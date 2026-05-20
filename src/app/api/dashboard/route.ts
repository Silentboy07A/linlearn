import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import type { CommandHistoryRow, DashboardStats, QuizResultRow } from "@/types";

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const userId = auth.user!.id;

  const [
    { data: progress },
    { count: quizzesCompleted },
    { count: commandsGenerated },
    { count: scriptsGenerated },
    { count: interviewsCompleted },
    { count: cheatSheetsGenerated },
    { data: recentCommands },
    { data: quizResults },
    { data: profile },
  ] = await Promise.all([
    auth.supabase.from("progress").select("*").eq("user_id", userId).single(),
    auth.supabase.from("quiz_results").select("*", { count: "exact", head: true }).eq("user_id", userId),
    auth.supabase.from("command_history").select("*", { count: "exact", head: true }).eq("user_id", userId),
    auth.supabase.from("scripts").select("*", { count: "exact", head: true }).eq("user_id", userId),
    auth.supabase.from("interview_sessions").select("*", { count: "exact", head: true }).eq("user_id", userId),
    auth.supabase.from("cheatsheets").select("*", { count: "exact", head: true }).eq("user_id", userId),
    auth.supabase
      .from("command_history")
      .select("id, query, command, explanation, risk_level, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5),
    auth.supabase
      .from("quiz_results")
      .select("id, category, score, total, difficulty, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10),
    auth.supabase.from("profiles").select("*").eq("id", userId).single(),
  ]);

  const stats: DashboardStats = {
    xp: progress?.xp ?? 0,
    streak: progress?.streak ?? 0,
    level: progress?.level ?? "Beginner",
    quizzesCompleted: quizzesCompleted ?? 0,
    commandsGenerated: commandsGenerated ?? 0,
    scriptsGenerated: scriptsGenerated ?? 0,
    interviewsCompleted: interviewsCompleted ?? 0,
    cheatSheetsGenerated: cheatSheetsGenerated ?? 0,
  };

  return NextResponse.json({
    profile,
    stats,
    recentCommands: (recentCommands ?? []) as CommandHistoryRow[],
    quizResults: (quizResults ?? []) as QuizResultRow[],
  });
}
