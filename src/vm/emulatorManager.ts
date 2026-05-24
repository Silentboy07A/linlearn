// src/vm/emulatorManager.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { WorkerBridge } from "./workerBridge";
import { VMLifecycleManager } from "./vmLifecycle";
import { ResourceLimitsValidator } from "./resourceLimits";
import { VMSessionConfig } from "../lib/types";
import { Logger } from "../lib/logger";
import { VMInitializationError } from "../lib/errors";

export class EmulatorManager {
  private bridge: WorkerBridge;
  private lifecycle: VMLifecycleManager;
  private config: VMSessionConfig;
  private onSerialOutput: ((data: string) => void) | null = null;
  private onStateChange: ((state: string) => void) | null = null;

  private saveStateResolver: ((buffer: ArrayBuffer) => void) | null = null;
  private saveStateRejecter: ((err: any) => void) | null = null;

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
    if (this.lifecycle.isAlive()) {
      Logger.warn("VM", "VM already running. Destroying it before starting new session.");
      await this.stop();
    }

    this.onSerialOutput = onSerial;
    this.onStateChange = onState;
    this.lifecycle.transitionTo("loading", this.config.memoryLimitBytes);

    const workerUrl = `${origin}/v86/v86-worker.js?v=${Date.now()}`;

    return new Promise((resolve, reject) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          this.lifecycle.transitionTo("failed");
          this.bridge.terminate();
          reject(new VMInitializationError(`Boot timeout exceeded: ${this.config.timeoutMs}ms`));
        }
      }, this.config.timeoutMs);

      this.bridge.initialize(workerUrl, (type, payload) => {
        switch (type) {
          case "INIT_SUCCESS":
            if (initialState) {
              // Direct transition to running for instant restoration
              this.lifecycle.transitionTo("running");
              if (this.onStateChange) this.onStateChange("running");
              clearTimeout(timeout);
              if (!resolved) {
                resolved = true;
                resolve();
              }
            } else {
              this.lifecycle.transitionTo("booting");
              if (this.onStateChange) this.onStateChange("booting");
            }
            break;

          case "INIT_FAILURE":
            clearTimeout(timeout);
            this.lifecycle.transitionTo("failed");
            if (this.onStateChange) this.onStateChange("failed");
            if (!resolved) {
              resolved = true;
              reject(new VMInitializationError(String(payload)));
            }
            break;

          case "SERIAL_OUT":
            if (this.lifecycle.getState().state === "booting") {
              this.lifecycle.transitionTo("running");
              if (this.onStateChange) this.onStateChange("running");
              clearTimeout(timeout);
              if (!resolved) {
                resolved = true;
                resolve();
              }
            }
            const char = typeof payload === "number" ? String.fromCharCode(payload) : String(payload);
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
              const newState = payload as any;
              this.lifecycle.transitionTo(newState);
              if (this.onStateChange) this.onStateChange(newState);
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
    if (this.lifecycle.getState().state !== "running" && this.lifecycle.getState().state !== "booting") {
      Logger.warn("VM", "Refusing to send serial input: VM is not in running/booting state");
      return;
    }
    this.bridge.post("INPUT", data);
  }

  public async stop(): Promise<void> {
    Logger.info("VM", "Stopping guest VM session...");
    this.lifecycle.transitionTo("destroyed");
    if (this.onStateChange) this.onStateChange("destroyed");
    this.bridge.terminate();
    this.onSerialOutput = null;
    this.onStateChange = null;
    this.saveStateResolver = null;
    this.saveStateRejecter = null;
  }

  public getLifecycleState() {
    return this.lifecycle.getState();
  }
}
