// src/services/v86/v86.worker.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

interface V86StarterConfig {
  wasm_path: string;
  bios?: { buffer: ArrayBuffer };
  vga_bios?: { buffer: ArrayBuffer };
  bzimage?: { buffer: ArrayBuffer };
  initrd?: { buffer: ArrayBuffer };
  cmdline?: string;
  autostart: boolean;
  initial_state?: { buffer: ArrayBuffer };
  memory_size?: number;
  vga_memory_size?: number;
}

interface V86StarterInstance {
  serial0_send: (data: string) => void;
  add_listener: (event: string, cb: (...args: any[]) => void) => void;
  remove_listener: (event: string, cb: (...args: any[]) => void) => void;
  destroy: () => void | Promise<void>;
  stop: () => Promise<void>;
  restart: () => void;
  save_state: () => Promise<ArrayBuffer>;
}

interface WindowWithV86 {
  V86: new (config: V86StarterConfig) => V86StarterInstance;
}

type EmulatorState = "idle" | "loading" | "initialized" | "booting" | "running" | "failed";

let emulator: V86StarterInstance | null = null;
let lifecycleState: EmulatorState = "idle";

function log(level: string, msg: string) {
  const formattedLevel = level.toUpperCase();
  const prefix = `[v86-worker] [${formattedLevel}]`;
  let cleanMsg = msg;
  if (msg.indexOf(prefix) !== 0) {
    cleanMsg = `${prefix} ${msg}`;
  }
  (self as any).postMessage({ type: "LOG", payload: { level: level.toLowerCase(), msg: cleanMsg } });
}

function setLifecycleState(newState: EmulatorState) {
  if (lifecycleState !== newState) {
    const oldState = lifecycleState;
    lifecycleState = newState;
    log("debug", `Lifecycle state transitioned: ${oldState} -> ${newState}`);
    (self as any).postMessage({ type: "STATE_CHANGED", payload: newState });
  }
}

