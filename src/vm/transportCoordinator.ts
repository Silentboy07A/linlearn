// src/vm/transportCoordinator.ts
import { Logger } from "../lib/logger";
import { WorkerBridge } from "./workerBridge";
import { SerialWriteQueue } from "./serialQueue";

export class TransportCoordinator {
  private bridge: WorkerBridge;
  private serialQueue: SerialWriteQueue;
  private pendingInit: Promise<void> | null = null;
  private hasSerial1 = false;

  constructor() {
    this.bridge = new WorkerBridge();
    this.serialQueue = new SerialWriteQueue((type, payload) => this.bridge.post(type, payload));
  }

  public getBridge(): WorkerBridge {
    return this.bridge;
  }

  public getSerialQueue(): SerialWriteQueue {
    return this.serialQueue;
  }

  public async initialize(
    workerUrl: string, 
    onMessage: (type: string, payload: unknown) => void
  ): Promise<void> {
    if (this.pendingInit) {
      Logger.info("VM", "[TransportCoordinator] Initialization already in progress, awaiting it.");
      return this.pendingInit;
    }

    this.pendingInit = (async () => {
      this.serialQueue.clear();
      
      // Initialize the worker bridge and wait for the HANDSHAKE.
      await this.bridge.initializeBridge(workerUrl, (type, payload) => {
        if (type === "INIT_SUCCESS") {
          const initPayload = payload as { hasSerial1?: boolean } | undefined;
          this.hasSerial1 = !!(initPayload && initPayload.hasSerial1);
        }
        onMessage(type, payload);
      });
    })();

    try {
      await this.pendingInit;
    } finally {
      this.pendingInit = null;
    }
  }

  public async post(type: string, payload?: unknown): Promise<void> {
    await this.bridge.waitUntilReady();
    this.bridge.post(type, payload);
  }

  public async send(port: number, data: string): Promise<void> {
    await this.bridge.waitUntilReady();
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
    this.bridge.terminate();
    this.hasSerial1 = false;
  }
}
