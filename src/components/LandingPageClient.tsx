"use client";
// src/components/LandingPageClient.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Client-side landing page layout for LinLearn.
// Fully animated via framer-motion. Focuses on premium visual rhythm,
// terminal cockpit realism, and click/hover micro-interactions.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Terminal as TermIcon,
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

// ─── Constants & Settings ───────────────────────────────────────────────────

const FADE_UP = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { ease: [0.16, 1, 0.3, 1], duration: 0.8 },
};

const STAGGER = {
  animate: {
    transition: {
      staggerChildren: 0.08,
    },
  },
};

const SPRING_TAP = { whileHover: { scale: 1.02 }, whileTap: { scale: 0.98 } };

const TRACK_ITEMS = [
  "File system navigation & paths",
  "Process management & signals",
  "Permissions, ownership & ACLs",
  "nginx reverse proxy configurations",
  "Docker container orchestration",
  "systemd unit service files",
  "Networking & port binding",
  "Security audit & user hardening",
];

interface TerminalLine {
  type: "input" | "output" | "prompt";
  text: string;
  color?: string;
}

const DEMO_STEPS = [
  { type: "input", text: "uname -a" },
  { type: "output", text: "Linux linlearn 5.15.0-v86-generic #1 SMP x86_64 GNU/Linux", color: "text-[#9d94bb]/80" },
  { type: "input", text: "docker run -d -p 80:80 nginx" },
  { type: "output", text: "✓ Container starts: 3a7f9c2d8e1b\n✓ Local port 80 bound to guest container port 80", color: "text-terminal-400" },
  { type: "input", text: "curl -I http://localhost" },
  { type: "output", text: "HTTP/1.1 200 OK\nServer: nginx/1.25.3\nContent-Type: text/html\nContent-Length: 615\nConnection: keep-alive", color: "text-cyan-400" },
  { type: "input", text: "clear" }
];

const FEATURES = [
  {
    icon: Cpu,
    title: "WebAssembly Virtualization",
    desc: "A full x86 hardware simulation compiling Linux kernel instructions in real-time browser sandbox. True client-side virtual hardware.",
    badge: "v86 WASM",
    color: "terminal" as const,
  },
  {
    icon: Sparkles,
    title: "AI Interactive Tutor",
    desc: "Describe DevOps procedures in plain English. Generates valid Linux commands, maps paths, and explains flags step by step.",
    badge: "Mistral-7B AI",
    color: "brand" as const,
  },
  {
    icon: Trophy,
    title: "PTY Signal Validation",
    desc: "Every command is cryptographically validated inside the VM. Learn via feedback, not static multiple-choice tests.",
    badge: "XP Level Up",
    color: "amber" as const,
  },
  {
    icon: MessageSquare,
    title: "DevOps Sandbox",
    desc: "Safe environment for dangerous scripts. Test file permission overrides, process shutdowns, or Nginx configurations safely.",
    badge: "Isolated",
    color: "sky" as const,
  },
  {
    icon: Shield,
    title: "Persistent Filesystem",
    desc: "Changes automatically persist to browser IndexedDB storage. Save snapshots, load boot points, and resume missions instantly.",
    badge: "IndexedDB",
    color: "rose" as const,
  },
  {
    icon: BarChart2,
    title: "Adaptive Mastery System",
    desc: "Built-in Bayesian Knowledge Tracing maps command history, finds gaps, and dynamically serves custom learning pathways.",
    badge: "BKT Engine",
    color: "purple" as const,
  },
];

const ACCENT_MAP: Record<string, { text: string; border: string; badge: string }> = {
  terminal: { text: "text-terminal-400", border: "border-terminal-500/20", badge: "bg-terminal-500/10 text-terminal-400 border-terminal-500/20" },
  brand:    { text: "text-brand-400",    border: "border-brand-500/20",    badge: "bg-brand-500/10    text-brand-400    border-brand-500/20"    },
  amber:    { text: "text-amber-400",    border: "border-amber-500/20",    badge: "bg-amber-500/10    text-amber-400    border-amber-500/20"    },
  sky:      { text: "text-sky-400",      border: "border-sky-500/20",      badge: "bg-sky-500/10       text-sky-400      border-sky-500/20"      },
  rose:     { text: "text-rose-400",     border: "border-rose-500/20",     badge: "bg-rose-500/10      text-rose-400     border-rose-500/20"     },
  purple:   { text: "text-purple-400",   border: "border-purple-500/20",   badge: "bg-purple-500/10    text-purple-400   border-purple-500/20"   },
};

