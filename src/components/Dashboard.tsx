"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Flame, Terminal, Trophy, Zap, Activity } from "lucide-react";
import { motion } from "framer-motion";
import { GlassCard }    from "@/components/GlassCard";
import { StatCard }     from "@/components/StatCard";
import { TerminalPrompt } from "@/components/TerminalPrompt";
import { normalizeCommandBase, type QuizSummary, type SessionCommand, type XpDailyPoint } from "@/lib/session";
import { STAGGER_CONTAINER, STAGGER_ITEM } from "@/lib/motion";

// ─── Chart style tokens — single source of truth ────────────────────────────
const CHART = {
  grid: {
    stroke: "rgba(255,255,255,0.05)",
    strokeDasharray: "3 3",
  },
  axis: {
    stroke:     "rgba(255,255,255,0)",  // hide axis line
    tick:       { fill: "#635b80", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
  },
  tooltip: {
    contentStyle: {
      background:   "#1c1232",
      border:       "1px solid rgba(255,255,255,0.09)",
      borderRadius: "10px",
      boxShadow:    "0 8px 28px rgba(0,0,0,0.65)",
      padding:      "8px 12px",
      fontSize:     "12px",
    },
    labelStyle: { color: "#f0eeff", fontWeight: 600, marginBottom: 2 },
    itemStyle:  { color: "#9d94bb" },
    cursor:     { stroke: "rgba(233,84,32,0.15)", strokeWidth: 1 },
  },
} as const;

// ─── Heat level for activity heatmap ────────────────────────────────────────
function heatColor(xp: number): string {
  if (xp >= 80) return "bg-brand-500";
  if (xp >= 40) return "bg-brand-500/65";
  if (xp >= 15) return "bg-brand-500/40";
  if (xp >  0)  return "bg-brand-500/22";
  return "bg-white/[0.04]";
}

// ─── Helper functions ────────────────────────────────────────────────────────
function averageQuizScore(history: QuizSummary[]) {
  if (!history.length) return 0;
  return Math.round(history.reduce((s, h) => s + h.scorePercent, 0) / history.length);
}

function mostUsedCommands(commands: SessionCommand[]) {
  const counts = new Map<string, number>();
  commands.forEach(({ input }) => {
    const base = normalizeCommandBase(input);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

// ─── Props ───────────────────────────────────────────────────────────────────
interface DashboardProps {
  username:    string;
  xp:          number;
  streak:      number;
  commands:    SessionCommand[];
  quizHistory: QuizSummary[];
  xpTimeline:  XpDailyPoint[];
}

// ─── Component ───────────────────────────────────────────────────────────────
export function Dashboard({
  username, xp, streak, commands, quizHistory, xpTimeline,
}: DashboardProps) {
  const commandCount = commands.filter((c) => c.source === "ai-generated").length;
  const quizScore    = averageQuizScore(quizHistory);
  const xpLast7Days  = xpTimeline.slice(-7).map((p) => ({ day: p.date.slice(5), xp: p.xp }));
  const topCommands  = mostUsedCommands(commands);
  const heatmapData  = xpTimeline.slice(-30);

  return (
    <motion.div
      variants={STAGGER_CONTAINER}
      initial="initial"
      animate="animate"
      className="space-y-5"
    >
      {/* ── Welcome prompt ─────────────────────────────────────── */}
      <motion.div variants={STAGGER_ITEM}>
        <GlassCard>
          <TerminalPrompt username={username}>
            <span className="text-ink-primary">
              Ready to level up,{" "}
              <span className="text-brand-400 font-semibold">{username}</span>
              . Your streak is at{" "}
              <span className="text-amber-400 font-semibold">{streak} day{streak !== 1 ? "s" : ""}</span>.
            </span>
          </TerminalPrompt>
        </GlassCard>
      </motion.div>

      {/* ── Stat cards ─────────────────────────────────────────── */}
      <motion.div
        variants={STAGGER_CONTAINER}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <motion.div variants={STAGGER_ITEM}>
          <StatCard label="Commands Generated" value={commandCount} icon={Terminal}  accent="brand"    sublabel="via AI generator" />
        </motion.div>
        <motion.div variants={STAGGER_ITEM}>
          <StatCard label="Avg Quiz Score"     value={`${quizScore}%`} icon={Trophy} accent="amber"    sublabel={`${quizHistory.length} sessions`} />
        </motion.div>
        <motion.div variants={STAGGER_ITEM}>
          <StatCard label="Active Streak"      value={`${streak}d`}   icon={Flame}  accent="terminal" sublabel="consecutive days" />
        </motion.div>
        <motion.div variants={STAGGER_ITEM}>
          <StatCard label="Total XP Earned"    value={xp.toLocaleString()} icon={Zap} accent="sky"  sublabel="lifetime XP" />
        </motion.div>
      </motion.div>

      {/* ── Charts row ─────────────────────────────────────────── */}
      <motion.div variants={STAGGER_ITEM} className="grid gap-4 lg:grid-cols-2">
        {/* XP timeline */}
        <GlassCard static delay={0.15}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink-secondary">XP Earned — Last 7 Days</h3>
            <Activity className="h-4 w-4 text-brand-500/60" />
          </div>
          {xpLast7Days.length === 0 ? (
            <EmptyChartState message="Start using the platform to track XP over time." />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={xpLast7Days} margin={{ left: -20, right: 8, top: 4, bottom: 0 }}>
                <CartesianGrid {...CHART.grid} />
                <XAxis dataKey="day" {...CHART.axis} tick={CHART.axis.tick} tickLine={false} axisLine={false} />
                <YAxis {...CHART.axis} tick={CHART.axis.tick} tickLine={false} axisLine={false} />
                <Tooltip {...CHART.tooltip} />
                <Line
                  type="monotone"
                  dataKey="xp"
                  stroke="#E95420"
                  strokeWidth={2}
                  dot={{ fill: "#E95420", r: 3, strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: "#f97316", strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </GlassCard>

        {/* Top commands bar chart */}
        <GlassCard static delay={0.20}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink-secondary">Most Used Commands</h3>
            <Terminal className="h-4 w-4 text-terminal-500/60" />
          </div>
          {topCommands.length === 0 ? (
            <EmptyChartState
              message="Run commands in the terminal simulator to populate usage data."
              hint="ls -la"
            />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={topCommands} margin={{ left: -20, right: 8, top: 4, bottom: 0 }}>
                <CartesianGrid {...CHART.grid} />
                <XAxis dataKey="command" {...CHART.axis} tick={CHART.axis.tick} tickLine={false} axisLine={false} />
                <YAxis {...CHART.axis} tick={CHART.axis.tick} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip {...CHART.tooltip} />
                <Bar dataKey="count" fill="#E95420" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </GlassCard>
      </motion.div>

      {/* ── Activity heatmap ──────────────────────────────────── */}
      <motion.div variants={STAGGER_ITEM}>
        <GlassCard static delay={0.25}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink-secondary">Activity Heatmap — Last 30 Days</h3>
            <div className="flex items-center gap-1.5">
              <span className="text-2xs text-ink-muted">Less</span>
              {["bg-white/[0.04]", "bg-brand-500/22", "bg-brand-500/40", "bg-brand-500/65", "bg-brand-500"].map((c, i) => (
                <div key={i} className={`h-3 w-3 rounded-sm border border-white/5 ${c}`} />
              ))}
              <span className="text-2xs text-ink-muted">More</span>
            </div>
          </div>
          {heatmapData.length === 0 ? (
            <EmptyChartState message="No activity yet. Complete missions and quizzes to fill your heatmap." />
          ) : (
            <div className="overflow-x-auto pb-1">
              <div
                className="grid min-w-[640px] gap-1.5"
                style={{ gridTemplateColumns: "repeat(30, minmax(0, 1fr))" }}
              >
                {heatmapData.map((point) => (
                  <div key={point.date} className="flex flex-col items-center gap-1">
                    <div
                      title={`${point.date}: ${point.xp} XP`}
                      className={`h-3.5 w-3.5 rounded-sm border border-white/[0.06] transition-transform hover:scale-125 ${heatColor(point.xp)}`}
                    />
                    <span className="text-2xs text-ink-muted tabular">{point.date.slice(8)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </GlassCard>
      </motion.div>
    </motion.div>
  );
}

// ─── Empty chart state ───────────────────────────────────────────────────────
function EmptyChartState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex h-[200px] flex-col items-center justify-center gap-3 text-center">
      <p className="max-w-xs text-sm text-ink-tertiary">{message}</p>
      {hint && (
        <code className="rounded-md border border-[var(--border-subtle)] bg-surface-02 px-3 py-1.5 font-mono text-xs text-ink-secondary">
          <span className="text-brand-500">$ </span>{hint}
        </code>
      )}
    </div>
  );
}
