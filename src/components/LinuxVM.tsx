"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Terminal } from "xterm";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { FADE } from "@/lib/motion";
import {
  Eraser,
  Maximize2,
  Minimize2,
} from "lucide-react";

// ─── xterm.js theme — Authentic Ubuntu 22.04 palette ────────────────────────
const TERMINAL_THEME = {
  background:                  "#08090e",
  foreground:                  "#dde1f0",
  cursor:                      "#4ade80",
  cursorAccent:                "#08090e",
  selectionBackground:         "rgba(233,84,32,0.28)",
  selectionForeground:         "#ffffff",
  selectionInactiveBackground: "rgba(255,255,255,0.08)",
  // ANSI 16 — Ubuntu terminal defaults
  black:         "#0d1117",   brightBlack:   "#4d5566",
  red:           "#f43f5e",   brightRed:     "#ff6b81",
  green:         "#4ade80",   brightGreen:   "#69ff94",
  yellow:        "#fbbf24",   brightYellow:  "#ffe066",
  blue:          "#58a6ff",   brightBlue:    "#79c0ff",
  magenta:       "#c084fc",   brightMagenta: "#d6acff",
  cyan:          "#22d3ee",   brightCyan:    "#87e8fb",
  white:         "#cdd6f4",   brightWhite:   "#ffffff",
} as const;

// ─── Boot sequence lines ─────────────────────────────────────────────────────
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

// ─── Boot Overlay ────────────────────────────────────────────────────────────
function BootOverlay({ onComplete }: { onComplete?: () => void }) {
  const [lines, setLines]       = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [done, setDone]         = useState(false);

  useEffect(() => {
    let i = 0;
    const total = BOOT_LINES.length;

    const tick = () => {
      if (i >= total) {
        setDone(true);
        onComplete?.();
        return;
      }
      setLines((prev) => [...prev, BOOT_LINES[i]]);
      setProgress(Math.round(((i + 1) / total) * 100));
      i++;
      setTimeout(tick, 70 + Math.random() * 65);
    };

    const t = setTimeout(tick, 200);
    return () => clearTimeout(t);
  }, [onComplete]);

  return (
    <motion.div
      variants={FADE}
      initial="initial"
      animate="animate"
      exit="exit"
      className="absolute inset-0 z-10 flex flex-col bg-[#08090e] p-4 font-mono"
      aria-label="VM booting"
    >
      {/* Boot progress bar at top */}
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
            transition={{ duration: 0.10 }}
            className="leading-5 text-[11px]"
          >
            <span className="text-terminal-500/35">{line.slice(0, 18)}</span>
            <span className="text-[#9d94bb]/75">{line.slice(18)}</span>
          </motion.div>
        ))}
        {/* Blinking cursor at end */}
        {!done && (
          <span className="inline-block h-3 w-1.5 bg-terminal-500 animate-cursor-blink" />
        )}
      </div>

      {/* Status bar */}
      <div className="mt-2 pt-2 border-t border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="dot-loading" />
          <span className="text-[10px] text-[#635b80] font-mono">Initializing WebAssembly x86 runtime</span>
        </div>
        <span className="text-[10px] text-[#635b80] font-mono tabular">{progress}%</span>
      </div>
    </motion.div>
  );
}

// ─── V86 config types ────────────────────────────────────────────────────────
interface V86StarterConfig {
  wasm_path: string;
  bios: { url: string };
  vga_bios: { url: string };
  bzimage: { url: string; async?: boolean };
  cmdline: string;
  autostart: boolean;
  initial_state?: { buffer: ArrayBuffer };
}
interface V86StarterInstance {
  serial0_send: (data: string) => void;
  add_listener: (event: string, cb: (char: string) => void) => void;
  remove_listener: (event: string, cb: (char: string) => void) => void;
  destroy: () => void;
}
interface WindowWithV86 extends Window {
  V86: new (config: V86StarterConfig) => V86StarterInstance;
}
interface CustomTerminal extends Terminal {
  _v86Disposable?: { dispose: () => void };
}

// ─── Traffic-light button ────────────────────────────────────────────────────
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

