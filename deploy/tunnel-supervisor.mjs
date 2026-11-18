// Reverse SSH Tunnel Supervisor for https://marketbrain.bcsmethai.com
// Reads MB_TUNNEL_SSH from .env.local (never hardcoded in git)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envLocalPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const rawLine of fs.readFileSync(envLocalPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}

const REMOTE_SSH = process.env.MB_TUNNEL_SSH || "";
const REMOTE_PORT = process.env.MB_TUNNEL_REMOTE_PORT || "13090";
const LOCAL_PORT = process.env.MB_TUNNEL_LOCAL_PORT || "3090";

if (!REMOTE_SSH) {
  console.error("Missing MB_TUNNEL_SSH in .env.local");
  process.exit(1);
}

let stopping = false;
let activeProc = null;

function startTunnel() {
  if (stopping) return;
  const startedAt = Date.now();
  console.log(`[${new Date().toISOString()}] [tunnel] Dialing reverse SSH (127.0.0.1:${REMOTE_PORT} -> 127.0.0.1:${LOCAL_PORT})...`);

  const proc = spawn(
    "ssh",
    [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=20",
      "-o",
      "ServerAliveCountMax=3",
      "-R",
      `127.0.0.1:${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}`,
      REMOTE_SSH,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  activeProc = proc;
  proc.stderr.on("data", (d) => {
    const line = String(d).trim();
    if (line) console.error(`[tunnel:ssh] ${line}`);
  });

  proc.on("exit", (code, sig) => {
    activeProc = null;
    if (stopping) return;
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.warn(`[${new Date().toISOString()}] [tunnel] Disconnected after ${elapsedSec}s (code=${code}, sig=${sig}). Redialing in 6s...`);
    setTimeout(startTunnel, 6000);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    if (activeProc) activeProc.kill();
    process.exit(0);
  });
}

startTunnel();
