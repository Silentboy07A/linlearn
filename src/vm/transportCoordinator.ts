// src/vm/transportCoordinator.ts
import { Logger } from "../lib/logger";
import { WorkerBridge, WorkerBridgeState, WorkerBridgeError } from "./workerBridge";
import { SerialWriteQueue } from "./serialQueue";

export interface RecoveryContext {
  reason: string;
  expectedTeardown: boolean;
  bridgeGeneration: number;
}

export class LifecycleErrorClassifier {
  public static isFatal(error: unknown): boolean {
    if (error instanceof WorkerBridgeError) {
      return error.isFatal;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (
        msg.includes("terminating") ||
        msg.includes("terminated") ||
        msg.includes("teardown") ||
        msg.includes("intentional stop")
      ) {
        return false;
      }
    }
    return true;
  }
}

export interface BridgeTelemetry {
  generationCount: number;
  terminationReasons: { timestamp: number; reason: string }[];
  recreationTimesMs: { timestamp: number; duration: number }[];
  staleReferenceDetections: number;
  recoveryEscalationHistory: { timestamp: number; stage: string }[];
  suppressedTeardownExceptions: number;
  staleAsyncInvalidations: number;
  recoveryTransitions: { timestamp: number; transition: string }[];
  configAvailability: boolean;
  missingConfigDetections: number;
}

export interface BridgeGeneration {
  readonly id: number;
  readonly createdAt: number;
  readonly bridge: WorkerBridge;
  readonly ownershipToken: string;
  isValid: boolean;
}

export class BridgeGenerationManager {
  private currentGenerationId = 0;
  private activeGeneration: BridgeGeneration | null = null;
  private history: BridgeGeneration[] = [];
  
  private telemetry: BridgeTelemetry = {
    generationCount: 0,
    terminationReasons: [],
    recreationTimesMs: [],
    staleReferenceDetections: 0,
    recoveryEscalationHistory: [],
    suppressedTeardownExceptions: 0,
    staleAsyncInvalidations: 0,
    recoveryTransitions: [],
    configAvailability: false,
    missingConfigDetections: 0
  };

  public createNextGeneration(bridge: WorkerBridge, token: string): BridgeGeneration {
    if (this.activeGeneration) {
      Logger.info("VM", `[BridgeGenerationManager] Invalidating active bridge generation: ${this.activeGeneration.id}`);
      this.activeGeneration.isValid = false;
      this.activeGeneration.bridge.invalidate();
    }

    this.currentGenerationId++;
    const gen: BridgeGeneration = {
      id: this.currentGenerationId,
      createdAt: Date.now(),
      bridge,
      ownershipToken: token,
      isValid: true
    };

    this.activeGeneration = gen;
    this.history.push(gen);
    if (this.history.length > 10) {
      this.history.shift();
    }

    this.telemetry.generationCount = this.currentGenerationId;
    Logger.info("VM", `[BridgeGenerationManager] Created bridge generation ${gen.id} (token: ${token})`);
    return gen;
  }

  public getActiveGeneration(): BridgeGeneration | null {
    return this.activeGeneration;
  }

  public invalidateAll(reason: string = "unspecified"): void {
    Logger.info("VM", `[BridgeGenerationManager] Invalidating all bridge generations. Reason: ${reason}`);
    this.recordTerminationReason(reason);

    if (this.activeGeneration) {
      this.activeGeneration.isValid = false;
      this.activeGeneration.bridge.terminate(reason);
      this.activeGeneration = null;
    }
    this.history.forEach(g => {
      if (g.isValid) {
        g.isValid = false;
        g.bridge.terminate(reason);
      }
    });
  }

  public recordTerminationReason(reason: string): void {
    this.telemetry.terminationReasons.push({
      timestamp: Date.now(),
      reason
    });
    if (this.telemetry.terminationReasons.length > 20) {
      this.telemetry.terminationReasons.shift();
    }
  }

  public recordRecreationTime(duration: number): void {
    this.telemetry.recreationTimesMs.push({
      timestamp: Date.now(),
      duration
    });
    if (this.telemetry.recreationTimesMs.length > 20) {
      this.telemetry.recreationTimesMs.shift();
    }
  }

  public recordStaleReferenceDetection(): void {
    this.telemetry.staleReferenceDetections++;
  }

