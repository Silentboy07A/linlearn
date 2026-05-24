"use client";
// src/components/LinuxVM.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Primary v86 VM component.  Worker-based architecture, xterm.js terminal,
// serial bridge, deterministic lifecycle management.
//
// Fixed:
//  - Uses plain JS worker from public/ (no Webpack bundling issues)
//  - Correct v86 config with initrd + console=ttyS0
//  - Shell-prompt detection for boot completion (not first-char)
//  - React StrictMode guard (initialization ref)
//  - Frame-batched serial output rendering
//  - Proper cleanup on unmount
//  - xterm.css imported
//  - No competing main-thread v86 instance
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { FADE } from "@/lib/motion";
import { Eraser, Maximize2, Minimize2 } from "lucide-react";

// ─── xterm.js theme — dark palette ──────────────────────────────────────────
const TERMINAL_THEME = {
  background: "#08090e",
  foreground: "#dde1f0",
  cursor: "#4ade80",
  cursorAccent: "#08090e",
  selectionBackground: "rgba(233,84,32,0.28)",
  selectionForeground: "#ffffff",
  selectionInactiveBackground: "rgba(255,255,255,0.08)",
  black: "#0d1117",
  brightBlack: "#4d5566",
  red: "#f43f5e",
  brightRed: "#ff6b81",
  green: "#4ade80",
  brightGreen: "#69ff94",
  yellow: "#fbbf24",
  brightYellow: "#ffe066",
  blue: "#58a6ff",
  brightBlue: "#79c0ff",
  magenta: "#c084fc",
  brightMagenta: "#d6acff",
  cyan: "#22d3ee",
  brightCyan: "#87e8fb",
  white: "#cdd6f4",
  brightWhite: "#ffffff",
} as const;

// ─── Boot sequence lines (cosmetic overlay) ─────────────────────────────────
const BOOT_LINES = [
  "[    0.000000] Linux version 5.15.0-linlearn (gcc 11.4.0) #1 SMP PREEMPT",
  "[    0.000000] Command line: tsc=reliable mitigations=off console=ttyS0",
  "[    0.001841] BIOS-provided physical RAM map:",
  "[    0.001842] BIOS-e820: [mem 0x0000000000000000-0x000000000009fbff] usable",
  "[    0.004102] ACPI: RSDP 0x00000000000F0490 000014 (v00 BOCHS )",
  "[    0.009234] PCI: Using configuration type 1 for base access",
  "[    0.014501] Initializing cgroup subsys cpuset — done",
  "[    0.019823] CPU: Intel(R) Core(TM) i7 (WebAssembly x86 emulated)",
  "[    0.026437] Freeing SMP alternatives memory: 28K",
  "[    0.033152] NET: Registered PF_INET6 protocol family",
  "[    0.041289] EXT4-fs (sda1): mounted filesystem with ordered data mode",
  "[    0.049017] systemd[1]: Starting Network Service…",
  "[    0.055834] systemd[1]: Started OpenSSH server daemon.",
  "[    0.061402] systemd[1]: Reached target Multi-User System.",
  "[    0.067918] Ubuntu 22.04.3 LTS linlearn ttyS0",
];

// ─── Types ──────────────────────────────────────────────────────────────────
type BootPhase = "booting" | "kernel" | "ready" | "error";

interface WorkerMessage {
  type: string;
  payload?: unknown;
}

