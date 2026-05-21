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
      // ── AI first ──
      try {
        const questions = await callLlamaJson<QuizQuestion[]>(
          SYSTEM,
          `Category: ${category}\nDifficulty: ${difficulty}`
        );
        return NextResponse.json({ questions: questions.slice(0, 10), source: "ai" });
      } catch (aiErr) {
        console.warn("AI quiz failed, falling back to DB:", aiErr);

        // ── DB fallback: pick 10 random commands, build MCQ from them ──
        const { data: commands, error: dbErr } = await auth.supabase
          .from("linux_commands")
          .select("command_name, description, example_usage, category")
          .limit(40);

        if (dbErr || !commands || commands.length < 4) {
          throw new Error("AI unavailable and DB fallback also failed.");
        }

        // Shuffle and take 10
        const shuffled = commands.sort(() => Math.random() - 0.5).slice(0, 10);

        const questions: QuizQuestion[] = shuffled.map((cmd) => {
          // Pick 3 wrong options from the remaining commands
          const others = commands
            .filter((c) => c.command_name !== cmd.command_name)
            .sort(() => Math.random() - 0.5)
            .slice(0, 3)
            .map((c) => c.command_name);

          const options = [cmd.command_name, ...others].sort(() => Math.random() - 0.5) as [
            string,
            string,
            string,
            string,
          ];
          const correct = options.indexOf(cmd.command_name);

          return {
            question: `Which command: "${cmd.description}"?`,
            options,
            correct,
            explanation: `The answer is \`${cmd.command_name}\`. Example: ${cmd.example_usage}`,
          };
        });

        return NextResponse.json({ questions, source: "db" });
      }
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
