// Full-duplex speaker-echo guard, adaptive noise gate & text echo filter (client-safe, zero DOM/Node imports).
// Tuned for 32 ms AudioWorklet frames (512 samples @ 16 kHz) paired with WebRTC loopback AEC3 + Silero VAD v5.

const ENVELOPE_HOP_SEC = 0.032; // matches 32 ms AudioWorklet frame (512 samples @ 16 kHz)
const UNKNOWN_PLAYED_RMS = 0.25; // envelope not decoded yet -> assume full voice
const ECHO_WINDOW_SEC = 0.36; // speaker/room reverb + loopback latency window
const PLAYED_AUDIBLE_RMS = 0.018;

// Echo calibration & 2-stage barge-in thresholds (32 ms frames)
const CALIB_FRAMES = 6; // ~192 ms of initial audible bot speech to learn room echo ratio
export const DUCK_FRAMES = 3; // ~96 ms of clear user speech -> duck bot volume to 15%
export const FAST_BARGE_FRAMES = 6; // ~192 ms if loud & high-confidence human speech
export const BARGE_FRAMES = 8; // ~256 ms of sustained human speech -> hard-stop bot
const DUCK_RELEASE_MISSES = 4; // ~128 ms of silence/echo while ducked -> restore bot volume to 100%

export type EchoDecision = "echo" | "duck" | "barge_in";

/** RMS envelope (one value per 32 ms) of a PCM16 mono/stereo WAV, or null if the file is not PCM16. */
export function wavEnvelope(buf: ArrayBuffer): Float32Array | null {
  const view = new DataView(buf);
  if (buf.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return null; // "RIFF"
  let pos = 12;
  let channels = 1;
  let rate = 24000;
  let pcm16 = false;
  while (pos + 8 <= buf.byteLength) {
    const id = view.getUint32(pos, false);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 0x666d7420) {
      // "fmt "
      pcm16 = view.getUint16(body, true) === 1 && view.getUint16(body + 14, true) === 16;
      channels = view.getUint16(body + 2, true) || 1;
      rate = view.getUint32(body + 4, true) || rate;
    } else if (id === 0x64617461) {
      // "data"
      if (!pcm16) return null;
      const frames = Math.floor(Math.min(size, buf.byteLength - body) / (2 * channels));
      const hop = Math.max(1, Math.round(rate * ENVELOPE_HOP_SEC));
      const env = new Float32Array(Math.ceil(frames / hop));
      for (let h = 0; h < env.length; h++) {
        const end = Math.min(frames, (h + 1) * hop);
        let sumSq = 0;
        for (let i = h * hop; i < end; i++) {
          const v = view.getInt16(body + i * 2 * channels, true) / 32768;
          sumSq += v * v;
        }
        env[h] = Math.sqrt(sumSq / Math.max(1, end - h * hop));
      }
      return env;
    }
    pos = body + size + (size & 1);
  }
  return null;
}

/** Loudest level played during the window that can still be in the mic frame ending at `currentTimeSec`. */
export function playedLevel(env: Float32Array | null, currentTimeSec: number): number {
  if (!env) return UNKNOWN_PLAYED_RMS;
  const last = Math.min(env.length - 1, Math.floor(currentTimeSec / ENVELOPE_HOP_SEC));
  const first = Math.max(0, Math.floor((currentTimeSec - ECHO_WINDOW_SEC) / ENVELOPE_HOP_SEC));
  let max = 0;
  for (let i = first; i <= last; i++) if (env[i] > max) max = env[i];
  return max;
}

/**
 * Adaptive ambient noise gate (post-HPF 95 Hz).
 * Tracks the room's steady noise floor (fan, AC, road hum) during non-speech and combines it
 * with client-side Silero VAD speech probability (with automatic RMS-SNR fallback if WASM is absent).
 */
export class AdaptiveNoiseGate {
  private floor = 0.004;

  get noiseFloor(): number {
    return this.floor;
  }

  private updateFloor(rms: number): void {
    if (rms < this.floor) {
      this.floor = this.floor * 0.9 + rms * 0.1;
    } else {
      // Climb gently so steady fan/AC hum is absorbed without letting loud noise lock out real voice.
      this.floor = Math.min(0.045, this.floor * 0.975 + rms * 0.025);
    }
  }

