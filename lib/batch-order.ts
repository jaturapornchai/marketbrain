import Decimal from "decimal.js";
import { formatThaiBaht, parseDecimal } from "./decimal-money";
import { evaluateDietaryShield, type DietaryTagId } from "./dietary-shield";
import { NUM_WORDS, parseThaiNumber } from "./numbered-order";
import type { JavisProductCard } from "./product-card";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type BatchOrderItemRequest = {
  rawPhrase: string;
  query: string;
  qty: number;
  unitHint: string;
};

export type BatchOrderMatchRow = {
  id: string;
  rawPhrase: string;
  query: string;
  qty: number;
  unitCode: string;
  unitPrice: string;
  matched: JavisProductCard | null;
  alternatives: JavisProductCard[];
  selected: boolean;
  dietaryWarn?: string;
};

export type BatchOrderPlan = {
  rawMessage: string;
  rows: BatchOrderMatchRow[];
  matchedCount: number;
  totalFormatted: string;
};

const ORDER_UNIT_LIST =
  "ขวด|ลัง|แพ็ค|แพค|กล่อง|ซอง|ถุง|กระป๋อง|ชิ้น|อัน|กิโลกรัม|กิโล|กก\\.?|โล|โหล|ม้วน|แผง|หลอด|ก้อน|กระปุก|แท่ง|คู่|ใบ|เส้น|ชุด|กระสอบ|ถัง|แกลลอน|ห่อ|ตลับ|ปี๊บ|ลิตร";

const CARD_REF_GUARD_RE = /(?:เบอร์|หมายเลข|เลขที่|อันที่|ตัวที่|รายการที่|ข้อ)\s*(?:\d|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)/;
const QUESTION_GUARD_RE = /(?:เท่าไหร่|เท่าไร|ยังไง|อย่างไร|คุ้มกว่า|ต่างกัน|ราคาไหน)/;
const LEADING_FILLER_RE = /^(?:นะครับ|นะคะ|นะ|ครับผม|ครับ|คับ|ค่ะ|คะ|เออ|อ่า|เอ่อ|น้องตี๋|ตี๋|ช่วย|จัด|สั่ง|ขอ|เอา|รับ|ซื้อ|เพิ่ม|ใส่|และ|กับ|แล้วก็|ด้วย|\s)+/i;
const TRAILING_FILLER_RE = /(?:นะครับ|นะคะ|นะ|ครับผม|ครับ|คับ|ค่ะ|คะ|ด้วย|เลย|หน่อย|ให้หน่อย|ทั้งหมด|\s)+$/i;

const QTY_TOKEN = `(\\d{1,3}(?!\\d)|(?:${NUM_WORDS})+)`;
const SEGMENT_RE = new RegExp(
  `([\\p{L}\\p{M}\\p{N}.%+\\-/\\s]{2,56}?)\\s*(?:จำนวน|อย่างละ|สัก)?\\s*${QTY_TOKEN}\\s*(${ORDER_UNIT_LIST})(?!\\s*(?:\\d|${NUM_WORDS}|บาท))`,
  "gu",
);

function cleanBatchQuery(raw: string): string {
  let out = raw.trim();
  for (let i = 0; i < 4; i++) {
    const next = out.replace(LEADING_FILLER_RE, "").replace(TRAILING_FILLER_RE, "").trim();
    if (next === out) break;
    out = next;
  }
  return out.replace(/^[,،\n+]+|[,،\n+]+$/g, "").trim();
}

/**
 * Parse continuous multi-item spoken Thai orders or pasted chat lists into structured item requests.
 * Returns >= 2 valid items only, so single-product browse queries never hijack normal search.
 */
