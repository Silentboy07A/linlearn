// src/services/v86/v86.worker.ts
import { log } from "./logger";
import { loadAsset } from "./assetLoader";
import {
  setLifecycleState,
  getLifecycleState,
  canInitialize,
  canSendInput,
  setBootingInProgress,
  isBooting,
  EmulatorState,
} from "./vmLifecycle";
import {
  getEmulator,
  createEmulator,
  destroyEmulator,
  V86StarterConfig,
  V86StarterInstance,
} from "./emulatorManager";

interface DedicatedWorkerGlobal {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  importScripts(...urls: string[]): void;
  close(): void;
}

const workerCtx = self as unknown as DedicatedWorkerGlobal;

interface WindowWithV86 {
  V86: new (config: V86StarterConfig) => V86StarterInstance;
}

type WorkerMessageType =
  | "INIT"
  | "INPUT"
  | "SET_STATE"
  | "SET_RUNNING"
  | "SET_PROVISIONING"
  | "SAVE_STATE"
  | "STOP"
  | "RESTART"
  | "DESTROY";

interface WorkerMessage {
  type: WorkerMessageType;
  payload?: unknown;
}

interface InitPayload {
  origin: string;
  version?: string;
  initial_state?: ArrayBuffer;
  cmdline?: string;
  memory_size?: number;
  vga_memory_size?: number;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Mutex lock for init serialization ──────────────────────────────────────
let initLock: Promise<void> | null = null;

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  if (!e.data) return;
  const { type, payload } = e.data;

  switch (type) {
    case "INIT": {
      const initPayload = payload as InitPayload;
      if (!canInitialize() || isBooting()) {
        log("warn", `Ignored INIT: emulator already initializing or running (state: ${getLifecycleState()})`);
        return;
      }
      // Mutex: prevent concurrent INIT calls
      if (initLock) {
        log("warn", `Ignored INIT: another initialization is already in progress`);
        return;
      }
      setBootingInProgress(true);
      initLock = handleInit(initPayload).finally(() => {
        initLock = null;
        setBootingInProgress(false);
      });
      await initLock;
      break;
    }

    case "INPUT": {
      const emulator = getEmulator();
      if (!emulator) {
        log("warn", `Ignored serial input: No active emulator (state: ${getLifecycleState()})`);
        break;
      }
      if (!canSendInput()) {
        log("warn", `Ignored serial input: VM is in non-interactive state (state: ${getLifecycleState()})`);
        break;
      }
      const inputPayload = payload as string;
      log("info", `Routing serial input of length ${inputPayload ? inputPayload.length : 0} payload: ${JSON.stringify(inputPayload)} to emulator`);
      try {
        emulator.serial0_send(inputPayload);
        log("info", "Successfully sent serial input to emulator.");
      } catch (err: unknown) {
        log("error", `Failed to send serial input: ${getErrorMessage(err)}`);
      }
      break;
    }

    case "SET_STATE": {
      // Incoming state sync from main thread — use silent=true to break echo loop
      const statePayload = payload as EmulatorState;
      setLifecycleState(statePayload, "SET_STATE from main thread", true);
      break;
    }

    case "SET_RUNNING":
      if (getLifecycleState() === "booting") {
        setLifecycleState("running", "SET_RUNNING (boot complete)");
        log("info", "Emulator successfully transitioned to running state (boot complete)");
      } else {
        log("warn", `Ignored SET_RUNNING: current state: ${getLifecycleState()}`);
      }
      break;

    case "SET_PROVISIONING":
      if (getLifecycleState() === "booting") {
        setLifecycleState("provisioning", "SET_PROVISIONING");
        log("info", "Emulator transitioned to provisioning state");
      } else {
        log("warn", `Ignored SET_PROVISIONING: current state: ${getLifecycleState()}`);
      }
      break;

    case "SAVE_STATE": {
      const emulator = getEmulator();
      if (!emulator) {
        log("error", "Cannot save state: emulator not initialized.");
        workerCtx.postMessage({ type: "SAVE_STATE_FAILURE", payload: "Emulator not initialized" });
        break;
      }
      try {
        log("info", "Taking guest VM memory snapshot...");
        const state = await emulator.save_state();
        workerCtx.postMessage({ type: "SAVE_STATE_SUCCESS", payload: state }, [state]);
        log("info", "Guest VM snapshot taken successfully.");
      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        log("error", `Failed to save VM state: ${errMsg}`);
        workerCtx.postMessage({ type: "SAVE_STATE_FAILURE", payload: errMsg });
      }
      break;
    }

    case "STOP":
      await handleStop();
      break;

    case "RESTART":
      await handleRestart();
      break;

    case "DESTROY":
      await handleDestroy();
      break;

    default:
      log("warn", `Unknown message type received: ${type}`);
  }
};

