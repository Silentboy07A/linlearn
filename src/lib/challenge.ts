// src/lib/challenge.ts
import { createHmac, randomBytes } from "crypto";

const SECRET_KEY = process.env.JWT_SECRET || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "linlearn-default-hmac-secret-key-9988";

export interface Challenge {
  nonce: string;
  expires: number;
  signature: string;
}

export function generateChallenge(userId: string): Challenge {
  const nonce = randomBytes(16).toString("hex");
  const expires = Date.now() + 5 * 60 * 1000; // 5 minutes expiration window
  const payload = `${userId}:${nonce}:${expires}`;
  const signature = createHmac("sha256", SECRET_KEY).update(payload).digest("hex");
  
  return { nonce, expires, signature };
}

export function verifyChallenge(userId: string, nonce: string, expires: number, signature: string): boolean {
  if (Date.now() > expires) {
    return false; // Expired challenge
  }
  const payload = `${userId}:${nonce}:${expires}`;
  const expectedSignature = createHmac("sha256", SECRET_KEY).update(payload).digest("hex");
  
  return signature === expectedSignature;
}

export function verifyStateHash(nonce: string, stateMetrics: string, clientHash: string): boolean {
  const expectedHash = createHmac("sha256", nonce).update(stateMetrics).digest("hex");
  return clientHash === expectedHash;
}
