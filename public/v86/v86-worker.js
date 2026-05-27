// public/v86/v86-worker.js
// ─────────────────────────────────────────────────────────────────────────────
// Plain JavaScript Web Worker for v86 emulation.
// Lives in public/ to bypass Next.js webpack bundling entirely.
// This is a CLASSIC worker (not module) — importScripts() is available.
// Mirrors the modular TS architecture in src/services/v86/.
// ─────────────────────────────────────────────────────────────────────────────

/* global importScripts, self, V86 */

"use strict";

console.log("[WORKER STARTUP]");

// Generation management
var workerGeneration = 0;

/**
 * Post a message back to the main thread, automatically attaching the active generation ID.
 * @param {string} type
 * @param {any} [payload]
 * @param {any[]} [transferables]
 */
function postToHost(type, payload, transferables) {
  var msg = {
    type: type,
    payload: payload,
    generation: workerGeneration
  };
  console.log("[WORKER MESSAGE SENT]", msg);
  if (transferables) {
    self.postMessage(msg, transferables);
  } else {
    self.postMessage(msg);
  }
}

// Global Exception Guards
self.onerror = function (message, source, lineno, colno, error) {
  var errInfo = "Uncaught worker exception: " + message + " at " + source + ":" + lineno + ":" + colno;
  if (error && error.stack) {
    errInfo += "\nStack: " + error.stack;
  }
  log("error", errInfo);
  postToHost("INIT_FAILURE", errInfo);
};

