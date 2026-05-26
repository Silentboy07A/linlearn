// src/vm/workerBridge.ts
import { Logger } from "../lib/logger";

export enum WorkerBridgeState {
  UNINITIALIZED = "uninitialized",
  INITIALIZING = "initializing",
  READY = "ready",
  DEGRADED = "degraded",
  FAILED = "failed",
  TERMINATED = "terminated"
}

export class WorkerBridge {
  private worker: Worker | null = null;
  private state: WorkerBridgeState = WorkerBridgeState.UNINITIALIZED;
  private onMessageCallback: ((type: string, payload: unknown) => void) | null = null;
  
  // Handshake resolution
  private readyResolver: (() => void) | null = null;
  
  // Deferred message queue
  private deferredQueue: { type: string; payload?: unknown }[] = [];
  
  // Telemetry
  private initStartedAt = 0;
  private readyAt = 0;
  private queuedCount = 0;
  private droppedCount = 0;
  private errorCount = 0;

  public getState(): WorkerBridgeState {
    return this.state;
  }

  public getTelemetry() {
    return {
      state: this.state,
      initLatencyMs: this.readyAt > 0 ? this.readyAt - this.initStartedAt : null,
      queuedMessages: this.queuedCount,
      droppedMessages: this.droppedCount,
      errors: this.errorCount
    };
  }

  private transitionTo(newState: WorkerBridgeState): void {
    if (this.state === newState) return;
    Logger.info("VM", `[WorkerBridge] State transition: ${this.state} -> ${newState}`);
    this.state = newState;
  }

  public initializeBridge(workerUrl: string, onMessage: (type: string, payload: unknown) => void): Promise<void> {
    if (this.state === WorkerBridgeState.INITIALIZING) {
      Logger.warn("VM", "[WorkerBridge] Initialization already in progress.");
      return this.waitUntilReady();
    }

    if (this.worker) {
      Logger.warn("VM", "[WorkerBridge] Pre-existing worker found. Terminating before new session.");
      this.terminate();
    }

    this.initStartedAt = Date.now();
    this.readyAt = 0;
    this.transitionTo(WorkerBridgeState.INITIALIZING);
    this.onMessageCallback = onMessage;
    this.deferredQueue = [];

    return new Promise<void>((resolve, reject) => {
      // Setup timeout for worker initialization: 10 seconds max
      const initTimeout = setTimeout(() => {
        if (this.state === WorkerBridgeState.INITIALIZING) {
          Logger.error("VM", "[WorkerBridge] Initialization timed out after 10s.");
          this.transitionTo(WorkerBridgeState.FAILED);
          reject(new Error("Worker initialization timed out"));
        }
      }, 10000);

      try {
        this.worker = new Worker(workerUrl);

        this.worker.onmessage = (e: MessageEvent) => {
          if (!e.data) return;
          const { type, payload } = e.data;

          if (type === "WORKER_READY") {
            clearTimeout(initTimeout);
            this.readyAt = Date.now();
            this.transitionTo(WorkerBridgeState.READY);
            Logger.info("VM", `[WorkerBridge] Handshake received. Ready in ${this.readyAt - this.initStartedAt}ms`);
            
            // Resolve the handshake promise
            resolve();
            if (this.readyResolver) {
              const res = this.readyResolver;
              this.readyResolver = null;
              res();
            }

            // Flush deferred queue
            this.flushQueue();
            return;
          }

          if (this.onMessageCallback) {
            this.onMessageCallback(type, payload);
          }
        };

        this.worker.onerror = (err) => {
          clearTimeout(initTimeout);
          this.errorCount++;
          Logger.error("VM", "[WorkerBridge] Worker thread error", err);
          
          if (this.state === WorkerBridgeState.INITIALIZING) {
            this.transitionTo(WorkerBridgeState.FAILED);
            reject(err);
          } else if (this.state === WorkerBridgeState.READY) {
            this.transitionTo(WorkerBridgeState.DEGRADED);
          }
          
          if (this.onMessageCallback) {
            this.onMessageCallback("INIT_FAILURE", String(err));
          }
        };

      } catch (err) {
        clearTimeout(initTimeout);
        this.transitionTo(WorkerBridgeState.FAILED);
        reject(err);
      }
    });
  }

  public waitUntilReady(): Promise<void> {
    if (this.state === WorkerBridgeState.READY) {
      return Promise.resolve();
    }
    if (this.state === WorkerBridgeState.FAILED || this.state === WorkerBridgeState.TERMINATED) {
      return Promise.reject(new Error(`Worker bridge is in non-functional state: ${this.state}`));
    }

    return new Promise<void>((resolve) => {
      const prevResolver = this.readyResolver;
      this.readyResolver = () => {
        if (prevResolver) prevResolver();
        resolve();
      };
    });
  }

  public post(type: string, payload?: unknown): void {
    if (this.state === WorkerBridgeState.READY && this.worker) {
      this.worker.postMessage({ type, payload });
      return;
    }

    if (this.state === WorkerBridgeState.INITIALIZING || this.state === WorkerBridgeState.UNINITIALIZED) {
      this.queuedCount++;
      Logger.info("VM", `[WorkerBridge] Queueing message: ${type} (state: ${this.state})`);
      this.deferredQueue.push({ type, payload });
      return;
    }

    this.droppedCount++;
    Logger.warn("VM", `[WorkerBridge] Dropped message: ${type} (state is ${this.state})`);
  }

  private flushQueue(): void {
    if (!this.worker || this.state !== WorkerBridgeState.READY) return;
    
    Logger.info("VM", `[WorkerBridge] Flushing ${this.deferredQueue.length} deferred messages`);
    const queue = this.deferredQueue;
    this.deferredQueue = [];
    
    for (const msg of queue) {
      this.worker.postMessage(msg);
    }
  }

  public terminate(): void {
    this.transitionTo(WorkerBridgeState.TERMINATED);
    if (this.worker) {
      Logger.info("VM", "[WorkerBridge] Terminating worker thread...");
      try {
        this.worker.postMessage({ type: "DESTROY" });
        this.worker.terminate();
      } catch (err) {
        Logger.warn("VM", "[WorkerBridge] Exception during worker termination", err);
      }
      this.worker = null;
    }
    this.onMessageCallback = null;
    this.readyResolver = null;
    this.deferredQueue = [];
  }
}
