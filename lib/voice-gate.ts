// Zero-latency local voice micro-noise filter (replaces the removed BGE-M3 gatekeeper).
// All real customer Thai utterances pass straight through to Nong Tee (gemma4:12b) with 0 ms overhead.

export type VoiceGateResult = {
  allow: boolean;
  prob: number;
  reason: "direct_pass" | "empty" | "noise";
  ms: number;
};

// Drop only blank transcripts, pure punctuation, single non-digit symbols, or bare filler hesitations.
const PURE_PUNCT_RE = /^[\s.…,!?'"\-_~`()[\]{}]+$/u;
const PURE_HESITATION_RE = /^(?:เอ่อ+|อืม+|อ่า+|อือ+|เออ+|ฮึ+|หืม+)[.…\s]*$/i;

export async function classifyVoiceIntent(
  text: string,
  _ctx?: { pendingQty?: boolean; hasFocus?: boolean; signal?: AbortSignal },
): Promise<VoiceGateResult> {
  const trimmed = text.trim();
  if (!trimmed || PURE_PUNCT_RE.test(trimmed)) {
    return { allow: false, prob: 0, reason: "empty", ms: 0 };
  }
  if (trimmed.length < 2 && !/^\d$/.test(trimmed)) {
    return { allow: false, prob: 0, reason: "noise", ms: 0 };
  }
  if (PURE_HESITATION_RE.test(trimmed)) {
    return { allow: false, prob: 0, reason: "noise", ms: 0 };
  }
  return { allow: true, prob: 1, reason: "direct_pass", ms: 0 };
}
