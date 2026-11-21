// Server-side 20-second ring buffer of recent TTS sentences spoken by MarketBrain.
// Blocks speaker-to-mic echo even across two open browser tabs or two devices in the same room.
import { toSpokenThai } from "./spoken-thai";

export const GREET_TEXT_CANONICAL =
  "สวัสดีครับ ผมน้องตี๋ เลขาช่วยหาสินค้าและรับออเดอร์ครับ อยากดูสินค้าตัวไหน พูดหรือพิมพ์บอกตี๋ได้เลยนะครับ";

type TtsEntry = { text: string; at: number };

const WINDOW_MS = 20_000;
const MAX_ENTRIES = 24;
const recentTts: TtsEntry[] = [];

export function recordServerTts(rawText: string): void {
  const clean = toSpokenThai(rawText.trim());
  if (!clean) return;
  const now = Date.now();
  recentTts.push({ text: clean, at: now });
  while (recentTts.length > MAX_ENTRIES || (recentTts.length > 0 && now - recentTts[0].at > WINDOW_MS)) {
    recentTts.shift();
  }
}

export function getRecentServerTts(windowMs = WINDOW_MS): string[] {
  const now = Date.now();
  while (recentTts.length > 0 && now - recentTts[0].at > WINDOW_MS) {
    recentTts.shift();
  }
  return recentTts.filter((e) => now - e.at <= windowMs).map((e) => e.text);
}
