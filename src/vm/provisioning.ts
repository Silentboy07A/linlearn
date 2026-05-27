// src/vm/provisioning.ts
import { Logger } from "../lib/logger";
import { ProvisioningState } from "./vmLifecycle";

export class ProvisioningController {
  private state: ProvisioningState = "idle";
  private isLocked = false;
  private checkpoint = 0;
  private currentExecutionId = 0;
  private executionStartTimestamp = 0;
  private lastHeartbeatTimestamp = 0;
  private onStateChange: (state: ProvisioningState) => void;
  private onSendInput: (port: number, data: string) => Promise<void>;

  constructor(
    onStateChange: (state: ProvisioningState) => void,
    onSendInput: (port: number, data: string) => Promise<void>
  ) {
    this.onStateChange = onStateChange;
    this.onSendInput = onSendInput;
  }

  public getState(): ProvisioningState {
    return this.state;
  }

  public getExecutionId(): number {
    return this.currentExecutionId;
  }

  public getExecutionStartTimestamp(): number {
    return this.executionStartTimestamp;
  }

  public getLastHeartbeatTimestamp(): number {
    return this.lastHeartbeatTimestamp;
  }

  public recordHeartbeat(): void {
    this.lastHeartbeatTimestamp = Date.now();
    Logger.debug("VM", `[PROVISIONING] Heartbeat received for execution ID ${this.currentExecutionId}`);
  }

  public transitionTo(newState: ProvisioningState): void {
    if (this.state === newState) return;
    Logger.info("VM", `[PROVISIONING] State: ${this.state} -> ${newState} (execId: ${this.currentExecutionId})`);
    this.state = newState;
    this.onStateChange(newState);
  }

  public reset(): void {
    this.state = "idle";
    this.isLocked = false;
    this.checkpoint = 0;
  }

  public getDiagnostics(): Record<string, unknown> {
    return {
      state: this.state,
      isLocked: this.isLocked,
      checkpoint: this.checkpoint,
      executionId: this.currentExecutionId,
      executionStartTimestamp: this.executionStartTimestamp,
      lastHeartbeatTimestamp: this.lastHeartbeatTimestamp,
      elapsedMs: this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0,
      heartbeatAgeMs: this.lastHeartbeatTimestamp ? Date.now() - this.lastHeartbeatTimestamp : 0,
    };
  }

  public async startProvisioning(restoreCmd: string, inspectScript: string, useSerial1: boolean): Promise<boolean> {
    if (this.isLocked || this.state === "completed") {
      Logger.warn("VM", `Provisioning ignored. Locked: ${this.isLocked}, State: ${this.state}`);
      return false;
    }

    this.isLocked = true;
    this.currentExecutionId++;
    const executionId = this.currentExecutionId;
    this.executionStartTimestamp = Date.now();
    this.lastHeartbeatTimestamp = 0;

    this.transitionTo("preparing");
    this.checkpoint = 1;

    Logger.info("VM", `[PROVISIONING] Preparing execution ID ${executionId}. useSerial1=${useSerial1}, restoreCmdLen=${restoreCmd.length}, inspectScriptLen=${inspectScript.length}`);

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
  owner=$(stat -c "%U" /dev/ttyS0 2>/dev/null || stat -f "%u" /dev/ttyS0 2>/dev/null || ls -l /dev/ttyS0 | while read -r perm links usr rest; do echo "$usr"; break; done || echo "user")
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

    // The shell script uses an exit trap to guarantee a completion or failure
    // signal is emitted to /dev/ttyS0 even if the script exits unexpectedly.
    // Heartbeat markers are emitted at key checkpoints so the host-side watchdog
    // can distinguish "still running" from "truly stalled".
    const script = `#!/bin/sh
# Provisioning script - execution ID: ${executionId}
# Redirect all stdout/stderr to log file to keep serial clean
exec >/tmp/provision_exec.log 2>&1

# Exit trap: if script exits without completing, emit failure marker
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
export PS1='user@linlearn:\\$(pwd | sed "s|^\\$HOME|~|")\\\\$ '
cd /home/user
PROFILE_EOF

cat << 'INSPECT_EOF' > /usr/bin/linlearn-inspect
${inspectScript}
INSPECT_EOF
chmod +x /usr/bin/linlearn-inspect

chown -R user:user /home/user
chown user /dev/ttyS0

echo "PROVISIONING_HEARTBEAT:${executionId}" > /dev/ttyS0

${backgroundMonitorScript}

# Mark provisioning as completed BEFORE the exec
_provision_completed=1
echo "PROVISIONING_COMPLETE:${executionId}" > /dev/ttyS0

# Replace this shell with the user login loop
exec sh -c 'while true; do chown user /dev/ttyS0; su - user; done' < /dev/ttyS0 > /dev/ttyS0 2>&1
`;

    this.transitionTo("transferring");

    // Convert string to base64 properly
    let base64Script = "";
    if (typeof window !== "undefined" && window.btoa) {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(script);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      base64Script = window.btoa(binary);
    } else {
      base64Script = Buffer.from(script, "utf-8").toString("base64");
    }

    Logger.info("VM", `[PROVISIONING] Atomic script encoded. execId=${executionId}, base64Size=${base64Script.length} chars, rawScriptSize=${script.length} chars`);

    const atomicCmd = `stty -echo; echo '${base64Script}' | base64 -d > /tmp/p.sh && chmod +x /tmp/p.sh && exec sh /tmp/p.sh\n`;

    // Transition to executing BEFORE the send so the state is correct
    // when serial output starts arriving
    this.transitionTo("executing");
    await this.onSendInput(0, atomicCmd);

    // The script is now being processed by the VM. Transition to waiting.
    this.transitionTo("waiting_completion");
    Logger.info("VM", `[PROVISIONING] Atomic command sent. Now waiting for PROVISIONING_COMPLETE:${executionId}`);

    return true;
  }

  public handleProvisioningComplete(id: number): void {
    if (id !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Ignored stale PROVISIONING_COMPLETE marker for execution ID ${id} (current is ${this.currentExecutionId})`);
      return;
    }
    const elapsed = this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0;
    Logger.info("VM", `[PROVISIONING] Complete! execId=${id}, elapsed=${elapsed}ms`);
    this.checkpoint = 2;
    this.isLocked = false;
    this.transitionTo("completed");
  }

  public handleProvisioningFailed(id: number): void {
    if (id !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Ignored stale PROVISIONING_FAILED marker for execution ID ${id} (current is ${this.currentExecutionId})`);
      return;
    }
    const elapsed = this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0;
    Logger.error("VM", `[PROVISIONING] Script exited without completion marker! execId=${id}, elapsed=${elapsed}ms`);
    this.isLocked = false;
    this.transitionTo("failed");
  }

  public handleFailure(): void {
    this.isLocked = false;
    this.transitionTo("failed");
  }

  public handleRecover(): void {
    this.isLocked = false;
    this.transitionTo("recovering");
  }
}
