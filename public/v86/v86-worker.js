// public/v86/v86-worker.js
// ─────────────────────────────────────────────────────────────────────────────
// Plain JavaScript Web Worker for v86 emulation.
// Lives in public/ to bypass Next.js webpack bundling entirely.
// This is a CLASSIC worker (not module) — importScripts() is available.
// ─────────────────────────────────────────────────────────────────────────────

/* global importScripts, self, V86 */

"use strict";

/** @type {object|null} */
/** @type {object|null} */
/** @type {object|null} */
var emulator = null;
/** @type {boolean} */
var isInitialized = false;

/**
 * Post a log message back to the main thread for diagnostics.
 * @param {string} level
 * @param {string} msg
 */
function log(level, msg) {
  self.postMessage({ type: "LOG", payload: { level: level, msg: msg } });
}

/**
 * Fetches and validates a binary asset.
 * @param {string} url
 * @param {string} name
 * @param {boolean} requireAlignment
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchAndValidateAsset(url, name, requireAlignment) {
  log("debug", "[v86-worker] [DEBUG] Fetching asset: " + name + " from " + url);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("HTTP status " + response.status + " " + response.statusText);
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
    log("info", "[v86-worker] [INFO] Loaded asset: " + name + ", size: " + byteLength + " bytes, aligned: " + isAligned);

    if (requireAlignment && !isAligned) {
      throw new Error("Asset is corrupted (byte length " + byteLength + " is not a multiple of 2)");
    }

    return buffer;
  } catch (err) {
    const errorMsg = "Failed to load " + name + ": " + (err.message || String(err));
    log("error", "[v86-worker] [ERROR] " + errorMsg);
    throw new Error(errorMsg);
  }
}

/**
 * Handle messages from the main thread.
 */
self.onmessage = function (e) {
  var data = e.data;
  var type = data.type;
  var payload = data.payload;

  switch (type) {
    case "INIT":
      handleInit(payload);
      break;

    case "INPUT":
      if (emulator && isInitialized) {
        emulator.serial0_send(payload);
      }
      break;

    case "SAVE_STATE":
      handleSaveState();
      break;

    case "DESTROY":
      handleDestroy();
      break;

    default:
      log("warn", "[v86-worker] [DEBUG] Unknown message type: " + type);
  }
};

/**
 * Initialize the v86 emulator inside this worker.
 * @param {{ origin: string, initial_state?: ArrayBuffer }} payload
 */
async function handleInit(payload) {
  var origin = payload.origin;
  var t0 = Date.now();

  log("info", "[v86-worker] [INFO] Loading libv86.js from " + origin + "/v86/libv86.js");

  try {
    // importScripts is synchronous — blocks until script is fully loaded.
    importScripts(origin + "/v86/libv86.js");
  } catch (err) {
    var msg = "Failed to load libv86.js: " + (err.message || String(err));
    log("error", "[v86-worker] [ERROR] " + msg);
    self.postMessage({ type: "INIT_FAILURE", payload: msg });
    return;
  }

  if (typeof V86 === "undefined") {
    var errMsg = "V86 constructor not found after importScripts";
    log("error", "[v86-worker] [ERROR] " + errMsg);
    self.postMessage({ type: "INIT_FAILURE", payload: errMsg });
    return;
  }

  log("info", "[v86-worker] [INFO] libv86.js loaded in " + (Date.now() - t0) + "ms");

  const isRestore = !!(payload.initial_state && payload.initial_state.byteLength > 1024);

  try {
    log("info", "[v86-worker] [INFO] Preloading and validating WebAssembly runtime...");
    const wasmBuffer = await fetchAndValidateAsset(origin + "/v86/v86.wasm", "v86.wasm", false);
    const wasmBlob = new Blob([wasmBuffer], { type: "application/wasm" });
    const wasmBlobUrl = URL.createObjectURL(wasmBlob);

    // Basic config required for both cold boot and snapshot restore
    var config = {
      wasm_path: wasmBlobUrl,
      memory_size: 128 * 1024 * 1024, // 128 MB
      vga_memory_size: 2 * 1024 * 1024, // 2 MB
      autostart: true,
    };

    if (isRestore) {
      log(
        "info",
        "[v86-worker] [INFO] Restoring saved state (" +
          Math.round(payload.initial_state.byteLength / 1024) +
          " KB)"
      );

      // Perform signature check on saved state before applying it
      const view = new DataView(payload.initial_state);
      const magic = view.getInt32(0, true);
      if (magic !== -2039052682) {
        throw new Error("Saved state magic bytes mismatch: " + magic + " (expected -2039052682)");
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
      config.cmdline =
        "rw init=/sbin/init root=/dev/ram0 " +
        "tsc=reliable mitigations=off random.trust_cpu=on " +
        "console=ttyS0";
    }

    log("info", "[v86-worker] [INFO] Creating v86 emulator instance...");
    emulator = new V86(config);

    // Bridge serial0 output back to main thread
    emulator.add_listener("serial0-output-byte", function (byte) {
      self.postMessage({ type: "SERIAL_OUT", payload: byte });
    });

    // Notify main thread that init succeeded
    isInitialized = true;
    self.postMessage({ type: "INIT_SUCCESS" });
    log("info", "[v86-worker] [INFO] v86 emulator created and started successfully");
  } catch (err) {
    isInitialized = false;
    emulator = null;
    var initErr = "Emulator initialization failed: " + (err.message || String(err));
    log("error", "[v86-worker] [ERROR] " + initErr);
    self.postMessage({ type: "INIT_FAILURE", payload: initErr });
  }
}

/**
 * Save VM state and send buffer back to main thread via Transferable.
 */
function handleSaveState() {
  if (!emulator || !isInitialized) {
    self.postMessage({
      type: "SAVE_FAILURE",
      payload: "No emulator instance or emulator not fully initialized",
    });
    return;
  }

  try {
    emulator.save_state()
      .then(function (state) {
        if (!state || !(state instanceof ArrayBuffer)) {
          throw new Error("Invalid state buffer returned by emulator");
        }
        self.postMessage({ type: "SAVE_SUCCESS", payload: state }, [state]);
      })
      .catch(function (err) {
        log("error", "[v86-worker] [ERROR] Save state failed: " + String(err));
        self.postMessage({ type: "SAVE_FAILURE", payload: String(err) });
      });
  } catch (err) {
    self.postMessage({
      type: "SAVE_FAILURE",
      payload: "save_state threw: " + (err.message || String(err)),
    });
  }
}

/**
 * Cleanly destroy the emulator and close the worker.
 */
function handleDestroy() {
  log("info", "[v86-worker] [INFO] Destroying emulator...");
  isInitialized = false;
  if (emulator) {
    try {
      emulator.destroy();
    } catch (err) {
      log("warn", "[v86-worker] [DEBUG] Destroy error (non-fatal): " + (err.message || String(err)));
    }
    emulator = null;
  }
  self.close();
}
