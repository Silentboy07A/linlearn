// public/v86/v86-worker.js
// ─────────────────────────────────────────────────────────────────────────────
// Plain JavaScript Web Worker for v86 emulation.
// Lives in public/ to bypass Next.js webpack bundling entirely.
// This is a CLASSIC worker (not module) — importScripts() is available.
// ─────────────────────────────────────────────────────────────────────────────

/* global importScripts, self, V86 */

"use strict";

/**
 * @typedef {'idle' | 'loading' | 'initialized' | 'booting' | 'running' | 'failed'} EmulatorState
 */

/** @type {object|null} */
var emulator = null;
/** @type {EmulatorState} */
var lifecycleState = "idle";

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

/**
 * Generic binary validation.
 * Checks if the fetch response is successful, non-empty, a valid ArrayBuffer, and not HTML.
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
 * Validates and retrieves an asset, optionally checking for alignment or padding it.
 * @param {string} url
 * @param {string} name
 * @param {object} options
 * @param {boolean} [options.requireUint16Alignment] - If true, throws an error if not aligned to 2 bytes (for BIOS).
 * @param {boolean} [options.autoAlign] - If true, pads the buffer to a multiple of 4 bytes if not aligned.
 * @returns {Promise<ArrayBuffer>}
 */
async function loadAsset(url, name, options = {}) {
  log("debug", "Fetching asset: " + name + " from " + url);
  try {
    var response = await fetch(url);
    var buffer = await validateBinaryResponse(response, name);
    var byteLength = buffer.byteLength;
    
    // Only apply Uint16Array divisibility validation (divisible by 2) if option is explicitly set
    if (options.requireUint16Alignment) {
      if (byteLength % 2 !== 0) {
        throw new Error("size (" + byteLength + ") is not a multiple of 2 (required for Uint16Array parsing)");
      }
    }

    // Auto-align (pad) to multiple of 4 if requested and needed
    if (options.autoAlign && byteLength % 4 !== 0) {
      var padBytes = 4 - (byteLength % 4);
      log("info", "Auto-aligning asset " + name + ": padding " + byteLength + " bytes with " + padBytes + " bytes to make it a multiple of 4.");
      var alignedBuffer = new ArrayBuffer(byteLength + padBytes);
      new Uint8Array(alignedBuffer).set(new Uint8Array(buffer));
      buffer = alignedBuffer;
    }

    log("info", "Loaded asset: " + name + ", size: " + buffer.byteLength + " bytes");
    return buffer;
  } catch (err) {
    var errorMsg = "Failed to load " + name + ": " + (err.message || String(err));
    log("error", errorMsg);
    throw new Error(errorMsg);
  }
}

/**
 * Handle messages from the main thread.
 */
self.onmessage = function (e) {
  var data = e.data;
  if (!data) return;
  
  var type = data.type;
  var payload = data.payload;

  switch (type) {
    case "INIT":
      if (lifecycleState !== "idle" && lifecycleState !== "failed") {
        log("warn", "Ignored INIT command: Emulator already initialized or loading. Current state: " + lifecycleState);
        return;
      }
      handleInit(payload);
      break;

    case "INPUT":
      if (!emulator) {
        log("debug", "Ignored serial input: No active emulator instance. Current state: " + lifecycleState);
        break;
      }
      if (lifecycleState !== "initialized" && lifecycleState !== "booting" && lifecycleState !== "running") {
        log("debug", "Ignored serial input: Emulator is in non-interactive state: " + lifecycleState);
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
        log("warn", "Ignored SET_RUNNING message. Current state: " + lifecycleState);
      }
      break;

    case "SAVE_STATE":
      handleSaveState();
      break;

    case "STOP":
      handleStop();
      break;

    case "RESTART":
      handleRestart();
      break;

    case "DESTROY":
      handleDestroy();
      break;

    default:
      log("warn", "Unknown message type received: " + type);
  }
};

/**
 * Initialize the v86 emulator inside this worker.
 * @param {{ origin: string, initial_state?: ArrayBuffer, memory_size?: number, vga_memory_size?: number, cmdline?: string }} payload
 */
