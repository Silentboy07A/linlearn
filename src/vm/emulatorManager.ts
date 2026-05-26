// src/vm/emulatorManager.ts
import { WorkerBridge } from "./workerBridge";
import { VMLifecycleManager } from "./vmLifecycle";
import { ResourceLimitsValidator } from "./resourceLimits";
import { VMSessionConfig, VMStateName, VMSnapshotMetadata } from "../lib/types";
import { Logger } from "../lib/logger";
import { VMInitializationError } from "../lib/errors";
import { GUEST_INSPECT_SCRIPT } from "./inspect";
import { TerminalHealthMonitor } from "./healthMonitor";

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
  private watchdogTimer: NodeJS.Timeout | null = null;
  private serialHistory: string = "";

  private wasRestoredFromSnapshot = false;
  private savedState: ArrayBuffer | null = null;

  private lastInputTimestamp = Date.now();
  private lastSerialOutputTimestamp = Date.now();
  private lastRestoreTimestamp = 0;
  private healthMonitor: TerminalHealthMonitor | null = null;
  private rebootAttempts: number[] = [];

  // Centralized provisioning state machine and buffer
  private provisioningState: "idle" | "in-progress" | "complete" = "idle";
  private isProvisioning = false;
  private isProvisioned = false;
  private provisioningSearchBuffer = "";

  // Programmatic throttled sequential queue
  private programmaticQueue: string[] = [];
  private isSendingProgrammatic = false;

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
        Logger.warn("VM", "Invalid snapshot magic bytes (expected gzip 0x1F 0x8B). Discarding corrupted state.");
        this.wasRestoredFromSnapshot = false;
        this.savedState = null;
      }
    } else {
      this.wasRestoredFromSnapshot = false;
      this.savedState = null;
      Logger.info("VM", "No snapshot found or empty snapshot. Clean cold boot.");
    }

    this.isProvisioned = false;
    this.isProvisioning = false;
    this.provisioningState = "idle";
    this.provisioningSearchBuffer = "";

    this.lifecycle.transitionTo("loading", this.config.memoryLimitBytes, "VMController.start");

    const workerUrl = `${origin}/v86/v86-worker.js?v=${Date.now()}`;

    // Start boot watchdog
    this.startWatchdog();

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
            // For both cold boot and snapshot-recovery, don't transition here — worker will send STATE_CHANGED("booting")
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

            // Track last serial output timestamp for watchdog activity checks
            this.lastSerialOutputTimestamp = Date.now();

            // Centralized prompt matching and provisioning triggers
            this.handleSerialLifecycle(char);

            // Refresh provisioning watchdog if provisioning is active
            this.refreshProvisioningWatchdog();

            // Print character to UI terminal (hide outputs printed during silent provisioning)
            if (this.onSerialOutput && !this.isProvisioning) {
              this.onSerialOutput(char);
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
        initial_state: undefined, // Always force cold boot for guest stability
      });
    });
  }

  private handleSerialLifecycle(char: string): void {
    if (this.provisioningState === "complete") return;

    this.provisioningSearchBuffer += char;
    if (this.provisioningSearchBuffer.length > 256) {
      this.provisioningSearchBuffer = this.provisioningSearchBuffer.substring(this.provisioningSearchBuffer.length - 256);
    }

    const hasRootPrompt = this.provisioningSearchBuffer.endsWith("~% ") || 
                          this.provisioningSearchBuffer.endsWith("# ") || 
                          this.provisioningSearchBuffer.endsWith("~# ");
    const hasUserSentinel = this.provisioningSearchBuffer.includes("PROVISIONING_COMPLETE");

    if (hasRootPrompt && this.provisioningState === "idle") {
      this.provisioningState = "in-progress";
      this.isProvisioning = true;
      this.requestProvisioningTransition();

      Logger.info("VM", "[PROVISIONING] Root shell prompt detected in guest. Initiating provisioning sequence.");

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

      // Send silent provisioning commands sequentially and throttled to prevent UART overflows
      this.sendProgrammaticInput(`stty -echo\nhostname linlearn\nmkdir -p /home/user/Projects /home/user/.config /home/user/workspace\nadduser -D -h /home/user -s /bin/sh user 2>/dev/null || true\n${restoreCmd}cat << 'EOF' > /home/user/.profile\nexport HOME=/home/user\nexport PS1='user@linlearn:\\$(pwd | sed "s|^\\$HOME|~|")\\\\$ '\ncd /home/user\nstty echo\necho "PROVISIONING_COMPLETE"\nEOF\ncat << 'EOF' > /usr/bin/linlearn-inspect\n${GUEST_INSPECT_SCRIPT}\nEOF\nchmod +x /usr/bin/linlearn-inspect\nchown -R user:user /home/user\nchown user /dev/ttyS0\nexec sh -c 'while true; do chown user /dev/ttyS0; su - user; done'\n`);
    } else if (hasUserSentinel && this.provisioningState === "in-progress") {
      this.provisioningSearchBuffer = "";
      this.isProvisioning = false;
      this.isProvisioned = true;
      this.provisioningState = "complete";
      this.requestRunningTransition();

      Logger.info("VM", "[PROVISIONING] Sentinel matched. Guest user environment provisioned.");

      if (this.onSerialOutput) {
        this.onSerialOutput("\x1b[1;36mWelcome to the LinLearn Virtual Training Environment!\x1b[0m\r\n");
        this.onSerialOutput(" * System Sandbox: \x1b[1;32mActive (100% Secure, No host access)\x1b[0m\r\n");
        this.onSerialOutput(" * Active Profile: \x1b[1;33muser@linlearn\x1b[0m\r\n\r\n");
        this.onSerialOutput("Try running: \x1b[1;33mcd Projects\x1b[0m, \x1b[1;33mtouch file.txt\x1b[0m, or explore folders.\r\n\r\n");
      }
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
    this.lastInputTimestamp = Date.now();
    Logger.info("VM", `sendInput: routing character sequence to bridge: ${JSON.stringify(data)}`);
    try {
      this.bridge.post("INPUT", data);
    } catch (err: unknown) {
      if (this.healthMonitor) {
        this.healthMonitor.reportSerialError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  public sendProgrammaticInput(data: string): void {
    const stateName = this.lifecycle.getState().state;
    if (stateName !== "running" && stateName !== "booting" && stateName !== "provisioning") {
      Logger.warn("VM", `Refusing to send programmatic serial input: VM is in non-interactive state: ${stateName}`);
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

    if (newState === "provisioning") {
      this.refreshProvisioningWatchdog();
    } else if (newState === "running" || newState === "stopped" || newState === "error") {
      this.stopWatchdog();
      if (newState === "running") {
        this.startHealthMonitoring();
      } else {
        this.stopHealthMonitoring();
      }
    }

    return true;
  }

  public requestProvisioningTransition(): void {
    this.bridge.post("SET_PROVISIONING");
  }

  public requestRunningTransition(): void {
    this.bridge.post("SET_RUNNING");
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    Logger.info("VM", "Starting boot watchdog timer (45s)...");
    this.watchdogTimer = setTimeout(() => {
      const currentState = this.lifecycle.getState().state;
      if (currentState === "loading" || currentState === "booting") {
        // Skip boot watchdog check if we've seen recent serial output activity
        if (Date.now() - this.lastSerialOutputTimestamp < 15000) {
          Logger.info("VM", "[WATCHDOG] Boot watchdog: VM is progressing (active serial output). Extending boot grace period.");
          this.startWatchdog();
          return;
        }
        Logger.warn("VM", `[WATCHDOG] VM boot stalled in state: ${currentState}. Recovering...`);
        this.recoverShell();
      }
    }, 45000);
  }

  private refreshProvisioningWatchdog(): void {
    if (this.lifecycle.getState().state !== "provisioning") return;
    this.stopWatchdog();
    Logger.debug("VM", "[WATCHDOG] Refreshing provisioning watchdog due to serial output activity.");
    this.watchdogTimer = setTimeout(() => {
      if (this.lifecycle.getState().state === "provisioning") {
        // Double check active serial output before declaring provisioning stalled
        if (Date.now() - this.lastSerialOutputTimestamp < 15000) {
          Logger.info("VM", "[WATCHDOG] Provisioning watchdog: active serial output detected. Extending grace period.");
          this.refreshProvisioningWatchdog();
          return;
        }
        Logger.warn("VM", `[WATCHDOG] VM provisioning stalled (no output for 45s). Recovering...`);
        this.recoverShell();
      }
    }, 45000); // 45s of absolute silence during provisioning triggers reboot
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  public async stop(): Promise<void> {
    Logger.info("VM", "Stopping guest VM session...");

    if (this.initAbortController) {
      this.initAbortController.abort();
    }

    this.stopWatchdog();
    this.transitionState("stopped", "VMController.stop");
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

  public wasRestored(): boolean {
    return this.wasRestoredFromSnapshot;
  }

  public clearWasRestored(): void {
    this.wasRestoredFromSnapshot = false;
  }

  private startHealthMonitoring(): void {
    this.stopHealthMonitoring();
    Logger.info("VM", "Starting periodic shell health monitoring (every 20s)...");
    this.healthMonitor = new TerminalHealthMonitor(
      (type, payload) => this.bridge.post(type, payload),
      () => this.recoverShell(),
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
    const now = Date.now();

    // Async-safe state validation: check if VM is still in an active/interactive state
    const state = this.lifecycle.getState().state;
    if (state !== "running" && state !== "booting" && state !== "provisioning" && state !== "loading") {
      Logger.info("VM", `[Watchdog] Skipping recovery: VM state is ${state}`);
      return;
    }

    // Cooldown check: if a snapshot restore occurred within the last 20 seconds, skip recovery
    if (this.lastRestoreTimestamp > 0 && now - this.lastRestoreTimestamp < 20000) {
      Logger.info("VM", "[Watchdog] Skipping recovery: within snapshot restore cooldown.");
      return;
    }

    // Keep only attempts in the last 60 seconds
    this.rebootAttempts = this.rebootAttempts.filter(t => now - t < 60000);

    if (this.rebootAttempts.length >= 3) {
      Logger.error("VM", "[WATCHDOG] Reboot loop detected! 3 failures in 60s. Suspending watchdog to prevent storms.");
      if (this.onSerialOutput) {
        this.onSerialOutput("\r\n\x1b[1;31m[Watchdog] Critical: VM is stuck in a reboot loop. Boot suspended to protect state. Please click 'Reset VM State' to format.\x1b[0m\r\n");
      }
      this.transitionState("error", "reboot_loop_prevented");
      await this.stop();
      return;
    }

    this.rebootAttempts.push(now);
    Logger.error("VM", `[HEALTH] Session is unresponsive (reboot attempt ${this.rebootAttempts.length}/3). Rebooting guest VM...`);

    // Discard possibly corrupted snapshot on second failure
    if (this.rebootAttempts.length === 2) {
      Logger.warn("VM", "[WATCHDOG] Second boot failure. Discarding possibly corrupted snapshot to force clean recovery.");
      if (this.onSerialOutput) {
        this.onSerialOutput("\r\n\x1b[1;33m[Watchdog] Detecting snapshot corruption. Discarding snapshot and booting clean factory state...\x1b[0m\r\n");
      }
      this.savedState = null;
      this.wasRestoredFromSnapshot = false;
    }

    const activeOnSerial = this.onSerialOutput;
    const activeOnState = this.onStateChange;
    if (activeOnSerial && activeOnState) {
      if (this.onSerialOutput) {
        this.onSerialOutput("\r\n\x1b[1;31m[Watchdog] Guest virtual machine is unresponsive. Rebooting...\x1b[0m\r\n");
      }
      await this.stop();
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Perform clean boot and let it restore files
      await this.start(
        window.location.origin, 
        activeOnSerial, 
        activeOnState, 
        this.savedState || undefined
      );
    }
  }
}