  public recordRecoveryEscalation(stage: string): void {
    this.telemetry.recoveryEscalationHistory.push({
      timestamp: Date.now(),
      stage
    });
    if (this.telemetry.recoveryEscalationHistory.length > 20) {
      this.telemetry.recoveryEscalationHistory.shift();
    }
  }

  public recordSuppressedTeardownException(): void {
    this.telemetry.suppressedTeardownExceptions++;
  }

  public recordStaleAsyncInvalidation(): void {
    this.telemetry.staleAsyncInvalidations++;
  }

  public recordRecoveryTransition(transition: string): void {
    this.telemetry.recoveryTransitions.push({
      timestamp: Date.now(),
      transition
    });
    if (this.telemetry.recoveryTransitions.length > 20) {
      this.telemetry.recoveryTransitions.shift();
    }
  }

  public recordConfigAvailability(available: boolean): void {
    this.telemetry.configAvailability = available;
  }

  public recordMissingConfigDetection(): void {
    this.telemetry.missingConfigDetections++;
  }

  public getTelemetry(): BridgeTelemetry {
    return { ...this.telemetry };
  }

  public getHistory(): BridgeGeneration[] {
    return this.history;
  }
}

export interface TransportConfiguration {
  workerUrl: string;
  onMessageCallback: (type: string, payload: unknown) => void;
  lastInitPayload: unknown;
}

export interface RuntimeTransportState {
  hasSerial1: boolean;
  currentRecoveryContext: RecoveryContext | null;
  pendingInit: Promise<void> | null;
  recreatePromise: Promise<void> | null;
}

export class WorkerBridgeFactory {
  public static createBridge(generationId: number): WorkerBridge {
    const token = Math.random().toString(36).substring(2);
    return new WorkerBridge(generationId, token);
  }
}

export class TransportCoordinator {
  private generationManager: BridgeGenerationManager;
  private serialQueue: SerialWriteQueue;
  
  // Decoupled lifecycles: Config outlives transient runtime states
  private config: TransportConfiguration | null = null;
  private state: RuntimeTransportState = {
    hasSerial1: false,
    currentRecoveryContext: null,
    pendingInit: null,
    recreatePromise: null
  };

  private isRecreationAllowed: () => boolean;
  private lastInitGenerationId = 0;

  constructor(isRecreationAllowed?: () => boolean) {
    this.isRecreationAllowed = isRecreationAllowed || (() => true);
    this.generationManager = new BridgeGenerationManager();
    
    // Start with an initial dummy generation 0
    const token = Math.random().toString(36).substring(2);
    const bridge = new WorkerBridge(0, token);
    this.generationManager.createNextGeneration(bridge, token);

    // Initialize the serial queue with a dynamic delegate call targeting the current active bridge
    this.serialQueue = new SerialWriteQueue((type, payload) => {
      const activeGen = this.generationManager.getActiveGeneration();
      if (activeGen && activeGen.isValid) {
        activeGen.bridge.post(type, payload);
      } else {
        Logger.warn("VM", "[TransportCoordinator] Serial write dropped: active generation is invalid or null");
      }
    });
  }

  public getBridge(): WorkerBridge {
    const activeGen = this.generationManager.getActiveGeneration();
    if (!activeGen) {
      throw new Error("No active bridge generation found.");
    }
    return activeGen.bridge;
  }

  public getGenerationManager(): BridgeGenerationManager {
    return this.generationManager;
  }

  public getSerialQueue(): SerialWriteQueue {
    return this.serialQueue;
  }

  public getRecoveryContext(): RecoveryContext | null {
    return this.state.currentRecoveryContext;
  }

  public isConfigValid(): boolean {
    return !!(this.config && this.config.workerUrl && this.config.onMessageCallback);
  }

  public async initialize(
    workerUrl: string, 
    onMessage: (type: string, payload: unknown) => void
  ): Promise<void> {
    // Capture immutable config settings
    this.config = {
      workerUrl,
      onMessageCallback: onMessage,
      lastInitPayload: this.config ? this.config.lastInitPayload : null
    };
    
    this.generationManager.recordConfigAvailability(true);
    
    if (this.state.pendingInit) {
      Logger.info("VM", "[TransportCoordinator] Initialization already in progress, awaiting it.");
      return this.state.pendingInit;
    }

    this.state.pendingInit = (async () => {
      this.serialQueue.clear();
      await this.recreateBridge();
    })();

    try {
      await this.state.pendingInit;
    } finally {
      this.state.pendingInit = null;
    }
  }

