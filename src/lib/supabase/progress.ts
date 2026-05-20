import type { SupabaseClient } from "@supabase/supabase-js";
import { computeStreak, levelFromXp } from "@/lib/xp";
import type { Level } from "@/types";

export async function addXp(
  supabase: SupabaseClient,
  userId: string,
  amount: number
): Promise<{ xp: number; level: Level; streak: number } | null> {
  const { data: progress, error } = await supabase
    .from("progress")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !progress) return null;

  const streakUpdate = computeStreak(progress.last_active);
  let newStreak = progress.streak;
  if (streakUpdate.streak === -2) newStreak = progress.streak + 1;
  else if (streakUpdate.streak === 1 && progress.last_active !== streakUpdate.lastActive) {
    newStreak = 1;
  }

  const newXp = progress.xp + amount;
  const newLevel = levelFromXp(newXp);

  const { data: updated } = await supabase
    .from("progress")
    .update({
      xp: newXp,
      level: newLevel,
      streak: newStreak,
      last_active: streakUpdate.lastActive,
    })
    .eq("user_id", userId)
    .select("xp, level, streak")
    .single();

  return updated
    ? { xp: updated.xp, level: updated.level as Level, streak: updated.streak }
    : null;
}
