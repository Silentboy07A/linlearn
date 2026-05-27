// src/vm/workerBridge.ts
import { Logger } from "../lib/logger";

export enum WorkerBridgeState {
  UNINITIALIZED = "uninitialized",
  INITIALIZING = "initializing",
  ATTACHING_LISTENERS = "attaching_listeners",
  INITIALIZING_SERIAL = "initializing_serial",
  COMMITTING_GENERATION = "committing_generation",
  READY = "ready",
  DEGRADED = "degraded",
  FAILED = "failed",
  TERMINATING = "terminating",
  TERMINATED = "terminated",
  RECOVERING = "recovering"
}

export interface BridgeReadinessValidator {
  isSerialAttached: () => boolean;
  isGenerationCommitted: (genId: number) => boolean;
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

  // Readiness barrier flags
  private handshakeReceived = false;
  private listenersAttached = false;
  private serialInitialized = false;
  private generationCommitted = false;

  // Telemetry timestamps
  private handshakeReceivedAt = 0;
  private listenersAttachedAt = 0;
  private serialInitializedAt = 0;
  private fsmReadyCommittedAt = 0;
  private initDispatchedAt = 0;

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

  public getHandshakeReceived(): boolean {
    return this.handshakeReceived;
  }

  public getListenersAttached(): boolean {
    return this.listenersAttached;
  }

  public getSerialInitialized(): boolean {
    return this.serialInitialized;
  }

