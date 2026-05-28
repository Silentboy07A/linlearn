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
  STOP:          new Set<VMStateName>(["loading", "booting", "interactive", "provisioning", "shell_ready", "terminal_ready", "ready", "stopping"]),
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
  private bootCompleted = false;

  // New modules
  private timeouts: UnifiedTimeoutManager;
  private provisioning: ProvisioningController;
  private orchestrator: RecoveryOrchestrator;

  // Provisioning matching buffer
  private provisioningSearchBuffer = "";

  private fileVisibilityRetries = 0;
  private fileVisibilityTimer: NodeJS.Timeout | null = null;
  private isVerifyingVisibility = false;
  private pendingOnVerified: (() => void) | null = null;
  private pendingOnVisibilityError: (() => void) | null = null;
  private verifyingFilePath = "";

  private lastOrigin: string = "";
  private useMinimalFallback: boolean = false;

  // Initialization mutex (legacy — kept for _doStart abort signal)
  private initPromise: Promise<void> | null = null;
  private initAbortController: AbortController | null = null;

  // ─── Single-Authority Lifecycle Gate ─────────────────────────────────────
  private lifecycleMutex = new AsyncMutex();
  private actionToken = 0;

  // ─── Shell Readiness Gate ─────────────────────────────────────────────────
  // Tracks conditions required before serial input may be sent programmatically.
  // The gate opens when ALL of the following are satisfied:
  //   1. SERIAL_READY stage notification received from worker
  //   2. At least one shell prompt (# / % / $) observed in serial stream
  //   3. No active INIT_STAGE transitions pending
  //   4. Runtime state is not 'loading' or 'booting'
  private receivedSerialReady = false;
  private hasSeenPrompt = false;
  private pendingInitStage = false;
  private shellReadinessResolved = false;
  private shellReadinessResolvers: Array<() => void> = [];

  // ─── Deferred Input Queue ─────────────────────────────────────────────────
  // Programmatic serial inputs sent before the interactive gate is open are
  // enqueued here and flushed upon transition to 'interactive'.
  private deferredInputQueue: Array<{ port: number; data: string }> = [];

  constructor(config: Partial<VMSessionConfig> = {}) {
    this.transport = new TransportCoordinator(() => {
      const state = this.lifecycle.getState().state;
      return state !== "loading" && state !== "booting" && state !== "interactive" && state !== "provisioning" && state !== "shell_ready" && state !== "terminal_ready";
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
      (type, payload) => this.transport.postProvision(type, payload),
      (filePath, onVerified, onError) => this.startFileVisibilityVerification(filePath, onVerified, onError)
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
    if (this.initPromise || state === "loading" || state === "booting" || state === "interactive" || state === "provisioning" || state === "shell_ready" || state === "terminal_ready" || state === "ready") {
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
    this.bootCompleted = false;
    this.lifecycle.setBootComplete(false);
    this.transport.post("RESTART");
  }

  private async _dispatchColdBoot(token: number): Promise<void> {
    Logger.info("VM", "Recovery [Stage 5]: Triggering cold boot fallback via dispatch...");
    if (this.onSerialOutput) {
      this.onSerialOutput("\r\n\x1b[1;31m[Recovery] All recovery exhausted. Cold booting guest VM...\x1b[0m\r\n");
    }

    this.bootCompleted = false;
    this.lifecycle.setBootComplete(false);

    // Force stop regardless of state
    if (this.lifecycle.isAlive() || this.lifecycle.getState().state !== "idle") {
      await this._internalStop();
      if (this.isStaleAction(token)) return;
    }

    this.savedState = null;
    this.wasRestoredFromSnapshot = false;
    this.serialHistory = "";

    const origin = this.lastOrigin || "";
    const onSerial = this.onSerialOutput || (() => {});
    const onState = this.onStateChange || (() => {});

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

  private _dispatchReattach(
    onSerial: (data: string) => void,
    onState: (state: string) => void
  ): void {
    Logger.info("VM", "Reattaching listeners to active VM session");
    this.onSerialOutput = onSerial;
    this.onStateChange = onState;
    onState(this.lifecycle.getState().state);

    this.lifecycle.transitionTerminalTo("attached", "VMController.reattach");
    if (this.lifecycle.getState().state === "ready") {
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
    
    this.bootCompleted = false;
    this.lifecycle.setBootComplete(false);

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
    this.lastOrigin = origin;
    this.onSerialOutput = onSerial;
    this.onStateChange = onState;

    // STABILITY FIX: Temporarily disable snapshot restore to isolate emulator boot lifecycle.
    // Corrupted snapshots can poison WASM memory and cause RuntimeError: unreachable traps.
    // Re-enable once emulator ticking loop stability is validated.
    if (initialState && initialState.byteLength > 2) {
      Logger.warn("VM", "[STABILITY FIX] Snapshot restore DISABLED for stability testing. Forcing clean cold boot.");
    }
    this.wasRestoredFromSnapshot = false;
    this.savedState = null;
    Logger.info("VM", "Cold boot mode active (snapshot restore disabled for stability).");

    this.provisioning.reset();
    this.provisioningSearchBuffer = "";

    // Reset shell readiness gate for new session
    this.receivedSerialReady = false;
    this.hasSeenPrompt = false;
    this.pendingInitStage = false;
    this.shellReadinessResolved = false;
    this.shellReadinessResolvers = [];
    this.deferredInputQueue = [];

    this.transitionState("loading", "VMController.start");
    this.lifecycle.transitionTerminalTo("attached", "VMController.start");

    const workerUrl = `${origin}/v86/v86-worker.js?v=${Date.now()}`;

    // Start boot watchdog timeout
    // NOTE: During loading/booting we only extend based on serial activity.
    // We never probe the shell during these phases — shell is not yet interactive.
    this.timeouts.register("boot_watchdog", this.config.timeoutMs, async () => {
      const state = this.lifecycle.getState().state;
      if (state === "loading" || state === "booting") {
        if (Date.now() - this.lastSerialOutputTimestamp < 15000) {
          Logger.info("VM", "Boot progress active (serial output received). Extending boot timeout.");
          this.timeouts.extend("boot_watchdog", 15000);
          return;
        }

        // Only probe shell if we are past the early boot phase (shell readiness gate open)
        if (!this.shellReadinessResolved) {
          Logger.warn("VM", `[BOOT WATCHDOG] Shell not yet interactive — skipping probe. Stalled in state: ${state}`);
          this.useMinimalFallback = true;
          this.orchestrator.triggerRecovery("boot timeout exceeded (shell not ready)");
          return;
        }

        // Probe shell responsiveness only after shell is confirmed interactive
        const shellResponsive = await this.probeShellResponsiveness();
        if (shellResponsive) {
          Logger.info("VM", "[BOOT WATCHDOG] Shell responded to probe. Extending boot timeout.");
          this.timeouts.extend("boot_watchdog", 15000);
          return;
        }

        Logger.warn("VM", `Boot watchdog triggered. Stalled in state: ${state}`);
        this.useMinimalFallback = true;
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
            this.timeouts.register("init_watchdog", 12000, async () => {
              const currentState = this.lifecycle.getState().state;
              if (currentState === "loading") {
                Logger.error("VM", "[INIT TIMEOUT] Worker received INIT but failed to complete asset loading / instantiation!");
                const activeGen = this.transport.getGenerationManager().getActiveGeneration();
                this.dumpInitDiagnostics(activeGen ? activeGen.id : 0);
                this.useMinimalFallback = true;
                this.orchestrator.triggerRecovery("init watchdog timeout");
              }
            });
            Logger.info("VM", `[INIT_ACK] Worker acknowledged INIT receipt for generation ${payload && typeof payload === "object" && "generation" in payload ? (payload as { generation: number }).generation : "unknown"}`);
            break;

          case "INIT_STAGE": {
            const stagePayload = payload as { stage: string; ts: number };
            const stage = stagePayload.stage;
            this.timeouts.cancel("init_watchdog");

            // Mark that an INIT_STAGE is in progress — shell readiness gate depends on this
            this.pendingInitStage = true;

            // SERIAL_READY is the last stage; after it we know serial is attached
            if (stage === "SERIAL_READY") {
              this.receivedSerialReady = true;
              this.pendingInitStage = false;
              Logger.info("VM", "[SHELL GATE] SERIAL_READY received. Serial port is now attached.");
              this.checkInteractiveShellReadiness();
            }
            
            // Phase-specific watchdog timeout durations
            let timeoutMs = 12000; // default 12s
            if (stage === "WASM_FETCH") timeoutMs = 25000;
            else if (stage === "WASM_COMPILE") timeoutMs = 15000;
            else if (stage === "BIOS_LOAD") timeoutMs = 15000;
            else if (stage === "FS_LOAD") timeoutMs = 30000;
            else if (stage === "EMULATOR_CREATE") timeoutMs = 10000;
            else if (stage === "CPU_BOOT") timeoutMs = 15000;
            else if (stage === "SERIAL_READY") timeoutMs = 10000;
            
            this.timeouts.register("init_watchdog", timeoutMs, async () => {
              const currentState = this.lifecycle.getState().state;
              if (currentState === "loading") {
                Logger.error("VM", `[INIT TIMEOUT] Worker stalled during stage '${stage}'!`);
                const activeGen = this.transport.getGenerationManager().getActiveGeneration();
                this.dumpInitDiagnostics(activeGen ? activeGen.id : 0);
                this.useMinimalFallback = true;
                this.orchestrator.triggerRecovery(`init watchdog timeout at stage ${stage}`);
              }
            });
            Logger.info("VM", `[INIT_STAGE] Stage transitioned to ${stage}. Timeout registered for ${timeoutMs}ms.`);
            break;
          }

          case "INIT_PROGRESS": {
            const stats = payload as {
              ts: number;
              stage: string;
              jsHeapLimit: number;
              totalJSHeap: number;
              usedJSHeap: number;
              deviceMemory?: number;
              emulatorRam?: number;
              emulatorVgaRam?: number;
            };
            // Extend/reset active init watchdog timeout to keep alive
            this.timeouts.extend("init_watchdog", 12000);
            Logger.debug("VM", `[INIT_PROGRESS] Worker heartbeat: stage=${stats.stage}, heap=${Math.round(stats.usedJSHeap / (1024 * 1024))}MB/${Math.round(stats.totalJSHeap / (1024 * 1024))}MB, limit=${Math.round(stats.jsHeapLimit / (1024 * 1024))}MB`);
            break;
          }

          case "INIT_TELEMETRY": {
            const telemetry = payload as {
              wasmFetchDuration: number;
              wasmCompileDuration: number;
              biosLoadDuration: number;
              filesystemImageLoadDuration: number;
              initrdLoadDuration: number;
              emulatorConstructorDuration: number;
              cpuBootstrapDuration: number;
              firstSerialOutputLatency: number;
            };
            Logger.info("VM", "[INIT TELEMETRY RECEIVED]", telemetry);
            break;
          }

          case "INIT_SUCCESS":
            this.timeouts.cancel("init_watchdog");
            this.initCompleteTimestamp = Date.now();
            Logger.info("VM", `[INIT_SUCCESS] Worker successfully initialized emulator. Latency: ${this.initCompleteTimestamp - this.initDispatchTimestamp}ms`);
            this.useMinimalFallback = false; // Reset minimal boot fallback flag upon success
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
              if (rawState === "booting" || rawState === "ready") {
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

              // Prevent host backward FSM transitions for the bootstrap-to-ready sequence
              const stateOrder: VMStateName[] = ["idle", "loading", "booting", "interactive", "provisioning", "shell_ready", "terminal_ready", "ready"];
              const currentState = this.lifecycle.getState().state;
              const currentIndex = stateOrder.indexOf(currentState);
              const targetIndex = stateOrder.indexOf(mappedState);

              if (currentIndex !== -1 && targetIndex !== -1 && targetIndex < currentIndex) {
                Logger.info("VM", `[FSM] Dropped backward worker STATE_CHANGED transition notification: ${currentState} -> ${mappedState}`);
                break;
              }

              this.transitionState(mappedState, "worker STATE_CHANGED", true, "STATE_CHANGED");
            }
            break;

          case "PROVISION_RECOVERING":
            {
              const data = payload as { msg: string };
              Logger.info("VM", `[PROVISIONING RECOVERY] Worker reported: ${data.msg}`);
              this.lifecycle.transitionRecoveryTo("recovering", "Worker PROVISION_RECOVERING");
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
            this.useMinimalFallback = true;
            this.orchestrator.triggerRecovery("INIT_ACK handshake timeout");
          }
        });

        this.transport.post("INIT", {
          origin,
          memory_size: this.config.memoryLimitBytes,
          vga_memory_size: this.config.vgaMemoryLimitBytes,
          version: Date.now().toString(),
          initial_state: this.savedState || undefined,
          minimal: this.useMinimalFallback,
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

    if (this.isVerifyingVisibility && this.provisioningSearchBuffer.includes("<<<PROVISION_FILES_VISIBLE>>>")) {
      Logger.info("VM", `[PROVISIONING WATCHDOG] Visibility confirmed for ${this.verifyingFilePath} (STAGE:PROVISION_FILES_VISIBLE).`);
      this.isVerifyingVisibility = false;
      if (this.fileVisibilityTimer) {
        clearTimeout(this.fileVisibilityTimer);
        this.fileVisibilityTimer = null;
      }
      this.provisioningSearchBuffer = "";
      this.pendingOnVisibilityError = null;
      if (this.pendingOnVerified) {
        const cb = this.pendingOnVerified;
        this.pendingOnVerified = null;
        cb();
      }
      return;
    }

    const hasRootPrompt = this.provisioningSearchBuffer.endsWith("~% ") || 
                          this.provisioningSearchBuffer.endsWith("# ") || 
                          this.provisioningSearchBuffer.endsWith("~# ") ||
                          this.provisioningSearchBuffer.endsWith("root% ") ||
                          this.provisioningSearchBuffer.endsWith("% ");

    const provisioningActive =
      this.provisioning.getState() === "preparing" ||
      this.provisioning.getState() === "transferring" ||
      this.provisioning.getState() === "executing" ||
      this.provisioning.getState() === "waiting_completion";

    if (provisioningActive && hasRootPrompt && !this.isVerifyingVisibility) {
      Logger.error("VM", `[PROVISIONING WATCHDOG] Prompt leakage detected: root prompt found in serial stream while provisioning is active. Aborting, resetting TTY, and restarting execution.`);
      Logger.warn("VM", `[PROVISIONING WATCHDOG] Buffer tail: ${JSON.stringify(this.provisioningSearchBuffer.slice(-64))}`);
      
      void this.sendProgrammaticInput(0, "\x03\n");
      void this.sendProgrammaticInput(0, "stty sane\nreset\n");
      
      const execId = this.provisioning.getExecutionId();
      Logger.info("VM", `[PROVISIONING WATCHDOG] Clean restart: sending execute command for helper prov_execute_${execId}.sh`);
      void this.sendProgrammaticInput(0, `sh /root/.provision/prov_execute_${execId}.sh\n`);
      
      this.provisioningSearchBuffer = "";
      return;
    }

    if (provisioningActive && (char === "\n" || hasRootPrompt) && !this.isVerifyingVisibility) {
      const lastOpen = this.provisioningSearchBuffer.lastIndexOf("<<<");
      const lastClose = this.provisioningSearchBuffer.lastIndexOf(">>>");
      if (lastOpen > lastClose) {
        Logger.warn("VM", `[PROVISIONING WATCHDOG] TTY desync / tag fragmentation detected. Unclosed tag: ${JSON.stringify(this.provisioningSearchBuffer.slice(lastOpen))}`);
      }
    }

    const activeGen = this.transport.getGenerationManager().getActiveGeneration();
    const activeGenId = activeGen ? activeGen.id : 0;

    // Check for mount stabilization markers during interactive state
    if (this.lifecycle.getState().state === "interactive") {
      if (this.provisioningSearchBuffer.includes("<<<STAGE:MOUNT_OK>>>") || this.provisioningSearchBuffer.includes("<<<MOUNT_STABILIZED>>>")) {
        this.timeouts.cancel("mount_stabilization_watchdog");
        Logger.info("VM", "[PROVISIONING] Guest filesystem mount stabilized (STAGE:MOUNT_OK). Transitioning to provisioning state.");
        this.transitionState("provisioning", "handleSerialLifecycle");
        this.lifecycle.transitionTerminalTo("recovering", "handleSerialLifecycle");

        Logger.info("VM", "[PROVISIONING] Starting atomic provisioning via PROVISION_* protocol...");
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

        void this.provisioning.startProvisioning(
          this.savedState,
          GUEST_INSPECT_SCRIPT,
          this.transport.hasSerial1Support(),
          activeGenId
        );
        this.provisioningSearchBuffer = "";
        return;
      } else if (this.provisioningSearchBuffer.includes("<<<STAGE:MOUNT_FAIL>>>") || this.provisioningSearchBuffer.includes("<<<MOUNT_FAILED>>>")) {
        this.timeouts.cancel("mount_stabilization_watchdog");
        Logger.error("VM", "[PROVISIONING] Guest filesystem mount failed.");
        this.orchestrator.triggerRecovery("guest mount barrier report failure");
        this.provisioningSearchBuffer = "";
        return;
      }
    }

    const parserEvents = this.provisioning.getCompletionParser().feed(char, activeGenId);

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

    // ── PS2 continuation prompt recovery ──────────────────────────────────────
    // If ash emits '> ' (PS2 prompt) during provisioning, it means the shell received
    // an incomplete compound command and is waiting for more input. This is a deadlock.
    // Recovery: send Ctrl+C (\x03) to abort, then a newline to clear the line.
    if (provisioningActive && (
      this.provisioningSearchBuffer.includes("> > >") ||
      this.provisioningSearchBuffer.endsWith("\n> ") ||
      this.provisioningSearchBuffer.endsWith("\r\n> ") ||
      this.provisioningSearchBuffer.endsWith("\n>\r") ||
      this.provisioningSearchBuffer.endsWith("> \r")
    )) {
      Logger.warn("VM", "[PROVISIONING] PS2 continuation prompt detected (shell awaiting more input). Aborting with Ctrl+C and running stty sane/reset...");
      Logger.warn("VM", `[PROVISIONING] Buffer tail: ${JSON.stringify(this.provisioningSearchBuffer.slice(-64))}`);
      void this.sendProgrammaticInput(0, "\x03\n");
      void this.sendProgrammaticInput(0, "stty sane\nreset\n");
      
      const execId = this.provisioning.getExecutionId();
      if (this.provisioning.getState() === "executing" || this.provisioning.getState() === "waiting_completion") {
        Logger.info("VM", `[PROVISIONING] Retrying execution trigger for execId=${execId}...`);
        const activeGen = this.transport.getGenerationManager().getActiveGeneration();
        const activeGenId = activeGen ? activeGen.id : 0;
        this.transport.post("PROVISION_EXECUTE", {
          execId: execId,
          generation: activeGenId,
          filePath: `/root/.provision/runtime_exec.sh`,
          verifiedInode: "unknown",
          fallbackRequired: false
        });
      }
      this.provisioningSearchBuffer = "";
    }

    // ── Boot ready: root prompt detected → update shell readiness gate ──
    const isBootingState = this.lifecycle.getState().state === "booting";
    if (hasRootPrompt) {
      // Signal that we've seen a shell prompt — gate condition 2
      if (!this.hasSeenPrompt) {
        this.hasSeenPrompt = true;
        Logger.info("VM", "[SHELL GATE] First root prompt observed in serial stream.");
        this.checkInteractiveShellReadiness();
      }
    }

    if (hasRootPrompt && isBootingState && this.provisioning.getState() === "idle") {
      // Wait for prompt to be stable using event-driven awaitPromptStable()
      void this.awaitPromptStable(1000).then(() => {
        if (this.lifecycle.getState().state !== "booting" || this.provisioning.getState() !== "idle") return;

        this.timeouts.cancel("prompt_stabilization");
        this.timeouts.cancel("boot_watchdog");

        Logger.info("VM", "<<<VM_BOOT_COMPLETE>>>");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;32m<<<VM_BOOT_COMPLETE>>>\x1b[0m\r\n");
        }
        this.bootCompleted = true;
        this.lifecycle.setBootComplete(true);

        // Wait for interactive shell gate to fully open before sending any serial commands
        void this.waitForInteractiveShell().then(() => {
          this.startFileVisibilityVerification(
            "/root/.provision/mount_prepare.sh",
            () => {
              Logger.info("VM", "[PROVISIONING] mount_prepare.sh guest visibility verified. Transitioning to interactive.");
              this.transitionState("interactive", "handleSerialLifecycle");

              // Flush any deferred inputs that were queued before shell was ready
              this._flushDeferredInputQueue();

              Logger.info("VM", "[PROVISIONING] Executing guest mount stabilization helper script...");
              void this.sendProgrammaticInput(0, "sh /root/.provision/mount_prepare.sh\n");

              this.timeouts.register("mount_stabilization_watchdog", 15000, () => {
                Logger.error("VM", "[PROVISIONING] mount_stabilization_watchdog fired. Guest mount did not stabilize in 15 seconds.");
                this.handleVisibilityFailure();
              });
            },
            () => {
              Logger.error("VM", "[PROVISIONING] mount_prepare.sh guest visibility check timed out.");
              this.handleVisibilityFailure();
            }
          );
        });

        this.provisioningSearchBuffer = "";
      });
    }
  }

  // ─── Shell Readiness Gate ─────────────────────────────────────────────────

  /**
   * Returns a Promise that resolves only when the interactive shell is confirmed
   * ready. All conditions must be met:
   *   1. SERIAL_READY received from worker
   *   2. A root shell prompt was observed in serial output
   *   3. No INIT_STAGE transition is pending
   *   4. Runtime state is not 'loading' or 'booting'
   * If the gate is already open, resolves immediately.
   */
  public waitForInteractiveShell(): Promise<void> {
    if (this.shellReadinessResolved) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.shellReadinessResolvers.push(resolve);
    });
  }

  /**
   * Called whenever any shell readiness condition changes.
   * Opens the gate if all conditions are now satisfied.
   */
  private checkInteractiveShellReadiness(): void {
    if (this.shellReadinessResolved) return;

    const state = this.lifecycle.getState().state;
    const isEarlyBoot = state === "loading" || state === "booting";
    const allConditionsMet =
      this.receivedSerialReady &&
      this.hasSeenPrompt &&
      !this.pendingInitStage &&
      !isEarlyBoot;

    // In practice the prompt may arrive before SERIAL_READY or after — handle both orderings.
    // Allow the gate to open if prompt AND state are valid even before SERIAL_READY if the prompt
    // unambiguously arrived during the booting state (we relax receivedSerialReady in that case).
    const promptReceivedInBootingState = this.hasSeenPrompt && state === "booting";

    if (allConditionsMet || promptReceivedInBootingState) {
      this.shellReadinessResolved = true;
      Logger.info("VM", "[SHELL GATE] Interactive shell readiness confirmed. Flushing deferred input queue.");
      // Resolve all waiting callers
      const resolvers = this.shellReadinessResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  /**
   * Waits for the serial stream to be quiet for at least `quietMs` milliseconds
   * (no new characters arriving), then resolves. This is the event-driven
   * replacement for setTimeout-based prompt stabilization.
   */
  private awaitPromptStable(quietMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        const age = Date.now() - this.lastSerialOutputTimestamp;
        if (age >= quietMs) {
          resolve();
        } else {
          // Re-check after the remaining quiet period has elapsed
          this.timeouts.register("prompt_stabilization", quietMs - age, check);
        }
      };
      this.timeouts.cancel("prompt_stabilization");
      check();
    });
  }

  /**
   * Flush all deferred programmatic inputs that were queued while the shell
   * was not yet interactive. Called after the gate opens.
   */
  private _flushDeferredInputQueue(): void {
    if (this.deferredInputQueue.length === 0) return;
    Logger.info("VM", `[SHELL GATE] Flushing ${this.deferredInputQueue.length} deferred input(s) now that shell is interactive.`);
    const queue = this.deferredInputQueue.splice(0);
    for (const item of queue) {
      void this.transport.send(item.port, item.data);
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
    const queryCmd = `\nstty -echo; [ -f /root/.provision/runtime_exec.sh ] && (ps | grep -v grep | grep -q "runtime_exec.sh" && echo "<<<PROTO:${execId}:5:HEARTBEAT>>>" || ([ -f /root/.provision/provision_complete ] && echo "<<<PROTO:${execId}:6:EXEC_COMPLETE>>>" || echo "<<<PROTO:${execId}:7:FAIL:recovery_script_terminated>>>")) || echo "<<<PROTO:${execId}:7:FAIL:recovery_script_not_found>>>"\n`;
    
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

    Logger.info("VM", "<<<PROVISIONING_COMPLETE>>>");
    if (this.onSerialOutput) {
      this.onSerialOutput("\r\n\x1b[1;32m<<<PROVISIONING_COMPLETE>>>\x1b[0m\r\n");
    }

    const isTransitioned = this.transitionState("ready", "resolveTerminalReadinessConvergence");
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
      Logger.error("VM", "[Convergence] State transition to ready failed.");
      this.dumpConvergenceDiagnostics("State transition to ready failed");
      this.orchestrator.triggerRecovery("ready transition failed");
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
    if (currentState !== "ready") {
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
    if (status !== "ready" && status !== "booting" && status !== "interactive" && status !== "provisioning" && status !== "shell_ready" && status !== "terminal_ready") {
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

  /**
   * Queue a programmatic serial input for deferred delivery.
   * The input will be sent once the interactive shell gate is open.
   * Use this instead of sendProgrammaticInput when the gate may not yet be open.
   */
  public queueProgrammaticInput(port: number, data: string): void {
    if (this.shellReadinessResolved) {
      // Gate already open — send immediately
      void this.transport.send(port, data);
    } else {
      Logger.info("VM", `[SHELL GATE] Deferring serial input (port=${port}): ${JSON.stringify(data.slice(0, 64))}`);
      this.deferredInputQueue.push({ port, data });
    }
  }

  public sendProgrammaticInput(port: number, data: string): Promise<void> {
    const stateName = this.lifecycle.getState().state;

    // Hard block: never send programmatic input during early boot phases.
    // Commands sent during loading/booting would be injected before the shell
    // is interactive, causing "Ignored serial input in non-interactive state" errors
    // and TTY desynchronization.
    if (stateName === "loading" || stateName === "booting") {
      Logger.warn("VM", `[SHELL GATE] Deferring programmatic input during '${stateName}' phase (port=${port}): ${JSON.stringify(data.slice(0, 64))}`);
      this.deferredInputQueue.push({ port, data });
      return Promise.resolve();
    }

    if (
      stateName === "error" ||
      stateName === "stopped" ||
      stateName === "stopping" ||
      stateName === "idle"
    ) {
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

    if (newState === "error" && this.bootCompleted) {
      Logger.warn("VM", `[LIFECYCLE PREVENT] Prevented transition to error after boot completion. Current state: ${currentState}. Source: ${source}`);
      return false;
    }

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

    if (newState === "ready") {
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
 
  public startFileVisibilityVerification(filePath: string, onVerified: () => void, onError: () => void) {
    if (this.fileVisibilityTimer) {
      clearTimeout(this.fileVisibilityTimer);
      this.fileVisibilityTimer = null;
    }
    this.fileVisibilityRetries = 0;
    this.isVerifyingVisibility = true;
    this.verifyingFilePath = filePath;
    this.pendingOnVerified = onVerified;
    this.pendingOnVisibilityError = onError;
    
    this.pollFileVisibility();
  }

  private pollFileVisibility() {
    if (!this.isVerifyingVisibility) return;
    this.fileVisibilityRetries++;
    if (this.fileVisibilityRetries > 8) {
      Logger.error("VM", `[PROVISIONING WATCHDOG] Visibility check failed for ${this.verifyingFilePath} after 8 attempts.`);
      this.isVerifyingVisibility = false;
      if (this.pendingOnVisibilityError) {
        const errCb = this.pendingOnVisibilityError;
        this.pendingOnVisibilityError = null;
        this.pendingOnVerified = null;
        errCb();
      }
      return;
    }

    Logger.info("VM", `[PROVISIONING WATCHDOG] Polling guest visibility for ${this.verifyingFilePath} (attempt ${this.fileVisibilityRetries})...`);
    
    const checkCmd = `sync; echo 3 > /proc/sys/vm/drop_caches; [ -f "${this.verifyingFilePath}" ] && [ -s "${this.verifyingFilePath}" ] && [ -x "${this.verifyingFilePath}" ] && echo '<<<PROVISION_FILES_VISIBLE>>>'\n`;
    void this.sendProgrammaticInput(0, checkCmd);

    const delay = Math.min(1000 + (this.fileVisibilityRetries * 250), 3000);
    this.fileVisibilityTimer = setTimeout(() => {
      this.pollFileVisibility();
    }, delay);
  }

  private runVisibilityDiagnostics() {
    Logger.error("VM", "[PROVISIONING WATCHDOG] Visibility timeout reached. Running diagnostics...");
    void this.sendProgrammaticInput(0, "ls -la /root/.provision\n");
    void this.sendProgrammaticInput(0, "ls -la /mnt/9p/root/.provision\n");
    void this.sendProgrammaticInput(0, "cat /proc/mounts\n");
  }

  private handleVisibilityFailure() {
    this.runVisibilityDiagnostics();
    this.orchestrator.triggerRecovery("file visibility timeout");
  }

  private stopHealthMonitoring(): void {
    if (this.healthMonitor) {
      this.healthMonitor.stop();
      this.healthMonitor = null;
    }
  }
}
