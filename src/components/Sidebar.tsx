"use client";

import {
  LayoutDashboard,
  Terminal,
  Monitor,
  Code,
  MessageSquare,
  Trophy,
  BarChart2,
  Mic,
  AlertTriangle,
  FileText,
  History,
  Settings,
  LogOut,
  Menu,
  X,
  Flame,
  Bookmark,
  ChevronRight,
  Zap,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { XPBar }      from "./XPBar";
import { LevelBadge } from "./LevelBadge";
import { cn }         from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { DRAWER, MODAL_OVERLAY, STAGGER_CONTAINER_FAST, STAGGER_ITEM } from "@/lib/motion";
import type { ModuleId, Profile, Progress } from "@/types";

// ─── Navigation Groups ───────────────────────────────────────────────────────

const NAV_GROUPS: {
  group: string;
  items: { id: ModuleId; label: string; icon: typeof Terminal; badge?: string }[];
}[] = [
  {
    group: "Learn",
    items: [
      { id: "dashboard",   label: "Dashboard",          icon: LayoutDashboard },
      { id: "terminal",    label: "Linux Terminal",      icon: Monitor,         badge: "Live" },
      { id: "quiz",        label: "Quiz Arena",          icon: Trophy },
      { id: "interview",   label: "Mock Interview",      icon: Mic },
    ],
  },
  {
    group: "Tools",
    items: [
      { id: "command",     label: "Command Generator",   icon: Terminal },
      { id: "script",      label: "Script Generator",    icon: Code },
      { id: "chat",        label: "Linux Tutor",         icon: MessageSquare },
      { id: "error",       label: "Error Explainer",     icon: AlertTriangle },
      { id: "cheatsheet",  label: "Cheat Sheets",        icon: FileText },
    ],
  },
  {
    group: "Progress",
    items: [
      { id: "history",     label: "Command History",     icon: History },
      { id: "leaderboard", label: "Leaderboard",         icon: BarChart2 },
      { id: "bookmarks",   label: "Bookmarks",           icon: Bookmark },
      { id: "settings",    label: "Settings",            icon: Settings },
    ],
  },
];

// Bottom-nav subset for mobile (icons only with labels)
const MOBILE_NAV = [
  { id: "dashboard"  as ModuleId, icon: LayoutDashboard, label: "Home"     },
  { id: "terminal"   as ModuleId, icon: Monitor,          label: "Terminal" },
  { id: "quiz"       as ModuleId, icon: Trophy,           label: "Quiz"     },
  { id: "chat"       as ModuleId, icon: MessageSquare,    label: "Tutor"    },
  { id: "settings"   as ModuleId, icon: Settings,         label: "Settings" },
];

// ─── Nav Item ────────────────────────────────────────────────────────────────

function NavItem({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  id: _id, label, icon: Icon, badge, active, onClick,
}: {
  id:      ModuleId;
  label:   string;
  icon:    typeof Terminal;
  badge?:  string;
  active:  boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      variants={STAGGER_ITEM}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm",
        "transition-all duration-fast focus-visible:ring-2 focus-visible:ring-brand-500/50",
        "active:scale-[0.98]",
        active
          ? "bg-brand-500/10 text-brand-400 font-medium"
          : "text-ink-tertiary hover:bg-white/[0.04] hover:text-ink-secondary"
      )}
      aria-current={active ? "page" : undefined}
    >
      {/* Active indicator bar */}
      {active && (
        <motion.span
          layoutId="sidebar-active"
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-brand-500"
          transition={{ type: "spring", stiffness: 420, damping: 30 }}
        />
      )}

      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-brand-500" : "text-inherit")} />
      <span className="flex-1 truncate">{label}</span>

      {badge && (
        <span className="badge-terminal text-2xs shrink-0">{badge}</span>
      )}

      {active && (
        <ChevronRight className="h-3 w-3 shrink-0 text-brand-500/60" />
      )}
    </motion.button>
  );
}

// ─── Sidebar Content ─────────────────────────────────────────────────────────

interface SidebarProps {
  active:        ModuleId;
  onNavigate:    (id: ModuleId) => void;
  profile:       Profile | null;
  progress:      Progress | null;
  mobileOpen:    boolean;
  setMobileOpen: (v: boolean) => void;
}

