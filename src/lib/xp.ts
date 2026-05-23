import type { Level } from "@/types";

export const XP_REWARDS = {
  command: 10,
  script: 25,
  chat: 5,
  quizCorrect: 20,
  errorExplain: 15,
  interviewGood: 30,
  cheatsheet: 20,
  missionCompleted: 100,
} as const;

export function levelFromXp(xp: number): Level {
  if (xp >= 3000) return "Expert";
  if (xp >= 1500) return "Advanced";
  if (xp >= 500) return "Intermediate";
  return "Beginner";
}

export function levelEmoji(level: Level): string {
  switch (level) {
    case "Expert":
      return "🏆";
    case "Advanced":
      return "🔥";
    case "Intermediate":
      return "⚡";
    default:
      return "🐣";
  }
}

export function xpProgressInLevel(xp: number): { current: number; max: number; percent: number } {
  if (xp >= 3000) return { current: xp - 3000, max: 1000, percent: 100 };
  if (xp >= 1500) return { current: xp - 1500, max: 1500, percent: ((xp - 1500) / 1500) * 100 };
  if (xp >= 500) return { current: xp - 500, max: 1000, percent: ((xp - 500) / 1000) * 100 };
  return { current: xp, max: 500, percent: (xp / 500) * 100 };
}

export function computeStreak(lastActive: string | null): { streak: number; lastActive: string } {
  const today = new Date().toISOString().split("T")[0];
  if (!lastActive) return { streak: 1, lastActive: today };

  const last = new Date(lastActive);
  const now = new Date(today);
  const diffDays = Math.floor((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));

  if (lastActive === today) return { streak: -1, lastActive: today }; // signal: don't change streak
  if (diffDays === 1) return { streak: -2, lastActive: today }; // signal: increment
  return { streak: 1, lastActive: today }; // reset
}
