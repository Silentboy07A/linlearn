// public/v86/v86-worker.js
// ─────────────────────────────────────────────────────────────────────────────
// Plain JavaScript Web Worker for v86 emulation.
// Lives in public/ to bypass Next.js webpack bundling entirely.
// This is a CLASSIC worker (not module) — importScripts() is available.
// ─────────────────────────────────────────────────────────────────────────────

/* global importScripts, self, V86 */

"use strict";

/** @type {object|null} */
var emulator = null;

/**
 * Post a log message back to the main thread for diagnostics.
 * @param {string} level
 * @param {string} msg
 */
function log(level, msg) {
  self.postMessage({ type: "LOG", payload: { level: level, msg: msg } });
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
      if (emulator) {
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
      log("warn", "Unknown message type: " + type);
  }
};

/**
 * Initialize the v86 emulator inside this worker.
 * @param {{ origin: string, initial_state?: ArrayBuffer }} payload
 */
function handleInit(payload) {
  var origin = payload.origin;
  var t0 = Date.now();

  log("info", "Worker: Loading libv86.js from " + origin + "/v86/libv86.js");

  try {
    // importScripts is synchronous — blocks until script is fully loaded.
    // This only works in classic workers (not module workers).
    importScripts(origin + "/v86/libv86.js");
  } catch (err) {
    var msg =
      "Failed to load libv86.js: " + (err.message || String(err));
    log("error", msg);
    self.postMessage({ type: "INIT_FAILURE", payload: msg });
    return;
  }

  if (typeof V86 === "undefined") {
    var errMsg = "V86 constructor not found after importScripts";
    log("error", errMsg);
    self.postMessage({ type: "INIT_FAILURE", payload: errMsg });
    return;
  }

  log("info", "Worker: libv86.js loaded in " + (Date.now() - t0) + "ms");
  log("info", "Worker: Creating v86 emulator instance...");

  try {
    var config = {
      wasm_path: origin + "/v86/v86.wasm",
      memory_size: 128 * 1024 * 1024, // 128 MB
      vga_memory_size: 2 * 1024 * 1024, // 2 MB
      bios: { url: origin + "/v86/bios/seabios.bin" },
      vga_bios: { url: origin + "/v86/bios/vgabios.bin" },
      bzimage: { url: origin + "/v86/images/bzImage", async: false },
      cmdline:
        "rw init=/sbin/init root=/dev/ram0 " +
        "tsc=reliable mitigations=off random.trust_cpu=on " +
        "console=ttyS0",
      autostart: true,
    };

    // If a saved state exists, restore from snapshot instead of cold boot
    if (payload.initial_state && payload.initial_state.byteLength > 1024) {
      log(
        "info",
        "Worker: Restoring saved state (" +
          Math.round(payload.initial_state.byteLength / 1024) +
          " KB)"
      );
      config.initial_state = { buffer: payload.initial_state };
    }

    emulator = new V86(config);

    // Bridge serial0 output back to main thread
    emulator.add_listener("serial0-output-byte", function (byte) {
      // Send individual bytes — main thread batches them for xterm
      self.postMessage({ type: "SERIAL_OUT", payload: byte });
    });

    // Notify main thread that init succeeded
    self.postMessage({ type: "INIT_SUCCESS" });
    log("info", "Worker: v86 emulator created and started");
  } catch (err) {
    var initErr =
      "Emulator creation failed: " + (err.message || String(err));
    log("error", initErr);
    self.postMessage({ type: "INIT_FAILURE", payload: initErr });
  }
}

/**
 * Save VM state and send buffer back to main thread via Transferable.
 */
function handleSaveState() {
  if (!emulator) {
    self.postMessage({
      type: "SAVE_FAILURE",
      payload: "No emulator instance",
    });
    return;
  }

  try {
    emulator.save_state(function (err, state) {
      if (err) {
        self.postMessage({ type: "SAVE_FAILURE", payload: String(err) });
      } else {
        // Transfer the ArrayBuffer (zero-copy) to main thread
        self.postMessage({ type: "SAVE_SUCCESS", payload: state }, [state]);
      }
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
  log("info", "Worker: Destroying emulator...");
  if (emulator) {
    try {
      emulator.destroy();
    } catch (err) {
      log("warn", "Destroy error (non-fatal): " + (err.message || String(err)));
    }
    emulator = null;
  }
  self.close();
}
