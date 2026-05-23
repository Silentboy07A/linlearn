"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { TerminalSimulator } from "@/components/TerminalSimulator";
import { BookmarksPage } from "@/components/BookmarksPage";
import { Leaderboard } from "@/components/Leaderboard";
import { createClient } from "@/lib/supabase/client";
import { addXp } from "@/lib/supabase/progress";
import {
  seedTimeline,
  type QuizSummary,
  type SessionCommand,
  type XpDailyPoint,
  type TerminalPrefs,
  type TerminalTheme,
  type TerminalFontSize,
} from "@/lib/session";
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
  const [allCommands, setAllCommands] = useState<SessionCommand[]>([]);
  const [bookmarks, setBookmarks] = useState<SessionCommand[]>([]);
  const clearSignal = 0;
  const [terminalPrefs, setTerminalPrefs] = useState<TerminalPrefs>({
    theme: "green",
    fontSize: "medium",
    showSourceTags: true,
  });

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

  useEffect(() => {
    const savedPrefs = localStorage.getItem("terminalPrefs");
    if (savedPrefs) {
      try {
        setTerminalPrefs(JSON.parse(savedPrefs));
      } catch (e) {
        console.error("Failed to parse terminalPrefs", e);
      }
    }
    const savedBookmarks = localStorage.getItem("bookmarks");
    if (savedBookmarks) {
      try {
        setBookmarks(JSON.parse(savedBookmarks));
      } catch (e) {
        console.error("Failed to parse bookmarks", e);
      }
    }
  }, []);

  // Fetch all history entries when on History tab
  useEffect(() => {
    if (active === "history" && profile?.id) {
      const fetchAllHistory = async () => {
        try {
          const supabase = createClient();
          const { data, error } = await supabase
            .from("command_history")
            .select("id, query, command, explanation, risk_level, created_at")
            .eq("user_id", profile.id)
            .order("created_at", { ascending: false });

          if (!error && data) {
            const mapped = data.map((item) => ({
              id: item.id,
              input: item.command,
              output: item.explanation || "",
              source: "ai-generated" as const,
              createdAt: item.created_at,
            }));
            setAllCommands(mapped);
          }
        } catch (e) {
          console.error("Failed to fetch command history", e);
        }
      };
      fetchAllHistory();
    }
  }, [active, profile?.id]);

  const onSuccess = () => refresh();

  const handleThemeChange = useCallback((theme: TerminalTheme) => {
    setTerminalPrefs((prev) => {
      const next = { ...prev, theme };
      localStorage.setItem("terminalPrefs", JSON.stringify(next));
      return next;
    });
  }, []);

  const handleFontSizeChange = useCallback((fontSize: TerminalFontSize) => {
    setTerminalPrefs((prev) => {
      const next = { ...prev, fontSize };
      localStorage.setItem("terminalPrefs", JSON.stringify(next));
      return next;
    });
  }, []);


  const handleCopy = useCallback(() => {
    // Handled in sub-components
  }, []);

  const handleToggleBookmark = useCallback((cmd: SessionCommand) => {
    setBookmarks((prev) => {
      const exists = prev.some((b) => b.id === cmd.id);
      let next;
      if (exists) {
        next = prev.filter((b) => b.id !== cmd.id);
      } else {
        next = [...prev, cmd];
      }
      localStorage.setItem("bookmarks", JSON.stringify(next));
      return next;
    });
  }, []);

  const isBookmarked = useCallback((cmdId: string) => {
    return bookmarks.some((b) => b.id === cmdId);
  }, [bookmarks]);

  const handleCommandLogged = useCallback(async (item: SessionCommand) => {
    if (!profile?.id) return;
    try {
      const supabase = createClient();
      await supabase.from("command_history").insert({
        user_id: profile.id,
        query: item.input,
        command: item.input,
        explanation: item.output,
        risk_level: "Low",
      });

      await addXp(supabase, profile.id, 10);
      refresh();
    } catch (e) {
      console.error("Failed to log command or award XP:", e);
    }
  }, [profile?.id, refresh]);

  const handleDbFallback = useCallback(async () => {
    // No-op
  }, []);

  const handleUsernameChange = useCallback(async (value: string) => {
    if (!profile?.id) return;
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("profiles")
        .update({ username: value })
        .eq("id", profile.id);
      if (error) throw error;
      refresh();
    } catch (e) {
      console.error("Failed to update username:", e);
    }
  }, [profile?.id, refresh]);

  const handleResetXp = useCallback(async () => {
    if (!profile?.id) return;
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("progress")
        .update({ xp: 0, level: "Beginner" })
        .eq("user_id", profile.id);
      if (error) throw error;
      refresh();
    } catch (e) {
      console.error("Failed to reset XP:", e);
    }
  }, [profile?.id, refresh]);

  const handleResetStreak = useCallback(async () => {
    if (!profile?.id) return;
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("progress")
        .update({ streak: 0 })
        .eq("user_id", profile.id);
      if (error) throw error;
      refresh();
    } catch (e) {
      console.error("Failed to reset streak:", e);
    }
  }, [profile?.id, refresh]);

  const mappedCommands = useMemo<SessionCommand[]>(() => {
    return recentCommands.map((item) => ({
      id: item.id,
      input: item.command,
      output: item.explanation || "",
      source: "ai-generated",
      createdAt: item.created_at,
    }));
  }, [recentCommands]);

  const mappedQuizHistory = useMemo<QuizSummary[]>(() => {
    return quizResults.map((item) => {
      const scorePercent = item.total > 0 ? Math.round((item.score / item.total) * 100) : 0;
      const xpEarned = item.score * 20;
      return {
        id: item.id,
        category: item.category,
        correct: item.score,
        wrong: item.total - item.score,
        total: item.total,
        xpEarned,
        timeTakenSec: 0,
        scorePercent,
        createdAt: item.created_at,
      };
    });
  }, [quizResults]);

  const xpTimeline = useMemo<XpDailyPoint[]>(() => {
    const timelineMap = new Map<string, number>();
    const baseTimeline = seedTimeline(30);
    baseTimeline.forEach((point) => {
      timelineMap.set(point.date, 0);
    });

    recentCommands.forEach((cmd) => {
      const dateKey = cmd.created_at.slice(0, 10);
      if (timelineMap.has(dateKey)) {
        timelineMap.set(dateKey, (timelineMap.get(dateKey) || 0) + 10);
      }
    });

    quizResults.forEach((quiz) => {
      const dateKey = quiz.created_at.slice(0, 10);
      if (timelineMap.has(dateKey)) {
        timelineMap.set(dateKey, (timelineMap.get(dateKey) || 0) + quiz.score * 20);
      }
    });

    return baseTimeline.map((point) => ({
      date: point.date,
      xp: timelineMap.get(point.date) || 0,
    }));
  }, [recentCommands, quizResults]);

  const renderModule = () => {
    if (loading && active === "dashboard") return <LoadingSpinner />;
    switch (active) {
      case "dashboard":
        return stats ? (
          <Dashboard
            username={profile?.username || "hacker"}
            xp={stats.xp}
            streak={stats.streak}
            commands={mappedCommands}
            quizHistory={mappedQuizHistory}
            xpTimeline={xpTimeline}
          />
        ) : (
          <LoadingSpinner />
        );
      case "command":
        return (
          <CommandGenerator
            onSuccess={onSuccess}
            onCommandGenerated={handleCommandLogged}
            onCopy={handleCopy}
            onToggleBookmark={handleToggleBookmark}
            isBookmarked={isBookmarked}
          />
        );
      case "terminal":
        return (
          <TerminalSimulator
            prefs={terminalPrefs}
            clearSignal={clearSignal}
            onCommandLogged={handleCommandLogged}
            onDbFallback={handleDbFallback}
          />
        );
      case "script":
        return <ShellScriptGenerator onSuccess={onSuccess} />;
      case "chat":
        return <Chatbot onSuccess={onSuccess} />;
      case "quiz":
        return (
          <QuizArena
            onAwardXp={async (amount) => {
              if (profile?.id) {
                const supabase = createClient();
                await addXp(supabase, profile.id, amount);
                refresh();
              }
            }}
            onComplete={async (summary) => {
              if (profile?.id) {
                const supabase = createClient();
                await supabase.from("quiz_results").insert({
                  user_id: profile.id,
                  category: summary.category,
                  score: summary.correct,
                  total: summary.total,
                  difficulty: "Beginner",
                });
                refresh();
              }
            }}
          />
        );
      case "interview":
        return (
          <MockInterview
            onAwardXp={async (amount) => {
              if (profile?.id) {
                const supabase = createClient();
                await addXp(supabase, profile.id, amount);
                refresh();
              }
            }}
            onHistoryAdd={async (item) => {
              if (profile?.id) {
                const supabase = createClient();
                await supabase.from("interview_sessions").insert({
                  user_id: profile.id,
                  topic: "Linux & DevOps Q: " + item.question.slice(0, 50),
                  total_questions: 1,
                  score: item.score,
                  feedback: JSON.stringify({
                    good: item.good,
                    missing: item.missing,
                    modelAnswer: item.modelAnswer,
                    answer: item.answer,
                  }),
                });
                refresh();
              }
            }}
          />
        );
      case "error":
        return <ErrorExplainer onSuccess={onSuccess} />;
      case "cheatsheet":
        return <CheatSheetGenerator onSuccess={onSuccess} />;
      case "history":
        return <CommandHistory rows={allCommands.length > 0 ? allCommands : mappedCommands} onCopy={handleCopy} />;
      case "leaderboard":
        return <Leaderboard username={profile?.username || "hacker"} xp={stats?.xp || 0} />;
      case "bookmarks":
        return (
          <BookmarksPage
            bookmarks={bookmarks}
            onRemove={(id) => {
              const next = bookmarks.filter((b) => b.id !== id);
              setBookmarks(next);
              localStorage.setItem("bookmarks", JSON.stringify(next));
            }}
            onCopy={handleCopy}
          />
        );
      case "settings":
        return (
          <Settings
            username={profile?.username || "hacker"}
            prefs={terminalPrefs}
            onUsernameChange={handleUsernameChange}
            onThemeChange={handleThemeChange}
            onFontSizeChange={handleFontSizeChange}
            onResetXp={handleResetXp}
            onResetStreak={handleResetStreak}
          />
        );
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
