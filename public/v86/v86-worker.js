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
 * @typedef {'idle' | 'loading' | 'initialized' | 'booting' | 'provisioning' | 'running' | 'failed' | 'destroyed'} EmulatorState
 */

/** @type {EmulatorState} */
var lifecycleState = "idle";
var isBootingInProgress = false;

// Serial byte buffering variables
var serialSendBuffer = [];
var serialTimeoutId = null;
var utf8Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;

function flushSerialBuffer() {
  if (serialSendBuffer.length > 0) {
    if (utf8Decoder) {
      var uint8 = new Uint8Array(serialSendBuffer);
      var str = utf8Decoder.decode(uint8, { stream: true });
      self.postMessage({ type: "SERIAL_OUT", payload: str });
    } else {
      var str = "";
      for (var i = 0; i < serialSendBuffer.length; i++) {
        str += String.fromCharCode(serialSendBuffer[i]);
      }
      self.postMessage({ type: "SERIAL_OUT", payload: str });
    }
    serialSendBuffer = [];
  }
  serialTimeoutId = null;
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

function canInitialize() {
  return lifecycleState === "idle" || lifecycleState === "failed" || lifecycleState === "destroyed";
}

function canSendInput() {
  return lifecycleState === "booting" || lifecycleState === "provisioning" || lifecycleState === "running";
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
 * Validates and retrieves an asset cleanly, optionally checking for alignment or padding it.
 * @param {string} url
 * @param {string} name
 * @param {object} [options]
 * @param {boolean} [options.autoAlign] - If true, pads the buffer to a multiple of 4 bytes if not aligned.
 * @returns {Promise<ArrayBuffer>}
 */
async function loadAsset(url, name, options = {}) {
  log("debug", "Fetching asset: " + name + " from " + url);
  try {
    var response = await fetch(url);
    var buffer = await validateBinaryResponse(response, name);
    
    if (options.autoAlign && buffer.byteLength % 4 !== 0) {
      var padBytes = 4 - (buffer.byteLength % 4);
      log("info", "Auto-aligning asset " + name + ": padding " + buffer.byteLength + " bytes with " + padBytes + " bytes to make it a multiple of 4.");
      var alignedBuffer = new ArrayBuffer(buffer.byteLength + padBytes);
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

// ─── 3.5. SERIAL CHANNEL MANAGER MODULE ──────────────────────────────────────
/**
 * Manages serial port capacity and routes inputs safely.
 */
var SerialChannelManager = {
  ports: {},
  logThrottle: {},

  init: function(emu) {
    this.ports = {};
    this.logThrottle = {};
    if (!emu) return;

    var keys = Object.keys(emu);
    log("info", "[SerialManager] Auditing emulator capabilities. Keys: " + keys.filter(function(k) {
      return k.indexOf("serial") !== -1 || k.indexOf("adapter") !== -1;
    }).join(", "));

    this.ports['0'] = {
      hasSend: typeof emu.serial0_send === "function",
      ready: true
    };

    this.ports['1'] = {
      hasSend: typeof emu.serial1_send === "function",
      ready: typeof emu.serial_send_bytes === "function"
    };

    log("info", "[SerialManager] Port 0 capability: hasSend=" + this.ports['0'].hasSend);
    log("info", "[SerialManager] Port 1 capability: hasSend=" + this.ports['1'].hasSend + ", hasSendBytes=" + this.ports['1'].ready);
  },

  send: function(port, data) {
    if (!emulator) {
      this.logThrottled("send_no_emu", "error", "[SerialManager] Cannot send: emulator not initialized.");
      return false;
    }

    if (port === 1) {
      if (typeof emulator.serial1_send === "function") {
        emulator.serial1_send(data);
        return true;
      } else if (typeof emulator.serial_send_bytes === "function") {
        var bytes = new Uint8Array(data.length);
        for (var i = 0; i < data.length; i++) {
          bytes[i] = data.charCodeAt(i);
        }
        emulator.serial_send_bytes(1, bytes);
        return true;
      } else {
        this.logThrottled("serial1_unsupported", "warn", "[SerialManager] serial1 is unsupported by the emulator. Dropping payload.");
        return false;
      }
    } else {
      if (typeof emulator.serial0_send === "function") {
        emulator.serial0_send(data);
        return true;
      } else if (typeof emulator.serial_send_bytes === "function") {
        var bytes = new Uint8Array(data.length);
        for (var i = 0; i < data.length; i++) {
          bytes[i] = data.charCodeAt(i);
        }
        emulator.serial_send_bytes(0, bytes);
        return true;
      } else {
        this.logThrottled("serial0_unsupported", "error", "[SerialManager] serial0 is unsupported! Dropping payload.");
        return false;
      }
    }
  },

  logThrottled: function(key, level, msg) {
    var now = Date.now();
    if (!this.logThrottle[key] || now - this.logThrottle[key] > 5000) {
      this.logThrottle[key] = now;
      log(level, msg);
    }
  }
};

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
      vga_memory_size: Math.min(config.vga_memory_size || 8 * 1024 * 1024, 16 * 1024 * 1024), // Sane VGA RAM limit: max 16MB
      autostart: true
    });

    log("debug", "Configuring VM: RAM=" + (finalConfig.memory_size / (1024 * 1024)) + "MB, VGA RAM=" + (finalConfig.vga_memory_size / (1024 * 1024)) + "MB");

    emulator = new win.V86(finalConfig);
    SerialChannelManager.init(emulator);

    // Bridge serial output with batch buffering
    emulator.add_listener("serial0-output-byte", function (byte) {
      serialSendBuffer.push(byte);
      if (serialSendBuffer.length >= 1024) {
        if (serialTimeoutId) {
          clearTimeout(serialTimeoutId);
        }
        flushSerialBuffer();
      } else if (!serialTimeoutId) {
        serialTimeoutId = setTimeout(flushSerialBuffer, 10);
      }
    });

    // Bridge serial1 output (invisible heartbeat channel)
    emulator.add_listener("serial1-output-byte", function (byte) {
      self.postMessage({ type: "SERIAL1_OUT", payload: byte });
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
      if (typeof payload !== "string") {
        log("warn", "Ignored non-string serial input payload");
        break;
      }
      SerialChannelManager.send(0, payload);
      break;

    case "INPUT1":
      if (typeof payload !== "string") {
        log("warn", "Ignored non-string serial1 input payload");
        break;
      }
      SerialChannelManager.send(1, payload);
      break;

    case "SET_STATE":
      setLifecycleState(payload);
      break;

    case "SET_RUNNING":
      if (lifecycleState === "initialized" || lifecycleState === "booting" || lifecycleState === "provisioning") {
        setLifecycleState("running");
        log("info", "Emulator successfully transitioned to running state (boot complete)");
      } else {
        log("warn", "Ignored SET_RUNNING: current state: " + lifecycleState);
      }
      break;

    case "SET_PROVISIONING":
      if (lifecycleState === "booting") {
        setLifecycleState("provisioning");
        log("info", "Emulator transitioned to provisioning state");
      } else {
        log("warn", "Ignored SET_PROVISIONING: current state: " + lifecycleState);
      }
      break;

    case "PING": {
      var cpuRunning = emulator ? (typeof emulator.is_cpu_running === "function" ? emulator.is_cpu_running() : true) : false;
      self.postMessage({ type: "PONG", payload: { cpu_running: cpuRunning } });
      break;
    }

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

    case "SAVE_STATE":
      if (!emulator) {
        log("error", "Cannot save state: emulator not initialized.");
        self.postMessage({ type: "SAVE_STATE_FAILURE", payload: "Emulator not initialized" });
        break;
      }
      try {
        log("info", "Taking guest VM memory snapshot...");
        var state = await emulator.save_state();
        self.postMessage({ type: "SAVE_STATE_SUCCESS", payload: state }, [state]);
        log("info", "Guest VM snapshot taken successfully.");
      } catch (err) {
        log("error", "Failed to save VM state: " + (err.message || String(err)));
        self.postMessage({ type: "SAVE_STATE_FAILURE", payload: err.message || String(err) });
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

    var bzImageBuffer = null;
    if (!payload.initial_state) {
      log("info", "Loading Linux kernel (bzImage)");
      bzImageBuffer = await loadAsset(origin + "/v86/images/bzImage?v=" + version, "bzImage", { autoAlign: true });
    } else {
      log("info", "Skipping kernel download: Restoring directly from snapshot.");
    }

    var config = {
      wasm_path: wasmBlobUrl,
      bios: { buffer: biosBuffer },
      vga_bios: { buffer: vgaBiosBuffer },
      bzimage: bzImageBuffer ? { buffer: bzImageBuffer } : undefined,
      initial_state: payload.initial_state ? { buffer: payload.initial_state } : undefined,
      filesystem: {},
      autostart: true,
      cmdline: payload.cmdline || "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
      memory_size: payload.memory_size || 64 * 1024 * 1024,
      vga_memory_size: payload.vga_memory_size || 8 * 1024 * 1024
    };

    // Step 4: Create emulator
    log("info", "Step 4/4: Creating v86 emulator instance...");
    await createEmulator(config, self);

    self.postMessage({
      type: "INIT_SUCCESS",
      payload: {
        hasSerial1: !!(SerialChannelManager.ports['1'] && SerialChannelManager.ports['1'].ready)
      }
    });
    if (payload.initial_state) {
      log("info", "v86 emulator successfully restored from snapshot. Transitioning to running...");
      setLifecycleState("running");
    } else {
      log("info", "v86 emulator successfully created. Transitioned to booting guest...");
      setLifecycleState("booting");
    }
  } catch (err) {
    setLifecycleState("failed");
    await destroyEmulator();
    var initErr = "Emulator initialization failed: " + (err.message || String(err));
    log("error", initErr);
    self.postMessage({ type: "INIT_FAILURE", payload: initErr });
  }
}

// Post message that the worker script is fully loaded and ready to accept commands
self.postMessage({ type: "WORKER_READY" });
