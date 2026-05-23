import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  // Rate Limit: 15 requests per minute
  const limitResponse = rateLimit(req, auth.user!.id, { limit: 15, windowMs: 60 * 1000 });
  if (limitResponse) return limitResponse;

  try {
    const { missionId, success } = await req.json();
    if (!missionId) {
      return NextResponse.json({ error: "Mission ID required" }, { status: 400 });
    }

    if (!success) {
      return NextResponse.json({ verified: false, error: "Validation failed" });
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
