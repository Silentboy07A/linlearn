// src/vm/healthMonitor.ts
import { Logger } from "../lib/logger";

export class TerminalHealthMonitor {
  private lastHeartbeatTime: number = Date.now();
  private isHealthy: boolean = true;
  private checkInterval: NodeJS.Timeout | null = null;
  private pingTimeout: NodeJS.Timeout | null = null;
  private onUnhealthy: () => void;
  private postMessage: (type: string, payload?: unknown) => void;
  private getLastActivityTime: () => number;
  private startedAt: number = Date.now();

  constructor(
    postMessage: (type: string, payload?: unknown) => void,
    onUnhealthy: () => void,
    getLastActivityTime: () => number
  ) {
    this.postMessage = postMessage;
    this.onUnhealthy = onUnhealthy;
    this.getLastActivityTime = getLastActivityTime;
  }

  /**
   * Start periodic health checks (heartbeat)
   */
  public start(): void {
    this.stop();
    Logger.info("VM", "Starting periodic shell health monitoring (every 20s)...");
    this.lastHeartbeatTime = Date.now();
    this.startedAt = Date.now();
    this.isHealthy = true;

    this.checkInterval = setInterval(() => {
      this.checkHeartbeat();
    }, 20000); // Check every 20 seconds
  }

  /**
   * Stop health monitoring
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }

  /**
   * Send heartbeat check to worker
   */
  private checkHeartbeat(): void {
    // Skip heartbeat checks if we had recent keyboard input or serial output activity
    const lastActivity = this.getLastActivityTime();
    const timeSinceLastActivity = Date.now() - lastActivity;
    if (timeSinceLastActivity < 15000) {
      Logger.debug("VM", `[HEALTH] Skipping heartbeat check: recent VM activity detected (${Math.round(timeSinceLastActivity / 1000)}s ago).`);
      this.lastHeartbeatTime = Date.now();
      return;
    }

    Logger.debug("VM", "Sending worker heartbeat PING...");
    
    // 3-second timeout for the PONG reply
    this.pingTimeout = setTimeout(() => {
      this.pingTimeout = null;
      Logger.error("VM", "Worker heartbeat PING timed out! Worker or VM is unresponsive.");
      this.handleUnhealthy();
    }, 3000);

    this.postMessage("PING");
  }

  /**
   * Handle the PONG response from the worker
   */
  public handlePong(cpuRunning: boolean): void {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
    this.lastHeartbeatTime = Date.now();
    Logger.debug("VM", `Worker heartbeat PONG received. CPU running: ${cpuRunning}`);

    if (!cpuRunning) {
      Logger.warn("VM", "Worker is responsive but guest CPU is halted.");
      this.handleUnhealthy();
    } else {
      this.isHealthy = true;
    }
  }

  /**
   * Handle communication/serial error reports from interactive TTY
   */
  public reportSerialError(err: Error): void {
    Logger.error("VM", `Serial adapter communication error: ${err.message}`);
    this.handleUnhealthy();
  }

  /**
   * Mark session as unhealthy and fire recovery callback
   */
  private handleUnhealthy(): void {
    // 30-second cooldown/exemption period after boot or snapshot restore
    const timeSinceStart = Date.now() - this.startedAt;
    if (timeSinceStart < 30000) {
      Logger.info("VM", `[HEALTH] Ignoring unhealthy signal: within grace period (${Math.round(timeSinceStart / 1000)}s since start).`);
      return;
    }

    if (this.isHealthy) {
      this.isHealthy = false;
      Logger.warn("VM", "Terminal session detected as unhealthy. Triggering recovery callback...");
      this.onUnhealthy();
    }
  }
}
