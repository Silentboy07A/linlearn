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
  private serial1Buffer = "";

  constructor(
    postMessage: (type: string, payload?: unknown) => void,
    onUnhealthy: () => void,
    getLastActivityTime: () => number
  ) {
    this.postMessage = postMessage;
    this.onUnhealthy = onUnhealthy;
    this.getLastActivityTime = getLastActivityTime;
  }

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

  private checkHeartbeat(): void {
    const lastActivity = this.getLastActivityTime();
    const timeSinceLastActivity = Date.now() - lastActivity;
    
    // Skip health check if there has been very recent user/console activity
    if (timeSinceLastActivity < 15000) {
      Logger.debug("VM", `[HEALTH] Skipping heartbeat check: recent VM activity detected (${Math.round(timeSinceLastActivity / 1000)}s ago).`);
      this.lastHeartbeatTime = Date.now();
      return;
    }

    Logger.debug("VM", "Sending serial1 guest PING heartbeat...");
    this.serial1Buffer = "";

    // Set 4-second timeout for the serial1 PONG. If it fails, fall back to worker CPU ping.
    this.pingTimeout = setTimeout(() => {
      Logger.warn("VM", "[HEALTH] serial1 PONG timed out. Falling back to worker CPU status check...");
      
      // Fallback: ping worker to see if worker process and VM CPU are still responsive
      this.pingTimeout = setTimeout(() => {
        this.pingTimeout = null;
        Logger.error("VM", "[HEALTH] Worker CPU ping timed out! Guest VM is unresponsive.");
        this.handleUnhealthy();
      }, 3000);

      this.postMessage("PING");
    }, 4000);

    // Send PING to the invisible serial1 port
    this.postMessage("INPUT1", "PING\n");
  }

  public handleSerial1Byte(byte: number): void {
    this.serial1Buffer += String.fromCharCode(byte);
    if (this.serial1Buffer.includes("PONG")) {
      Logger.debug("VM", "[HEALTH] Guest shell response verified on serial1 (PONG).");
      this.serial1Buffer = "";
      if (this.pingTimeout) {
        clearTimeout(this.pingTimeout);
        this.pingTimeout = null;
      }
      this.lastHeartbeatTime = Date.now();
      this.isHealthy = true;
    }
  }

  public handlePong(cpuRunning: boolean): void {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
    this.lastHeartbeatTime = Date.now();
    Logger.debug("VM", `[HEALTH] Fallback CPU ping received. CPU running: ${cpuRunning}`);

    if (!cpuRunning) {
      Logger.warn("VM", "[HEALTH] Guest CPU is halted.");
      this.handleUnhealthy();
    } else {
      this.isHealthy = true;
    }
  }

  public reportSerialError(err: Error): void {
    Logger.error("VM", `[HEALTH] Serial adapter communication error: ${err.message}`);
    this.handleUnhealthy();
  }

  private handleUnhealthy(): void {
    const timeSinceStart = Date.now() - this.startedAt;
    if (timeSinceStart < 30000) {
      Logger.info("VM", `[HEALTH] Ignoring unhealthy signal: within grace period (${Math.round(timeSinceStart / 1000)}s since start).`);
      return;
    }

    if (this.isHealthy) {
      this.isHealthy = false;
      Logger.warn("VM", "[HEALTH] Terminal session detected as unhealthy. Triggering recovery callback...");
      this.onUnhealthy();
    }
  }
}