self.addEventListener("unhandledrejection", function (event) {
  var reason = event.reason;
  var errInfo = "Unhandled promise rejection in worker: " + (reason && (reason.message || String(reason)));
  if (reason && reason.stack) {
    errInfo += "\nStack: " + reason.stack;
  }
  log("error", errInfo);
  postToHost("INIT_FAILURE", errInfo);
});

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
  postToHost("LOG", { level: level.toLowerCase(), msg: cleanMsg });
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
      postToHost("SERIAL_OUT", str);
    } else {
      var str = "";
      for (var i = 0; i < serialSendBuffer.length; i++) {
        str += String.fromCharCode(serialSendBuffer[i]);
      }
      postToHost("SERIAL_OUT", str);
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
    console.log("[WORKER STATE_CHANGED EMISSION]", newState);
    var oldState = lifecycleState;
    lifecycleState = newState;
    console.log("[STATE_CHANGED EMIT]", {
      from: oldState,
      to: newState,
      source: "setLifecycleState",
      generation: workerGeneration,
      ts: Date.now()
    });
    log("debug", "Lifecycle state transitioned: " + oldState + " -> " + newState);
    postToHost("STATE_CHANGED", newState);
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

// ─── 3.6. WORKER PROVISIONER MODULE ─────────────────────────────────────────
/**
 * Handles atomic script provisioning on the worker side.
 *
 * Protocol:
 *   Host sends: PROVISION_BEGIN → PROVISION_CHUNK(s) → PROVISION_END
 *                              → PROVISION_WRITE → PROVISION_EXECUTE
 *   Worker replies: PROVISION_ACK for each step, PROVISION_NACK on failure.
 *
 * The script is assembled entirely in the worker from framed chunks.
 * It is written to the VM filesystem via emulator.create_file().
 * Only a single short serial command ("sh /tmp/p.sh\n") is written to ttyS0.
 * This eliminates serial flooding and PTY echo corruption entirely.
 */
var WorkerProvisioner = {
  execId: 0,
  generation: 0,
  chunks: [],
  totalExpected: 0,
  receivedCount: 0,
  active: false,
  state: "idle", // idle, assembling, validating_fs, writing, verifying, executable, executing, completed, failed

  transitionTo: function(newState) {
    log("info", "[WorkerProvisioner] FSM State: " + this.state + " -> " + newState);
    this.state = newState;
  },

  /**
   * Compute simple XOR checksum (matches provisioningProtocol.ts).
   */
  computeChecksum: function(data) {
    var cs = 0;
    for (var i = 0; i < data.length; i++) {
      cs ^= data.charCodeAt(i);
    }
    return cs;
  },

  /**
   * Begin a new provisioning session.
   */
  begin: function(payload) {
    if (this.active) {
      log("warn", "[WorkerProvisioner] PROVISION_BEGIN received while already active (execId=" + this.execId + "). Resetting.");
    }
    this.execId = payload.execId;
    this.generation = payload.generation;
    this.totalExpected = payload.totalChunks;
    this.chunks = new Array(payload.totalChunks);
    this.receivedCount = 0;
    this.active = true;
    this.transitionTo("assembling");
    log("info", "[WorkerProvisioner] Session started. execId=" + this.execId + ", totalChunks=" + this.totalExpected + ", totalBytes=" + payload.totalBytes);
  },

  /**
   * Add and validate a script chunk.
   * Returns true on success, false on validation failure.
   */
  addChunk: function(payload) {
    if (!this.active || payload.execId !== this.execId) {
      log("warn", "[WorkerProvisioner] Stale/unexpected PROVISION_CHUNK. Expected execId=" + this.execId + ", got=" + payload.execId);
      return false;
    }
    if (payload.chunkIndex < 0 || payload.chunkIndex >= this.totalExpected) {
      log("error", "[WorkerProvisioner] Chunk index out of bounds: " + payload.chunkIndex + " / " + this.totalExpected);
      return false;
    }
    // Validate checksum
    var computed = this.computeChecksum(payload.data);
    if (computed !== payload.checksum) {
      log("error", "[WorkerProvisioner] Checksum mismatch for chunk " + payload.chunkIndex + ": expected=" + payload.checksum + ", got=" + computed);
      return false;
    }
    this.chunks[payload.chunkIndex] = payload.data;
    this.receivedCount++;
    log("debug", "[WorkerProvisioner] Chunk " + payload.chunkIndex + "/" + (this.totalExpected - 1) + " received OK.");
    return true;
  },

  /**
   * Finalize: verify all chunks are present.
   */
  finalize: function(payload) {
    if (!this.active || payload.execId !== this.execId) {
      log("warn", "[WorkerProvisioner] Stale PROVISION_END received.");
      return false;
    }
    if (payload.chunkCount !== this.totalExpected) {
      log("error", "[WorkerProvisioner] PROVISION_END chunkCount mismatch: expected=" + this.totalExpected + ", got=" + payload.chunkCount);
      return false;
    }
    // Verify all slots are filled
    for (var i = 0; i < this.totalExpected; i++) {
      if (this.chunks[i] === undefined || this.chunks[i] === null) {
        log("error", "[WorkerProvisioner] Missing chunk at index " + i);
        return false;
      }
    }
    log("info", "[WorkerProvisioner] All " + this.totalExpected + " chunks received and validated.");
    return true;
  },

  /**
   * Assemble all chunks into the final script string.
   */
  assembleScript: function() {
    return this.chunks.join("");
  },

  /**
   * Helper to dynamically create parent directories in 9p filesystem.
   */
  ensureParentDirectories: function(emu, filePath) {
    var c = emu.fs9p;
    if (!c) return;

    var path = filePath.replace(/\/\/+/g, "/");
    var parts = path.split("/");
    if (parts[0] === "") {
      parts.shift();
    }
    if (parts.length > 0) {
      parts.pop(); // Remove the filename to get just directory paths
    }

    var currentId = 0; // Root directory in 9p
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === "" || part === "." || part === "..") continue;

      var nextId = c.Search(currentId, part);
      if (nextId === -1) {
        log("info", "[WorkerProvisioner] Creating directory '" + part + "' in 9p filesystem under node " + currentId);
        currentId = c.CreateDirectory(part, currentId);
      } else {
        currentId = nextId;
      }
    }
  },

  /**
   * Log comprehensive filesystem diagnostics.
   */
  logDiagnostics: function(emu, filePath) {
    var fs = emu.fs9p;
    log("info", "[WorkerProvisioner DIAGNOSTICS] Target Path: " + filePath + 
               " | Emulator Status: " + (emu ? "initialized" : "null") +
               " | Lifecycle State: " + lifecycleState +
               " | FS Ready State: " + (fs ? "mounted" : "not_mounted") +
               " | Mount Tag: host9p" +
               " | Total Mounts: " + (fs && fs.mounts ? fs.mounts.length : 0));
  },

  /**
   * Await filesystem mounting/ready status with retries.
   */
  waitAndValidateFS: async function(emu, filePath) {
    var retries = 5;
    var delay = 200;

    this.transitionTo("validating_fs");
    this.logDiagnostics(emu, filePath);

    // Barrier 1: emulator check
    if (!emu) {
      throw new Error("Emulator not initialized");
    }

    // Barrier 2: lifecycle state check
    if (lifecycleState !== "booting" && lifecycleState !== "running") {
      throw new Error("Cannot write file when lifecycleState is " + lifecycleState);
    }

    // Barrier 3: fs9p readiness check with retry loop
    for (var i = 0; i < retries; i++) {
      if (emu.fs9p && typeof emu.create_file === "function") {
        log("info", "[WorkerProvisioner] Filesystem ready on attempt " + (i + 1));
        return true;
      }
      log("warn", "[WorkerProvisioner] Filesystem not ready. Retrying in " + delay + "ms... (attempt " + (i + 1) + "/" + retries + ")");
      await new Promise(function(resolve) { setTimeout(resolve, delay); });
    }

    // Diagnostics if it failed
    this.logDiagnostics(emu, filePath);
    if (!emu.fs9p) {
      throw new Error("fs9p (9p filesystem layer) is not initialized on emulator");
    }
    if (typeof emu.create_file !== "function") {
      throw new Error("emulator.create_file() function is missing");
    }
  },

  /**
   * Write the assembled script to the VM filesystem using create_file() with validation.
   */
  writeFile: async function(emu, filePath) {
    var startTime = Date.now();
    await this.waitAndValidateFS(emu, filePath);

    this.transitionTo("writing");
    this.ensureParentDirectories(emu, filePath);

    var script = this.assembleScript();
    log("info", "[WorkerProvisioner] Writing " + script.length + " bytes to " + filePath + " via create_file()");

    var encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    var bytes;
    if (encoder) {
      bytes = encoder.encode(script);
    } else {
      bytes = new Uint8Array(script.length);
      for (var i = 0; i < script.length; i++) {
        bytes[i] = script.charCodeAt(i) & 0xFF;
      }
    }

    await emu.create_file(filePath, bytes);
    
    // Integrity verification FSM step
    this.transitionTo("verifying");
    var fs = emu.fs9p;
    var search = fs.SearchPath(filePath);
    
    if (search.id === -1) {
      throw new Error("Verification failed: File not found in 9p filesystem after write");
    }
    
    var inode = fs.GetInode(search.id);
    if (inode.size !== bytes.length) {
      throw new Error("Verification failed: File size mismatch. Wrote " + bytes.length + ", got " + inode.size);
    }

    // Try reading it back to verify readability
    var readData = await emu.read_file(filePath);
    if (!readData || readData.length !== bytes.length) {
      throw new Error("Verification failed: File could not be read back or length mismatch");
    }

    this.transitionTo("executable");
    var writeLatency = Date.now() - startTime;
    log("info", "[WorkerProvisioner] File write verified successfully. Latency: " + writeLatency + "ms");

    // Return structured telemetry
    return {
      fsReadyTimestamp: startTime,
      writeLatencyMs: writeLatency,
      filePath: filePath,
      fileSize: bytes.length,
      verified: true
    };
  },

  /**
   * Write a binary blob directly to the VM filesystem with validation.
   */
  writeBinaryFile: async function(emu, filePath, data) {
    var startTime = Date.now();
    await this.waitAndValidateFS(emu, filePath);

    this.transitionTo("writing");
    this.ensureParentDirectories(emu, filePath);

    log("info", "[WorkerProvisioner] Writing binary blob of " + data.byteLength + " bytes to " + filePath + " via create_file()");
    await emu.create_file(filePath, data);

    // Verify
    this.transitionTo("verifying");
    var fs = emu.fs9p;
    var search = fs.SearchPath(filePath);
    if (search.id === -1) {
      throw new Error("Verification failed: Binary file not found in 9p filesystem after write");
    }

    var inode = fs.GetInode(search.id);
    if (inode.size !== data.byteLength) {
      throw new Error("Verification failed: Binary file size mismatch. Wrote " + data.byteLength + ", got " + inode.size);
    }

    this.transitionTo("executable");
    var writeLatency = Date.now() - startTime;
    log("info", "[WorkerProvisioner] Binary file write verified successfully. Latency: " + writeLatency + "ms");
  },

  /**
   * Cancel the current provisioning session.
   */
  cancel: function() {
    log("info", "[WorkerProvisioner] Provisioning cancelled for execId=" + this.execId);
    this.chunks = [];
    this.active = false;
    this.receivedCount = 0;
    this.totalExpected = 0;
    this.execId = 0;
    this.transitionTo("idle");
  }
};


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
      postToHost("SERIAL1_OUT", byte);
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
  
  console.log("[WORKER MESSAGE RECEIVED]", data);

  var type = data.type;
  var payload = data.payload;
  var gen = data.generation;

  if (gen !== undefined) {
    workerGeneration = gen;
  }

  switch (type) {
    case "INIT":
      console.log("[WORKER INIT RECEIVED]", {
        generation: workerGeneration,
        runtimeState: payload.initial_state ? "restoring" : "cold_boot",
        workerState: lifecycleState,
        ts: Date.now()
      });
      console.log("[INIT START]", {
        generation: workerGeneration,
        runtimeState: payload.initial_state ? "restoring" : "cold_boot",
        workerState: lifecycleState,
        ts: Date.now()
      });
      // Acknowledge receipt of INIT configuration immediately
      postToHost("INIT_ACK", {
        generation: workerGeneration,
        ts: Date.now()
      });
      if (!canInitialize() || isBootingInProgress) {
        log("warn", "Ignored INIT: emulator already initializing or running (state: " + lifecycleState + ")");
        return;
      }
      isBootingInProgress = true;
      try {
        await handleInit(payload);
        console.log("[INIT COMPLETE]", {
          generation: workerGeneration,
          ts: Date.now()
        });
      } catch (err) {
        log("error", "Uncaught exception in handleInit: " + (err.message || String(err)));
        postToHost("INIT_FAILURE", "Uncaught exception in handleInit: " + (err.message || String(err)));
      } finally {
        isBootingInProgress = false;
      }
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
      if (lifecycleState === "initialized" || lifecycleState === "booting" || lifecycleState === "provisioning" || lifecycleState === "shell_ready" || lifecycleState === "terminal_ready") {
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
      postToHost("PONG", { cpu_running: cpuRunning });
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
        postToHost("SAVE_STATE_FAILURE", "Emulator not initialized");
        break;
      }
      try {
        log("info", "Taking guest VM memory snapshot...");
        var state = await emulator.save_state();
        postToHost("SAVE_STATE_SUCCESS", state, [state]);
        log("info", "Guest VM snapshot taken successfully.");
      } catch (err) {
        log("error", "Failed to save VM state: " + (err.message || String(err)));
        postToHost("SAVE_STATE_FAILURE", err.message || String(err));
      }
      break;

    case "DESTROY":
      log("info", "Destroying emulator worker context...");
      setLifecycleState("destroyed");
      await destroyEmulator();
      self.close();
      break;

    // ── Provisioning Protocol Handlers ───────────────────────────────────────
    // These messages travel over the host↔worker message bus, NOT serial.
    // They implement atomic file transfer to replace base64 serial injection.

    case "PROVISION_BEGIN":
      WorkerProvisioner.begin(payload);
      postToHost("PROVISION_ACK", { type: "begin", execId: payload.execId });
      break;

    case "PROVISION_CHUNK": {
      var chunkOk = WorkerProvisioner.addChunk(payload);
      if (chunkOk) {
        postToHost("PROVISION_ACK", { type: "chunk", execId: payload.execId, chunkIndex: payload.chunkIndex });
      } else {
        log("error", "[WorkerProvisioner] Chunk validation failed for index=" + payload.chunkIndex);
        postToHost("PROVISION_NACK", { execId: payload.execId, chunkIndex: payload.chunkIndex, reason: "checksum_mismatch" });
      }
      break;
    }

    case "PROVISION_END": {
      var endOk = WorkerProvisioner.finalize(payload);
      if (endOk) {
        postToHost("PROVISION_ACK", { type: "end", execId: payload.execId });
      } else {
        postToHost("PROVISION_NACK", { execId: payload.execId, reason: "assembly_incomplete" });
        WorkerProvisioner.cancel();
      }
      break;
    }

    case "PROVISION_WRITE": {
      // Write the assembled script to the VM filesystem via create_file().
      // This is the key step that replaces base64 serial injection.
      var writeExecId = payload.execId;
      var writeFilePath = payload.filePath;
      try {
        var telemetry = await WorkerProvisioner.writeFile(emulator, writeFilePath);
        postToHost("PROVISION_READY", {
          execId: writeExecId,
          generation: payload.generation,
          filePath: writeFilePath,
          telemetry: telemetry
        });
      } catch (writeErr) {
        log("error", "[WorkerProvisioner] create_file() failed: " + (writeErr.message || String(writeErr)));
        postToHost("PROVISION_NACK", {
          execId: writeExecId,
          reason: "write_failed: " + (writeErr.message || String(writeErr))
        });
        WorkerProvisioner.cancel();
      }
      break;
    }

    case "PROVISION_WRITE_BINARY": {
      // Write the user home backup blob directly to the VM filesystem.
      // payload.data is a Uint8Array transferred via structured clone (no base64).
      var binaryExecId = payload.execId;
      var binaryFilePath = payload.filePath;
      var binaryData = payload.data; // Uint8Array
      try {
        await WorkerProvisioner.writeBinaryFile(emulator, binaryFilePath, binaryData);
        postToHost("PROVISION_ACK", {
          type: "write_binary",
          execId: binaryExecId,
          filePath: binaryFilePath
        });
      } catch (binErr) {
        log("error", "[WorkerProvisioner] Binary create_file() failed: " + (binErr.message || String(binErr)));
        postToHost("PROVISION_NACK", {
          execId: binaryExecId,
          reason: "binary_write_failed: " + (binErr.message || String(binErr))
        });
      }
      break;
    }

    case "PROVISION_EXECUTE": {
      // Send a single short serial command to trigger script execution.
      // This is the ONLY serial write during the entire provisioning flow.
      var execFilePath = payload.filePath;
      var execExecId = payload.execId;
      log("info", "[WorkerProvisioner] Triggering script execution via serial: sh " + execFilePath);
      WorkerProvisioner.transitionTo("executing");
      
      // Build a robust trigger command: mount virtio-9p, copy script locally, and run
      var triggerCmd = 
        "stty -echo\n" +
        "mkdir -p /mnt/9p /tmp\n" +
        "mount -t 9p host9p /mnt/9p -o trans=virtio,version=9p2000.L 2>/dev/null\n" +
        "cp /mnt/9p" + execFilePath + " " + execFilePath + " 2>/dev/null\n" +
        "cp /mnt/9p/tmp/fs.tar.gz /tmp/fs.tar.gz 2>/dev/null\n" +
        "chmod +x " + execFilePath + " 2>/dev/null\n" +
        "sh " + execFilePath + "\n";

      var sent = SerialChannelManager.send(0, triggerCmd);
      if (sent) {
        postToHost("PROVISION_ACK", { type: "execute", execId: execExecId });
      } else {
        postToHost("PROVISION_NACK", { execId: execExecId, reason: "serial_send_failed" });
        WorkerProvisioner.transitionTo("failed");
      }
      break;
    }

    case "PROVISION_CANCEL":
      WorkerProvisioner.cancel();
      postToHost("PROVISION_ACK", { type: "cancel", execId: payload ? payload.execId : 0 });
      break;

    default:
      log("warn", "Unknown message type received: " + type);
  }
};
console.log("[WORKER ONMESSAGE REGISTERED]");

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
    postToHost("INIT_FAILURE", msg);
    return;
  }

  if (typeof V86 === "undefined") {
    var errMsg = "V86 constructor not found after importScripts";
    log("error", errMsg);
    setLifecycleState("failed");
    postToHost("INIT_FAILURE", errMsg);
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
      // filesystem:{} enables the 9p virtual filesystem, which is required for
      // create_file() to work. Without this the fs9p field on the emulator is null.
      filesystem: { baseurl: "", basefs: "" },
      autostart: true,
      cmdline: payload.cmdline || "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
      memory_size: payload.memory_size || 64 * 1024 * 1024,
      vga_memory_size: payload.vga_memory_size || 8 * 1024 * 1024
    };

    // Step 4: Create emulator
    log("info", "Step 4/4: Creating v86 emulator instance...");
    await createEmulator(config, self);

    postToHost("INIT_SUCCESS", {
      hasSerial1: !!(SerialChannelManager.ports['1'] && SerialChannelManager.ports['1'].ready)
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
    postToHost("INIT_FAILURE", initErr);
  }
}

// Post message that the worker script is fully loaded and ready to accept commands
console.log("[WORKER HANDSHAKE EMITTED]");
postToHost("WORKER_READY");
