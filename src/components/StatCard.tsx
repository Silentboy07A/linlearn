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
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-400">{label}</p>
          <p className="mt-1 text-2xl font-bold text-white">{value}</p>
        </div>
        <Icon className="h-8 w-8 text-[#E95420]" />
      </div>
    </GlassCard>
  );
}
