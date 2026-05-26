// src/vm/emulatorManager.ts
import { WorkerBridge } from "./workerBridge";
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

export class VMController {
  private static activeInstance: VMController | null = null;

  public static getActiveInstance(): VMController | null {
    return VMController.activeInstance;
  }

  public static setActiveInstance(instance: VMController | null): void {
    VMController.activeInstance = instance;
  }

  private bridge: WorkerBridge;
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

  // Programmatic throttled sequential queue
  private programmaticQueue: string[] = [];
  private isSendingProgrammatic = false;

  // Initialization mutex
  private initPromise: Promise<void> | null = null;
  private initAbortController: AbortController | null = null;

  constructor(config: Partial<VMSessionConfig> = {}) {
    this.bridge = new WorkerBridge();
    this.lifecycle = new VMLifecycleManager();
    this.config = ResourceLimitsValidator.validate(config);

    // Initialize unified timeout manager
    this.timeouts = new UnifiedTimeoutManager();

    // Initialize provisioning controller
    this.provisioning = new ProvisioningController(
      (state) => this.lifecycle.transitionProvisioningTo(state, "ProvisioningController"),
      (data) => this.sendProgrammaticInput(data)
    );

    // Initialize recovery orchestrator
    this.orchestrator = new RecoveryOrchestrator(
      this.timeouts,
      (stage) => this.handleRecoveryAction(stage),
      (state) => this.lifecycle.transitionRecoveryTo(state, "RecoveryOrchestrator")
    );
  }

