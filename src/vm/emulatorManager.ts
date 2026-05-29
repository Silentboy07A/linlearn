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

  // FILE_MATERIALIZATION_VERIFIED handler
  // When the worker confirms host-side 9p write success, we bypass the serial
  // visibility poll and fire this callback directly.
  private pendingMaterializationVerified: (() => void) | null = null;
  private pendingMaterializationFailed: (() => void) | null = null;
  private hostMaterialized = false;
  private mountPrepareVerified = false;
  private isProvisioningAttemptStarted = false;
  private provisioningExecutionStarted = false;
  private provisioningExecutionCompleted = false;
  private verifiedInodeId: number | null = null;
  private verifiedInodeMtime: number | null = null;
  private verifiedInodeSize: number | null = null;
  private verifiedInodeReadability: boolean | null = null;
  private provisionExecutionInFlight = false;

  private lastOrigin: string = "";
  private useMinimalFallback: boolean = false;

  // Initialization mutex (legacy — kept for _doStart abort signal)
  private initPromise: Promise<void> | null = null;
  private initAbortController: AbortController | null = null;

  // ─── Single-Authority Lifecycle Gate ─────────────────────────────────────
  private lifecycleMutex = new AsyncMutex();
  private actionToken = 0;

  // ─── Shell Readiness Preconditions ──────────────────────────────────────
  // These booleans track low-level preconditions for the "interactive" FSM
  // transition. They are NEVER used directly to gate serial input — the
  // lifecycle FSM state "interactive" is the SINGLE SOURCE OF TRUTH.
  //
  // Gate opens (FSM → "interactive") when ALL are true:
  //   1. receivedSerialReady  — SERIAL_READY received from worker
  //   2. hasSeenPrompt        — root shell prompt observed in serial stream
  //   3. !pendingInitStage    — no active INIT_STAGE transition in flight
  //   4. FSM state === "booting" (transition guard)
  private receivedSerialReady = false;
  private hasSeenPrompt = false;
  private pendingInitStage = false;
  private rawLineBuffer = "";

  // ─── Deferred Input Queue ─────────────────────────────────────────────────
  // Programmatic serial inputs arriving before FSM reaches "interactive" are
  // enqueued here and flushed atomically when the FSM transitions to "interactive".
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
    this.hostMaterialized = false;
    this.mountPrepareVerified = false;
    this.isProvisioningAttemptStarted = false;
    this.provisioningExecutionStarted = false;
    this.provisioningExecutionCompleted = false;
    this.verifiedInodeId = null;
    this.verifiedInodeMtime = null;
    this.verifiedInodeSize = null;
    this.verifiedInodeReadability = null;
    this.provisionExecutionInFlight = false;
    this._guestExistsMarker = null;
    this._guestExistsCallback = null;
    this._guestMissingCallback = null;
    this._guestPollAttempt = 0;
    this._guestPollMaxRetries = 0;

    // Reset shell readiness preconditions for new session
    this.receivedSerialReady = false;
    this.hasSeenPrompt = false;
    this.pendingInitStage = false;
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

        // Inside this block, FSM is still in "loading" or "booting", which means
        // it has NOT yet reached "interactive" (the single source of truth for readiness).
        // Skip shell probe entirely — the shell is not yet ready for programmatic input.
        Logger.warn("VM", `[BOOT WATCHDOG] FSM has not reached 'interactive' — skipping probe. Stalled in state: ${state}`);
        this.useMinimalFallback = true;
        this.orchestrator.triggerRecovery("boot timeout exceeded (shell not interactive)");
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

            // Track INIT_STAGE — clears when SERIAL_READY arrives (last stage)
            this.pendingInitStage = true;

            // SERIAL_READY is the terminal stage: serial port is now attached
            if (stage === "SERIAL_READY") {
              this.receivedSerialReady = true;
              this.pendingInitStage = false;
              Logger.info("VM", "[SHELL GATE] SERIAL_READY received. Attempting FSM transition to 'interactive'.");
              // Attempt FSM transition — will succeed only if prompt was already seen
              this._tryTransitionToInteractive("SERIAL_READY");
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
              const stateOrder: VMStateName[] = ["idle", "loading", "booting", "fs9p_ready", "interactive", "provisioning", "shell_ready", "terminal_ready", "ready"];
              const currentState = this.lifecycle.getState().state;
              const currentIndex = stateOrder.indexOf(currentState);
              const targetIndex = stateOrder.indexOf(mappedState);

              if (currentIndex !== -1 && targetIndex !== -1 && targetIndex < currentIndex) {
                Logger.info("VM", `[FSM] Dropped backward worker STATE_CHANGED transition notification: ${currentState} -> ${mappedState}`);
                break;
              }

              this.transitionState(mappedState, "worker STATE_CHANGED", true, "STATE_CHANGED");
              if (mappedState === "fs9p_ready") {
                this._tryTransitionToInteractive("worker-fs9p-ready");
              }
            }
            break;

          case "PROVISION_RECOVERING":
            {
              const data = payload as { msg: string };
              Logger.info("VM", `[PROVISIONING RECOVERY] Worker reported: ${data.msg}`);
              this.lifecycle.transitionRecoveryTo("recovering", "Worker PROVISION_RECOVERING");
            }
            break;

          case "FILE_MATERIALIZATION_VERIFIED": {
            // Worker confirmed host-side 9p filesystem write success.
            // NOTE: This only confirms the HOST 9p inode table — NOT guest VFS visibility.
            const matPayload = payload as { path: string; inodeId: number; size: number; mtime?: number; readability?: boolean; isReinject?: boolean; skipped?: boolean; verifiedNamespace?: string; guestVerified?: boolean };
            
            Logger.info("VM", `[VERIFY_PATH] FILE_MATERIALIZATION_VERIFIED: path=${matPayload.path}, inode=${matPayload.inodeId}, size=${matPayload.size}, mtime=${matPayload.mtime || "unknown"}, readability=${matPayload.readability !== false}, isReinject=${matPayload.isReinject || false}, skipped=${matPayload.skipped || false}`);
            Logger.info("VM", `[VERIFY_NAMESPACE] Verification namespace: ${matPayload.verifiedNamespace || "host_9p_inode_table"}, guestVerified: ${matPayload.guestVerified || false}`);
            Logger.info("VM", `[FS9P_PATH] Host 9p export path: ${matPayload.path}`);
            Logger.info("VM", `[GUEST_PATH] Guest execution path: ${matPayload.path}`);
            
            this.verifiedInodeId = matPayload.inodeId;
            this.verifiedInodeMtime = matPayload.mtime || null;
            this.verifiedInodeSize = matPayload.size;
            this.verifiedInodeReadability = matPayload.readability !== false;

            // Telemetry: HOST_* (Task 9)
            Logger.info("VM", `[HOST_FILE_EXISTS] true`);
            Logger.info("VM", `[HOST_FILE_SIZE] ${matPayload.size}`);
            Logger.info("VM", `[HOST_FILE_PATH] ${matPayload.path}`);

            this.hostMaterialized = true;
            // Task 11: Remove FILE_MATERIALIZATION_VERIFIED success if guestVerified=false
            this.mountPrepareVerified = matPayload.guestVerified || false;

            if (this.pendingMaterializationVerified) {
              const cb = this.pendingMaterializationVerified;
              this.pendingMaterializationVerified = null;
              this.pendingMaterializationFailed = null;
              cb();
            }
            break;
          }

          case "SERIAL_FRAGMENTATION_DETECTED": {
            const fragPayload = payload as { reason: string; length?: number; violations?: string[]; payload?: string };
            Logger.error("VM", `[TELEMETRY] SERIAL_FRAGMENTATION_DETECTED received from worker: reason=${fragPayload.reason}, violations=${fragPayload.violations ? fragPayload.violations.join(",") : "none"}, length=${fragPayload.length || "unknown"}, payload=${JSON.stringify(fragPayload.payload)}`);
            break;
          }
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

    // Buffer and log raw serial chunks line by line
    this.rawLineBuffer += char;
    if (char === "\n" || this.rawLineBuffer.length > 256) {
      Logger.debug("VM", `[SERIAL_RAW_CHUNK] Raw chunk: ${JSON.stringify(this.rawLineBuffer)}`);
      this.rawLineBuffer = "";
    }

    this.provisioningSearchBuffer += char;
    if (this.provisioningSearchBuffer.length > 512) {
      this.provisioningSearchBuffer = this.provisioningSearchBuffer.substring(this.provisioningSearchBuffer.length - 512);
    }

    if (this.provisioningSearchBuffer.includes("<<<PRE_EXEC_FILE_CHECK>>>")) {
      Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches PRE_EXEC_FILE_CHECK");
      Logger.info("VM", "[TELEMETRY] PRE_EXEC_FILE_CHECK: Starting guest-side filesystem checks before execution.");
      this.provisioningSearchBuffer = this.provisioningSearchBuffer.replace("<<<PRE_EXEC_FILE_CHECK>>>", "");
    }
    if (this.provisioningSearchBuffer.includes("<<<PRE_EXEC_FILE_EXISTS>>>")) {
      Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches PRE_EXEC_FILE_EXISTS");
      Logger.info("VM", "[TELEMETRY] PRE_EXEC_FILE_EXISTS: Verified guest-side readability/existence of mount_prepare.sh.");
      this.provisioningSearchBuffer = this.provisioningSearchBuffer.replace("<<<PRE_EXEC_FILE_EXISTS>>>", "");
    }
    if (this.provisioningSearchBuffer.includes("<<<PRE_EXEC_FILE_MISSING>>>")) {
      Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches PRE_EXEC_FILE_MISSING");
      Logger.error("VM", "[TELEMETRY] PRE_EXEC_FILE_MISSING: mount_prepare.sh not found inside guest VFS!");
      this.provisioningSearchBuffer = this.provisioningSearchBuffer.replace("<<<PRE_EXEC_FILE_MISSING>>>", "");
    }

    // Guest-side existence check markers (from _pollGuestFileExists)
    if (this._guestExistsMarker && this.provisioningSearchBuffer.includes(this._guestExistsMarker)) {
      Logger.info("VM", `[SERIAL_PARSED_MATCH] Matches guestExistsMarker: ${this._guestExistsMarker}`);
      Logger.info("VM", "[GUEST_FILE_EXISTS] Guest-side existence check confirmed file is visible.");
      this.provisioningSearchBuffer = this.provisioningSearchBuffer.replace(this._guestExistsMarker, "");
      this.timeouts.cancel("guest_file_poll");
      const cb = this._guestExistsCallback;
      this._guestExistsMarker = null;
      this._guestExistsCallback = null;
      this._guestMissingCallback = null;
      if (cb) cb();
      return;
    }
    if (this._guestExistsMarker && (this.provisioningSearchBuffer.includes("<<<GF_MISS>>>") || this.provisioningSearchBuffer.includes("GF_MISS"))) {
      Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches GF_MISS");
      Logger.warn("VM", "[GUEST_FILE_MISSING] Guest-side existence check reports file NOT found.");
      this.provisioningSearchBuffer = this.provisioningSearchBuffer.replace("<<<GF_MISS>>>", "").replace("GF_MISS", "");
      // Don't act immediately — the retry timer in _pollGuestFileExists will handle it
    }

    if (this.isVerifyingVisibility && (this.provisioningSearchBuffer.includes("<<<PROVISION_FILES_VISIBLE>>>") || this.provisioningSearchBuffer.includes("PROV_FILES_VISIBLE"))) {
      Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches PROV_FILES_VISIBLE");
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
      void this.sendProgrammaticInput(0, "stty sane\n");
      void this.sendProgrammaticInput(0, "reset\n");
      
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
      if (this.provisioningSearchBuffer.includes("<<<V_OK>>>")) {
        this.provisioningSearchBuffer = this.provisioningSearchBuffer.replace("<<<V_OK>>>", "");
        Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches V_OK");
        Logger.info("VM", "[VERIFY_SCRIPT_VISIBLE] verify_mount.sh is confirmed visible and readable on guest.");
        
        // Execute verify_mount.sh using a single short, atomic command (35 bytes, well under 128 transport limit)
        void this.sendProgrammaticInput(0, "sh /root/.provision/verify_mount.sh\n");
        return;
      }

      if (this.provisioningSearchBuffer.includes("<<<V_ERR>>>")) {
        this.provisioningSearchBuffer = this.provisioningSearchBuffer.replace("<<<V_ERR>>>", "");
        Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches V_ERR");
        Logger.error("VM", "[VERIFY_SCRIPT_CREATE_FAILURE] verify_mount.sh visibility check failed on guest (missing, empty, or unreadable)!");
        
        this.timeouts.cancel("mount_stabilization_watchdog");
        this.provisionExecutionInFlight = false;
        this.orchestrator.triggerRecovery("verify_mount.sh visibility check failed on guest");
        return;
      }

      if (this.provisioningSearchBuffer.includes("<<<GUEST_MOUNT_PREPARE_VERIFIED>>>")) {
        this.provisioningSearchBuffer = this.provisioningSearchBuffer.replace("<<<GUEST_MOUNT_PREPARE_VERIFIED>>>", "");
        Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches GUEST_MOUNT_PREPARE_VERIFIED");

        // Guest confirmed mount_prepare.sh is visible and readable
        Logger.info("VM", `[GUEST_FILE_EXISTS] Guest verified mount_prepare.sh is present and readable.`);
        console.log(`[PROVISIONING_VERIFICATION] Verified path: /root/.provision/mount_prepare.sh`);
        console.log(`[PROVISIONING_VERIFICATION] Actual file existence: true`);

        // Execute — command is 37 bytes, well under 100-byte limit
        const wrapperCmd = `sh /root/.provision/mount_prepare.sh\n`;
        Logger.info("VM", `[PROVISIONING_EXECUTION_PATH] cmd_bytes=${wrapperCmd.length}`);

        void this.sendProgrammaticInput(0, wrapperCmd);
        return;
      }

      if (this.provisioningSearchBuffer.includes("<<<GUEST_MOUNT_PREPARE_FAILED>>>")) {
        this.provisioningSearchBuffer = this.provisioningSearchBuffer.replace("<<<GUEST_MOUNT_PREPARE_FAILED>>>", "");
        Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches GUEST_MOUNT_PREPARE_FAILED");

        Logger.error("VM", `[GUEST_FILE_MISSING] Guest reports mount_prepare.sh is NOT visible or NOT readable.`);
        console.log(`[PROVISIONING_VERIFICATION] Actual file existence: false`);

        this.timeouts.cancel("mount_stabilization_watchdog");
        this.provisionExecutionInFlight = false;
        this.orchestrator.triggerRecovery("mount_prepare.sh visibility check failed on guest");
        return;
      }

      if (this.provisioningSearchBuffer.includes("<<<STAGE:MOUNT_OK>>>") || this.provisioningSearchBuffer.includes("<<<MOUNT_STABILIZED>>>")) {
        Logger.info("VM", "[SERIAL_PARSED_MATCH] Matches STAGE:MOUNT_OK or MOUNT_STABILIZED");
        this.timeouts.cancel("mount_stabilization_watchdog");
        Logger.info("VM", "[PROVISIONING] Guest filesystem mount stabilized (STAGE:MOUNT_OK). Transitioning to provisioning state.");
        this.provisioningExecutionCompleted = true;
        this.provisionExecutionInFlight = false; // Release lock!
        this.mountPrepareVerified = true;
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
      } else if (
        this.provisioningSearchBuffer.includes("<<<STAGE:MOUNT_FAIL>>>") || 
        this.provisioningSearchBuffer.includes("STAGE:MOUNT_FAIL") || 
        this.provisioningSearchBuffer.includes("<<<MOUNT_FAILED>>>") ||
        this.provisioningSearchBuffer.includes("[EXECUTION FAILURE]") ||
        this.provisioningSearchBuffer.includes("[GUEST_STALE_DENTRY_RECOVER_FAIL]")
      ) {
        Logger.info("VM", `[SERIAL_PARSED_MATCH] Matches STAGE:MOUNT_FAIL, MOUNT_FAILED, EXECUTION FAILURE, or GUEST_STALE_DENTRY_RECOVER_FAIL`);
        this.timeouts.cancel("mount_stabilization_watchdog");
        this.provisionExecutionInFlight = false; // Release lock!
        Logger.error("VM", `[PROVISIONING] Guest filesystem mount or wrapper execution failed. Buffer: ${this.provisioningSearchBuffer}`);
        this.orchestrator.triggerRecovery("guest mount barrier report failure or wrapper execution failure");
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
      void this.sendProgrammaticInput(0, "stty sane\n");
      void this.sendProgrammaticInput(0, "reset\n");
      
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

    // ── Boot ready: root prompt detected → update FSM precondition, try interactive transition ──
    const state = this.lifecycle.getState().state;
    const canCompleteBoot = (state === "booting" || state === "interactive" || state === "fs9p_ready") && !this.bootCompleted;

    if (hasRootPrompt) {
      // Record prompt seen — precondition 2 for FSM transition to "interactive"
      if (!this.hasSeenPrompt) {
        this.hasSeenPrompt = true;
        Logger.info("VM", "[SHELL GATE] First root prompt observed in serial stream.");
        // Attempt FSM transition to "interactive" (may already be satisfied if SERIAL_READY arrived first)
        this._tryTransitionToInteractive("prompt-detected");
      }
    }

    if (hasRootPrompt && canCompleteBoot && this.provisioning.getState() === "idle") {
      // Wait for prompt to be stable using event-driven awaitPromptStable()
      void this.awaitPromptStable(1000).then(() => {
        const curState = this.lifecycle.getState().state;
        if (curState !== "booting" && curState !== "interactive" && curState !== "fs9p_ready") return;
        if (this.provisioning.getState() !== "idle") return;

        this.timeouts.cancel("prompt_stabilization");
        this.timeouts.cancel("boot_watchdog");

        Logger.info("VM", "<<<VM_BOOT_COMPLETE>>>");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;32m<<<VM_BOOT_COMPLETE>>>\x1b[0m\r\n");
        }
        this.bootCompleted = true;
        this.lifecycle.setBootComplete(true);

        // Try FSM transition to "interactive" now that serial has stabilized.
        // This is the authoritative transition: if preconditions are already met
        // (SERIAL_READY + prompt + no pending stage), the FSM moves to "interactive"
        // immediately. If not yet met, the transition will fire when they are.
        this._tryTransitionToInteractive("boot-complete-stable");

        // Wait for FSM to reach "interactive" before starting mount_prepare execution.
        // awaitFsmState() returns immediately if FSM is already "interactive" or beyond.
        void this.awaitFsmState("interactive").then(() => {
          // ARCHITECTURAL FIX: Do not poll the guest serial output for file visibility.
          // The worker emits FILE_MATERIALIZATION_VERIFIED after confirming the host-side
          // 9p inode write. We wait for that event (or a timeout), then directly execute
          // mount_prepare.sh. The guest need not confirm the file before running it because
          // mount_prepare.sh itself establishes the 9p mount that makes the file visible.
          this._waitForMaterializationThenMount();
        });

        this.provisioningSearchBuffer = "";
      });
    }
  }

  // ─── FSM-Unified Shell Readiness ─────────────────────────────────────────
  // The lifecycle FSM state "interactive" is the SINGLE SOURCE OF TRUTH for
  // shell readiness. All readiness checks must derive from:
  //   lifecycleState === "interactive"
  // The private booleans below are only precondition trackers that feed into
  // the FSM transition. They are never used to gate I/O directly.

  private dumpDiagnosticLogs(): void {
    const activeGen = this.transport.getGenerationManager().getActiveGeneration();
    const bridge = activeGen ? activeGen.bridge : null;
    const workerState = bridge ? bridge.getState() : WorkerBridgeState.UNINITIALIZED;
    const workerResponding = activeGen ? activeGen.isValid && workerState === WorkerBridgeState.READY : false;
    const cpuRunning = this.healthMonitor ? (this.healthMonitor as unknown as { isHealthy: boolean }).isHealthy : true;
    const stateName = this.lifecycle.getState().state;
    const shellGateAllowed = (
      stateName === "interactive" ||
      stateName === "provisioning" ||
      stateName === "shell_ready" ||
      stateName === "terminal_ready" ||
      stateName === "ready"
    );

    Logger.info("VM", "=== VM SYSTEM DIAGNOSTICS ===");
    Logger.info("VM", `  - currentLifecycleState: ${stateName}`);
    Logger.info("VM", `  - promptDetected: ${this.hasSeenPrompt}`);
    Logger.info("VM", `  - serialReady: ${this.receivedSerialReady}`);
    Logger.info("VM", `  - workerHealthy: ${workerResponding}`);
    Logger.info("VM", `  - cpuRunning: ${cpuRunning}`);
    Logger.info("VM", `  - shellGateAllowed: ${shellGateAllowed}`);
    Logger.info("VM", "=============================");
  }

  /**
   * Attempt to transition the FSM from "booting" or "fs9p_ready" to "interactive".
   * Called whenever any precondition changes. Does nothing if:
   *   - FSM is not in "booting" or "fs9p_ready" state
   *   - Not all preconditions are satisfied
   */
  private _tryTransitionToInteractive(trigger: string): void {
    const state = this.lifecycle.getState().state;

    // Log diagnostic logs
    this.dumpDiagnosticLogs();

    // Only transition from "booting" or "fs9p_ready"
    if (state !== "booting" && state !== "fs9p_ready") {
      // Detect split-brain: conditions met but FSM isn't in "booting" or "fs9p_ready"
      if (this.hasSeenPrompt && this.receivedSerialReady && state !== "interactive" &&
          state !== "provisioning" && state !== "shell_ready" && state !== "terminal_ready" && state !== "ready") {
        Logger.warn("VM",
          `[FSM_SPLIT_BRAIN] Shell conditions met (prompt=${this.hasSeenPrompt}, serialReady=${this.receivedSerialReady}) ` +
          `but FSM is in state '${state}' (trigger: ${trigger}). Expected 'booting', 'fs9p_ready', or 'interactive+'.`
        );
      }
      return;
    }

    const promptDetected = this.hasSeenPrompt;
    const serialReady = this.receivedSerialReady;
    const fs9pReady = state === "fs9p_ready" || this.mountPrepareVerified;

    const activeGen = this.transport.getGenerationManager().getActiveGeneration();
    const bridge = activeGen ? activeGen.bridge : null;
    const workerState = bridge ? bridge.getState() : WorkerBridgeState.UNINITIALIZED;
    const workerResponding = activeGen ? activeGen.isValid && workerState === WorkerBridgeState.READY : false;

    if (!promptDetected || !serialReady) {
      Logger.debug("VM", `[SHELL GATE] Preconditions not yet satisfied (trigger: ${trigger}). promptDetected=${promptDetected}, serialReady=${serialReady}`);
      return;
    }

    // Invariant: if promptDetected && serialReady && fs9pReady, transition to interactive!
    if (fs9pReady && workerResponding) {
      Logger.info("VM", `[INTERACTIVE_ENTER] Invariant satisfied (promptDetected=${promptDetected}, serialReady=${serialReady}, fs9pReady=true, workerResponding=true). Transitioning to interactive.`);
      const succeeded = this.transitionState("interactive", `shell-gate:${trigger}`);
      if (succeeded) {
        Logger.info("VM", `[FSM_SYNC_OK] FSM successfully transitioned to 'interactive' (trigger: ${trigger}).`);
        // Flush the deferred queue atomically AFTER the FSM state change
        this._flushDeferredInputQueue();
      } else {
        Logger.error("VM",
          `[FSM_SPLIT_BRAIN] FSM transition to interactive FAILED despite all preconditions being met ` +
          `(trigger: ${trigger}). Current state: ${this.lifecycle.getState().state}`
        );
      }
    } else {
      Logger.debug("VM", `[SHELL GATE] Waiting for fs9pReady or workerResponding. fs9pReady=${fs9pReady}, workerResponding=${workerResponding}`);
    }
  }

  /**
   * Returns a Promise that resolves when the lifecycle FSM reaches the target
   * state or any state that comes after it in the boot sequence.
   * Resolves immediately if already at or past the target state.
   *
   * This replaces waitForInteractiveShell() and is the event-driven bridge
   * between FSM transitions and async continuation chains.
   */
  public awaitFsmState(targetState: VMStateName): Promise<void> {
    const stateOrder: VMStateName[] = ["idle", "loading", "booting", "fs9p_ready", "interactive", "provisioning", "shell_ready", "terminal_ready", "ready"];
    const targetIdx = stateOrder.indexOf(targetState);

    const checkReached = (): boolean => {
      const current = this.lifecycle.getState().state;
      const currentIdx = stateOrder.indexOf(current);
      return currentIdx >= targetIdx && currentIdx !== -1 && targetIdx !== -1;
    };

    if (checkReached()) {
      return Promise.resolve();
    }

    // Poll using the timeout manager — re-check every 50ms until reached or VM stops
    return new Promise<void>((resolve, reject) => {
      const poll = () => {
        if (checkReached()) {
          resolve();
          return;
        }
        const current = this.lifecycle.getState().state;
        if (current === "stopped" || current === "error" || current === "idle") {
          reject(new Error(`[awaitFsmState] VM reached terminal state '${current}' before reaching '${targetState}'.`));
          return;
        }
        this.timeouts.register(`await_fsm_${targetState}`, 50, poll);
      };
      poll();
    });
  }

  /**
   * Waits for the serial stream to be quiet for at least `quietMs` milliseconds
   * (no new characters arriving), then resolves. Event-driven replacement for
   * setTimeout-based prompt stabilization.
   */
  private awaitPromptStable(quietMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        const age = Date.now() - this.lastSerialOutputTimestamp;
        if (age >= quietMs) {
          resolve();
        } else {
          this.timeouts.register("prompt_stabilization", quietMs - age, check);
        }
      };
      this.timeouts.cancel("prompt_stabilization");
      check();
    });
  }

  /**
   * Flush all deferred programmatic inputs queued while FSM was in
   * loading/booting. Called atomically after FSM transitions to "interactive".
   */
  private _flushDeferredInputQueue(): void {
    if (this.deferredInputQueue.length === 0) return;
    Logger.info("VM", `[SHELL GATE] Flushing ${this.deferredInputQueue.length} deferred input(s) after FSM reached 'interactive'.`);
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
    const queryCmd = `sh /root/.provision/status_query.sh\n`;
    
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

      // Send both probe commands separately to obey serial transport guards
      void this.sendProgrammaticInput(0, "\n");
      void this.sendProgrammaticInput(0, "echo '**PONG**'\n");
      void this.sendProgrammaticInput(0, "echo '**SHELL_READY**'\n");
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

  /**
   * Asserts that a serial payload does not violate transport rules:
   *   - Maximum length: <= 128 bytes
   *   - No newline inside (excluding a trailing newline)
   *   - No carriage return inside (excluding a trailing carriage return)
   *   - No heredocs (<<)
   *   - No if/then/fi blocks
   */
  private assertSerialPayload(data: string): void {
    const MAX_SERIAL_PAYLOAD = 128;
    const SERIAL_PROVISIONING_COMMAND_TOO_LARGE = new Error("SERIAL_PROVISIONING_COMMAND_TOO_LARGE");

    // Strip trailing newlines/carriage returns for multiline checks
    const trimmed = data.endsWith("\n") ? data.slice(0, -1) : data;
    const cleanTrimmed = trimmed.endsWith("\r") ? trimmed.slice(0, -1) : trimmed;

    if (data.length > MAX_SERIAL_PAYLOAD) {
      const payload_length = data.length;
      const max_allowed_length = MAX_SERIAL_PAYLOAD;
      const overflow_amount = payload_length - max_allowed_length;
      const payloadBytes = new TextEncoder().encode(data).length;
      
      Logger.error("VM", `[SERIAL_PAYLOAD_SIZE] payload_length: ${payload_length}`);
      Logger.error("VM", `[SERIAL_PAYLOAD_LIMIT] max_allowed_length: ${max_allowed_length}`);
      Logger.error("VM", `[SERIAL_PAYLOAD_REJECTED] Rejected payload size: ${payloadBytes} bytes`);
      Logger.error("VM", `[TRANSPORT GUARD] Oversized command aborted! payload_length: ${payload_length}, max_allowed_length: ${max_allowed_length}, overflow_amount: ${overflow_amount}`);
      console.error(`[SERIAL_PAYLOAD_SIZE] payload_length: ${payload_length}`);
      console.error(`[SERIAL_PAYLOAD_LIMIT] max_allowed_length: ${max_allowed_length}`);
      console.error(`[SERIAL_PAYLOAD_REJECTED] Rejected payload size: ${payloadBytes} bytes`);
      console.error(`[TRANSPORT GUARD] Call stack:\n${SERIAL_PROVISIONING_COMMAND_TOO_LARGE.stack}`);
      console.error(`[TRANSPORT GUARD] Offending payload: ${JSON.stringify(data)}`);
      
      this.transport.post("SERIAL_FRAGMENTATION_DETECTED", {
        reason: "SERIAL_PROVISIONING_COMMAND_TOO_LARGE",
        length: payload_length,
        payload: data.slice(0, max_allowed_length)
      });
      throw SERIAL_PROVISIONING_COMMAND_TOO_LARGE;
    }

    if (
      cleanTrimmed.includes('\n') ||
      cleanTrimmed.includes('\r')
    ) {
      const payloadBytes = new TextEncoder().encode(data).length;
      Logger.error("VM", `[TRANSPORT REJECTION] Command contains internal newlines/carriage returns. command length: ${data.length}, max allowed length: ${MAX_SERIAL_PAYLOAD}, rejected payload size: ${payloadBytes}`);
      console.log(`[TRANSPORT REJECTION] Command contains internal newlines/carriage returns. command length: ${data.length}, max allowed length: ${MAX_SERIAL_PAYLOAD}, rejected payload size: ${payloadBytes}`);
      this.transport.post("SERIAL_FRAGMENTATION_DETECTED", {
        reason: "SERIAL_PROVISIONING_COMMAND_TOO_LARGE",
        length: data.length,
        payload: data.slice(0, MAX_SERIAL_PAYLOAD)
      });
      throw SERIAL_PROVISIONING_COMMAND_TOO_LARGE;
    }

    // 2. Additional Interactive Security Checks
    const hasHeredoc = cleanTrimmed.includes("<<");
    const hasIfThenFi = /\b(if|then|fi)\b/i.test(cleanTrimmed);

    if (hasHeredoc || hasIfThenFi) {
      this.transport.post("SERIAL_FRAGMENTATION_DETECTED", {
        reason: "FORBIDDEN_CONSTRUCTS",
        payload: data.slice(0, 128)
      });
      throw new Error('SERIAL_PROVISIONING_COMMAND_TOO_LARGE');
    }
  }

  public sendInput(data: string): void {
    // Interactivity is decoupled: keyboard input allowed when VM is booting/provisioning/running
    // sendInput does NOT mutate lifecycle — no dispatch() needed.
    const status = this.lifecycle.getState().state;
    if (status !== "ready" && status !== "booting" && status !== "interactive" && status !== "provisioning" && status !== "shell_ready" && status !== "terminal_ready") {
      Logger.warn("VM", `Refusing input: VM in state: ${status}`);
      return;
    }

    // Assert data size and safety constructs before sending
    try {
      this.assertSerialPayload(data);
    } catch (err) {
      Logger.error("VM", `[TRANSPORT ASSERTION] sendInput rejected payload: ${err}`);
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
   * Derives readiness from the lifecycle FSM state — the single source of truth.
   * If FSM is at "interactive" or beyond, sends immediately.
   * Otherwise enqueues for flush when FSM reaches "interactive".
   */
  public queueProgrammaticInput(port: number, data: string): void {
    const stateName = this.lifecycle.getState().state;
    const isInteractiveOrBeyond =
      stateName === "interactive" || stateName === "provisioning" ||
      stateName === "shell_ready" || stateName === "terminal_ready" || stateName === "ready";
    if (isInteractiveOrBeyond) {
      void this.transport.send(port, data);
    } else {
      Logger.info("VM", `[SHELL GATE] Deferring queued input (port=${port}, fsmState=${stateName}): ${JSON.stringify(data.slice(0, 64))}`);
      this.deferredInputQueue.push({ port, data });
    }
  }

  /**
   * Send programmatic serial input.
   * Validated against the lifecycle FSM — the single source of truth.
   *
   * Allowed when FSM is: interactive | provisioning | shell_ready | terminal_ready | ready
   * Deferred when FSM is: loading | booting
   * Rejected when FSM is: idle | stopping | stopped | error
   */
  public sendProgrammaticInput(port: number, data: string): Promise<void> {
    const stateName = this.lifecycle.getState().state;

    // Assert data size and safety constructs before sending on port 0
    if (port === 0) {
      try {
        this.assertSerialPayload(data);
      } catch (err) {
        Logger.error("VM", `[TRANSPORT ASSERTION] sendProgrammaticInput rejected payload: ${err}`);
        return Promise.reject(err);
      }
    }

    // Allowed states — FSM-derived, single source of truth
    if (
      stateName === "interactive" ||
      stateName === "provisioning" ||
      stateName === "shell_ready" ||
      stateName === "terminal_ready" ||
      stateName === "ready"
    ) {
      Logger.debug("VM", `[PROVISIONING_ALLOWED] sendProgrammaticInput: port=${port}, fsmState=${stateName}`);
      return this.transport.send(port, data);
    }

    // Defer during early boot — FSM has not yet transitioned to "interactive"
    if (stateName === "loading" || stateName === "booting" || stateName === "fs9p_ready") {
      Logger.warn("VM",
        `[SHELL GATE] Deferring programmatic input: FSM in '${stateName}' (port=${port}). ` +
        `Input queued until FSM reaches 'interactive'. Data: ${JSON.stringify(data.slice(0, 64))}`
      );
      // Invariant check: if shell conditions are met, FSM MUST NOT be in booting
      if (this.hasSeenPrompt && this.receivedSerialReady && !this.pendingInitStage) {
        Logger.error("VM",
          `[FSM_SPLIT_BRAIN] INVARIANT VIOLATION: Shell conditions fully met ` +
          `(prompt=${this.hasSeenPrompt}, serialReady=${this.receivedSerialReady}, pendingStage=${this.pendingInitStage}) ` +
          `but FSM is still in '${stateName}'. Forcing _tryTransitionToInteractive().`
        );
        this._tryTransitionToInteractive("invariant-repair");
        // After repair attempt, retry immediately
        return this.sendProgrammaticInput(port, data);
      }
      this.deferredInputQueue.push({ port, data });
      return Promise.resolve();
    }

    // Reject for terminal/error states
    Logger.warn("VM", `[SHELL GATE] Refusing programmatic input: FSM in non-interactive state '${stateName}'.`);
    return Promise.resolve();
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

  // ─── Guest-side file existence polling state ────────────────────────────
  private _guestExistsMarker: string | null = null;
  private _guestExistsCallback: (() => void) | null = null;
  private _guestMissingCallback: (() => void) | null = null;
  private _guestPollAttempt = 0;
  private _guestPollMaxRetries = 0;

  /**
   * TRANSPORT LIMIT: Every serial command MUST be under 100 bytes.
   * BusyBox compatible only: no stat, no GNU coreutils extensions.
   * Allowed: test -f, test -r, ls, pwd, mount, echo, mkdir.
   */
  private static readonly SERIAL_CMD_LIMIT = 100;

  /**
   * Assert a serial command string is under the transport limit.
   * Hard fail with Logger.error if exceeded — never silently truncate.
   */
  private _assertCmdLimit(cmd: string, label: string): void {
    if (cmd.length > VMController.SERIAL_CMD_LIMIT) {
      Logger.error("VM", `[TRANSPORT_LIMIT_EXCEEDED] ${label}: ${cmd.length} bytes > ${VMController.SERIAL_CMD_LIMIT} limit. cmd=${JSON.stringify(cmd)}`);
      throw new Error(`SERIAL_CMD_LIMIT exceeded: ${label} is ${cmd.length} bytes`);
    }
  }

  /**
   * Send a serial command with transport limit assertion.
   */
  private _sendChecked(cmd: string, label: string): void {
    this._assertCmdLimit(cmd, label);
    void this.sendProgrammaticInput(0, cmd);
  }

  /**
   * Verify guest-side visibility before executing mount_prepare.sh.
   *
   * All commands are BusyBox-compatible (no stat) and under 100 bytes.
   * Does NOT assume /root/.provision exists. Discovers path from guest.
   *
   * Flow:
   *   1. Log guest environment (pwd, mount, ls /mnt, ls /mnt/9p)
   *   2. Poll guest: test -f on 9p-native path first
   *   3. If exists → [GUEST_FILE_EXISTS] → execute
   *   4. If missing → [GUEST_FILE_MISSING] → inline mount fallback
   */
  private verifyAndExecuteMountScript(): void {
    Logger.info("VM", `[VERIFY_PATH] Materialization received. Beginning guest-side verification.`);

    this.provisioningExecutionStarted = true;
    this.provisionExecutionInFlight = true;

    // PHASE 1: Guest environment diagnostics — each command under 100 bytes
    Logger.info("VM", "[VERIFY_STAT] Running guest-side diagnostics (BusyBox only)...");
    this._sendChecked("pwd\n", "diag_pwd");                            // 4 bytes
    this._sendChecked("mount\n", "diag_mount");                          // 6 bytes
    this._sendChecked("ls /mnt\n", "diag_ls_mnt");                       // 8 bytes
    this._sendChecked("ls /mnt/9p 2>/dev/null\n", "diag_ls_9p");         // 22 bytes
    this._sendChecked("ls /mnt/9p/root 2>/dev/null\n", "diag_ls_9p_root"); // 28 bytes
    this._sendChecked("ls -l /root/.provision 2>/dev/null\n", "diag_ls_prov"); // 34 bytes
    // Tasks 5, 6, 7: Recursive directory lists under 100 bytes
    this._sendChecked("ls -R /mnt/9p 2>/dev/null\n", "diag_ls_9p_r");         // 26 bytes
    this._sendChecked("ls -R /mnt/9p/root 2>/dev/null\n", "diag_ls_9p_root_r"); // 31 bytes
    this._sendChecked("ls -R /mnt/9p/root/.provision 2>/dev/null\n", "diag_ls_9p_prov_r"); // 42 bytes

    // PHASE 2: Guest-side existence check — try 9p native path first
    // /mnt/9p/root/.provision is the 9p-native path that doesn't need the symlink
    Logger.info("VM", "[VERIFY_INODE] Starting guest-side existence check...");
    this._pollGuestFileExists(
      "/mnt/9p/root/.provision/mount_prepare.sh",  // check 9p-native path
      5,    // max retries
      300,  // initial delay ms
      () => {
        // File found at 9p-native path — run from there
        Logger.info("VM", `[GUEST_FILE_EXISTS] true`);
        Logger.info("VM", `[GUEST_FILE_SIZE] ${this.verifiedInodeSize}`);
        Logger.info("VM", `[GUEST_FILE_PATH] /mnt/9p/root/.provision/mount_prepare.sh`);
        this.mountPrepareVerified = true;

        Logger.info("VM", "[GUEST_FILE_EXISTS] Found at /mnt/9p path. Executing.");
        this._sendChecked(
          "sh /mnt/9p/root/.provision/mount_prepare.sh\n",
          "exec_9p_native"
        );  // 46 bytes
      },
      () => {
        // Not at 9p path — try mounting 9p first, then execute
        Logger.info("VM", `[GUEST_FILE_EXISTS] false`);
        Logger.info("VM", `[GUEST_FILE_SIZE] unknown`);
        Logger.info("VM", `[GUEST_FILE_PATH] /mnt/9p/root/.provision/mount_prepare.sh`);

        Logger.warn("VM", "[GUEST_FILE_MISSING] Not at /mnt/9p. Trying mount fallback.");
        this._tryDirectMountFallback();
      }
    );
  }

  /**
   * Poll the guest filesystem to confirm a file exists.
   * Uses `test -f` via serial — BusyBox compatible, no stat.
   * Every probe command is under 100 bytes.
   */
  private _pollGuestFileExists(
    path: string,
    maxRetries: number,
    delayMs: number,
    onExists: () => void,
    onMissing: () => void
  ): void {
    this._guestPollAttempt = 0;
    this._guestPollMaxRetries = maxRetries;
    // Short marker — keep total probe command under 100 bytes and avoid "<<<" to satisfy transport constraints
    const ts = Date.now() % 100000; // 5 digits max
    const marker = `GF_OK_${ts}`;
    this._guestExistsMarker = marker;
    this._guestExistsCallback = onExists;
    this._guestMissingCallback = onMissing;

    const probe = () => {
      this._guestPollAttempt++;
      if (this._guestPollAttempt > this._guestPollMaxRetries) {
        Logger.error("VM", `[GUEST_FILE_MISSING] Failed after ${this._guestPollMaxRetries} attempts for ${path}`);
        this.timeouts.cancel("guest_file_poll");
        const cb = this._guestMissingCallback;
        this._guestExistsMarker = null;
        this._guestExistsCallback = null;
        this._guestMissingCallback = null;
        if (cb) cb();
        return;
      }

      Logger.info("VM", `[VERIFY_INODE] Guest poll ${this._guestPollAttempt}/${this._guestPollMaxRetries}`);

      // Task 9 Telemetry on Guest side (each command under 100 bytes)
      this._sendChecked(`p=${path}\n`, "p_assign");
      this._sendChecked(`test -f $p && echo "GUEST_FILE_EXISTS: true" || echo "GUEST_FILE_EXISTS: false"\n`, "g_exists");
      this._sendChecked(`test -f $p && echo "GUEST_FILE_SIZE: $(wc -c <$p)"\n`, "g_size");
      this._sendChecked(`test -f $p && echo "GUEST_FILE_PATH: $p"\n`, "g_path");

      // Probe: test -f PATH && echo MARKER > /dev/ttyS0
      // Split into two commands to stay under limit
      // Quote-split the marker command to bypass shell command echo false positives
      const splitMarker = marker.substring(0, 2) + "'" + marker.substring(2, 3) + "'" + marker.substring(3);
      const testCmd = `test -f ${path} && echo ${splitMarker}>/dev/ttyS0\n`;
      const missCmd = `test -f ${path} || echo GF'_'MISS>/dev/ttyS0\n`;

      if (testCmd.length > VMController.SERIAL_CMD_LIMIT || missCmd.length > VMController.SERIAL_CMD_LIMIT) {
        Logger.error("VM", `[TRANSPORT_LIMIT_EXCEEDED] probe cmd too long: test=${testCmd.length}, miss=${missCmd.length}`);
        // Fallback: skip polling, go straight to missing handler
        const cb = this._guestMissingCallback;
        this._guestExistsMarker = null;
        this._guestExistsCallback = null;
        this._guestMissingCallback = null;
        if (cb) cb();
        return;
      }

      void this.sendProgrammaticInput(0, testCmd);
      void this.sendProgrammaticInput(0, missCmd);

      // Schedule retry
      const retryDelay = delayMs * this._guestPollAttempt;
      this.timeouts.register("guest_file_poll", retryDelay, () => {
        probe();
      });
    };

    probe();
  }

  /**
   * Fallback: mount 9p and run mount_prepare.sh from native 9p path.
   * Every command is under 100 bytes. BusyBox compatible only.
   */
  private _tryDirectMountFallback(): void {
    Logger.info("VM", "[GUEST_FILE_MISSING] Direct 9p mount fallback.");

    // Each command individually under 100 bytes:
    this._sendChecked("mkdir -p /mnt/9p\n", "fb_mkdir");                  // 18 bytes
    this._sendChecked(
      "mount|grep -q /mnt/9p||mount -t 9p -o trans=virtio host9p /mnt/9p\n",
      "fb_mount_simple"
    );  // 65 bytes
    this._sendChecked("ls /mnt/9p/root 2>/dev/null\n", "fb_ls_verify");    // 28 bytes

    // Guest side telemetry fallback
    const mp = "/mnt/9p/root/.provision/mount_prepare.sh";
    this._sendChecked(`p=${mp}\n`, "fb_p_assign");
    this._sendChecked(`test -f $p && echo "GUEST_FILE_EXISTS: true" || echo "GUEST_FILE_EXISTS: false"\n`, "fb_g_exists");
    this._sendChecked(`test -f $p && echo "GUEST_FILE_SIZE: $(wc -c <$p)"\n`, "fb_g_size");
    this._sendChecked(`test -f $p && echo "GUEST_FILE_PATH: $p"\n`, "fb_g_path");

    // Check if file exists at 9p native path, then execute or fail
    // Split into two separate commands for clarity and limit safety
    // Quote-split to bypass command echo false positives
    this._sendChecked(
      `test -f ${mp} && sh ${mp}\n`,
      "fb_test_exec"
    );  // 73 bytes
    this._sendChecked(
      `test -f ${mp} || echo STAGE':'MOUNT'_'FAIL>/dev/ttyS0\n`,
      "fb_test_fail"
    );  // 63 bytes
  }

  /**
   * Wait for FILE_MATERIALIZATION_VERIFIED from the worker, then execute mount_prepare.sh.
   *
   * Replaces the old serial-echo visibility poll (startFileVisibilityVerification).
   *
   * Flow:
   *   1. If FILE_MATERIALIZATION_VERIFIED already arrived (mountPrepareVerified), proceed immediately.
   *   2. Otherwise register a pending callback fired by the message handler.
   *   3. A 10-second timeout guard triggers PROVISIONING_REINJECTION on failure.
   */
  private _waitForMaterializationThenMount(): void {
    if (this.isProvisioningAttemptStarted) {
      Logger.warn("VM", "[PROVISIONING] Provisioning attempt already in progress. Ignoring duplicate trigger.");
      return;
    }
    this.isProvisioningAttemptStarted = true;

    const executeMountScript = () => {
      this.verifyAndExecuteMountScript();

      this.timeouts.register("mount_stabilization_watchdog", 15000, () => {
        if (!this.provisioningExecutionStarted) {
          Logger.warn("VM", "[PROVISIONING] mount_stabilization_watchdog fired, but execution was never actually attempted. Skipping.");
          return;
        }
        // If execution is in flight or already started, do NOT reinject as it causes inode replacement races.
        // Instead, escalate to recovery directly which cleanly reboots the VM.
        Logger.error("VM", "[PROVISIONING] mount_stabilization_watchdog fired. Guest mount did not stabilize in 15 seconds. Escating directly to recovery reboot.");
        this.provisionExecutionInFlight = false;
        this.orchestrator.triggerRecovery("mount stabilization timeout during execution");
      });
    };

    if (this.hostMaterialized || this.mountPrepareVerified) {
      Logger.info("VM", "[PROVISIONING] mount_prepare.sh already materialized (fast path). Executing immediately.");
      executeMountScript();
      return;
    }

    Logger.info("VM", "[PROVISIONING] Waiting for FILE_MATERIALIZATION_VERIFIED from worker...");

    this.pendingMaterializationVerified = executeMountScript;
    this.pendingMaterializationFailed = () => {
      Logger.error("VM", "[PROVISIONING] Materialization verification failed. Triggering PROVISIONING_REINJECTION.");
      this.handleVisibilityFailure();
    };

    this.timeouts.register("materialization_watchdog", 10000, () => {
      if (this.pendingMaterializationVerified) {
        Logger.error("VM", "[PROVISIONING] materialization_watchdog fired: FILE_MATERIALIZATION_VERIFIED not received within 10s.");
        this.dumpMaterializationDiagnostics();
        const cb = this.pendingMaterializationFailed;
        this.pendingMaterializationVerified = null;
        this.pendingMaterializationFailed = null;
        if (cb) cb();
      }
    });
  }

  private dumpMaterializationDiagnostics(): void {
    Logger.error("VM", "=== MATERIALIZATION DIAGNOSTICS ===");
    Logger.error("VM", `  - mountPrepareVerified: ${this.mountPrepareVerified}`);
    Logger.error("VM", `  - FSM state: ${this.lifecycle.getState().state}`);
    Logger.error("VM", `  - Provisioning state: ${this.provisioning.getState()}`);
    Logger.error("VM", `  - Last serial output age: ${Date.now() - this.lastSerialOutputTimestamp}ms`);
    Logger.error("VM", `  - Worker generation valid: ${this.transport.getGenerationManager().getActiveGeneration()?.isValid}`);
    Logger.error("VM", "  - [ACTION] Will trigger PROVISION_REINJECT to re-inject mount_prepare.sh via worker message channel.");
    Logger.error("VM", "===================================");
  }

  /**
   * Handle file visibility / materialization failure.
   *
   * Old behavior: trigger generic recovery (TTY -> shell -> serial -> soft reboot -> cold boot).
   * New behavior: trigger targeted PROVISIONING_REINJECTION via PROVISION_REINJECT worker message,
   * which reruns create_file() for mount_prepare.sh without touching TTY/shell/serial.
   * Only escalates to full recovery chain if reinject itself fails.
   */
  private handleVisibilityFailure(): void {
    const stateName = this.lifecycle.getState().state;
    const isInteractiveOrBeyond = (
      stateName === "interactive" ||
      stateName === "provisioning" ||
      stateName === "shell_ready" ||
      stateName === "terminal_ready" ||
      stateName === "ready"
    );

    if (!isInteractiveOrBeyond) {
      Logger.warn("VM", `[PROVISIONING] handleVisibilityFailure: FSM in non-interactive state '${stateName}'. Aborting reinjection.`);
      return;
    }

    if (this.provisionExecutionInFlight) {
      Logger.warn("VM", "[PROVISIONING] handleVisibilityFailure: Execution is currently in flight. Aborting reinjection.");
      return;
    }

    if (!this.provisioningExecutionStarted && stateName !== "interactive") {
      Logger.warn("VM", `[PROVISIONING] handleVisibilityFailure: Execution not started and FSM in state '${stateName}'. Aborting reinjection.`);
      return;
    }

    Logger.error("VM", "[PROVISIONING] handleVisibilityFailure: Triggering PROVISIONING_REINJECTION (targeted file reinject).");
    Logger.error("VM", "[PROVISIONING] This targets the host-side 9p file injection layer, NOT the TTY/shell/serial transport.");

    this.timeouts.cancel("mount_stabilization_watchdog");
    this.pendingMaterializationVerified = null;
    this.pendingMaterializationFailed = null;
    this.mountPrepareVerified = false;

    this.transport.post("PROVISION_REINJECT", { path: "/root/.provision/mount_prepare.sh" });

    this.pendingMaterializationVerified = () => {
      Logger.info("VM", "[PROVISIONING] File reinjection confirmed. Verifying mount_prepare.sh visibility on guest.");
      this.verifyAndExecuteMountScript();
      this.timeouts.register("mount_stabilization_watchdog", 20000, () => {
        Logger.error("VM", "[PROVISIONING] mount_stabilization_watchdog fired after reinject. Escalating to generic recovery.");
        this.orchestrator.triggerRecovery("file reinject mount stabilization timeout");
      });
    };

    this.timeouts.register("reinject_watchdog", 15000, () => {
      if (this.pendingMaterializationVerified) {
        Logger.error("VM", "[PROVISIONING] reinject_watchdog fired: PROVISION_REINJECT did not complete within 15s. Escalating.");
        this.pendingMaterializationVerified = null;
        this.pendingMaterializationFailed = null;
        this.orchestrator.triggerRecovery("provisioning reinjection timeout");
      }
    });
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
    void this.sendProgrammaticInput(0, "sync\n");
    // Quote-split to bypass command echo false positives
    const checkCmd = `[ -f "${this.verifyingFilePath}" ] && echo PROV'_'FILES'_'VISIBLE\n`;
    void this.sendProgrammaticInput(0, checkCmd);
    const delay = Math.min(1000 + (this.fileVisibilityRetries * 250), 3000);
    this.fileVisibilityTimer = setTimeout(() => {
      this.pollFileVisibility();
    }, delay);
  }

  private stopHealthMonitoring(): void {
    if (this.healthMonitor) {
      this.healthMonitor.stop();
      this.healthMonitor = null;
    }
  }
}
