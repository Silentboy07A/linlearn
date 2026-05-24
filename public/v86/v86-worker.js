// public/v86/v86-worker.js
// ─────────────────────────────────────────────────────────────────────────────
// Plain JavaScript Web Worker for v86 emulation.
// Lives in public/ to bypass Next.js webpack bundling entirely.
// This is a CLASSIC worker (not module) — importScripts() is available.
// Mirrors the modular TS architecture in src/services/v86/.
// ─────────────────────────────────────────────────────────────────────────────

/* global importScripts, self, V86 */

"use strict";

// ─── 1. LOGGER MODULE ────────────────────────────────────────────────────────
/**
 * Post a log message back to the main thread with standardized prefixing.
 * @param {'info' | 'debug' | 'error' | 'warn'} level
 * @param {string} msg
 */
function log(level, msg) {
  var formattedLevel = level.toUpperCase();
  var prefix = "[v86-worker] [" + formattedLevel + "]";
  var cleanMsg = msg;
  if (msg.indexOf(prefix) !== 0) {
    cleanMsg = prefix + " " + msg;
  }
  self.postMessage({ type: "LOG", payload: { level: level.toLowerCase(), msg: cleanMsg } });
}

// ─── 2. VM LIFECYCLE STATE MACHINE MODULE ────────────────────────────────────
/**
 * @typedef {'idle' | 'loading' | 'initialized' | 'booting' | 'running' | 'failed' | 'destroyed'} EmulatorState
 */

/** @type {EmulatorState} */
var lifecycleState = "idle";
var isBootingInProgress = false;

/**
 * Update the emulator lifecycle state and notify the host.
 * @param {EmulatorState} newState
 */
function setLifecycleState(newState) {
  if (lifecycleState !== newState) {
    var oldState = lifecycleState;
    lifecycleState = newState;
    log("debug", "Lifecycle state transitioned: " + oldState + " -> " + newState);
    self.postMessage({ type: "STATE_CHANGED", payload: newState });
  }
}

function canInitialize() {
  return lifecycleState === "idle" || lifecycleState === "failed" || lifecycleState === "destroyed";
}

function canSendInput() {
  return lifecycleState === "booting" || lifecycleState === "running";
}

// ─── 3. ASSET LOADER MODULE ──────────────────────────────────────────────────
/**
 * Generic binary validation.
 * Checks if the fetch response is successful, non-empty, and a valid ArrayBuffer.
 * @param {Response} response
 * @param {string} name
 * @returns {Promise<ArrayBuffer>}
 */
async function validateBinaryResponse(response, name) {
  if (!response.ok) {
    throw new Error("HTTP status " + response.status + " " + response.statusText);
  }

  var contentType = response.headers.get("content-type") || "";
  var ctLower = contentType.toLowerCase();
  if (ctLower.includes("text/html") || ctLower.includes("application/xhtml+xml") || ctLower.includes("text/xml")) {
    throw new Error("received HTML/XML instead of binary stream (probable 404 page redirect)");
  }

  var buffer = await response.arrayBuffer();
  if (!buffer || !(buffer instanceof ArrayBuffer)) {
    throw new Error("response is not a valid ArrayBuffer");
  }

  if (buffer.byteLength === 0) {
    throw new Error("asset is empty (0 bytes)");
  }

  return buffer;
}

/**
 * Validates and retrieves an asset cleanly without any padding/alignment.
 * @param {string} url
 * @param {string} name
 * @returns {Promise<ArrayBuffer>}
 */
async function loadAsset(url, name) {
  log("debug", "Fetching asset: " + name + " from " + url);
  try {
    var response = await fetch(url);
    var buffer = await validateBinaryResponse(response, name);
    log("info", "Loaded asset: " + name + ", size: " + buffer.byteLength + " bytes");
    return buffer;
  } catch (err) {
    var errorMsg = "Failed to load " + name + ": " + (err.message || String(err));
    log("error", errorMsg);
    throw new Error(errorMsg);
  }
}

// ─── 4. EMULATOR MANAGER MODULE ──────────────────────────────────────────────
/** @type {object|null} */
var emulator = null;

/**
 * Instantiates the v86 emulator instance under safe limits.
 * @param {object} config 
 * @param {object} win Global self object containing the loaded V86 class
 */
async function createEmulator(config, win) {
  if (emulator) {
    log("warn", "Pre-existing emulator instance found. Destroying it first to avoid memory leaks.");
    await destroyEmulator();
  }

  log("info", "Instantiating v86 emulator...");
  try {
    // Sane memory limits to prevent memory abuse
    var finalConfig = Object.assign({}, config, {
      memory_size: Math.min(config.memory_size || 64 * 1024 * 1024, 128 * 1024 * 1024), // Sane RAM limit: max 128MB
      vga_memory_size: 2 * 1024 * 1024, // Minimal VGA memory: 2MB
      autostart: true
    });

    log("debug", "Configuring VM: RAM=" + (finalConfig.memory_size / (1024 * 1024)) + "MB, VGA RAM=" + (finalConfig.vga_memory_size / (1024 * 1024)) + "MB");

    emulator = new win.V86(finalConfig);

    // Bridge serial output
    emulator.add_listener("serial0-output-byte", function (byte) {
      self.postMessage({ type: "SERIAL_OUT", payload: byte });
    });

    log("info", "v86 emulator successfully created.");
  } catch (err) {
    emulator = null;
    var msg = "Failed to create emulator instance: " + (err.message || String(err));
    log("error", msg);
    throw new Error(msg);
  }
}

/**
 * Destroy the emulator instance and free resources.
 */