  /**
   * Returns true if this 32 ms frame is human speech clearly above the room's ambient noise floor.
   * `speechProb` is Silero VAD v5 output (0..1), or `null` when running in energy-only fallback mode.
   */
  isVoiceFrame(rms: number, speechProb: number | null, alreadySpeaking: boolean): boolean {
    if (speechProb !== null) {
      const probThreshold = alreadySpeaking ? 0.38 : 0.62;
      const rmsThreshold = Math.max(alreadySpeaking ? 0.0045 : 0.006, this.floor * (alreadySpeaking ? 1.35 : 1.85));
      const isVoice = speechProb >= probThreshold && rms >= rmsThreshold;
      if (!isVoice && speechProb < 0.25) {
        this.updateFloor(rms);
      }
      return isVoice;
    }

    const rmsThreshold = Math.max(alreadySpeaking ? 0.011 : 0.015, this.floor * (alreadySpeaking ? 2.1 : 2.8));
    const isVoice = rms >= rmsThreshold;
    if (!isVoice) {
      this.updateFloor(rms);
    }
    return isVoice;
  }

  reset(): void {
    this.floor = 0.004;
  }
}

/**
 * 2-stage speaker-echo guard & barge-in detector (32 ms frames):
 *  - Learns how strongly the speaker leaks into this room's mic (`gain`).
 *  - Stage 1 ("duck"): after ~96 ms of speech over echo, ducks bot volume to 15% without dropping the queue.
 *  - Stage 2 ("barge_in"): after ~192–256 ms of sustained speech, confirms real interruption.
 *  - If speech stops before Stage 2 (cough/tap), returns "echo" after ~128 ms so volume restores cleanly.
 */
export class EchoGuard {
  private gain = 0;
  private calibrated = 0;
  private run = 0;
  private missRun = 0;
  private ducked = false;

  get isDucked(): boolean {
    return this.ducked;
  }

  hear(
    micRms: number,
    playedRms: number,
    speechProb: number | null = null,
    aecLoopbackActive = false,
  ): EchoDecision {
    // While ducked to 15% volume, expected speaker leakage drops proportionally.
    const effectivePlayed = this.ducked ? playedRms * 0.25 : playedRms;

    if (!this.ducked && playedRms >= PLAYED_AUDIBLE_RMS && this.calibrated < CALIB_FRAMES) {
      const ratio = Math.min(0.85, micRms / playedRms);
      this.calibrated += 1;
      this.gain = Math.max(this.gain, ratio);
      this.run = 0;
      this.missRun = 0;
      return "echo";
    }

    let isCustomer = false;
    const vadPass =
      speechProb === null
        ? true
        : this.ducked
          ? speechProb >= 0.48
          : speechProb >= 0.72;

    if (vadPass) {
      const minRms = speechProb !== null ? (aecLoopbackActive ? 0.013 : 0.018) : 0.028;
      const overEcho = aecLoopbackActive ? 1.85 : 2.05;

      if (effectivePlayed >= PLAYED_AUDIBLE_RMS) {
        const expectedEcho = this.gain * effectivePlayed;
        isCustomer = micRms > Math.max(minRms, expectedEcho * overEcho);
        if (!this.ducked) {
          const ratio = Math.min(0.95, micRms / effectivePlayed);
          // Follow echo down quickly-ish, up only slowly, so customer barge-in cannot raise the bar.
          this.gain = ratio < this.gain ? this.gain * 0.92 + ratio * 0.08 : Math.min(ratio, this.gain * 1.02);
        }
      } else {
        isCustomer = micRms > minRms;
      }
    }

    if (isCustomer) {
      this.run += 1;
      this.missRun = 0;
      const needBarge =
        speechProb !== null && speechProb >= 0.85 && micRms >= 0.038 ? FAST_BARGE_FRAMES : BARGE_FRAMES;
      if (this.run >= needBarge) {
        this.ducked = false;
        this.run = 0;
        this.missRun = 0;
        return "barge_in";
      }
      if (this.run >= DUCK_FRAMES) {
        this.ducked = true;
        return "duck";
      }
      return this.ducked ? "duck" : "echo";
    }

    if (this.ducked) {
      this.missRun += 1;
      if (this.missRun >= DUCK_RELEASE_MISSES) {
        this.ducked = false;
        this.run = 0;
        this.missRun = 0;
        return "echo";
      }
      return "duck";
    }

    this.run = 0;
    this.missRun = 0;
    return "echo";
  }

  resetRun(): void {
    this.run = 0;
    this.missRun = 0;
    this.ducked = false;
  }
}

