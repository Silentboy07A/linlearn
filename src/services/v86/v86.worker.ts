// src/services/v86/v86.worker.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

interface V86StarterConfig {
  wasm_path: string;
  bios?: { url: string };
  vga_bios?: { url: string };
  bzimage?: { url: string; async?: boolean };
  cmdline?: string;
  autostart: boolean;
  initial_state?: { buffer: ArrayBuffer };
}

interface V86StarterInstance {
  serial0_send: (data: string) => void;
  add_listener: (event: string, cb: (char: string) => void) => void;
  remove_listener: (event: string, cb: (char: string) => void) => void;
  destroy: () => void;
  save_state: () => Promise<ArrayBuffer>;
}

interface WindowWithV86 {
  V86: new (config: V86StarterConfig) => V86StarterInstance;
}

let emulator: V86StarterInstance | null = null;
let isInitialized = false;

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

        // Basic config required for both cold boot and snapshot restore
        const config: V86StarterConfig = {
          wasm_path: origin + "/v86/v86.wasm",
          autostart: true,
        };

        if (payload.initial_state && payload.initial_state.byteLength > 1024) {
          config.initial_state = { buffer: payload.initial_state };
        } else {
          config.bios = { url: origin + "/v86/bios/seabios.bin" };
          config.vga_bios = { url: origin + "/v86/bios/vgabios.bin" };
          config.bzimage = {
            url: origin + "/v86/images/bzImage",
            async: false,
          };
          config.cmdline = "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0";
        }

        emulator = new win.V86(config);

        emulator.add_listener("serial0-output-char", (char: string) => {
          (self as any).postMessage({ type: "SERIAL_OUT", payload: char });
        });

        isInitialized = true;
        (self as any).postMessage({ type: "INIT_SUCCESS" });
      } catch (err: any) {
        isInitialized = false;
        emulator = null;
        (self as any).postMessage({ type: "INIT_FAILURE", payload: err.message || String(err) });
      }
      break;

    case "INPUT":
      if (emulator && isInitialized) {
        emulator.serial0_send(payload);
      }
      break;

    case "SAVE_STATE":
      if (emulator && isInitialized) {
        emulator.save_state()
          .then((state: ArrayBuffer) => {
            if (!state || !(state instanceof ArrayBuffer)) {
              throw new Error("Invalid state buffer returned by emulator");
            }
            (self as any).postMessage({ type: "SAVE_SUCCESS", payload: state }, [state]);
          })
          .catch((err: unknown) => {
            (self as any).postMessage({ type: "SAVE_FAILURE", payload: String(err) });
          });
      } else {
        (self as any).postMessage({
          type: "SAVE_FAILURE",
          payload: "No emulator instance or emulator not fully initialized"
        });
      }
      break;

    case "DESTROY":
      isInitialized = false;
      if (emulator) {
        try {
          emulator.destroy();
        } catch {
          // ignore
        }
        emulator = null;
      }
      self.close(); // Close the worker thread context
      break;
  }
};

