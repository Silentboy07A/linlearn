// src/services/v86/v86.worker.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

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
  save_state: (cb: (err: unknown, state: ArrayBuffer) => void) => void;
}

interface WindowWithV86 {
  V86: new (config: V86StarterConfig) => V86StarterInstance;
}

let emulator: V86StarterInstance | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  switch (type) {
    case "INIT":
      try {
        const origin = payload.origin;
        // Synchronously import the v86 constructor library
        (self as any).importScripts(origin + "/v86/libv86.js");

        const win = self as unknown as WindowWithV86;
        if (!win.V86) {
          throw new Error("V86 constructor not found in worker context after importScripts");
        }

        const config: V86StarterConfig = {
          wasm_path: origin + "/v86/v86.wasm",
          bios: { url: origin + "/v86/bios/seabios.bin" },
          vga_bios: { url: origin + "/v86/bios/vgabios.bin" },
          bzimage: {
            url: origin + "/v86/images/bzImage",
            async: false,
          },
          cmdline: "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
          autostart: true,
        };

        if (payload.initial_state) {
          config.initial_state = { buffer: payload.initial_state };
        }

        emulator = new win.V86(config);

        emulator.add_listener("serial0-output-char", (char: string) => {
          (self as any).postMessage({ type: "SERIAL_OUT", payload: char });
        });

        (self as any).postMessage({ type: "INIT_SUCCESS" });
      } catch (err: any) {
        (self as any).postMessage({ type: "INIT_FAILURE", payload: err.message || String(err) });
      }
      break;

    case "INPUT":
      if (emulator) {
        emulator.serial0_send(payload);
      }
      break;

    case "SAVE_STATE":
      if (emulator) {
        emulator.save_state((err: unknown, state: ArrayBuffer) => {
          if (err) {
            (self as any).postMessage({ type: "SAVE_FAILURE", payload: String(err) });
          } else {
            (self as any).postMessage({ type: "SAVE_SUCCESS", payload: state }, [state]);
          }
        });
      }
      break;

    case "DESTROY":
      if (emulator) {
        emulator.destroy();
        emulator = null;
      }
      self.close(); // Close the worker thread context
      break;
  }
};
