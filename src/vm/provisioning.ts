// src/vm/provisioning.ts
import { Logger } from "../lib/logger";
import { ProvisioningState } from "./vmLifecycle";

export class ProvisioningController {
  private state: ProvisioningState = "idle";
  private isLocked = false;
  private checkpoint = 0;
  private currentExecutionId = 0;
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

  public transitionTo(newState: ProvisioningState): void {
    if (this.state === newState) return;
    Logger.info("VM", `State change: ${this.state} -> ${newState}`);
    this.state = newState;
    this.onStateChange(newState);
  }

  public reset(): void {
    this.state = "idle";
    this.isLocked = false;
    this.checkpoint = 0;
  }

  public async startProvisioning(restoreCmd: string, inspectScript: string, useSerial1: boolean): Promise<boolean> {
    if (this.isLocked || this.state === "completed") {
      Logger.warn("VM", `Provisioning ignored. Locked: ${this.isLocked}, State: ${this.state}`);
      return false;
    }

    this.isLocked = true;
    this.currentExecutionId++;
    const executionId = this.currentExecutionId;

    this.transitionTo("preparing");
    this.checkpoint = 1;

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

    const script = `#!/bin/sh
exec >/tmp/provision_exec.log 2>&1
echo "[PROVISIONING] Started execution ID: ${executionId}"

hostname linlearn
mkdir -p /home/user/Projects /home/user/.config /home/user/workspace
adduser -D -h /home/user -s /bin/sh user 2>/dev/null || true

${restoreCmd}

cat << 'EOF' > /home/user/.profile
export HOME=/home/user
export PS1='user@linlearn:\\$(pwd | sed "s|^\\$HOME|~|")\\\\$ '
cd /home/user
EOF

cat << 'EOF' > /usr/bin/linlearn-inspect
${inspectScript}
EOF
chmod +x /usr/bin/linlearn-inspect

chown -R user:user /home/user
chown user /dev/ttyS0

${backgroundMonitorScript}

echo "PROVISIONING_COMPLETE:${executionId}" > /dev/ttyS0
exec sh -c 'while true; do chown user /dev/ttyS0; su - user; done' < /dev/ttyS0 > /dev/ttyS0 2>&1
`;

    this.transitionTo("transferring");

    // Convert string to base64 properly
    let base64Script = "";
    if (typeof window !== "undefined" && window.btoa) {
      // Handle potential unicode characters safely
      const encoder = new TextEncoder();
      const bytes = encoder.encode(script);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      base64Script = window.btoa(binary);
    } else {
      // Fallback if not in browser environment
      base64Script = Buffer.from(script, "utf-8").toString("base64");
    }

    Logger.info("VM", `Sending atomic provisioning script (execution ID: ${executionId}, size: ${base64Script.length} bytes)...`);

    const atomicCmd = `stty -echo; echo '${base64Script}' | base64 -d > /tmp/p.sh && chmod +x /tmp/p.sh && exec sh /tmp/p.sh\n`;

    this.transitionTo("executing");
    await this.onSendInput(0, atomicCmd);
    this.transitionTo("waiting_completion");

    return true;
  }

  public handleProvisioningComplete(id: number): void {
    if (id !== this.currentExecutionId) {
      Logger.warn("VM", `Ignored stale PROVISIONING_COMPLETE marker for execution ID ${id} (current is ${this.currentExecutionId})`);
      return;
    }
    this.checkpoint = 2;
    this.isLocked = false;
    this.transitionTo("completed");
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
