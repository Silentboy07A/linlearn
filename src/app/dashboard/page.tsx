"use client";

import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Dashboard } from "@/components/Dashboard";
import { CommandGenerator } from "@/components/CommandGenerator";
import { ShellScriptGenerator } from "@/components/ShellScriptGenerator";
import { Chatbot } from "@/components/Chatbot";
import { QuizArena } from "@/components/QuizArena";
import { MockInterview } from "@/components/MockInterview";
import { ErrorExplainer } from "@/components/ErrorExplainer";
import { CheatSheetGenerator } from "@/components/CheatSheetGenerator";
import { CommandHistory } from "@/components/CommandHistory";
import { Settings } from "@/components/Settings";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import type {
  CommandHistoryRow,
  DashboardStats,
  ModuleId,
  Profile,
  Progress,
  QuizResultRow,
} from "@/types";

export default function DashboardPage() {
  const [active, setActive] = useState<ModuleId>("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentCommands, setRecentCommands] = useState<CommandHistoryRow[]>([]);
  const [quizResults, setQuizResults] = useState<QuizResultRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) return;
      const data = await res.json();
      setProfile(data.profile);
      setStats(data.stats);
      setRecentCommands(data.recentCommands);
      setQuizResults(data.quizResults);
      if (data.stats) {
        setProgress({
          id: "",
          user_id: data.profile?.id || "",
          xp: data.stats.xp,
          streak: data.stats.streak,
          level: data.stats.level,
          last_active: new Date().toISOString().split("T")[0],
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSuccess = () => refresh();

  const renderModule = () => {
    if (loading && active === "dashboard") return <LoadingSpinner />;
    switch (active) {
      case "dashboard":
        return stats ? (
          <Dashboard
            profile={profile}
            stats={stats}
            recentCommands={recentCommands}
            quizResults={quizResults}
          />
        ) : (
          <LoadingSpinner />
        );
      case "command":
        return <CommandGenerator onSuccess={onSuccess} />;
      case "script":
        return <ShellScriptGenerator onSuccess={onSuccess} />;
      case "chat":
        return <Chatbot onSuccess={onSuccess} />;
      case "quiz":
        return <QuizArena onSuccess={onSuccess} />;
      case "interview":
        return <MockInterview onSuccess={onSuccess} />;
      case "error":
        return <ErrorExplainer onSuccess={onSuccess} />;
      case "cheatsheet":
        return <CheatSheetGenerator onSuccess={onSuccess} />;
      case "history":
        return <CommandHistory />;
      case "settings":
        return <Settings profile={profile} onUpdate={refresh} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-screen bg-[#1a0a2e]">
      <Sidebar
        active={active}
        onNavigate={setActive}
        profile={profile}
        progress={progress}
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
      />
      <main className="flex-1 overflow-auto p-4 pb-24 pt-16 lg:p-8 lg:pb-8 lg:pt-8">
        {renderModule()}
      </main>
    </div>
  );
}
