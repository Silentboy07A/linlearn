"use client";

import {
  LayoutDashboard,
  Terminal,
  Monitor,
  Code,
  MessageSquare,
  Trophy,
  Star,
  Mic,
  AlertTriangle,
  FileText,
  History,
  Settings,
  LogOut,
  Menu,
  X,
  Flame,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { XPBar } from "./XPBar";
import { LevelBadge } from "./LevelBadge";
import { cn } from "@/lib/utils";
import type { ModuleId, Profile, Progress } from "@/types";

const NAV: { id: ModuleId; label: string; icon: typeof Terminal }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "command", label: "AI Command Generator", icon: Terminal },
  { id: "terminal", label: "Terminal Simulator", icon: Monitor },
  { id: "script", label: "Shell Script Generator", icon: Code },
  { id: "chat", label: "Linux Chatbot", icon: MessageSquare },
  { id: "quiz", label: "Quiz Arena", icon: Trophy },
  { id: "interview", label: "Mock Interview", icon: Mic },
  { id: "error", label: "Error Explainer", icon: AlertTriangle },
  { id: "cheatsheet", label: "Cheat Sheet Generator", icon: FileText },
  { id: "history", label: "Command History", icon: History },
  { id: "leaderboard", label: "Leaderboard", icon: Trophy },
  { id: "bookmarks", label: "Bookmarks", icon: Star },
  { id: "settings", label: "Settings", icon: Settings },
];

interface SidebarProps {
  active: ModuleId;
  onNavigate: (id: ModuleId) => void;
  profile: Profile | null;
  progress: Progress | null;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
}

export function Sidebar({
  active,
  onNavigate,
  profile,
  progress,
  mobileOpen,
  setMobileOpen,
}: SidebarProps) {
  const logout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/auth/login";
  };

  const content = (
    <div className="flex h-full flex-col p-4">
      <div className="mb-6 flex items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#E95420]">
          <Terminal className="h-5 w-5 text-white" />
        </div>
        <span className="text-xl font-bold text-[#E95420]">LinLearn</span>
      </div>

      {profile && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E95420]/30 text-sm font-bold text-[#E95420]">
            {(profile.username?.[0] || "U").toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-white">{profile.username || "User"}</p>
            {progress && <LevelBadge level={progress.level} />}
          </div>
        </div>
      )}

      <nav className="flex-1 space-y-1 overflow-y-auto">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              onNavigate(id);
              setMobileOpen(false);
            }}
            className={cn(
              "micro-button flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition",
              active === id
                ? "border border-[#E95420]/30 bg-[#E95420]/15 text-[#E95420]"
                : "text-gray-400 hover:bg-white/5 hover:text-white"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </nav>

      {progress && (
        <div className="mt-4 border-t border-white/10 pt-4">
          <XPBar xp={progress.xp} />
          <div className="mt-3 flex items-center gap-2 rounded-md border border-orange-500/30 bg-orange-500/10 px-2.5 py-2 text-xs text-orange-200">
            <Flame className="h-3.5 w-3.5" />
            <span>Streak: {progress.streak} day{progress.streak === 1 ? "" : "s"}</span>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={logout}
        className="micro-button mt-4 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-red-500/10 hover:text-red-400"
      >
        <LogOut className="h-4 w-4" />
        Logout
      </button>
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-4 z-50 rounded-lg border border-white/10 bg-[#1a0a2e] p-2 lg:hidden"
        aria-label="Menu"
      >
        <Menu className="h-5 w-5 text-white" />
      </button>

      <aside className="hidden w-64 shrink-0 border-r border-white/10 bg-[#120a1c]/95 backdrop-blur-xl lg:block">
        {content}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => setMobileOpen(false)}
            role="presentation"
          />
          <aside className="absolute left-0 top-0 h-full w-72 border-r border-white/10 bg-[#120a1c]">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-3 text-gray-400"
            >
              <X className="h-5 w-5" />
            </button>
            {content}
          </aside>
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 z-40 flex justify-around border-t border-white/10 bg-[#120a1c]/95 p-2 backdrop-blur lg:hidden">
        {NAV.slice(0, 6).map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onNavigate(id)}
            className={cn(
              "micro-button rounded-md p-2",
              active === id ? "text-[#E95420]" : "text-gray-500"
            )}
          >
            <Icon className="h-5 w-5" />
          </button>
        ))}
      </nav>
    </>
  );
}
