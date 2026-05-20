"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { Zap, Flame, Trophy, Terminal, Code, Mic, FileText } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { StatCard } from "./StatCard";
import { TerminalPrompt } from "./TerminalPrompt";
import { xpProgressInLevel } from "@/lib/xp";
import type { CommandHistoryRow, DashboardStats, Profile, QuizResultRow } from "@/types";

interface DashboardProps {
  profile: Profile | null;
  stats: DashboardStats;
  recentCommands: CommandHistoryRow[];
  quizResults: QuizResultRow[];
}

export function Dashboard({ profile, stats, recentCommands, quizResults }: DashboardProps) {
  const { percent } = xpProgressInLevel(stats.xp);
  const chartData = quizResults.map((q) => ({
    name: q.category.slice(0, 12),
    score: Math.round((q.score / q.total) * 100),
  }));

  return (
    <div className="space-y-6">
      <GlassCard>
        <TerminalPrompt>
          <span className="text-white">
            Welcome back, <span className="text-[#E95420]">{profile?.username || "hacker"}</span>
            ! Ready to level up your Linux skills?
          </span>
        </TerminalPrompt>
      </GlassCard>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Total XP" value={stats.xp} icon={Zap} />
        <StatCard label="Streak" value={`${stats.streak} days`} icon={Flame} delay={0.05} />
        <StatCard label="Quizzes Done" value={stats.quizzesCompleted} icon={Trophy} delay={0.1} />
        <StatCard label="Commands" value={stats.commandsGenerated} icon={Terminal} delay={0.15} />
        <StatCard label="Scripts" value={stats.scriptsGenerated} icon={Code} delay={0.2} />
        <StatCard label="Interviews" value={stats.interviewsCompleted} icon={Mic} delay={0.25} />
        <StatCard label="Cheat Sheets" value={stats.cheatSheetsGenerated} icon={FileText} delay={0.3} />
      </div>

      <GlassCard>
        <h3 className="mb-2 text-sm font-medium text-gray-400">Level Progress — {stats.level}</h3>
        <div className="h-3 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-gradient-to-r from-[#E95420] to-[#4CAF50] transition-all duration-700"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Beginner (0) → Intermediate (500) → Advanced (1500) → Expert (3000+)
        </p>
      </GlassCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <GlassCard>
          <h3 className="mb-4 font-semibold text-white">Recent Commands</h3>
          {recentCommands.length === 0 ? (
            <p className="text-sm text-gray-500">No commands yet. Try the AI Command Generator!</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-gray-500">
                    <th className="pb-2">Query</th>
                    <th className="pb-2">Risk</th>
                    <th className="pb-2">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {recentCommands.map((c) => (
                    <tr key={c.id} className="border-t border-white/5">
                      <td className="py-2 font-mono text-[#4CAF50]">{c.command.slice(0, 40)}...</td>
                      <td className="py-2">{c.risk_level}</td>
                      <td className="py-2 text-gray-500">
                        {new Date(c.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>

        <GlassCard delay={0.1}>
          <h3 className="mb-4 font-semibold text-white">Quiz Performance</h3>
          {chartData.length === 0 ? (
            <p className="text-sm text-gray-500">Complete a quiz to see your chart!</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                <XAxis dataKey="name" stroke="#888" fontSize={11} />
                <YAxis stroke="#888" fontSize={11} domain={[0, 100]} />
                <Tooltip
                  contentStyle={{
                    background: "#1a0a2e",
                    border: "1px solid #ffffff20",
                  }}
                />
                <Bar dataKey="score" fill="#E95420" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </GlassCard>
      </div>
    </div>
  );
}
