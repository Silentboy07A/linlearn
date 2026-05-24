// src/vm/inspect.ts

/**
 * Shell script deployed to the guest VM at `/usr/bin/linlearn-inspect`.
 * It executes when the user clicks 'Verify Mission' to inspect guest state and serializes it.
 */
export const GUEST_INSPECT_SCRIPT = `#!/bin/sh
echo "INSPECT_START"
echo "=== FILES ==="
# Recursively list files up to depth 3 in /home/user, printing path, type, octal permissions, owner, size
find /home/user -maxdepth 3 -exec stat -c "%n:%F:%a:%U:%s" {} \\; 2>/dev/null
# Also include Nginx config and access logs
stat -c "%n:%F:%a:%U:%s" /etc/nginx/nginx.conf 2>/dev/null
stat -c "%n:%F:%a:%U:%s" /var/log/nginx/access.log 2>/dev/null

echo "=== PROCESSES ==="
ps -w 2>/dev/null || ps

echo "=== FILE_CONTENTS ==="
echo "--- /etc/nginx/nginx.conf ---"
if [ -f /etc/nginx/nginx.conf ]; then
  cat /etc/nginx/nginx.conf 2>/dev/null
fi
echo "--- /var/log/nginx/access.log ---"
if [ -f /var/log/nginx/access.log ]; then
  tail -n 15 /var/log/nginx/access.log 2>/dev/null
fi

echo "=== HISTORY ==="
if [ -f /home/user/.ash_history ]; then
  tail -n 10 /home/user/.ash_history 2>/dev/null
elif [ -f ~/.ash_history ]; then
  tail -n 10 ~/.ash_history 2>/dev/null
else
  history 2>/dev/null | tail -n 10 || echo "no-history"
fi

echo "INSPECT_END"
`;
