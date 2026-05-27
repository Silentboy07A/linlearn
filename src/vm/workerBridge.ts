// src/vm/workerBridge.ts
import { Logger } from "../lib/logger";

export enum WorkerBridgeState {
  UNINITIALIZED = "uninitialized",
  INITIALIZING = "initializing",
  READY = "ready",
  DEGRADED = "degraded",
  FAILED = "failed",
  TERMINATING = "terminating",
  TERMINATED = "terminated",
  RECOVERING = "recovering"
}

export class WorkerBridgeError extends Error {
  public readonly isFatal: boolean = true;
  constructor(message: string) {
    super(message);
    this.name = "WorkerBridgeError";
  }
}

export class WorkerBridgeTeardownError extends WorkerBridgeError {
  public override readonly isFatal = false;
  constructor(generationId: number, state: string) {
    super(`Worker bridge ${generationId} intentionally stopped/teardown (state: ${state})`);
    this.name = "WorkerBridgeTeardownError";
  }
}

export class WorkerBridgeStaleError extends WorkerBridgeError {
  public override readonly isFatal = false;
  constructor(generationId: number, activeId: number) {
    super(`Worker bridge ${generationId} is stale. Active generation is ${activeId}`);
    this.name = "WorkerBridgeStaleError";
  }
}

export class WorkerBridge {
  private worker: Worker | null = null;
  private state: WorkerBridgeState = WorkerBridgeState.UNINITIALIZED;
  private onMessageCallback: ((type: string, payload: unknown) => void) | null = null;
  
  // Handshake resolution
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((err: Error) => void) | null = null;
  
  // Deferred message queue
  private deferredQueue: { type: string; payload?: unknown }[] = [];
  
  // Generation & lifecycle metadata
  private generationId: number;
  private createdAt: number;
  private ownershipToken: string;
  private isValid: boolean;

  // Telemetry
  private initStartedAt = 0;
  private readyAt = 0;
  private queuedCount = 0;
  private droppedCount = 0;
  private errorCount = 0;

  constructor(generationId: number = 0, ownershipToken: string = "") {
    this.generationId = generationId;
    this.createdAt = Date.now();
    this.ownershipToken = ownershipToken;
    this.isValid = true;
  }

  public getGenerationId(): number {
    return this.generationId;
  }

  public getCreatedAt(): number {
    return this.createdAt;
  }

  public getOwnershipToken(): string {
    return this.ownershipToken;
  }

  public getIsValid(): boolean {
    return this.isValid;
  }

  public invalidate(): void {
    this.isValid = false;
  }

  public getState(): WorkerBridgeState {
    return this.state;
  }

  public getTelemetry() {
    return {
      state: this.state,
      generationId: this.generationId,
      createdAt: this.createdAt,
      isValid: this.isValid,
      initLatencyMs: this.readyAt > 0 ? this.readyAt - this.initStartedAt : null,
      queuedMessages: this.queuedCount,
      droppedMessages: this.droppedCount,
      errors: this.errorCount
    };
  }

  private transitionTo(newState: WorkerBridgeState): void {
    if (this.state === newState) return;
    Logger.info("VM", `[WorkerBridge ${this.generationId}] State transition: ${this.state} -> ${newState}`);
    this.state = newState;

    if (
      newState === WorkerBridgeState.FAILED ||
      newState === WorkerBridgeState.TERMINATING ||
      newState === WorkerBridgeState.TERMINATED
    ) {
      if (this.readyRejecter) {
        const rej = this.readyRejecter;
        this.readyResolver = null;
        this.readyRejecter = null;
        
        if (newState === WorkerBridgeState.TERMINATING || newState === WorkerBridgeState.TERMINATED || !this.isValid) {
          rej(new WorkerBridgeTeardownError(this.generationId, newState));
        } else {
          rej(new WorkerBridgeError(`Worker bridge ${this.generationId} transitioned to non-functional state: ${newState}`));
        }
      }
    }
  }