// ─── Sub-Components ─────────────────────────────────────────────────────────

function CardWithGlow({ children, className, accentColor }: { children: React.ReactNode; className?: string; accentColor: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    ref.current.style.setProperty("--mouse-x", `${x}px`);
    ref.current.style.setProperty("--mouse-y", `${y}px`);
  };

  const a = ACCENT_MAP[accentColor] || ACCENT_MAP.brand;

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      className={`premium-card p-5 group flex flex-col justify-between hover:border-brand-500/30 hover:shadow-glow-brand ${a.border} ${className}`}
    >
      {children}
    </div>
  );
}

function VMTelemetryHUD() {
  const [cpu, setCpu] = useState(2.8);
  const [ram, setRam] = useState(48.2);
  const [netIn, setNetIn] = useState(0.0);
  const [netOut, setNetOut] = useState(0.0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCpu(prev => Math.max(1.2, Math.min(22.8, prev + (Math.random() - 0.5) * 3)));
      setRam(prev => Math.max(47.9, Math.min(49.1, prev + (Math.random() - 0.5) * 0.1)));
      setNetIn(prev => Math.random() > 0.85 ? Math.random() * 18.5 : Math.max(0, prev * 0.4));
      setNetOut(prev => Math.random() > 0.85 ? Math.random() * 11.2 : Math.max(0, prev * 0.4));
    }, 900);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex flex-wrap items-center justify-between border-t border-white/[0.05] bg-[#0c0e14]/90 px-4 py-2.5 text-[10px] font-mono text-gray-500 gap-2 shrink-0 select-none">
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-[#4CAF50] animate-pulse" />
        <span className="text-gray-400 font-bold">WASM VM STATE: BOOTED</span>
      </div>
      <div className="flex items-center gap-4">
        <div>CPU: <span className="text-gray-300 tabular">{cpu.toFixed(1)}%</span></div>
        <div>RAM: <span className="text-gray-300 tabular">{ram.toFixed(1)}% (128MB)</span></div>
        <div>NET RX: <span className="text-gray-300 tabular">{netIn.toFixed(1)} KB/s</span></div>
        <div>NET TX: <span className="text-gray-300 tabular">{netOut.toFixed(1)} KB/s</span></div>
      </div>
    </div>
  );
}