// ─── Boot Overlay ───────────────────────────────────────────────────────────
function BootOverlay({ phase }: { phase: BootPhase }) {
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let i = 0;
    const total = BOOT_LINES.length;
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      if (i >= total) {
        setProgress(100);
        return;
      }
      setLines((prev) => [...prev, BOOT_LINES[i]]);
      setProgress(Math.round(((i + 1) / total) * 100));
      i++;
      timer = setTimeout(tick, 70 + Math.random() * 65);
    };

    timer = setTimeout(tick, 200);
    return () => clearTimeout(timer);
  }, []);

  const statusText =
    phase === "error"
      ? "Boot failed — check console"
      : phase === "kernel"
        ? "Kernel output received…"
        : "Initializing WebAssembly x86 runtime";

  return (
    <motion.div
      variants={FADE}
      initial="initial"
      animate="animate"
      exit="exit"
      className="absolute inset-0 z-10 flex flex-col bg-[#08090e] p-4 font-mono"
      aria-label="VM booting"
    >
      {/* Progress bar */}
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-white/5">
        <motion.div
          className="h-full bg-terminal-500"
          initial={{ width: "0%" }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
      </div>

      {/* Boot log */}
      <div className="flex-1 overflow-hidden space-y-px">
        {lines.map((line, idx) => (
          <motion.div
            key={idx}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.1 }}
            className="leading-5 text-[11px]"
          >
            <span className="text-terminal-500/35">{line.slice(0, 18)}</span>
            <span className="text-[#9d94bb]/75">{line.slice(18)}</span>
          </motion.div>
        ))}
        {phase === "booting" && (
          <span className="inline-block h-3 w-1.5 bg-terminal-500 animate-cursor-blink" />
        )}
      </div>

      {/* Status */}
      <div className="mt-2 pt-2 border-t border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="dot-loading" />
          <span className="text-[10px] text-[#635b80] font-mono">
            {statusText}
          </span>
        </div>
        <span className="text-[10px] text-[#635b80] font-mono tabular">
          {progress}%
        </span>
      </div>
    </motion.div>
  );
}

// ─── Traffic light button ───────────────────────────────────────────────────
function TrafficLight({ color, title }: { color: string; title: string }) {
  return (
    <button
      type="button"
      title={title}
      className={cn(
        "group h-3 w-3 rounded-full border border-black/20 transition-all duration-fast",
        "hover:brightness-110 active:scale-90",
        color
      )}
      aria-label={title}
    />
  );
}

