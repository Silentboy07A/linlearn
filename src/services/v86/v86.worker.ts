// src/services/v86/v86.worker.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

interface V86StarterConfig {
  wasm_path: string;
  bios?: { buffer: ArrayBuffer };
  vga_bios?: { buffer: ArrayBuffer };
  bzimage?: { buffer: ArrayBuffer };
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

function log(level: string, msg: string) {
  (self as any).postMessage({ type: "LOG", payload: { level, msg } });
}

async function fetchAndValidateAsset(url: string, name: string, requireAlignment: boolean): Promise<ArrayBuffer> {
  log("debug", "[v86-worker] [DEBUG] Fetching asset: " + name + " from " + url);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP status ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("text/html")) {
      throw new Error("Invalid content type: received text/html instead of binary stream (probable 404 page redirect)");
    }

    const buffer = await response.arrayBuffer();
    const byteLength = buffer.byteLength;
    if (byteLength === 0) {
      throw new Error("Asset is empty (0 bytes)");
    }

    const isAligned = byteLength % 2 === 0;
    log("info", `[v86-worker] [INFO] Loaded asset: ${name}, size: ${byteLength} bytes, aligned: ${isAligned}`);

    if (requireAlignment && !isAligned) {
      throw new Error(`Asset is corrupted (byte length ${byteLength} is not a multiple of 2)`);
    }

    return buffer;
  } catch (err: any) {
    const errorMsg = `Failed to load ${name}: ${err.message || String(err)}`;
    log("error", `[v86-worker] [ERROR] ${errorMsg}`);
    throw new Error(errorMsg);
  }
}

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

        log("info", "[v86-worker] [INFO] Preloading and validating WebAssembly runtime...");
        const wasmBuffer = await fetchAndValidateAsset(origin + "/v86/v86.wasm", "v86.wasm", false);
        const wasmBlob = new Blob([wasmBuffer], { type: "application/wasm" });
        const wasmBlobUrl = URL.createObjectURL(wasmBlob);

        // Basic config required for both cold boot and snapshot restore
        const config: V86StarterConfig = {
          wasm_path: wasmBlobUrl,
          autostart: true,
        };

        const isRestore = !!(payload.initial_state && payload.initial_state.byteLength > 1024);

        if (isRestore) {
          log(
            "info",
            `[v86-worker] [INFO] Restoring saved state (${Math.round(payload.initial_state.byteLength / 1024)} KB)`
          );

          // Perform signature check on saved state before applying it
          const view = new DataView(payload.initial_state);
          const magic = view.getInt32(0, true);
          if (magic !== -2039052682) {
            throw new Error(`Saved state magic bytes mismatch: ${magic} (expected -2039052682)`);
          }

          config.initial_state = { buffer: payload.initial_state };
        } else {
          log("info", "[v86-worker] [INFO] Cold booting Linux VM — validating boot binaries...");

          const biosBuffer = await fetchAndValidateAsset(origin + "/v86/bios/seabios.bin", "seabios.bin", true);
          const vgaBiosBuffer = await fetchAndValidateAsset(origin + "/v86/bios/vgabios.bin", "vgabios.bin", true);
          const bzImageBuffer = await fetchAndValidateAsset(origin + "/v86/images/bzImage", "bzImage", true);

          config.bios = { buffer: biosBuffer };
          config.vga_bios = { buffer: vgaBiosBuffer };
          config.bzimage = { buffer: bzImageBuffer };
          config.cmdline = "rw init=/sbin/init root=/dev/ram0 tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0";
        }

        log("info", "[v86-worker] [INFO] Creating v86 emulator instance...");
        emulator = new win.V86(config);

        emulator.add_listener("serial0-output-char", (char: string) => {
          (self as any).postMessage({ type: "SERIAL_OUT", payload: char });
        });

        isInitialized = true;
        (self as any).postMessage({ type: "INIT_SUCCESS" });
        log("info", "[v86-worker] [INFO] v86 emulator created and started successfully");
      } catch (err: any) {
        isInitialized = false;
        emulator = null;
        const initErr = `Emulator initialization failed: ${err.message || String(err)}`;
        log("error", `[v86-worker] [ERROR] ${initErr}`);
        (self as any).postMessage({ type: "INIT_FAILURE", payload: initErr });
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
            log("error", `[v86-worker] [ERROR] Save state failed: ${String(err)}`);
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
      log("info", "[v86-worker] [INFO] Destroying emulator...");
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