  public async recreateBridge(): Promise<void> {
    if (!this.isRecreationAllowed()) {
      Logger.warn("VM", "[TransportCoordinator] Suppressing bridge recreation/VM recreation during active boot lifecycle.");
      return;
    }

    if (this.state.recreatePromise) {
      Logger.info("VM", "[TransportCoordinator] Bridge recreation already in progress, awaiting existing promise.");
      return this.state.recreatePromise;
    }

    if (!this.isConfigValid()) {
      Logger.warn("VM", "[TransportCoordinator] Cannot recreate bridge: configuration is missing or invalid.");
      this.generationManager.recordMissingConfigDetection();
      this.generationManager.recordConfigAvailability(false);
      throw new Error("Cannot recreate bridge: configuration not set");
    }

    const config = this.config!;
    this.generationManager.recordConfigAvailability(true);
    
    const tStart = Date.now();
    this.state.recreatePromise = (async () => {
      const activeGen = this.generationManager.getActiveGeneration();
      const prevId = activeGen ? activeGen.id : 0;
      Logger.info("VM", `[TransportCoordinator] Initiating bridge recreation. Previous generation: ${prevId}`);
      
      this.state.currentRecoveryContext = {
        reason: "recovery recreation",
        expectedTeardown: true,
        bridgeGeneration: prevId + 1
      };
      this.generationManager.recordRecoveryTransition(`recreate generation ${prevId + 1}`);

      // 1. Terminate and invalidate old generations
      if (activeGen) {
        activeGen.bridge.terminate("bridge recreation");
      }
      this.generationManager.invalidateAll("bridge recreation");

      // Reset capabilities and clear writes
      this.serialQueue.clear();

      // 2. Create fresh bridge generation using the factory
      const nextGenId = prevId + 1;
      const newBridge = WorkerBridgeFactory.createBridge(nextGenId);
      
      const newGen = this.generationManager.createNextGeneration(newBridge, newBridge.getOwnershipToken());

      // 3. Initialize and wait for WORKER_READY handshake
      Logger.info("VM", `[TransportCoordinator] Initializing fresh bridge generation ${newGen.id}`);
      try {
        await newBridge.initializeBridge(config.workerUrl, (type, payload) => {
          const currentActive = this.generationManager.getActiveGeneration();
          if (!currentActive || currentActive.id !== newGen.id || !currentActive.isValid) {
            Logger.warn("VM", `[TransportCoordinator] Dropping callback message '${type}' from stale bridge generation ${newGen.id}`);
            this.generationManager.recordStaleAsyncInvalidation();
            return;
          }

          if (type === "INIT_SUCCESS") {
            const initPayload = payload as { hasSerial1?: boolean } | undefined;
            this.state.hasSerial1 = !!(initPayload && initPayload.hasSerial1);
          }

          if (config.onMessageCallback) {
            config.onMessageCallback(type, payload);
          }
        });
      } catch (err) {
        if (LifecycleErrorClassifier.isFatal(err)) {
          throw err;
        }
        Logger.info("VM", `[TransportCoordinator] Suppressed non-fatal teardown exception during bridge initialization: ${err}`);
        this.generationManager.recordSuppressedTeardownException();
        return;
      }

      // 4. Auto-initialize the worker if config exists
      if (config.lastInitPayload) {
        Logger.info("VM", `[TransportCoordinator] Auto-initializing new worker generation ${newGen.id} with saved config.`);
        newBridge.post("INIT", config.lastInitPayload);
        this.lastInitGenerationId = newGen.id;
      }

      const duration = Date.now() - tStart;
      this.generationManager.recordRecreationTime(duration);
      Logger.info("VM", `[TransportCoordinator] Bridge recreation successful. Generation ${newGen.id} ready in ${duration}ms.`);
    })();

    try {
      await this.state.recreatePromise;
    } finally {
      this.state.recreatePromise = null;
    }
  }

