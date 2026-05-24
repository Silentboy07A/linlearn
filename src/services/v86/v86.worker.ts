// src/services/v86/v86.worker.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { log } from "./logger";
import { loadAsset } from "./assetLoader";
import {
  setLifecycleState,
  getLifecycleState,
  canInitialize,
  canSendInput,
  setBootingInProgress,
  isBooting,
} from "./vmLifecycle";
import {
  getEmulator,
  createEmulator,
  destroyEmulator,
  V86StarterConfig,
} from "./emulatorManager";

interface WindowWithV86 {
  V86: any;
}

self.onmessage = async (e: MessageEvent) => {
  if (!e.data) return;
  const { type, payload } = e.data;

  switch (type) {
    case "INIT":
      if (!canInitialize() || isBooting()) {
        log("warn", `Ignored INIT: emulator already initializing or running (state: ${getLifecycleState()})`);
        return;
      }
      setBootingInProgress(true);
      await handleInit(payload);
      setBootingInProgress(false);
      break;

    case "INPUT": {
      const emulator = getEmulator();
      if (!emulator) {
        log("debug", `Ignored serial input: No active emulator (state: ${getLifecycleState()})`);
        break;
      }
      if (!canSendInput()) {
        log("debug", `Ignored serial input: VM is in non-interactive state (state: ${getLifecycleState()})`);
        break;
      }
      try {
        emulator.serial0_send(payload);
      } catch (err: any) {
        log("error", `Failed to send serial input: ${err.message || String(err)}`);
      }
      break;
    }

    case "SET_RUNNING":
      if (getLifecycleState() === "booting") {
        setLifecycleState("running");
        log("info", "Emulator successfully transitioned to running state (boot complete)");
      } else {
        log("warn", `Ignored SET_RUNNING: current state: ${getLifecycleState()}`);
      }
      break;

    case "STOP":
      await handleStop();
      break;

    case "RESTART":
      handleRestart();
      break;

    case "DESTROY":
      await handleDestroy();
      break;

    default:
      log("warn", `Unknown message type received: ${type}`);
  }
};

async function handleInit(payload: any) {
  const origin = payload.origin;
  const version = payload.version || Date.now().toString();
  const t0 = Date.now();

  setLifecycleState("loading");
  log("info", `Step 1/4: Loading libv86.js from ${origin}/v86/libv86.js?v=${version}`);

  try {
    (self as any).importScripts(`${origin}/v86/libv86.js?v=${version}`);
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

  log("info", `Step 1/4 completed: libv86.js loaded in ${Date.now() - t0}ms`);

  try {
    // Step 2: Preload Wasm Runtime
    log("info", "Step 2/4: Preloading and validating WebAssembly runtime...");
    const wasmBuffer = await loadAsset(`${origin}/v86/v86.wasm?v=${version}`, "v86.wasm");
    const wasmBlob = new Blob([wasmBuffer], { type: "application/wasm" });
    const wasmBlobUrl = URL.createObjectURL(wasmBlob);
    log("info", "Step 2/4 completed: WebAssembly runtime loaded.");

    // Step 3: Load Boot Binaries (BIOS, VGA BIOS, Kernel)
    log("info", "Step 3/4: Loading BIOS & Kernel binaries...");

    log("info", "Loading System BIOS (seabios.bin)");
    const biosBuffer = await loadAsset(`${origin}/v86/bios/seabios.bin?v=${version}`, "seabios.bin");

    log("info", "Loading VGA BIOS (vgabios.bin)");
    const vgaBiosBuffer = await loadAsset(`${origin}/v86/bios/vgabios.bin?v=${version}`, "vgabios.bin");

    log("info", "Loading Linux kernel (bzImage)");
    const bzImageBuffer = await loadAsset(`${origin}/v86/images/bzImage?v=${version}`, "bzImage", { autoAlign: true });

    const config: V86StarterConfig = {
      wasm_path: wasmBlobUrl,
      bios: { buffer: biosBuffer },
      vga_bios: { buffer: vgaBiosBuffer },
      bzimage: { buffer: bzImageBuffer },
      filesystem: {},
      autostart: true,
      cmdline: payload.cmdline || "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
      memory_size: payload.memory_size || 64 * 1024 * 1024,
      vga_memory_size: payload.vga_memory_size || 8 * 1024 * 1024,
    };

    // Step 4: Create emulator
    log("info", "Step 4/4: Creating v86 emulator instance...");
    await createEmulator(config, win);

    (self as any).postMessage({ type: "INIT_SUCCESS" });
    log("info", "v86 emulator successfully created. Transitioned to booting guest...");
    setLifecycleState("booting");
  } catch (err: any) {
    setLifecycleState("failed");
    await destroyEmulator();
    const initErr = `Emulator initialization failed: ${err.message || String(err)}`;
    log("error", initErr);
    (self as any).postMessage({ type: "INIT_FAILURE", payload: initErr });
  }
}

async function handleStop() {
  const emulator = getEmulator();
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
  const emulator = getEmulator();
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

async function handleDestroy() {
  log("info", "Destroying emulator worker context...");
  setLifecycleState("destroyed");
  await destroyEmulator();
  self.close();
}
