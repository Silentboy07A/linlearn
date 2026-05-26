// src/vm/serialQueue.ts

export class SerialWriteQueue {
  private queue: { port: number; data: string; resolve: () => void }[] = [];
  private isProcessing = false;
  private postMessage: (type: string, payload?: unknown) => void;

  constructor(postMessage: (type: string, payload?: unknown) => void) {
    this.postMessage = postMessage;
  }

  public enqueue(port: number, data: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ port, data, resolve });
      this.process();
    });
  }

  private process(): void {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const { port, data, resolve } = this.queue.shift()!;
    
    const chunkSize = 64;
    const delayMs = 15;
    let offset = 0;

    const sendNextChunk = () => {
      if (offset >= data.length) {
        this.isProcessing = false;
        resolve();
        // Trigger next write queue processing
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

  public clear(): void {
    this.queue.forEach(q => q.resolve());
    this.queue = [];
    this.isProcessing = false;
  }
}
