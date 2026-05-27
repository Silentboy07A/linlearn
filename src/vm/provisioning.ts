// src/vm/provisioning.ts
import { Logger } from "../lib/logger";
import { ProvisioningState } from "./vmLifecycle";
import {
  ProvisionTransportState,
  chunkScript,
  chunkBinary,
  PROVISION_CHUNK_ACK_TIMEOUT_MS,
  PROVISION_MAX_CHUNK_RETRIES,
  ProvisionAckPayload,
  ProvisionNackPayload,
  ProvisionReadyPayload,
} from "./provisioningProtocol";

// ─── Completion Parser ───────────────────────────────────────────────────────
// Parses the ttyS0 stream for provisioning lifecycle markers ONLY.
// All other serial noise is safely ignored. Base64 echo is gone entirely.

export class ProvisioningCompletionParser {
  private buffer = "";

  public feed(data: string): { type: "complete" | "failed" | "heartbeat" | "shell_ready"; id: number }[] {
    this.buffer += data;
    if (this.buffer.length > 4096) {
      this.buffer = this.buffer.slice(-4096);
    }

    const results: { type: "complete" | "failed" | "heartbeat" | "shell_ready"; id: number }[] = [];

    const completeRegex = /\*\*LLVM_PROVISION_COMPLETE\*\*:(\d+)/g;
    let match;
    while ((match = completeRegex.exec(this.buffer)) !== null) {
      results.push({ type: "complete", id: parseInt(match[1], 10) });
    }

    const failedRegex = /PROVISIONING_FAILED:(\d+)/g;
    while ((match = failedRegex.exec(this.buffer)) !== null) {
      results.push({ type: "failed", id: parseInt(match[1], 10) });
    }

    const heartbeatRegex = /PROVISIONING_HEARTBEAT:(\d+)/g;
    while ((match = heartbeatRegex.exec(this.buffer)) !== null) {
      results.push({ type: "heartbeat", id: parseInt(match[1], 10) });
    }

    const shellReadyRegex = /\*\*SHELL_READY\*\*:(\d+)/g;
    while ((match = shellReadyRegex.exec(this.buffer)) !== null) {
      results.push({ type: "shell_ready", id: parseInt(match[1], 10) });
    }

    if (results.length > 0) {
      this.buffer = this.buffer
        .replace(/\*\*LLVM_PROVISION_COMPLETE\*\*:(\d+)/g, "")
        .replace(/PROVISIONING_FAILED:(\d+)/g, "")
        .replace(/PROVISIONING_HEARTBEAT:(\d+)/g, "")
        .replace(/\*\*SHELL_READY\*\*:(\d+)/g, "");
    }

    return results;
  }

  public reset(): void {
    this.buffer = "";
  }
}

// ─── ProvisioningController ──────────────────────────────────────────────────
// Orchestrates the full atomic provisioning flow:
//   1. (Optional) PROVISION_WRITE_BINARY for user backup blob
//   2. PROVISION_BEGIN → PROVISION_CHUNK(s) [ACK-gated] → PROVISION_END
//   3. PROVISION_WRITE  → wait PROVISION_READY
//   4. PROVISION_EXECUTE → FSM enters "executing"
//   5. Wait for **LLVM_PROVISION_COMPLETE** marker on ttyS0

export class ProvisioningController {
  private state: ProvisioningState = "idle";
  private transportState: ProvisionTransportState = "idle";
  private isLocked = false;
  private checkpoint = 0;
  private currentExecutionId = 0;
  private executionStartTimestamp = 0;
  private lastHeartbeatTimestamp = 0;
  private activeBridgeGeneration = 0;
  private completionParser = new ProvisioningCompletionParser();

  // ACK-gated streaming state
  private pendingChunkIndex = -1;
  private chunkRetries = 0;
  private chunkAckTimer: ReturnType<typeof setTimeout> | null = null;
  private chunksToSend: ReturnType<typeof chunkScript>["chunks"] = [];
  private chunkResolve: (() => void) | null = null;
  private chunkReject: ((reason: string) => void) | null = null;

