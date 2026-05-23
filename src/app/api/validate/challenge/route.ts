import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { generateChallenge } from "@/lib/challenge";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  // Rate Limit: 15 requests per minute for requesting challenges
  const limitResponse = rateLimit(req, auth.user!.id, { limit: 15, windowMs: 60 * 1000 });
  if (limitResponse) return limitResponse;

  try {
    const challenge = generateChallenge(auth.user!.id);
    return NextResponse.json(challenge);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to generate challenge";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Support POST as well, doing the same as GET
  return GET(req);
}
