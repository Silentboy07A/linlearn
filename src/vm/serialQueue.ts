// src/vm/serialQueue.ts
// ─── Serial Write Queue with Backpressure ────────────────────────────────────
// Manages ttyS0 write pacing for INTERACTIVE keyboard input only.
// Provisioning script transfer no longer uses this queue — it uses the
// PROVISION_* message protocol instead. This queue is now solely for:
//   - User keystrokes forwarded from the terminal
//   - Short programmatic commands (shell probe pings, PROVISIONING_ACK, etc.)

import { Logger } from "../lib/logger";

export class SerialWriteQueue {
  private queue: { port: number; data: string; resolve: () => void }[] = [];
  private isProcessing = false;
  private postMessage: (type: string, payload?: unknown) => void;

  // Backpressure: prevent unbounded queue growth.
  // Interactive input rarely exceeds a few items at once.
  private readonly maxQueueDepth: number;

  // Chunk size for serial writes (bytes per postMessage).
  // 64B is safe for interactive PTY line discipline.
  private readonly chunkSize: number;

  // Delay between serial chunks (ms).
  private readonly delayMs: number;

  constructor(
    postMessage: (type: string, payload?: unknown) => void,
    options: { maxQueueDepth?: number; chunkSize?: number; delayMs?: number } = {}
  ) {
    this.postMessage = postMessage;
    this.maxQueueDepth = options.maxQueueDepth ?? 16;
    this.chunkSize = options.chunkSize ?? 64;
    this.delayMs = options.delayMs ?? 15;
  }

  /**
   * Enqueue data for serial transmission.
   * Returns a Promise that resolves when all bytes have been sent.
   * If the queue is full (backpressure), the new write is dropped and the
   * returned Promise resolves immediately with a warning.
   */
  public enqueue(port: number, data: string): Promise<void> {
    if (this.queue.length >= this.maxQueueDepth) {
      Logger.warn("VM", `[SerialQueue] Backpressure: queue depth ${this.queue.length} >= ${this.maxQueueDepth}. Dropping write of ${data.length} bytes on port ${port}.`);
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push({ port, data, resolve });
      this.process();
    });
  }

  /**
   * Current number of pending write operations.
   */
  public getQueueDepth(): number {
    return this.queue.length + (this.isProcessing ? 1 : 0);
  }

  private process(): void {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const { port, data, resolve } = this.queue.shift()!;

    const chunkSize = this.chunkSize;
    const delayMs = this.delayMs;
    let offset = 0;

    const sendNextChunk = () => {
      if (offset >= data.length) {
        this.isProcessing = false;
        resolve();
        setTimeout(() => this.process(), 0);
        return;
      }

      const chunk = data.substring(offset, offset + chunkSize);
      offset += chunkSize;

      const type = port === 0 ? "INPUT" : "INPUT1";
      this.postMessage(type, chunk);

      setTimeout(sendNextChunk, delayMs);
    };

    sendNextChunk();
  }

  /**
   * Flush and discard all pending writes.
   * Used during recovery or VM teardown.
   */
  public clear(): void {
    this.queue.forEach((q) => q.resolve());
    this.queue = [];
    this.isProcessing = false;
  }
}
