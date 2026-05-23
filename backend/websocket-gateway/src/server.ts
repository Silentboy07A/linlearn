import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import pty from "node-pty";
import cors from "cors";
import dotenv from "dotenv";
import { VMAllocationPooler } from "./pooler";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const pooler = new VMAllocationPooler();

const PORT = process.env.PORT || 4000;

// Health check endpoint
app.get("/health", (req: express.Request, res: express.Response) => {
  res.json({ status: "healthy", activeSessions: wss.clients.size });
});

// Coordinate WebSocket handshakes
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  
  if (url.pathname === "/tty") {
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (ws: WebSocket, request: http.IncomingMessage) => {
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  const userId = url.searchParams.get("userId");

  if (!userId) {
    ws.close(1008, "Missing userId credential parameter.");
    return;
  }

  console.log(`Establishing secure terminal stream connection for user: ${userId}`);

  try {
    // 1. Allocate or retrieve sandbox VM container
    const containerId = await pooler.allocateVM(userId);

    // 2. Spawn PTY process attached to the guest sandbox container
    // If running in production with Docker, execute bash inside the user container.
    // Falls back to local bash for development environments.
    const isMock = containerId.startsWith("mock-");
    const shellFile = isMock ? (process.platform === "win32" ? "powershell.exe" : "bash") : "docker";
    const shellArgs = isMock ? [] : ["exec", "-it", containerId, "su", "-", "user"];

    const ptyProcess = pty.spawn(shellFile, shellArgs, {
      name: "xterm-color",
      cols: 80,
      rows: 25,
      cwd: process.env.HOME || process.env.USERPROFILE,
      env: process.env as Record<string, string>,
    });

    console.log(`PTY process spawned successfully (PID: ${ptyProcess.pid}) for container: ${containerId}`);

    // Keep session alive while socket remains connected
    const heartbeat = setInterval(() => {
      pooler.keepAlive(userId);
    }, 30000);

    // 3. Pipe PTY stdout stream back to client WebSocket
    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // 4. Receive client keystrokes and pipe to PTY process input
    ws.on("message", (message: any) => {
      pooler.keepAlive(userId);
      ptyProcess.write(message.toString());
    });

    // Handle terminal resize commands from client xterm
    ws.on("message", (message: any) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === "resize" && parsed.cols && parsed.rows) {
          ptyProcess.resize(parsed.cols, parsed.rows);
        }
      } catch {
        // Normal text inputs will fail JSON parsing and fall through
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      ptyProcess.kill();
      console.log(`Terminal connection closed for user: ${userId}`);
      
      // Keep sandbox alive for 5 minutes in case of quick page reloads / network switches
      setTimeout(() => {
        pooler.releaseVM(userId).catch(console.error);
      }, 5 * 60 * 1000);
    });

    ws.on("error", (error: any) => {
      console.error(`Socket error in user session ${userId}:`, error);
      ptyProcess.kill();
      clearInterval(heartbeat);
    });

  } catch (err) {
    console.error(`Failed to establish PTY connection for user ${userId}:`, err);
    ws.close(1011, "Sandbox allocation failed.");
  }
});

server.listen(PORT, () => {
  console.log(`🚀 LinLearn PTY WebSocket Gateway running on port ${PORT}`);
});
