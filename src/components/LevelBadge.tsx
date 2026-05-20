"use client";

import { levelEmoji } from "@/lib/xp";
import type { Level } from "@/types";

export function LevelBadge({ level }: { level: Level }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#E95420]/30 bg-[#E95420]/10 px-2 py-0.5 text-xs font-medium text-[#E95420]">
      {levelEmoji(level)} {level}
    </span>
  );
}
