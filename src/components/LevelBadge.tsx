"use client";

import { levelEmoji } from "@/lib/xp";
import type { Level } from "@/types";
import { cn } from "@/lib/utils";

const LEVEL_STYLES: Partial<Record<string, { badge: string; glow: boolean }>> = {
  Beginner:     { badge: "bg-terminal-500/10 text-terminal-400 border-terminal-500/25", glow: false },
  Intermediate: { badge: "bg-sky-500/10      text-sky-400      border-sky-500/25",      glow: false },
  Advanced:     { badge: "bg-amber-500/10    text-amber-400    border-amber-500/25",    glow: false },
  Expert:       { badge: "bg-brand-500/10    text-brand-400    border-brand-500/25",    glow: true  },
};

export function LevelBadge({ level }: { level: Level }) {
  const style = LEVEL_STYLES[level] ?? {
    badge: "bg-ink-muted/10 text-ink-tertiary border-[var(--border-subtle)]",
    glow: false,
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
        "text-2xs font-semibold tracking-wide",
        style.badge,
        style.glow && "animate-pulse-brand"
      )}
    >
      {levelEmoji(level)} {level}
    </span>
  );
}
