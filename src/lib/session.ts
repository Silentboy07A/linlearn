import { levelFromXp } from "@/lib/xp";
import type { Level } from "@/types";

export type TerminalTheme = "green" | "amber" | "cyan" | "white";
export type TerminalFontSize = "small" | "medium" | "large";
export type CommandOrigin = "local" | "ai" | "db" | "ai-generated";
export type CommandFilter = "All" | "AI Generated" | "DB Fallback" | "Local";

export interface SessionCommand {
  id: string;
  input: string;
  output: string;
  source: CommandOrigin;
  createdAt: string;
}

export interface QuizSummary {
  id: string;
  category: string;
  correct: number;
  wrong: number;
  total: number;
  xpEarned: number;
  timeTakenSec: number;
  scorePercent: number;
  createdAt: string;
}

export interface InterviewHistoryItem {
  id: string;
  question: string;
  answer: string;
  score: number;
  good: string;
  missing: string;
  modelAnswer: string;
  xpEarned: number;
  createdAt: string;
}

export interface TerminalPrefs {
  theme: TerminalTheme;
  fontSize: TerminalFontSize;
  showSourceTags: boolean;
}

export interface XpDailyPoint {
  date: string;
  xp: number;
}

export interface StreakUpdateResult {
  streak: number;
  lastLoginDate: string;
  milestoneHit: number | null;
}

export const STREAK_MILESTONES = new Set([3, 7, 14, 30]);

export function todayIsoDate(): string {
  return new Date().toISOString().split("T")[0];
}

export function shiftIsoDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split("T")[0];
}

export function applyDailyStreak(lastLoginDate: string | null, currentStreak: number): StreakUpdateResult {
  const today = todayIsoDate();
  if (!lastLoginDate) {
    const streak = 1;
    return {
      streak,
      lastLoginDate: today,
      milestoneHit: STREAK_MILESTONES.has(streak) ? streak : null,
    };
  }

  if (lastLoginDate === today) {
    return { streak: currentStreak, lastLoginDate: today, milestoneHit: null };
  }

  const last = new Date(lastLoginDate);
  const now = new Date(today);
  const diffDays = Math.floor((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));

  const streak = diffDays === 1 ? currentStreak + 1 : 1;
  return {
    streak,
    lastLoginDate: today,
    milestoneHit: STREAK_MILESTONES.has(streak) ? streak : null,
  };
}

export function bumpXpTimeline(timeline: XpDailyPoint[], amount: number): XpDailyPoint[] {
  const today = todayIsoDate();
  let didUpdate = false;
  const next = timeline.map((point) => {
    if (point.date !== today) return point;
    didUpdate = true;
    return { ...point, xp: point.xp + amount };
  });

  if (!didUpdate) {
    next.push({ date: today, xp: amount });
  }

  return next
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);
}

export function seedTimeline(days: number): XpDailyPoint[] {
  return Array.from({ length: days }, (_, index) => ({
    date: shiftIsoDate(days - 1 - index),
    xp: 0,
  }));
}

export function levelFromSessionXp(xp: number): Level {
  return levelFromXp(xp);
}

export function sourceTag(source: CommandOrigin): string {
  if (source === "ai") return "[AI]";
  if (source === "db") return "[DB]";
  if (source === "local") return "[local]";
  return "[AI]";
}

export function matchesCommandFilter(source: CommandOrigin, filter: CommandFilter): boolean {
  if (filter === "All") return true;
  if (filter === "AI Generated") return source === "ai" || source === "ai-generated";
  if (filter === "DB Fallback") return source === "db";
  return source === "local";
}

export function normalizeCommandBase(input: string): string {
  return input.trim().split(/\s+/)[0] || "unknown";
}
