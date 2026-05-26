// src/vm/healthMonitor.ts
import { Logger } from "../lib/logger";
import { TTYStateGuard } from "./ttyStateGuard";

export class TerminalHealthMonitor {
  private lastHeartbeatTime: number = Date.now();
  private isHealthy: boolean = true;
  private checkInterval: NodeJS.Timeout | null = null;
  private pingTimeout: NodeJS.Timeout | null = null;
  private onUnhealthy: (reason?: string) => void;
  private postMessage: (type: string, payload?: unknown) => void;
  private getLastActivityTime: () => number;
  private startedAt: number = Date.now();
  private serial1Buffer = "";
  private useSerial1 = true;

  constructor(
    postMessage: (type: string, payload?: unknown) => void,
    onUnhealthy: (reason?: string) => void,
    getLastActivityTime: () => number,
    useSerial1: boolean = true
  ) {
    this.postMessage = postMessage;
    this.onUnhealthy = onUnhealthy;
    this.getLastActivityTime = getLastActivityTime;
    this.useSerial1 = useSerial1;
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

    if (!this.useSerial1) {
      Logger.debug("VM", "[HEALTH] serial1 is unsupported. Sending CPU PING heartbeat directly...");
      this.pingTimeout = setTimeout(() => {
        this.pingTimeout = null;
        Logger.error("VM", "[HEALTH] Worker CPU ping timed out! Guest VM is unresponsive.");
        this.handleUnhealthy("worker CPU timeout");
      }, 4000);
      this.postMessage("PING");
      return;
    }

    Logger.debug("VM", "Sending serial1 guest CHECK_TTY heartbeat...");
    this.serial1Buffer = "";

    // Set 4-second timeout for the serial1 response. If it fails, fall back to worker CPU ping.
    this.pingTimeout = setTimeout(() => {
      Logger.warn("VM", "[HEALTH] serial1 heartbeat timed out. Falling back to worker CPU status check...");
      
      // Fallback: ping worker to see if worker process and VM CPU are still responsive
      this.pingTimeout = setTimeout(() => {
        this.pingTimeout = null;
        Logger.error("VM", "[HEALTH] Worker CPU ping timed out! Guest VM is unresponsive.");
        this.handleUnhealthy("worker CPU timeout");
      }, 3000);

      this.postMessage("PING");
    }, 4000);

    // Send CHECK_TTY to the invisible serial1 port
    this.postMessage("INPUT1", "CHECK_TTY\n");
  }

  public handleSerial1Byte(byte: number): void {
    this.serial1Buffer += String.fromCharCode(byte);
    if (this.serial1Buffer.length > 512) {
      this.serial1Buffer = this.serial1Buffer.substring(this.serial1Buffer.length - 512);
    }

    if (this.serial1Buffer.includes("\n")) {
      const lines = this.serial1Buffer.split("\n");
      this.serial1Buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("TTY_STATE:")) {
          Logger.debug("VM", `[HEALTH] Received TTY state from guest: ${trimmed}`);
          const state = TTYStateGuard.parse(trimmed);
          if (state) {
            const validation = TTYStateGuard.validate(state);
            if (validation.healthy) {
              Logger.debug("VM", "[HEALTH] Guest TTY state verified healthy.");
              if (this.pingTimeout) {
                clearTimeout(this.pingTimeout);
                this.pingTimeout = null;
              }
              this.lastHeartbeatTime = Date.now();
              this.isHealthy = true;
            } else {
              Logger.warn("VM", `[HEALTH] Guest TTY state unhealthy: ${validation.reason}`);
              if (this.pingTimeout) {
                clearTimeout(this.pingTimeout);
                this.pingTimeout = null;
              }
              this.handleUnhealthy(`tty corruption: ${validation.reason}`);
            }
          }
        } else if (trimmed === "PONG" || trimmed === "RECOVERY_DONE") {
          Logger.debug("VM", `[HEALTH] Guest shell response verified (${trimmed}).`);
          if (this.pingTimeout) {
            clearTimeout(this.pingTimeout);
            this.pingTimeout = null;
          }
          this.lastHeartbeatTime = Date.now();
          this.isHealthy = true;
        }
      }
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
      this.handleUnhealthy("guest CPU halted");
    } else {
      this.isHealthy = true;
    }
  }

  public reportSerialError(err: Error): void {
    Logger.error("VM", `[HEALTH] Serial adapter communication error: ${err.message}`);
    this.handleUnhealthy(`serial error: ${err.message}`);
  }

  private handleUnhealthy(reason?: string): void {
    const timeSinceStart = Date.now() - this.startedAt;
    if (timeSinceStart < 30000) {
      Logger.info("VM", `[HEALTH] Ignoring unhealthy signal: within grace period (${Math.round(timeSinceStart / 1000)}s since start). Reason: ${reason}`);
      return;
    }

    if (this.isHealthy) {
      this.isHealthy = false;
      Logger.warn("VM", `[HEALTH] Terminal session detected as unhealthy. Reason: ${reason || "none"}. Triggering recovery callback...`);
      this.onUnhealthy(reason);
    }
  }
}
