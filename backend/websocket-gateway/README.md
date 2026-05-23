# LinLearn PTY WebSocket Gateway

This directory contains the production-grade PTY terminal router and container sandbox allocation engine for LinLearn.

## Architecture Flow

```text
[xterm.js Client] <=== WebSocket (TLS) ===> [PTY Gateway Server] <=== node-pty ===> [Docker exec / Guest VM Bash]
```

## System Requirements & Prerequisites
1. **Node.js:** `>=18.x`
2. **Docker Engine:** Installed and running on the host system. The gateway user must have permission to execute commands via the Docker socket (typically by being part of the `docker` user group).
3. **Cgroups v2:** Used by the host OS kernel to enforce strict cpu and memory limits on containers.

## Production Security Hardening Checklist
* **Read-Only Root Filesystem:** Containers are spawned with `--read-only` flag to prevent modification of system binaries.
* **Non-Root Execution:** Students execute shells under UID 1000 (`user`) instead of `root` to prevent privilege escalation.
* **Network Isolation:** Spawning containers with `--network=none` isolates users from accessing public networks or the host metadata service (e.g. AWS IMDS).
* **Resource Ceilings:** Containers are throttled to `0.25 vCPU`, `256MB RAM`, and a process ceiling of `128` (prevents fork-bombs from crashing the host).

## Setup & Running Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Build TypeScript Source
```bash
npm run build
```

### 3. Start the Gateway
```bash
PORT=4000 npm start
```

### 4. Development Auto-reload Mode
```bash
npm run dev
```
