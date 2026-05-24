// src/security/abuseDetector.ts
import { Logger } from "../lib/logger";
import { AbuseDetectedError } from "../lib/errors";

interface AbuseScorecard {
  commandBlocks: number;
  injectionAttempts: number;
  isBanned: boolean;
  banReason?: string;
  expiresAt?: number;
}

const scoreStore = new Map<string, AbuseScorecard>();
const BAN_DURATION_MS = 24 * 60 * 60 * 1000;

export class AbuseDetector {
  public static checkIP(ip: string): void {
    const card = scoreStore.get(ip);
    if (card && card.isBanned) {
      if (card.expiresAt && Date.now() > card.expiresAt) {
        card.isBanned = false;
        card.commandBlocks = 0;
        card.injectionAttempts = 0;
        Logger.info("ABUSE", `Abuse ban expired and lifted for IP: ${ip}`);
      } else {
        Logger.abuseDetected(ip, `Rejected blocked request due to active ban: ${card.banReason}`);
        throw new AbuseDetectedError(`Access denied. Banned for security violations: ${card.banReason}`);
      }
    }
  }

  public static recordCommandBlock(ip: string, reason: string): void {
    let card = scoreStore.get(ip);
    if (!card) {
      card = { commandBlocks: 0, injectionAttempts: 0, isBanned: false };
      scoreStore.set(ip, card);
    }

    card.commandBlocks++;
    Logger.securityEvent(`Command blocked for IP ${ip}: ${reason}. Failures: ${card.commandBlocks}`);

    if (card.commandBlocks >= 3) {
      card.isBanned = true;
      card.banReason = "Repeated execution of dangerous or prohibited commands";
      card.expiresAt = Date.now() + BAN_DURATION_MS;
      Logger.abuseDetected(ip, "Banned IP due to repeated blocked commands", { card });
    }
  }

  public static recordPromptInjection(ip: string, reason: string): void {
    let card = scoreStore.get(ip);
    if (!card) {
      card = { commandBlocks: 0, injectionAttempts: 0, isBanned: false };
      scoreStore.set(ip, card);
    }

    card.injectionAttempts++;
    Logger.securityEvent(`Prompt injection attempt for IP ${ip}: ${reason}. Attempts: ${card.injectionAttempts}`);

    if (card.injectionAttempts >= 2) {
      card.isBanned = true;
      card.banReason = "Repeated adversarial prompt injection attempts";
      card.expiresAt = Date.now() + BAN_DURATION_MS;
      Logger.abuseDetected(ip, "Banned IP due to repeated prompt injections", { card });
    }
  }
}
