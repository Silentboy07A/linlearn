import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type { QuizQuestion } from "@/types";

const SYSTEM = `Generate exactly 10 multiple choice Linux/DevOps quiz questions.
Return ONLY a JSON array of 10 objects:
[{
  "question": "string",
  "options": ["A", "B", "C", "D"],
  "correct": 0,
  "explanation": "string"
}]
correct is 0-3 index. No markdown.`;

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { category, difficulty, score, total } = await req.json();

    if (category && difficulty && score === undefined) {
      const questions = await callLlamaJson<QuizQuestion[]>(
        SYSTEM,
        `Category: ${category}\nDifficulty: ${difficulty}`
      );
      return NextResponse.json({ questions: questions.slice(0, 10) });
    }

    if (typeof score === "number" && typeof total === "number") {
      await auth.supabase.from("quiz_results").insert({
        user_id: auth.user!.id,
        category: category || "Mixed",
        score,
        total,
        difficulty: difficulty || "Beginner",
      });

      const xpEarned = score * XP_REWARDS.quizCorrect;
      const progress = await addXp(auth.supabase, auth.user!.id, xpEarned);
      return NextResponse.json({ xpEarned, progress });
    }

    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Quiz failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
