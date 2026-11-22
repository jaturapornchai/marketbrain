// Lightweight JSONL telemetry logs for MarketBrain voice & local/fallback LLM auditing
// (.data/voice-turns.jsonl and .data/llm-dev.jsonl).
// Masks Thai phone numbers so PII never lands in plain logs (Iron Rule #10).
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const LOG_PATH = path.join(DATA_DIR, "voice-turns.jsonl");
const PREV_PATH = path.join(DATA_DIR, "voice-turns.prev.jsonl");
const LLM_LOG_PATH = path.join(DATA_DIR, "llm-dev.jsonl");
const LLM_PREV_PATH = path.join(DATA_DIR, "llm-dev.prev.jsonl");
const MAX_BYTES = 5 * 1024 * 1024;

export type LlmProviderKind = "local" | "fallback" | "ram";

export type LlmDevLogEntry = {
  ts?: string;
  phase: "planner" | "chat_round" | "vision" | "turn_summary" | "asr_merge";
  provider: LlmProviderKind;
  model: string;
  ms: number;
  loadMs?: number;
  promptMs?: number;
  evalMs?: number;
  promptTok?: number;
  evalTok?: number;
  tps?: number;
  round?: number;
  toolCalls?: string[];
  fallbackReason?: string;
  error?: string;
  query?: string;
  altHeard?: string;
  spoken?: string;
  ok?: boolean;
};

export type LlmDevStats = {
  localTurns: number;
  fallbackTurns: number;
  ramTurns: number;
  visionLocalCalls: number;
  errorCount: number;
  lastProvider: LlmProviderKind | null;
  lastModel: string;
  lastMs: number;
  lastTps?: number;
  lastFallbackReason?: string;
  lastAt: string | null;
};

const STATS_KEY = Symbol.for("marketbrain.llmDevStats");

function statsStore(): LlmDevStats {
  const g = globalThis as Record<symbol, LlmDevStats | undefined>;
  if (!g[STATS_KEY]) {
    g[STATS_KEY] = {
      localTurns: 0,
      fallbackTurns: 0,
      ramTurns: 0,
      visionLocalCalls: 0,
      errorCount: 0,
      lastProvider: null,
      lastModel: "",
      lastMs: 0,
      lastAt: null,
    };
  }
  return g[STATS_KEY]!;
}

const PHONE_RE = /(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{3,4}(?!\d)/g;

export function maskPii(text: string): string {
  return text.replace(PHONE_RE, (m) => m.slice(0, 3) + "XXXX" + m.slice(-2));
}

function sanitizeValue(v: unknown): unknown {
  if (typeof v === "string") return maskPii(v).slice(0, 400);
  if (Array.isArray(v)) return v.slice(0, 20).map(sanitizeValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
      if (val !== undefined) out[k] = sanitizeValue(val);
    }
    return out;
  }
  return v;
}

function appendJsonlRotated(filePath: string, prevPath: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(filePath) && fs.statSync(filePath).size >= MAX_BYTES) {
    try {
      fs.renameSync(filePath, prevPath);
    } catch {
      // ignore rotation race
    }
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...(sanitizeValue(payload) as Record<string, unknown>),
  });
  fs.appendFileSync(filePath, line + "\n", "utf8");
}

export function appendVoiceLog(entry: Record<string, unknown>): void {
  try {
    appendJsonlRotated(LOG_PATH, PREV_PATH, entry);
  } catch {
    // Telemetry must never interrupt a live customer turn.
  }
}

export function appendLlmDevLog(entry: LlmDevLogEntry): void {
  const nowIso = new Date().toISOString();
  const s = statsStore();
  if (entry.phase === "turn_summary") {
    if (entry.provider === "local") s.localTurns += 1;
    else if (entry.provider === "fallback") s.fallbackTurns += 1;
    else if (entry.provider === "ram") s.ramTurns += 1;
    s.lastProvider = entry.provider;
    s.lastModel = entry.model;
    s.lastMs = entry.ms;
    if (entry.tps !== undefined) s.lastTps = entry.tps;
    s.lastFallbackReason = entry.fallbackReason ? maskPii(entry.fallbackReason).slice(0, 160) : undefined;
    s.lastAt = nowIso;
    if (entry.error || entry.ok === false) s.errorCount += 1;
  } else if (entry.phase === "vision") {
    s.visionLocalCalls += 1;
    if (entry.error || entry.ok === false) s.errorCount += 1;
  } else if (entry.phase === "chat_round") {
    if (entry.tps !== undefined) s.lastTps = entry.tps;
    if (entry.error || entry.ok === false) s.errorCount += 1;
  }

  try {
    appendJsonlRotated(LLM_LOG_PATH, LLM_PREV_PATH, { ...entry, ts: nowIso } as Record<string, unknown>);
  } catch {
    // Telemetry must never interrupt a live customer turn.
  }
}

export function getLlmDevStats(): LlmDevStats {
  return { ...statsStore() };
}

export function readRecentLlmDevLogs(limit = 30): LlmDevLogEntry[] {
  const capped = Math.max(1, Math.min(100, Math.floor(limit || 30)));
  try {
    if (!fs.existsSync(LLM_LOG_PATH)) return [];
    const raw = fs.readFileSync(LLM_LOG_PATH, "utf8");
    const lines = raw.trim().split(/\r?\n/);
    const out: LlmDevLogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < capped; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as LlmDevLogEntry);
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}