async function destroyEmulator() {
  if (emulator) {
    log("info", "Destroying active emulator instance...");
    try {
      if (typeof emulator.destroy === "function") {
        await emulator.destroy();
      }
      log("info", "Emulator instance destroyed successfully.");
    } catch (err) {
      log("warn", "Error while destroying emulator (non-fatal): " + (err.message || String(err)));
    }
    emulator = null;
  }
}

// ─── 5. MESSAGE EVENT HANDLER & ENTRYPOINT ───────────────────────────────────
/**
 * Handle messages from the main thread.
 */
self.onmessage = async function (e) {
  var data = e.data;
  if (!data) return;
  
  var type = data.type;
  var payload = data.payload;

  switch (type) {
    case "INIT":
      if (!canInitialize() || isBootingInProgress) {
        log("warn", "Ignored INIT: emulator already initializing or running (state: " + lifecycleState + ")");
        return;
      }
      isBootingInProgress = true;
      await handleInit(payload);
      isBootingInProgress = false;
      break;

    case "INPUT":
      if (!emulator) {
        log("debug", "Ignored serial input: No active emulator (state: " + lifecycleState + ")");
        break;
      }
      if (!canSendInput()) {
        log("debug", "Ignored serial input: VM is in non-interactive state (state: " + lifecycleState + ")");
        break;
      }
      try {
        emulator.serial0_send(payload);
      } catch (err) {
        log("error", "Failed to send serial input: " + (err.message || String(err)));
      }
      break;

    case "SET_RUNNING":
      if (lifecycleState === "initialized" || lifecycleState === "booting") {
        setLifecycleState("running");
        log("info", "Emulator successfully transitioned to running state (boot complete)");
      } else {
        log("warn", "Ignored SET_RUNNING: current state: " + lifecycleState);
      }
      break;

    case "STOP":
      if (emulator) {
        log("info", "Stopping/pausing guest emulator...");
        try {
          await emulator.stop();
          log("info", "Guest emulator stopped successfully.");
        } catch (err) {
          log("error", "Failed to stop emulator: " + (err.message || String(err)));
        }
      }
      break;

    case "RESTART":
      if (emulator) {
        log("info", "Restarting guest emulator...");
        try {
          emulator.restart();
          setLifecycleState("booting");
          log("info", "Guest emulator restarted successfully.");
        } catch (err) {
          log("error", "Failed to restart emulator: " + (err.message || String(err)));
        }
      }
      break;

    case "DESTROY":
      log("info", "Destroying emulator worker context...");
      setLifecycleState("destroyed");
      await destroyEmulator();
      self.close();
      break;

    default:
      log("warn", "Unknown message type received: " + type);
  }
};

/**
 * Initialize the v86 emulator inside this worker.
 * @param {{ origin: string, version?: string, memory_size?: number, cmdline?: string }} payload
 */
async function handleInit(payload) {
  var origin = payload.origin;
  var version = payload.version || Date.now().toString();
  var t0 = Date.now();

  setLifecycleState("loading");
  log("info", "Step 1/4: Loading libv86.js from " + origin + "/v86/libv86.js?v=" + version);

  try {
    importScripts(origin + "/v86/libv86.js?v=" + version);
  } catch (err) {
    var msg = "Failed to load libv86.js: " + (err.message || String(err));
    log("error", msg);
    setLifecycleState("failed");
    self.postMessage({ type: "INIT_FAILURE", payload: msg });
    return;
  }

  if (typeof V86 === "undefined") {
    var errMsg = "V86 constructor not found after importScripts";
    log("error", errMsg);
    setLifecycleState("failed");
    self.postMessage({ type: "INIT_FAILURE", payload: errMsg });
    return;
  }

  log("info", "Step 1/4 completed: libv86.js loaded in " + (Date.now() - t0) + "ms");

  try {
    // Step 2: Preload Wasm Runtime
    log("info", "Step 2/4: Preloading and validating WebAssembly runtime...");
    var wasmBuffer = await loadAsset(origin + "/v86/v86.wasm?v=" + version, "v86.wasm");
    var wasmBlob = new Blob([wasmBuffer], { type: "application/wasm" });
    var wasmBlobUrl = URL.createObjectURL(wasmBlob);
    log("info", "Step 2/4 completed: WebAssembly runtime loaded.");

    // Step 3: Load Boot Binaries
    log("info", "Step 3/4: Loading BIOS & Kernel binaries...");

    log("info", "Loading System BIOS (seabios.bin)");
    var biosBuffer = await loadAsset(origin + "/v86/bios/seabios.bin?v=" + version, "seabios.bin");

    log("info", "Loading VGA BIOS (vgabios.bin)");
    var vgaBiosBuffer = await loadAsset(origin + "/v86/bios/vgabios.bin?v=" + version, "vgabios.bin");

    log("info", "Loading Linux kernel (bzImage)");
    var bzImageBuffer = await loadAsset(origin + "/v86/images/bzImage?v=" + version, "bzImage");

    var config = {
      wasm_path: wasmBlobUrl,
      bios: { buffer: biosBuffer },
      vga_bios: { buffer: vgaBiosBuffer },
      bzimage: { buffer: bzImageBuffer },
      autostart: true,
      cmdline: payload.cmdline || "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
      memory_size: payload.memory_size || 64 * 1024 * 1024
    };

    // Step 4: Create emulator
    log("info", "Step 4/4: Creating v86 emulator instance...");
    await createEmulator(config, self);

    setLifecycleState("initialized");
    self.postMessage({ type: "INIT_SUCCESS" });
    log("info", "v86 emulator successfully created. Transitioned to booting guest...");
    setLifecycleState("booting");
  } catch (err) {
    setLifecycleState("failed");
    await destroyEmulator();
    var initErr = "Emulator initialization failed: " + (err.message || String(err));
    log("error", initErr);
    self.postMessage({ type: "INIT_FAILURE", payload: initErr });
  }
}
