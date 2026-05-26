// src/vm/emulatorManager.ts
import { VMLifecycleManager } from "./vmLifecycle";
import { ResourceLimitsValidator } from "./resourceLimits";
import { VMSessionConfig, VMStateName, VMSnapshotMetadata } from "../lib/types";
import { Logger } from "../lib/logger";
import { VMInitializationError } from "../lib/errors";
import { GUEST_INSPECT_SCRIPT } from "./inspect";
import { TerminalHealthMonitor } from "./healthMonitor";
import { UnifiedTimeoutManager } from "./timeoutManager";
import { ProvisioningController } from "./provisioning";
import { RecoveryOrchestrator, RecoveryStage } from "./recoveryOrchestrator";
import { TransportCoordinator } from "./transportCoordinator";

// ─── Async Mutex ────────────────────────────────────────────────────────────
// Serializes all lifecycle operations into a FIFO queue.
// Only one lifecycle action can execute at a time.
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  public acquire(): Promise<() => void> {
    let release: () => void;
    const prev = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prev.then(() => release!);
  }
}

// ─── Emulator Action Types ──────────────────────────────────────────────────
// Every lifecycle intent is expressed as a typed action dispatched through
// the central gate. No subsystem may mutate lifecycle state directly.
export type EmulatorAction =
  | { type: "START"; origin: string; onSerial: (data: string) => void; onState: (state: string) => void; initialState?: ArrayBuffer }
  | { type: "STOP" }
  | { type: "RECOVER_SHELL" }
  | { type: "SOFT_REBOOT" }
  | { type: "COLD_BOOT" }
  | { type: "REATTACH"; onSerial: (data: string) => void; onState: (state: string) => void }
  | { type: "DETACH" }
  | { type: "RESET"; origin: string; onSerial: (data: string) => void; onState: (state: string) => void };

// ─── Action validation gates ────────────────────────────────────────────────
// Maps each action type to the set of lifecycle states from which it is valid.
const ACTION_VALID_FROM: Record<EmulatorAction["type"], Set<VMStateName> | "always" | "alive"> = {
  START:         new Set<VMStateName>(["idle", "stopped", "error"]),
  STOP:          new Set<VMStateName>(["loading", "booting", "provisioning", "running", "stopping"]),
  RECOVER_SHELL: "alive",
  SOFT_REBOOT:   "alive",
  COLD_BOOT:     "alive",
  REATTACH:      "always",
  DETACH:        "always",
  RESET:         "always",
};

function isActionAllowed(action: EmulatorAction, currentState: VMStateName, isAlive: boolean): boolean {
  const rule = ACTION_VALID_FROM[action.type];
  if (rule === "always") return true;
  if (rule === "alive") return isAlive;
  return rule.has(currentState);
}

export class VMController {
  private static activeInstance: VMController | null = null;

  public static getActiveInstance(): VMController | null {
    return VMController.activeInstance;
  }

  public static setActiveInstance(instance: VMController | null): void {
    VMController.activeInstance = instance;
  }

  private transport: TransportCoordinator;
  private lifecycle: VMLifecycleManager;
  private config: VMSessionConfig;
  private onSerialOutput: ((data: string) => void) | null = null;
  private onStateChange: ((state: string) => void) | null = null;

  private saveStateResolver: ((buffer: ArrayBuffer) => void) | null = null;
  private saveStateRejecter: ((err: Error) => void) | null = null;
  private serialHistory: string = "";

  private wasRestoredFromSnapshot = false;
  private savedState: ArrayBuffer | null = null;

  private lastInputTimestamp = Date.now();
  private lastSerialOutputTimestamp = Date.now();
  private lastRestoreTimestamp = 0;
  private healthMonitor: TerminalHealthMonitor | null = null;

  // New modules
  private timeouts: UnifiedTimeoutManager;
  private provisioning: ProvisioningController;
  private orchestrator: RecoveryOrchestrator;

  // Provisioning matching buffer
  private provisioningSearchBuffer = "";

  // Initialization mutex (legacy — kept for _doStart abort signal)
  private initPromise: Promise<void> | null = null;
  private initAbortController: AbortController | null = null;

  // ─── Single-Authority Lifecycle Gate ─────────────────────────────────────
  private lifecycleMutex = new AsyncMutex();
  private actionToken = 0;