  public async start(
    origin: string,
    onSerial: (data: string) => void,
    onState: (state: string) => void,
    initialState?: ArrayBuffer
  ): Promise<void> {
    if (this.initPromise) {
      Logger.warn("VM", "VM is already starting. Ignoring redundant start call.");
      return;
    }

    if (this.lifecycle.isAlive()) {
      Logger.warn("VM", "VM already running. Destroying it before starting new session.");
      await this.stop();
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

      this.bridge.initialize(workerUrl, (type, payload) => {
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
            if (this.onSerialOutput && this.provisioning.getState() !== "running") {
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
      });

      this.bridge.post("INIT", {
        origin,
        memory_size: this.config.memoryLimitBytes,
        vga_memory_size: this.config.vgaMemoryLimitBytes,
        version: Date.now().toString(),
        initial_state: undefined, // Force cold boot, restore files via provisioning
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
    const hasUserSentinel = this.provisioningSearchBuffer.includes("PROVISIONING_COMPLETE");

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
        if (this.provisioning.getState() === "running") {
          Logger.warn("VM", "Provisioning watchdog triggered. Provisioning stalled.");
          this.provisioning.handleFailure();
          this.orchestrator.triggerRecovery("provisioning timeout exceeded");
        }
      });

      this.provisioning.startProvisioning(restoreCmd, GUEST_INSPECT_SCRIPT);

    } else if (hasUserSentinel && this.provisioning.getState() === "running") {
      this.timeouts.cancel("provisioning_watchdog");
      this.provisioningSearchBuffer = "";

      this.provisioning.handleProvisioningComplete();
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

  private async handleRecoveryAction(stage: RecoveryStage): Promise<boolean> {
    switch (stage) {
      case RecoveryStage.SHELL_RECONNECT:
        Logger.info("VM", "Recovery [Stage 1]: Sending carriage return to recover terminal...");
        this.sendInput("\n");
        return true;

      case RecoveryStage.SERIAL_REBIND:
        Logger.info("VM", "Recovery [Stage 2]: Re-triggering state changes listeners...");
        if (this.onStateChange) {
          this.onStateChange(this.lifecycle.getState().state);
        }
        return true;

      case RecoveryStage.TERMINAL_RECOVERY:
        Logger.info("VM", "Recovery [Stage 3]: Resetting visual prompt on screen...");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;33m[Recovery] Redrawing terminal prompt...\x1b[0m\r\n");
          const promptPath = "~";
          const symbol = "$";
          this.onSerialOutput(`\r\n\x1b[1;32muser@linlearn\x1b[0m:\x1b[1;34m${promptPath}\x1b[0m${symbol} `);
        }
        return true;

      case RecoveryStage.WORKER_RESTART:
        Logger.info("VM", "Recovery [Stage 4]: Restarting worker processes...");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;31m[Recovery] Worker unresponsive. Restarting worker adapter...\x1b[0m\r\n");
        }
        await this.recoverShell();
        return true;

      case RecoveryStage.VM_SOFT_REBOOT:
        Logger.info("VM", "Recovery [Stage 5]: Performing soft restart...");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;31m[Recovery] Stalled guest CPU. Triggering soft reboot...\x1b[0m\r\n");
        }
        this.bridge.post("RESTART");
        return true;

      case RecoveryStage.COLD_BOOT_FALLBACK:
        Logger.info("VM", "Recovery [Stage 6]: Triggering cold boot fallback...");
        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;31m[Recovery] Recovery exhausted. Cleaning corrupted snapshot and cold booting...\x1b[0m\r\n");
        }
        this.savedState = null;
        this.wasRestoredFromSnapshot = false;
        await this.recoverShell();
        return true;

      case RecoveryStage.NONE:
      default:
        Logger.warn("VM", "Recovery suspended or unknown stage executed.");
        await this.stop();
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

  public reattach(
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

  public detach(): void {
    Logger.info("VM", "Detaching listeners from active VM session");
    this.onSerialOutput = null;
    this.onStateChange = null;
    this.lifecycle.transitionTerminalTo("detached", "VMController.detach");
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

      this.bridge.post("SAVE_STATE");

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
    const status = this.lifecycle.getState().state;
    if (status !== "running" && status !== "booting" && status !== "provisioning") {
      Logger.warn("VM", `Refusing input: VM in state: ${status}`);
      return;
    }
    this.lastInputTimestamp = Date.now();
    try {
      this.bridge.post("INPUT", data);
      
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

  public sendProgrammaticInput(data: string): void {
    const stateName = this.lifecycle.getState().state;
    if (stateName !== "running" && stateName !== "booting" && stateName !== "provisioning") {
      Logger.warn("VM", `Refusing programmatic input in non-interactive state: ${stateName}`);
      return;
    }
    this.programmaticQueue.push(data);
    this.processProgrammaticQueue();
  }

  private processProgrammaticQueue(): void {
    if (this.isSendingProgrammatic || this.programmaticQueue.length === 0) {
      return;
    }

    this.isSendingProgrammatic = true;
    const data = this.programmaticQueue.shift()!;
    
    const chunkSize = 64;
    const delayMs = 15;
    let offset = 0;

    const sendNextChunk = () => {
      if (!this.lifecycle.isAlive()) {
        this.isSendingProgrammatic = false;
        return;
      }
      if (offset >= data.length) {
        this.isSendingProgrammatic = false;
        this.processProgrammaticQueue();
        return;
      }
      const chunk = data.substring(offset, offset + chunkSize);
      offset += chunkSize;
      this.bridge.post("INPUT", chunk);
      setTimeout(sendNextChunk, delayMs);
    };

    sendNextChunk();
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
      this.bridge.post("SET_STATE", workerState);
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
    this.bridge.post("SET_PROVISIONING");
  }

  public requestRunningTransition(): void {
    this.bridge.post("SET_RUNNING");
  }

  public async stop(): Promise<void> {
    Logger.info("VM", "Stopping guest VM session...");

    if (this.initAbortController) {
      this.initAbortController.abort();
    }

    this.timeouts.clearAll();
    this.orchestrator.reset();
    this.transitionState("stopped", "VMController.stop");
    this.lifecycle.transitionTerminalTo("detached", "VMController.stop");
    this.bridge.terminate();
    this.onSerialOutput = null;
    this.onStateChange = null;
    this.saveStateResolver = null;
    this.saveStateRejecter = null;
    if (VMController.getActiveInstance() === this) {
      VMController.setActiveInstance(null);
    }
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
      (type, payload) => this.bridge.post(type, payload),
      () => this.orchestrator.triggerRecovery("health check failure"),
      () => Math.max(this.lastInputTimestamp, this.lastSerialOutputTimestamp)
    );
    this.healthMonitor.start();
  }

  private stopHealthMonitoring(): void {
    if (this.healthMonitor) {
      this.healthMonitor.stop();
      this.healthMonitor = null;
    }
  }

  public async recoverShell(): Promise<void> {
    const activeOnSerial = this.onSerialOutput;
    const activeOnState = this.onStateChange;
    
    if (activeOnSerial && activeOnState) {
      await this.stop();
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Perform fresh initialization
      await this.start(
        window.location.origin, 
        activeOnSerial, 
        activeOnState, 
        this.savedState || undefined
      );
    }
  }
}