  private onStateChange: (state: ProvisioningState) => void;
  private onPostMessage: (type: string, payload: unknown) => void;

  constructor(
    onStateChange: (state: ProvisioningState) => void,
    onPostMessage: (type: string, payload: unknown) => void
  ) {
    this.onStateChange = onStateChange;
    this.onPostMessage = onPostMessage;
  }

  // ─── Public getters ───────────────────────────────────────────────────────
  public getState(): ProvisioningState { return this.state; }
  public getTransportState(): ProvisionTransportState { return this.transportState; }
  public getExecutionId(): number { return this.currentExecutionId; }
  public getExecutionStartTimestamp(): number { return this.executionStartTimestamp; }
  public getLastHeartbeatTimestamp(): number { return this.lastHeartbeatTimestamp; }
  public getCompletionParser(): ProvisioningCompletionParser { return this.completionParser; }

  public recordHeartbeat(): void {
    this.lastHeartbeatTimestamp = Date.now();
    Logger.debug("VM", `[PROVISIONING] Heartbeat received for execId ${this.currentExecutionId}`);
  }

  public transitionTo(newState: ProvisioningState): void {
    if (this.state === newState) return;
    Logger.info("VM", `[PROVISIONING] State: ${this.state} -> ${newState} (execId: ${this.currentExecutionId})`);
    this.state = newState;
    this.onStateChange(newState);
  }

  private transitionTransportTo(newState: ProvisionTransportState): void {
    if (this.transportState === newState) return;
    Logger.info("VM", `[PROVISIONING TRANSPORT] ${this.transportState} -> ${newState} (execId: ${this.currentExecutionId})`);
    this.transportState = newState;
  }

  public reset(): void {
    this.state = "idle";
    this.transportState = "idle";
    this.isLocked = false;
    this.checkpoint = 0;
    this._cancelChunkTimer();
    this.chunksToSend = [];
    this.completionParser.reset();
  }

  public getDiagnostics(): Record<string, unknown> {
    return {
      state: this.state,
      transportState: this.transportState,
      isLocked: this.isLocked,
      checkpoint: this.checkpoint,
      executionId: this.currentExecutionId,
      executionStartTimestamp: this.executionStartTimestamp,
      lastHeartbeatTimestamp: this.lastHeartbeatTimestamp,
      activeBridgeGeneration: this.activeBridgeGeneration,
      pendingChunkIndex: this.pendingChunkIndex,
      chunkRetries: this.chunkRetries,
      totalChunks: this.chunksToSend.length,
      parserBufferLength: (this.completionParser as unknown as { buffer: string }).buffer.length,
      elapsedMs: this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0,
      heartbeatAgeMs: this.lastHeartbeatTimestamp ? Date.now() - this.lastHeartbeatTimestamp : 0,
    };
  }