  public async post(type: string, payload?: unknown): Promise<void> {
    if (type === "INIT") {
      if (this.config) {
        this.config.lastInitPayload = payload;
      }
      const activeGen = this.generationManager.getActiveGeneration();
      if (activeGen && this.lastInitGenerationId === activeGen.id) {
        Logger.info("VM", `[TransportCoordinator] Suppressing duplicate INIT for bridge generation ${activeGen.id}`);
        return;
      }
      if (activeGen) {
        this.lastInitGenerationId = activeGen.id;
      }
    }

    try {
      const activeGen = this.generationManager.getActiveGeneration();
      const bridge = activeGen ? activeGen.bridge : null;
      
      if (
        !activeGen || 
        !activeGen.isValid || 
        !bridge || 
        bridge.getState() === WorkerBridgeState.TERMINATED || 
        bridge.getState() === WorkerBridgeState.FAILED
      ) {
        Logger.warn("VM", `[TransportCoordinator] Active bridge is invalid/terminated (state: ${bridge ? bridge.getState() : "null"}). Recreating before posting '${type}'`);
        this.generationManager.recordStaleReferenceDetection();
        await this.recreateBridge();
      }

      const currentBridge = this.getBridge();
      await currentBridge.waitUntilReady();
      currentBridge.post(type, payload);
    } catch (err) {
      if (LifecycleErrorClassifier.isFatal(err)) {
        throw err;
      }
      Logger.info("VM", `[TransportCoordinator] Suppressed non-fatal teardown exception during post('${type}'): ${err}`);
      this.generationManager.recordSuppressedTeardownException();
    }
  }

  public async send(port: number, data: string): Promise<void> {
    try {
      const activeGen = this.generationManager.getActiveGeneration();
      const bridge = activeGen ? activeGen.bridge : null;

      if (
        !activeGen || 
        !activeGen.isValid || 
        !bridge || 
        bridge.getState() === WorkerBridgeState.TERMINATED || 
        bridge.getState() === WorkerBridgeState.FAILED
      ) {
        Logger.warn("VM", `[TransportCoordinator] Active bridge is invalid/terminated (state: ${bridge ? bridge.getState() : "null"}). Recreating before sending on port ${port}`);
        this.generationManager.recordStaleReferenceDetection();
        await this.recreateBridge();
      }

      const currentBridge = this.getBridge();
      await currentBridge.waitUntilReady();
      return await this.serialQueue.enqueue(port, data);
    } catch (err) {
      if (LifecycleErrorClassifier.isFatal(err)) {
        throw err;
      }
      Logger.info("VM", `[TransportCoordinator] Suppressed non-fatal teardown exception during send on port ${port}: ${err}`);
      this.generationManager.recordSuppressedTeardownException();
    }
  }

  public hasSerial1Support(): boolean {
    return this.state.hasSerial1;
  }

  public setSerial1Support(support: boolean): void {
    this.state.hasSerial1 = support;
  }

  public reconnectSerial(): void {
    Logger.info("VM", "[TransportCoordinator] Reconnecting serial transport and rebinding listeners...");
    const activeGen = this.generationManager.getActiveGeneration();
    if (activeGen && activeGen.isValid) {
      const bridge = activeGen.bridge;
      const worker = (bridge as unknown as { worker: Worker | null }).worker;
      if (worker && this.config) {
        const config = this.config;
        worker.onmessage = (e: MessageEvent) => {
          if (!bridge.getIsValid() || bridge.getState() === WorkerBridgeState.TERMINATED || bridge.getState() === WorkerBridgeState.TERMINATING) {
            return;
          }
          if (!e.data) return;
          const { type, payload } = e.data;
          
          if (type === "WORKER_READY") {
            return;
          }
          
          if (type === "INIT_SUCCESS") {
            const initPayload = payload as { hasSerial1?: boolean } | undefined;
            this.state.hasSerial1 = !!(initPayload && initPayload.hasSerial1);
          }
          
          if (config.onMessageCallback) {
            config.onMessageCallback(type, payload);
          }
        };
        Logger.info("VM", `[TransportCoordinator] Rebound message handler for bridge generation ${activeGen.id}`);
      }
    }
  }

  public terminate(): void {
    // 1. Clear transient queues
    this.serialQueue.clear();

    // 2. Invalidate all active worker and bridge instances
    this.generationManager.invalidateAll("terminated transport");
    
    // 3. Reset runtime state, but PRESERVE immutable configuration store (this.config)
    this.state = {
      hasSerial1: false,
      currentRecoveryContext: null,
      pendingInit: null,
      recreatePromise: null
    };

    if (this.config) {
      this.config.lastInitPayload = null;
    }
    this.lastInitGenerationId = 0;

    Logger.info("VM", "[TransportCoordinator] Terminated runtime resources, but preserved immutable configuration.");
  }
}