async function handleInit(payload: InitPayload) {
  const origin = payload.origin;
  const version = payload.version || Date.now().toString();
  const t0 = Date.now();

  setLifecycleState("loading", "handleInit");
  log("info", `Step 1/4: Loading libv86.js from ${origin}/v86/libv86.js?v=${version}`);

  try {
    workerCtx.importScripts(`${origin}/v86/libv86.js?v=${version}`);
  } catch (err: unknown) {
    const msg = `Failed to load libv86.js: ${getErrorMessage(err)}`;
    log("error", msg);
    setLifecycleState("error", "handleInit: libv86 load failed");
    workerCtx.postMessage({ type: "INIT_FAILURE", payload: msg });
    return;
  }

  const win = self as unknown as WindowWithV86;
  if (!win.V86) {
    const errMsg = "V86 constructor not found after importScripts";
    log("error", errMsg);
    setLifecycleState("error", "handleInit: V86 constructor missing");
    workerCtx.postMessage({ type: "INIT_FAILURE", payload: errMsg });
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

    let bzImageBuffer: ArrayBuffer | null = null;
    if (!payload.initial_state) {
      log("info", "Loading Linux kernel (bzImage)");
      bzImageBuffer = await loadAsset(`${origin}/v86/images/bzImage?v=${version}`, "bzImage", { autoAlign: true });
    } else {
      log("info", "Skipping kernel download: Restoring directly from snapshot.");
    }

    const config: V86StarterConfig = {
      wasm_path: wasmBlobUrl,
      bios: { buffer: biosBuffer },
      vga_bios: { buffer: vgaBiosBuffer },
      bzimage: bzImageBuffer ? { buffer: bzImageBuffer } : undefined,
      initial_state: payload.initial_state ? { buffer: payload.initial_state } : undefined,
      filesystem: {},
      autostart: true,
      cmdline: payload.cmdline || "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
      memory_size: payload.memory_size || 64 * 1024 * 1024,
      vga_memory_size: payload.vga_memory_size || 8 * 1024 * 1024,
    };

    // Step 4: Create emulator
    log("info", "Step 4/4: Creating v86 emulator instance...");
    await createEmulator(config, win);

    workerCtx.postMessage({ type: "INIT_SUCCESS" });
    log("info", "v86 emulator successfully created. Transitioned to booting guest...");
    setLifecycleState("booting", "handleInit: emulator created");
  } catch (err: unknown) {
    setLifecycleState("error", "handleInit: emulator creation failed");
    await destroyEmulator();
    const initErr = `Emulator initialization failed: ${getErrorMessage(err)}`;
    log("error", initErr);
    workerCtx.postMessage({ type: "INIT_FAILURE", payload: initErr });
  }
}

async function handleStop() {
  const emulator = getEmulator();
  if (!emulator) {
    log("debug", "Stop request ignored: No active emulator instance.");
    return;
  }

  const currentState = getLifecycleState();
  if (currentState !== "running" && currentState !== "booting" && currentState !== "provisioning") {
    log("debug", `Stop request ignored: VM is in state ${currentState}`);
    return;
  }

  // Graceful shutdown: running -> stopping -> stopped
  setLifecycleState("stopping", "handleStop");
  log("info", "Stopping/pausing guest emulator...");
  try {
    await emulator.stop();
    setLifecycleState("stopped", "handleStop: emulator stopped");
    log("info", "Guest emulator stopped successfully.");
  } catch (err: unknown) {
    log("error", `Failed to stop emulator: ${getErrorMessage(err)}`);
    setLifecycleState("error", "handleStop: stop failed");
  }
}

async function handleRestart() {
  const emulator = getEmulator();
  if (!emulator) {
    log("debug", "Restart request ignored: No active emulator instance.");
    return;
  }

  const currentState = getLifecycleState();
  log("info", `Restart requested. Current state: ${currentState}`);

  // Must go through proper shutdown first: running -> stopping -> stopped -> booting
  if (currentState === "running" || currentState === "booting" || currentState === "provisioning") {
    setLifecycleState("stopping", "handleRestart: stopping before restart");
    try {
      await emulator.stop();
    } catch (err: unknown) {
      log("warn", `Error stopping emulator during restart: ${getErrorMessage(err)}`);
    }
    setLifecycleState("stopped", "handleRestart: stopped");
  }

  // Now transition stopped -> loading -> booting via restart
  if (getLifecycleState() !== "stopped" && getLifecycleState() !== "error") {
    log("warn", `Cannot restart from state: ${getLifecycleState()}`);
    return;
  }

  try {
    // Transition to loading first (stopped -> loading is valid)
    setLifecycleState("loading", "handleRestart: restarting");
    emulator.restart();
    setLifecycleState("booting", "handleRestart: emulator restarted");
    log("info", "Guest emulator restarted successfully.");
  } catch (err: unknown) {
    log("error", `Failed to restart emulator: ${getErrorMessage(err)}`);
    setLifecycleState("error", "handleRestart: restart failed");
  }
}

async function handleDestroy() {
  log("info", "Destroying emulator worker context...");
  const currentState = getLifecycleState();
  // Ensure we go through stopping if currently alive
  if (currentState === "running" || currentState === "booting" || currentState === "provisioning") {
    setLifecycleState("stopping", "handleDestroy: stopping first");
  }
  setLifecycleState("stopped", "handleDestroy");
  await destroyEmulator();
  workerCtx.close();
}
