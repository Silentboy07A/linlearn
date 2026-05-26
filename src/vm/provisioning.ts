// src/vm/provisioning.ts
import { Logger } from "../lib/logger";
import { ProvisioningState } from "./vmLifecycle";

export class ProvisioningController {
  private state: ProvisioningState = "idle";
  private isLocked = false;
  private checkpoint = 0;
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

  public startProvisioning(restoreCmd: string, inspectScript: string): boolean {
    if (this.isLocked || this.state === "completed") {
      Logger.warn("VM", `Provisioning ignored. Locked: ${this.isLocked}, State: ${this.state}`);
      return false;
    }

    this.isLocked = true;
    this.transitionTo("running");
    this.checkpoint = 1;

    Logger.info("VM", "Initiating provisioning script execution...");

    // 1. Send the single-line trigger command to serial0 (user interactive TTY)
    const triggerCmd = `rm -f /tmp/provision_event && mkfifo /tmp/provision_event && (sh < /dev/ttyS1 > /dev/ttyS1 2>&1 &) && (read _ < /tmp/provision_event; rm -f /tmp/provision_event; exec sh -c 'while true; do chown user /dev/ttyS0; su - user; done')\n`;
    this.onSendInput(0, triggerCmd);

    // 2. Send the actual provisioning commands to serial1 (background TTYS1)
    const provisioningScript = `hostname linlearn
mkdir -p /home/user/Projects /home/user/.config /home/user/workspace
adduser -D -h /home/user -s /bin/sh user 2>/dev/null || true
${restoreCmd}
cat << 'EOF' > /home/user/.profile
export HOME=/home/user
export PS1='user@linlearn:\\$(pwd | sed "s|^\\$HOME|~|")\\\\$ '
cd /home/user
echo "PROVISIONING_COMPLETE"
EOF
cat << 'EOF' > /usr/bin/linlearn-inspect
${inspectScript}
EOF
chmod +x /usr/bin/linlearn-inspect
chown -R user:user /home/user
chown user /dev/ttyS0
echo "done" > /tmp/provision_event
exec sh -c '
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
      echo -e "\\033c" > /dev/ttyS0 2>/dev/null
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
'
`;

    this.onSendInput(1, provisioningScript);
    return true;
  }

  public handleProvisioningComplete(): void {
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
