"use client";

import { motion } from "framer-motion";
import { Zap } from "lucide-react";
import { xpProgressInLevel } from "@/lib/xp";
import { XP_BAR } from "@/lib/motion";

export function XPBar({ xp }: { xp: number }) {
  const { current, max, percent } = xpProgressInLevel(xp);
  const safePercent = Math.min(Math.max(percent, 0), 100);

  return (
    <div className="w-full space-y-1.5">
      {/* Labels */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-brand-500" />
          <span className="text-xs font-semibold text-ink-secondary tabular">
            {xp.toLocaleString()} XP
          </span>
        </div>
        <span className="text-2xs text-ink-tertiary tabular">
          {current.toLocaleString()} / {max.toLocaleString()}
        </span>
      </div>

      {/* Track */}
      <div className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        {/* Animated fill */}
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            background: "linear-gradient(90deg, #E95420 0%, #f97316 55%, #4CAF50 100%)",
          }}
          {...XP_BAR(safePercent)}
        />
        {/* Shimmer sweep over the fill */}
        <motion.div
          className="absolute inset-0 shimmer opacity-50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.5 }}
          transition={{ delay: 0.6, duration: 0.4 }}
        />
      </div>

      {/* Level progress label */}
      <p className="text-2xs text-ink-muted">
        {safePercent.toFixed(0)}% to next level
      </p>
    </div>
  );
}
