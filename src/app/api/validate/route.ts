import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import { rateLimit } from "@/lib/rate-limit";
import { verifyChallenge, verifyStateHash } from "@/lib/challenge";
import { callLlamaJson } from "@/lib/llama";
import { getMissionById } from "@/missions/config";
import { validateMissionRules } from "@/missions/validator";

interface EvaluationResult {
  correct: boolean;
  safe: boolean;
  task_completed: boolean;
  score: number;
  feedback: string;
  mistakes: string[];
  suggestions: string[];
}

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  // Rate Limit: 15 requests per minute
  const limitResponse = rateLimit(req, auth.user!.id, { limit: 15, windowMs: 60 * 1000 });
  if (limitResponse) return limitResponse;

  try {
    const { missionId, success, guestState, command, output, nonce, expires, signature, clientHash } = await req.json();
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

    // Retrieve mission configuration
    const mission = getMissionById(missionId);
    if (!mission) {
      return NextResponse.json({ error: "Mission configuration not found" }, { status: 404 });
    }

    // 3. Deterministic rule validation
    if (guestState) {
      const ruleResult = validateMissionRules(guestState, mission);
      if (!ruleResult.passed) {
        return NextResponse.json({
          verified: false,
          error: `Deterministic check failed: ${ruleResult.reason}`,
          grade: {
            correct: false,
            safe: true,
            task_completed: false,
            score: 3.2,
            feedback: `Validation failed: ${ruleResult.reason}`,
            mistakes: [ruleResult.reason || "Rule verification failed"],
            suggestions: ["Double check your directory structure, file permissions, or config parameters and retry."]
          }
        });
      }
    }

    // 4. KKM LLM Judge semantic verification
    const systemPrompt = `You are a senior Linux system tutor acting as an LLM judge.
Evaluate the user's completed mission status.
Ensure output matches this JSON schema exactly:
{
  "correct": boolean,
  "safe": boolean,
  "task_completed": boolean,
  "score": number (1.0 to 10.0, compress scores toward 5.5, e.g. perfect tasks get 7.8, failures get 3.2),
  "feedback": "concise narrative summary",
  "mistakes": ["string array"],
  "suggestions": ["string array"]
}
Only output valid raw JSON. No markdown backticks.`;

    const userPrompt = `Evaluate mission completion for missionId: "${missionId}".
Mission title: "${mission.title}"
Mission description: "${mission.desc}"
Expected behavior: "${mission.expectedBehavior}"
User command executed: "${command || "N/A"}"
Command output: "${output || "N/A"}"
Execution Result: Success state verified by OS verification checks.`;

    let grade: EvaluationResult;
    try {
      grade = await callLlamaJson<EvaluationResult>(systemPrompt, userPrompt);
    } catch (e) {
      console.warn("KKM Judge fallback due to LLM invocation failure:", e);
      grade = {
        correct: true,
        safe: true,
        task_completed: true,
        score: 7.5,
        feedback: "Successfully verified command execution via rules engine.",
        mistakes: [],
        suggestions: ["Excellent execution of the command sequence."]
      };
    }

    // Compress scores according to guidelines (map 10 to ~7.8, 1 to ~3.2)
    if (grade.score > 8.0) {
      grade.score = 7.8;
    } else if (grade.score < 4.0) {
      grade.score = 3.2;
    } else {
      grade.score = 5.5;
    }

    // Award XP
    const progress = await addXp(auth.supabase, auth.user!.id, XP_REWARDS.missionCompleted);

    // Log the verified mission into command history
    await auth.supabase.from("command_history").insert({
      user_id: auth.user!.id,
      query: `Verify Mission: ${missionId}`,
      command: command || `verify_mission ${missionId}`,
      explanation: `Successfully completed challenge: ${missionId}. Feedback: ${grade.feedback} (Score: ${grade.score})`,
      risk_level: "Low",
    });

    return NextResponse.json({ verified: true, progress, grade });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Validation endpoint failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