// ─── LinuxVM ─────────────────────────────────────────────────────────────────
export function LinuxVM() {
  const terminalRef    = useRef<HTMLDivElement>(null);
  const v86ContainerRef = useRef<V86StarterInstance | null>(null);
  const [booting,    setBooting]    = useState(true);
  const [bootDone,   setBootDone]   = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const handleClear = useCallback(() => {
    // Clear signal propagated through xterm instance on window
    const w = window as unknown as { __linlearn_term?: CustomTerminal };
    w.__linlearn_term?.clear();
  }, []);

  useEffect(() => {
    let active = true;
    let termInstance: CustomTerminal | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const initialize = async () => {
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");

      if (!active) return;

      termInstance = new Terminal({
        cursorBlink:  true,
        cursorStyle:  "block",
        cursorWidth:  2,
        theme:        TERMINAL_THEME,
        fontSize:     14,
        fontFamily:   "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
        fontWeight:   "400",
        fontWeightBold: "600",
        lineHeight:   1.55,
        letterSpacing: 0,
        convertEol:   true,
        scrollback:   10000,
        allowTransparency: true,
        minimumContrastRatio: 4.5,
        smoothScrollDuration: 100,
      }) as CustomTerminal;

      const fitAddon = new FitAddon();
      termInstance.loadAddon(fitAddon);

      if (terminalRef.current) {
        termInstance.open(terminalRef.current);
        fitAddon.fit();
      }

      // Expose for external clear
      (window as unknown as { __linlearn_term?: CustomTerminal }).__linlearn_term = termInstance;

      // Load v86 script
      const loadV86 = () =>
        new Promise<void>((resolve, reject) => {
          const w = window as unknown as WindowWithV86;
          if (w.V86) return resolve();
          const s = document.createElement("script");
          s.src = window.location.origin + "/v86/libv86.js";
          s.async = true;
          s.onload  = () => resolve();
          s.onerror = (e) => reject(e);
          document.head.appendChild(s);
        });

      try {
        await loadV86();
        if (!active) return;

        const origin = window.location.origin;
        const emulator = new (window as unknown as WindowWithV86).V86({
          wasm_path: `${origin}/v86/v86.wasm`,
          bios:      { url: `${origin}/v86/bios/seabios.bin` },
          vga_bios:  { url: `${origin}/v86/bios/vgabios.bin` },
          bzimage:   { url: `${origin}/v86/images/bzImage`, async: false },
          cmdline:   "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
          autostart: true,
        });

        v86ContainerRef.current = emulator;
        let isFirstChar = true;

        emulator.add_listener("serial0-output-char", (char: string) => {
          if (isFirstChar) {
            isFirstChar = false;
            setBooting(false);
            setBootDone(true);
            termInstance?.clear();
          }
          termInstance?.write(char);
        });

        const dataDisposable = termInstance.onData((data) => {
          emulator.serial0_send(data);
        });
        termInstance._v86Disposable = dataDisposable;

        if (terminalRef.current) {
          resizeObserver = new ResizeObserver(() => {
            if (active) fitAddon.fit();
          });
          resizeObserver.observe(terminalRef.current);
        }
      } catch (err) {
        console.error("LinuxVM init failed:", err);
        termInstance?.write(
          "\r\n\x1b[1;31m[LinLearn] Failed to initialize WebAssembly VM.\x1b[0m\r\n" +
          "\x1b[90mCheck console for details. Refresh to retry.\x1b[0m\r\n"
        );
        setBooting(false);
      }
    };

    initialize();

    return () => {
      active = false;
      resizeObserver?.disconnect();
      v86ContainerRef.current?.destroy();
      v86ContainerRef.current = null;
      if (termInstance) {
        termInstance._v86Disposable?.dispose();
        termInstance.dispose();
      }
    };
  }, []);

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
      {/* ── Window Chrome ─────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-0 h-9 px-4 bg-[#0d0f14] border-b border-white/[0.05] select-none">
        {/* Traffic lights */}
        <div className="flex items-center gap-1.5 mr-4">
          <TrafficLight color="bg-[#ff5f57]" title="Close" />
          <TrafficLight color="bg-[#ffbd2e]" title="Minimize" />
          <TrafficLight color="bg-[#28c840]" title="Maximize" />
        </div>

        {/* Tab */}
        <div className="flex items-center gap-2 rounded-md bg-white/[0.05] border border-white/[0.07] px-2.5 py-1">
          <span className={cn("dot-online", booting && "dot-loading")} />
          <span className="text-[11px] font-mono text-[#9d94bb]">
            bash — linlearn v86
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {/* Boot status */}
          <AnimatePresence>
            {booting && (
              <motion.span
                variants={FADE}
                initial="initial"
                animate="animate"
                exit="exit"
                className="mr-2 text-[10px] font-mono text-amber-400/60 tabular"
              >
                booting kernel…
              </motion.span>
            )}
            {bootDone && !booting && (
              <motion.span
                variants={FADE}
                initial="initial"
                animate="animate"
                className="mr-2 text-[10px] font-mono text-terminal-500/50"
              >
                kernel ready
              </motion.span>
            )}
          </AnimatePresence>

          {/* Toolbar actions */}
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
            {fullscreen
              ? <Minimize2 className="h-3 w-3" />
              : <Maximize2 className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* ── Terminal body ──────────────────────────────────────── */}
      <div className="relative flex-1 min-h-0 scanlines">
        {/* Boot overlay */}
        <AnimatePresence>
          {booting && <BootOverlay key="boot-overlay" />}
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
