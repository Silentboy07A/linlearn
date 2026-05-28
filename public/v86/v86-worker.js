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
var workerTerminating = false;
var activeEmulatorInstances = new Set();

// Wrap timers for clean teardown tracking
var activeTimeouts = new Set();
var activeIntervals = new Set();

var originalSetTimeout = self.setTimeout;
var originalClearTimeout = self.clearTimeout;
var originalSetInterval = self.setInterval;
var originalClearInterval = self.clearInterval;

self.setTimeout = function(callback, delay, ...args) {
  var id;
  var wrappedCallback = function() {
    activeTimeouts.delete(id);
    if (workerTerminating) return;
    callback(...args);
  };
  id = originalSetTimeout(wrappedCallback, delay);
  activeTimeouts.add(id);
  return id;
};

self.clearTimeout = function(id) {
  activeTimeouts.delete(id);
  originalClearTimeout(id);
};

self.setInterval = function(callback, delay, ...args) {
  var id;
  var wrappedCallback = function() {
    if (workerTerminating) {
      originalClearInterval(id);
      activeIntervals.delete(id);
      return;
    }
    callback(...args);
  };
  id = originalSetInterval(wrappedCallback, delay);
  activeIntervals.add(id);
  return id;
};

self.clearInterval = function(id) {
  activeIntervals.delete(id);
  originalClearInterval(id);
};

function clearAllTrackedTimers() {
  if (typeof log === "function") {
    log("info", "Clearing all tracked timers: " + activeTimeouts.size + " timeouts, " + activeIntervals.size + " intervals");
  } else {
    console.log("Clearing all tracked timers: " + activeTimeouts.size + " timeouts, " + activeIntervals.size + " intervals");
  }
  for (var id of activeTimeouts) {
    originalClearTimeout(id);
  }
  activeTimeouts.clear();
  for (var id of activeIntervals) {
    originalClearInterval(id);
  }
  activeIntervals.clear();
}

/**
 * Post a message back to the main thread, automatically attaching the active generation ID.
 * @param {string} type
 * @param {any} [payload]
 * @param {any[]} [transferables]
 */
