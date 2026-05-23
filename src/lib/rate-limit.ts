import { NextResponse } from "next/server";

interface RateLimitRecord {
  timestamps: number[];
}

const rateLimitMap = new Map<string, RateLimitRecord>();

export interface RateLimitOptions {
  limit: number;      // Maximum requests allowed in the window
  windowMs: number;   // Window size in milliseconds
}

/**
 * Retrieves the client's IP address from request headers.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.headers.get("x-real-ip") || "127.0.0.1";
}

/**
 * High-level Next.js Route Handler helper.
 * Enforces rate limiting on BOTH the user's ID (if authenticated) and their IP address.
 * If either rate limit is exceeded, returns a 429 NextResponse.
 * Otherwise, records the request for both keys and returns null.
 */
export function rateLimit(
  req: Request,
  userId: string | null,
  options: RateLimitOptions = { limit: 10, windowMs: 60 * 1000 }
): NextResponse | null {
  const ip = getClientIp(req);
  const ipKey = `ip:${ip}`;
  const userKey = userId ? `user:${userId}` : null;

  const now = Date.now();
  const windowStart = now - options.windowMs;

  // 1. Dry-run check for IP rate limit
  let ipRecord = rateLimitMap.get(ipKey);
  if (ipRecord) {
    ipRecord.timestamps = ipRecord.timestamps.filter((t) => t > windowStart);
    if (ipRecord.timestamps.length >= options.limit) {
      const oldest = ipRecord.timestamps[0];
      const retryAfter = Math.ceil((oldest + options.windowMs - now) / 1000);
      return create429Response(retryAfter, options.limit);
    }
  }

  // 2. Dry-run check for User ID rate limit (if authenticated)
  if (userKey) {
    const userRecord = rateLimitMap.get(userKey);
    if (userRecord) {
      userRecord.timestamps = userRecord.timestamps.filter((t) => t > windowStart);
      if (userRecord.timestamps.length >= options.limit) {
        const oldest = userRecord.timestamps[0];
        const retryAfter = Math.ceil((oldest + options.windowMs - now) / 1000);
        return create429Response(retryAfter, options.limit);
      }
    }
  }

  // 3. Both checks passed! Register the request timestamp for both keys
  if (!ipRecord) {
    ipRecord = { timestamps: [] };
    rateLimitMap.set(ipKey, ipRecord);
  }
  ipRecord.timestamps.push(now);

  if (userKey) {
    let userRecord = rateLimitMap.get(userKey);
    if (!userRecord) {
      userRecord = { timestamps: [] };
      rateLimitMap.set(userKey, userRecord);
    }
    userRecord.timestamps.push(now);
  }

  return null;
}

/**
 * Creates a standard JSON 429 Too Many Requests response.
 */
function create429Response(retryAfter: number, limit: number): NextResponse {
  return NextResponse.json(
    {
      error: "Too Many Requests",
      message: `You have exceeded the rate limit. Please try again in ${retryAfter} seconds.`,
    },
    {
      status: 429,
      headers: {
        "Retry-After": Math.max(1, retryAfter).toString(),
        "X-RateLimit-Limit": limit.toString(),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": Math.ceil((Date.now() + retryAfter * 1000) / 1000).toString(),
      },
    }
  );
}