  constructor(config: Partial<VMSessionConfig> = {}) {
    this.transport = new TransportCoordinator();
    this.lifecycle = new VMLifecycleManager();
    this.config = ResourceLimitsValidator.validate(config);

    // Initialize unified timeout manager
    this.timeouts = new UnifiedTimeoutManager();

    // Initialize provisioning controller
    this.provisioning = new ProvisioningController(
      (state) => this.lifecycle.transitionProvisioningTo(state, "ProvisioningController"),
      (port, data) => this.sendProgrammaticInput(port, data)
    );

    // Initialize recovery orchestrator
    // Recovery actions are now routed through dispatch() — no direct lifecycle mutation.
    this.orchestrator = new RecoveryOrchestrator(
      this.timeouts,
      (stage) => this.handleRecoveryAction(stage),
      (state) => this.lifecycle.transitionRecoveryTo(state, "RecoveryOrchestrator")
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DISPATCH — The single entry point for all lifecycle mutations.
  // All external callers must use this method. Concurrent dispatches are
  // serialized by the AsyncMutex. Each dispatch receives a monotonically-
  // increasing action token; if a newer action supersedes, the stale token
  // causes early-exit from async continuations.
  // ═══════════════════════════════════════════════════════════════════════════
  public async dispatch(action: EmulatorAction): Promise<void> {
    const token = ++this.actionToken;
    const currentState = this.lifecycle.getState().state;
    const alive = this.lifecycle.isAlive();

    // Pre-validation: check if this action is valid from the current state.
    // RESET is always allowed; it forces a stop before restarting.
    if (!isActionAllowed(action, currentState, alive)) {
      Logger.warn(
        "VM",
        `[DISPATCH REJECTED] Action '${action.type}' is not valid from state '${currentState}'. ` +
        `Token #${token}. Ignoring.`
      );
      return;
    }

    Logger.info("VM", `[DISPATCH] Queuing action '${action.type}' (token #${token}) from state '${currentState}'`);

    const release = await this.lifecycleMutex.acquire();
    try {
      // Stale-guard: if a newer action was dispatched while we waited for the mutex,
      // this action is superseded and should be silently dropped.
      if (token !== this.actionToken) {
        Logger.info("VM", `[DISPATCH STALE] Action '${action.type}' (token #${token}) superseded by token #${this.actionToken}. Dropping.`);
        return;
      }

      Logger.info("VM", `[DISPATCH EXECUTING] Action '${action.type}' (token #${token})`);

      switch (action.type) {
        case "START":
          await this._dispatchStart(action.origin, action.onSerial, action.onState, action.initialState, token);
          break;

        case "STOP":
          await this._dispatchStop();
          break;

        case "RECOVER_SHELL":
          await this._dispatchRecoverShell(token);
          break;

        case "SOFT_REBOOT":
          await this._dispatchSoftReboot();
          break;

        case "COLD_BOOT":
          await this._dispatchColdBoot(token);
          break;

        case "REATTACH":
          this._dispatchReattach(action.onSerial, action.onState);
          break;

        case "DETACH":
          this._dispatchDetach();
          break;

        case "RESET":
          await this._dispatchReset(action.origin, action.onSerial, action.onState, token);
          break;
      }
    } catch (err) {
      Logger.error("VM", `[DISPATCH ERROR] Action '${action.type}' (token #${token}) threw:`, err);
      throw err;
    } finally {
      release();
    }
  }

  // ─── Stale-guard helper ─────────────────────────────────────────────────
  private isStaleAction(token: number): boolean {
    if (token !== this.actionToken) {
      Logger.info("VM", `[STALE GUARD] Token #${token} is stale (current: #${this.actionToken}). Aborting continuation.`);
      return true;
    }
    return false;
  }

  // ─── Dispatch implementations ───────────────────────────────────────────

  private async _dispatchStart(
    origin: string,
    onSerial: (data: string) => void,
    onState: (state: string) => void,
    initialState: ArrayBuffer | undefined,
    token: number
  ): Promise<void> {
    // If already alive, stop first
    if (this.lifecycle.isAlive()) {
      Logger.warn("VM", "VM already running. Destroying it before starting new session.");
      await this._internalStop();
      if (this.isStaleAction(token)) return;
    }

    this.initAbortController = new AbortController();
    const abortSignal = this.initAbortController.signal;

    this.initPromise = this._doStart(origin, onSerial, onState, initialState, abortSignal);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
      this.initAbortController = null;
    }
  }

  private async _dispatchStop(): Promise<void> {
    await this._internalStop();
  }

  private async _dispatchRecoverShell(token: number): Promise<void> {
    const activeOnSerial = this.onSerialOutput;
    const activeOnState = this.onStateChange;

    if (activeOnSerial && activeOnState) {
      await this._internalStop();
      if (this.isStaleAction(token)) return;

      await new Promise(resolve => setTimeout(resolve, 1500));
      if (this.isStaleAction(token)) return;

      // Perform fresh initialization
      this.initAbortController = new AbortController();
      const abortSignal = this.initAbortController.signal;
      this.initPromise = this._doStart(
        window.location.origin,
        activeOnSerial,
        activeOnState,
        this.savedState || undefined,
        abortSignal
      );
      try {
        await this.initPromise;
      } finally {
        this.initPromise = null;
        this.initAbortController = null;
      }
    }
  }

  private async _dispatchSoftReboot(): Promise<void> {
    Logger.info("VM", "Recovery [Stage 4]: Performing VM soft reboot via dispatch...");
    if (this.onSerialOutput) {
      this.onSerialOutput("\r\n\x1b[1;31m[Recovery] Guest CPU stalled. Rebooting VM...\x1b[0m\r\n");
    }
    this.transport.post("RESTART");
  }

  private async _dispatchColdBoot(token: number): Promise<void> {
    Logger.info("VM", "Recovery [Stage 5]: Triggering cold boot fallback via dispatch...");
    if (this.onSerialOutput) {
      this.onSerialOutput("\r\n\x1b[1;31m[Recovery] All recovery exhausted. Cold booting guest VM...\x1b[0m\r\n");
    }
    this.savedState = null;
    this.wasRestoredFromSnapshot = false;

    // Full shell recovery (stop → delay → start)
    await this._dispatchRecoverShell(token);
  }

  private _dispatchReattach(
    onSerial: (data: string) => void,
    onState: (state: string) => void
  ): void {
    Logger.info("VM", "Reattaching listeners to active VM session");
    this.onSerialOutput = onSerial;
    this.onStateChange = onState;
    onState(this.lifecycle.getState().state);

    this.lifecycle.transitionTerminalTo("attached", "VMController.reattach");
    if (this.lifecycle.getState().state === "running") {
      this.lifecycle.transitionTerminalTo("interactive", "VMController.reattach");
    }
  }

  private _dispatchDetach(): void {
    Logger.info("VM", "Detaching listeners from active VM session");
    this.onSerialOutput = null;
    this.onStateChange = null;
    this.lifecycle.transitionTerminalTo("detached", "VMController.detach");
  }

  private async _dispatchReset(
    origin: string,
    onSerial: (data: string) => void,
    onState: (state: string) => void,
    token: number
  ): Promise<void> {
    Logger.info("VM", "[DISPATCH] Executing RESET: force stop + clear snapshot + cold boot.");
    
    // Force stop regardless of state
    if (this.lifecycle.isAlive() || this.lifecycle.getState().state !== "idle") {
      await this._internalStop();
      if (this.isStaleAction(token)) return;
    }

    // Clear snapshot
    this.savedState = null;
    this.wasRestoredFromSnapshot = false;
    this.serialHistory = "";

    // Cold start
    this.initAbortController = new AbortController();
    const abortSignal = this.initAbortController.signal;
    this.initPromise = this._doStart(origin, onSerial, onState, undefined, abortSignal);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
      this.initAbortController = null;
    }
  }