// ─── LinuxVM ────────────────────────────────────────────────────────────────
export function LinuxVM() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const initRef = useRef(false); // StrictMode guard
  const [bootPhase, setBootPhase] = useState<BootPhase>("booting");
  const [fullscreen, setFullscreen] = useState(false);

  // ── Terminal clear ──────────────────────────────────────────────────────
  const xtermRef = useRef<import("xterm").Terminal | null>(null);
  const handleClear = useCallback(() => {
    xtermRef.current?.clear();
  }, []);

  // ── Main initialization effect ──────────────────────────────────────────
  useEffect(() => {
    // StrictMode guard — prevent double initialization
    if (initRef.current) return;
    initRef.current = true;

    let active = true;
    let term: import("xterm").Terminal | null = null;
    let fitAddon: import("xterm-addon-fit").FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let serialBuffer = ""; // Batched serial output
    let rafId: number | null = null;

    // Shell prompt detection buffer
    let promptBuffer = "";
    let shellReady = false;

    const init = async () => {
      // ── 1. Dynamic import xterm (avoid SSR) ─────────────────────────────
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("xterm"),
        import("xterm-addon-fit"),
      ]);

      if (!active) return;

      // ── 2. Create terminal ──────────────────────────────────────────────
      term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        cursorWidth: 2,
        theme: TERMINAL_THEME,
        fontSize: 14,
        fontFamily:
          "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
        fontWeight: "400",
        fontWeightBold: "600",
        lineHeight: 1.55,
        letterSpacing: 0,
        convertEol: true,
        scrollback: 10000,
        allowTransparency: true,
        minimumContrastRatio: 4.5,
        smoothScrollDuration: 100,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      if (terminalRef.current) {
        term.open(terminalRef.current);
        fitAddon.fit();
      }

      xtermRef.current = term;

      // ── 3. Create worker (plain JS from public/) ───────────────────────
      const workerUrl = window.location.origin + "/v86/v86-worker.js?v=" + Date.now();
      const worker = new Worker(workerUrl);
      workerRef.current = worker;

      // ── 4. Frame-batched serial output renderer ─────────────────────────
      // Instead of writing each char individually (causes flicker),
      // we batch serial output and flush once per animation frame.
      const flushSerial = () => {
        if (serialBuffer.length > 0 && term) {
          term.write(serialBuffer);
          serialBuffer = "";
        }
        rafId = requestAnimationFrame(flushSerial);
      };
      rafId = requestAnimationFrame(flushSerial);

      // ── 5. Worker message handler ───────────────────────────────────────
      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        if (!active) return;
        const { type, payload } = e.data;

        switch (type) {
          case "INIT_SUCCESS":
            console.log("[LinuxVM] v86 emulator initialized");
            break;

          case "INIT_FAILURE":
            console.error("[LinuxVM] v86 init failed:", payload);
            setBootPhase("error");
            if (term) {
              term.write(
                "\r\n\x1b[1;31m[LinLearn] Failed to initialize v86 VM.\x1b[0m\r\n"
              );
              term.write(
                `\x1b[90m${String(payload)}\x1b[0m\r\n`
              );
              term.write(
                "\x1b[90mCheck that all v86 assets exist in public/v86/\x1b[0m\r\n"
              );
            }
            break;

          case "SERIAL_OUT": {
            const char = typeof payload === "number" ? String.fromCharCode(payload) : (payload as string);

            // Buffer for batched rendering
            serialBuffer += char;

            // ── Shell prompt detection ──────────────────────────────────
            if (!shellReady) {
              promptBuffer += char;
              // Keep only last 80 chars for prompt matching
              if (promptBuffer.length > 80) {
                promptBuffer = promptBuffer.slice(-80);
              }
              // Detect common shell prompts
              // Buildroot: "/ # "  or "~ # "
              // Alpine:    "localhost:~# "
              // Ubuntu:    "user@host:~$ "
              // Generic:   ends with "# " or "$ "
              if (
                promptBuffer.endsWith("# ") ||
                promptBuffer.endsWith("$ ") ||
                promptBuffer.endsWith("~ # ") ||
                promptBuffer.endsWith("~ $ ") ||
                promptBuffer.endsWith(":~# ") ||
                promptBuffer.endsWith(":~$ ")
              ) {
                shellReady = true;
                setBootPhase("ready");
                worker.postMessage({ type: "SET_RUNNING" });
                console.log("[LinuxVM] Shell prompt detected — VM ready");
              }

              // Transition from "booting" to "kernel" on first serial output
              if (promptBuffer.length > 10) {
                setBootPhase((prev) =>
                  prev === "booting" ? "kernel" : prev
                );
              }
            }
            break;
          }

          case "SAVE_SUCCESS":
            console.log("[LinuxVM] VM state saved");
            break;

          case "SAVE_FAILURE":
            console.warn("[LinuxVM] State save failed:", payload);
            break;

          case "LOG": {
            const log = payload as { level: string; msg: string };
            const fn =
              log.level === "error"
                ? console.error
                : log.level === "warn"
                  ? console.warn
                  : console.log;
            fn("[v86-worker]", log.msg);
            break;
          }
        }
      };

      worker.onerror = (e) => {
        console.error("[LinuxVM] Worker error:", e);
        setBootPhase("error");
      };

      // ── 6. Connect xterm input → worker serial input ────────────────────
      const dataDisposable = term.onData((data) => {
        worker.postMessage({ type: "INPUT", payload: data });
      });

      // Forward Ctrl+C, Ctrl+Z, Ctrl+D as raw bytes
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.ctrlKey && ev.type === "keydown") {
          const key = ev.key.toLowerCase();
          if (key === "c") {
            worker.postMessage({ type: "INPUT", payload: "\x03" });
            return false;
          }
          if (key === "z") {
            worker.postMessage({ type: "INPUT", payload: "\x1a" });
            return false;
          }
          if (key === "d") {
            worker.postMessage({ type: "INPUT", payload: "\x04" });
            return false;
          }
        }
        return true;
      });

      // ── 7. Resize observer ──────────────────────────────────────────────
      if (terminalRef.current) {
        resizeObserver = new ResizeObserver(() => {
          if (active && fitAddon) {
            try {
              fitAddon.fit();
            } catch {
              // Ignore resize errors during teardown
            }
          }
        });
        resizeObserver.observe(terminalRef.current);
      }

      // ── 8. Send INIT to worker ──────────────────────────────────────────
      worker.postMessage({
        type: "INIT",
        payload: {
          origin: window.location.origin,
          version: Date.now().toString(),
        },
      });

      // Store disposable for cleanup
      (term as unknown as { _dataDisposable?: { dispose(): void } })._dataDisposable =
        dataDisposable;
    };

    init().catch((err) => {
      console.error("[LinuxVM] Fatal init error:", err);
      setBootPhase("error");
    });

    // ── Cleanup ─────────────────────────────────────────────────────────────
    return () => {
      active = false;
      initRef.current = false;

      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      resizeObserver?.disconnect();

      // Destroy worker
      if (workerRef.current) {
        try {
          workerRef.current.postMessage({ type: "DESTROY" });
        } catch {
          // Worker may already be terminated
        }
        workerRef.current = null;
      }

      // Dispose xterm
      if (term) {
        const t = term as unknown as { _dataDisposable?: { dispose(): void } };
        t._dataDisposable?.dispose();
        term.dispose();
        term = null;
      }

      xtermRef.current = null;
    };
  }, []); // Empty deps — initialize once

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-[10px]",
        "border border-terminal-500/14 terminal-surface",
        "transition-all duration-slow",
        fullscreen
          ? "fixed inset-4 z-modal shadow-e4"
          : "w-full min-h-[540px]"
      )}
    >
      {/* Window Chrome */}
      <div className="flex shrink-0 items-center gap-0 h-9 px-4 bg-[#0d0f14] border-b border-white/[0.05] select-none">
        <div className="flex items-center gap-1.5 mr-4">
          <TrafficLight color="bg-[#ff5f57]" title="Close" />
          <TrafficLight color="bg-[#ffbd2e]" title="Minimize" />
          <TrafficLight color="bg-[#28c840]" title="Maximize" />
        </div>

        <div className="flex items-center gap-2 rounded-md bg-white/[0.05] border border-white/[0.07] px-2.5 py-1">
          <span
            className={cn(
              "dot-online",
              bootPhase !== "ready" && "dot-loading"
            )}
          />
          <span className="text-[11px] font-mono text-[#9d94bb]">
            bash — linlearn v86
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <AnimatePresence mode="wait">
            {bootPhase === "booting" && (
              <motion.span
                key="booting"
                variants={FADE}
                initial="initial"
                animate="animate"
                exit="exit"
                className="mr-2 text-[10px] font-mono text-amber-400/60 tabular"
              >
                booting kernel…
              </motion.span>
            )}
            {bootPhase === "kernel" && (
              <motion.span
                key="kernel"
                variants={FADE}
                initial="initial"
                animate="animate"
                exit="exit"
                className="mr-2 text-[10px] font-mono text-blue-400/60 tabular"
              >
                kernel running…
              </motion.span>
            )}
            {bootPhase === "ready" && (
              <motion.span
                key="ready"
                variants={FADE}
                initial="initial"
                animate="animate"
                className="mr-2 text-[10px] font-mono text-terminal-500/50"
              >
                kernel ready
              </motion.span>
            )}
            {bootPhase === "error" && (
              <motion.span
                key="error"
                variants={FADE}
                initial="initial"
                animate="animate"
                className="mr-2 text-[10px] font-mono text-red-400/60"
              >
                boot failed
              </motion.span>
            )}
          </AnimatePresence>

          <button
            type="button"
            title="Clear terminal"
            onClick={handleClear}
            className="btn-icon h-6 w-6 text-[#635b80] hover:text-[#9d94bb]"
            aria-label="Clear terminal"
          >
            <Eraser className="h-3 w-3" />
          </button>
          <button
            type="button"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            onClick={() => setFullscreen((f) => !f)}
            className="btn-icon h-6 w-6 text-[#635b80] hover:text-[#9d94bb]"
            aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {fullscreen ? (
              <Minimize2 className="h-3 w-3" />
            ) : (
              <Maximize2 className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      {/* Terminal body */}
      <div className="relative flex-1 min-h-0 scanlines">
        <AnimatePresence>
          {bootPhase !== "ready" && bootPhase !== "error" && (
            <BootOverlay key="boot-overlay" phase={bootPhase} />
          )}
        </AnimatePresence>

        <div
          ref={terminalRef}
          className="w-full h-full p-3"
          style={{ minHeight: "490px" }}
        />
      </div>
    </div>
  );
}
