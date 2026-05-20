import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type {
  InterviewAnswerResponse,
  InterviewReportResponse,
  InterviewStartResponse,
} from "@/types";

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const body = await req.json();
    const { action, topic, difficulty } = body;

    if (action === "start") {
      const result = await callLlamaJson<InterviewStartResponse>(
        `You are a technical interviewer for ${topic} at ${difficulty} level.
Return JSON: { "question": "string", "questionNumber": 1, "totalQuestions": 5 }`,
        `Start interview on topic: ${topic}`
      );
      return NextResponse.json(result);
    }

    if (action === "answer") {
      const { question, answer, questionNumber } = body;
      const result = await callLlamaJson<InterviewAnswerResponse>(
        `Grade this interview answer 0-10. Return JSON:
{ "score": number, "good": "string", "missing": "string", "modelAnswer": "string",
  "nextQuestion": "string or null if question ${questionNumber} was 5", "questionNumber": number }`,
        `Topic: ${topic}\nQuestion: ${question}\nAnswer: ${answer}\nCurrent question number: ${questionNumber}`
      );

      if (result.score >= 7) {
        await addXp(auth.supabase, auth.user!.id, XP_REWARDS.interviewGood);
      }

      return NextResponse.json(result);
    }

    if (action === "report") {
      const { answers, topic: t } = body;
      const result = await callLlamaJson<InterviewReportResponse>(
        `Generate final interview report. Return JSON:
{ "totalScore": number, "performance": "Needs Practice|Good|Excellent",
  "strengths": ["string"], "improvements": ["string"], "recommendations": ["string"] }`,
        JSON.stringify({ topic: t, answers })
      );

      await auth.supabase.from("interview_sessions").insert({
        user_id: auth.user!.id,
        topic: t || topic,
        total_questions: answers?.length || 5,
        score: result.totalScore,
        feedback: JSON.stringify(result),
      });

      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Interview failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