  // ─── Internal stop (no mutex, no dispatch — used inside dispatch impls) ─
  private async _internalStop(): Promise<void> {
    Logger.info("VM", "Stopping guest VM session...");

    if (this.initAbortController) {
      this.initAbortController.abort();
    }

    this.timeouts.clearAll();
    this.transport.terminate();
    this.orchestrator.reset();
    this.transitionState("stopped", "VMController.stop");
    this.lifecycle.transitionTerminalTo("detached", "VMController.stop");
    this.onSerialOutput = null;
    this.onStateChange = null;
    this.saveStateResolver = null;
    this.saveStateRejecter = null;
    if (VMController.getActiveInstance() === this) {
      VMController.setActiveInstance(null);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — Legacy methods that delegate to dispatch()
  // These exist for backward compatibility. All paths go through dispatch().
  // ═══════════════════════════════════════════════════════════════════════════

  public async start(
    origin: string,
    onSerial: (data: string) => void,
    onState: (state: string) => void,
    initialState?: ArrayBuffer
  ): Promise<void> {
    return this.dispatch({ type: "START", origin, onSerial, onState, initialState });
  }

  public async stop(): Promise<void> {
    return this.dispatch({ type: "STOP" });
  }

  public reattach(
    onSerial: (data: string) => void,
    onState: (state: string) => void
  ): void {
    // Reattach is synchronous and lightweight — dispatch is async but we fire-and-forget
    this.dispatch({ type: "REATTACH", onSerial, onState });
  }

  public detach(): void {
    this.dispatch({ type: "DETACH" });
  }

  public async recoverShell(): Promise<void> {
    return this.dispatch({ type: "RECOVER_SHELL" });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL IMPLEMENTATION — Boot, serial lifecycle, health monitoring
  // These are NOT called directly by external callers.
  // ═══════════════════════════════════════════════════════════════════════════

  private async _doStart(
    origin: string,
    onSerial: (data: string) => void,
    onState: (state: string) => void,
    initialState: ArrayBuffer | undefined,
    abortSignal: AbortSignal
  ): Promise<void> {
    this.onSerialOutput = onSerial;
    this.onStateChange = onState;

    // Validate snapshot integrity before restore (gzip magic bytes: 0x1F 0x8B)
    if (initialState && initialState.byteLength > 2) {
      const bytes = new Uint8Array(initialState);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        this.wasRestoredFromSnapshot = true;
        this.savedState = initialState;
        this.lastRestoreTimestamp = Date.now();
        Logger.info("VM", `Valid snapshot found (gzip magic 0x1F 0x8B): size ${initialState.byteLength} bytes.`);
      } else {
        Logger.warn("VM", "Invalid snapshot magic bytes (expected gzip 0x1F 0x8B). Discarding corrupted state safely.");
        this.wasRestoredFromSnapshot = false;
        this.savedState = null;
      }
    } else {
      this.wasRestoredFromSnapshot = false;
      this.savedState = null;
      Logger.info("VM", "No snapshot found or empty snapshot. Clean cold boot.");
    }

    this.provisioning.reset();
    this.provisioningSearchBuffer = "";

    this.transitionState("loading", "VMController.start");
    this.lifecycle.transitionTerminalTo("detached", "VMController.start");

    const workerUrl = `${origin}/v86/v86-worker.js?v=${Date.now()}`;

    // Start boot watchdog timeout
    this.timeouts.register("boot_watchdog", this.config.timeoutMs, () => {
      const state = this.lifecycle.getState().state;
      if (state === "loading" || state === "booting") {
        if (Date.now() - this.lastSerialOutputTimestamp < 15000) {
          Logger.info("VM", "Boot progress active (serial output received). Extending boot timeout.");
          this.timeouts.extend("boot_watchdog", 15000);
          return;
        }
        Logger.warn("VM", `Boot watchdog triggered. Stalled in state: ${state}`);
        this.orchestrator.triggerRecovery("boot timeout exceeded");
      }
    });

    return new Promise((resolve, reject) => {
      if (abortSignal.aborted) {
        reject(new VMInitializationError("Start aborted"));
        return;
      }

      let resolved = false;

      this.transport.initialize(workerUrl, (type, payload) => {
        if (abortSignal.aborted) return;

        switch (type) {
          case "INIT_SUCCESS":
            break;

          case "INIT_FAILURE":
            this.timeouts.cancel("boot_watchdog");
            this.transitionState("error", "INIT_FAILURE");
            if (!resolved) {
              resolved = true;
              reject(new VMInitializationError(String(payload)));
            }
            break;

          case "SERIAL_OUT":
            if (this.lifecycle.getState().state === "booting") {
              if (!resolved) {
                resolved = true;
                resolve();
              }
            }
            const char = typeof payload === "number" ? String.fromCharCode(payload) : String(payload);
            this.serialHistory += char;
            if (this.serialHistory.length > 20000) {
              this.serialHistory = this.serialHistory.substring(this.serialHistory.length - 20000);
            }

            this.lastSerialOutputTimestamp = Date.now();

            // Match prompt and trigger provisioning
            this.handleSerialLifecycle(char);

            // Print character to UI terminal (hide outputs during silent provisioning)
            const provState = this.provisioning.getState();
            const isProvisioningActive = provState === "preparing" || provState === "transferring" || provState === "executing" || provState === "waiting_completion";
            if (this.onSerialOutput && !isProvisioningActive) {
              this.onSerialOutput(char);
            }
            break;

          case "SERIAL1_OUT":
            if (this.healthMonitor) {
              this.healthMonitor.handleSerial1Byte(payload as number);
            }
            break;

          case "PONG":
            {
              const pongPayload = payload as { cpu_running: boolean };
              if (this.healthMonitor) {
                this.healthMonitor.handlePong(pongPayload.cpu_running);
              }
            }
            break;

          case "SAVE_STATE_SUCCESS":
            if (this.saveStateResolver) {
              const res = this.saveStateResolver;
              this.saveStateResolver = null;
              this.saveStateRejecter = null;
              res(payload as ArrayBuffer);
            }
            break;

          case "SAVE_STATE_FAILURE":
            if (this.saveStateRejecter) {
              const rej = this.saveStateRejecter;
              this.saveStateResolver = null;
              this.saveStateRejecter = null;
              rej(new Error(String(payload)));
            }
            break;

          case "LOG":
            {
              const logData = payload as { level: string; msg: string };
              if (logData.level === "error") {
                Logger.error("VM", logData.msg);
              } else if (logData.level === "warn") {
                Logger.warn("VM", logData.msg);
              } else {
                Logger.debug("VM", logData.msg);
              }
            }
            break;

          case "STATE_CHANGED":
            {
              const rawState = payload as string;
              let mappedState: VMStateName;
              if (rawState === "failed") {
                mappedState = "error";
              } else if (rawState === "destroyed") {
                mappedState = "stopped";
              } else {
                mappedState = rawState as VMStateName;
              }
              this.transitionState(mappedState, "worker STATE_CHANGED", true, "STATE_CHANGED");
            }
            break;
        }
      }).then(() => {
        if (abortSignal.aborted) return;
        Logger.info("VM", "Worker is ready. Dispatching INIT configuration...");
        this.transport.post("INIT", {
          origin,
          memory_size: this.config.memoryLimitBytes,
          vga_memory_size: this.config.vgaMemoryLimitBytes,
          version: Date.now().toString(),
          initial_state: undefined,
        });
      }).catch((err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  private handleSerialLifecycle(char: string): void {
    if (this.provisioning.getState() === "completed") return;

    this.provisioningSearchBuffer += char;
    if (this.provisioningSearchBuffer.length > 256) {
      this.provisioningSearchBuffer = this.provisioningSearchBuffer.substring(this.provisioningSearchBuffer.length - 256);
    }

    const hasRootPrompt = this.provisioningSearchBuffer.endsWith("~% ") || 
                          this.provisioningSearchBuffer.endsWith("# ") || 
                          this.provisioningSearchBuffer.endsWith("~# ");
    const sentinelMatch = this.provisioningSearchBuffer.match(/PROVISIONING_COMPLETE:(\d+)/);

    if (hasRootPrompt && this.provisioning.getState() === "idle") {
      this.timeouts.cancel("boot_watchdog");
      this.transitionState("provisioning", "handleSerialLifecycle");
      this.lifecycle.transitionTerminalTo("recovering", "handleSerialLifecycle");

      Logger.info("VM", "[PROVISIONING] Root prompt detected. Starting environment provisioning...");

      if (this.onSerialOutput) {
        this.onSerialOutput("\r\n\x1b[1;33m[VM] Provisioning user environment silently...\x1b[0m\r\n");
      }

      let restoreCmd = "";
      if (this.savedState) {
        try {
          const backupB64 = this.arrayBufferToBase64(this.savedState);
          restoreCmd = `cat << 'EOF' > /tmp/fs.tar.gz.b64\n${backupB64}\nEOF\nbase64 -d /tmp/fs.tar.gz.b64 | tar -xzf - -C /home/user 2>/dev/null\nrm -f /tmp/fs.tar.gz.b64\n`;
        } catch (e) {
          Logger.error("VM", "Failed to generate restore command from backup:", e);
        }
      }

      // Provisioning timeout guard: 45 seconds to finish provisioning
      this.timeouts.register("provisioning_watchdog", 45000, () => {
        const state = this.provisioning.getState();
        if (state === "preparing" || state === "transferring" || state === "executing" || state === "waiting_completion") {
          Logger.warn("VM", `Provisioning watchdog triggered. Provisioning stalled in state: ${state}.`);
          this.provisioning.handleFailure();
          this.orchestrator.triggerRecovery("provisioning timeout exceeded");
        }
      });

      this.provisioning.startProvisioning(restoreCmd, GUEST_INSPECT_SCRIPT, this.transport.hasSerial1Support());

    } else if (sentinelMatch && this.provisioning.getState() === "waiting_completion") {
      const execId = parseInt(sentinelMatch[1], 10);
      this.timeouts.cancel("provisioning_watchdog");
      this.provisioningSearchBuffer = "";

      this.provisioning.handleProvisioningComplete(execId);
      this.transitionState("running", "handleSerialLifecycle");
      this.lifecycle.transitionTerminalTo("interactive", "handleSerialLifecycle");

      Logger.info("VM", "[PROVISIONING] Complete. Guest VM shell running.");

      if (this.onSerialOutput) {
        this.onSerialOutput("\x1b[1;36mWelcome to the LinLearn Virtual Training Environment!\x1b[0m\r\n");
        this.onSerialOutput(" * System Sandbox: \x1b[1;32mActive (100% Secure, No host access)\x1b[0m\r\n");
        this.onSerialOutput(" * Active Profile: \x1b[1;33muser@linlearn\x1b[0m\r\n\r\n");
        this.onSerialOutput("Try running: \x1b[1;33mcd Projects\x1b[0m, \x1b[1;33mtouch file.txt\x1b[0m, or explore folders.\r\n\r\n");
      }

      // Tell orchestrator we are healthy and start health monitor
      this.orchestrator.reportHealthy();
      this.startHealthMonitoring();
    }
  }

  // ─── Recovery action handler (called by RecoveryOrchestrator) ───────────
  // Stages that mutate lifecycle (SERIAL_RECONNECT, VM_SOFT_REBOOT,
  // COLD_BOOT_FALLBACK) now go through dispatch(). TTY_REPAIR and
  // SHELL_RESTART are non-lifecycle transport posts and remain direct.
  private async handleRecoveryAction(stage: RecoveryStage): Promise<boolean> {
    this.transport.getGenerationManager().recordRecoveryEscalation(RecoveryStage[stage]);
    switch (stage) {
      case RecoveryStage.TTY_REPAIR:
        if (!this.transport.hasSerial1Support()) {
          Logger.warn("VM", "[Recovery] Skipping TTY_REPAIR: serial1 is unsupported.");
          return false;
        }
        Logger.info("VM", "Recovery [Stage 1]: Attempting out-of-band TTY repair via serial1...");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;33m[Recovery] Repairing terminal settings...\x1b[0m\r\n");
        }
        await this.sendProgrammaticInput(1, "RECOVER_TTY\n");
        return true;

      case RecoveryStage.SHELL_RESTART:
        if (!this.transport.hasSerial1Support()) {
          Logger.warn("VM", "[Recovery] Skipping SHELL_RESTART: serial1 is unsupported.");
          return false;
        }
        Logger.info("VM", "Recovery [Stage 2]: Restarting user shell process...");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;33m[Recovery] Shell unresponsive. Restarting interactive session...\x1b[0m\r\n");
        }
        await this.sendProgrammaticInput(1, "RESTART_SHELL\n");
        return true;

      case RecoveryStage.SERIAL_RECONNECT:
        Logger.info("VM", "Recovery [Stage 3]: Dispatching RECOVER_SHELL through lifecycle gate...");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;31m[Recovery] Serial connection stalled. Reconnecting serial worker...\x1b[0m\r\n");
        }
        await this.dispatch({ type: "RECOVER_SHELL" });
        return true;

      case RecoveryStage.VM_SOFT_REBOOT:
        Logger.info("VM", "Recovery [Stage 4]: Dispatching SOFT_REBOOT through lifecycle gate...");
        await this.dispatch({ type: "SOFT_REBOOT" });
        return true;

      case RecoveryStage.COLD_BOOT_FALLBACK:
        Logger.info("VM", "Recovery [Stage 5]: Dispatching COLD_BOOT through lifecycle gate...");
        await this.dispatch({ type: "COLD_BOOT" });
        return true;

      case RecoveryStage.NONE:
      default:
        Logger.warn("VM", "Recovery suspended or unknown stage executed.");
        await this.dispatch({ type: "STOP" });
        return false;
    }
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  public getSerialHistory(): string {
    return this.serialHistory;
  }

  public clearSerialHistory(): void {
    this.serialHistory = "";
  }

  public async saveState(): Promise<ArrayBuffer> {
    const currentState = this.lifecycle.getState().state;
    if (currentState !== "running") {
      throw new Error(`Cannot save state while VM is in state: ${currentState}`);
    }

    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.saveStateResolver = resolve;
      this.saveStateRejecter = reject;

      this.transport.post("SAVE_STATE");

      this.timeouts.register("save_state_timeout", 10000, () => {
        if (this.saveStateRejecter === reject) {
          this.saveStateResolver = null;
          this.saveStateRejecter = null;
          reject(new Error("VM snapshot save operation timed out."));
        }
      });
    });
  }

  public sendInput(data: string): void {
    // Interactivity is decoupled: keyboard input allowed when VM is booting/provisioning/running
    // sendInput does NOT mutate lifecycle — no dispatch() needed.
    const status = this.lifecycle.getState().state;
    if (status !== "running" && status !== "booting" && status !== "provisioning") {
      Logger.warn("VM", `Refusing input: VM in state: ${status}`);
      return;
    }
    this.lastInputTimestamp = Date.now();
    try {
      this.transport.post("INPUT", data);
      
      // Heartbeat feedback: if a user types something, they are active, restore orchestrator health
      if (this.orchestrator.getRecoveryState() !== "healthy") {
        this.orchestrator.reportHealthy();
      }
    } catch (err: unknown) {
      if (this.healthMonitor) {
        this.healthMonitor.reportSerialError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  public sendProgrammaticInput(port: number, data: string): Promise<void> {
    const stateName = this.lifecycle.getState().state;
    if (stateName !== "running" && stateName !== "booting" && stateName !== "provisioning") {
      Logger.warn("VM", `Refusing programmatic input in non-interactive state: ${stateName}`);
      return Promise.resolve();
    }
    return this.transport.send(port, data);
  }

  public transitionState(
    newState: VMStateName,
    source?: string,
    fromWorker: boolean = false,
    workerEvent?: string,
    snapshot?: VMSnapshotMetadata,
  ): boolean {
    const currentState = this.lifecycle.getState().state;
    if (currentState === newState) return true;

    const succeeded = this.lifecycle.transitionTo(newState, undefined, source, workerEvent, snapshot);
    if (!succeeded) {
      return false;
    }

    if (this.onStateChange) this.onStateChange(newState);

    if (!fromWorker) {
      let workerState: string = newState;
      if (newState === "stopped") workerState = "destroyed";
      if (newState === "error") workerState = "failed";
      this.transport.post("SET_STATE", workerState);
    }

    // Coordinated timeout updates on state transition
    if (newState === "running") {
      this.timeouts.cancel("boot_watchdog");
      this.timeouts.cancel("provisioning_watchdog");
      this.startHealthMonitoring();
    } else if (newState === "stopped" || newState === "error") {
      this.timeouts.clearAll();
      this.stopHealthMonitoring();
    }

    return true;
  }

  public requestProvisioningTransition(): void {
    this.transport.post("SET_PROVISIONING");
  }

  public requestRunningTransition(): void {
    this.transport.post("SET_RUNNING");
  }

  public getLifecycleState() {
    return this.lifecycle.getState();
  }

  public getFullLifecycleState() {
    return this.lifecycle.getFullState();
  }

  public wasRestored(): boolean {
    return this.wasRestoredFromSnapshot;
  }

  public clearWasRestored(): void {
    this.wasRestoredFromSnapshot = false;
  }

  private startHealthMonitoring(): void {
    this.stopHealthMonitoring();
    Logger.info("VM", "Starting health monitoring...");
    this.healthMonitor = new TerminalHealthMonitor(
      (type, payload) => this.transport.post(type, payload),
      (reason) => this.orchestrator.triggerRecovery(reason || "health check failure"),
      () => Math.max(this.lastInputTimestamp, this.lastSerialOutputTimestamp),
      this.transport.hasSerial1Support()
    );
    this.healthMonitor.start();
  }

  private stopHealthMonitoring(): void {
    if (this.healthMonitor) {
      this.healthMonitor.stop();
      this.healthMonitor = null;
    }
  }
}
