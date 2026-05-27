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
import { RecoveryOrchestrator, RecoveryStage, VMHealthStatus } from "./recoveryOrchestrator";
import { TransportCoordinator } from "./transportCoordinator";
import { WorkerBridgeState } from "./workerBridge";

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

export class RuntimeSteadyStateValidator {
  constructor(private controller: VMController) {}

  public async validate(): Promise<{ passed: boolean; reason?: string }> {
    const health = this.controller.getHealthStatus();
    
    // 1. Worker alive & responding
    if (!health.workerResponding) {
      return { passed: false, reason: "Worker is not responding or not in READY state." };
    }
    
    // 2. Bridge ready
    if (health.workerState !== WorkerBridgeState.READY) {
      return { passed: false, reason: `Bridge is not in READY state. Current state: ${health.workerState}` };
    }

    // 3. Shell responsive
    const shellResponsive = await this.controller.probeShellResponsiveness();
    if (!shellResponsive) {
      return { passed: false, reason: "Shell failed responsiveness probe." };
    }

    // 4. Terminal interactive (listeners registered)
    const fullState = this.controller.getFullLifecycleState();
    if (fullState.terminal !== "attached" && fullState.terminal !== "interactive" && fullState.terminal !== "recovering") {
      return { passed: false, reason: `Terminal state is not active. Current: ${fullState.terminal}` };
    }

    // 5. Active generation valid
    const access = this.controller as unknown as { transport: TransportCoordinator };
    const activeGen = access.transport.getGenerationManager().getActiveGeneration();
    if (!activeGen || !activeGen.isValid) {
      return { passed: false, reason: "Active worker generation is invalid." };
    }

    // 6. No pending recovery
    const accessOrch = this.controller as unknown as { orchestrator: RecoveryOrchestrator };
    if (accessOrch.orchestrator.getStage() !== RecoveryStage.NONE) {
      return { passed: false, reason: `Recovery orchestrator is actively executing recovery stage: ${RecoveryStage[accessOrch.orchestrator.getStage()]}` };
    }

    // 7. Provisioning completed
    if (fullState.provisioning !== "completed" && fullState.provisioning !== "recovering" && fullState.provisioning !== "waiting_completion") {
      return { passed: false, reason: `Provisioning state is not completed. Current: ${fullState.provisioning}` };
    }

    return { passed: true };
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
  STOP:          new Set<VMStateName>(["loading", "booting", "provisioning", "shell_ready", "terminal_ready", "running", "stopping"]),
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

  // INIT path tracing and startup telemetry
  private firstSerialByteReceived = false;
  private initDispatchTimestamp = 0;
  private initCompleteTimestamp = 0;
  private firstStateChangedTimestamp = 0;
  private firstSerialOutputTimestamp = 0;

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
    this.transport = new TransportCoordinator(() => {
      const state = this.lifecycle.getState().state;
      return state !== "loading" && state !== "booting" && state !== "provisioning" && state !== "shell_ready" && state !== "terminal_ready";
    });
    this.transport.setSerialAttachedChecker(() => {
      return this.lifecycle.getFullState().terminal !== "detached";
    });
    this.lifecycle = new VMLifecycleManager();
    this.config = ResourceLimitsValidator.validate(config);

    // Initialize unified timeout manager
    this.timeouts = new UnifiedTimeoutManager();

    // Initialize provisioning controller
    // onPostMessage routes PROVISION_* messages directly through the bridge
    // message channel, bypassing the serial write queue entirely.
    this.provisioning = new ProvisioningController(
      (state) => this.lifecycle.transitionProvisioningTo(state, "ProvisioningController"),
      (type, payload) => this.transport.postProvision(type, payload)
    );

    // Initialize recovery orchestrator
    // Recovery actions are now routed through dispatch() — no direct lifecycle mutation.
    this.orchestrator = new RecoveryOrchestrator(
      this.timeouts,
      () => this.getHealthStatus(),
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
    const state = this.lifecycle.getState().state;
    if (this.initPromise || state === "loading" || state === "booting" || state === "provisioning" || state === "shell_ready" || state === "terminal_ready" || state === "running") {
      Logger.warn("VM", `[START IGNORED] VM is already starting, booting, or active (state: ${state}). Ignoring duplicate START.`);
      this.orchestrator.recordDuplicateStartSuppression();
      return;
    }

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
    Logger.info("VM", `[RECOVER_SHELL] Repairing shell session and TTY without restarting emulator runtime (token #${token}).`);
    
    // 1. Reconnect terminal (rebind transport listeners and reattach terminal)
    this.transport.reconnectSerial();
    if (this.onSerialOutput && this.onStateChange) {
      this._dispatchReattach(this.onSerialOutput, this.onStateChange);
    }
    
    // 2. Restart TTY and repair shell session
    if (this.transport.hasSerial1Support()) {
      Logger.info("VM", "[RECOVER_SHELL] Sending RECOVER_TTY and RESTART_SHELL programmatically via serial1...");
      await this.sendProgrammaticInput(1, "RECOVER_TTY\n");
      await this.sendProgrammaticInput(1, "RESTART_SHELL\n");
    } else {
      Logger.warn("VM", "[RECOVER_SHELL] Serial1 not supported, sending Ctrl+C and resetting TTY via serial0...");
      this.sendInput("\x03\rreset\r");
    }
    
    // 3. Refresh provisioning channel if in provisioning state
    const provState = this.provisioning.getState();
    if (provState !== "idle" && provState !== "completed") {
      Logger.info("VM", `[RECOVER_SHELL] Active provisioning state detected: '${provState}'. Refreshing provisioning channel...`);
      this.attemptNonDestructiveProvisioningRecovery();
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
    this.lifecycle.transitionTerminalTo("attached", "VMController.start");

    const workerUrl = `${origin}/v86/v86-worker.js?v=${Date.now()}`;

    // Start boot watchdog timeout
    this.timeouts.register("boot_watchdog", this.config.timeoutMs, async () => {
      const state = this.lifecycle.getState().state;
      if (state === "loading" || state === "booting") {
        if (Date.now() - this.lastSerialOutputTimestamp < 15000) {
          Logger.info("VM", "Boot progress active (serial output received). Extending boot timeout.");
          this.timeouts.extend("boot_watchdog", 15000);
          return;
        }
        
        // Probe shell responsiveness
        const shellResponsive = await this.probeShellResponsiveness();
        if (shellResponsive) {
          Logger.info("VM", "[BOOT WATCHDOG] Shell responded to probe. Extending boot timeout.");
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
          case "INIT_ACK":
            this.timeouts.cancel("init_watchdog");
            this.timeouts.register("init_watchdog", 10000, async () => {
              const currentState = this.lifecycle.getState().state;
              if (currentState === "loading") {
                Logger.error("VM", "[INIT TIMEOUT] Worker received INIT but failed to complete asset loading / instantiation within 10s!");
                const activeGen = this.transport.getGenerationManager().getActiveGeneration();
                this.dumpInitDiagnostics(activeGen ? activeGen.id : 0);
              }
            });
            Logger.info("VM", `[INIT_ACK] Worker acknowledged INIT receipt for generation ${payload && typeof payload === "object" && "generation" in payload ? (payload as { generation: number }).generation : "unknown"}`);
            break;

          case "INIT_SUCCESS":
            this.timeouts.cancel("init_watchdog");
            this.initCompleteTimestamp = Date.now();
            Logger.info("VM", `[INIT_SUCCESS] Worker successfully initialized emulator. Latency: ${this.initCompleteTimestamp - this.initDispatchTimestamp}ms`);
            if (!resolved) {
              resolved = true;
              resolve();
            }
            break;

          case "INIT_FAILURE":
            this.timeouts.cancel("init_watchdog");
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
            if (!this.firstSerialByteReceived) {
              this.firstSerialByteReceived = true;
              this.firstSerialOutputTimestamp = Date.now();
              Logger.info("VM", `[SERIAL FIRST BYTE] First serial byte received: ${JSON.stringify(char)} at ${this.firstSerialOutputTimestamp}`);
            }

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

          case "PROVISION_ACK": {
            // Safely type the ACK payload using structural cast
            const ackTyped = payload as { type: string; execId: number; chunkIndex?: number };
            const activeGenForAck = this.transport.getGenerationManager().getActiveGeneration();
            const ackGenId = activeGenForAck ? activeGenForAck.id : 0;
            this.provisioning.handleProvisionAck(
              ackTyped as Parameters<typeof this.provisioning.handleProvisionAck>[0],
              ackGenId
            );
            break;
          }

          case "PROVISION_NACK": {
            const nackTyped = payload as { execId: number; chunkIndex?: number; reason: string };
            Logger.error("VM", `[PROVISIONING] PROVISION_NACK received: reason=${nackTyped.reason}, execId=${nackTyped.execId}`);
            this.provisioning.handleProvisionNack(
              nackTyped as Parameters<typeof this.provisioning.handleProvisionNack>[0]
            );
            // NACK during transfer triggers provisioning recovery
            const nackProvState = this.provisioning.getState();
            if (nackProvState === "transferring" || nackProvState === "executing" || nackProvState === "waiting_completion") {
              this.orchestrator.triggerRecovery("provisioning NACK: " + nackTyped.reason);
            }
            break;
          }

          case "PROVISION_READY": {
            // Worker has written the script to the VM filesystem.
            // Signal the provisioning controller to dispatch PROVISION_EXECUTE.
            const readyTyped = payload as { execId: number; generation: number; filePath: string };
            const activeGenForReady = this.transport.getGenerationManager().getActiveGeneration();
            const readyGenId = activeGenForReady ? activeGenForReady.id : 0;
            Logger.info("VM", `[PROVISIONING] PROVISION_READY received. filePath=${readyTyped.filePath}, execId=${readyTyped.execId}`);
            this.provisioning.handleProvisionReady(
              readyTyped as Parameters<typeof this.provisioning.handleProvisionReady>[0],
              readyGenId
            );
            break;
          }

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
              if (rawState === "booting" || rawState === "running") {
                this.timeouts.cancel("init_watchdog");
              }
              if (!this.firstStateChangedTimestamp) {
                this.firstStateChangedTimestamp = Date.now();
              }
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

        const activeGen = this.transport.getGenerationManager().getActiveGeneration();
        const activeGenId = activeGen ? activeGen.id : 0;
        const bridgeDiagnostics = activeGen?.bridge.getReadinessDiagnostics();

        Logger.info("VM", "[INIT PREFLIGHT DIAGNOSTICS]", {
          bridgeState: activeGen?.bridge.getState(),
          listenersAttached: bridgeDiagnostics?.listenersAttached,
          serialAttachState: this.lifecycle.getFullState().terminal,
          generationCommitted: bridgeDiagnostics?.generationCommitted,
          ownershipToken: activeGen?.ownershipToken,
          transportState: (this.transport as unknown as { state: unknown }).state,
          ts: Date.now()
        });

        Logger.info("VM", "Worker is ready. Dispatching INIT configuration...");
        
        this.initDispatchTimestamp = Date.now();
        
        // Register a 5-second watchdog for INIT_ACK
        this.timeouts.register("init_watchdog", 5000, async () => {
          const currentState = this.lifecycle.getState().state;
          if (currentState === "loading") {
            Logger.error("VM", "[INIT TIMEOUT] VM initialization stalled (no INIT_ACK or INIT_SUCCESS) for more than 5s!");
            this.dumpInitDiagnostics(activeGenId);
          }
        });

        this.transport.post("INIT", {
          origin,
          memory_size: this.config.memoryLimitBytes,
          vga_memory_size: this.config.vgaMemoryLimitBytes,
          version: Date.now().toString(),
          initial_state: this.savedState || undefined,
        });
      }).catch((err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  private dumpInitDiagnostics(activeGenId: number): void {
    const currentState = this.lifecycle.getState().state;
    const activeGen = this.transport.getGenerationManager().getActiveGeneration();
    const bridgeDiagnostics = activeGen?.bridge.getReadinessDiagnostics();

    // Determine which conditions failed
    const failedConditions: string[] = [];
    if (bridgeDiagnostics) {
      if (!bridgeDiagnostics.handshakeReceived) failedConditions.push("worker_handshake");
      if (!bridgeDiagnostics.listenersAttached) failedConditions.push("listeners_attached");
      if (!bridgeDiagnostics.serialInitialized) failedConditions.push("serial_initialized");
      if (!bridgeDiagnostics.generationCommitted) failedConditions.push("generation_committed");
    } else {
      failedConditions.push("no_active_bridge");
    }

    Logger.error("VM", "[INIT TIMEOUT DIAGNOSTICS]", {
      workerState: "loading",
      runtimeState: currentState,
      bridgeGeneration: activeGenId,
      bridgeState: activeGen?.bridge.getState(),
      failedReadinessConditions: failedConditions,
      bridgeReadinessDetails: bridgeDiagnostics,
      pendingDispatches: this.initPromise !== null,
      activeListeners: {
        hasSerialOutputListener: !!this.onSerialOutput,
        hasStateChangeListener: !!this.onStateChange,
      },
      serialAttachState: this.lifecycle.getFullState().terminal,
      unresolvedPromises: {
        hasInitPromise: !!this.initPromise,
        hasRecreatePromise: !!(this.transport as unknown as { state: { recreatePromise: Promise<void> | null } }).state.recreatePromise
      },
      ts: Date.now()
    });
  }

  private handleSerialLifecycle(char: string): void {
    if (this.provisioning.getState() === "completed") return;

    this.provisioningSearchBuffer += char;
    if (this.provisioningSearchBuffer.length > 512) {
      this.provisioningSearchBuffer = this.provisioningSearchBuffer.substring(this.provisioningSearchBuffer.length - 512);
    }

    const hasRootPrompt = this.provisioningSearchBuffer.endsWith("~% ") || 
                          this.provisioningSearchBuffer.endsWith("# ") || 
                          this.provisioningSearchBuffer.endsWith("~# ") ||
                          this.provisioningSearchBuffer.endsWith("root% ") ||
                          this.provisioningSearchBuffer.endsWith("% ");

    const activeGen = this.transport.getGenerationManager().getActiveGeneration();
    const activeGenId = activeGen ? activeGen.id : 0;
    const parserEvents = this.provisioning.getCompletionParser().feed(char);

    for (const event of parserEvents) {
      const execId = event.id;
      
      if (event.type === "heartbeat") {
        if (execId === this.provisioning.getExecutionId()) {
          this.provisioning.recordHeartbeat();
          // Extend the watchdog since the script is actively running
          this.timeouts.cancel("provisioning_watchdog");
          this.timeouts.register("provisioning_watchdog", 45000, () => {
            this._onProvisioningWatchdogFired();
          });
        }
      } else if (event.type === "exec_start") {
        if (execId === this.provisioning.getExecutionId()) {
          this.provisioning.handleExecStart(execId);
          // Extend the watchdog
          this.timeouts.cancel("provisioning_watchdog");
          this.timeouts.register("provisioning_watchdog", 45000, () => {
            this._onProvisioningWatchdogFired();
          });
        }
      } else if (event.type === "failed") {
        const provState = this.provisioning.getState();
        if (provState === "executing" || provState === "waiting_completion") {
          this.timeouts.cancel("provisioning_watchdog");
          Logger.error("VM", `[PROVISIONING] Failure marker parsed for execId=${execId}.`);
          this.provisioning.handleProvisioningFailed(execId, activeGenId);
          this.orchestrator.triggerRecovery("provisioning script failure parsed");
        }
      } else if (event.type === "complete") {
        const provState = this.provisioning.getState();
        if (provState === "executing" || provState === "waiting_completion") {
          this.timeouts.cancel("provisioning_watchdog");
          Logger.info("VM", `[PROVISIONING] Completion marker parsed for execId=${execId}. Transitioning to shell_ready & starting handshake.`);
          this.transitionState("shell_ready", "handleSerialLifecycle");
          void this.executeTerminalReadinessHandshake(execId);
        } else {
          Logger.warn("VM", `[PROVISIONING] Completion marker parsed but state is '${provState}' (not executing/waiting_completion). execId=${execId}`);
        }
      } else if (event.type === "shell_ready") {
        const state = this.lifecycle.getState().state;
        if (state === "shell_ready") {
          Logger.info("VM", `[Handshake] Deterministic SHELL_READY parsed for execId=${execId}. Transitioning to terminal_ready.`);
          this.transitionState("terminal_ready", "handleSerialLifecycle");
          void this.resolveTerminalReadinessConvergence(execId, activeGenId);
        } else {
          Logger.warn("VM", `[Handshake] SHELL_READY parsed but VM state is '${state}' (not shell_ready). execId=${execId}`);
        }
      }
    }

    // ── Boot ready: root prompt detected, start provisioning ──
    if (hasRootPrompt && this.provisioning.getState() === "idle") {
      this.timeouts.cancel("boot_watchdog");
      
      // Disable echo and canonical mode immediately to isolate the stream
      Logger.info("VM", "[PROVISIONING] Disabling serial echo and line discipline (stty -echo -icanon) immediately...");
      void this.sendProgrammaticInput(0, "stty -echo -icanon\n");

      this.transitionState("provisioning", "handleSerialLifecycle");
      this.lifecycle.transitionTerminalTo("recovering", "handleSerialLifecycle");

      Logger.info("VM", "[PROVISIONING] Root prompt detected. Starting atomic provisioning via PROVISION_* protocol...");

      if (this.onSerialOutput) {
        this.onSerialOutput("\r\n\x1b[1;33m[VM] Provisioning user environment silently...\x1b[0m\r\n");
      }

      // Dynamic provisioning timeout
      let timeoutMs = 45000;
      if (this.wasRestoredFromSnapshot) {
        timeoutMs = 60000;
      } else {
        timeoutMs = 75000;
      }
      if (this.orchestrator.getStage() > RecoveryStage.NONE) {
        timeoutMs += 15000;
      }

      this.timeouts.register("provisioning_watchdog", timeoutMs, () => {
        this._onProvisioningWatchdogFired();
      });

      // Pass the raw savedState ArrayBuffer directly — no base64 encoding.
      // The ProvisioningController will send it as a binary PROVISION_WRITE_BINARY
      // message that the worker writes via create_file().
      void this.provisioning.startProvisioning(
        this.savedState,
        GUEST_INSPECT_SCRIPT,
        this.transport.hasSerial1Support(),
        activeGenId
      );
    }
  }

  // ─── Provisioning watchdog handler ─────────────────────────────────────
  private async _onProvisioningWatchdogFired(): Promise<void> {
    const state = this.provisioning.getState();
    if (state === "preparing" || state === "transferring" || state === "executing" || state === "waiting_completion") {
      const diag = this.provisioning.getDiagnostics();
      
      // Print buffered output diagnostics
      const parserBuffer = (this.provisioning.getCompletionParser() as unknown as { buffer: string }).buffer;
      Logger.info("VM", `[PROVISIONING DIAGNOSTICS] Parser buffer: ${JSON.stringify(parserBuffer)}, Last 128 chars of serial: ${JSON.stringify(this.provisioningSearchBuffer.slice(-128))}`);
      
      // Probe shell responsiveness
      const shellResponsive = await this.probeShellResponsiveness();
      if (shellResponsive) {
        Logger.info("VM", "[PROVISIONING WATCHDOG] Shell is responsive to probe. Extending provisioning timeout instead of escalating.");
        this.timeouts.register("provisioning_watchdog", 15000, () => {
          this._onProvisioningWatchdogFired();
        });
        return;
      }

      Logger.error("VM", `[PROVISIONING WATCHDOG] Timeout fired. Diagnostics: ${JSON.stringify(diag)}`);
      Logger.error("VM", `[PROVISIONING WATCHDOG] Last 128 chars of serial buffer: ${JSON.stringify(this.provisioningSearchBuffer.slice(-128))}`);
      Logger.error("VM", `[PROVISIONING WATCHDOG] Serial forwarding active: ${!!this.onSerialOutput}, Runtime state: ${this.lifecycle.getState().state}`);
      this.provisioning.handleFailure();
      this.orchestrator.triggerRecovery("provisioning timeout exceeded");
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
        Logger.info("VM", "Recovery [Stage 3]: Reconnecting serial transport, rebinding listeners, and reattaching terminal...");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;33m[Recovery] Reconnecting serial transport...\x1b[0m\r\n");
        }
        
        // 1. Reconnect serial transport (rebind listeners in transport layer)
        this.transport.reconnectSerial();
        
        // 2. Reattach terminal listeners (without dispatching or destroying VM)
        if (this.onSerialOutput && this.onStateChange) {
          this._dispatchReattach(this.onSerialOutput, this.onStateChange);
        }
        
        // 3. Verify serial responsiveness: Send a PING to check worker CPU and serial message loop
        this.transport.post("PING");
        return true;

      case RecoveryStage.VM_SOFT_REBOOT:
        Logger.info("VM", "Recovery [Stage 4]: Dispatching SOFT_REBOOT through lifecycle gate...");
        await this.dispatch({ type: "SOFT_REBOOT" });
        return true;

      case RecoveryStage.COLD_BOOT_FALLBACK:
        Logger.info("VM", "Recovery [Stage 5]: Dispatching COLD_BOOT through lifecycle gate...");
        await this.dispatch({ type: "COLD_BOOT" });
        return true;

      case RecoveryStage.PROVISIONING_RECOVERY:
        Logger.info("VM", "Recovery [Stage 6]: Triggering non-destructive provisioning recovery...");
        this.attemptNonDestructiveProvisioningRecovery();
        return true;

      case RecoveryStage.NONE:
      default:
        Logger.warn("VM", "Recovery suspended or unknown stage executed.");
        await this.dispatch({ type: "STOP" });
        return false;
    }
  }

  public getHealthStatus(): VMHealthStatus {
    const activeGen = this.transport.getGenerationManager().getActiveGeneration();
    const bridge = activeGen ? activeGen.bridge : null;
    const workerState = bridge ? bridge.getState() : WorkerBridgeState.UNINITIALIZED;
    const cpuRunning = this.healthMonitor ? (this.healthMonitor as unknown as { isHealthy: boolean }).isHealthy : true;
    
    return {
      runtimeState: this.lifecycle.getState().state,
      provisioningState: this.provisioning.getState(),
      workerState,
      hasSerial1: this.transport.hasSerial1Support(),
      lastHeartbeatAgeMs: this.provisioning.getLastHeartbeatTimestamp() ? Date.now() - this.provisioning.getLastHeartbeatTimestamp() : Infinity,
      lastSerialOutputAgeMs: Date.now() - this.lastSerialOutputTimestamp,
      lastInputAgeMs: Date.now() - this.lastInputTimestamp,
      cpuRunning,
      workerResponding: activeGen ? activeGen.isValid && workerState === WorkerBridgeState.READY : false,
    };
  }

  private attemptNonDestructiveProvisioningRecovery(): void {
    const execId = this.provisioning.getExecutionId();
    Logger.info("VM", `[Provisioning Recovery] Attempting non-destructive recovery for execution ID ${execId}...`);
    
    // 1. Refresh serial listeners & reset parser
    this.provisioning.getCompletionParser().reset();
    this.transport.reconnectSerial();
    if (this.onSerialOutput && this.onStateChange) {
      this._dispatchReattach(this.onSerialOutput, this.onStateChange);
    }
    const queryCmd = `\nstty -echo; if [ -f /tmp/provision_${execId}.sh ]; then if ps | grep -v grep | grep -q "provision_${execId}.sh"; then echo "<<<PROTO:${execId}:5:HEARTBEAT>>>"; elif [ -f /tmp/provision_complete ]; then echo "<<<PROTO:${execId}:6:EXEC_COMPLETE>>>"; else echo "<<<PROTO:${execId}:7:FAIL:recovery_script_terminated>>>"; fi; else echo "<<<PROTO:${execId}:7:FAIL:recovery_script_not_found>>>"; fi\n`;
    
    // Send the query on serial0
    void this.sendProgrammaticInput(0, queryCmd);
    Logger.info("VM", `[Provisioning Recovery] Sent completion query command for execId=${execId}`);
  }

  public async probeShellResponsiveness(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const originalBuffer = this.serialHistory;
      const startOffset = originalBuffer.length;
      
      setTimeout(() => {
        const newContent = this.serialHistory.substring(startOffset);
        if (newContent.includes("**PONG**") || newContent.includes("**SHELL_READY**")) {
          resolve(true);
        } else {
          resolve(false);
        }
      }, 1000);

      // Send both probe commands
      void this.sendProgrammaticInput(0, "\necho '**PONG**'\necho '**SHELL_READY**'\n");
    });
  }

  private async executeTerminalReadinessHandshake(execId: number): Promise<void> {
    Logger.info("VM", `[Handshake] Sending PROVISIONING_ACK for execId=${execId}...`);
    
    // Register the handshake_watchdog timeout (5s)
    this.timeouts.register("handshake_watchdog", 5000, () => {
      const state = this.lifecycle.getState().state;
      if (state === "shell_ready") {
        Logger.error("VM", `[Handshake] Handshake watchdog fired! SHELL_READY marker was not received within 5 seconds for execId=${execId}.`);
        this.dumpConvergenceDiagnostics("Handshake watchdog timeout");
        this.orchestrator.triggerRecovery("provisioning completion handshake timed out");
      }
    });

    // Send ACK to guest VM so it exits the read loop and starts user login shell
    await this.sendProgrammaticInput(0, `PROVISIONING_ACK:${execId}\n`);
  }

  private async resolveTerminalReadinessConvergence(execId: number, activeGenId: number): Promise<void> {
    const startTime = Date.now();
    Logger.info("VM", `[Convergence] Resolving terminal readiness convergence. execId=${execId}, activeGenId=${activeGenId}`);

    // 1. Idle stabilization window (Requirement 11): 500ms
    Logger.info("VM", "[Convergence] Waiting for 500ms stabilization window...");
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (!this.lifecycle.isAlive() || this.lifecycle.getState().state !== "terminal_ready") {
      Logger.warn("VM", "[Convergence] VM left terminal_ready state during stabilization window.");
      return;
    }

    // 2. Terminal attach synchronization barrier (Requirement 4)
    // Wait for xterm attached, serial listeners active, stdin routing ready, output parser ready
    const listenersActive = this.onSerialOutput !== null && this.onStateChange !== null;
    const transportReady = this.transport.getGenerationManager().getActiveGeneration()?.isValid || false;
    const parserReady = !!this.provisioning.getCompletionParser();

    if (!listenersActive || !transportReady || !parserReady) {
      Logger.warn("VM", `[Convergence] Terminal attach barrier failed: listenersActive=${listenersActive}, transportReady=${transportReady}, parserReady=${parserReady}`);
      // Attempt non-destructive terminal recovery (Requirement 9)
      await this.attemptNonDestructiveTerminalRecovery();
      
      // Recheck once after recovery
      const recheckListeners = this.onSerialOutput !== null && this.onStateChange !== null;
      if (!recheckListeners) {
        this.dumpConvergenceDiagnostics("Terminal attach barrier failure");
        this.orchestrator.triggerRecovery("terminal attach barrier failed after recovery");
        return;
      }
    }

    // 3. Lifecycle quiet-state stabilization (Requirement 10)
    // No pending dispatches, no active recovery escalation, no bridge recreation pending
    const hasPendingDispatches = (this.lifecycleMutex as unknown as { queue: Promise<void> }).queue !== Promise.resolve();
    const activeRecovery = this.orchestrator.getRecoveryState() === "recovering";
    const bridgeRecreationPending = this.transport.getGenerationManager().getActiveGeneration()?.bridge.getState() === WorkerBridgeState.UNINITIALIZED;

    if (hasPendingDispatches || activeRecovery || bridgeRecreationPending) {
      Logger.warn("VM", `[Convergence] Quiet-state validation failed: activeRecovery=${activeRecovery}, bridgeRecreationPending=${bridgeRecreationPending}`);
      this.dumpConvergenceDiagnostics("Quiet-state stabilization failure");
      this.orchestrator.triggerRecovery("quiet-state stabilization failed");
      return;
    }

    // 4. Runtime steady-state validation (Requirement 5)
    const validator = new RuntimeSteadyStateValidator(this);
    const validationResult = await validator.validate();
    if (!validationResult.passed) {
      Logger.error("VM", `[Convergence] Steady-state validation failed: ${validationResult.reason}`);
      this.dumpConvergenceDiagnostics(`Steady-state validation failure: ${validationResult.reason}`);
      this.orchestrator.triggerRecovery(`steady-state validation failed: ${validationResult.reason}`);
      return;
    }

    // 5. Buffered stdout drain (Requirement 6)
    // Flush serial queue, drain stdout buffer, synchronize parser state
    this.drainStdoutBuffers();

    // 6. Transition to running
    // Finalize provisioning
    this.provisioning.handleProvisioningComplete(execId, activeGenId);

    const isTransitioned = this.transitionState("running", "resolveTerminalReadinessConvergence");
    if (isTransitioned) {
      this.lifecycle.transitionTerminalTo("interactive", "resolveTerminalReadinessConvergence");
      
      if (this.onSerialOutput) {
        this.onSerialOutput("\x1b[1;36mWelcome to the LinLearn Virtual Training Environment!\x1b[0m\r\n");
        this.onSerialOutput(" * System Sandbox: \x1b[1;32mActive (100% Secure, No host access)\x1b[0m\r\n");
        this.onSerialOutput(" * Active Profile: \x1b[1;33muser@linlearn\x1b[0m\r\n\r\n");
        this.onSerialOutput("Try running: \x1b[1;33mcd Projects\x1b[0m, \x1b[1;33mtouch file.txt\x1b[0m, or explore folders.\r\n\r\n");
      }

      this.orchestrator.reportHealthy();
      this.startHealthMonitoring();

      // Track structured convergence telemetry (Requirement 12)
      const duration = Date.now() - startTime;
      Logger.info("VM", `[Telemetry] Convergence completed successfully. Duration: ${duration}ms. execId: ${execId}, activeGenId: ${activeGenId}`);
    } else {
      Logger.error("VM", "[Convergence] State transition to running failed.");
      this.dumpConvergenceDiagnostics("State transition to running failed");
      this.orchestrator.triggerRecovery("running transition failed");
    }
  }

  private drainStdoutBuffers(): void {
    Logger.info("VM", "[Convergence] Draining stdout/serial buffers...");
    this.provisioningSearchBuffer = "";
    this.provisioning.getCompletionParser().reset();
  }

  public async attemptNonDestructiveTerminalRecovery(): Promise<void> {
    Logger.info("VM", "[Recovery] Initiating non-destructive terminal recovery...");

    // 1. Reset parser
    this.provisioning.getCompletionParser().reset();

    // 2. Listener rebind & xterm reconnect
    this.transport.reconnectSerial();
    if (this.onSerialOutput && this.onStateChange) {
      this._dispatchReattach(this.onSerialOutput, this.onStateChange);
    }

    // 3. TTY refresh
    if (this.transport.hasSerial1Support()) {
      Logger.info("VM", "[Recovery] Refreshing TTY settings via serial1...");
      await this.sendProgrammaticInput(1, "RECOVER_TTY\n");
    } else {
      Logger.info("VM", "[Recovery] Refreshing TTY settings via serial0...");
      await this.sendProgrammaticInput(0, "\x03\rreset\r");
    }

    Logger.info("VM", "[Recovery] Non-destructive terminal recovery complete.");
  }

  private dumpConvergenceDiagnostics(reason: string): void {
    const activeGen = this.transport.getGenerationManager().getActiveGeneration();
    const activeGenId = activeGen ? activeGen.id : 0;
    const parserBuffer = (this.provisioning.getCompletionParser() as unknown as { buffer: string }).buffer;
    const termAttached = this.onSerialOutput !== null && this.onStateChange !== null;
    const hasPendingDispatches = (this.lifecycleMutex as unknown as { queue: Promise<void> }).queue !== Promise.resolve();

    Logger.error("VM", `=== CONVERGENCE DIAGNOSTICS: ${reason} ===`);
    Logger.error("VM", `  - Current Runtime State: ${this.lifecycle.getState().state}`);
    Logger.error("VM", `  - Provisioning State: ${this.provisioning.getState()}`);
    Logger.error("VM", `  - Terminal Attach State: ${termAttached ? "attached" : "detached"}`);
    Logger.error("VM", `  - Parser State: buffer length = ${parserBuffer ? parserBuffer.length : 0}`);
    Logger.error("VM", `  - Active Generation: ${activeGenId}`);
    Logger.error("VM", `  - Pending Lifecycle Actions: ${hasPendingDispatches}`);
    Logger.error("VM", `  - Last 128 chars of serial: ${JSON.stringify(this.provisioningSearchBuffer.slice(-128))}`);
    Logger.error("VM", `=========================================`);
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
    if (status !== "running" && status !== "booting" && status !== "provisioning" && status !== "shell_ready" && status !== "terminal_ready") {
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
    if (stateName !== "running" && stateName !== "booting" && stateName !== "provisioning" && stateName !== "shell_ready" && stateName !== "terminal_ready") {
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
