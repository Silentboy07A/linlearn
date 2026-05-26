// src/vm/timeoutManager.ts
import { Logger } from "../lib/logger";

export class UnifiedTimeoutManager {
  private timeouts = new Map<string, {
    timer: NodeJS.Timeout | null;
    delayMs: number;
    onTimeout: () => void;
    startedAt: number;
    remainingMs: number;
    isSuspended: boolean;
  }>();

  public register(name: string, delayMs: number, onTimeout: () => void): void {
    this.cancel(name);
    
    const timeoutFn = () => {
      this.timeouts.delete(name);
      Logger.info("VM", `Timeout fired: ${name}`);
      onTimeout();
    };

    const timer = setTimeout(timeoutFn, delayMs);
    this.timeouts.set(name, {
      timer,
      delayMs,
      onTimeout,
      startedAt: Date.now(),
      remainingMs: delayMs,
      isSuspended: false
    });
    Logger.debug("VM", `Registered timeout: ${name} for ${delayMs}ms`);
  }

  public cancel(name: string): void {
    const item = this.timeouts.get(name);
    if (item) {
      if (item.timer) {
        clearTimeout(item.timer);
      }
      this.timeouts.delete(name);
      Logger.debug("VM", `Cancelled timeout: ${name}`);
    }
  }

  public suspend(name: string): void {
    const item = this.timeouts.get(name);
    if (item && !item.isSuspended) {
      if (item.timer) {
        clearTimeout(item.timer);
        item.timer = null;
      }
      const elapsed = Date.now() - item.startedAt;
      item.remainingMs = Math.max(0, item.remainingMs - elapsed);
      item.isSuspended = true;
      Logger.debug("VM", `Suspended timeout: ${name}. Remaining: ${item.remainingMs}ms`);
    }
  }

  public resume(name: string): void {
    const item = this.timeouts.get(name);
    if (item && item.isSuspended) {
      item.startedAt = Date.now();
      item.isSuspended = false;
      const timeoutFn = () => {
        this.timeouts.delete(name);
        Logger.info("VM", `Timeout fired: ${name}`);
        item.onTimeout();
      };
      item.timer = setTimeout(timeoutFn, item.remainingMs);
      Logger.debug("VM", `Resumed timeout: ${name} for remaining ${item.remainingMs}ms`);
    }
  }

  public extend(name: string, extraMs: number): void {
    const item = this.timeouts.get(name);
    if (item) {
      if (item.isSuspended) {
        item.remainingMs += extraMs;
        Logger.debug("VM", `Extended suspended timeout: ${name} by ${extraMs}ms (new remaining: ${item.remainingMs}ms)`);
      } else {
        if (item.timer) {
          clearTimeout(item.timer);
        }
        const elapsed = Date.now() - item.startedAt;
        const newRemaining = Math.max(0, item.remainingMs - elapsed) + extraMs;
        item.remainingMs = newRemaining;
        item.startedAt = Date.now();
        const timeoutFn = () => {
          this.timeouts.delete(name);
          Logger.info("VM", `Timeout fired: ${name}`);
          item.onTimeout();
        };
        item.timer = setTimeout(timeoutFn, newRemaining);
        Logger.debug("VM", `Extended running timeout: ${name} by ${extraMs}ms (new remaining: ${newRemaining}ms)`);
      }
    }
  }

  public clearAll(): void {
    this.timeouts.forEach((item, name) => {
      if (item.timer) {
        clearTimeout(item.timer);
      }
      Logger.debug("VM", `Cleared timeout: ${name}`);
    });
    this.timeouts.clear();
  }
}