export function parseBatchOrderPhrases(rawText: string): BatchOrderItemRequest[] {
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.length > 600) return [];
  if (CARD_REF_GUARD_RE.test(trimmed) || QUESTION_GUARD_RE.test(trimmed)) return [];

  // Normalize connectors that glue clauses together without changing words inside product names.
  const normalized = trimmed
    .replace(/[\r\n,،+]+/g, " , ")
    .replace(/\s+(?:แล้วก็|พร้อมกับ|แล้วเอา|แล้วขอ)\s+/g, " , ")
    .replace(/\s+(?:กับ|และ)\s+(?=[^\s,]+\s+\d)/g, " , ");

  const items: BatchOrderItemRequest[] = [];
  for (const m of normalized.matchAll(SEGMENT_RE)) {
    const query = cleanBatchQuery(m[1] ?? "");
    const qty = parseThaiNumber(m[2] ?? "");
    const unitHint = (m[3] ?? "").replace(/\.$/, "").trim();

    if (!query || query.length < 2) continue;
    if (!qty || qty <= 0 || qty > 999) continue;
    // Ignore hardware diameter/dimension clauses when caught alone without product name
    if (/^(?:ท่อ|ข้องอ|สามทาง|ข้อต่อ)$/.test(query) && unitHint === "หุน") continue;

    items.push({
      rawPhrase: `${query} ${qty} ${unitHint}`.trim(),
      query,
      qty,
      unitHint,
    });
    if (items.length >= 12) break;
  }

  return items.length >= 2 ? items : [];
}

/**
 * Compute Decimal.js subtotal across all selected matched rows in a batch order plan.
 */
export function computeBatchPlanTotal(rows: readonly BatchOrderMatchRow[]): string {
  let sum = new Decimal(0);
  for (const r of rows) {
    if (!r.selected || !r.matched || r.qty <= 0) continue;
    const p = parseDecimal(r.unitPrice || r.matched.bestPrice);
    if (!p || p.lte(0)) continue;
    sum = sum.plus(p.times(r.qty));
  }
  return formatThaiBaht(sum.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
}

function pickUnitForHint(card: JavisProductCard, hint: string): { unitCode: string; unitPrice: string } {
  const normHint = hint.trim().toLowerCase().replace(/^แพค$/, "แพ็ค").replace(/^โล$/, "กิโล");
  const matchedOpt = card.unitOptions.find(
    (u) =>
      u.unitCode.toLowerCase() === normHint ||
      u.label.toLowerCase().includes(normHint) ||
      (normHint === "กิโล" && u.unitCode.includes("กิโล")),
  );
  if (matchedOpt) {
    return { unitCode: matchedOpt.unitCode, unitPrice: matchedOpt.price };
  }
  return {
    unitCode: card.unitCode,
    unitPrice: card.bestPrice ?? "0.00",
  };
}

/**
 * Match every parsed item in a multi-item spoken order against real catalog search results,
 * honoring active dietary rules (safe items sorted ahead of warned items).
 */
export function resolveBatchOrderWithSearch(
  rawMessage: string,
  searchFn: (query: string) => JavisProductCard[],
  dietaryTags: readonly DietaryTagId[] = [],
): BatchOrderPlan | null {
  const parsed = parseBatchOrderPhrases(rawMessage);
  if (parsed.length < 2) return null;

  const rows: BatchOrderMatchRow[] = parsed.map((req, idx) => {
    const candidates = searchFn(req.query).slice(0, 6);
    const ordered =
      dietaryTags.length > 0
        ? [...candidates].sort((a, b) => {
            const va = evaluateDietaryShield(a, dietaryTags).status === "warn" ? 1 : 0;
            const vb = evaluateDietaryShield(b, dietaryTags).status === "warn" ? 1 : 0;
            return va - vb;
          })
        : candidates;

    const top = ordered[0] ?? null;
    const pickedUnit = top ? pickUnitForHint(top, req.unitHint) : { unitCode: req.unitHint || "ชิ้น", unitPrice: "0.00" };
    const verdict = top && dietaryTags.length > 0 ? evaluateDietaryShield(top, dietaryTags) : null;

    return {
      id: `bo-${idx + 1}-${top?.slug ?? "none"}`,
      rawPhrase: req.rawPhrase,
      query: req.query,
      qty: req.qty,
      unitCode: pickedUnit.unitCode,
      unitPrice: pickedUnit.unitPrice,
      matched: top,
      alternatives: ordered.slice(0, 4),
      selected: Boolean(top),
      dietaryWarn: verdict?.status === "warn" ? verdict.warnLabels.join(", ") : undefined,
    };
  });

  const matchedCount = rows.filter((r) => Boolean(r.matched)).length;
  if (matchedCount === 0) return null;

  return {
    rawMessage,
    rows,
    matchedCount,
    totalFormatted: computeBatchPlanTotal(rows),
  };
}
