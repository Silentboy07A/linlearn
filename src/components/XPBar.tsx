"use client";

import { motion } from "framer-motion";
import { xpProgressInLevel } from "@/lib/xp";

export function XPBar({ xp }: { xp: number }) {
  const { current, max, percent } = xpProgressInLevel(xp);

  return (
    <div className="w-full space-y-1">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{xp} XP</span>
        <span>
          {current}/{max}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <motion.div
          className="h-full bg-gradient-to-r from-[#E95420] to-[#4CAF50]"
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(percent, 100)}%` }}
          transition={{ duration: 0.8 }}
        />
      </div>
    </div>
  );
}
