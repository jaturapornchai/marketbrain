// Unified Production Supervisor for MarketBrain (https://marketbrain.bcsmethai.com)
// Manages:
//  1) Local GPU OmniVoice + OpenThai ASR Sidecar (127.0.0.1:3091)
//  2) Next.js Production Server (127.0.0.1:3090)
//  3) Reverse SSH Tunnel to public Caddy (127.0.0.1:13090 -> 127.0.0.1:3090)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env.local so MB_TUNNEL_SSH and runtime env vars are available
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

const PYTHON_EXE = process.env.VOICE_PYTHON_EXE || "d:\\bctest01\\.venv\\Scripts\\python.exe";
const REMOTE_SSH = process.env.MB_TUNNEL_SSH || "";
const REMOTE_PORT = process.env.MB_TUNNEL_REMOTE_PORT || "13090";
const LOCAL_PORT = process.env.PORT || "3090";

let shuttingDown = false;
const children = new Set();

function supervise(name, cmd, args, opts = {}) {
  const launch = () => {
    if (shuttingDown) return;
    const t0 = Date.now();
    console.log(`[${new Date().toISOString()}] [${name}] starting...`);
    const proc = spawn(cmd, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    children.add(proc);

    proc.stdout.on("data", (d) => {
      for (const line of String(d).trim().split(/\r?\n/)) {
        if (line) console.log(`[${name}] ${line}`);
      }
    });
    proc.stderr.on("data", (d) => {
      for (const line of String(d).trim().split(/\r?\n/)) {
        if (line) console.error(`[${name}] ${line}`);
      }
    });

    proc.on("exit", (code, sig) => {
      children.delete(proc);
      if (shuttingDown) return;
      const aliveSec = ((Date.now() - t0) / 1000).toFixed(1);
      const waitMs = aliveSec < 10 ? 6000 : 2500;
      console.warn(
        `[${new Date().toISOString()}] [${name}] exited (code=${code}, sig=${sig}, up=${aliveSec}s). Restarting in ${waitMs}ms...`,
      );
      setTimeout(launch, waitMs);
    });
  };
  launch();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shuttingDown = true;
    for (const c of children) {
      try {
        c.kill();
      } catch {
        // ignore
      }
    }
    process.exit(0);
  });
}

if (fs.existsSync(PYTHON_EXE)) {
  supervise("voice", PYTHON_EXE, ["-X", "utf8", "-W", "ignore", path.join(ROOT, "voice_sidecar", "voice_service.py")]);
} else {
  console.warn(`[voice] Python env not found at ${PYTHON_EXE}; skipping local voice sidecar`);
}

const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
supervise("web", process.execPath, [nextBin, "start", "-p", LOCAL_PORT], {
  env: { ...process.env, NODE_ENV: "production", PORT: LOCAL_PORT },
});

if (REMOTE_SSH) {
  supervise("tunnel", "ssh", [
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
  ]);
} else {
  console.log("[tunnel] MB_TUNNEL_SSH not set in .env.local; running local-only");
}
