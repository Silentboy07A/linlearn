// src/vm/provisioning.ts
import { Logger } from "../lib/logger";
import { ProvisioningState } from "./vmLifecycle";

export class ProvisioningController {
  private state: ProvisioningState = "idle";
  private isLocked = false;
  private checkpoint = 0;
  private onStateChange: (state: ProvisioningState) => void;
  private onSendInput: (data: string) => void;

  constructor(
    onStateChange: (state: ProvisioningState) => void,
    onSendInput: (data: string) => void
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

    // Lightweight heartbeat daemon on serial1 /dev/ttyS1
    const serial1Daemon = `chown user /dev/ttyS1 2>/dev/null || true; (while true; do read line < /dev/ttyS1; echo "PONG" > /dev/ttyS1; done) &`;

    const provisioningScript = `stty -echo
hostname linlearn
mkdir -p /home/user/Projects /home/user/.config /home/user/workspace
adduser -D -h /home/user -s /bin/sh user 2>/dev/null || true
${restoreCmd}
cat << 'EOF' > /home/user/.profile
export HOME=/home/user
export PS1='user@linlearn:\\$(pwd | sed "s|^\\$HOME|~|")\\\\$ '
cd /home/user
stty echo
echo "PROVISIONING_COMPLETE"
EOF
cat << 'EOF' > /usr/bin/linlearn-inspect
${inspectScript}
EOF
chmod +x /usr/bin/linlearn-inspect
chown -R user:user /home/user
chown user /dev/ttyS0
${serial1Daemon}
exec sh -c 'while true; do chown user /dev/ttyS0; su - user; done'
`;

    this.onSendInput(provisioningScript);
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