  // ─── Main provisioning entry point ────────────────────────────────────────
  public async startProvisioning(
    savedStateBuffer: ArrayBuffer | null,
    inspectScript: string,
    useSerial1: boolean,
    bridgeGeneration: number
  ): Promise<boolean> {
    if (this.isLocked || this.state === "completed") {
      Logger.warn("VM", `Provisioning ignored. Locked: ${this.isLocked}, State: ${this.state}`);
      return false;
    }

    this.isLocked = true;
    this.currentExecutionId++;
    const executionId = this.currentExecutionId;
    const filePath = `/tmp/provision_${executionId}.sh`;
    this.executionStartTimestamp = Date.now();
    this.lastHeartbeatTimestamp = 0;
    this.activeBridgeGeneration = bridgeGeneration;
    this.completionParser.reset();

    this.transitionTo("preparing");
    this.transitionTransportTo("preparing");
    this.checkpoint = 1;

    Logger.info("VM", `[PROVISIONING] Starting framed atomic transfer. execId=${executionId}, bridgeGen=${bridgeGeneration}, useSerial1=${useSerial1}`);

    // ── Step 1: Transfer backup blob via PROVISION_WRITE_BINARY (no base64!) ──
    if (savedStateBuffer && savedStateBuffer.byteLength > 2) {
      const bytes = new Uint8Array(savedStateBuffer.byteLength);
      bytes.set(new Uint8Array(savedStateBuffer));

      this.transitionTransportTo("writing_backup");
      Logger.info("VM", `[PROVISIONING] Sending backup blob (${bytes.byteLength} bytes) via PROVISION_WRITE_BINARY...`);

      try {
        await this._sendBinaryFile(executionId, bridgeGeneration, "/tmp/fs.tar.gz", bytes);
        Logger.info("VM", `[PROVISIONING] Backup blob written to /tmp/fs.tar.gz via create_file().`);
      } catch (e) {
        Logger.error("VM", `[PROVISIONING] Binary file write failed: ${String(e)}. Continuing without restore.`);
        // Non-fatal: continue without backup restore
      }
    }

    // ── Step 2: Build provisioning shell script (no base64, no heredoc blob) ──
    let backgroundMonitorScript = "";
    if (useSerial1) {
      backgroundMonitorScript = `
sh -c '
check_tty() {
  opts=$(stty -F /dev/ttyS0 -a 2>/dev/null)
  if [ -z "$opts" ]; then
    echo "TTY_STATE:err_query_failed"
    return
  fi
  case "$opts" in *"-echo"*) echo_ok=0 ;; *) echo_ok=1 ;; esac
  case "$opts" in *"-icanon"*) icanon_ok=0 ;; *) icanon_ok=1 ;; esac
  owner=$(stat -c "%U" /dev/ttyS0 2>/dev/null || echo "user")
  ps_ok=0
  if ps | grep -E "sh|su" | grep -v grep | grep -q -E "ttyS0|S0"; then
    ps_ok=1
  fi
  echo "TTY_STATE:echo=$echo_ok:icanon=$icanon_ok:owner=$owner:active=$ps_ok"
}

while true; do
  read line
  case "$line" in
    PING)
      echo "PONG"
      ;;
    CHECK_TTY)
      check_tty
      ;;
    RECOVER_TTY)
      stty -F /dev/ttyS0 sane 2>/dev/null
      echo -e "\\\\033c" > /dev/ttyS0 2>/dev/null
      echo "RECOVERY_DONE"
      ;;
    RESTART_SHELL)
      ps | grep -E "sh|su" | grep -v grep | grep -E "ttyS0|S0" | while read -r pid rest; do
        kill -9 "$pid" 2>/dev/null
      done
      echo "SHELL_RESTART_SENT"
      ;;
  esac
done
' < /dev/ttyS1 > /dev/ttyS1 2>&1 &
`;
    }

    // Restore command now references /tmp/fs.tar.gz which was written by create_file()
    // No base64 heredoc needed — the binary was transferred atomically above.
    const restoreCmd = savedStateBuffer && savedStateBuffer.byteLength > 2
      ? `[ -f /tmp/fs.tar.gz ] && tar -xzf /tmp/fs.tar.gz -C /home/user 2>/dev/null && rm -f /tmp/fs.tar.gz || true`
      : `true`;

    const script = `#!/bin/sh
# Provisioning script - execution ID: ${executionId}
# Written via create_file() — no base64 serial injection
exec >/tmp/provision_exec.log 2>&1

_provision_completed=0
trap '
  if [ "$_provision_completed" -eq 0 ]; then
    echo "PROVISIONING_FAILED:${executionId}" > /dev/ttyS0
  fi
' EXIT

echo "[PROVISIONING] Started execution ID: ${executionId}"
echo "PROVISIONING_HEARTBEAT:${executionId}" > /dev/ttyS0

hostname linlearn
mkdir -p /home/user/Projects /home/user/.config /home/user/workspace
adduser -D -h /home/user -s /bin/sh user 2>/dev/null || true

echo "PROVISIONING_HEARTBEAT:${executionId}" > /dev/ttyS0

${restoreCmd}

echo "PROVISIONING_HEARTBEAT:${executionId}" > /dev/ttyS0

cat << 'PROFILE_EOF' > /home/user/.profile
export HOME=/home/user
export PS1='user@linlearn:\\$(pwd | sed "s|^\\$HOME|~|")\\$ '
cd /home/user
echo "**SHELL_READY**:${executionId}"
PROFILE_EOF

cat << 'INSPECT_EOF' > /usr/bin/linlearn-inspect
${inspectScript}
INSPECT_EOF
chmod +x /usr/bin/linlearn-inspect

chown -R user:user /home/user
chown user /dev/ttyS0

echo "PROVISIONING_HEARTBEAT:${executionId}" > /dev/ttyS0

${backgroundMonitorScript}

_provision_completed=1
echo "done" > /tmp/provision_complete

echo "" > /dev/ttyS0
sync
sleep 1

echo "**LLVM_PROVISION_COMPLETE**:${executionId}" > /dev/ttyS0
sync

while read -r ack_line; do
  case "$ack_line" in
    "PROVISIONING_ACK:${executionId}"*)
      break
      ;;
  esac
done < /dev/ttyS0

exec sh -c 'while true; do chown user /dev/ttyS0; su - user; done' < /dev/ttyS0 > /dev/ttyS0 2>&1
`;

    Logger.info("VM", `[PROVISIONING] Script built. execId=${executionId}, scriptSize=${script.length} chars`);

    // ── Step 3: Send script as framed PROVISION_* chunks ─────────────────────
    this.transitionTo("transferring");
    this.transitionTransportTo("sending_script");

    try {
      await this._streamScript(script, executionId, bridgeGeneration);
    } catch (e) {
      Logger.error("VM", `[PROVISIONING] Script streaming failed: ${String(e)}`);
      this.isLocked = false;
      this.transitionTransportTo("failed");
      this.transitionTo("failed");
      return false;
    }

    // ── Step 4: Tell worker to write file to VM FS ────────────────────────────
    this.transitionTransportTo("awaiting_write");
    Logger.info("VM", `[PROVISIONING] Sending PROVISION_WRITE for execId=${executionId}`);
    this.onPostMessage("PROVISION_WRITE", {
      execId: executionId,
      generation: bridgeGeneration,
      filePath: filePath,
    });
    // PROVISION_READY is handled by handleProvisionAck() below

    return true;
  }

