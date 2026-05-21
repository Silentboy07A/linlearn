"use client";

import type { LucideIcon } from "lucide-react";
import { GlassCard } from "./GlassCard";

export function StatCard({
  label,
  value,
  icon: Icon,
  delay = 0,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  delay?: number;
}) {
  return (
    <GlassCard delay={delay}>
      <div className="flex items-center justify-between p-2">
        <div>
          <p className="text-sm font-medium text-gray-400">{label}</p>
          <p className="mt-2 text-4xl font-bold text-white">{value}</p>
        </div>
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[#E95420]/15 ring-1 ring-[#E95420]/30">
          <Icon className="h-7 w-7 text-[#E95420]" />
        </div>
      </div>
    </GlassCard>
  );
}
