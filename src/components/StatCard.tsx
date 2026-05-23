"use client";

import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { CARD, STAT_VALUE } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Accent = "brand" | "terminal" | "amber" | "sky" | "rose";
type Trend  = "up" | "down" | "neutral";

const ACCENT: Record<Accent, { iconBg: string; iconRing: string; iconColor: string; border: string }> = {
  brand:    { iconBg: "bg-brand-500/10",    iconRing: "ring-brand-500/20",    iconColor: "text-brand-400",    border: "border-l-brand-500"    },
  terminal: { iconBg: "bg-terminal-500/10", iconRing: "ring-terminal-500/20", iconColor: "text-terminal-400", border: "border-l-terminal-500" },
  amber:    { iconBg: "bg-amber-500/10",    iconRing: "ring-amber-500/20",    iconColor: "text-amber-400",    border: "border-l-amber-500"    },
  sky:      { iconBg: "bg-sky-500/10",      iconRing: "ring-sky-500/20",      iconColor: "text-sky-400",      border: "border-l-sky-500"      },
  rose:     { iconBg: "bg-rose-500/10",     iconRing: "ring-rose-500/20",     iconColor: "text-rose-400",     border: "border-l-rose-500"     },
};

const TREND_CONFIG: Record<Trend, { icon: LucideIcon; color: string; label: string }> = {
  up:      { icon: TrendingUp,   color: "text-terminal-400", label: "up"      },
  down:    { icon: TrendingDown, color: "text-rose-400",     label: "down"    },
  neutral: { icon: Minus,        color: "text-ink-muted",    label: "neutral" },
};

interface StatCardProps {
  label:      string;
  value:      string | number;
  icon:       LucideIcon;
  delay?:     number;
  accent?:    Accent;
  trend?:     Trend;
  trendLabel?: string;
  sublabel?:  string;
}

export function StatCard({
  label,
  value,
  icon: Icon,
  delay = 0,
  accent = "brand",
  trend,
  trendLabel,
  sublabel,
}: StatCardProps) {
  const a = ACCENT[accent];
  const t = trend ? TREND_CONFIG[trend] : null;
  const TrendIcon = t?.icon;

  return (
    <motion.div
      variants={CARD}
      initial="initial"
      animate="animate"
      transition={{ duration: 0.32, delay, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "relative rounded-xl border-[var(--border-default)] bg-surface-03/75",
        "border-l-2 border border-[var(--border-default)] p-5",
        "shadow-e2 backdrop-blur-md",
        "group transition-all duration-normal",
        "hover:border-[var(--border-strong)] hover:shadow-e3",
        a.border
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Text side */}
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-semibold uppercase tracking-widest text-ink-tertiary">
            {label}
          </p>

          <motion.p
            variants={STAT_VALUE}
            initial="initial"
            animate="animate"
            className="mt-2.5 text-3xl font-bold tracking-tight text-ink-primary tabular"
          >
            {value}
          </motion.p>

          {/* Trend indicator */}
          {trend && TrendIcon && trendLabel && (
            <div className="mt-1.5 flex items-center gap-1">
              <TrendIcon className={cn("h-3 w-3 shrink-0", t!.color)} />
              <span className={cn("text-2xs font-medium", t!.color)}>{trendLabel}</span>
            </div>
          )}

          {sublabel && !trend && (
            <p className="mt-1 text-2xs text-ink-tertiary">{sublabel}</p>
          )}
        </div>

        {/* Icon */}
        <div
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
            "ring-1 transition-transform duration-normal group-hover:scale-105",
            a.iconBg, a.iconRing
          )}
        >
          <Icon className={cn("h-5 w-5", a.iconColor)} />
        </div>
      </div>
    </motion.div>
  );
}