function TerminalSimulatorPreview() {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [currentText, setCurrentText] = useState("");
  const [step, setStep] = useState(0);

  useEffect(() => {
    const activeStep = DEMO_STEPS[step];
    let timer: ReturnType<typeof setTimeout>;

    if (activeStep.type === "input") {
      let charIndex = 0;
      const type = () => {
        if (charIndex < activeStep.text.length) {
          setCurrentText(activeStep.text.substring(0, charIndex + 1));
          charIndex++;
          timer = setTimeout(type, 50 + Math.random() * 70); // Natural typing rhythm
        } else {
          // Pause briefly, then append command
          timer = setTimeout(() => {
            if (activeStep.text === "clear") {
              setLines([]);
            } else {
              setLines(prev => [
                ...prev,
                { type: "prompt", text: activeStep.text }
              ]);
            }
            setCurrentText("");
            setStep((prev) => (prev + 1) % DEMO_STEPS.length);
          }, 800);
        }
      };
      timer = setTimeout(type, 500);
    } else if (activeStep.type === "output") {
      // Latency simulation (simulating execution overhead)
      timer = setTimeout(() => {
        setLines(prev => [
          ...prev,
          { type: "output", text: activeStep.text, color: activeStep.color }
        ]);
        setStep((prev) => (prev + 1) % DEMO_STEPS.length);
      }, 400 + Math.random() * 200);
    }

    return () => clearTimeout(timer);
  }, [step]);

  return (
    <div className="flex flex-col rounded-xl overflow-hidden terminal-surface border border-white/[0.08] shadow-glow-terminal w-full h-[340px] md:h-[380px]">
      {/* Title bar */}
      <div className="flex items-center justify-between h-9 px-4 bg-[#0d0f14] border-b border-white/[0.05] shrink-0 select-none">
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-full bg-[#ff5f57] border border-black/20" />
          <div className="h-3 w-3 rounded-full bg-[#ffbd2e] border border-black/20" />
          <div className="h-3 w-3 rounded-full bg-[#28c840] border border-black/20" />
        </div>
        <div className="flex items-center gap-2 rounded-md bg-white/[0.05] border border-white/[0.07] px-2.5 py-1">
          <span className="dot-online" />
          <span className="text-[11px] font-mono text-[#9d94bb]">root@linlearn: ~</span>
        </div>
        <div className="w-12 h-3" /> {/* Spacer */}
      </div>

      {/* Code viewport */}
      <div className="flex-1 min-h-0 bg-[#08090e] p-5 font-mono text-[12px] leading-6 overflow-y-auto select-text scrollbar-thin scrollbar-thumb-gray-800">
        {lines.map((line, idx) => (
          <div key={idx} className={line.color ?? "text-[#dde1f0]"}>
            {line.type === "prompt" ? (
              <div className="flex items-center flex-wrap">
                <span className="text-[#E95420] font-semibold">root</span>
                <span className="text-gray-500 mx-px">@</span>
                <span className="text-terminal-400 font-semibold">linlearn</span>
                <span className="text-gray-500 mr-1.5">:~$ </span>
                <span>{line.text}</span>
              </div>
            ) : (
              <pre className="font-mono whitespace-pre-wrap leading-relaxed mt-0.5 mb-1.5 opacity-90">{line.text}</pre>
            )}
          </div>
        ))}
        <div className="flex items-center flex-wrap">
          <span className="text-[#E95420] font-semibold">root</span>
          <span className="text-gray-500 mx-px">@</span>
          <span className="text-terminal-400 font-semibold">linlearn</span>
          <span className="text-gray-500 mr-1.5">:~$ </span>
          <span>{currentText}</span>
          <span className="animate-cursor-blink inline-block h-3.5 w-1.5 bg-terminal-400 align-middle ml-0.5" />
        </div>
      </div>

      {/* Telemetry Footer */}
      <VMTelemetryHUD />
    </div>
  );
}

// ─── Main Landing Page Component ────────────────────────────────────────────

export function LandingPageClient() {
  return (
    <div className="min-h-screen bg-[#090614] overflow-hidden text-ink-primary selection:bg-brand-500/28 selection:text-white noise">
      {/* ── Header ───────────────────────────────────────────── */}
      <header className="sticky top-0 z-sticky border-b border-white/[0.04] bg-[#090614]/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 shadow-glow-brand transition-all duration-normal group-hover:scale-105 active:scale-95">
              <TermIcon className="h-4 w-4 text-white" />
            </div>
            <span className="text-base font-bold tracking-tight text-white">
              Lin<span className="text-brand-500">Learn</span>
            </span>
          </Link>

          {/* Nav */}
          <nav className="hidden items-center gap-8 md:flex" aria-label="Landing Page Navigation">
            {["Features", "Tracks", "Incidents"].map((item) => (
              <a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="text-xs font-semibold tracking-wider uppercase text-ink-secondary transition-colors duration-fast hover:text-white"
              >
                {item}
              </a>
            ))}
          </nav>

          {/* CTA */}
          <div className="flex items-center gap-3">
            <Link
              href="/auth/login"
              className="text-xs font-bold tracking-wider uppercase text-ink-secondary hover:text-white px-3 py-2"
            >
              Sign in
            </Link>
            <motion.div {...SPRING_TAP}>
              <Link
                href="/auth/signup"
                className="btn-primary text-xs font-bold tracking-wider uppercase px-4 py-2 shadow-glow-brand"
              >
                Start free
              </Link>
            </motion.div>
          </div>
        </div>
      </header>

      {/* ── Hero Section ─────────────────────────────────────── */}
      <section className="relative px-6 py-20 md:py-32">
        {/* Decorative lighting background grid */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-0">
          <div className="h-[600px] w-[600px] rounded-full bg-brand-500/[0.04] blur-[140px]" />
          <div className="absolute top-1/4 left-1/4 h-[400px] w-[400px] rounded-full bg-purple-500/[0.02] blur-[120px]" />
        </div>

        <div className="relative mx-auto max-w-6xl z-10 grid gap-12 lg:grid-cols-12 items-center">
          {/* Hero text */}
          <motion.div
            variants={STAGGER}
            initial="initial"
            animate="animate"
            className="lg:col-span-7 space-y-6 text-left"
          >
            <motion.div variants={FADE_UP} className="inline-flex items-center gap-2 rounded-full border border-brand-500/25 bg-brand-500/8 px-3.5 py-1.5 select-none">
              <span className="dot-online" />
              <span className="text-[10px] font-bold tracking-wider uppercase text-brand-400">
                Real Linux Kernel — running via browser WASM
              </span>
            </motion.div>

            <motion.h1
              variants={FADE_UP}
              className="text-4xl font-extrabold leading-[1.1] tracking-tight md:text-5xl lg:text-6xl text-white"
            >
              Master DevOps with a <span className="gradient-text">Real Linux VM</span> in your browser.
            </motion.h1>

            <motion.p
              variants={FADE_UP}
              className="max-w-xl text-sm md:text-base text-ink-secondary leading-relaxed"
            >
              LinLearn compiles a complete i386 Ubuntu kernel directly into browser sandbox memory. 
              Deploy web servers, configure secure firewalls, and complete DevOps missions without local installs or container billing cycles.
            </motion.p>

            {/* CTAs */}
            <motion.div variants={FADE_UP} className="flex flex-wrap items-center gap-4 pt-4">
              <motion.div {...SPRING_TAP}>
                <Link
                  href="/auth/signup"
                  className="btn-primary px-6 py-3 text-sm font-bold tracking-wide shadow-glow-brand"
                >
                  <Zap className="h-4 w-4 text-white" />
                  Start learning free
                </Link>
              </motion.div>
              <motion.div {...SPRING_TAP}>
                <Link
                  href="/auth/login"
                  className="btn-secondary px-6 py-3 text-sm font-bold tracking-wide"
                >
                  Launch workspace
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </motion.div>
            </motion.div>

            {/* Micro value proof points */}
            <motion.div
              variants={FADE_UP}
              className="grid grid-cols-2 md:grid-cols-4 gap-6 pt-10 border-t border-white/[0.04]"
            >
              {[
                { val: "100% Native", label: "No server latency" },
                { val: "Mistral-7B AI", label: "Interactive tutoring" },
                { val: "PTY Signals", label: "Cryptographic validation" },
                { val: "Auto-save", label: "IndexedDB persistence" },
              ].map(({ val, label }) => (
                <div key={label} className="space-y-1">
                  <h4 className="text-sm font-bold text-white font-mono">{val}</h4>
                  <p className="text-2xs text-ink-tertiary uppercase tracking-wider">{label}</p>
                </div>
              ))}
            </motion.div>
          </motion.div>

          {/* Hero VM Console container */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ease: [0.16, 1, 0.3, 1], duration: 1.0, delay: 0.15 }}
            className="lg:col-span-5 relative flex items-center justify-center"
          >
            {/* Ambient terminal backing glow */}
            <div className="absolute inset-0 bg-terminal-500/[0.03] blur-3xl rounded-xl z-0" />
            <div className="relative w-full z-10 p-1 bg-white/[0.02] border border-white/[0.06] rounded-2xl backdrop-blur-xl">
              <TerminalSimulatorPreview />
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Feature Cards Grid ───────────────────────────────── */}
      <section id="features" className="px-6 py-20 relative border-t border-white/[0.03]">
        <div className="mx-auto max-w-6xl space-y-16">
          <div className="text-center max-w-2xl mx-auto space-y-4">
            <span className="text-xs font-bold tracking-widest uppercase text-brand-500">
              Virtualization Stack Overview
            </span>
            <h2 className="text-3xl font-extrabold tracking-tight text-white md:text-4xl">
              Engineered for absolute client-side execution
            </h2>
            <p className="text-sm text-ink-secondary">
              Everything runs locally in your browser tab. We don&apos;t host containers; we orchestrate high-fidelity WebAssembly hardware.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, desc, badge, color }) => {
              const a = ACCENT_MAP[color];
              return (
                <CardWithGlow key={title} accentColor={color}>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-lg border bg-[#0f0a28]/60 ${a.border}`}>
                        <Icon className={`h-5 w-5 ${a.text}`} />
                      </div>
                      <span className={`badge border text-[10px] font-mono tracking-wider uppercase font-semibold ${a.badge}`}>
                        {badge}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-sm font-bold text-white tracking-tight">{title}</h3>
                      <p className="text-xs text-ink-secondary leading-relaxed">{desc}</p>
                    </div>
                  </div>
                </CardWithGlow>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Incidents Section (Product Atmosphere) ─────────────── */}
      <section id="incidents" className="px-6 py-20 relative border-t border-white/[0.03] bg-white/[0.01]">
        <div className="mx-auto max-w-5xl grid gap-12 md:grid-cols-2 items-center">
          <div className="space-y-6">
            <span className="text-xs font-bold tracking-widest uppercase text-purple-500">
              Live Incident Sandbox
            </span>
            <h2 className="text-3xl font-extrabold tracking-tight text-white">
              Simulate actual production failures
            </h2>
            <p className="text-sm text-ink-secondary leading-relaxed">
              LinLearn&apos;s validator injects live bugs into your guest OS environment. Debug real Nginx reverse-proxy syntax errors, resolve Docker networking loops, or analyze broken memory allocations.
            </p>
            <div className="space-y-3.5">
              {[
                "Port 80 conflict error troubleshooting",
                "Nginx root path config corruption audits",
                "Permission level-wheel setup verification",
              ].map(text => (
                <div key={text} className="flex items-center gap-2.5">
                  <CheckCircle2 className="h-4 w-4 text-brand-500 shrink-0" />
                  <span className="text-xs font-semibold text-white/95">{text}</span>
                </div>
              ))}
            </div>
          </div>
          {/* Visual block */}
          <div className="relative p-1 bg-white/[0.02] border border-white/[0.06] rounded-xl overflow-hidden shadow-e3">
            <div className="bg-[#08090e] p-5 font-mono text-[11px] leading-5 text-gray-400 select-none">
              <div className="text-gray-500"># systemctl status nginx</div>
              <div className="text-rose-400 mt-1">● nginx.service - LSB: 301 Nginx web server</div>
              <div className="text-rose-400">   Loaded: loaded (/etc/init.d/nginx; generated)</div>
              <div className="text-rose-400">   Active: failed (Result: exit-code) since Sun 2026-05-24</div>
              <div className="text-gray-500 mt-2"># journalctl -u nginx --no-pager</div>
              <div className="text-white mt-1">[EMERG] 2012#0: invalid number of arguments in &quot;listen&quot; directive in /etc/nginx/nginx.conf:23</div>
              <div className="text-terminal-400 mt-2">💡 Nginx syntax audit recommended by AI Tutor.</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Learning Tracks ───────────────────────────────────── */}
      <section id="tracks" className="px-6 py-20 relative border-t border-white/[0.03]">
        <div className="mx-auto max-w-5xl space-y-12">
          <div className="text-center space-y-3">
            <h2 className="text-2xl font-extrabold tracking-tight text-white md:text-3xl">
              DevOps skills you will master
            </h2>
            <p className="text-sm text-ink-secondary">
              Go from beginner shell commands to deploying professional, hardened container infrastructure.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {TRACK_ITEMS.map((item) => (
              <div
                key={item}
                className="flex items-center gap-3.5 rounded-xl border border-white/[0.04] bg-white/[0.01] px-4.5 py-3.5 hover:bg-white/[0.03] transition-all duration-normal"
              >
                <div className="flex h-5 w-5 items-center justify-center rounded bg-terminal-500/10 border border-terminal-500/20 shrink-0">
                  <CheckCircle2 className="h-3 w-3 text-terminal-500" />
                </div>
                <span className="text-xs font-semibold text-white/90">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final Call to Action ──────────────────────────────── */}
      <section className="px-6 py-24 relative border-t border-white/[0.03] bg-gradient-to-b from-[#090614] to-[#04020a]">
        <div className="mx-auto max-w-3xl text-center space-y-8">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-brand-500/20 bg-brand-500/8 shadow-glow-brand">
            <Code2 className="h-6 w-6 text-brand-500 animate-pulse" />
          </div>
          <div className="space-y-3">
            <h2 className="text-3xl font-extrabold tracking-tight text-white md:text-4xl">
              Boot Linux inside your browser now
            </h2>
            <p className="text-sm text-ink-secondary max-w-md mx-auto">
              No credit card setup required. Boot a full Ubuntu system in under 10 seconds.
            </p>
          </div>
          <motion.div {...SPRING_TAP} className="inline-block">
            <Link
              href="/auth/signup"
              className="btn-primary inline-flex items-center gap-2 px-8 py-4 text-sm font-bold tracking-wider uppercase shadow-glow-brand"
            >
              Start for free
              <ArrowRight className="h-4 w-4" />
            </Link>
          </motion.div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.04] bg-[#04020a] px-6 py-10 relative z-10">
        <div className="mx-auto max-w-6xl flex flex-col items-center gap-4 text-center sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-brand-500/10 border border-brand-500/20">
              <TermIcon className="h-3.5 w-3.5 text-brand-500" />
            </div>
            <span className="text-sm font-bold text-white tracking-tight">LinLearn</span>
          </div>
          <p className="text-[11px] font-medium text-ink-tertiary leading-relaxed">
            Linux virtualization running entirely on Client-Side WebAssembly. Sandbox isolated.
          </p>
        </div>
      </footer>
    </div>
  );
}