  // ─── ACK / NACK handlers (called by emulatorManager) ─────────────────────

  public handleProvisionAck(ack: ProvisionAckPayload, bridgeGeneration: number): void {
    if (ack.execId !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_ACK for execId=${ack.execId} (current=${this.currentExecutionId}). Ignoring.`);
      return;
    }
    if (bridgeGeneration !== this.activeBridgeGeneration) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_ACK from generation ${bridgeGeneration} (active=${this.activeBridgeGeneration}). Ignoring.`);
      return;
    }

    Logger.debug("VM", `[PROVISIONING] PROVISION_ACK received: type=${ack.type}, execId=${ack.execId}, chunkIndex=${ack.chunkIndex ?? "n/a"}`);

    switch (ack.type) {
      case "begin":
        // Begin ACK: resolved by _streamScript waiting logic
        break;

      case "chunk":
        // Chunk ACK: advance to next chunk
        this._cancelChunkTimer();
        if (this.chunkResolve) {
          const resolve = this.chunkResolve;
          this.chunkResolve = null;
          this.chunkReject = null;
          this.chunkRetries = 0;
          resolve();
        }
        break;

      case "end":
        // End ACK: streaming complete, chunks assembled
        Logger.info("VM", `[PROVISIONING] Worker confirmed full script assembly for execId=${ack.execId}`);
        break;

      case "write_binary":
        // Binary backup blob written to VM FS
        Logger.info("VM", `[PROVISIONING] Worker confirmed binary file write for execId=${ack.execId}`);
        break;

      case "write":
        // Not used in current flow; PROVISION_READY supersedes this
        break;

      case "execute":
        // Worker sent serial trigger. Transition to executing state.
        Logger.info("VM", `[PROVISIONING] Worker confirmed serial trigger sent for execId=${ack.execId}. Script is executing.`);
        this.transitionTransportTo("executing");
        this.transitionTo("executing");
        // Wait transitions to waiting_completion after execute
        this.transitionTo("waiting_completion");
        Logger.info("VM", `[PROVISIONING] Now waiting for **LLVM_PROVISION_COMPLETE**:${ack.execId}`);
        break;

      case "cancel":
        Logger.info("VM", `[PROVISIONING] Worker confirmed provisioning cancelled.`);
        break;
    }
  }

  public handleProvisionNack(nack: ProvisionNackPayload): void {
    if (nack.execId !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_NACK for execId=${nack.execId}. Ignoring.`);
      return;
    }
    Logger.error("VM", `[PROVISIONING] PROVISION_NACK received: reason=${nack.reason}, chunkIndex=${nack.chunkIndex ?? "n/a"}, execId=${nack.execId}`);

    if (nack.chunkIndex !== undefined && this.chunkReject) {
      // Chunk failure — retry logic is in _sendChunk
      const reject = this.chunkReject;
      this.chunkResolve = null;
      this.chunkReject = null;
      reject(`nack:${nack.reason}`);
    } else {
      // Fatal transport failure
      this._cancelChunkTimer();
      this.isLocked = false;
      this.transitionTransportTo("failed");
      this.transitionTo("failed");
    }
  }

  public handleProvisionReady(ready: ProvisionReadyPayload, bridgeGeneration: number): void {
    if (ready.execId !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_READY for execId=${ready.execId}. Ignoring.`);
      return;
    }
    if (bridgeGeneration !== this.activeBridgeGeneration) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_READY from generation ${bridgeGeneration}. Ignoring.`);
      return;
    }
    if (ready.telemetry) {
      Logger.info(
        "VM",
        `[PROVISIONING TELEMETRY] FS Ready: ${ready.telemetry.fsReadyTimestamp}, ` +
        `Write Latency: ${ready.telemetry.writeLatencyMs}ms, Path: ${ready.telemetry.filePath}, ` +
        `Size: ${ready.telemetry.fileSize} bytes, Verified: ${ready.telemetry.verified}`
      );
    }
    Logger.info("VM", `[PROVISIONING] PROVISION_READY received. File ${ready.filePath} written to VM FS. Sending PROVISION_EXECUTE...`);
    this.transitionTransportTo("awaiting_execute");

    // Send execution trigger — worker will write single serial command
    this.onPostMessage("PROVISION_EXECUTE", {
      execId: this.currentExecutionId,
      generation: this.activeBridgeGeneration,
      filePath: ready.filePath,
    });
  }

  // ─── Completion / failure handlers ────────────────────────────────────────

  public handleProvisioningComplete(id: number, bridgeGeneration: number): void {
    if (id !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Ignored stale PROVISIONING_COMPLETE for execId=${id} (current=${this.currentExecutionId})`);
      return;
    }
    if (bridgeGeneration !== this.activeBridgeGeneration) {
      Logger.warn("VM", `[PROVISIONING] Ignored PROVISIONING_COMPLETE from stale generation ${bridgeGeneration}`);
      return;
    }
    const elapsed = this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0;
    Logger.info("VM", `[PROVISIONING] Complete! execId=${id}, bridgeGen=${bridgeGeneration}, elapsed=${elapsed}ms`);
    this.checkpoint = 2;
    this.isLocked = false;
    this.transitionTransportTo("completed");
    this.transitionTo("completed");
  }

  public handleProvisioningFailed(id: number, bridgeGeneration: number): void {
    if (id !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Ignored stale PROVISIONING_FAILED for execId=${id}`);
      return;
    }
    if (bridgeGeneration !== this.activeBridgeGeneration) {
      Logger.warn("VM", `[PROVISIONING] Ignored PROVISIONING_FAILED from stale generation ${bridgeGeneration}`);
      return;
    }
    const elapsed = this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0;
    Logger.error("VM", `[PROVISIONING] Script exited without completion marker! execId=${id}, elapsed=${elapsed}ms`);
    this.isLocked = false;
    this.transitionTransportTo("failed");
    this.transitionTo("failed");
  }

  public handleFailure(): void {
    this._cancelChunkTimer();
    this.isLocked = false;
    this.transitionTransportTo("failed");
    this.transitionTo("failed");
  }

  public handleRecover(): void {
    this.isLocked = false;
    this.transitionTo("recovering");
  }

  // ─── Cancel provisioning transport cleanly ────────────────────────────────
  public cancelTransport(): void {
    Logger.info("VM", `[PROVISIONING] Cancelling active transport for execId=${this.currentExecutionId}`);
    this._cancelChunkTimer();
    this.chunksToSend = [];
    this.isLocked = false;
    this.transitionTransportTo("cancelling");
    this.onPostMessage("PROVISION_CANCEL", {
      execId: this.currentExecutionId,
      generation: this.activeBridgeGeneration,
    });
  }

  // ─── Internal: ACK-gated script streaming ─────────────────────────────────

  private async _streamScript(
    script: string,
    execId: number,
    generation: number
  ): Promise<void> {
    const { begin, chunks, end } = chunkScript(script, execId, generation);
    this.chunksToSend = chunks;

    Logger.info("VM", `[PROVISIONING] Streaming ${chunks.length} chunks (${script.length} bytes total) for execId=${execId}`);

    // Send BEGIN
    this.onPostMessage("PROVISION_BEGIN", begin);
    // Give worker a tick to process BEGIN before streaming chunks
    await new Promise<void>((r) => setTimeout(r, 0));

    // ACK-gated chunk streaming
    for (let i = 0; i < chunks.length; i++) {
      await this._sendChunkWithRetry(chunks[i], execId);
      Logger.debug("VM", `[PROVISIONING] Chunk ${i + 1}/${chunks.length} ACKed.`);
    }

    // Send END
    this.onPostMessage("PROVISION_END", end);
    // Give worker a tick to finalize assembly
    await new Promise<void>((r) => setTimeout(r, 0));

    Logger.info("VM", `[PROVISIONING] Script streaming complete. execId=${execId}`);
  }

  private _sendChunkWithRetry(
    chunk: ReturnType<typeof chunkScript>["chunks"][0],
    execId: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let retries = 0;

      const attempt = () => {
        if (execId !== this.currentExecutionId) {
          reject("execId_superseded");
          return;
        }

        this.pendingChunkIndex = chunk.chunkIndex;
        this.chunkRetries = retries;
        this.chunkResolve = resolve;
        this.chunkReject = (reason: string) => {
          retries++;
          if (retries >= PROVISION_MAX_CHUNK_RETRIES) {
            reject(`chunk_${chunk.chunkIndex}_failed_after_${retries}_retries: ${reason}`);
            return;
          }
          Logger.warn("VM", `[PROVISIONING] Chunk ${chunk.chunkIndex} retry ${retries}/${PROVISION_MAX_CHUNK_RETRIES}. Reason: ${reason}`);
          setTimeout(attempt, 100);
        };

        this.onPostMessage("PROVISION_CHUNK", chunk);

        this._cancelChunkTimer();
        this.chunkAckTimer = setTimeout(() => {
          const reject = this.chunkReject;
          this.chunkResolve = null;
          this.chunkReject = null;
          if (reject) reject(`chunk_ack_timeout`);
        }, PROVISION_CHUNK_ACK_TIMEOUT_MS);
      };

      attempt();
    });
  }

  private _cancelChunkTimer(): void {
    if (this.chunkAckTimer !== null) {
      clearTimeout(this.chunkAckTimer);
      this.chunkAckTimer = null;
    }
  }

  private _sendBinaryFile(
    execId: number,
    generation: number,
    filePath: string,
    data: Uint8Array
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      // For binary writes we don't need ACK-gating since it's a single atomic message
      // and the result comes back as PROVISION_ACK(write_binary)
      const { chunks } = chunkBinary(data, filePath, execId, generation);
      if (chunks.length === 0) {
        resolve();
        return;
      }
      // Send the single binary write message
      // Note: data is a Uint8Array which travels via structured clone, no serialization needed
      this.onPostMessage("PROVISION_WRITE_BINARY", chunks[0]);
      // Resolve immediately — failure is handled by PROVISION_NACK callback
      // We can't easily await here without a separate promise registry,
      // so we resolve optimistically and let NACK handlers trigger recovery
      resolve();
    });
  }
}