function SidebarContent({
  active, onNavigate, profile, progress, setMobileOpen,
}: Omit<SidebarProps, "mobileOpen">) {
  const logout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/auth/login";
  };

  const navigate = (id: ModuleId) => {
    onNavigate(id);
    setMobileOpen(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Logo ─────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2.5 px-4 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 shadow-glow-brand">
          <Terminal className="h-4 w-4 text-white" />
        </div>
        <span className="text-lg font-bold tracking-tight text-ink-primary">
          Lin<span className="text-brand-500">Learn</span>
        </span>
      </div>

      {/* ── User Card ─────────────────────────────────────────── */}
      {profile && (
        <div className="mx-3 mb-3 shrink-0 rounded-lg border border-[var(--border-subtle)] bg-surface-02/60 p-3">
          <div className="flex items-center gap-2.5">
            {/* Avatar */}
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500/15 ring-1 ring-brand-500/30 text-sm font-bold text-brand-400">
              {(profile.username?.[0] ?? "U").toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink-primary">
                {profile.username ?? "User"}
              </p>
              {progress && <LevelBadge level={progress.level} />}
            </div>
          </div>

          {/* XP bar */}
          {progress && (
            <div className="mt-3">
              <XPBar xp={progress.xp} />
            </div>
          )}
        </div>
      )}

      {/* ── Navigation ────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-3 pb-2" aria-label="Main navigation">
        <motion.div
          variants={STAGGER_CONTAINER_FAST}
          initial="initial"
          animate="animate"
          className="space-y-4"
        >
          {NAV_GROUPS.map(({ group, items }) => (
            <div key={group}>
              <p className="section-header mb-1.5 px-3">{group}</p>
              <div className="space-y-0.5">
                {items.map(({ id, label, icon, badge }) => (
                  <NavItem
                    key={id}
                    id={id}
                    label={label}
                    icon={icon}
                    badge={badge}
                    active={active === id}
                    onClick={() => navigate(id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </motion.div>
      </nav>

      {/* ── Footer ───────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-[var(--border-subtle)] px-3 py-3 space-y-2">
        {/* Streak pill */}
        {progress && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2">
            <Flame className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span className="text-xs font-medium text-amber-300">
              {progress.streak} day{progress.streak === 1 ? "" : "s"} streak
            </span>
            <div className="ml-auto flex items-center gap-0.5">
              {Array.from({ length: Math.min(progress.streak, 7) }).map((_, i) => (
                <div
                  key={i}
                  className="h-1.5 w-1.5 rounded-full bg-amber-400/60"
                  style={{ opacity: 0.4 + (i / 7) * 0.6 }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Keyboard shortcut hint */}
        <div className="flex items-center gap-2 px-1">
          <Zap className="h-3 w-3 text-ink-muted shrink-0" />
          <span className="text-2xs text-ink-muted flex-1">Command palette</span>
          <kbd className="rounded border border-[var(--border-subtle)] bg-surface-02 px-1.5 py-0.5 text-2xs font-mono text-ink-tertiary">
            ⌘K
          </kbd>
        </div>

        {/* Logout */}
        <button
          type="button"
          onClick={logout}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-tertiary
                     transition-all duration-fast hover:bg-status-error/8 hover:text-status-error
                     focus-visible:ring-2 focus-visible:ring-status-error/40 active:scale-[0.98]"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
}

// ─── Sidebar Shell ───────────────────────────────────────────────────────────

export function Sidebar({
  active, onNavigate, profile, progress, mobileOpen, setMobileOpen,
}: SidebarProps) {
  const contentProps = { active, onNavigate, profile, progress, setMobileOpen };

  return (
    <>
      {/* ── Mobile hamburger ──────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-4 z-sticky rounded-lg border border-[var(--border-default)]
                   bg-surface-01/90 p-2 backdrop-blur-md lg:hidden
                   focus-visible:ring-2 focus-visible:ring-brand-500/50 active:scale-95"
        aria-label="Open navigation"
      >
        <Menu className="h-4 w-4 text-ink-secondary" />
      </button>

      {/* ── Desktop sidebar ───────────────────────────────────── */}
      <aside
        id="sidebar"
        className="hidden lg:flex"
        aria-label="Sidebar navigation"
      >
        <SidebarContent {...contentProps} />
      </aside>

      {/* ── Mobile drawer ─────────────────────────────────────── */}
      <AnimatePresence>
        {mobileOpen && (
          <div className="fixed inset-0 z-modal lg:hidden" role="dialog" aria-modal="true">
            {/* Scrim */}
            <motion.div
              variants={MODAL_OVERLAY}
              initial="initial"
              animate="animate"
              exit="exit"
              className="absolute inset-0 bg-surface-overlay"
              onClick={() => setMobileOpen(false)}
            />
            {/* Drawer */}
            <motion.aside
              variants={DRAWER}
              initial="initial"
              animate="animate"
              exit="exit"
              className="absolute left-0 top-0 h-full w-72 border-r border-[var(--border-subtle)]
                         bg-surface-01 shadow-e4"
            >
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="btn-icon absolute right-3 top-3 z-10"
                aria-label="Close navigation"
              >
                <X className="h-4 w-4" />
              </button>
              <SidebarContent {...contentProps} />
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      {/* ── Mobile bottom nav ─────────────────────────────────── */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-sticky flex justify-around border-t
                   border-[var(--border-subtle)] bg-surface-01/95 px-2 pb-safe pt-1.5
                   backdrop-blur-xl lg:hidden"
        aria-label="Mobile navigation"
      >
        {MOBILE_NAV.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onNavigate(id)}
            aria-label={label}
            aria-current={active === id ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-1 rounded-md px-3 py-1.5 text-2xs font-medium",
              "transition-all duration-fast active:scale-95",
              "focus-visible:ring-2 focus-visible:ring-brand-500/50",
              active === id
                ? "text-brand-400"
                : "text-ink-muted hover:text-ink-secondary"
            )}
          >
            <Icon className={cn("h-5 w-5", active === id && "text-brand-500")} />
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}
