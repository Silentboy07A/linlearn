// src/vm/emulatorManager.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { WorkerBridge } from "./workerBridge";
import { VMLifecycleManager } from "./vmLifecycle";
import { ResourceLimitsValidator } from "./resourceLimits";
import { VMSessionConfig, VMState } from "../lib/types";
import { Logger } from "../lib/logger";
import { VMInitializationError } from "../lib/errors";
import { GUEST_INSPECT_SCRIPT } from "./inspect";

export class EmulatorManager {
  private static activeInstance: EmulatorManager | null = null;

  public static getActiveInstance(): EmulatorManager | null {
    return EmulatorManager.activeInstance;
  }

  public static setActiveInstance(instance: EmulatorManager | null): void {
    EmulatorManager.activeInstance = instance;
  }

  private bridge: WorkerBridge;
  private lifecycle: VMLifecycleManager;
  private config: VMSessionConfig;
  private onSerialOutput: ((data: string) => void) | null = null;
  private onStateChange: ((state: string) => void) | null = null;

  private saveStateResolver: ((buffer: ArrayBuffer) => void) | null = null;
  private saveStateRejecter: ((err: any) => void) | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private serialHistory: string = "";

  // ─── Initialization mutex ─────────────────────────────────────────────────
  private initPromise: Promise<void> | null = null;
  private initAbortController: AbortController | null = null;

  constructor(config: Partial<VMSessionConfig> = {}) {
    this.bridge = new WorkerBridge();
    this.lifecycle = new VMLifecycleManager();
    this.config = ResourceLimitsValidator.validate(config);
  }

  public async start(
    origin: string,
    onSerial: (data: string) => void,
    onState: (state: string) => void,
    initialState?: ArrayBuffer
  ): Promise<void> {
    // Mutex: prevent concurrent start() calls
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
    this.lifecycle.transitionTo("loading", this.config.memoryLimitBytes, "EmulatorManager.start");

    const workerUrl = `${origin}/v86/v86-worker.js?v=${Date.now()}`;

    // Start provisioning watchdog if cold boot
    if (!initialState) {
      this.startWatchdog();
    }

    return new Promise((resolve, reject) => {
      if (abortSignal.aborted) {
        reject(new VMInitializationError("Start aborted"));
        return;
      }

      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          this.transitionState("error", "boot timeout");
          this.bridge.terminate();
          this.stopWatchdog();
          reject(new VMInitializationError(`Boot timeout exceeded: ${this.config.timeoutMs}ms`));
        }
      }, this.config.timeoutMs);

