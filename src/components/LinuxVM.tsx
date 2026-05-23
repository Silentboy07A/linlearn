"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "xterm";

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
  V86Starter: new (config: V86StarterConfig) => V86StarterInstance;
}

interface CustomTerminal extends Terminal {
  _v86Disposable?: { dispose: () => void };
}

export function LinuxVM() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const v86ContainerRef = useRef<V86StarterInstance | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let active = true;
    let termInstance: CustomTerminal | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const initialize = async () => {
      // 1. Dynamic import of xterm.js elements to isolate execution client-side (no SSR)
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");

      if (!active) return;

      // 2. Initialize xterm.js instance with styling matching the theme
      termInstance = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        theme: {
          background: "#0c0e14",
          foreground: "#51e08c",
          cursor: "#51e08c",
        },
        fontSize: 14,
        fontFamily: "JetBrains Mono, Courier New, monospace",
        convertEol: true,
        rows: 24,
      }) as CustomTerminal;

      const fitAddon = new FitAddon();
      termInstance.loadAddon(fitAddon);

      if (terminalRef.current) {
        termInstance.open(terminalRef.current);
        fitAddon.fit();
      }

      // 3. Inject the local libv86 script absolute path loader
      const loadV86Script = () => {
        return new Promise<void>((resolve, reject) => {
          const win = window as unknown as WindowWithV86;
          if (win.V86Starter) return resolve();
          const script = document.createElement("script");
          script.src = "/v86/libv86.js";
          script.async = true;
          script.onload = () => resolve();
          script.onerror = (e) => reject(e);
          document.head.appendChild(script);
        });
      };

      try {
        await loadV86Script();
        if (!active) return;

        const win = window as unknown as WindowWithV86;
        
        // 4. Configuration referencing only local absolute paths under /v86/
        const config: V86StarterConfig = {
          wasm_path: "/v86/v86.wasm",
          bios: { url: "/v86/bios/seabios.bin" },
          vga_bios: { url: "/v86/bios/vgabios.bin" },
          bzimage: {
            url: "/v86/images/bzImage",
            async: false,
          },
          cmdline: "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
          autostart: true,
        };

        // 5. Instantiate V86 CPU emulator
        const emulator = new win.V86Starter(config);
        v86ContainerRef.current = emulator;

        let isFirstChar = true;

        // 6. Bridge Serial Output -> xterm.js
        emulator.add_listener("serial0-output-char", (char: string) => {
          if (isFirstChar) {
            isFirstChar = false;
            setBooting(false);
            termInstance?.clear();
          }
          termInstance?.write(char);
        });

        // 7. Bridge xterm.js User Input -> VM Serial Port
        const dataDisposable = termInstance.onData((data) => {
          emulator.serial0_send(data);
        });

        // Store reference on terminal object for disposal lifecycle
        termInstance._v86Disposable = dataDisposable;

        // 8. Auto-resize observer hook
        if (terminalRef.current) {
          resizeObserver = new ResizeObserver(() => {
            if (active) {
              fitAddon.fit();
            }
          });
          resizeObserver.observe(terminalRef.current);
        }

      } catch (err) {
        console.error("Failed to initialize WebAssembly VM:", err);
        termInstance.write("\r\n\x1b[1;31mError: Failed to fetch WebAssembly virtual machine libraries.\x1b[0m\r\n");
      }
    };

    initialize();

    // 9. Rigid cleanup and teardown cycle to prevent memory leaks and zombie processes
    return () => {
      active = false;
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (v86ContainerRef.current) {
        v86ContainerRef.current.destroy();
        v86ContainerRef.current = null;
      }
      if (termInstance) {
        if (termInstance._v86Disposable) {
          termInstance._v86Disposable.dispose();
        }
        termInstance.dispose();
      }
    };
  }, []);

  return (
    <div className="flex flex-col w-full h-[520px] bg-[#0c0e14] border border-emerald-500/20 p-4 rounded-xl shadow-2xl">
      <div className="flex items-center justify-between border-b border-emerald-500/10 pb-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs font-mono text-emerald-500">linlearn_v86_core_engine</span>
        </div>
        {booting && (
          <span className="text-xs font-mono text-emerald-500/60 animate-pulse">
            loading guest kernel...
          </span>
        )}
      </div>
      <div ref={terminalRef} className="w-full h-full overflow-hidden" />
    </div>
  );
}