// Explicit short Thai cut-in / sales phrases that must never be discarded as echo.
const CUT_IN_PHRASES = new Set([
  "หยุด",
  "หยุดก่อน",
  "เดี๋ยว",
  "เดี๋ยวก่อน",
  "พอ",
  "พอก่อน",
  "เงียบ",
  "ฟังก่อน",
  "เอา",
  "ไม่เอา",
  "เอาอันนี้",
  "เอาตัวนี้",
  "เอาตัวแรก",
  "ตกลง",
  "ใช่",
  "ไม่ใช่",
  "สั่ง",
  "ซื้อ",
  "ยกเลิก",
  "เพิ่ม",
  "ลบ",
  "เปลี่ยน",
  "ขอโทษ",
  "ถอยกลับ",
  "ย้อนกลับ",
  "หน้าหลัก",
  "ดูตะกร้า",
  "คิดเงิน",
  "ชำระเงิน",
  "ครับ",
  "ค่ะ",
]);

const PUNCT_SPACE_RE = /[\s.,!?;:()[\]{}"'`~@#$%^&*+=<>|\\/_—–…“”‘’]+/g;
const WORD_CHAR_RE = /[ก-๙A-Za-z0-9]/;

const THAI_DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const THAI_PLACES = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน", "ล้าน"];

function intToThaiWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 0) return "ศูนย์";
  if (n >= 1_000_000) return String(Math.floor(n)).split("").map((d) => THAI_DIGITS[Number(d)] ?? d).join("");
  const digits = String(Math.floor(n));
  const len = digits.length;
  let out = "";
  for (let i = 0; i < len; i++) {
    const d = Number(digits[i]);
    const pos = len - 1 - i;
    if (d === 0) continue;
    if (pos === 1 && d === 1) out += "สิบ";
    else if (pos === 1 && d === 2) out += "ยี่สิบ";
    else if (pos === 0 && d === 1 && len > 1) out += "เอ็ด";
    else out += THAI_DIGITS[d] + THAI_PLACES[pos];
  }
  return out;
}

/** Converts Arabic numbers inside bot speech ("141", "23.50", "1,090") to Thai words so Whisper's echo matches it. */
export function normalizeForEchoMatch(text: string): string {
  return text
    .replace(/฿/g, " ")
    .replace(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g, (_, whole: string, frac?: string) => {
      const w = intToThaiWords(Number(whole.replace(/,/g, "")));
      if (!frac) return ` ${w} `;
      const f = frac.split("").map((d) => THAI_DIGITS[Number(d)] ?? d).join("");
      return ` ${w}จุด${f} `;
    })
    .replace(/แพ[็ั]?[คก]/g, "แพ็ก")
    .replace(/สไล[ซด]์/g, "สไลด์")
    .replace(/ตี๋/g, "ตี");
}

let thaiSegmenter: Intl.Segmenter | null | undefined;
function segmentThaiWords(text: string): string[] {
  if (thaiSegmenter === undefined) {
    thaiSegmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter("th", { granularity: "word" })
        : null;
  }
  const out: string[] = [];
  const keepToken = (raw: string) => {
    const w = raw.replace(PUNCT_SPACE_RE, "").toLowerCase();
    if (!w || !WORD_CHAR_RE.test(w)) return;
    // Keep digits (e.g. "2" in "2 ขวด") and words >= 2 chars so quantities count as customer speech.
    if (w.length >= 2 || /\d/.test(w)) out.push(w);
  };
  if (thaiSegmenter) {
    for (const seg of thaiSegmenter.segment(text)) keepToken(seg.segment);
    return out;
  }
  for (const part of text.split(PUNCT_SPACE_RE)) keepToken(part);
  return out;
}

/**
 * Text-level echo safety net (adapted from bctest01 grounding.is_echo):
 * Returns true when a multi-word STT transcript closely mirrors what Nong Tee just spoke
 * in both vocabulary AND word order (contiguous substring or adjacent bigrams).
 * Normalizes digits to Thai words so "141 บาท" matches Whisper's "หนึ่งร้อยสี่สิบเอ็ดบาท".
 * Never rejects explicit short cut-in commands or customer orders referencing a product name.
 */