function postToHost(type, payload, transferables) {
  if (workerTerminating) {
    console.warn("[WORKER MESSAGE DROPPED (TERMINATING)]", type);
    return;
  }
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
    var stateOrder = ["idle", "loading", "booting", "provision_preparing", "provisioning", "shell_ready", "terminal_ready", "ready"];
    var currentIndex = stateOrder.indexOf(lifecycleState);
    var targetIndex = stateOrder.indexOf(newState);
    if (currentIndex !== -1 && targetIndex !== -1 && targetIndex < currentIndex) {
      log("warn", "[TRANSITION BLOCKED] Dropped backward transition: " + lifecycleState + " -> " + newState);
      return;
    }

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
  return lifecycleState === "booting" || lifecycleState === "provision_preparing" || lifecycleState === "provisioning" || lifecycleState === "shell_ready" || lifecycleState === "terminal_ready" || lifecycleState === "ready";
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
/**
 * Filesystem Access Policy Engine
 * Coordinates filesystem permissions based on lifecycleState, operation source,
 * operation type, and execution context.
 */
var FilesystemAccessPolicy = {
  // Sources
  SOURCES: {
    USER_TERMINAL: "USER_TERMINAL",
    PROVISIONING_SYSTEM: "PROVISIONING_SYSTEM",
    RECOVERY_SYSTEM: "RECOVERY_SYSTEM",
    INTERNAL_RUNTIME: "INTERNAL_RUNTIME"
  },

  // Operation Types
  OPERATIONS: {
    WRITE_FILE: "WRITE_FILE",
    WRITE_BINARY: "WRITE_BINARY",
    CREATE_DIR: "CREATE_DIR",
    DELETE_FILE: "DELETE_FILE",
    READ_FILE: "READ_FILE"
  },

  /**
   * Determine if a filesystem operation is allowed under the current policy.
   * @param {{
   *   lifecycleState: string,
   *   source: string,
   *   operationType: string,
   *   filePath: string
   * }} params
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkPermission: function(params) {
    var state = params.lifecycleState;
    var source = params.source;
    var opType = params.operationType;
    var path = params.filePath;

    // Telemetry log for write policy audit
    log("info", "[FilesystemAccessPolicy] Audit: source=" + source +
               " | op=" + opType +
               " | state=" + state +
               " | path=" + path);

    // Rule 1: Trusted Internal Operations Bypass (PROVISIONING_SYSTEM, RECOVERY_SYSTEM, INTERNAL_RUNTIME)
    // Allowed during: booting, provision_preparing, provisioning, shell_ready, terminal_ready, and ready.
    if (source === this.SOURCES.PROVISIONING_SYSTEM || 
        source === this.SOURCES.RECOVERY_SYSTEM || 
        source === this.SOURCES.INTERNAL_RUNTIME) {
      if (state === "booting" || state === "provision_preparing" || state === "provisioning" || state === "shell_ready" || state === "terminal_ready" || state === "ready") {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Trusted internal write denied in inactive lifecycle state: " + state
      };
    }

    // Rule 2: User interactive writes (USER_TERMINAL)
    // Only allowed during "ready" (standard VM operation).
    if (source === this.SOURCES.USER_TERMINAL) {
      if (state === "ready") {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "User write denied in non-ready lifecycle state: " + state
      };
    }

    // Policy default: Deny
    return {
      allowed: false,
      reason: "Access denied: Unknown or untrusted operation source '" + source + "'"
    };
  }
};

var WorkerProvisioner = {
  execId: 0,
  generation: 0,
  chunks: [],
  totalExpected: 0,
  receivedCount: 0,
  active: false,
  state: "idle", // idle, assembling, validating_fs, writing, verifying, executable, executing, completed, failed
  registeredHelpers: {},

  transitionTo: function(newState) {
    log("info", "[WorkerProvisioner] FSM State: " + this.state + " -> " + newState);
    this.state = newState;
  },

  verifyExecId: function(execId) {
    if (execId < this.execId) {
      log("warn", "[WorkerProvisioner] Rejected stale message: message execId (" + execId + ") < active execId (" + this.execId + ")");
      return false;
    }
    if (execId > this.execId) {
      log("info", "[WorkerProvisioner] Monotonic execId progression: active " + this.execId + " -> " + execId + ". Resetting transfer assembly state.");
      this.execId = execId;
      this.chunks = [];
      this.receivedCount = 0;
      this.totalExpected = 0;
      this.active = false;
      this.state = "idle";
      this.registeredHelpers = {};
    }
    return true;
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
   * Compute SHA-256 hash of a Uint8Array.
   */
  computeSHA256: async function(bytes) {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      try {
        var hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
        var hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
      } catch (e) {
        log("warn", "[WorkerProvisioner] Subtle Crypto digest failed: " + e.message);
      }
    }
    // Fallback: simple checksum converted to hex
    var cs = 0;
    for (var i = 0; i < bytes.length; i++) {
      cs ^= bytes[i];
    }
    return cs.toString(16);
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
    this.registeredHelpers = {};
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
   * Await filesystem mounting/ready status with retries and policy checks.
   */
  waitAndValidateFS: async function(emu, filePath, source, operationType) {
    var retries = 5;
    var delay = 200;

    this.transitionTo("validating_fs");
    this.logDiagnostics(emu, filePath);

    // 1. Filesystem access policy check
    var policyResult = FilesystemAccessPolicy.checkPermission({
      lifecycleState: lifecycleState,
      source: source || FilesystemAccessPolicy.SOURCES.INTERNAL_RUNTIME,
      operationType: operationType || FilesystemAccessPolicy.OPERATIONS.WRITE_FILE,
      filePath: filePath
    });

    if (!policyResult.allowed) {
      var deniedMsg = "Lifecycle permission denied: " + policyResult.reason + 
                      " (state: " + lifecycleState + 
                      ", source: " + source + 
                      ", op: " + operationType + 
                      ", path: " + filePath + ")";
      log("error", "[WorkerProvisioner] " + deniedMsg);
      throw new Error(deniedMsg);
    }

    // 2. Barrier: emulator check
    if (!emu) {
      throw new Error("Emulator not initialized");
    }

    // 3. Barrier: fs9p readiness check with retry loop
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

    this.transitionTo("writing");
    this.ensureParentDirectories(emu, filePath);

    var fs = emu.fs9p;
    if (!fs) {
      throw new Error("fs9p is not initialized on emulator");
    }

    // Verify parent directory exists on host/worker side
    var parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
    var parentSearch = fs.SearchPath(parentDir);
    if (parentSearch.id === -1) {
      throw new Error("Verification failed: Parent directory " + parentDir + " not created in 9p filesystem");
    }

    await this.waitAndValidateFS(
      emu, 
      filePath + ".tmp", 
      FilesystemAccessPolicy.SOURCES.PROVISIONING_SYSTEM, 
      FilesystemAccessPolicy.OPERATIONS.WRITE_FILE
    );

    var script = this.assembleScript();
    var encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    var unframedBytes;
    if (encoder) {
      unframedBytes = encoder.encode(script);
    } else {
      unframedBytes = new Uint8Array(script.length);
      for (var i = 0; i < script.length; i++) {
        unframedBytes[i] = script.charCodeAt(i) & 0xFF;
      }
    }

    // Compute SHA-256 hash for guest-side integrity check (unframed payload)
    var sha256 = await this.computeSHA256(unframedBytes);
    log("info", "[WorkerProvisioner] Computed SHA-256 for assembly: " + sha256);

    // Frame the payload
    var framedPayload = "BEGIN_SCRIPT:" + script.length + ":" + sha256 + "\n" + script + "\nEND_SCRIPT\n";
    log("info", "[WorkerProvisioner] Writing " + framedPayload.length + " bytes of framed payload to " + filePath + ".tmp via create_file()");

    var bytes;
    if (encoder) {
      bytes = encoder.encode(framedPayload);
    } else {
      bytes = new Uint8Array(framedPayload.length);
      for (var i = 0; i < framedPayload.length; i++) {
        bytes[i] = framedPayload.charCodeAt(i) & 0xFF;
      }
    }

    await emu.create_file(filePath + ".tmp", bytes);

    // Worker-side filesystem integrity verification
    this.transitionTo("verifying");
    var search = fs.SearchPath(filePath + ".tmp");
    
    if (search.id === -1) {
      throw new Error("Verification failed: Temp file not found in 9p filesystem after write");
    }
    
    var inode = fs.GetInode(search.id);
    if (inode.size !== bytes.length) {
      throw new Error("Verification failed: Temp file size mismatch. Wrote " + bytes.length + ", got " + inode.size);
    }

    // Try reading it back to verify readability
    var readData = await emu.read_file(filePath + ".tmp");
    if (!readData || readData.length !== bytes.length) {
      throw new Error("Verification failed: Temp file could not be read back or length mismatch");
    }

    log("info", "[WorkerProvisioner] WorkerFS write verified. Size: " + bytes.length + " bytes. Latency: " + (Date.now() - startTime) + "ms");

    // FS propagation delay: give virtio-9p driver time to sync the inode
    // to the guest namespace before the visibility probe runs.
    log("info", "[WorkerProvisioner] Waiting 500ms for 9p FS propagation to guest namespace...");
    await new Promise(function(r) { setTimeout(r, 500); });

    // Pre-write all FSM helper scripts before starting the MountVisibilityFSM.
    // This ensures doMount(), doVerify(), doRemount(), and doDiagnostics() can
    // dispatch via short single-line tty commands ("sh /root/.provision/prov_XXX_N.sh")
    // instead of inline compound shell programs that trigger PS2 continuation deadlocks.
    log("info", "[WorkerProvisioner] Pre-writing FSM helper scripts via create_file()...");
    await this.prepareHelperScripts(emu, this.execId, filePath + ".tmp", sha256, script.length, this.totalExpected);

    // Guest namespace synchronization & verification step
    var guestVerification = await this.verifyGuestVisibility(emu, filePath, this.execId);

    
    this.transitionTo("executable");
    var writeLatency = Date.now() - startTime;
    log("info", "[WorkerProvisioner DIAGNOSTICS] WorkerFS File exists: true | GuestFS File exists: " + guestVerification.visible + " | Latency: " + writeLatency + "ms");

    // Return structured telemetry
    return {
      fsReadyTimestamp: startTime,
      writeLatencyMs: writeLatency,
      filePath: filePath,
      fileSize: bytes.length,
      verified: true,
      guestVisible: guestVerification.visible,
      fallbackRequired: !guestVerification.visible,
      mountSuccess: guestVerification.telemetry ? guestVerification.telemetry.mountSuccess : false,
      propagationLatencyMs: guestVerification.telemetry ? guestVerification.telemetry.propagationLatencyMs : -1,
      retryCount: guestVerification.telemetry ? guestVerification.telemetry.retryCount : 0,
      guestVisibilityTimingMs: guestVerification.telemetry ? guestVerification.telemetry.guestVisibilityTimingMs : -1,
      remountAttempts: guestVerification.telemetry ? guestVerification.telemetry.remountAttempts : 0,
      verifiedInode: guestVerification.inode
    };
  },

  /**
   * Strip ANSI escape codes and carriage returns from a string.
   */
  sanitizeSerialOutput: function(str) {
    var ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    var cleaned = str.replace(ansiRegex, "");
    cleaned = cleaned.replace(/\r/g, "");
    return cleaned;
  },

  /**
   * MountVisibilityFSM — deterministic 9p mount, verify, and retry state machine.
   *
   * States: MOUNTING -> VERIFYING -> RETRY_VERIFY -> REMOUNT -> VERIFIED | FALLBACK
   *
   * Rules:
   *  - Check /proc/mounts first; skip mount if already mounted.
   *  - Retry verification up to MAX_VERIFY_RETRIES times before trying remount.
   *  - Remount once (unmount + mount) before declaring FALLBACK.
   *  - Log mount latency, verify retry count, propagation timing.
   *  - On verify failure: dump /proc/mounts, ls /mnt/9p, stat <file> for diagnostics.
   *
   * Always resolves — never rejects. Returns { visible: bool, elapsedMs: number }.
   */
  /**
   * Prepare FSM helper scripts by writing them to the VM filesystem via create_file().
   * These scripts replace long inline shell one-liners sent over the interactive tty.
   * Each script is short, self-contained, and emits a single FSM marker to /dev/ttyS0.
   * The tty then only receives: "sh /root/.provision/prov_XXX_N.sh\n" (one short line).
   */
  prepareHelperScripts: async function(emu, execId, filePath, sha256, scriptSize, totalChunks) {
    var base = "/root/.provision";
    var encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

    function encode(s) {
      if (encoder) return encoder.encode(s);
      var b = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xFF;
      return b;
    }

    function makeTag(state, result) {
      return "<<<FSM:" + execId + ":" + state + ":" + result + ">>>";
    }

    // ── Mount script ───────────────────────────────────────────────────────────
    // Mounts host9p at /mnt/9p and emits OK or ERR marker.
    var mountScript =
      "#!/bin/sh\n" +
      "set -x\n" +
      "echo \"[STAGE] mount_verify\" > /dev/ttyS0\n" +
      "stty -echo > /dev/null 2>&1\n" +
      "trap 'echo \"[PROVISION_ERROR] line=$LINENO exit=$?\" > /dev/ttyS0' ERR\n" +
      "# Check kernel 9p filesystem support\n" +
      "b_i=0; b_ok=0\n" +
      "while [ \"$b_i\" -lt 30 ]; do\n" +
      "  if [ -f /proc/filesystems ] && grep -q 9p /proc/filesystems && [ -f /proc/mounts ]; then\n" +
      "    b_ok=1; break\n" +
      "  fi\n" +
      "  sleep 1; b_i=$((b_i + 1))\n" +
      "done\n" +
      "if [ \"$b_ok\" -eq 0 ]; then\n" +
      "  echo '" + makeTag("MOUNTING", "ERR") + "' > /dev/ttyS0; exit 1\n" +
      "fi\n" +
      "# Mount if not already mounted\n" +
      "mkdir -p /mnt/9p /root/.provision > /dev/null 2>&1\n" +
      "if ! grep -q host9p /proc/mounts 2>/dev/null; then\n" +
      "  mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/9p 2>/dev/null ||\n" +
      "  mount -t 9p -o trans=virtio host9p /mnt/9p 2>/dev/null ||\n" +
      "  mount -t 9p host9p /mnt/9p 2>/dev/null\n" +
      "fi\n" +
      "# Symlink setup\n" +
      "rm -rf /root/.provision && ln -s /mnt/9p/root/.provision /root/.provision\n" +
      "sync\n" +
      "if [ -d /root/.provision ]; then\n" +
      "  echo '" + makeTag("MOUNTING", "OK") + "' > /dev/ttyS0\n" +
      "else\n" +
      "  echo '" + makeTag("MOUNTING", "ERR") + "' > /dev/ttyS0\n" +
      "fi\n" +
      "trap - ERR\n";

    // ── Verify script ──────────────────────────────────────────────────────────
    // Checks that the provisioning file exists and is readable; emits VIS or NOVIS.
    var fp = filePath;
    var verifyScript =
      "#!/bin/sh\n" +
      "set -x\n" +
      "echo \"[STAGE] transfer_verify\" > /dev/ttyS0\n" +
      "stty -echo > /dev/null 2>&1\n" +
      "trap 'echo \"[PROVISION_ERROR] line=$LINENO exit=$?\" > /dev/ttyS0' ERR\n" +
      "sync\n" +
      "echo 3 > /proc/sys/vm/drop_caches 2>/dev/null\n" +
      "i=0; ok=0; inode=; size=;\n" +
      "while [ \"$i\" -lt 10 ]; do\n" +
      "  if [ -f '" + fp + "' ] && stat '" + fp + "' > /dev/null 2>&1; then\n" +
      "    inode=$(ls -i '" + fp + "' 2>/dev/null | awk '{print $1}')\n" +
      "    size=$(wc -c < '" + fp + "' 2>/dev/null)\n" +
      "    if [ -n \"$inode\" ] && [ -n \"$size\" ] && [ \"$size\" -gt 0 ]; then\n" +
      "      ok=1; break;\n" +
      "    fi\n" +
      "  fi\n" +
      "  sleep 1\n" +
      "  i=$((i + 1))\n" +
      "done\n" +
      "echo '[VERIFY:STAT]' > /dev/ttyS0; stat '" + fp + "' > /dev/ttyS0 2>/dev/null || echo 'stat-failed' > /dev/ttyS0\n" +
      "echo '[VERIFY:LS]' > /dev/ttyS0; ls -l '" + fp + "' > /dev/ttyS0 2>/dev/null || echo 'ls-failed' > /dev/ttyS0\n" +
      "echo '[VERIFY:MODE]' > /dev/ttyS0; ls -l '" + fp + "' > /dev/ttyS0 2>/dev/null || echo 'mode-failed' > /dev/ttyS0\n" +
      "if [ \"$ok\" -eq 1 ]; then\n" +
      "  actual_sha=$(sha256sum '" + fp + "' 2>/dev/null | awk '{print $1}')\n" +
      "  if [ -n \"$actual_sha\" ] && [ \"$actual_sha\" = \"" + sha256 + "\" ]; then\n" +
      "    echo '" + makeTag("VERIFYING", "VIS") + "':\"$inode\" > /dev/ttyS0\n" +
      "  elif [ -z \"$actual_sha\" ]; then\n" +
      "    # Fallback if sha256sum not available on guest\n" +
      "    echo '" + makeTag("VERIFYING", "VIS") + "':\"$inode\" > /dev/ttyS0\n" +
      "  else\n" +
      "    echo '[VERIFY:HASH_MISMATCH] expected=" + sha256 + " got='$actual_sha > /dev/ttyS0\n" +
      "    echo '" + makeTag("VERIFYING", "NOVIS") + "' > /dev/ttyS0\n" +
      "  fi\n" +
      "else\n" +
      "  echo '" + makeTag("VERIFYING", "NOVIS") + "' > /dev/ttyS0\n" +
      "fi\n" +
      "trap - ERR\n";

    // ── Remount script ─────────────────────────────────────────────────────────
    // Unmounts and remounts host9p, then emits OK or ERR.
    var remountScript =
      "#!/bin/sh\n" +
      "set -x\n" +
      "stty -echo > /dev/null 2>&1\n" +
      "trap 'echo \"[PROVISION_ERROR] line=$LINENO exit=$?\" > /dev/ttyS0' ERR\n" +
      "umount -f /mnt/9p > /dev/null 2>&1; umount /mnt/9p > /dev/null 2>&1\n" +
      "mkdir -p /mnt/9p > /dev/null 2>&1\n" +
      "if mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/9p 2>/dev/null ||\n" +
      "   mount -t 9p -o trans=virtio host9p /mnt/9p 2>/dev/null ||\n" +
      "   mount -t 9p host9p /mnt/9p 2>/dev/null; then\n" +
      "  rm -rf /root/.provision && ln -s /mnt/9p/root/.provision /root/.provision\n" +
      "  sync\n" +
      "  if [ -d /root/.provision ]; then\n" +
      "    echo '" + makeTag("REMOUNT", "OK") + "' > /dev/ttyS0\n" +
      "  else\n" +
      "    echo '" + makeTag("REMOUNT", "ERR") + "' > /dev/ttyS0\n" +
      "  fi\n" +
      "else\n" +
      "  echo '" + makeTag("REMOUNT", "ERR") + "' > /dev/ttyS0\n" +
      "fi\n" +
      "trap - ERR\n";

    // ── Diagnostics script ─────────────────────────────────────────────────────
    var diagScript =
      "#!/bin/sh\n" +
      "set -x\n" +
      "stty -echo > /dev/null 2>&1\n" +
      "trap 'echo \"[PROVISION_ERROR] line=$LINENO exit=$?\" > /dev/ttyS0' ERR\n" +
      "echo '[DIAG:MOUNT]' > /dev/ttyS0\n" +
      "mount 2>/dev/null > /dev/ttyS0 || echo 'mount-failed' > /dev/ttyS0\n" +
      "echo '[DIAG:MOUNTPATH]' > /dev/ttyS0\n" +
      "grep host9p /proc/mounts > /dev/ttyS0 2>/dev/null || echo 'not-mounted' > /dev/ttyS0\n" +
      "echo '[DIAG:DF]' > /dev/ttyS0\n" +
      "df 2>/dev/null > /dev/ttyS0 || echo 'df-failed' > /dev/ttyS0\n" +
      "echo '[DIAG:LS]' > /dev/ttyS0\n" +
      "ls -la /mnt/9p 2>/dev/null > /dev/ttyS0 || echo 'ls-failed' > /dev/ttyS0\n" +
      "echo '[DIAG:LS_PROVISION]' > /dev/ttyS0\n" +
      "ls -la /root/.provision 2>/dev/null > /dev/ttyS0 || echo 'ls-failed' > /dev/ttyS0\n" +
      "echo '[DIAG:STAT]' > /dev/ttyS0\n" +
      "stat '" + fp + "' 2>/dev/null > /dev/ttyS0 || echo 'stat-failed' > /dev/ttyS0\n" +
      "echo '[DIAG:MODE]' > /dev/ttyS0\n" +
      "ls -l '" + fp + "' 2>/dev/null > /dev/ttyS0 || echo 'mode-failed' > /dev/ttyS0\n" +
      "echo '<<<FSM:" + execId + ":DIAGNOSTICS:DONE>>>' > /dev/ttyS0\n" +
      "trap - ERR\n";

    // ── Revalidation script ────────────────────────────────────────────────────
    var okMarkerPrefix = "<<<EXEC_REVAL:" + execId + ":OK>>>";
    var failMarker = "<<<EXEC_REVAL:" + execId + ":FAIL>>>";
    var revalScript =
      "#!/bin/sh\n" +
      "set -x\n" +
      "stty -echo > /dev/null 2>&1\n" +
      "trap 'echo \"[PROVISION_ERROR] line=$LINENO exit=$?\" > /dev/ttyS0' ERR\n" +
      "sync\n" +
      "echo 3 > /proc/sys/vm/drop_caches 2>/dev/null\n" +
      "echo '[EXEC_DIAG:PWD]' > /dev/ttyS0; pwd > /dev/ttyS0\n" +
      "echo '[EXEC_DIAG:MOUNTS]' > /dev/ttyS0\n" +
      "cat /proc/mounts > /dev/ttyS0 2>/dev/null || echo none > /dev/ttyS0\n" +
      "echo '[EXEC_DIAG:LSPROVISION]' > /dev/ttyS0\n" +
      "ls -la /root/.provision > /dev/ttyS0 2>/dev/null || echo 'ls-failed' > /dev/ttyS0\n" +
      "echo '[EXEC_DIAG:STAT]' > /dev/ttyS0\n" +
      "stat '" + fp + "' > /dev/ttyS0 2>/dev/null || echo 'stat-failed' > /dev/ttyS0\n" +
      "echo '[EXEC_DIAG:MODE]' > /dev/ttyS0\n" +
      "ls -l '" + fp + "' > /dev/ttyS0 2>/dev/null || echo 'mode-failed' > /dev/ttyS0\n" +
      "echo '[EXEC_DIAG:LS]' > /dev/ttyS0; ls -l '" + fp + "' > /dev/ttyS0 2>/dev/null || echo 'ls-failed' > /dev/ttyS0\n" +
      "if [ -f '" + fp + "' ] && stat '" + fp + "' > /dev/null 2>&1; then\n" +
      "  actual_sha=$(sha256sum '" + fp + "' 2>/dev/null | awk '{print $1}')\n" +
      "  if [ -n \"$actual_sha\" ] && [ \"$actual_sha\" = \"" + sha256 + "\" ]; then\n" +
      "    inode=$(ls -i '" + fp + "' 2>/dev/null | awk '{print $1}' || echo unknown)\n" +
      "    echo '" + okMarkerPrefix + "':\"$inode\" > /dev/ttyS0\n" +
      "  elif [ -z \"$actual_sha\" ]; then\n" +
      "    inode=$(ls -i '" + fp + "' 2>/dev/null | awk '{print $1}' || echo unknown)\n" +
      "    echo '" + okMarkerPrefix + "':\"$inode\" > /dev/ttyS0\n" +
      "  else\n" +
      "    echo '[EXEC_DIAG:HASH_MISMATCH] expected=" + sha256 + " got='$actual_sha > /dev/ttyS0\n" +
      "    echo '" + failMarker + "' > /dev/ttyS0\n" +
      "  fi\n" +
      "else\n" +
      "  sleep 1\n" +
      "  if [ -f '" + fp + "' ] && stat '" + fp + "' > /dev/null 2>&1; then\n" +
      "    actual_sha=$(sha256sum '" + fp + "' 2>/dev/null | awk '{print $1}')\n" +
      "    if [ -n \"$actual_sha\" ] && [ \"$actual_sha\" = \"" + sha256 + "\" ]; then\n" +
      "      inode=$(ls -i '" + fp + "' 2>/dev/null | awk '{print $1}' || echo unknown)\n" +
      "      echo '" + okMarkerPrefix + "':\"$inode\" > /dev/ttyS0\n" +
      "    elif [ -z \"$actual_sha\" ]; then\n" +
      "      inode=$(ls -i '" + fp + "' 2>/dev/null | awk '{print $1}' || echo unknown)\n" +
      "      echo '" + okMarkerPrefix + "':\"$inode\" > /dev/ttyS0\n" +
      "    else\n" +
      "      echo '[EXEC_DIAG:HASH_MISMATCH] expected=" + sha256 + " got='$actual_sha > /dev/ttyS0\n" +
      "      echo '" + failMarker + "' > /dev/ttyS0\n" +
      "    fi\n" +
      "  else\n" +
      "    echo '" + failMarker + "' > /dev/ttyS0\n" +
      "  fi\n" +
      "fi\n" +
      "trap - ERR\n";

    // ── Execute script ─────────────────────────────────────────────────────────
    // Validates the framed payload, extracts the original script, validates size and sha256,
    // and finally executes it with `sh`.
    var executeScript =
      "#!/bin/sh\n" +
      "set -x\n" +
      "echo \"[STAGE] execute_verify\" > /dev/ttyS0\n" +
      "stty -echo > /dev/null 2>&1\n" +
      "trap 'echo \"[PROVISION_ERROR] line=$LINENO exit=$?\" > /dev/ttyS0' ERR\n" +
      "\n" +
      "tmp_file=\"/root/.provision/runtime_exec.sh.tmp\"\n" +
      "exec_file=\"/root/.provision/runtime_exec.sh\"\n" +
      "\n" +
      "echo \"[EXEC_PREFLIGHT] Starting execute preflight checks... Expected size: " + scriptSize + ", chunks: " + totalChunks + "\" > /dev/ttyS0\n" +
      "\n" +
      "if [ ! -f \"$tmp_file\" ]; then\n" +
      "  echo \"[EXEC_PREFLIGHT] Error: Temporary script file $tmp_file not found\" > /dev/ttyS0\n" +
      "  echo \"<<<PROTO:" + execId + ":7:FAIL:provision_file_missing>>>\" > /dev/ttyS0\n" +
      "  exit 1\n" +
      "fi\n" +
      "\n" +
      "# Validate header format and contents\n" +
      "header=$(head -n 1 \"$tmp_file\" 2>/dev/null)\n" +
      "case \"$header\" in\n" +
      "  \"BEGIN_SCRIPT:" + scriptSize + ":" + sha256 + "\")\n" +
      "    echo \"[EXEC_PREFLIGHT] Header validation passed\" > /dev/ttyS0\n" +
      "    ;;\n" +
      "  *)\n" +
      "    echo \"[EXEC_PREFLIGHT] Error: Header mismatch. Got '$header', expected 'BEGIN_SCRIPT:" + scriptSize + ":" + sha256 + "'\" > /dev/ttyS0\n" +
      "    echo \"<<<PROTO:" + execId + ":7:FAIL:header_invalid>>>\" > /dev/ttyS0\n" +
      "    exit 1\n" +
      "    ;;\n" +
      "esac\n" +
      "\n" +
      "# Validate footer format and contents\n" +
      "footer=$(tail -n 1 \"$tmp_file\" 2>/dev/null)\n" +
      "case \"$footer\" in\n" +
      "  \"END_SCRIPT\")\n" +
      "    echo \"[EXEC_PREFLIGHT] Footer validation passed\" > /dev/ttyS0\n" +
      "    ;;\n" +
      "  *)\n" +
      "    echo \"[EXEC_PREFLIGHT] Error: Footer mismatch. Got '$footer', expected 'END_SCRIPT'\" > /dev/ttyS0\n" +
      "    echo \"<<<PROTO:" + execId + ":7:FAIL:footer_invalid>>>\" > /dev/ttyS0\n" +
      "    exit 1\n" +
      "    ;;\n" +
      "esac\n" +
      "\n" +
      "# Strip header and footer to generate final executable script\n" +
      "sed '1d;$d' \"$tmp_file\" > \"$exec_file\"\n" +
      "\n" +
      "# Validate size of unframed script\n" +
      "actual_size=$(wc -c < \"$exec_file\" 2>/dev/null)\n" +
      "if [ \"$actual_size\" -ne " + scriptSize + " ]; then\n" +
      "  echo \"[EXEC_PREFLIGHT] Error: Size mismatch. Got $actual_size, expected " + scriptSize + "\" > /dev/ttyS0\n" +
      "  echo \"<<<PROTO:" + execId + ":7:FAIL:size_mismatch>>>\" > /dev/ttyS0\n" +
      "  exit 1\n" +
      "fi\n" +
      "\n" +
      "# Validate SHA256 checksum if sha256sum command exists on guest\n" +
      "actual_sha=$(sha256sum \"$exec_file\" 2>/dev/null | awk '{print $1}')\n" +
      "if [ -n \"$actual_sha\" ]; then\n" +
      "  if [ \"$actual_sha\" != \"" + sha256 + "\" ]; then\n" +
      "    echo \"[EXEC_PREFLIGHT] Error: SHA256 checksum mismatch. Got '$actual_sha', expected '" + sha256 + "'\" > /dev/ttyS0\n" +
      "    echo \"<<<PROTO:" + execId + ":7:FAIL:sha256_mismatch>>>\" > /dev/ttyS0\n" +
      "    exit 1\n" +
      "  fi\n" +
      "fi\n" +
      "\n" +
      "echo \"[EXEC_PREFLIGHT] Preflight checks passed. Launching script execution...\" > /dev/ttyS0\n" +
      "chmod +x \"$exec_file\"\n" +
      "sync\n" +
      "trap - ERR\n" +
      "\n" +
      "sh \"$exec_file\"\n";

    // Write all helper scripts via create_file() as .tmp files
    try {
      await emu.create_file(base + "/prov_mount_" + execId + ".sh.tmp", encode(mountScript));
      log("info", "[WorkerProvisioner] Helper: prov_mount_" + execId + ".sh.tmp written (" + mountScript.length + " bytes)");
      await emu.create_file(base + "/prov_verify_" + execId + ".sh.tmp", encode(verifyScript));
      log("info", "[WorkerProvisioner] Helper: prov_verify_" + execId + ".sh.tmp written (" + verifyScript.length + " bytes)");
      await emu.create_file(base + "/prov_remount_" + execId + ".sh.tmp", encode(remountScript));
      log("info", "[WorkerProvisioner] Helper: prov_remount_" + execId + ".sh.tmp written (" + remountScript.length + " bytes)");
      await emu.create_file(base + "/prov_diag_" + execId + ".sh.tmp", encode(diagScript));
      log("info", "[WorkerProvisioner] Helper: prov_diag_" + execId + ".sh.tmp written (" + diagScript.length + " bytes)");
      await emu.create_file(base + "/prov_reval_" + execId + ".sh.tmp", encode(revalScript));
      log("info", "[WorkerProvisioner] Helper: prov_reval_" + execId + ".sh.tmp written (" + revalScript.length + " bytes)");
      await emu.create_file(base + "/prov_execute_" + execId + ".sh.tmp", encode(executeScript));
      log("info", "[WorkerProvisioner] Helper: prov_execute_" + execId + ".sh.tmp written (" + executeScript.length + " bytes)");
      log("info", "[WorkerProvisioner] All FSM helper scripts written as .tmp. TTY will only receive short dispatch commands.");
    } catch (e) {
      log("error", "[WorkerProvisioner] Failed to write helper scripts: " + String(e));
      throw e;
    }
  },

  /**
   * MountVisibilityFSM — deterministic 9p mount, verify, and retry state machine.
   *
   * States: MOUNTING -> VERIFYING -> RETRY_VERIFY -> REMOUNT -> VERIFIED | FALLBACK
   *
   * CRITICAL: All shell logic is in pre-written helper script files.
   * The TTY receives ONLY short single-line dispatch commands:
   *   "sh /root/.provision/prov_mount_N.sh\n"
   * This prevents shell continuation prompt (>) deadlocks entirely.
   */
  verifyGuestVisibility: function(emu, filePath, execId) {
    var MAX_VERIFY_RETRIES = 6;
    var MAX_MOUNT_RETRIES = 3;
    var STABILITY_CHECKS = 3;
    var CMD_TIMEOUT_MS = 8000;
    var fsmState = "MOUNTING";
    var startTime = Date.now();
    var verifyAttempt = 0;
    var mountStartTime = 0;
    var finished = false;
    var rawBuffer = "";
    var parserState = "idle";
    var cmdTimeout = null;
    var listener = null;

    // Telemetry fields
    var mountSuccess = false;
    var mountSettled = false;
    var propagationLatencyMs = -1;
    var retryCount = 0;
    var guestVisibilityTimingMs = -1;
    var remountAttemptsCount = 0;
    
    // Advanced mount telemetry
    var mountLatencyMs = -1;
    var visibilityLatencyMs = -1;
    var virtioReadiness = false;
    var readdirSuccess = false;
    var inodeReadiness = false;
    var stabilityCount = 0;

    // Helper script base path
    var base = "/root/.provision";

    log("info", "[MountVisibilityFSM] Starting for path: " + filePath + " execId=" + execId);

    return new Promise(function(resolve) {
      function done(visible, inode) {
        if (finished) return;
        finished = true;
        if (cmdTimeout) clearTimeout(cmdTimeout);
        if (listener) emu.remove_listener("serial0-output-byte", listener);
        var elapsed = Date.now() - startTime;
        if (visible) {
          propagationLatencyMs = elapsed;
          visibilityLatencyMs = elapsed;
        }
        guestVisibilityTimingMs = elapsed;

        var resolvedInode = inode || "unknown";
        if (visible && resolvedInode !== "unknown" && resolvedInode !== "") {
          inodeReadiness = true;
        }

        log("info", "[MountVisibilityFSM TELEMETRY] Resolved visible=" + visible + 
                   " | inode=" + resolvedInode +
                   " | mountSuccess=" + mountSuccess +
                   " | mountSettled=" + mountSettled +
                   " | mountLatency=" + mountLatencyMs + "ms" +
                   " | visibilityLatency=" + visibilityLatencyMs + "ms" +
                   " | virtioReadiness=" + virtioReadiness +
                   " | readdirSuccess=" + readdirSuccess +
                   " | inodeReadiness=" + inodeReadiness +
                   " | propagationLatency=" + (propagationLatencyMs !== -1 ? propagationLatencyMs + "ms" : "N/A") +
                   " | retryCount=" + retryCount +
                   " | guestVisibilityTiming=" + guestVisibilityTimingMs + "ms" +
                   " | remountAttempts=" + remountAttemptsCount);

        resolve({
          visible: visible,
          elapsedMs: elapsed,
          inode: resolvedInode,
          telemetry: {
            mountSuccess: mountSuccess,
            mountSettled: mountSettled,
            propagationLatencyMs: propagationLatencyMs,
            retryCount: retryCount,
            guestVisibilityTimingMs: guestVisibilityTimingMs,
            remountAttempts: remountAttemptsCount,
            mountLatencyMs: mountLatencyMs,
            visibilityLatencyMs: visibilityLatencyMs,
            virtioReadiness: virtioReadiness,
            readdirSuccess: readdirSuccess,
            inodeReadiness: inodeReadiness
          }
        });
      }

      function armTimeout(ms) {
        if (cmdTimeout) clearTimeout(cmdTimeout);
        cmdTimeout = setTimeout(function() {
          log("warn", "[MountVisibilityFSM] Command timeout after " + ms + "ms in state " + fsmState +
                     ". Buffer: " + JSON.stringify(rawBuffer.slice(-512)));
          advance("TIMEOUT");
        }, ms);
      }

      // Parse serial output byte-by-byte, accumulate rawBuffer, scan for FSM markers
      listener = function(byte) {
        if (finished) return;
        rawBuffer += String.fromCharCode(byte);
        if (rawBuffer.length > 8192) rawBuffer = rawBuffer.slice(-8192);
        var buf = WorkerProvisioner.sanitizeSerialOutput(rawBuffer);

        // Parse <<<MOUNT_SETTLED>>> marker
        if (buf.indexOf("<<<MOUNT_SETTLED>>>") !== -1) {
          if (!mountSettled) {
            mountSettled = true;
            log("info", "[MountVisibilityFSM] Host confirmed guest filesystem has settled (expected entries are accessible and readable).");
          }
        }

        // Telemetry tracking for registered helpers
        if (buf.indexOf("<<<HELPER_REGISTERED:") !== -1) {
          var startRegIdx = buf.indexOf("<<<HELPER_REGISTERED:");
          var endRegIdx = buf.indexOf(">>>", startRegIdx);
          if (endRegIdx !== -1) {
            var helperName = buf.slice(startRegIdx + "<<<HELPER_REGISTERED:".length, endRegIdx).replace(/[^A-Z]/g, "");
            WorkerProvisioner.registeredHelpers[helperName] = true;
            log("info", "[MountVisibilityFSM] Host confirmed helper registration for: " + helperName);
            // Log full helper registry state (Requirement 1)
            log("info", "[MountVisibilityFSM TELEMETRY] Current FSM Registered Helpers: " + JSON.stringify(WorkerProvisioner.registeredHelpers));
          }
        }

        if (buf.indexOf("<<<PROVISION_FILE_MISSING>>>") !== -1) {
          log("error", "[MountVisibilityFSM] Preflight check failed: helper script " + fsmState + " is missing!");
          
          if (fsmState === "VERIFYING") {
            log("warn", "[MountVisibilityFSM] VERIFYING helper absent. Triggering basic mount validation fallback...");
            var fallbackCmd =
              "if grep -q host9p /proc/mounts 2>/dev/null && [ -d /root/.provision ]; then " +
              "  echo '<<<FSM:" + execId + ":VERIFYING:FALLBACK_OK>>>' > /dev/ttyS0; " +
              "else " +
              "  echo '<<<FSM:" + execId + ":VERIFYING:FALLBACK_FAIL>>>' > /dev/ttyS0; " +
              "fi\n";
            parserState = "waiting";
            rawBuffer = "";
            SerialChannelManager.send(0, fallbackCmd);
            return;
          }
          
          parserState = "idle";
          rawBuffer = "";
          advance("NOVIS");
          return;
        }

        var tag = "FSM:" + execId + ":" + fsmState;
        var okMarker  = "<<<" + tag + ":OK>>>";
        var errMarker = "<<<" + tag + ":ERR>>>";
        var fallbackOkMarker = "<<<FSM:" + execId + ":VERIFYING:FALLBACK_OK>>>";
        var fallbackFailMarker = "<<<FSM:" + execId + ":VERIFYING:FALLBACK_FAIL>>>";
        var visMarkerPrefix = "<<<" + tag + ":VIS>>>";
        var noVisMarker = "<<<" + tag + ":NOVIS>>>";
        var diagDoneMarker = "<<<FSM:" + execId + ":DIAGNOSTICS:DONE>>>";

        if (parserState === "waiting") {
          if (fsmState === "DIAGNOSTICS" && buf.indexOf(diagDoneMarker) !== -1) {
            var capturedBuf = buf;
            parserState = "idle";
            rawBuffer = "";
            advance("DIAG_DONE", capturedBuf);
          } else if (buf.indexOf(fallbackOkMarker) !== -1) {
            log("info", "[MountVisibilityFSM] Fallback validation SUCCESS. host9p is mounted.");
            parserState = "idle";
            rawBuffer = "";
            advance("VIS", "fallback-inode");
          } else if (buf.indexOf(fallbackFailMarker) !== -1) {
            log("error", "[MountVisibilityFSM] Fallback validation FAILED. host9p is not mounted.");
            parserState = "idle";
            rawBuffer = "";
            advance("NOVIS");
          } else if (buf.indexOf(okMarker) !== -1) {
            parserState = "idle";
            rawBuffer = "";
            advance("OK");
          } else if (buf.indexOf(errMarker) !== -1) {
            parserState = "idle";
            rawBuffer = "";
            advance("ERR");
          } else if (buf.indexOf(visMarkerPrefix) !== -1) {
            // Extract the inode suffix after the marker
            var idx = buf.indexOf(visMarkerPrefix);
            var restOfBuf = buf.slice(idx + visMarkerPrefix.length);
            var inode = "unknown";
            var endOfMarkerIdx = restOfBuf.indexOf("\n");
            if (endOfMarkerIdx !== -1) {
              inode = restOfBuf.slice(0, endOfMarkerIdx).replace(/[^0-9a-zA-Z]/g, "");
            } else {
              inode = restOfBuf.replace(/[^0-9a-zA-Z]/g, "");
            }
            if (inode.indexOf(":") === 0) {
              inode = inode.slice(1);
            }
            parserState = "idle";
            rawBuffer = "";
            advance("VIS", inode);
          } else if (buf.indexOf(noVisMarker) !== -1) {
            parserState = "idle";
            rawBuffer = "";
            advance("NOVIS");
          }
        }
      };
      emu.add_listener("serial0-output-byte", listener);

      // sendCmd: reset buffer, set parserState, send a SHORT single-line dispatch command.
      // All logic is in the helper scripts — the tty only receives "sh /path/to/script.sh\n".
      function sendCmd(scriptPath) {
        rawBuffer = "";
        parserState = "waiting";
        log("info", "[MountVisibilityFSM] Dispatching: sh " + scriptPath);
        
        // Output diagnostics if helper is missing (Requirement 5)
        var cmd =
          "if [ -f '" + scriptPath + "' ]; then " +
          "  sh " + scriptPath + "; " +
          "else " +
          "  echo '<<<PROVISION_FILE_MISSING>>>' > /dev/ttyS0; " +
          "  echo '[DIAG:MISSING] State=" + fsmState + " Path=" + scriptPath + "' > /dev/ttyS0; " +
          "  echo '[DIAG:LS_PROVISION]' > /dev/ttyS0; ls -la /root/.provision/ > /dev/ttyS0 2>&1; " +
          "  echo '[DIAG:LS_MNT]' > /dev/ttyS0; ls -la /mnt/9p/root/.provision/ > /dev/ttyS0 2>&1; " +
          "  echo '[DIAG:MOUNTS]' > /dev/ttyS0; cat /proc/mounts > /dev/ttyS0 2>&1; " +
          "fi\n";
          
        SerialChannelManager.send(0, cmd);
      }

      function doMount() {
        fsmState = "MOUNTING";
        mountStartTime = Date.now();
        log("info", "[MountVisibilityFSM] MOUNTING: dispatching inline mount command");
        armTimeout(CMD_TIMEOUT_MS + 30000); // Mount can take up to ~30s extra for sleep loops
        
        // Log telemetry: expected helpers, paths, state registry (Requirement 1)
        log("info", "[MountVisibilityFSM TELEMETRY] Expected helpers: prov_mount_" + execId + ".sh.tmp, prov_verify_" + execId + ".sh.tmp, prov_remount_" + execId + ".sh.tmp, prov_diag_" + execId + ".sh.tmp, prov_reval_" + execId + ".sh.tmp");
        log("info", "[MountVisibilityFSM TELEMETRY] Install base path: /root/.provision/ (mapped to /mnt/9p/root/.provision/)");
        log("info", "[MountVisibilityFSM TELEMETRY] Current FSM state: " + fsmState);

        var inlineCmd = 
          "set -x; echo '[INLINE_MOUNT] Starting mount sequence'; " +
          "mkdir -p /mnt/9p && " +
          "umount -f /mnt/9p >/dev/null 2>&1; umount /mnt/9p >/dev/null 2>&1; " +
          "echo '[INLINE_MOUNT] Attempting 9p mount'; " +
          "(mount -t 9p -o trans=virtio,version=9p2000.L,cache=none host9p /mnt/9p 2>/dev/null || " +
          " mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/9p 2>/dev/null || " +
          " mount -t 9p -o trans=virtio,cache=none host9p /mnt/9p 2>/dev/null || " +
          " mount -t 9p -o trans=virtio host9p /mnt/9p 2>/dev/null || " +
          " mount -t 9p host9p /mnt/9p 2>/dev/null) && " +
          "sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null && " +
          "echo '[INLINE_MOUNT] Waiting for verify script visibility'; " +
          "i=0; ok=0; while [ \"$i\" -lt 20 ]; do " +
          "  if [ -f /mnt/9p/root/.provision/prov_verify_" + execId + ".sh.tmp ] && [ -s /mnt/9p/root/.provision/prov_verify_" + execId + ".sh.tmp ]; then ok=1; break; fi; " +
          "  sleep 1; i=$((i+1)); " +
          "done && [ \"$ok\" -eq 1 ] && " +
          "echo '[INLINE_MOUNT] Verify script visible, setting up symlink'; " +
          "rm -rf /root/.provision && " +
          "mkdir -p /mnt/9p/root/.provision && " +
          "ln -s /mnt/9p/root/.provision /root/.provision && " +
          "sync && " +
          "echo '[INLINE_MOUNT] Renaming .tmp helpers to final'; " +
          "for f in /mnt/9p/root/.provision/prov_*.sh.tmp; do " +
          "  if [ -f \"$f\" ]; then " +
          "    mv -f \"$f\" \"${f%.tmp}\" && " +
          "    chmod +x \"${f%.tmp}\" && " +
          "    ls -l \"${f%.tmp}\"; " +
          "  fi; " +
          "done && " +
          "echo '[INLINE_MOUNT] Validating helper executables'; " +
          "h_ok=1; for h in mount verify remount diag reval execute; do " +
          "  if [ ! -f \"/root/.provision/prov_${h}_" + execId + ".sh\" ] || [ ! -x \"/root/.provision/prov_${h}_" + execId + ".sh\" ]; then " +
          "    h_ok=0; " +
          "  fi; " +
          "done && " +
          "[ \"$h_ok\" -eq 1 ] && " +
          "echo '<<<MOUNT_SETTLED>>>' > /dev/ttyS0 && " +
          "for h in mount verify remount diag reval execute; do " +
          "  if [ -f \"/root/.provision/prov_${h}_" + execId + ".sh\" ]; then " +
          "    case \"$h\" in " +
          "      mount) name=\"MOUNTING\" ;; " +
          "      verify) name=\"VERIFYING\" ;; " +
          "      remount) name=\"REMOUNT\" ;; " +
          "      diag) name=\"DIAGNOSTICS\" ;; " +
          "      reval) name=\"REVALIDATION\" ;; " +
          "      execute) name=\"EXECUTION\" ;; " +
          "    esac; " +
          "    echo \"<<<HELPER_REGISTERED:$name>>>\" > /dev/ttyS0; " +
          "  fi; " +
          "done && " +
          "sync && " +
          "[ -d /root/.provision ] && " +
          "echo '<<<FSM:" + execId + ":MOUNTING:OK>>>' > /dev/ttyS0 || " +
          "echo '<<<FSM:" + execId + ":MOUNTING:ERR>>>' > /dev/ttyS0\n";
          
        rawBuffer = "";
        parserState = "waiting";
        log("info", "[MountVisibilityFSM] Dispatching inline mount command: " + inlineCmd.trim());
        SerialChannelManager.send(0, inlineCmd);
      }

      function doVerify(isStabilityCheck) {
        fsmState = "VERIFYING";
        if (!isStabilityCheck) {
          verifyAttempt++;
          retryCount = verifyAttempt;
        }
        
        var delay = isStabilityCheck ? 200 : Math.min(4000, 300 * Math.pow(2, verifyAttempt - 1));
        log("info", "[MountVisibilityFSM] VERIFYING" + (isStabilityCheck ? " (stability check " + (stabilityCount + 1) + "/" + STABILITY_CHECKS + ")" : " attempt " + verifyAttempt + "/" + MAX_VERIFY_RETRIES) + " for " + filePath + " after delay of " + delay + "ms");
        
        setTimeout(function() {
          if (finished) return;
          armTimeout(CMD_TIMEOUT_MS);
          sendCmd(base + "/prov_verify_" + execId + ".sh");
        }, delay);
      }

      function doRemount() {
        fsmState = "REMOUNT";
        log("info", "[MountVisibilityFSM] REMOUNT: dispatching inline remount command (attempt " + remountAttemptsCount + "/" + MAX_MOUNT_RETRIES + ")");
        armTimeout(CMD_TIMEOUT_MS + 20000);
        
        var inlineRemountCmd =
          "set -x; echo '[INLINE_REMOUNT] Starting remount sequence'; " +
          "umount -f /mnt/9p >/dev/null 2>&1; umount /mnt/9p >/dev/null 2>&1; " +
          "mkdir -p /mnt/9p >/dev/null 2>&1; " +
          "echo '[INLINE_REMOUNT] Attempting 9p remount'; " +
          "(mount -t 9p -o trans=virtio,version=9p2000.L,cache=none host9p /mnt/9p 2>/dev/null || " +
          " mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/9p 2>/dev/null || " +
          " mount -t 9p -o trans=virtio,cache=none host9p /mnt/9p 2>/dev/null || " +
          " mount -t 9p -o trans=virtio host9p /mnt/9p 2>/dev/null || " +
          " mount -t 9p host9p /mnt/9p 2>/dev/null) && " +
          "sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null && " +
          "echo '[INLINE_REMOUNT] Waiting for verify script visibility'; " +
          "i=0; ok=0; while [ \"$i\" -lt 20 ]; do " +
          "  if [ -f /mnt/9p/root/.provision/prov_verify_" + execId + ".sh.tmp ] && [ -s /mnt/9p/root/.provision/prov_verify_" + execId + ".sh.tmp ]; then ok=1; break; fi; " +
          "  sleep 1; i=$((i+1)); " +
          "done && [ \"$ok\" -eq 1 ] && " +
          "echo '[INLINE_REMOUNT] Verify script visible, setting up symlink'; " +
          "rm -rf /root/.provision && " +
          "mkdir -p /mnt/9p/root/.provision && " +
          "ln -s /mnt/9p/root/.provision /root/.provision && " +
          "sync && " +
          "echo '[INLINE_REMOUNT] Renaming .tmp helpers to final'; " +
          "for f in /mnt/9p/root/.provision/prov_*.sh.tmp; do " +
          "  if [ -f \"$f\" ]; then " +
          "    mv -f \"$f\" \"${f%.tmp}\" && " +
          "    chmod +x \"${f%.tmp}\" && " +
          "    ls -l \"${f%.tmp}\"; " +
          "  fi; " +
          "done && " +
          "echo '[INLINE_REMOUNT] Validating helper executables'; " +
          "h_ok=1; for h in mount verify remount diag reval execute; do " +
          "  if [ ! -f \"/root/.provision/prov_${h}_" + execId + ".sh\" ] || [ ! -x \"/root/.provision/prov_${h}_" + execId + ".sh\" ]; then " +
          "    h_ok=0; " +
          "  fi; " +
          "done && " +
          "[ \"$h_ok\" -eq 1 ] && " +
          "echo '<<<MOUNT_SETTLED>>>' > /dev/ttyS0 && " +
          "for h in mount verify remount diag reval execute; do " +
          "  if [ -f \"/root/.provision/prov_${h}_" + execId + ".sh\" ]; then " +
          "    case \"$h\" in " +
          "      mount) name=\"MOUNTING\" ;; " +
          "      verify) name=\"VERIFYING\" ;; " +
          "      remount) name=\"REMOUNT\" ;; " +
          "      diag) name=\"DIAGNOSTICS\" ;; " +
          "      reval) name=\"REVALIDATION\" ;; " +
          "      execute) name=\"EXECUTION\" ;; " +
          "    esac; " +
          "    echo \"<<<HELPER_REGISTERED:$name>>>\" > /dev/ttyS0; " +
          "  fi; " +
          "done && " +
          "sync && " +
          "[ -d /root/.provision ] && " +
          "echo '<<<FSM:" + execId + ":REMOUNT:OK>>>' > /dev/ttyS0 || " +
          "echo '<<<FSM:" + execId + ":REMOUNT:ERR>>>' > /dev/ttyS0\n";
          
        rawBuffer = "";
        parserState = "waiting";
        log("info", "[MountVisibilityFSM] Dispatching inline remount command: " + inlineRemountCmd.trim());
        SerialChannelManager.send(0, inlineRemountCmd);
      }

      function scheduleRemount() {
        if (remountAttemptsCount < MAX_MOUNT_RETRIES) {
          remountAttemptsCount++;
          var delay = Math.min(8000, 1000 * Math.pow(2, remountAttemptsCount - 1));
          var jitter = Math.floor(Math.random() * 500);
          var finalDelay = delay + jitter;
          log("warn", "[MountVisibilityFSM] Scheduling remount attempt " + remountAttemptsCount + "/" + MAX_MOUNT_RETRIES + " in " + finalDelay + "ms (backoff=" + delay + "ms, jitter=" + jitter + "ms)");
          postToHost("PROVISION_RECOVERING", { msg: "Filesystem synchronization recovering..." });
          setTimeout(function() {
            if (finished) return;
            doRemount();
          }, finalDelay);
        } else {
          log("error", "[MountVisibilityFSM] Mount retry budget (" + MAX_MOUNT_RETRIES + ") exhausted. Triggering diagnostics.");
          doDiagnostics();
        }
      }

      function doDiagnostics() {
        fsmState = "DIAGNOSTICS";
        log("warn", "[MountVisibilityFSM] Verification exhausted. Dumping namespace diagnostics.");
        armTimeout(5000 + CMD_TIMEOUT_MS);
        sendCmd(base + "/prov_diag_" + execId + ".sh");
      }

      function advance(event, extra) {
        if (finished) return;
        log("info", "[MountVisibilityFSM] State=" + fsmState + " Event=" + event);

        if (fsmState === "MOUNTING") {
          if (event === "OK") {
            mountSuccess = true;
            virtioReadiness = true;
            readdirSuccess = true;
            mountLatencyMs = Date.now() - mountStartTime;
            log("info", "[MountVisibilityFSM] Mount OK. Latency: " + mountLatencyMs + "ms. Waiting 800ms for filesystem stabilization...");
            setTimeout(function() {
              if (finished) return;
              doVerify(false);
            }, 800);
          } else {
            // Mount failed — schedule remount recovery
            scheduleRemount();
          }
        } else if (fsmState === "VERIFYING") {
          if (event === "VIS") {
            stabilityCount++;
            if (stabilityCount >= STABILITY_CHECKS) {
              log("info", "[MountVisibilityFSM] File VISIBLE and STABLE across " + STABILITY_CHECKS + " cycles. -> VERIFIED");
              done(true, extra);
            } else {
              doVerify(true); // Run stability check
            }
          } else if (event === "NOVIS" || event === "TIMEOUT") {
            stabilityCount = 0; // Reset stability counter since it failed!
            if (verifyAttempt < MAX_VERIFY_RETRIES) {
              log("warn", "[MountVisibilityFSM] Not visible yet (attempt " + verifyAttempt + "). Retrying verify loop.");
              postToHost("PROVISION_RECOVERING", { msg: "Filesystem synchronization recovering..." });
              doVerify(false);
            } else {
              log("warn", "[MountVisibilityFSM] " + MAX_VERIFY_RETRIES + " verify attempts exhausted. Scheduling remount.");
              scheduleRemount();
            }
          } else {
            done(false);
          }
        } else if (fsmState === "REMOUNT") {
          if (event === "OK") {
            mountSuccess = true;
            virtioReadiness = true;
            readdirSuccess = true;
            log("info", "[MountVisibilityFSM] Remount OK. Resetting verify counter. Waiting 800ms for filesystem stabilization...");
            verifyAttempt = 0;
            stabilityCount = 0;
            setTimeout(function() {
              if (finished) return;
              doVerify(false);
            }, 800);
          } else {
            // Remount command itself failed or timed out — schedule another remount if budget remains
            scheduleRemount();
          }
        } else if (fsmState === "DIAGNOSTICS") {
          log("warn", "[MountVisibilityFSM DIAGNOSTICS] Guest dump:\n" + (extra || ""));
          done(false);
        }
      }

      // Kick off the FSM
      doMount();
    });
  },

  /**
   * Pre-execution revalidation.
   * Verifies file visibility/readability before triggering execution.
   * Uses a pre-written helper script instead of inline tty commands.
   */
  revalidateBeforeExecution: function(emu, filePath, execId, expectedInode) {
    var CMD_TIMEOUT_MS = 6000;
    var finished = false;
    var rawBuffer = "";
    var listener = null;
    var cmdTimeout = null;
    var startTime = Date.now();

    log("info", "[WorkerProvisioner] Starting pre-execution revalidation for: " + filePath + 
               " | Expected Inode: " + expectedInode + " | Exec ID: " + execId);

    log("info", "[WorkerProvisioner PERSISTENCE TELEMETRY] Path: " + filePath + 
               " | Expected Inode: " + expectedInode + 
               " | Exec ID: " + execId +
               " | Mount Source: host9p -> /mnt/9p" +
               " | Start Time: " + startTime);

    return new Promise(function(resolve) {
      function done(success, details) {
        if (finished) return;
        finished = true;
        if (cmdTimeout) clearTimeout(cmdTimeout);
        if (listener) emu.remove_listener("serial0-output-byte", listener);
        
        var latency = Date.now() - startTime;
        log("info", "[WorkerProvisioner PERSISTENCE TELEMETRY] Revalidation complete. Success: " + success +
                   " | Details: " + details +
                   " | Timing: " + latency + "ms");
        
        resolve({ success: success, details: details });
      }

      function armTimeout(ms) {
        if (cmdTimeout) clearTimeout(cmdTimeout);
        cmdTimeout = setTimeout(function() {
          log("warn", "[WorkerProvisioner] Pre-execution revalidation timed out. Raw buffer: " + JSON.stringify(rawBuffer.slice(-512)));
          done(false, "timeout");
        }, ms);
      }

      var okMarkerPrefix = "<<<EXEC_REVAL:" + execId + ":OK>>>";
      var failMarker = "<<<EXEC_REVAL:" + execId + ":FAIL>>>";

      listener = function(byte) {
        if (finished) return;
        rawBuffer += String.fromCharCode(byte);
        if (rawBuffer.length > 8192) rawBuffer = rawBuffer.slice(-8192);
        var buf = WorkerProvisioner.sanitizeSerialOutput(rawBuffer);

        if (buf.indexOf("<<<PROVISION_FILE_MISSING>>>") !== -1) {
          log("error", "[WorkerProvisioner] Preflight check failed: reval script is missing!");
          done(false, "reval_script_missing");
          return;
        }

        if (buf.indexOf(okMarkerPrefix) !== -1) {
          // Extract inode
          var idx = buf.indexOf(okMarkerPrefix);
          var rest = buf.slice(idx + okMarkerPrefix.length);
          var inode = "unknown";
          var endIdx = rest.indexOf("\n");
          if (endIdx !== -1) {
            inode = rest.slice(0, endIdx).replace(/[^0-9a-zA-Z]/g, "");
          } else {
            inode = rest.replace(/[^0-9a-zA-Z]/g, "");
          }
          log("info", "[WorkerProvisioner] Pre-execution revalidation OK. Inode: " + inode);
          log("info", "[WorkerProvisioner REVAL DIAGNOSTICS]\n" + buf);
          
          // Inode consistency check
          if (expectedInode && expectedInode !== "unknown" && inode !== "unknown" && inode !== expectedInode) {
            log("warn", "[WorkerProvisioner] Inode mismatch detected! Expected: " + expectedInode + ", got: " + inode + ". Possible filesystem reset.");
          } else {
            log("info", "[WorkerProvisioner] Inode consistency verified: " + inode);
          }
          
          done(true, inode);
        } else if (buf.indexOf(failMarker) !== -1) {
          log("error", "[WorkerProvisioner] Pre-execution revalidation reported FAIL.");
          log("warn", "[WorkerProvisioner REVAL DIAGNOSTICS]\n" + buf);
          done(false, "guest_verification_failed");
        }
      };
      emu.add_listener("serial0-output-byte", listener);

      // Dispatch the pre-written revalidation helper script.
      // Short single-line command — no inline shell over tty.
      armTimeout(CMD_TIMEOUT_MS + 10000);
      var helperPath = "/root/.provision/prov_reval_" + execId + ".sh";
      log("info", "[WorkerProvisioner] Dispatching revalidation helper: sh " + helperPath);
      
      var cmd =
        "if [ -f '" + helperPath + "' ]; then " +
        "sh " + helperPath + "; " +
        "else " +
        "echo '<<<PROVISION_FILE_MISSING>>>' > /dev/ttyS0; " +
        "fi\n";
      SerialChannelManager.send(0, cmd);
    });
  },

  /**
   * Write a binary blob directly to the VM filesystem with validation.
   */
  writeBinaryFile: async function(emu, filePath, data) {
    var startTime = Date.now();
    await this.waitAndValidateFS(
      emu, 
      filePath, 
      FilesystemAccessPolicy.SOURCES.PROVISIONING_SYSTEM, 
      FilesystemAccessPolicy.OPERATIONS.WRITE_BINARY
    );

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
    log("info", "[WorkerProvisioner] Binary file write verified successfully on WorkerFS. Latency: " + writeLatency + "ms");
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
    this.registeredHelpers = {};
    this.transitionTo("idle");
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
    // Stamp generation and destroyed flag for ownership tracking
    emulator.generation = workerGeneration;
    emulator.destroyed = false;
    activeEmulatorInstances.add(emulator);
    SerialChannelManager.init(emulator);

    // Bridge serial output with batch buffering
    var capturedEmulator = emulator;
    emulator.add_listener("serial0-output-byte", function (byte) {
      if (capturedEmulator.destroyed) return;
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
      if (capturedEmulator.destroyed) return;
      postToHost("SERIAL1_OUT", byte);
    });

    log("info", "v86 emulator successfully created. Generation: " + emulator.generation);
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
    log("info", "Destroying active emulator instance (generation=" + emulator.generation + ")...");
    // Mark destroyed FIRST so that any stale tick callbacks that fire during teardown exit safely
    emulator.destroyed = true;
    if (emulator._v86_val) {
      emulator._v86_val.destroyed = true;
    }
    activeEmulatorInstances.delete(emulator);
    // Flush and clear serial buffer before destroy
    if (serialTimeoutId) {
      clearTimeout(serialTimeoutId);
      serialTimeoutId = null;
    }
    serialSendBuffer = [];
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
  var gen = data.generation;

  // 5. Add worker termination barrier
  if (workerTerminating) {
    console.warn("[WORKER] Message ignored - worker is terminating: " + type);
    return;
  }

  // 2. Add generation ownership guards
  if (gen !== undefined) {
    if (type !== "INIT" && type !== "DESTROY" && gen !== workerGeneration) {
      log("warn", "[onmessage GUARD] Dropping message type '" + type + "' because payload generation (" + gen + ") doesn't match worker generation (" + workerGeneration + ")");
      return;
    }
    workerGeneration = gen;
  }

  console.log("[WORKER MESSAGE RECEIVED]", data);

  switch (type) {
    case "INIT":
      workerTerminating = false;
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
      if (lifecycleState === "initialized" || lifecycleState === "booting" || lifecycleState === "provision_preparing" || lifecycleState === "provisioning" || lifecycleState === "shell_ready" || lifecycleState === "terminal_ready") {
        setLifecycleState("ready");
        log("info", "Emulator successfully transitioned to ready state (boot complete)");
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
      // 4. Add teardown cleanup - set barrier first so all pending callbacks exit
      workerTerminating = true;
      clearAllTrackedTimers();
      setLifecycleState("destroyed");
      await destroyEmulator();
      self.close();
      break;

    // ── Provisioning Protocol Handlers ───────────────────────────────────────
    // These messages travel over the host↔worker message bus, NOT serial.
    // They implement atomic file transfer to replace base64 serial injection.

    case "PROVISION_BEGIN":
      if (!WorkerProvisioner.verifyExecId(payload.execId)) {
        postToHost("PROVISION_NACK", { execId: payload.execId, reason: "stale_execution_id" });
        break;
      }
      WorkerProvisioner.begin(payload);
      postToHost("PROVISION_ACK", { type: "begin", execId: payload.execId });
      break;

    case "PROVISION_CHUNK": {
      if (!WorkerProvisioner.verifyExecId(payload.execId)) {
        postToHost("PROVISION_NACK", { execId: payload.execId, chunkIndex: payload.chunkIndex, reason: "stale_execution_id" });
        break;
      }
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
      if (!WorkerProvisioner.verifyExecId(payload.execId)) {
        postToHost("PROVISION_NACK", { execId: payload.execId, reason: "stale_execution_id" });
        break;
      }
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
      if (!WorkerProvisioner.verifyExecId(payload.execId)) {
        postToHost("PROVISION_NACK", { execId: payload.execId, reason: "stale_execution_id" });
        break;
      }
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
      if (!WorkerProvisioner.verifyExecId(payload.execId)) {
        postToHost("PROVISION_NACK", { execId: payload.execId, reason: "stale_execution_id" });
        break;
      }
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
      if (!WorkerProvisioner.verifyExecId(payload.execId)) {
        postToHost("PROVISION_NACK", { execId: payload.execId, reason: "stale_execution_id" });
        break;
      }
      var execFilePath = payload.filePath;
      var execExecId = payload.execId;
      var expectedInode = payload.verifiedInode || "unknown";

      // 4. Filesystem stabilization delay
      log("info", "[WorkerProvisioner] Applying filesystem stabilization delay (800ms)...");
      await new Promise(function(r) { setTimeout(r, 800); });

      // 2. Pre-execution revalidation
      var reval = await WorkerProvisioner.revalidateBeforeExecution(emulator, execFilePath, execExecId, expectedInode);

      if (!reval.success) {
        log("error", "[WorkerProvisioner] Pre-execution revalidation failed. Aborting execution trigger.");
        postToHost("PROVISION_NACK", { execId: execExecId, reason: "pre_execution_revalidation_failed: " + reval.details });
        WorkerProvisioner.transitionTo("failed");
        break;
      }

      WorkerProvisioner.transitionTo("executing");
      log("info", "[WorkerProvisioner] Executing via direct file path: " + execFilePath);

      var triggerCmd = "sh /root/.provision/prov_execute_" + execExecId + ".sh\n";

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


// ─── 6. INTERCEPT AND WRAP V86 INTERNALS FOR LIFE-CYCLE SECURITY ──────────────

function wrapV86Constructor() {
  if (typeof self.V86 === "undefined") {
    log("error", "Cannot wrap V86: self.V86 is undefined");
    return;
  }
  
  if (self.V86._isWrapped) {
    log("info", "V86 constructor is already wrapped.");
    return;
  }
  
  log("info", "Wrapping V86 constructor and prototype to intercept ticking loop...");

  var OriginalV86 = self.V86;

  var WrappedV86 = function(config) {
    this.generation = workerGeneration;
    this.destroyed = false;
    log("info", "[V86 Constructor Wrapper] New V86 instance instantiated for generation: " + this.generation);
    var inst = new OriginalV86(config);
    inst.generation = this.generation;
    inst.destroyed = false;
    
    // Explicitly trace the new instance and register it
    activeEmulatorInstances.add(inst);

    return inst;
  };

  // Copy prototype and static properties
  WrappedV86.prototype = OriginalV86.prototype;
  Object.assign(WrappedV86, OriginalV86);
  WrappedV86._isWrapped = true;
  self.V86 = WrappedV86;

  // Let's add a setter for 'v86' on OriginalV86.prototype to intercept internal ticker 'F'
  Object.defineProperty(OriginalV86.prototype, "v86", {
    configurable: true,
    enumerable: true,
    get: function() {
      return this._v86_val;
    },
    set: function(val) {
      this._v86_val = val;
      if (val) {
        log("info", "Intercepted internal ticker F instance creation. Applying safe tick ownership and guards.");
        // Capture _ownerGeneration ON THE TICKER at construction time.
        // We cannot use emuInstance.generation because autostart fires ticks BEFORE
        // createEmulator() stamps emulator.generation after the constructor returns.
        val._ownerGeneration = workerGeneration;
        val.emuInstance = this;
        patchTickerInstance(val);
      }
    }
  });

  // Track add_listener / remove_listener on OriginalV86.prototype to safely detach callbacks
  var originalAddListener = OriginalV86.prototype.add_listener;
  OriginalV86.prototype.add_listener = function(name, callback) {
    if (!this._registeredListeners) {
      this._registeredListeners = [];
    }
    this._registeredListeners.push({ name: name, callback: callback });
    return originalAddListener.call(this, name, callback);
  };

  var originalRemoveListener = OriginalV86.prototype.remove_listener;
  OriginalV86.prototype.remove_listener = function(name, callback) {
    if (this._registeredListeners) {
      this._registeredListeners = this._registeredListeners.filter(function(l) {
        return !(l.name === name && l.callback === callback);
      });
    }
    return originalRemoveListener.call(this, name, callback);
  };

  // Override N.prototype.destroy to cleanly teardown
  var originalDestroy = OriginalV86.prototype.destroy;
  OriginalV86.prototype.destroy = async function() {
    log("info", "V86 instance destroy called for generation: " + this.generation);
    this.destroyed = true;
    if (this._v86_val) {
      this._v86_val.destroyed = true;
    }
    
    activeEmulatorInstances.delete(this);
    teardownTimersAndCallbacks(this);

    // Detach all listeners
    if (this._registeredListeners) {
      log("info", "Detaching " + this._registeredListeners.length + " serial/device callbacks...");
      var selfRef = this;
      this._registeredListeners.forEach(function(l) {
        try {
          originalRemoveListener.call(selfRef, l.name, l.callback);
        } catch (err) {
          // ignore
        }
      });
      this._registeredListeners = [];
    }

    if (originalDestroy) {
      try {
        await originalDestroy.call(this);
      } catch (err) {
        log("warn", "Error in original V86 destroy: " + err.message);
      }
    }
  };
}

function patchTickerInstance(ticker) {
  var FProto = Object.getPrototypeOf(ticker);
  
  if (FProto._patched) {
    return;
  }
  FProto._patched = true;

  log("info", "Applying lifecycle guards and safe tick ownership model to F.prototype");

  var originalDoTick = FProto.do_tick;
  var originalYieldCallback = FProto.yield_callback;

  FProto.do_tick = function() {
    var emuInstance = this.emuInstance;
    var emu = emulator;

    // Periodic instrumentation
    if (typeof globalThis.doTickLogCount === "undefined") {
      globalThis.doTickLogCount = 0;
    }
    globalThis.doTickLogCount++;
    if (globalThis.doTickLogCount % 50000 === 0) {
      log("debug", "[do_tick] State: " + lifecycleState +
                 " | Terminating: " + workerTerminating +
                 " | EmuDestroyed: " + !!(emuInstance && emuInstance.destroyed));
    }

    // Termination barrier — checked first, cheapest exit
    if (workerTerminating) {
      if (!this._warnedTerminating) {
        this._warnedTerminating = true;
        log("warn", "[do_tick GUARD] Rejected: worker is terminating.");
      }
      return;
    }

    // Destroyed-instance guard
    if (!emuInstance || emuInstance.destroyed || !emu || emu.destroyed) {
      if (!this._warnedDestroyed) {
        this._warnedDestroyed = true;
        log("warn", "[do_tick GUARD] Rejected: emulator instance is destroyed/null.");
      }
      return;
    }

    // Double-tick prevention
    if (this.isTickingNow) {
      if (!this._warnedDoubleTick) {
        this._warnedDoubleTick = true;
        log("warn", "[do_tick GUARD] Rejected: double tick loop detected.");
      }
      return;
    }

    this.isTickingNow = true;
    try {
      originalDoTick.call(this);
    } finally {
      this.isTickingNow = false;
    }
  };

  FProto.yield_callback = function(tickCount) {
    var emuInstance = this.emuInstance;
    var emu = emulator;

    // Termination barrier
    if (workerTerminating) {
      return;
    }

    // Destroyed-instance guard
    if (!emuInstance || emuInstance.destroyed || !emu || emu.destroyed) {
      if (!this._warnedYieldDestroyed) {
        this._warnedYieldDestroyed = true;
        log("warn", "[yield_callback GUARD] Rejected: emulator instance is destroyed/null.");
      }
      return;
    }

    originalYieldCallback.call(this, tickCount);
  };
}

function teardownTimersAndCallbacks(emuInstance) {
  log("info", "Tearing down timers and callbacks for emulator instance of generation " + emuInstance.generation);
  if (serialTimeoutId) {
    clearTimeout(serialTimeoutId);
    serialTimeoutId = null;
  }
  serialSendBuffer = [];
}

/**
 * Initialize the v86 emulator inside this worker.
 * @param {{ origin: string, version?: string, memory_size?: number, cmdline?: string }} payload
 */
async function handleInit(payload) {
  var origin = payload.origin;
  var version = payload.version || Date.now().toString();
  var t0 = Date.now();

  var initTelemetry = {
    wasmFetchDuration: 0,
    wasmCompileDuration: 0,
    biosLoadDuration: 0,
    filesystemImageLoadDuration: 0,
    initrdLoadDuration: 0,
    emulatorConstructorDuration: 0,
    cpuBootstrapDuration: 0,
    firstSerialOutputLatency: 0
  };

  var currentInitStage = "WASM_FETCH";
  function transitionInitStage(stage) {
    currentInitStage = stage;
    postToHost("INIT_STAGE", { stage: stage, ts: Date.now() });
  }

  // Set up progressive heartbeat telemetry
  var heartbeatInterval = setInterval(function() {
    var stats = {
      ts: Date.now(),
      stage: currentInitStage,
      jsHeapLimit: 0,
      totalJSHeap: 0,
      usedJSHeap: 0,
      deviceMemory: typeof navigator !== "undefined" ? navigator.deviceMemory : undefined,
      emulatorRam: payload.minimal ? 32 * 1024 * 1024 : payload.memory_size,
      emulatorVgaRam: payload.minimal ? 0 : payload.vga_memory_size
    };
    if (typeof performance !== "undefined" && performance.memory) {
      stats.jsHeapLimit = performance.memory.jsHeapSizeLimit;
      stats.totalJSHeap = performance.memory.totalJSHeapSize;
      stats.usedJSHeap = performance.memory.usedJSHeapSize;
    }
    postToHost("INIT_PROGRESS", stats);
  }, 1000);

  setLifecycleState("loading");
  WorkerProvisioner.cancel(); // Reset and clean up all state!
  transitionInitStage("WASM_FETCH");

  log("info", "Step 1/4: Loading libv86.js from " + origin + "/v86/libv86.js?v=" + version);

  try {
    importScripts(origin + "/v86/libv86.js?v=" + version);
  } catch (err) {
    clearInterval(heartbeatInterval);
    var msg = "Failed to load libv86.js: " + (err.message || String(err));
    log("error", msg);
    setLifecycleState("failed");
    postToHost("INIT_FAILURE", msg);
    return;
  }

  if (typeof V86 === "undefined") {
    clearInterval(heartbeatInterval);
    var errMsg = "V86 constructor not found after importScripts";
    log("error", errMsg);
    setLifecycleState("failed");
    postToHost("INIT_FAILURE", errMsg);
    return;
  }

  // Immediately wrap V86 constructor to intercept the internal ticker loop (F.prototype)
  // and install generation ownership guards, double-tick prevention, and destroyed-instance checks.
  wrapV86Constructor();

  log("info", "Step 1/4 completed: libv86.js loaded in " + (Date.now() - t0) + "ms");

  try {
    // Step 2: Preload Wasm Runtime
    log("info", "Step 2/4: Preloading and validating WebAssembly runtime...");
    var tWasmFetchStart = Date.now();
    var wasmBuffer = await loadAsset(origin + "/v86/v86.wasm?v=" + version, "v86.wasm");
    initTelemetry.wasmFetchDuration = Date.now() - tWasmFetchStart;

    transitionInitStage("WASM_COMPILE");
    var tWasmCompileStart = Date.now();
    try {
      await WebAssembly.compile(wasmBuffer);
    } catch (compileErr) {
      log("warn", "WebAssembly compilation check failed/warned: " + compileErr.message);
    }
    initTelemetry.wasmCompileDuration = Date.now() - tWasmCompileStart;

    var wasmBlob = new Blob([wasmBuffer], { type: "application/wasm" });
    var wasmBlobUrl = URL.createObjectURL(wasmBlob);
    log("info", "Step 2/4 completed: WebAssembly runtime loaded.");

    // Step 3: Load Boot Binaries
    transitionInitStage("BIOS_LOAD");
    var tBiosLoadStart = Date.now();

    log("info", "Loading System BIOS (seabios.bin)");
    var biosBuffer = await loadAsset(origin + "/v86/bios/seabios.bin?v=" + version, "seabios.bin");

    var vgaBiosBuffer = null;
    if (!payload.minimal) {
      log("info", "Loading VGA BIOS (vgabios.bin)");
      vgaBiosBuffer = await loadAsset(origin + "/v86/bios/vgabios.bin?v=" + version, "vgabios.bin");
    } else {
      log("info", "Minimal fallback boot active: skipping VGA BIOS fetch.");
    }
    initTelemetry.biosLoadDuration = Date.now() - tBiosLoadStart;

    transitionInitStage("FS_LOAD");
    var tFsLoadStart = Date.now();
    var bzImageBuffer = null;
    if (!payload.initial_state) {
      log("info", "Loading Linux kernel (bzImage)");
      bzImageBuffer = await loadAsset(origin + "/v86/images/bzImage?v=" + version, "bzImage", { autoAlign: true });
    } else {
      log("info", "Skipping kernel download: Restoring directly from snapshot.");
    }
    initTelemetry.filesystemImageLoadDuration = Date.now() - tFsLoadStart;
    initTelemetry.initrdLoadDuration = 0;

    var memoryLimit = payload.memory_size || 64 * 1024 * 1024;
    var vgaMemoryLimit = payload.vga_memory_size || 8 * 1024 * 1024;
    if (payload.minimal) {
      memoryLimit = 32 * 1024 * 1024; // 32MB
      vgaMemoryLimit = 0; // 0MB VGA
    }

    var config = {
      wasm_path: wasmBlobUrl,
      bios: { buffer: biosBuffer },
      vga_bios: vgaBiosBuffer ? { buffer: vgaBiosBuffer } : undefined,
      bzimage: bzImageBuffer ? { buffer: bzImageBuffer } : undefined,
      initial_state: payload.initial_state ? { buffer: payload.initial_state } : undefined,
      // filesystem:{} enables the 9p virtual filesystem, which is required for
      // create_file() to work. Without this the fs9p field on the emulator is null.
      filesystem: { baseurl: "", basefs: "" },
      autostart: true,
      cmdline: payload.cmdline || "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
      memory_size: memoryLimit,
      vga_memory_size: vgaMemoryLimit
    };

    // Step 4: Create emulator
    transitionInitStage("EMULATOR_CREATE");
    var tEmuCreateStart = Date.now();
    await createEmulator(config, self);
    initTelemetry.emulatorConstructorDuration = Date.now() - tEmuCreateStart;

    transitionInitStage("CPU_BOOT");
    var tCpuBootStart = Date.now();

    // Set up serial output listener to capture first serial byte received
    var firstByteReceived = false;
    var firstByteListener = function(byte) {
      if (firstByteReceived) return;
      firstByteReceived = true;
      initTelemetry.firstSerialOutputLatency = Date.now() - t0;
      initTelemetry.cpuBootstrapDuration = Date.now() - tCpuBootStart;
      log("info", "[TELEMETRY] First serial byte latency: " + initTelemetry.firstSerialOutputLatency + "ms, CPU bootstrap: " + initTelemetry.cpuBootstrapDuration + "ms");
      transitionInitStage("SERIAL_READY");
      postToHost("INIT_TELEMETRY", initTelemetry);
      if (emulator) {
        try {
          emulator.remove_listener("serial0-output-byte", firstByteListener);
        } catch (e) {
          // ignore
        }
      }
    };
    if (emulator) {
      emulator.add_listener("serial0-output-byte", firstByteListener);
    }

    clearInterval(heartbeatInterval);
    postToHost("INIT_SUCCESS", {
      hasSerial1: !!(SerialChannelManager.ports['1'] && SerialChannelManager.ports['1'].ready)
    });
    if (payload.initial_state) {
      log("info", "v86 emulator successfully restored from snapshot. Transitioning to ready...");
      setLifecycleState("ready");
    } else {
      log("info", "v86 emulator successfully created. Transitioned to booting guest...");
      setLifecycleState("booting");
    }
  } catch (err) {
    clearInterval(heartbeatInterval);
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