async function handleInit(payload) {
  var origin = payload.origin;
  var t0 = Date.now();

  setLifecycleState("loading");
  log("info", "Step 1/6: Loading libv86.js from " + origin + "/v86/libv86.js");

  try {
    importScripts(origin + "/v86/libv86.js");
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

  log("info", "Step 1/6 completed: libv86.js loaded in " + (Date.now() - t0) + "ms");

  var isRestore = !!(payload.initial_state && payload.initial_state.byteLength > 1024);

  try {
    // Step 1b: Preload Wasm Runtime
    log("info", "Step 1b/6: Preloading and validating WebAssembly runtime...");
    var wasmBuffer = await loadAsset(origin + "/v86/v86.wasm", "v86.wasm", { autoAlign: true });
    var wasmBlob = new Blob([wasmBuffer], { type: "application/wasm" });
    var wasmBlobUrl = URL.createObjectURL(wasmBlob);
    log("info", "Step 1b/6 completed: WebAssembly runtime loaded.");

    // Basic config required for both cold boot and snapshot restore
    var config = {
      wasm_path: wasmBlobUrl,
      memory_size: payload.memory_size || 128 * 1024 * 1024, // 128 MB
      vga_memory_size: payload.vga_memory_size || 2 * 1024 * 1024, // 2 MB
      autostart: true,
    };

    if (isRestore) {
      log("info", "Restoring saved state snapshot (" + Math.round(payload.initial_state.byteLength / 1024) + " KB)");

      // Perform signature check on saved state before applying it
      var view = new DataView(payload.initial_state);
      var magic = view.getInt32(0, true);
      if (magic !== -2039052682) {
        throw new Error("Saved state magic bytes mismatch: " + magic + " (expected -2039052682)");
      }

      config.initial_state = { buffer: payload.initial_state };
      log("info", "Snapshot signature verified successfully.");
    } else {
      log("info", "Cold booting Linux VM — validating boot binaries...");
      
      // Step 2: System BIOS load
      log("info", "Step 2/6: Loading System BIOS (seabios.bin)");
      var biosBuffer = await loadAsset(origin + "/v86/bios/seabios.bin", "seabios.bin", { requireUint16Alignment: true });
      config.bios = { buffer: biosBuffer };
      log("info", "Step 2/6 completed: System BIOS validated.");

      // Step 3: VGA BIOS load
      log("info", "Step 3/6: Loading VGA BIOS (vgabios.bin)");
      var vgaBiosBuffer = await loadAsset(origin + "/v86/bios/vgabios.bin", "vgabios.bin", { requireUint16Alignment: true });
      config.vga_bios = { buffer: vgaBiosBuffer };
      log("info", "Step 3/6 completed: VGA BIOS validated.");

      // Step 4: Kernel load (bzImage itself does not require even size, but libv86.js
      // instantiates Uint16Array and Uint32Array views over its buffer, requiring us
      // to auto-align/pad it to a multiple of 4 bytes at runtime to prevent RangeErrors).
      log("info", "Step 4/6: Loading Linux kernel (bzImage)");
      var bzImageBuffer = await loadAsset(origin + "/v86/images/bzImage", "bzImage", { autoAlign: true });
      config.bzimage = { buffer: bzImageBuffer };
      log("info", "Step 4/6 completed: Linux kernel validated.");

      // Step 5: Filesystem load (none specified for cold boot, but support it if passed)
      if (payload.initrd_url) {
        log("info", "Step 5/6: Loading ramdisk (initrd) from " + payload.initrd_url);
        var initrdBuffer = await loadAsset(payload.initrd_url, "initrd");
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
        emulator.destroy();
      } catch (e) {
        // ignore
      }
      emulator = null;
    }

    emulator = new V86(config);

    // Bridge serial0 output back to main thread
    emulator.add_listener("serial0-output-byte", function (byte) {
      self.postMessage({ type: "SERIAL_OUT", payload: byte });
    });

    setLifecycleState("initialized");
    self.postMessage({ type: "INIT_SUCCESS" });
    log("info", "v86 emulator successfully created. Transitioned to booting guest...");
    setLifecycleState("booting");
  } catch (err) {
    setLifecycleState("failed");
    emulator = null;
    var initErr = "Emulator initialization failed: " + (err.message || String(err));
    log("error", initErr);
    self.postMessage({ type: "INIT_FAILURE", payload: initErr });
  }
}

/**
 * Save VM state and send buffer back to main thread.
 * Defensively guarded to prevent error alerts on background autosaves.
 */
function handleSaveState() {
  if (!emulator) {
    log("debug", "Save state request ignored: No active emulator instance (state: " + lifecycleState + ")");
    return;
  }

  if (lifecycleState !== "running") {
    log("debug", "Save state request ignored: Emulator is not running (state: " + lifecycleState + ")");
    return;
  }

  log("info", "Saving VM state snapshot...");
  try {
    emulator.save_state()
      .then(function (state) {
        if (!state || !(state instanceof ArrayBuffer)) {
          throw new Error("Invalid state buffer returned by emulator");
        }
        self.postMessage({ type: "SAVE_SUCCESS", payload: state }, [state]);
        log("info", "VM state snapshot successfully saved.");
      })
      .catch(function (err) {
        var errStr = String(err.message || err);
        log("error", "Save state API failed: " + errStr);
        self.postMessage({ type: "SAVE_FAILURE", payload: errStr });
      });
  } catch (err) {
    var errStr = String(err.message || err);
    log("error", "Exception thrown in save_state: " + errStr);
    self.postMessage({ type: "SAVE_FAILURE", payload: errStr });
  }
}

/**
 * Defensively stop/pause the emulator.
 */
async function handleStop() {
  if (!emulator) {
    log("debug", "Stop request ignored: No active emulator instance.");
    return;
  }
  log("info", "Stopping/pausing guest emulator...");
  try {
    await emulator.stop();
    log("info", "Guest emulator stopped successfully.");
  } catch (err) {
    log("error", "Failed to stop emulator: " + (err.message || String(err)));
  }
}

/**
 * Defensively restart the emulator.
 */
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
  } catch (err) {
    log("error", "Failed to restart emulator: " + (err.message || String(err)));
  }
}

/**
 * Cleanly destroy the emulator and close the worker.
 */
function handleDestroy() {
  log("info", "Destroying emulator worker context...");
  setLifecycleState("idle");
  if (emulator) {
    try {
      emulator.destroy();
      log("info", "Emulator instance destroyed successfully.");
    } catch (err) {
      log("warn", "Destroy error (non-fatal): " + (err.message || String(err)));
    }
    emulator = null;
  }
  self.close();
}