export function isEchoTranscript(heard: string, recentSpoken: string): boolean {
  const cleanHeard = heard.trim();
  const cleanSpoken = recentSpoken.trim();
  if (!cleanHeard || !cleanSpoken) return false;

  const compactRaw = cleanHeard.replace(PUNCT_SPACE_RE, "").toLowerCase();
  if (!compactRaw || CUT_IN_PHRASES.has(compactRaw)) return false;

  const normHeard = normalizeForEchoMatch(cleanHeard);
  const normSpoken = normalizeForEchoMatch(cleanSpoken);
  const compactHeard = normHeard.replace(PUNCT_SPACE_RE, "").toLowerCase();
  const compactSpoken = normSpoken.replace(PUNCT_SPACE_RE, "").toLowerCase();
  if (compactSpoken.length < 6) return false;

  // Direct contiguous echo (mic picked up a whole clause from the speaker)
  if (compactHeard.length >= 10 && compactSpoken.includes(compactHeard)) return true;

  const words = segmentThaiWords(normHeard);
  if (words.length < 3) return false;

  let matchedWords = 0;
  let matchedChars = 0;
  for (const w of words) {
    if (compactSpoken.includes(w)) {
      matchedWords += 1;
      matchedChars += w.length;
    }
  }
  if (matchedWords / words.length < 0.65 || matchedChars < 10) return false;

  // Require word-order continuity (adjacent bigrams present in bot speech) so a customer ordering
  // "เอาน้ำปลาทิพรส 2 ขวดครับ" after the bot mentioned "น้ำปลาทิพรส ... ขวดนะครับ" is never blocked.
  let matchedBigrams = 0;
  const totalBigrams = words.length - 1;
  for (let i = 0; i < totalBigrams; i++) {
    if (compactSpoken.includes(words[i] + words[i + 1])) matchedBigrams += 1;
  }
  return matchedBigrams / totalBigrams >= 0.45;
}

const BOT_CLOSING_CUE_RE =
  /(?:รับกี่[ก-๙]{1,8}(?:ดี)?ครับ|รับเบอร์ไหน(?:ดี)?ครับ|รับอะไรเพิ่มหรือคิดเงินเลยครับ|คิดเงินเลยไหมครับ|รับไหมครับ|สนใจตัวไหนดีครับ|บอกตี๋?ได้เลยนะครับ|บอกตี๋?ได้เลยครับ|เอาเบอร์ไหนดีครับ)/g;

/**
 * Strips leading speaker-echo from a transcript when Nong Tee's own voice leaked before a customer cut-in
 * (e.g. "ช่องระบายอากาศ...รับเบอร์ไหนดีครับผักกาดขาว" -> "ผักกาดขาว"), or drops whole-sentence echo cleanly.
 */
export function stripBotEcho(
  heard: string,
  recentSpokenList: string[],
): { text: string; wasEcho: boolean; stripped: boolean } {
  const clean = heard.trim();
  if (!clean || recentSpokenList.length === 0) return { text: clean, wasEcho: false, stripped: false };

  const combined = recentSpokenList.join(" ");
  const normCombined = normalizeForEchoMatch(combined).replace(PUNCT_SPACE_RE, "").toLowerCase();

  // Check closing cue FIRST so if the customer cut in right after Nong Tee's sentence
  // ("...รับกี่ก้อนดีครับผักกาดขาว"), we strip the echo prefix and keep "ผักกาดขาว" instead of dropping the whole turn.
  const cueMatches = [...clean.matchAll(BOT_CLOSING_CUE_RE)];
  if (cueMatches.length > 0) {
    const last = cueMatches[cueMatches.length - 1];
    const endIdx = (last.index ?? 0) + last[0].length;
    const prefix = clean.slice(0, endIdx).trim();
    const tail = clean.slice(endIdx).replace(/^[\s.,!?]+/, "").trim();
    const prefixWords = segmentThaiWords(normalizeForEchoMatch(prefix));
    if (prefixWords.length >= 3) {
      let hits = 0;
      let hitChars = 0;
      for (const w of prefixWords) {
        if (normCombined.includes(w)) {
          hits++;
          hitChars += w.length;
        }
      }
      if (hits / prefixWords.length >= 0.5 && hitChars >= 12) {
        if (tail.length < 2) return { text: "", wasEcho: true, stripped: false };
        return { text: tail, wasEcho: false, stripped: true };
      }
    }
  }

  if (isEchoTranscript(clean, combined)) {
    return { text: "", wasEcho: true, stripped: false };
  }

  return { text: clean, wasEcho: false, stripped: false };
}
