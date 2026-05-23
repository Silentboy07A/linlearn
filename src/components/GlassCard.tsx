"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { CARD } from "@/lib/motion";

interface GlassCardProps {
  children:  React.ReactNode;
  className?: string;
  delay?:     number;
  /** Adds a subtle brand-colored left border accent */
  accent?:    boolean;
  /** Removes motion — use for skeletons or high-frequency re-renders */
  static?:    boolean;
  /** Makes card interactive (hover lift + border glow) */
  interactive?: boolean;
  onClick?:   () => void;
}

export function GlassCard({
  children,
  className,
  delay = 0,
  accent = false,
  static: isStatic = false,
  interactive = false,
  onClick,
}: GlassCardProps) {
  const baseClasses = cn(
    "relative rounded-xl border p-5",
    "border-[var(--border-default)] bg-surface-03/75",
    "shadow-e2 backdrop-blur-md",
    accent && "border-l-2 border-l-brand-500",
    interactive &&
      "cursor-pointer transition-all duration-normal hover:border-[var(--border-brand)] hover:shadow-card-hover hover:-translate-y-px active:translate-y-0 active:shadow-e1",
    className
  );

  if (isStatic) {
    return (
      <div className={baseClasses} onClick={onClick}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      variants={CARD}
      initial="initial"
      animate="animate"
      transition={{ duration: 0.32, delay, ease: [0.16, 1, 0.3, 1] }}
      className={baseClasses}
      onClick={onClick}
    >
      {children}
    </motion.div>
  );
}
