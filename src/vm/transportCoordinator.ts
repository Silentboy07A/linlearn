// src/vm/transportCoordinator.ts
import { Logger } from "../lib/logger";
import { WorkerBridge, WorkerBridgeState } from "./workerBridge";
import { SerialWriteQueue } from "./serialQueue";

export interface BridgeTelemetry {
  generationCount: number;
  terminationReasons: { timestamp: number; reason: string }[];
  recreationTimesMs: { timestamp: number; duration: number }[];
  staleReferenceDetections: number;
  recoveryEscalationHistory: { timestamp: number; stage: string }[];
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
    recoveryEscalationHistory: []
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

  public getTelemetry(): BridgeTelemetry {
    return { ...this.telemetry };
  }

  public getHistory(): BridgeGeneration[] {
    return this.history;
  }
}

export class TransportCoordinator {
  private generationManager: BridgeGenerationManager;
  private serialQueue: SerialWriteQueue;
  private pendingInit: Promise<void> | null = null;
  private recreatePromise: Promise<void> | null = null;
  private hasSerial1 = false;

  private workerUrl: string | null = null;
  private onMessageCallback: ((type: string, payload: unknown) => void) | null = null;
  private lastInitPayload: unknown = null;

  constructor() {
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

  public async initialize(
    workerUrl: string, 
    onMessage: (type: string, payload: unknown) => void
  ): Promise<void> {
    this.workerUrl = workerUrl;
    this.onMessageCallback = onMessage;
    
    if (this.pendingInit) {
      Logger.info("VM", "[TransportCoordinator] Initialization already in progress, awaiting it.");
      return this.pendingInit;
    }

    this.pendingInit = (async () => {
      this.serialQueue.clear();
      await this.recreateBridge();
    })();

    try {
      await this.pendingInit;
    } finally {
      this.pendingInit = null;
    }
  }

  public async recreateBridge(): Promise<void> {
    if (this.recreatePromise) {
      Logger.info("VM", "[TransportCoordinator] Bridge recreation already in progress, awaiting existing promise.");
      return this.recreatePromise;
    }

    const workerUrl = this.workerUrl;
    if (!workerUrl) {
      throw new Error("Cannot recreate bridge: workerUrl not set.");
    }

    const tStart = Date.now();
    this.recreatePromise = (async () => {
      const activeGen = this.generationManager.getActiveGeneration();
      const prevId = activeGen ? activeGen.id : 0;
      Logger.info("VM", `[TransportCoordinator] Initiating bridge recreation. Previous generation: ${prevId}`);
      
      // 1. Terminate and invalidate old generations
      if (activeGen) {
        activeGen.bridge.terminate("bridge recreation");
      }
      this.generationManager.invalidateAll("bridge recreation");

      // Reset capabilities and clear writes
      this.serialQueue.clear();

      // 2. Create fresh bridge generation
      const nextGenId = prevId + 1;
      const token = Math.random().toString(36).substring(2);
      const newBridge = new WorkerBridge(nextGenId, token);
      
      const newGen = this.generationManager.createNextGeneration(newBridge, token);

      // 3. Initialize and wait for WORKER_READY handshake
      Logger.info("VM", `[TransportCoordinator] Initializing fresh bridge generation ${newGen.id}`);
      await newBridge.initializeBridge(workerUrl, (type, payload) => {
        const currentActive = this.generationManager.getActiveGeneration();
        if (!currentActive || currentActive.id !== newGen.id || !currentActive.isValid) {
          Logger.warn("VM", `[TransportCoordinator] Dropping callback message '${type}' from stale bridge generation ${newGen.id}`);
          this.generationManager.recordStaleReferenceDetection();
          return;
        }

        if (type === "INIT_SUCCESS") {
          const initPayload = payload as { hasSerial1?: boolean } | undefined;
          this.hasSerial1 = !!(initPayload && initPayload.hasSerial1);
        }

        if (this.onMessageCallback) {
          this.onMessageCallback(type, payload);
        }
      });

      // 4. Auto-initialize the worker if config exists
      if (this.lastInitPayload) {
        Logger.info("VM", `[TransportCoordinator] Auto-initializing new worker generation ${newGen.id} with saved config.`);
        newBridge.post("INIT", this.lastInitPayload);
      }

      const duration = Date.now() - tStart;
      this.generationManager.recordRecreationTime(duration);
      Logger.info("VM", `[TransportCoordinator] Bridge recreation successful. Generation ${newGen.id} ready in ${duration}ms.`);
    })();

    try {
      await this.recreatePromise;
    } finally {
      this.recreatePromise = null;
    }
  }

  public async post(type: string, payload?: unknown): Promise<void> {
    if (type === "INIT") {
      this.lastInitPayload = payload;
    }

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
  }

  public async send(port: number, data: string): Promise<void> {
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
    return this.serialQueue.enqueue(port, data);
  }

  public hasSerial1Support(): boolean {
    return this.hasSerial1;
  }

  public setSerial1Support(support: boolean): void {
    this.hasSerial1 = support;
  }

  public terminate(): void {
    this.serialQueue.clear();
    this.generationManager.invalidateAll("terminated transport");
    this.hasSerial1 = false;
    this.lastInitPayload = null;
    this.workerUrl = null;
    this.onMessageCallback = null;
  }
}
