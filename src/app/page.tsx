import Link from "next/link";
import type { Metadata } from "next";
import {
  Terminal,
  Sparkles,
  Trophy,
  MessageSquare,
  Shield,
  Cpu,
  ArrowRight,
  CheckCircle2,
  Zap,
  BarChart2,
  Code2,
} from "lucide-react";

export const metadata: Metadata = {
  title: "LinLearn — Browser-Native Linux & DevOps Training",
  description:
    "Master Linux and DevOps with a real x86 virtual machine running in your browser. " +
    "AI-powered missions, live terminal, quiz arena — no install required.",
  openGraph: {
    title:       "LinLearn — Browser-Native Linux & DevOps Training",
    description: "Real Linux VM in your browser. AI-powered missions. No install required.",
    type:        "website",
  },
};

// ─── Feature data ─────────────────────────────────────────────────────────────
const FEATURES = [
  {
    icon: Cpu,
    title: "Real Linux VM",
    desc:  "A full x86 kernel running via WebAssembly virtualization — not a sandbox, not a simulation.",
    badge: "v86 WASM",
    accent: "terminal" as const,
  },
  {
    icon: Sparkles,
    title: "AI Command Generator",
    desc:  "Describe what you want in plain English. Get the exact Linux command with explanation.",
    badge: "Llama AI",
    accent: "brand" as const,
  },
  {
    icon: Trophy,
    title: "Mission System",
    desc:  "Cryptographically validated missions that prove real shell work — not checkbox completion.",
    badge: "XP System",
    accent: "amber" as const,
  },
  {
    icon: MessageSquare,
    title: "Linux Tutor",
    desc:  "Ask anything about Linux, DevOps, or shell scripting. Get expert answers instantly.",
    badge: "24/7",
    accent: "sky" as const,
  },
  {
    icon: Shield,
    title: "Security Mode",
    desc:  "Run real permission audits, explore dangerous commands safely, understand Linux security.",
    badge: "Sandboxed",
    accent: "rose" as const,
  },
  {
    icon: BarChart2,
    title: "Mastery Tracking",
    desc:  "Bayesian Knowledge Tracing adapts to your skill level and identifies knowledge gaps.",
    badge: "BKT",
    accent: "purple" as const,
  },
];

const TRACK_ITEMS = [
  "File system navigation",
  "Process management",
  "Permissions & ownership",
  "nginx & web servers",
  "Docker containers",
  "systemd services",
  "Networking fundamentals",
  "Security hardening",
];

const ACCENT_MAP: Record<string, { bg: string; text: string; border: string; badge: string }> = {
  terminal: { bg: "bg-terminal-500/8",  text: "text-terminal-400", border: "border-terminal-500/20", badge: "bg-terminal-500/10 text-terminal-400 border-terminal-500/20" },
  brand:    { bg: "bg-brand-500/8",     text: "text-brand-400",    border: "border-brand-500/20",    badge: "bg-brand-500/10    text-brand-400    border-brand-500/20"    },
  amber:    { bg: "bg-amber-500/8",     text: "text-amber-400",    border: "border-amber-500/20",    badge: "bg-amber-500/10    text-amber-400    border-amber-500/20"    },
  sky:      { bg: "bg-sky-500/8",       text: "text-sky-400",      border: "border-sky-500/20",      badge: "bg-sky-500/10       text-sky-400      border-sky-500/20"      },
  rose:     { bg: "bg-rose-500/8",      text: "text-rose-400",     border: "border-rose-500/20",     badge: "bg-rose-500/10      text-rose-400     border-rose-500/20"     },
  purple:   { bg: "bg-purple-500/8",    text: "text-purple-400",   border: "border-purple-500/20",   badge: "bg-purple-500/10    text-purple-400   border-purple-500/20"   },
};

