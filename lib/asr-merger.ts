import type { LlmConfig } from "./nong-tee";

const POLITE_TAIL_RE = /(?:นะครับ|นะคะ|ครับ|ค่ะ|คะ)+$/g;
const LATIN_OR_MODEL_RE = /[a-z]{3,}|[a-z]+\d+|\d+[a-z]+/gi;
const BOT_HALLUCINATION_RE = /(?:สวัสดีครับ|ยินดีครับ|ขออภัย|น้องตี๋|สามารถช่วย|ไม่เข้าใจคำถาม|โปรดระบุ)/;

const MERGE_SYSTEM_PROMPT = `คุณคือตัวรวมผลถอดเสียงภาษาไทย+อังกฤษจากเครื่องฟัง 3 ตัว (หู 1 Whisper GPU, หู 2 OpenThai ไทยล้วน, หู 3 OpenThai ไทยผสมอังกฤษ)
งานของคุณคือรวม 3 ข้อความให้เป็นคำพูดที่ลูกค้าพูดจริงเพียง 1 ประโยคสั้นๆ เท่านั้น
กติกา:
- ดึงคำไทย/ความตั้งใจซื้อที่ชัดที่สุดมาประกอบกับชื่อแบรนด์/รุ่นภาษาอังกฤษ (ถ้ามีในหู 3)
- ห้ามตอบคำถามลูกค้า ห้ามทักทาย ห้ามอธิบาย ห้ามเติมคำที่ไม่เคยมีในหูทั้ง 3
- ตอบเฉพาะประโยคสุดท้ายที่รวมแล้วเพียงบรรทัดเดียว ไม่มีเครื่องหมายคำพูด`;

function canonicalForCompare(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "").replace(POLITE_TAIL_RE, "");
}

/**
 * Decide whether Gemma needs to fuse disagreeing ASR hypotheses into one sentence (0ms skip when ears agree).
 */
export function shouldRunGemmaAsrMerge(opts: {
  ears: [string, string, string];
  chosenText: string;
  chosenStrong: boolean;
}): boolean {
  const chosen = opts.chosenText.trim();
  if (chosen.length < 3) return false;

  const uniqueCanon = new Set<string>();
  for (const e of opts.ears) {
    const c = canonicalForCompare(e);
    if (c) uniqueCanon.add(c);
  }
  if (uniqueCanon.size < 2) return false;

  if (!opts.chosenStrong) return true;

  const chosenLower = chosen.toLowerCase();
  for (const e of opts.ears) {
    const tokens = e.match(LATIN_OR_MODEL_RE) ?? [];
    for (const tok of tokens) {
      if (!chosenLower.includes(tok.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Clean and strictly validate Gemma's merged transcript so bot replies or runaway outputs never enter STT output.
 */
export function validateMergedAsr(rawMerged: string, ears: readonly string[]): string | null {
  let cleaned = rawMerged
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/[\r\n]+/g, " ")
    .trim();
  cleaned = cleaned
    .replace(/^["""'`]+|["""'`]+$/g, "")
    .replace(/^(?:คำพูดลูกค้า|ผลลัพธ์|ข้อความที่รวม|รวมแล้ว|สรุป|[-•*])\s*[:：-]?\s*/i, "")
    .replace(/^["""'`]+|["""'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || cleaned.length < 2) return null;

  const maxEarLen = Math.max(0, ...ears.map((e) => e.trim().length));
  if (cleaned.length > maxEarLen * 1.6 + 20) return null;

  const joinedEars = ears.join(" ");
  if (BOT_HALLUCINATION_RE.test(cleaned) && !BOT_HALLUCINATION_RE.test(joinedEars)) {
    return null;
  }

  return cleaned;
}

/**
 * Ask warm local `gemma4:12b` (<=2.2s budget) to fuse Ear 1 + Ear 2 + Ear 3 when multiple ears disagree.
 */
export async function mergeTripleEarsWithGemma(opts: {
  ear1: string;
  ear2: string;
  ear3: string;
  chosenText: string;
  chosenStrong: boolean;
  cfg: LlmConfig;
  isLoaded: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<{ merged: string | null; ms: number; skipped?: string }> {
  const ears: [string, string, string] = [opts.ear1.trim(), opts.ear2.trim(), opts.ear3.trim()];
  if (!shouldRunGemmaAsrMerge({ ears, chosenText: opts.chosenText, chosenStrong: opts.chosenStrong })) {
    return { merged: null, ms: 0, skipped: "not_needed" };
  }

  if (opts.signal?.aborted) {
    return { merged: null, ms: 0, skipped: "aborted" };
  }

  const loaded = await opts.isLoaded();
  if (!loaded) {
    return { merged: null, ms: 0, skipped: "cold" };
  }

  const t0 = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1400);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const userPrompt = [
      `หู1 (Whisper GPU): ${ears[0] || "(ว่าง)"}`,
      `หู2 (OpenThai th-TH): ${ears[1] || "(ว่าง)"}`,
      `หู3 (OpenThai th-mix): ${ears[2] || "(ว่าง)"}`,
      `ตัวเลือกเบื้องต้น: ${opts.chosenText}`,
    ].join("\n");

    const res = await fetch(`${opts.cfg.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.cfg.localModel,
        messages: [
          { role: "system", content: MERGE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        think: false,
        keep_alive: opts.cfg.keepAlive,
        options: { num_ctx: opts.cfg.numCtx, temperature: 0.0, num_predict: 48 },
      }),
      signal: controller.signal,
    });

    const ms = Math.max(1, Math.round(performance.now() - t0));
    if (!res.ok) {
      return { merged: null, ms, skipped: `http_${res.status}` };
    }
    const json = (await res.json()) as { message?: { content?: string } };
    const validated = validateMergedAsr(json.message?.content ?? "", ears);
    return { merged: validated, ms, ...(validated ? {} : { skipped: "invalid_output" }) };
  } catch {
    return { merged: null, ms: Math.max(1, Math.round(performance.now() - t0)), skipped: "timeout_or_error" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