  public initializeBridge(workerUrl: string, onMessage: (type: string, payload: unknown) => void): Promise<void> {
    if (this.state === WorkerBridgeState.INITIALIZING) {
      Logger.warn("VM", `[WorkerBridge ${this.generationId}] Initialization already in progress.`);
      return this.waitUntilReady();
    }

    if (this.worker) {
      Logger.warn("VM", `[WorkerBridge ${this.generationId}] Pre-existing worker found. Terminating before new session.`);
      this.terminate("new initialization requested");
    }

    this.initStartedAt = Date.now();
    this.readyAt = 0;
    this.transitionTo(WorkerBridgeState.INITIALIZING);
    this.onMessageCallback = onMessage;
    this.deferredQueue = [];

    return new Promise<void>((resolve, reject) => {
      // Setup timeout for worker initialization: 10 seconds max
      const initTimeout = setTimeout(() => {
        if (this.state === WorkerBridgeState.INITIALIZING && this.isValid) {
          Logger.error("VM", `[WorkerBridge ${this.generationId}] Initialization timed out after 10s.`);
          this.transitionTo(WorkerBridgeState.FAILED);
          reject(new WorkerBridgeError("Worker initialization timed out"));
        }
      }, 10000);

      try {
        this.worker = new Worker(workerUrl);

        this.worker.onmessage = (e: MessageEvent) => {
          if (!this.isValid || this.state === WorkerBridgeState.TERMINATED || this.state === WorkerBridgeState.TERMINATING) {
            return;
          }
          if (!e.data) return;
          console.log("[WORKER MESSAGE]", e.data);
          const { type, payload, generation } = e.data;

          if (generation !== undefined && generation !== 0 && generation !== this.generationId) {
            Logger.warn("VM", `[WorkerBridge ${this.generationId}] Dropping message '${type}' from stale worker generation ${generation}`);
            return;
          }

          if (type === "WORKER_READY") {
            clearTimeout(initTimeout);
            this.readyAt = Date.now();
            this.transitionTo(WorkerBridgeState.READY);
            Logger.info("VM", `[WorkerBridge ${this.generationId}] Handshake received. Ready in ${this.readyAt - this.initStartedAt}ms`);
            
            // Resolve the handshake promise
            resolve();
            if (this.readyResolver) {
              const res = this.readyResolver;
              this.readyResolver = null;
              this.readyRejecter = null;
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
          if (!this.isValid || this.state === WorkerBridgeState.TERMINATED || this.state === WorkerBridgeState.TERMINATING) {
            return;
          }
          clearTimeout(initTimeout);
          this.errorCount++;
          Logger.error("VM", `[WorkerBridge ${this.generationId}] Worker thread error`, err);
          
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
    if (
      this.state === WorkerBridgeState.FAILED || 
      this.state === WorkerBridgeState.TERMINATING ||
      this.state === WorkerBridgeState.TERMINATED ||
      !this.isValid
    ) {
      const err = (!this.isValid || this.state === WorkerBridgeState.TERMINATING || this.state === WorkerBridgeState.TERMINATED)
        ? new WorkerBridgeTeardownError(this.generationId, this.state)
        : new WorkerBridgeError(`Worker bridge ${this.generationId} is in non-functional state: ${this.state}`);
      return Promise.reject(err);
    }

    return new Promise<void>((resolve, reject) => {
      const prevResolver = this.readyResolver;
      const prevRejecter = this.readyRejecter;
      
      this.readyResolver = () => {
        if (prevResolver) prevResolver();
        resolve();
      };
      this.readyRejecter = (err) => {
        if (prevRejecter) prevRejecter(err);
        reject(err);
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
      Logger.info("VM", `[WorkerBridge ${this.generationId}] Queueing message: ${type} (state: ${this.state})`);
      this.deferredQueue.push({ type, payload });
      return;
    }

    this.droppedCount++;
    Logger.warn("VM", `[WorkerBridge ${this.generationId}] Dropped message: ${type} (state is ${this.state})`);
  }

  private flushQueue(): void {
    if (!this.worker || this.state !== WorkerBridgeState.READY) return;
    
    Logger.info("VM", `[WorkerBridge ${this.generationId}] Flushing ${this.deferredQueue.length} deferred messages`);
    const queue = this.deferredQueue;
    this.deferredQueue = [];
    
    for (const msg of queue) {
      this.worker.postMessage({ ...msg, generation: this.generationId });
    }
  }

  public terminate(reason: string = "unspecified"): void {
    if (this.state === WorkerBridgeState.TERMINATED) return;

    this.isValid = false;
    this.transitionTo(WorkerBridgeState.TERMINATING);
    
    if (this.worker) {
      Logger.info("VM", `[WorkerBridge ${this.generationId}] Terminating worker thread due to: ${reason}`);
      try {
        this.worker.postMessage({ type: "DESTROY" });
        this.worker.terminate();
      } catch (err) {
        Logger.warn("VM", `[WorkerBridge ${this.generationId}] Exception during worker termination`, err);
      }
      this.worker = null;
    }
    this.onMessageCallback = null;
    this.readyResolver = null;
    this.readyRejecter = null;
    this.deferredQueue = [];
    this.transitionTo(WorkerBridgeState.TERMINATED);
  }
}