      this.bridge.initialize(workerUrl, (type, payload) => {
        if (abortSignal.aborted) return;

        switch (type) {
          case "INIT_SUCCESS":
            if (initialState) {
              // Direct transition to running for instant restoration
              this.transitionState("running", "INIT_SUCCESS (snapshot restore)");
              clearTimeout(timeout);
              if (!resolved) {
                resolved = true;
                resolve();
              }
            }
            // For cold boot, don't transition here — worker will send STATE_CHANGED("booting")
            break;

          case "INIT_FAILURE":
            clearTimeout(timeout);
            this.transitionState("error", "INIT_FAILURE");
            if (!resolved) {
              resolved = true;
              reject(new VMInitializationError(String(payload)));
            }
            break;

          case "SERIAL_OUT":
            if (this.lifecycle.getState().state === "booting") {
              // Resolve the promise to indicate the VM has started executing,
              // but leave the state as "booting" until prompt is matched.
              clearTimeout(timeout);
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
            if (this.onSerialOutput) {
              this.onSerialOutput(char);
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
              // Worker is the source of truth — accept its state without echoing back
              const newState = payload as any;
              let mappedState: VMState["state"] = newState;
              if (newState === "failed") mappedState = "error";
              if (newState === "destroyed") mappedState = "stopped";
              // Use fromWorker=true to suppress the echo back to worker
              this.transitionState(mappedState, "worker STATE_CHANGED", true);
            }
            break;
        }
      });

      this.bridge.post("INIT", {
        origin,
        memory_size: this.config.memoryLimitBytes,
        vga_memory_size: this.config.vgaMemoryLimitBytes,
        version: Date.now().toString(),
        initial_state: initialState,
      });
    });
  }

  public reattach(
    onSerial: (data: string) => void,
    onState: (state: string) => void
  ): void {
    Logger.info("VM", "Reattaching listeners to active VM session");
    this.onSerialOutput = onSerial;
    this.onStateChange = onState;
    // Notify client of the current state immediately
    onState(this.lifecycle.getState().state);
  }

  public detach(): void {
    Logger.info("VM", "Detaching listeners from active VM session");
    this.onSerialOutput = null;
    this.onStateChange = null;
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

      // 10 second timeout for saving state buffer
      setTimeout(() => {
        if (this.saveStateRejecter === reject) {
          this.saveStateResolver = null;
          this.saveStateRejecter = null;
          reject(new Error("VM snapshot save operation timed out."));
        }
      }, 10000);
    });
  }

  public sendInput(data: string): void {
    if (!this.lifecycle.isAlive()) {
      Logger.warn("VM", "Refusing to send user keyboard input: VM is not alive");
      return;
    }
    this.bridge.post("INPUT", data);
  }

  public sendProgrammaticInput(data: string): void {
    const stateName = this.lifecycle.getState().state;
    if (stateName !== "running" && stateName !== "booting" && stateName !== "provisioning") {
      Logger.warn("VM", `Refusing to send programmatic serial input: VM is in non-interactive state: ${stateName}`);
      return;
    }
    this.bridge.post("INPUT", data);
  }

  /**
   * Transition the main-thread lifecycle state.
   * @param newState   Target state
   * @param source     Where this transition originated
   * @param fromWorker If true, skip echoing state back to worker (breaks feedback loop)
   */
  public transitionState(newState: VMState["state"], source?: string, fromWorker: boolean = false): void {
    try {
      this.lifecycle.transitionTo(newState, undefined, source);
    } catch (e) {
      Logger.warn("VM", `Ignored invalid state transition to ${newState}: ${e}`);
      return;
    }
    if (this.onStateChange) this.onStateChange(newState);

    // Only sync state back to worker if this transition did NOT originate from the worker
    // This is the key fix that breaks the echo loop:
    //   Worker STATE_CHANGED -> main transitionState(fromWorker=true) -> NO echo back
    //   Local transitionState(fromWorker=false) -> sync to worker
    if (!fromWorker) {
      let workerState: string = newState;
      if (newState === "stopped") workerState = "destroyed";
      if (newState === "error") workerState = "failed";
      this.bridge.post("SET_STATE", workerState);
    }

    if (newState === "provisioning") {
      this.startProvisioningWatchdog();
    } else if (newState === "running" || newState === "stopped" || newState === "error") {
      this.stopWatchdog();
    }
  }

  /**
   * Request the worker to transition to provisioning state.
   * This keeps the worker as the single source of truth.
   */
  public requestProvisioningTransition(): void {
    this.bridge.post("SET_PROVISIONING");
  }

  /**
   * Request the worker to transition to running state.
   * This keeps the worker as the single source of truth.
   */
  public requestRunningTransition(): void {
    this.bridge.post("SET_RUNNING");
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    Logger.info("VM", "Starting boot watchdog timer (45s)...");
    this.watchdogTimer = setTimeout(() => {
      const currentState = this.lifecycle.getState().state;
      if (currentState === "loading" || currentState === "booting") {
        Logger.warn("VM", `[WATCHDOG] VM boot stalled in state: ${currentState}. Recovering...`);
        this.transitionState("running", "watchdog recovery");
        
        // Execute recovery script to revive shell and stty settings
        const recoveryScript = `\n\x03\x03\nstty echo\nreset\nchown user /dev/ttyS0 2>/dev/null || true\ncat << 'EOF' > /usr/bin/linlearn-inspect\n${GUEST_INSPECT_SCRIPT}\nEOF\nchmod +x /usr/bin/linlearn-inspect\nsu - user\nexport PS1='user@linlearn:\\w\\$ '\necho "PROVISIONING_COMPLETE"\n`;
        this.sendProgrammaticInput(recoveryScript);

        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;33m[Watchdog] Boot took too long. Restoring shell and forcing interactive mode...\x1b[0m\r\n");
        }
      }
    }, 45000); // 45 seconds for kernel boot
  }

  private startProvisioningWatchdog(): void {
    this.stopWatchdog();
    Logger.info("VM", "Starting provisioning watchdog timer (15s)...");
    this.watchdogTimer = setTimeout(() => {
      const currentState = this.lifecycle.getState().state;
      if (currentState === "provisioning") {
        Logger.warn("VM", `[WATCHDOG] VM provisioning stalled. Recovering...`);
        this.transitionState("running", "provisioning watchdog recovery");
        
        // Execute recovery script to revive shell and stty settings
        const recoveryScript = `\n\x03\x03\nstty echo\nreset\nchown user /dev/ttyS0 2>/dev/null || true\ncat << 'EOF' > /usr/bin/linlearn-inspect\n${GUEST_INSPECT_SCRIPT}\nEOF\nchmod +x /usr/bin/linlearn-inspect\nsu - user\nexport PS1='user@linlearn:\\w\\$ '\necho "PROVISIONING_COMPLETE"\n`;
        this.sendProgrammaticInput(recoveryScript);

        if (this.onSerialOutput) {
          this.onSerialOutput("\r\n\x1b[1;33m[Watchdog] Provisioning took too long. Restoring shell and forcing interactive mode...\x1b[0m\r\n");
        }
      }
    }, 15000); // 15 seconds for provisioning commands
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  public async stop(): Promise<void> {
    Logger.info("VM", "Stopping guest VM session...");

    // Abort any in-progress start
    if (this.initAbortController) {
      this.initAbortController.abort();
    }

    this.stopWatchdog();
    this.transitionState("stopped", "EmulatorManager.stop");
    this.bridge.terminate();
    this.onSerialOutput = null;
    this.onStateChange = null;
    this.saveStateResolver = null;
    this.saveStateRejecter = null;
    if (EmulatorManager.getActiveInstance() === this) {
      EmulatorManager.setActiveInstance(null);
    }
  }

  public getLifecycleState() {
    return this.lifecycle.getState();
  }
}
