import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import { rateLimit } from "@/lib/rate-limit";
import { verifyChallenge, verifyStateHash } from "@/lib/challenge";

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  // Rate Limit: 15 requests per minute
  const limitResponse = rateLimit(req, auth.user!.id, { limit: 15, windowMs: 60 * 1000 });
  if (limitResponse) return limitResponse;

  try {
    const { missionId, success, nonce, expires, signature, clientHash } = await req.json();
    if (!missionId) {
      return NextResponse.json({ error: "Mission ID required" }, { status: 400 });
    }

    if (!success) {
      return NextResponse.json({ verified: false, error: "Validation failed" });
    }

    // Cryptographic validation check
    if (!nonce || !expires || !signature || !clientHash) {
      return NextResponse.json({ error: "Cryptographic validation fields are missing" }, { status: 400 });
    }

    // 1. Verify that the challenge was signed by the server and has not expired
    const isChallengeValid = verifyChallenge(auth.user!.id, nonce, expires, signature);
    if (!isChallengeValid) {
      return NextResponse.json({ error: "Invalid or expired challenge nonce" }, { status: 400 });
    }

    // 2. Verify that the client hash matches the validation state metrics
    const stateMetrics = `${missionId}:${success}`;
    const isStateHashValid = verifyStateHash(nonce, stateMetrics, clientHash);
    if (!isStateHashValid) {
      return NextResponse.json({ error: "Integrity check failed: validation state mismatch" }, { status: 400 });
    }

    // Award XP
    const progress = await addXp(auth.supabase, auth.user!.id, XP_REWARDS.missionCompleted);

    // Log the verified mission into command history
    await auth.supabase.from("command_history").insert({
      user_id: auth.user!.id,
      query: `Verify Mission: ${missionId}`,
      command: `verify_mission ${missionId}`,
      explanation: `Successfully completed challenge: ${missionId}`,
      risk_level: "Low",
    });

    return NextResponse.json({ verified: true, progress });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Validation endpoint failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

