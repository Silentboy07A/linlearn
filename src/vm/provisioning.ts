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
  private state: "IDLE" | "VERIFY_BEGIN" | "FILE_VISIBLE" | "VERIFY_END" | "EXEC_START" | "SUCCESS" | "FAIL" = "IDLE";
  private currentExecId = -1;
  private processedPackets = new Set<string>();
  private lastProcessedSequence = 0;
  private isExecutionMode = false;
  private currentPhaseTimestamp = Date.now();

  public feed(data: string): { type: "complete" | "failed" | "heartbeat" | "shell_ready" | "exec_start"; id: number }[] {
    // Sanitize immediately to prevent replacement mismatches caused by ANSI codes or carriage returns
    this.buffer = this.sanitize(this.buffer + data);
    if (this.buffer.length > 8192) {
      this.buffer = this.buffer.slice(-8192);
    }

    const results: { type: "complete" | "failed" | "heartbeat" | "shell_ready" | "exec_start"; id: number }[] = [];

    // Regex to match <<<PROTO:execId:sequence:ACTION(:reason)>>>
    const protoRegex = /<<<PROTO:(\d+):(\d+):([A-Z_]+)(?::([^>]*))?>>>/g;
    let match;

    // Use a temporary array of matched items
    const matchesToReplace: { raw: string; action: string; execId: number; sequence: number; reason?: string }[] = [];

    while ((match = protoRegex.exec(this.buffer)) !== null) {
      const raw = match[0];
      const execId = parseInt(match[1], 10);
      const sequence = parseInt(match[2], 10);
      const action = match[3];
      const reason = match[4];

      matchesToReplace.push({ raw, action, execId, sequence, reason });
    }

    for (const item of matchesToReplace) {
      const { raw, action, execId, sequence, reason } = item;

      // 1. Monotonic Execution ID constraint
      if (execId < this.currentExecId) {
        Logger.warn("VM", `[Provisioning FSM] Ignored stale execution packet '${action}' for past execId=${execId} (current=${this.currentExecId})`);
        this.buffer = this.buffer.replace(raw, "");
        continue;
      }

      if (execId > this.currentExecId) {
        Logger.info("VM", `[Provisioning FSM] Monotonic execId progression: ${this.currentExecId} -> ${execId}. Resetting parser state.`);
        this.currentExecId = execId;
        this.lastProcessedSequence = 0;
        this.processedPackets.clear();
        this.state = "IDLE";
        this.isExecutionMode = false;
        this.currentPhaseTimestamp = Date.now();
      }

      // 2. Execution-Phase Parser Mode Isolation
      const isVerificationAction = action === "BEGIN" || action === "FILE_VISIBLE" || action === "VERIFY_END";
      if (this.isExecutionMode && isVerificationAction) {
        Logger.warn("VM", `[Provisioning FSM] Ignored stale verification marker '${action}' (seq=${sequence}) during execution phase for execId=${execId}`);
        this.buffer = this.buffer.replace(raw, "");
        continue;
      }

      // 3. Packet Deduplication
      const packetKey = `${execId}:${sequence}:${action}`;
      if (action !== "HEARTBEAT" && this.processedPackets.has(packetKey)) {
        Logger.debug("VM", `[Provisioning FSM] Ignored duplicate packet '${action}' (seq=${sequence}) for execId=${execId}`);
        this.buffer = this.buffer.replace(raw, "");
        continue;
      }

      // 4. Packet Sequence Ordering Validation
      if (action !== "HEARTBEAT" && sequence <= this.lastProcessedSequence) {
        Logger.warn("VM", `[Provisioning FSM] Ignored out-of-order/stale packet '${action}' with sequence ${sequence} (last processed: ${this.lastProcessedSequence})`);
        this.buffer = this.buffer.replace(raw, "");
        continue;
      }
      if (action === "HEARTBEAT" && sequence < this.lastProcessedSequence) {
        Logger.warn("VM", `[Provisioning FSM] Ignored stale heartbeat with sequence ${sequence} (last processed: ${this.lastProcessedSequence})`);
        this.buffer = this.buffer.replace(raw, "");
        continue;
      }

      // 5. Stale Frame TTL Check (15 seconds verification phase timeout protection)
      if (isVerificationAction && (Date.now() - this.currentPhaseTimestamp > 15000)) {
        Logger.warn("VM", `[Provisioning FSM] Discarded stale verification marker '${action}' exceeding TTL`);
        this.buffer = this.buffer.replace(raw, "");
        continue;
      }

      // Validate transitions
      let transitionAllowed = false;
      const oldState = this.state;
      let rejectionReason = "";

      if (action === "BEGIN") {
        if (this.state === "IDLE") {
          this.state = "VERIFY_BEGIN";
          transitionAllowed = true;
        } else {
          rejectionReason = `FSM state not IDLE (current state: ${this.state})`;
        }
      } else if (action === "FILE_VISIBLE") {
        if (this.state === "VERIFY_BEGIN") {
          this.state = "FILE_VISIBLE";
          transitionAllowed = true;
        } else {
          rejectionReason = `FSM state not VERIFY_BEGIN (current state: ${this.state})`;
        }
      } else if (action === "VERIFY_END") {
        if (this.state === "VERIFY_BEGIN" || this.state === "FILE_VISIBLE") {
          this.state = "VERIFY_END";
          transitionAllowed = true;
        } else {
          rejectionReason = `FSM state not VERIFY_BEGIN or FILE_VISIBLE (current state: ${this.state})`;
        }
      } else if (action === "EXEC_START") {
        if (this.state === "IDLE" || this.state === "VERIFY_BEGIN" || this.state === "FILE_VISIBLE" || this.state === "VERIFY_END") {
          this.state = "EXEC_START";
          results.push({ type: "exec_start", id: execId });
          transitionAllowed = true;
        } else {
          rejectionReason = `FSM state not IDLE/VERIFY_BEGIN/FILE_VISIBLE/VERIFY_END (current state: ${this.state})`;
        }
      } else if (action === "HEARTBEAT") {
        if (this.state === "EXEC_START") {
          results.push({ type: "heartbeat", id: execId });
          transitionAllowed = true;
        } else {
          rejectionReason = `FSM state not EXEC_START (current state: ${this.state})`;
        }
      } else if (action === "EXEC_COMPLETE") {
        if (this.state === "EXEC_START" || this.state === "VERIFY_END" || this.state === "FILE_VISIBLE" || this.state === "VERIFY_BEGIN") {
          this.state = "SUCCESS";
          results.push({ type: "complete", id: execId });
          transitionAllowed = true;
        } else {
          rejectionReason = `FSM state not EXEC_START/VERIFY_END/FILE_VISIBLE/VERIFY_BEGIN (current state: ${this.state})`;
        }
      } else if (action === "FAIL") {
        if (this.state !== "SUCCESS" && this.state !== "FAIL") {
          this.state = "FAIL";
          results.push({ type: "failed", id: execId });
          transitionAllowed = true;
          Logger.error("VM", `[Provisioning FSM] Transitioned to FAIL for execId=${execId}. Reason: ${reason}`);
        } else {
          rejectionReason = `FSM state already SUCCESS or FAIL (current state: ${this.state})`;
        }
      } else if (action === "SHELL_READY") {
        if (this.state === "SUCCESS") {
          results.push({ type: "shell_ready", id: execId });
          transitionAllowed = true;
        } else {
          rejectionReason = `FSM state not SUCCESS (current state: ${this.state})`;
        }
      } else {
        rejectionReason = `Unknown action type: ${action}`;
      }

      if (transitionAllowed) {
        if (action !== "HEARTBEAT") {
          this.processedPackets.add(packetKey);
          this.lastProcessedSequence = sequence;
        }
        this.currentPhaseTimestamp = Date.now();
        if (action === "EXEC_START" || this.state === "SUCCESS" || this.state === "FAIL") {
          this.isExecutionMode = true;
        }
        if (oldState !== this.state) {
          Logger.info("VM", `[Provisioning FSM] State transition SUCCESS: ${oldState} -> ${this.state} for execId=${execId} (seq: ${sequence}, incoming frame: ${action})`);
        }
      } else {
        Logger.warn("VM", `[Provisioning FSM] Transition REJECTED: ${this.state} -> ${action} for execId=${execId} (seq: ${sequence}, currentExecId=${this.currentExecId}). Reason: ${rejectionReason}`);
      }

      // Remove the raw matched token from the original buffer
      this.buffer = this.buffer.replace(raw, "");
    }

    return results;
  }

  private sanitize(str: string): string {
    const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    return str.replace(ansiRegex, "").replace(/\r/g, "");
  }

  public enterExecutionMode(): void {
    Logger.info("VM", `[Provisioning FSM] Explicitly entering EXECUTION_MODE. Ignoring all future verification markers.`);
    this.isExecutionMode = true;
  }

  public flush(): void {
    Logger.info("VM", `[Provisioning FSM] Flushing parser buffer. Current state: ${this.state}, execId: ${this.currentExecId}`);
    this.buffer = "";
  }

  public reset(): void {
    this.buffer = "";
    this.state = "IDLE";
    this.currentExecId = -1;
    this.processedPackets.clear();
    this.lastProcessedSequence = 0;
    this.isExecutionMode = false;
    this.currentPhaseTimestamp = Date.now();
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

  // Fine-grained timeouts
  private writeTimer: NodeJS.Timeout | null = null;
  private execStartTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private execCompleteTimer: NodeJS.Timeout | null = null;

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

  // ─── Timeout Management ────────────────────────────────────────────────────
  private _startWriteTimer(execId: number): void {
    this._cancelWriteTimer();
    this.writeTimer = setTimeout(() => {
      Logger.error("VM", `[PROVISIONING TIMEOUT] Worker failed to report PROVISION_READY (write/verify guest visibility) within 15 seconds for execId=${execId}`);
      this.handleProvisioningFailed(execId, this.activeBridgeGeneration);
    }, 15000);
  }

  private _cancelWriteTimer(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  private _startExecStartTimer(execId: number): void {
    this._cancelExecStartTimer();
    this.execStartTimer = setTimeout(() => {
      Logger.error("VM", `[PROVISIONING TIMEOUT] Script failed to output <<<PROTO:EXEC_START:${execId}>>> within 15 seconds for execId=${execId}`);
      this.handleProvisioningFailed(execId, this.activeBridgeGeneration);
    }, 15000);
  }

  private _cancelExecStartTimer(): void {
    if (this.execStartTimer) {
      clearTimeout(this.execStartTimer);
      this.execStartTimer = null;
    }
  }

  private _startHeartbeatTimer(execId: number): void {
    this._cancelHeartbeatTimer();
    // Check every 5 seconds, fail if no heartbeat for 20 seconds
    this.heartbeatTimer = setInterval(() => {
      const age = this.lastHeartbeatTimestamp ? Date.now() - this.lastHeartbeatTimestamp : Date.now() - (this.executionStartTimestamp ?? Date.now());
      if (age > 20000) {
        Logger.error("VM", `[PROVISIONING TIMEOUT] Heartbeat stalled for execId=${execId} (age=${age}ms)`);
        this._cancelHeartbeatTimer();
        this.handleProvisioningFailed(execId, this.activeBridgeGeneration);
      }
    }, 5000);
  }

  private _cancelHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _startExecCompleteTimer(execId: number): void {
    this._cancelExecCompleteTimer();
    // Absolute max execution time: 90 seconds
    this.execCompleteTimer = setTimeout(() => {
      Logger.error("VM", `[PROVISIONING TIMEOUT] Script execution timed out (exceeded 90s) for execId=${execId}`);
      this.handleProvisioningFailed(execId, this.activeBridgeGeneration);
    }, 90000);
  }

  private _cancelExecCompleteTimer(): void {
    if (this.execCompleteTimer) {
      clearTimeout(this.execCompleteTimer);
      this.execCompleteTimer = null;
    }
  }

  private _cancelAllTimers(): void {
    this._cancelChunkTimer();
    this._cancelWriteTimer();
    this._cancelExecStartTimer();
    this._cancelHeartbeatTimer();
    this._cancelExecCompleteTimer();
  }

  public recordHeartbeat(): void {
    this.lastHeartbeatTimestamp = Date.now();
    Logger.info("VM", `[PROVISIONING] Heartbeat received for execId ${this.currentExecutionId}`);
  }

  public handleExecStart(execId: number): void {
    if (execId !== this.currentExecutionId) return;
    Logger.info("VM", `[PROVISIONING] Script execution started for execId=${execId}`);
    this._cancelExecStartTimer();
    this._startHeartbeatTimer(execId);
    this._startExecCompleteTimer(execId);
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
    this._cancelAllTimers();
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
  _exit_code=$?
  if [ "$_provision_completed" -eq 0 ]; then
    echo "<<<PROTO:${executionId}:7:FAIL:exit_code_\$_exit_code>>>" > /dev/ttyS0
  fi
' EXIT

echo "<<<PROTO:${executionId}:4:EXEC_START>>>" > /dev/ttyS0
echo "[PROVISIONING] Started execution ID: ${executionId}"
echo "<<<PROTO:${executionId}:5:HEARTBEAT>>>" > /dev/ttyS0

hostname linlearn
mkdir -p /home/user/Projects /home/user/.config /home/user/workspace
adduser -D -h /home/user -s /bin/sh user 2>/dev/null || true

echo "<<<PROTO:${executionId}:5:HEARTBEAT>>>" > /dev/ttyS0

${restoreCmd}

echo "<<<PROTO:${executionId}:5:HEARTBEAT>>>" > /dev/ttyS0

cat << 'PROFILE_EOF' > /home/user/.profile
export HOME=/home/user
export PS1='user@linlearn:\\$(pwd | sed "s|^\\$HOME|~|")\\$ '
cd /home/user
echo "<<<PROTO:${executionId}:8:SHELL_READY>>>"
PROFILE_EOF

cat << 'INSPECT_EOF' > /usr/bin/linlearn-inspect
${inspectScript}
INSPECT_EOF
chmod +x /usr/bin/linlearn-inspect

chown -R user:user /home/user
chown user /dev/ttyS0

echo "<<<PROTO:${executionId}:5:HEARTBEAT>>>" > /dev/ttyS0

${backgroundMonitorScript}

_provision_completed=1
echo "done" > /tmp/provision_complete

echo "" > /dev/ttyS0
sync
sleep 1

echo "<<<PROTO:${executionId}:6:EXEC_COMPLETE>>>" > /dev/ttyS0
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
    this._startWriteTimer(executionId);
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
    this._cancelWriteTimer();
    if (ready.telemetry) {
      Logger.info(
        "VM",
        `[PROVISIONING TELEMETRY] FS Ready: ${ready.telemetry.fsReadyTimestamp}, ` +
        `Write Latency: ${ready.telemetry.writeLatencyMs}ms, Path: ${ready.telemetry.filePath}, ` +
        `Size: ${ready.telemetry.fileSize} bytes, Verified: ${ready.telemetry.verified}, ` +
        `GuestVisible: ${ready.telemetry.guestVisible ?? "n/a"}, FallbackRequired: ${ready.telemetry.fallbackRequired ?? "n/a"}` +
        (ready.telemetry.mountSuccess !== undefined ? `, MountSuccess: ${ready.telemetry.mountSuccess}, PropLatency: ${ready.telemetry.propagationLatencyMs}ms, Retries: ${ready.telemetry.retryCount}, VisTiming: ${ready.telemetry.guestVisibilityTimingMs}ms, Remounts: ${ready.telemetry.remountAttempts}` : "")
      );
    }

    // Execution barrier: Do NOT execute provisioning until GuestVisible=true is confirmed
    if (!ready.telemetry || !ready.telemetry.guestVisible) {
      Logger.error(
        "VM",
        `[PROVISIONING BARRIER] Execution blocked. Guest visibility check failed (GuestVisible=false).`
      );
      this.handleProvisioningFailed(ready.execId, this.activeBridgeGeneration);
      return;
    }

    Logger.info(
      "VM",
      `[PROVISIONING] PROVISION_READY received and guest visibility confirmed. File ${ready.filePath} written to VM FS. ` +
      `Sending PROVISION_EXECUTE...`
    );
    this.transitionTransportTo("awaiting_execute");

    // Flush serial parser buffer and enter execution mode (Requirement 5, 10, 14)
    this.completionParser.flush();
    this.completionParser.enterExecutionMode();

    // Start timer waiting for execution to start
    this._startExecStartTimer(ready.execId);

    // Send execution trigger — worker will write single serial command
    this.onPostMessage("PROVISION_EXECUTE", {
      execId: this.currentExecutionId,
      generation: this.activeBridgeGeneration,
      filePath: ready.filePath,
      fallbackRequired: false
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
    this._cancelAllTimers();
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
    this._cancelAllTimers();
    const elapsed = this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0;
    Logger.error("VM", `[PROVISIONING] Script exited without completion marker! execId=${id}, elapsed=${elapsed}ms`);
    this.isLocked = false;
    this.transitionTransportTo("failed");
    this.transitionTo("failed");
  }

  public handleFailure(): void {
    this._cancelAllTimers();
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
    this._cancelAllTimers();
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