async function validateBinaryResponse(response: Response, name: string): Promise<ArrayBuffer> {
  if (!response.ok) {
    throw new Error(`Failed to load ${name}: HTTP status ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const ctLower = contentType.toLowerCase();
  if (ctLower.includes("text/html") || ctLower.includes("application/xhtml+xml") || ctLower.includes("text/xml")) {
    throw new Error(`Failed to load ${name}: received HTML/XML instead of binary stream (probable 404 page redirect)`);
  }

  const buffer = await response.arrayBuffer();
  if (!buffer || !(buffer instanceof ArrayBuffer)) {
    throw new Error(`Failed to load ${name}: response is not a valid ArrayBuffer`);
  }

  if (buffer.byteLength === 0) {
    throw new Error(`Failed to load ${name}: asset is empty (0 bytes)`);
  }

  return buffer;
}

async function loadAsset(
  url: string,
  name: string,
  options: { requireUint16Alignment?: boolean; autoAlign?: boolean } = {}
): Promise<ArrayBuffer> {
  log("debug", `Fetching asset: ${name} from ${url}`);
  try {
    const response = await fetch(url);
    let buffer = await validateBinaryResponse(response, name);
    const byteLength = buffer.byteLength;

    // Only apply Uint16Array divisibility validation (divisible by 2) if option is explicitly set
    if (options.requireUint16Alignment) {
      if (byteLength % 2 !== 0) {
        throw new Error(`size (${byteLength}) is not a multiple of 2 (required for Uint16Array parsing)`);
      }
    }

    if (options.autoAlign && byteLength % 4 !== 0) {
      const padBytes = 4 - (byteLength % 4);
      log("info", `Auto-aligning asset ${name}: padding ${byteLength} bytes with ${padBytes} bytes to make it a multiple of 4.`);
      const alignedBuffer = new ArrayBuffer(byteLength + padBytes);
      new Uint8Array(alignedBuffer).set(new Uint8Array(buffer));
      buffer = alignedBuffer;
    }

    log("info", `Loaded asset: ${name}, size: ${buffer.byteLength} bytes`);
    return buffer;
  } catch (err: any) {
    const errorMsg = `Failed to load ${name}: ${err.message || String(err)}`;
    log("error", errorMsg);
    throw new Error(errorMsg);
  }
}

self.onmessage = async (e: MessageEvent) => {
  if (!e.data) return;
  const { type, payload } = e.data;

  switch (type) {
    case "INIT":
      if (lifecycleState !== "idle" && lifecycleState !== "failed") {
        log("warn", `Ignored INIT command: Emulator already initialized or loading. Current state: ${lifecycleState}`);
        return;
      }
      await handleInit(payload);
      break;

    case "INPUT":
      if (!emulator) {
        log("debug", `Ignored serial input: No active emulator instance. Current state: ${lifecycleState}`);
        break;
      }
      if (lifecycleState !== "initialized" && lifecycleState !== "booting" && lifecycleState !== "running") {
        log("debug", `Ignored serial input: Emulator is in non-interactive state: ${lifecycleState}`);
        break;
      }
      try {
        emulator.serial0_send(payload);
      } catch (err: any) {
        log("error", `Failed to send serial input: ${err.message || String(err)}`);
      }
      break;

    case "SET_RUNNING":
      if (lifecycleState === "initialized" || lifecycleState === "booting") {
        setLifecycleState("running");
        log("info", "Emulator successfully transitioned to running state (boot complete)");
      } else {
        log("warn", `Ignored SET_RUNNING message. Current state: ${lifecycleState}`);
      }
      break;

    case "SAVE_STATE":
      await handleSaveState();
      break;

    case "STOP":
      await handleStop();
      break;

    case "RESTART":
      handleRestart();
      break;

    case "DESTROY":
      handleDestroy();
      break;

    default:
      log("warn", `Unknown message type received: ${type}`);
  }
};

async function handleInit(payload: any) {
  const origin = payload.origin;
  const t0 = Date.now();

  setLifecycleState("loading");
  log("info", `Step 1/6: Loading libv86.js from ${origin}/v86/libv86.js`);

  try {
    (self as any).importScripts(origin + "/v86/libv86.js");
  } catch (err: any) {
    const msg = `Failed to load libv86.js: ${err.message || String(err)}`;
    log("error", msg);
    setLifecycleState("failed");
    (self as any).postMessage({ type: "INIT_FAILURE", payload: msg });
    return;
  }

  const win = self as unknown as WindowWithV86;
  if (!win.V86) {
    const errMsg = "V86 constructor not found after importScripts";
    log("error", errMsg);
    setLifecycleState("failed");
    (self as any).postMessage({ type: "INIT_FAILURE", payload: errMsg });
    return;
  }

  log("info", `Step 1/6 completed: libv86.js loaded in ${Date.now() - t0}ms`);

  const isRestore = !!(payload.initial_state && payload.initial_state.byteLength > 1024);

  try {
    // Step 1b: Preload Wasm Runtime
    log("info", "Step 1b/6: Preloading and validating WebAssembly runtime...");
    const wasmBuffer = await loadAsset(origin + "/v86/v86.wasm", "v86.wasm", { autoAlign: true });
    const wasmBlob = new Blob([wasmBuffer], { type: "application/wasm" });
    const wasmBlobUrl = URL.createObjectURL(wasmBlob);
    log("info", "Step 1b/6 completed: WebAssembly runtime loaded.");

    // Basic config required for both cold boot and snapshot restore
    const config: V86StarterConfig = {
      wasm_path: wasmBlobUrl,
      memory_size: payload.memory_size || 128 * 1024 * 1024, // 128 MB
      vga_memory_size: payload.vga_memory_size || 2 * 1024 * 1024, // 2 MB
      autostart: true,
    };

    if (isRestore) {
      log("info", `Restoring saved state snapshot (${Math.round(payload.initial_state.byteLength / 1024)} KB)`);

      // Perform signature check on saved state before applying it
      const view = new DataView(payload.initial_state);
      const magic = view.getInt32(0, true);
      if (magic !== -2039052682) {
        throw new Error(`Saved state magic bytes mismatch: ${magic} (expected -2039052682)`);
      }

      config.initial_state = { buffer: payload.initial_state };
      log("info", "Snapshot signature verified successfully.");
    } else {
      log("info", "Cold booting Linux VM — validating boot binaries...");
      
      // Step 2: System BIOS load
      log("info", "Step 2/6: Loading System BIOS (seabios.bin)");
      const biosBuffer = await loadAsset(origin + "/v86/bios/seabios.bin", "seabios.bin", { requireUint16Alignment: true });
      config.bios = { buffer: biosBuffer };
      log("info", "Step 2/6 completed: System BIOS validated.");

      // Step 3: VGA BIOS load
      log("info", "Step 3/6: Loading VGA BIOS (vgabios.bin)");
      const vgaBiosBuffer = await loadAsset(origin + "/v86/bios/vgabios.bin", "vgabios.bin", { requireUint16Alignment: true });
      config.vga_bios = { buffer: vgaBiosBuffer };
      log("info", "Step 3/6 completed: VGA BIOS validated.");

      // Step 4: Kernel load (bzImage does NOT need divisibility by 2)
      log("info", "Step 4/6: Loading Linux kernel (bzImage)");
      const bzImageBuffer = await loadAsset(origin + "/v86/images/bzImage", "bzImage");
      config.bzimage = { buffer: bzImageBuffer };
      log("info", "Step 4/6 completed: Linux kernel validated.");

      // Step 5: Filesystem load (none specified for cold boot, but support it if passed)
      if (payload.initrd_url) {
        log("info", `Step 5/6: Loading ramdisk (initrd) from ${payload.initrd_url}`);
        const initrdBuffer = await loadAsset(payload.initrd_url, "initrd");
        config.initrd = { buffer: initrdBuffer };
        log("info", "Step 5/6 completed: Ramdisk validated.");
      } else {
        log("info", "Step 5/6: Skipping external filesystem/ramdisk loading (none specified).");
      }

      config.cmdline = payload.cmdline ||
        "rw init=/sbin/init root=/dev/ram0 " +
        "tsc=reliable mitigations=off random.trust_cpu=on " +
        "console=ttyS0";
    }

    // Step 6: Create emulator
    log("info", "Step 6/6: Creating v86 emulator instance...");
    if (emulator) {
      log("warn", "Pre-existing emulator instance found during init. Destroying it first.");
      try {
        await emulator.destroy();
      } catch {
        // ignore
      }
      emulator = null;
    }

    emulator = new win.V86(config);

    // Bridge serial0 output back to main thread
    emulator.add_listener("serial0-output-byte", (byte: number) => {
      (self as any).postMessage({ type: "SERIAL_OUT", payload: byte });
    });

    setLifecycleState("initialized");
    (self as any).postMessage({ type: "INIT_SUCCESS" });
    log("info", "v86 emulator successfully created. Transitioned to booting guest...");
    setLifecycleState("booting");
  } catch (err: any) {
    setLifecycleState("failed");
    emulator = null;
    const initErr = `Emulator initialization failed: ${err.message || String(err)}`;
    log("error", initErr);
    (self as any).postMessage({ type: "INIT_FAILURE", payload: initErr });
  }
}

async function handleSaveState() {
  if (!emulator) {
    log("debug", `Save state request ignored: No active emulator instance (state: ${lifecycleState})`);
    return;
  }

  if (lifecycleState !== "running") {
    log("debug", `Save state request ignored: Emulator is not running (state: ${lifecycleState})`);
    return;
  }

  log("info", "Saving VM state snapshot...");
  try {
    emulator.save_state()
      .then((state: ArrayBuffer) => {
        if (!state || !(state instanceof ArrayBuffer)) {
          throw new Error("Invalid state buffer returned by emulator");
        }
        (self as any).postMessage({ type: "SAVE_SUCCESS", payload: state }, [state]);
        log("info", "VM state snapshot successfully saved.");
      })
      .catch((err: any) => {
        const errStr = String(err.message || err);
        log("error", `Save state API failed: ${errStr}`);
        (self as any).postMessage({ type: "SAVE_FAILURE", payload: errStr });
      });
  } catch (err: any) {
    const errStr = String(err.message || err);
    log("error", `Exception thrown in save_state: ${errStr}`);
    (self as any).postMessage({ type: "SAVE_FAILURE", payload: errStr });
  }
}

async function handleStop() {
  if (!emulator) {
    log("debug", "Stop request ignored: No active emulator instance.");
    return;
  }
  log("info", "Stopping/pausing guest emulator...");
  try {
    await emulator.stop();
    log("info", "Guest emulator stopped successfully.");
  } catch (err: any) {
    log("error", `Failed to stop emulator: ${err.message || String(err)}`);
  }
}

function handleRestart() {
  if (!emulator) {
    log("debug", "Restart request ignored: No active emulator instance.");
    return;
  }
  log("info", "Restarting guest emulator...");
  try {
    emulator.restart();
    setLifecycleState("booting");
    log("info", "Guest emulator restarted successfully.");
  } catch (err: any) {
    log("error", `Failed to restart emulator: ${err.message || String(err)}`);
  }
}

function handleDestroy() {
  log("info", "Destroying emulator worker context...");
  setLifecycleState("idle");
  if (emulator) {
    try {
      emulator.destroy();
      log("info", "Emulator instance destroyed successfully.");
    } catch (err: any) {
      log("warn", `Destroy error (non-fatal): ${err.message || String(err)}`);
    }
    emulator = null;
  }
  self.close();
}
