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
import { Flame, Terminal, Trophy, Zap } from "lucide-react";
import { GlassCard } from "@/components/GlassCard";
import { StatCard } from "@/components/StatCard";
import { TerminalPrompt } from "@/components/TerminalPrompt";
import { normalizeCommandBase, type QuizSummary, type SessionCommand, type XpDailyPoint } from "@/lib/session";

interface DashboardProps {
  username: string;
  xp: number;
  streak: number;
  commands: SessionCommand[];
  quizHistory: QuizSummary[];
  xpTimeline: XpDailyPoint[];
}

function averageQuizScore(quizHistory: QuizSummary[]) {
  if (!quizHistory.length) return 0;
  const total = quizHistory.reduce((sum, item) => sum + item.scorePercent, 0);
  return Math.round(total / quizHistory.length);
}

function mostUsedCommands(commands: SessionCommand[]) {
  const counts = new Map<string, number>();
  commands.forEach((item) => {
    const base = normalizeCommandBase(item.input);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function heatLevel(value: number) {
  if (value >= 80) return "bg-[#E95420]";
  if (value >= 40) return "bg-[#E95420]/70";
  if (value >= 15) return "bg-[#E95420]/45";
  if (value > 0) return "bg-[#E95420]/25";
  return "bg-white/5";
}

export function Dashboard({ username, xp, streak, commands, quizHistory, xpTimeline }: DashboardProps) {
  const commandCount = commands.filter((item) => item.source === "ai-generated").length;
  const quizScore = averageQuizScore(quizHistory);
  const xpLast7Days = xpTimeline.slice(-7).map((point) => ({
    day: point.date.slice(5),
    xp: point.xp,
  }));
  const topCommands = mostUsedCommands(commands);
  const heatmapData = xpTimeline.slice(-30);

  return (
    <div className="space-y-6">
      <GlassCard>
        <TerminalPrompt>
          <span className="text-white">
            Welcome back, <span className="text-[#E95420]">{username}</span>. Let&apos;s keep the streak alive.
          </span>
        </TerminalPrompt>
      </GlassCard>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Commands Generated" value={commandCount} icon={Terminal} />
        <StatCard label="Quiz Score" value={`${quizScore}%`} icon={Trophy} delay={0.05} />
        <StatCard label="Current Streak" value={`${streak} days`} icon={Flame} delay={0.1} />
        <StatCard label="Total XP" value={xp} icon={Zap} delay={0.15} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <GlassCard>
          <h3 className="mb-3 text-sm font-semibold text-gray-300">XP Earned (Last 7 Days)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={xpLast7Days}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
              <XAxis dataKey="day" stroke="#a3a3a3" fontSize={11} />
              <YAxis stroke="#a3a3a3" fontSize={11} />
              <Tooltip
                contentStyle={{ background: "#1a0a2e", border: "1px solid #ffffff20" }}
                labelStyle={{ color: "#f5f5f5" }}
              />
              <Line type="monotone" dataKey="xp" stroke="#E95420" strokeWidth={2.5} />
            </LineChart>
          </ResponsiveContainer>
        </GlassCard>

        <GlassCard>
          <h3 className="mb-3 text-sm font-semibold text-gray-300">Most Used Commands</h3>
          {topCommands.length === 0 ? (
            <p className="text-sm text-gray-500">Run commands to populate usage data.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={topCommands}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                <XAxis dataKey="command" stroke="#a3a3a3" fontSize={11} />
                <YAxis stroke="#a3a3a3" fontSize={11} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: "#1a0a2e", border: "1px solid #ffffff20" }}
                  labelStyle={{ color: "#f5f5f5" }}
                />
                <Bar dataKey="count" fill="#F97316" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </GlassCard>
      </div>

      <GlassCard>
        <h3 className="mb-3 text-sm font-semibold text-gray-300">Activity Heatmap (Last 30 Days)</h3>
        <div className="overflow-x-auto pb-2">
          <div
            className="grid min-w-[720px] gap-2"
            style={{ gridTemplateColumns: "repeat(30, minmax(0, 1fr))" }}
          >
            {heatmapData.map((point) => (
              <div key={point.date} className="flex flex-col items-center gap-1">
                <div
                  title={`${point.date}: ${point.xp} XP`}
                  className={`h-4 w-4 rounded-sm border border-white/5 ${heatLevel(point.xp)}`}
                />
                <span className="text-[10px] text-gray-500">{point.date.slice(8)}</span>
              </div>
            ))}
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