// ─── Terminal demo preview ────────────────────────────────────────────────────
const TERMINAL_LINES: { prompt?: boolean; text: string; color?: string }[] = [
  { prompt: true, text: "whoami" },
  { text: "student", color: "text-terminal-400" },
  { prompt: true, text: "uname -r" },
  { text: "5.15.0-linlearn", color: "text-sky-400" },
  { prompt: true, text: "docker run -d -p 80:80 nginx" },
  { text: "✓ Container started: 3a7f9c2d8e1b", color: "text-terminal-400" },
  { prompt: true, text: "systemctl status nginx" },
  { text: "● nginx.service — active (running)", color: "text-terminal-400" },
  { prompt: true, text: "_", color: "text-terminal-400" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function HomePage() {
  return (
    <div className="min-h-screen text-ink-primary">
      {/* ── Header ───────────────────────────────────────────── */}
      <header className="sticky top-0 z-sticky border-b border-[var(--border-subtle)] bg-surface-02/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500 shadow-glow-brand">
              <Terminal className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-base font-bold tracking-tight">
              Lin<span className="text-brand-500">Learn</span>
            </span>
          </div>

          {/* Nav */}
          <nav className="hidden items-center gap-6 md:flex" aria-label="Primary">
            {["Features", "Tracks", "Leaderboard"].map((item) => (
              <a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="text-sm text-ink-secondary transition-colors duration-fast hover:text-ink-primary"
              >
                {item}
              </a>
            ))}
          </nav>

          {/* CTA */}
          <div className="flex items-center gap-2">
            <Link
              href="/auth/login"
              className="btn-secondary text-sm px-3 py-1.5"
            >
              Sign in
            </Link>
            <Link
              href="/auth/signup"
              className="btn-primary text-sm px-3.5 py-1.5"
            >
              Start free
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-6 pb-24 pt-20 md:pt-28">
        {/* Background glow rings */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[500px] w-[500px] rounded-full bg-brand-500/[0.03] blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-5xl text-center">
          {/* Pill badge */}
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-500/25 bg-brand-500/8 px-3.5 py-1.5">
            <span className="dot-online" />
            <span className="text-xs font-medium text-brand-400">
              Real Linux kernel — running in your browser
            </span>
          </div>

          {/* H1 */}
          <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-5xl lg:text-6xl">
            Master Linux &amp; DevOps{" "}
            <span className="gradient-text">with a Real VM</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-base text-ink-secondary md:text-lg">
            LinLearn runs a full x86 Ubuntu kernel in WebAssembly — right in your browser.
            AI-powered missions, cryptographic validation, and adaptive mastery tracking.
            No install. No VM setup. Just open and learn.
          </p>

          {/* CTAs */}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/auth/signup"
              className="btn-primary px-6 py-3 text-base shadow-glow-brand"
            >
              <Zap className="h-4 w-4" />
              Start learning free
            </Link>
            <Link
              href="/auth/login"
              className="btn-secondary px-6 py-3 text-base"
            >
              Sign in
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          {/* Social proof numbers */}
          <div className="mt-12 flex flex-wrap items-center justify-center gap-8">
            {[
              { value: "Real VM",  label: "x86 kernel"       },
              { value: "6 tracks", label: "learning paths"   },
              { value: "AI-first", label: "mission system"   },
              { value: "Free",     label: "to get started"   },
            ].map(({ value, label }) => (
              <div key={label} className="text-center">
                <p className="text-xl font-bold text-ink-primary">{value}</p>
                <p className="text-xs text-ink-tertiary">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Terminal Preview ──────────────────────────────────── */}
      <section className="px-6 pb-24">
        <div className="mx-auto max-w-4xl">
          {/* Window chrome */}
          <div className="overflow-hidden rounded-[10px] terminal-surface">
            {/* Title bar */}
            <div className="flex items-center gap-0 h-9 px-4 bg-[#0d0f14] border-b border-white/[0.05]">
              <div className="flex items-center gap-1.5 mr-4">
                <div className="h-3 w-3 rounded-full bg-[#ff5f57] border border-black/20" />
                <div className="h-3 w-3 rounded-full bg-[#ffbd2e] border border-black/20" />
                <div className="h-3 w-3 rounded-full bg-[#28c840] border border-black/20" />
              </div>
              <div className="flex items-center gap-2 rounded-md bg-white/[0.05] border border-white/[0.07] px-2.5 py-1">
                <span className="dot-online" />
                <span className="text-[11px] font-mono text-[#9d94bb]">bash — linlearn v86</span>
              </div>
            </div>

            {/* Terminal lines */}
            <div className="bg-[#08090e] p-5 font-mono text-[13px] leading-7 min-h-[280px]">
              {TERMINAL_LINES.map((line, i) => (
                <div key={i} className={line.color ?? "text-[#dde1f0]"}>
                  {line.prompt ? (
                    <>
                      <span className="text-brand-400 font-semibold">student</span>
                      <span className="text-[#635b80]">@</span>
                      <span className="text-terminal-400 font-semibold">linlearn</span>
                      <span className="text-[#635b80]">:~$ </span>
                      {line.text === "_" ? (
                        <span className="animate-cursor-blink inline-block h-4 w-1.5 bg-terminal-400 align-middle" />
                      ) : (
                        line.text
                      )}
                    </>
                  ) : (
                    line.text
                  )}
                </div>
              ))}
            </div>
          </div>

          <p className="mt-4 text-center text-xs text-ink-tertiary">
            Live WebAssembly Linux VM — this is real shell output, not a simulation
          </p>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────── */}
      <section id="features" className="px-6 pb-24">
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold tracking-tight">
              Built for engineers who learn by doing
            </h2>
            <p className="mt-3 text-ink-secondary">
              Every feature is designed to build real skills, not just familiarity.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, desc, badge, accent }) => {
              const a = ACCENT_MAP[accent];
              return (
                <div
                  key={title}
                  className={`relative rounded-xl border p-5 transition-all duration-normal hover:-translate-y-px hover:shadow-e3 ${a.border} ${a.bg}`}
                >
                  {/* Badge */}
                  <span className={`badge border text-2xs mb-4 ${a.badge}`}>{badge}</span>

                  <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-lg ${a.bg} border ${a.border}`}>
                    <Icon className={`h-[18px] w-[18px] ${a.text}`} />
                  </div>

                  <h3 className="mb-2 text-sm font-semibold text-ink-primary">{title}</h3>
                  <p className="text-sm text-ink-tertiary leading-relaxed">{desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Learning Tracks ───────────────────────────────────── */}
      <section id="tracks" className="px-6 pb-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold tracking-tight">
              What you will master
            </h2>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {TRACK_ITEMS.map((item) => (
              <div
                key={item}
                className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-surface-03/60 px-4 py-3"
              >
                <CheckCircle2 className="h-4 w-4 shrink-0 text-terminal-500" />
                <span className="text-sm text-ink-secondary">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────── */}
      <section className="px-6 pb-24">
        <div className="mx-auto max-w-2xl rounded-2xl border border-brand-500/20 bg-brand-500/6 p-10 text-center">
          <Code2 className="mx-auto mb-4 h-8 w-8 text-brand-500" />
          <h2 className="text-2xl font-bold tracking-tight">
            Open a real Linux shell in 10 seconds
          </h2>
          <p className="mt-3 text-sm text-ink-secondary">
            No credit card. No install. No Docker. Just a browser.
          </p>
          <Link
            href="/auth/signup"
            className="btn-primary mt-6 inline-flex px-8 py-3 text-base shadow-glow-brand"
          >
            Start for free
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="border-t border-[var(--border-subtle)] px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 text-center sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-brand-500" />
            <span className="text-sm font-semibold text-ink-primary">LinLearn</span>
          </div>
          <p className="text-xs text-ink-tertiary">
            Commands executed in a sandboxed WebAssembly VM. For educational use only.
          </p>
        </div>
      </footer>
    </div>
  );
}
