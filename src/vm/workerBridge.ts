// src/vm/workerBridge.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Logger } from "../lib/logger";

export class WorkerBridge {
  private worker: Worker | null = null;
  private onMessageCallback: ((type: string, payload: any) => void) | null = null;

  public initialize(workerUrl: string, onMessage: (type: string, payload: any) => void): void {
    if (this.worker) {
      Logger.warn("VM", "Pre-existing worker found in WorkerBridge. Terminating it first.");
      this.terminate();
    }

    Logger.info("VM", `Initializing worker from URL: ${workerUrl}`);
    this.worker = new Worker(workerUrl);
    this.onMessageCallback = onMessage;

    this.worker.onmessage = (e: MessageEvent) => {
      if (!e.data) return;
      const { type, payload } = e.data;
      if (this.onMessageCallback) {
        this.onMessageCallback(type, payload);
      }
    };

    this.worker.onerror = (err) => {
      Logger.error("VM", "Worker process crashed or encountered an error", err);
      if (this.onMessageCallback) {
        this.onMessageCallback("INIT_FAILURE", String(err));
      }
    };
  }

  public post(type: string, payload?: any): void {
    if (!this.worker) {
      Logger.warn("VM", "Attempted to post message to an uninitialized worker bridge");
      return;
    }
    this.worker.postMessage({ type, payload });
  }

  public terminate(): void {
    if (this.worker) {
      Logger.info("VM", "Terminating worker bridge...");
      try {
        this.worker.postMessage({ type: "DESTROY" });
        this.worker.terminate();
      } catch (err) {
        Logger.warn("VM", "Exception during worker termination", err);
      }
      this.worker = null;
      this.onMessageCallback = null;
    }
  }
}
