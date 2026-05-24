// src/vm/environment.ts

export const DEFAULT_VM_CONFIG = {
  memorySize: 64 * 1024 * 1024,      // 64MB RAM
  vgaMemorySize: 8 * 1024 * 1024,    // 8MB VGA RAM
  cmdline: "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
  timeoutMs: 40000,                  // 40 second boot timeout guard
};

/**
 * Commands executed silently inside the guest OS during boot to initialize
 * a clean, secure, and consistent non-root workspace environment.
 */
export const GUEST_PROVISIONING_COMMANDS = [
  "hostname linlearn",
  "mkdir -p /home/user/Projects /home/user/.config /home/user/workspace",
  "adduser -D -h /home/user -s /bin/sh user 2>/dev/null || true",
  "echo 'export HOME=/home/user' > /home/user/.profile",
  "echo 'export PS1=\"user@linlearn:\\w\\$ \"' >> /home/user/.profile",
  "echo 'cd /home/user' >> /home/user/.profile",
  "chown -R user:user /home/user",
  "su - user"
];

export const GUEST_INIT_PAYLOAD = GUEST_PROVISIONING_COMMANDS.join("\n") + "\n";

/**
 * Array of patterns that match the guest shell prompts to detect when VM is interactive.
 */
export const GUEST_PROMPT_PATTERNS = [
  "user@linlearn:~$",
  "user@linlearn:~%",
  "user@linlearn:",
  "~% ",
  "# ",
  "~# ",
  "$ "
];