  public getGenerationCommitted(): boolean {
    return this.generationCommitted;
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

  public initializeBridge(
    workerUrl: string, 
    onMessage: (type: string, payload: unknown) => void,
    validator: BridgeReadinessValidator
  ): Promise<void> {
    if (
      this.state === WorkerBridgeState.INITIALIZING ||
      this.state === WorkerBridgeState.ATTACHING_LISTENERS ||
      this.state === WorkerBridgeState.INITIALIZING_SERIAL ||
      this.state === WorkerBridgeState.COMMITTING_GENERATION
    ) {
      Logger.warn("VM", `[WorkerBridge ${this.generationId}] Initialization already in progress (state: ${this.state}).`);
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

    // Reset barrier flags
    this.handshakeReceived = false;
    this.listenersAttached = false;
    this.serialInitialized = false;
    this.generationCommitted = false;

    // Reset telemetry
    this.handshakeReceivedAt = 0;
    this.listenersAttachedAt = 0;
    this.serialInitializedAt = 0;
    this.fsmReadyCommittedAt = 0;
    this.initDispatchedAt = 0;

    Logger.info("VM", `[BRIDGE INIT START] Starting WorkerBridge initialization for generation ${this.generationId}`);

    return new Promise<void>((resolve, reject) => {
      // Setup timeout for worker initialization: 10 seconds max
      const initTimeout = setTimeout(() => {
        if (
          (this.state === WorkerBridgeState.INITIALIZING ||
           this.state === WorkerBridgeState.ATTACHING_LISTENERS ||
           this.state === WorkerBridgeState.INITIALIZING_SERIAL ||
           this.state === WorkerBridgeState.COMMITTING_GENERATION) && 
          this.isValid
        ) {
          Logger.error("VM", `[BRIDGE INIT TIMEOUT DIAGNOSTICS] WorkerBridge initialization timed out after 10s. ` +
            `State: ${this.state}, ` +
            `workerExists: ${!!this.worker}, ` +
            `onmessageRegistered: ${typeof this.worker?.onmessage}, ` +
            `handshakeReceived: ${this.handshakeReceived}, ` +
            `listenersAttached: ${this.listenersAttached}, ` +
            `serialInitialized: ${this.serialInitialized}, ` +
            `generationCommitted: ${this.generationCommitted}`
          );
          this.transitionTo(WorkerBridgeState.FAILED);
          reject(new WorkerBridgeError(`Worker initialization timed out at state: ${this.state}`));
        }
      }, 10000);

      try {
        Logger.info("VM", `[WorkerBridge ${this.generationId}] [initializeWorker] Instantiating Web Worker...`);
        this.worker = new Worker(workerUrl);
        Logger.info("VM", `[WORKER CREATED] Web Worker instantiated successfully for generation ${this.generationId}`);

        Logger.info("VM", `[WorkerBridge ${this.generationId}] [awaitHandshake] Registering handshake listener and awaiting WORKER_READY...`);
        Logger.info("VM", `[HANDSHAKE WAIT] Waiting for WORKER_READY handshake from generation ${this.generationId}`);

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
            Logger.info("VM", `[HANDSHAKE RECEIVED] Received WORKER_READY handshake for generation ${this.generationId}`);
            clearTimeout(initTimeout);
            this.readyAt = Date.now();
            
            // 1. Handshake received
            this.handshakeReceived = true;
            this.handshakeReceivedAt = Date.now();
            this.transitionTo(WorkerBridgeState.ATTACHING_LISTENERS);
            Logger.info("VM", `[WorkerBridge ${this.generationId}] Handshake received. Transitioning to ATTACHING_LISTENERS`);
            
            // 2. Attach listeners
            try {
              if (this.onMessageCallback) {
                this.listenersAttached = true;
                this.listenersAttachedAt = Date.now();
                this.transitionTo(WorkerBridgeState.INITIALIZING_SERIAL);
                Logger.info("VM", `[LISTENERS ATTACHED] Listeners attached and verified for generation ${this.generationId}`);
              } else {
                throw new Error("onMessageCallback is missing");
              }
            } catch (attachErr) {
              const attachErrMsg = attachErr instanceof Error ? attachErr.message : String(attachErr);
              Logger.error("VM", `[WorkerBridge ${this.generationId}] [LISTENERS ATTACHED FAILED] Listener verification failed: ${attachErrMsg}`);
              this.transitionTo(WorkerBridgeState.FAILED);
              reject(new WorkerBridgeError(`Listener verification failed: ${attachErrMsg}`));
              return;
            }

            // 3. Initialize serial
            try {
              if (validator.isSerialAttached()) {
                this.serialInitialized = true;
                this.serialInitializedAt = Date.now();
                this.transitionTo(WorkerBridgeState.COMMITTING_GENERATION);
                Logger.info("VM", `[SERIAL INITIALIZED] Serial port validation succeeded for generation ${this.generationId}`);
              } else {
                throw new Error("serial is detached");
              }
            } catch (serialErr) {
              const serialErrMsg = serialErr instanceof Error ? serialErr.message : String(serialErr);
              Logger.error("VM", `[WorkerBridge ${this.generationId}] [SERIAL INITIALIZED FAILED] Serial initialization check failed: ${serialErrMsg}`);
              this.transitionTo(WorkerBridgeState.FAILED);
              reject(new WorkerBridgeError(`Serial initialization check failed: ${serialErrMsg}`));
              return;
            }

            // 4. Commit generation
            try {
              if (validator.isGenerationCommitted(this.generationId)) {
                this.generationCommitted = true;
                Logger.info("VM", `[GENERATION COMMITTED] Generation ${this.generationId} committed successfully`);
                
                // Flush deferred queue
                this.flushQueue();

                // 5. Commit state READY
                this.transitionTo(WorkerBridgeState.READY);
                this.fsmReadyCommittedAt = Date.now();
                Logger.info("VM", `[BRIDGE READY] All readiness barriers satisfied. State is now READY for generation ${this.generationId}`);
                
                resolve();
                if (this.readyResolver) {
                  const res = this.readyResolver;
                  this.readyResolver = null;
                  this.readyRejecter = null;
                  res();
                }
              } else {
                throw new Error(`Generation commit check failed for genId ${this.generationId}`);
              }
            } catch (genErr) {
              const genErrMsg = genErr instanceof Error ? genErr.message : String(genErr);
              Logger.error("VM", `[WorkerBridge ${this.generationId}] [GENERATION COMMITTED FAILED] Generation commit check failed: ${genErrMsg}`);
              this.transitionTo(WorkerBridgeState.FAILED);
              reject(new WorkerBridgeError(`Generation commit check failed: ${genErrMsg}`));
              return;
            }
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
          
          if (
            this.state === WorkerBridgeState.INITIALIZING ||
            this.state === WorkerBridgeState.ATTACHING_LISTENERS ||
            this.state === WorkerBridgeState.INITIALIZING_SERIAL ||
            this.state === WorkerBridgeState.COMMITTING_GENERATION
          ) {
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
        const createErrMsg = err instanceof Error ? err.message : String(err);
        Logger.error("VM", `[WorkerBridge ${this.generationId}] [WORKER CREATED FAILED] Worker creation/setup failed: ${createErrMsg}`);
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
    if (type === "INIT") {
      this.initDispatchedAt = Date.now();
      if (
        this.state !== WorkerBridgeState.READY ||
        !this.handshakeReceived ||
        !this.listenersAttached ||
        !this.serialInitialized ||
        !this.generationCommitted
      ) {
        const errorMsg = `Refusing to dispatch INIT: bridge state or readiness invariants violated (state: ${this.state}, ` +
          `handshake: ${this.handshakeReceived}, listeners: ${this.listenersAttached}, ` +
          `serial: ${this.serialInitialized}, generation: ${this.generationCommitted})`;
        Logger.error("VM", `[WorkerBridge ${this.generationId}] ${errorMsg}`);
        throw new WorkerBridgeError(errorMsg);
      }
    }
    if (this.state === WorkerBridgeState.READY && this.worker) {
      this.worker.postMessage({ type, payload, generation: this.generationId });
      return;
    }

    if (
      this.state === WorkerBridgeState.UNINITIALIZED ||
      this.state === WorkerBridgeState.INITIALIZING ||
      this.state === WorkerBridgeState.ATTACHING_LISTENERS ||
      this.state === WorkerBridgeState.INITIALIZING_SERIAL ||
      this.state === WorkerBridgeState.COMMITTING_GENERATION
    ) {
      this.queuedCount++;
      Logger.info("VM", `[WorkerBridge ${this.generationId}] Queueing message: ${type} (state: ${this.state})`);
      this.deferredQueue.push({ type, payload });
      return;
    }

    this.droppedCount++;
    Logger.warn("VM", `[WorkerBridge ${this.generationId}] Dropped message: ${type} (state is ${this.state})`);
  }

  public waitUntilFullyReady(): Promise<void> {
    if (this.state === WorkerBridgeState.READY) {
      // Validate all readiness invariants before resolving
      if (!this.handshakeReceived || !this.listenersAttached || !this.serialInitialized || !this.generationCommitted) {
        return Promise.reject(new WorkerBridgeError("Readiness invariants violated in READY state"));
      }
      return Promise.resolve();
    }
    return this.waitUntilReady();
  }

  public getReadinessDiagnostics() {
    return {
      generationId: this.generationId,
      state: this.state,
      handshakeReceived: this.handshakeReceived,
      listenersAttached: this.listenersAttached,
      serialInitialized: this.serialInitialized,
      generationCommitted: this.generationCommitted,
      telemetry: {
        handshakeReceivedAt: this.handshakeReceivedAt,
        listenersAttachedAt: this.listenersAttachedAt,
        serialInitializedAt: this.serialInitializedAt,
        fsmReadyCommittedAt: this.fsmReadyCommittedAt,
        initDispatchedAt: this.initDispatchedAt
      }
    };
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
