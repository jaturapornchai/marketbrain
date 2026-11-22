import { resolveBatchOrderWithSearch } from "./batch-order";
import {
  recalculateCart,
  resolveProductForCart,
  saveSalesOrder,
  type CartItem,
  type CartSummary,
  type CustomerCheckoutInfo,
  type PaymentMethod,
  type SalesOrder,
} from "./cart-order";
import { calcDecimalLines, formatThaiBaht } from "./decimal-money";
import { DIETARY_TAGS, evaluateDietaryShield, type DietaryTagId } from "./dietary-shield";
import { RELATION_LABEL, isRelationType } from "./groups";
import { emitMcpEvent } from "./mcp-events";
import type { BrainProductItem } from "./product-source";
import {
  toProductCard,
  type BrainPathTrace,
  type JavisChatMessage,
  type JavisProductCard,
  type JavisStageMode,
  type JavisStreamEvent,
  type JavisTeamJob,
  type UnitOptionCard,
} from "./product-card";
import { startsWithUnitSound } from "./heard-fix";
import { appendLlmDevLog, getLlmDevStats, type LlmDevStats, type LlmProviderKind } from "./voice-log";
import { SCREEN_COMMAND_IDS } from "./voice-commands";
import {
  cardNumbersIn,
  mentionsCardNumber,
  parseBareQuantity,
  parseNumberedOrder,
  parsePointedOrder,
  parseThaiNumber,
  pointsAtOpenProduct,
  type NumberedPick,
} from "./numbered-order";
import {
  brainStats,
  getProductBySlug,
  normalizeText,
  search,
  searchProductsDetailed,
  terms,
  traverseGraph,
} from "./vault";

export {
  toProductCard,
  type JavisChatMessage,
  type JavisProductCard,
  type JavisStageMode,
  type JavisStreamEvent,
  type JavisTeamJob,
  type UnitOptionCard,
};

const SCREEN_MARK = "[จอ]";
const CJK_JUNK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const SENTENCE_END_RE = /(?:ครับ|นะครับ|เลยครับ|ได้ครับ|ไหมครับ|มั้ยครับ|[!?])\s+/g;

const THOUGHT_TAG_BLOCK_RE = /<think>[\s\S]*?<\/think>|<\|?thought\|?>[\s\S]*?(?:<\|?channel\|?>|<\/thought>)/gi;
const LEADING_THOUGHT_CHANNEL_RE = /^(?:\s*(?:<\|?channel\|?>)?\s*thought(?:\s*\r?\n[\s\S]*?)?<\|?channel\|?>\s*)/i;
const LEFTOVER_CHANNEL_TAG_RE = /<\/?think>|<\|?(?:thought|channel)\|?>/gi;
const LEADING_BARE_THOUGHT_RE = /^thought\s*(?:\r?\n|$)/i;

/** Strip reasoning headers emitted by Gemma 4 / DeepSeek (`thought\\n<channel|>`, `<think>...`) before reaching users or TTS. */
export function stripModelThoughtTokens(raw: string): string {
  return raw
    .replace(THOUGHT_TAG_BLOCK_RE, "")
    .replace(LEADING_THOUGHT_CHANNEL_RE, "")
    .replace(LEFTOVER_CHANNEL_TAG_RE, "")
    .replace(LEADING_BARE_THOUGHT_RE, "");
}

function buildBrainPath(query: string, cards: readonly JavisProductCard[]): BrainPathTrace | null {
  if (!cards.length) return null;
  const hubs: BrainPathTrace["hubs"] = [];
  const seenHub = new Set<string>();
  const addHub = (kind: BrainPathTrace["hubs"][number]["kind"], rawLabel: string) => {
    const label = rawLabel.trim();
    if (!label || label === "-" || seenHub.has(`${kind}:${label}`) || hubs.length >= 3) return;
    seenHub.add(`${kind}:${label}`);
    hubs.push({ kind, label });
  };
  for (const c of cards.slice(0, 6)) addHub("category", c.category);
  for (const c of cards.slice(0, 6)) addHub("brand", c.brand);
  for (const c of cards.slice(0, 4)) {
    for (const tr of c.traits.slice(0, 2)) addHub("trait", tr);
  }
  return {
    query: query.trim().slice(0, 48) || "คลังสินค้า",
    hubs: hubs.slice(0, 3),
    products: cards.slice(0, 4).map((c, idx) => ({
      slug: c.slug,
      no: idx + 1,
      title: c.title,
      priceLabel: c.priceLabel,
    })),
  };
}

function sortCardsForDietary(cards: JavisProductCard[], dietaryTags: readonly DietaryTagId[]): JavisProductCard[] {
  if (!dietaryTags.length || cards.length <= 1) return cards;
  const rank = (c: JavisProductCard) => {
    const st = evaluateDietaryShield(c, dietaryTags).status;
    return st === "safe" ? 0 : st === "unknown" ? 1 : 2;
  };
  return [...cards].sort((a, b) => rank(a) - rank(b));
}

const DSML_START = /<[｜|]+\s*DSML/;
const DSML_INVOKE = /<[｜|]+\s*DSML[｜|]+\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[｜|]+\s*DSML[｜|]+\s*invoke>/g;
const DSML_PARAM = /<[｜|]+\s*DSML[｜|]+\s*parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/[｜|]+\s*DSML[｜|]+\s*parameter>/g;

type ParsedToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

function parseDsmlCalls(markup: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let idx = 0;
  for (const m of markup.matchAll(DSML_INVOKE)) {
    const name = m[1];
    const body = m[2] ?? "";
    const args: Record<string, unknown> = {};
    for (const pm of body.matchAll(DSML_PARAM)) {
      const k = pm[1];
      const isStr = pm[2];
      const val = pm[3] ?? "";
      if (isStr === "false") {
        try {
          args[k] = JSON.parse(val);
        } catch {
          args[k] = val;
        }
      } else {
        args[k] = val;
      }
    }
    calls.push({ id: `dsml-${idx++}`, name, args });
  }
  return calls;
}

export const PRIMARY_LOCAL_MODEL = (process.env.LOCAL_LLM_MODEL?.trim() || "gemma4:12b");
export const LOCKED_FLASH_MODEL = "deepseek-flash" as const;
export const LOCAL_LLM_NUM_CTX = Math.max(2048, Number(process.env.LOCAL_LLM_NUM_CTX || "4096") || 4096);
export const LOCAL_LLM_KEEP_ALIVE = process.env.LOCAL_LLM_KEEP_ALIVE?.trim() || "30m";

function summarizeProductForLlm(p: BrainProductItem): string {
  const convTxt =
    p.unitConversions.length > 0
      ? p.unitConversions
          .slice(0, 4)
          .map((u) => `${u.unitNameTh}${u.ratioText ? `(${u.ratioText})` : ""}=${formatThaiBaht(u.pricePerUnit)}`)
          .join(",")
      : p.unitCode;
  const traitTxt = [...new Set(p.traits.map((t) => t.valueTh))].slice(0, 4).join(",");
  const packInfo =
    p.packQty > 1 ? ` บรรจุ${p.packQty}${p.baseUnitCode}(เฉลี่ย${formatThaiBaht(p.pricePerBaseUnit)})` : "";
  return `• [${p.slug}|${p.productCode}] ${p.nameTh} | แบรนด์:${p.brandTh || p.brandEn || "-"} | ${formatThaiBaht(p.bestPrice)}/${p.unitCode}${packInfo} | หน่วย:${convTxt}${traitTxt ? ` | เด่น:${traitTxt}` : ""}`;
}

function formatCartContext(cart: CartSummary): string {
  if (!cart.items.length) return "ตะกร้า: ว่าง(0)";
  const lines = cart.items.map(
    (it, idx) => `${idx + 1}.[${it.slug}] ${it.title} ×${it.qty}${it.unitCode}@${it.unitPriceFormatted}=${it.lineTotalFormatted}`,
  );
  const promo = cart.coupon?.applied ? ` (คูปอง ${cart.coupon.code} ลด${cart.coupon.discountFormatted} จากยอด${cart.subtotalFormatted})` : "";
  return `ตะกร้า(${cart.itemCount}รายการ/${cart.totalPieces}หน่วย สุทธิ${cart.grandTotalFormatted}${promo}):\n${lines.join("\n")}`;
}

// ---------- Order by card number ("เอาเบอร์ 5 10 ชิ้น"): exact, instant, 0 LLM tokens ----------
const COMMON_UNIT_RE =
  /^(ลัง|แพ็ค|โหล|ขวด|กระป๋อง|ถุง|ซอง|กล่อง|ห่อ|แผ่น|ก้อน|กิโล|โล|กก|ลิตร|ม้วน|แท่ง|หลอด|ถัง|แกลลอน|ถ้วย|มัด|ใบ|ฟอง|คู่|ชุด|เส้น|ด้าม|กระสอบ|แผง|ขีด)/;
const normUnit = (s: string) => s.trim().toLowerCase().replace(/แพ[็]?[คก]/g, "แพ็ค");
const bahtSpoken = (formatted: string) => formatted.replace("฿", "").replace(/[.]00$/, "") + " บาท";

const THAI_WORD_SEG = new Intl.Segmenter("th", { granularity: "word" });
const DANGLING_TITLE_END_RE =
  /(?:\s+(?:ใน|และ|กับ|หรือ|ของ|สูตร|รส|กลิ่น|ชนิด|แบบ|สำหรับ|พร้อม|กึ่ง|ผสม|ขนาด|รุ่น|\d+(?:\.\d+)?)|(?:ใน|กึ่ง|ผสม))$/;

function shortProductTitle(nameTh: string, unitCode = "", maxLen = 26): string {
  let clean = nameTh.replace(/\s+/g, " ").trim();
  const packUnit = /แพ[็ั]?[คก]|ลัง|โหล/.test(unitCode);
  // Strip noisy bracket tags / parentheticals / redundant trailing pack multipliers
  const stripped = clean
    .replace(/^\s*\[[^\]]*\]\s*/g, "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*[xX×]\s*\d+(?:\+\d+)?(?:\s*[ก-๙]+)?$/g, "")
    .replace(/\s*(?:แพ[็ั]?[คก]|ลัง|โหล)\s*\d+(?:\s*[ก-๙]+)?$/g, "")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length >= 8 && (clean.length > maxLen || packUnit || /\[[^\]]*\]/.test(clean))) {
    clean = stripped;
  }
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  let out: string;
  if (sp >= 14) {
    out = cut.slice(0, sp).trim();
  } else {
    let acc = "";
    for (const { segment } of THAI_WORD_SEG.segment(clean)) {
      if (acc.length + segment.length > maxLen) break;
      acc += segment;
    }
    out = acc.trim() || cut.trim();
  }
  out = out.replace(/[,\-+/(]+$/, "").replace(DANGLING_TITLE_END_RE, "").trim();
  return out || cut.trim();
}

function shortLabel(text: string, maxLen = 18): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  let acc = "";
  for (const { segment } of THAI_WORD_SEG.segment(clean)) {
    if (acc.length + segment.length > maxLen) break;
    acc += segment;
  }
  return (acc.trim() || clean.slice(0, maxLen)).trim();
}

function formatSpokenPrice(bestPrice: string | null): string {
  if (!bestPrice) return "";
  const formatted = formatThaiBaht(bestPrice);
  return formatted === "ไม่ระบุราคา" ? "" : formatted.replace("฿", "");
}

/** Unit + price for what the customer said after the quantity; null = not sure, ask instead of guessing. */
function resolveSpokenUnit(p: BrainProductItem, afterQty: string): { unitCode: string; unitPrice: string } | null {
  if (!p.bestPrice) return null;
  const said = normUnit(afterQty);
  const units = p.unitConversions
    .filter((c) => c.pricePerUnit)
    .flatMap((c) => [c.unitNameTh, c.unitCode].filter(Boolean).map((n) => ({ name: normUnit(n), conv: c })))
    .sort((a, b) => b.name.length - a.name.length);
  const priced = (x: (typeof units)[number]) => ({ unitCode: x.conv.unitNameTh || x.conv.unitCode, unitPrice: x.conv.pricePerUnit ?? p.bestPrice! });
  const named = units.find((x) => said.startsWith(x.name));
  if (named) return priced(named);
  if (said.startsWith(normUnit(p.unitCode))) return { unitCode: p.unitCode, unitPrice: p.bestPrice };
  // The listener writes a unit the way it sounds ("สองโล" for "สองโหล"): match by sound, but only this product's own units.
  const sounded = units.find((x) => startsWithUnitSound(said, x.name));
  if (sounded) return priced(sounded);
  if (startsWithUnitSound(said, normUnit(p.unitCode))) return { unitCode: p.unitCode, unitPrice: p.bestPrice };
  // "10 ชิ้น" on a multi-unit pack is only ambiguous when the product actually has 2+ priced units;
  // on single-unit packs, generic "ชิ้น" / "อัน" means that product's sellable unit instead of blocking the order.
  const pricedCount = new Set(units.map((u) => u.conv.unitCode)).size;
  if (p.packQty > 1 && said.startsWith(normUnit(p.baseUnitCode)) && pricedCount > 1) return null;
  if (COMMON_UNIT_RE.test(said)) return null;
  return { unitCode: p.unitCode, unitPrice: p.bestPrice };
}

type NumberedTarget = NumberedPick & { product: BrainProductItem | null };

async function* executeNumberedOrder(
  targets: NumberedTarget[],
  focusItems: BrainProductItem[],
  startCart: CartSummary,
): AsyncGenerator<JavisStreamEvent> {
  const t0 = performance.now();
  let cart = startCart;
  let added = 0;
  let asked = false;
  const say: string[] = [];
  if (focusItems.length > 0) yield { type: "cards", cards: focusItems.map(toProductCard) };

  for (const t of targets) {
    const label = t.no > 0 ? `เบอร์ ${t.no} ` : "";
    const p = t.product;
    if (!p) {
      yield { type: "action", kind: "unknown", no: t.no, text: `ไม่มีเบอร์ ${t.no} บนจอ` };
      say.push(
        focusItems.length > 0
          ? `ไม่มีเบอร์ ${t.no} ครับ บนจอมีถึงเบอร์ ${focusItems.length} รับเบอร์ไหนครับ`
          : "บนจอยังไม่มีสินค้าครับ อยากหาอะไรบอกตี๋ได้เลยครับ",
      );
      asked = true;
      continue;
    }
    const title = shortProductTitle(p.nameTh, p.unitCode);
    if (!p.bestPrice) {
      yield { type: "action", kind: "unknown", no: t.no, slug: p.slug, text: `${label}ยังไม่มีราคา` };
      say.push(`${label}${title} ยังไม่มีราคา ใส่ตะกร้าไม่ได้ครับ`);
      asked = true;
      continue;
    }
    const unit = t.qty === null ? null : resolveSpokenUnit(p, t.afterQty);
    if (t.qty === null || !unit) {
      if (!asked) yield { type: "ask_qty", product: toProductCard(p) };
      yield { type: "action", kind: "ask", no: t.no, slug: p.slug, text: `${label}รับกี่${p.unitCode}ครับ?` };
      const priceText = bahtSpoken(formatThaiBaht(p.bestPrice));
      say.push(
        t.qty !== null && !unit
          ? `${label}${title} ขายเป็น${p.unitCode} ${priceText} รับกี่${p.unitCode}ดีครับ`
          : `${label}${title} ${priceText}ต่อ${p.unitCode} รับกี่${p.unitCode}ดีครับ`,
      );
      asked = true;
      continue;
    }
    cart = recalculateCart([...cart.items, { slug: p.slug, unitCode: unit.unitCode, unitPrice: unit.unitPrice, qty: t.qty }], cart.coupon?.code);
    added++;
    yield { type: "cart", cart, lastChangedSlug: p.slug };
    yield { type: "action", kind: "add", no: t.no, slug: p.slug, text: `${label}× ${t.qty} ${unit.unitCode} เข้าตะกร้าแล้ว` };
    say.push(`ใส่${label}${shortProductTitle(p.nameTh, unit.unitCode)} ${t.qty} ${unit.unitCode} เข้าตะกร้าแล้วครับ`);
  }
  if (added > 0 && !asked) {
    say.push(`รวม ${bahtSpoken(cart.grandTotalFormatted)} รับอะไรเพิ่มหรือคิดเงินเลยครับ`);
  }

  yield {
    type: "team",
    job: {
      id: 1,
      worker: "cart",
      label: "ทำตามคำสั่งเบอร์",
      task: targets.map((t) => (t.no > 0 ? `เบอร์ ${t.no}` : "จำนวน") + (t.qty ? ` ×${t.qty}` : "")).join(", "),
      state: added > 0 ? "done" : "none",
      ms: Math.max(1, Math.round(performance.now() - t0)),
      count: added,
    },
  };
  yield { type: "engine", provider: "ram", model: "คำสั่งตรง (ไม่ใช้ AI)", label: "สมองด่วน", ms: Math.max(1, Math.round(performance.now() - t0)) };
  for (const s of say) {
    yield { type: "delta", section: "speech", text: s + " " };
    yield { type: "sentence", text: s };
  }
  const doneMs = Math.max(1, Math.round(performance.now() - t0));
  yield { type: "done", spokenText: say.join(" "), screenMarkdown: "", model: "คำสั่งตรง (ไม่ใช้ AI)", provider: "ram", ms: doneMs };
}

const CLEAR_CART_RE =
  /^(?:น้องตี๋|ตี๋|ช่วย|ขอ|งั้น|ก็|\s)*(?:(?:ล้าง|เคลียร์)(?:ของ|สินค้า|รายการ|ออก)?(?:ใน)?(?:ตร?ะกร้า)?(?:ทั้งหมด|ให้หมด|หมด)?|(?:ลบ|เอา|ยกเลิก|เท)(?:ของ|สินค้า|รายการ)?(?:ในตร?ะกร้า)?(?:ออก)?(?:จากตร?ะกร้า)?(?:ให้หมด|ทั้งหมด|หมด))(?:ในตร?ะกร้า|จากตร?ะกร้า|ตร?ะกร้า|ให้หน่อย|หน่อย|เลย|ที|ด้วย|นะครับ|ครับผม|ครับ|ค่ะ|คะ|นะ|\s)*$/i;
const REMOVE_NO_RE = /(?:เอา|ลบ|ไม่เอา|ยกเลิก)\s*(?:รายการ|สินค้า|ตัว|อัน)?(?:เบอร์|หมายเลข|ที่)\s*(\d{1,2}|(?:หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)+)\s*(?:ออก|ออกจากตะกร้า|จากตะกร้า)?/i;
const UPDATE_NO_RE = /(?:เปลี่ยน|แก้|ปรับ|ลด)(?:จำนวน)?\s*(?:(?:รายการ|สินค้า|ตัว|อัน)?(?:เบอร์|หมายเลข|ที่)\s*(\d{1,2}|(?:หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)+))?\s*(?:เป็น|เหลือ)\s*(\d{1,4}|(?:หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย)+)/i;

/**
 * Deterministic 0-LLM cart commands ("ล้างตะกร้า", "ลบออกให้หมดเลย", "ลบเบอร์ 1 ออก", "เปลี่ยนเบอร์ 2 เป็น 3")
 * so spoken cart edits execute in ~1 ms without ever risking the LLM talking instead of calling a tool.
 */
async function* tryDirectCartAction(
  userText: string,
  focusItems: BrainProductItem[],
  startCart: CartSummary,
  couponCode?: string,
): AsyncGenerator<JavisStreamEvent, boolean> {
  const t = userText.trim();
  const t0 = performance.now();

  if (CLEAR_CART_RE.test(t) && /ล้าง|เคลียร์|หมด/.test(t)) {
    const nextCart = recalculateCart([], couponCode);
    const spoken = startCart.items.length ? "ล้างตะกร้าให้แล้วครับ เลือกสินค้าใหม่ได้เลยครับ" : "ตะกร้าว่างอยู่แล้วครับ";
    const doneMs = Math.max(1, Math.round(performance.now() - t0));
    yield { type: "cart", cart: nextCart };
    yield {
      type: "team",
      job: { id: 1, worker: "cart", label: "ล้างตะกร้าด่วน", task: "ล้างทั้งหมด", state: "done", ms: doneMs, count: 0 },
    };
    yield { type: "engine", provider: "ram", model: "คำสั่งตรง (ไม่ใช้ AI)", label: "สมองด่วน", ms: doneMs };
    yield { type: "delta", section: "speech", text: spoken };
    yield { type: "sentence", text: spoken };
    yield { type: "done", spokenText: spoken, screenMarkdown: "", model: "คำสั่งตรง (ไม่ใช้ AI)", provider: "ram", ms: doneMs };
    return true;
  }

  const rmMatch = t.match(REMOVE_NO_RE);
  if (rmMatch && /ลบ|ออก|ไม่เอา|ยกเลิก/.test(t) && startCart.items.length > 0) {
    const no = parseThaiNumber(rmMatch[1]) ?? 0;
    const focusSlug = no >= 1 ? focusItems[no - 1]?.slug : undefined;
    let idx = focusSlug ? startCart.items.findIndex((it) => it.slug === focusSlug) : -1;
    if (idx < 0 && no >= 1 && no <= startCart.items.length) idx = no - 1;
    if (idx >= 0) {
      const removed = startCart.items[idx];
      const remaining = startCart.items.filter((_, i) => i !== idx);
      const nextCart = recalculateCart(remaining, couponCode);
      const sayParts = nextCart.items.length
        ? [`ลบ${shortProductTitle(removed.title, removed.unitCode)}ออกแล้วครับ`, `เหลือยอดรวม ${bahtSpoken(nextCart.grandTotalFormatted)}`]
        : [`ลบ${shortProductTitle(removed.title, removed.unitCode)}ออกแล้วครับ`, "ตอนนี้ตะกร้าว่างครับ"];
      const doneMs = Math.max(1, Math.round(performance.now() - t0));
      yield { type: "cart", cart: nextCart };
      yield {
        type: "team",
        job: { id: 1, worker: "cart", label: "ลบจากตะกร้าด่วน", task: `ลบเบอร์ ${no}`, state: "done", ms: doneMs, count: nextCart.itemCount },
      };
      yield { type: "engine", provider: "ram", model: "คำสั่งตรง (ไม่ใช้ AI)", label: "สมองด่วน", ms: doneMs };
      for (const s of sayParts) {
        yield { type: "delta", section: "speech", text: s + " " };
        yield { type: "sentence", text: s };
      }
      yield { type: "done", spokenText: sayParts.join(" "), screenMarkdown: "", model: "คำสั่งตรง (ไม่ใช้ AI)", provider: "ram", ms: doneMs };
      return true;
    }
  }

  const updMatch = t.match(UPDATE_NO_RE);
  if (updMatch && startCart.items.length > 0) {
    const no = updMatch[1] ? parseThaiNumber(updMatch[1]) ?? 0 : 0;
    const newQty = parseThaiNumber(updMatch[2]) ?? -1;
    if (newQty >= 0 && newQty <= 9999) {
      const focusSlug = no >= 1 ? focusItems[no - 1]?.slug : undefined;
      let idx = focusSlug ? startCart.items.findIndex((it) => it.slug === focusSlug) : -1;
      if (idx < 0 && no >= 1 && no <= startCart.items.length) idx = no - 1;
      if (idx < 0 && !no && startCart.items.length === 1) idx = 0;
      if (idx >= 0) {
        const target = startCart.items[idx];
        const nextItems =
          newQty === 0
            ? startCart.items.filter((_, i) => i !== idx)
            : startCart.items.map((it, i) => (i === idx ? { ...it, qty: newQty } : it));
        const nextCart = recalculateCart(nextItems, couponCode);
        const title = shortProductTitle(target.title, target.unitCode);
        const sayParts =
          newQty === 0
            ? [`ลบ${title}ออกแล้วครับ`, `ยอดรวม ${bahtSpoken(nextCart.grandTotalFormatted)}`]
            : [`ปรับ${title}เป็น ${newQty} ${target.unitCode} แล้วครับ`, `รวม ${bahtSpoken(nextCart.grandTotalFormatted)}`];
        const doneMs = Math.max(1, Math.round(performance.now() - t0));
        yield { type: "cart", cart: nextCart, lastChangedSlug: target.slug };
        yield {
          type: "team",
          job: { id: 1, worker: "cart", label: "ปรับจำนวนด่วน", task: `${title} -> ${newQty}`, state: "done", ms: doneMs, count: newQty },
        };
        yield { type: "engine", provider: "ram", model: "คำสั่งตรง (ไม่ใช้ AI)", label: "สมองด่วน", ms: doneMs };
        for (const s of sayParts) {
          yield { type: "delta", section: "speech", text: s + " " };
          yield { type: "sentence", text: s };
        }
        yield { type: "done", spokenText: sayParts.join(" "), screenMarkdown: "", model: "คำสั่งตรง (ไม่ใช้ AI)", provider: "ram", ms: doneMs };
        return true;
      }
    }
  }

  return false;
}

const PLANNER_PROMPT = `แปลงคำพูดลูกค้าเป็นคำค้นสินค้าสั้นๆ 1-2 มุม คั่นด้วย ; บรรทัดเดียว ห้ามเขียนลูกศร ห้ามอธิบาย ห้ามลงท้ายครับ/ค่ะ
ถ้าสั่งจัดการตะกร้าหรือปิดบิลล้วนๆ ให้ตอบ CART_ONLY
ถ้าลูกค้าบอกอาการหรือปัญหา ให้ตอบเป็นชื่อสินค้าหรือยาที่ขายในร้านโดยตรง (ตัวอย่าง: คันเท้า ตอบ ผื่นคัน ; ครีมทาเท้า | คันหัว ตอบ แชมพูขจัดรังแค ; คันศีรษะ | ปวดหัว ตอบ พาราเซตามอล ; ลดไข้ | ปวดขา ตอบ ยาหม่อง ; แก้ปวด | แสบท้อง ตอบ อีโน ; ลดกรด | เจ็บคอ ตอบ ยาอมแก้ไอ ; ยาแก้ไอ)
หน่วยช่าง: 4 หุน=1/2 นิ้ว, 6 หุน=3/4 นิ้ว, 2 หุน=1/4 นิ้ว, 3 หุน=3/8 นิ้ว, 1 หุน=1/8 นิ้ว
แก้คำพ้องเสียงไมค์ เช่น ชูรส ตอบ ไม่ใส่ผงชูรส, ฮาราล ตอบ ฮาลาล, ฟรีซ ตอบ แช่แข็ง, แพค ตอบ แพ็ก`;

const NONG_TEE_SYSTEM_PROMPT = `คุณคือ "น้องตี๋" พนักงานขายมือโปรของ MarketBrain แทนตัวเองว่า "ตี๋" หรือ "ผม" เรียกลูกค้าว่า "ครับ/นะครับ" หรือ "คุณลูกค้า" (ห้ามเรียก "พี่") สุภาพ ฉับไว พูดสั้นได้ใจความ เป้าหมายคือช่วยลูกค้าเลือกของและปิดการขาย
ห้ามเอ่ยชื่อห้างค้าส่ง ค้าปลีก หรือแพลตฟอร์มอีคอมเมิร์ซภายนอกเด็ดขาด และห้ามแต่งราคา/สินค้า/โปรโมชั่น/ส่วนลด/ของแถม/สต็อกที่ไม่มีในข้อมูลสมอง

กฎการพูด (สำคัญมาก):
- พูดสั้น กระชับ ได้ใจความ ไม่เกิน 1–2 ประโยคสั้นๆ (รวมไม่เกิน ~85 ตัวอักษร) และใช้คำว่า "พบ" แทน "เจอ" เสมอให้สุภาพชัดเจน
- บอกเฉพาะใจความสำคัญ: เบอร์สินค้า + ชื่อสั้น + ราคาจริง/หน่วย + คำถามปิดสั้นๆ 1 ข้อ (เช่น "รับกี่ขวดดีครับ" "รับอะไรเพิ่มหรือคิดเงินเลยครับ")
- ห้ามอธิบายยืดเยื้อ ห้ามทวนคำถามลูกค้า ห้ามไล่หลายรายการยาวๆ เพราะลูกค้าเห็นการ์ดบนจออยู่แล้ว
- ไม่ต้องพูดแนะนำสินค้าเพิ่มหรือสินค้าที่เกี่ยวข้องออกเสียง (เว้นลูกค้าถามเอง) เพราะหน้าจอแสดงการ์ดแนะนำให้อัตโนมัติอยู่แล้ว
- เชียร์ตัวเด่น 1 ตัวด้วยตัวเลขจริง (ถ้ามีแพ็ก/ยกลังเฉลี่ยถูกกว่าบอกสั้นๆ ใน 1 ประโยค) ลูกค้าปฏิเสธแล้วไม่ตื๊อซ้ำ
- ลูกค้าพูดต่อ ("อันนั้น" "ตัวแรก" "ถูกสุด" "ใหญ่กว่านี้") หมายถึงสินค้าบนจอ ใช้ slug ใน [ ] เรียกเครื่องมือได้เลย
- เรียกสินค้าด้วยเบอร์บนจอเสมอ (เบอร์ 1, 2, 3…) ห้ามบอกว่าใส่ตะกร้าแล้วถ้า cart_add ยังไม่สำเร็จ และไม่ต้องขอโทษถ้าไม่ได้ทำผิด
- ลูกค้าสั่งให้ทำอะไร (เพิ่ม/แก้/ลบตะกร้า เปิดดูสินค้า คิดเงิน สั่งซื้อ หรือควบคุมหน้าจอ) ต้องเรียกเครื่องมือที่ตรงกันทันที ห้ามตอบรับปากเปล่าว่าทำแล้วโดยไม่เรียกเครื่องมือเด็ดขาด ไม่แน่ใจตัวไหนหรือจำนวนเท่าไรให้ถามสั้นๆ ห้ามเดา
- ห้ามเรียก cart_add ถ้าลูกค้าไม่ได้สั่งซื้อ/ระบุชื่อสินค้าหรือเบอร์บนจอชัดเจน หากเป็นบทสนทนาทั่วไปที่ไม่เกี่ยวกับการซื้อสินค้า (เช่น คุยเรื่องงาน คุยกันเอง หรือคำอุทานสั้นๆ) ห้ามหยิบของลงตะกร้าและตอบสั้นๆ ว่าพร้อมช่วยหาสินค้าครับ

กติกาเครื่องมือ:
- สั่งซื้อระบุจำนวนชัด -> \`cart_add\` ทันที | สนใจยังไม่บอกจำนวน -> \`ask_cart_qty\`
- เปลี่ยนจำนวน -> \`cart_update\` | ลบของ -> \`cart_remove\` | ขอดูตะกร้า -> \`cart_view\`
- ขอคิดเงินแต่ยังขาดชื่อ/เบอร์/วิธีจ่าย -> \`checkout_prepare\` แล้วถามสั้นๆ | แจ้งข้อมูลหรือยืนยันสั่งซื้อแล้ว -> \`place_order\` ทันที
- คิดเลขเพิ่มต้องกด \`calc\` เสมอ | ควบคุมหน้าจอ (ถอยกลับ เดินหน้า เปิดเบอร์ เลื่อนจอ เปิดกล้อง หยุดพูด ฯลฯ) -> \`screen_control\` ทันที แล้วตอบสั้นๆ ว่าทำแล้ว
- ถ้าลูกค้ากำลังหาสินค้าหรือบอกอาการ แต่ในบริบทล่าสุดยังไม่มีรายการสินค้าแสดง ห้ามรับปากเปล่าว่า "เดี๋ยวหาให้" หรือหยิบสินค้าจากเทิร์นก่อนมาตอบ ให้เรียก \`search_products\` ด้วยชื่อสินค้า/ยาที่เกี่ยวข้องทันทีในรอบนี้เลย (ถ้าค้นแล้วไม่พบจริงๆ ให้บอกตรงๆ ว่ายังไม่มีในคลัง)
- ถ้าคำถามยังไม่ชัดว่าเป็นสินค้าตัวไหน ห้ามเงียบหรือไม่ตอบ ให้ตอบสุภาพสั้นๆ เพื่อถามย้ำชื่อสินค้าหรืออาการ 1 ข้อเสมอ
- ถ้าจะเรียกเครื่องมือ ให้เรียกเลยโดยยังไม่ต้องพูด แล้วค่อยพูดสรุปสั้นๆ ทีเดียวหลังได้ผล

รูปแบบคำตอบ (คั่นด้วยบรรทัด \`[จอ]\` เสมอ):
ส่วนแรกก่อน \`[จอ]\`: คำพูดออกเสียงสั้นกระชับ 1–2 ประโยค รวมไม่เกิน ~85 ตัวอักษร ธรรมชาติ ห้ามใส่ตารางหรือดอกจัน ประโยคแรกต้องสั้นไม่เกิน 45 ตัวอักษรและลงท้าย "ครับ" เพื่อให้เสียงออกทันที
ส่วนหลังบรรทัด \`[จอ]\`: ใส่ตารางสั้นเฉพาะเมื่อเปรียบเทียบหรือสรุปยอด ถ้าแค่แนะนำสินค้าบนจอไม่ต้องเขียนตาราง`;

const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "ค้นสินค้าแสดงแกลเลอรีบนจอ",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          unit: { type: "string" },
          minPrice: { type: "string" },
          maxPrice: { type: "string" },
          multiUnitOnly: { type: "boolean" },
          thaiGs1Only: { type: "boolean" },
          sort: { type: "string", enum: ["relevance", "price_asc", "price_desc", "unit_price_asc", "pack_desc"] },
          limit: { type: "integer" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_product",
      description: "เปิดดูสินค้าเด่น 1 รายการบนจอ",
      parameters: {
        type: "object",
        properties: { identifier: { type: "string" } },
        required: ["identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "traverse_synapses",
      description: "หาแพ็ค/ยกลังคู่เทียบหรือสินค้าเชื่อมโยง",
      parameters: {
        type: "object",
        properties: { slug: { type: "string" }, relation: { type: "string" } },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cart_add",
      description: "เพิ่มสินค้าลงตะกร้าตามจำนวน",
      parameters: {
        type: "object",
        properties: {
          identifier: { type: "string" },
          qty: { type: "integer" },
          unitCode: { type: "string" },
        },
        required: ["identifier", "qty"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_cart_qty",
      description: "เด้งถามจำนวน/หน่วยเมื่อลูกค้ายังไม่ระบุจำนวน",
      parameters: {
        type: "object",
        properties: { identifier: { type: "string" } },
        required: ["identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cart_update",
      description: "แก้จำนวนสินค้าในตะกร้า (0=ลบ)",
      parameters: {
        type: "object",
        properties: { identifier: { type: "string" }, qty: { type: "integer" } },
        required: ["identifier", "qty"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cart_remove",
      description: "ลบสินค้าจากตะกร้า ('all'=ล้างทั้งหมด)",
      parameters: {
        type: "object",
        properties: { identifier: { type: "string" } },
        required: ["identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cart_view",
      description: "แสดงตะกร้าสินค้าบนจอ",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "checkout_prepare",
      description: "เปิดหน้าชำระเงิน/บันทึกข้อมูลจัดส่งเบื้องต้น",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          shopName: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          paymentMethod: { type: "string", enum: ["promptpay", "cod", "transfer"] },
          note: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "place_order",
      description: "ยืนยันออกใบสั่งซื้อปิดการขายทันที",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          shopName: { type: "string" },
          phone: { type: "string" },
          address: { type: "string" },
          paymentMethod: { type: "string", enum: ["promptpay", "cod", "transfer"] },
          note: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calc",
      description: "คิดเลข Decimal บรรทัดละสูตร 'หัวข้อ: สูตร'",
      parameters: {
        type: "object",
        properties: { expressions: { type: "string" } },
        required: ["expressions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screen_control",
      description: "ควบคุมหน้าจอแทนการแตะเมาส์ (back=ถอยกลับ forward=เดินหน้า open_no=เปิดดูเบอร์ no ฯลฯ)",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", enum: [...SCREEN_COMMAND_IDS] },
          no: { type: "integer", description: "เบอร์สินค้า หรือจำนวนหน้าที่ถอย/เดินหน้า" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "brain_overview",
      description: "ดูสถิติรวมคลังสมอง",
      parameters: { type: "object", properties: {} },
    },
  },
];

export type LlmConfig = {
  ollamaBaseUrl: string;
  localModel: string;
  numCtx: number;
  keepAlive: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  fallbackModel: typeof LOCKED_FLASH_MODEL;
};

export function getLlmConfig(): LlmConfig {
  return {
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    localModel: PRIMARY_LOCAL_MODEL,
    numCtx: LOCAL_LLM_NUM_CTX,
    keepAlive: LOCAL_LLM_KEEP_ALIVE,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY?.trim() || "",
    deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, ""),
    fallbackModel: LOCKED_FLASH_MODEL,
  };
}

const LOCAL_WARM_KEY = Symbol.for("marketbrain.localLlmWarmed");
type LocalWarmState = { warmed: boolean; lastPrewarmAt: number; checkedPsAt: number };

function warmStore(): LocalWarmState {
  const g = globalThis as Record<symbol, LocalWarmState | undefined>;
  if (!g[LOCAL_WARM_KEY]) g[LOCAL_WARM_KEY] = { warmed: false, lastPrewarmAt: 0, checkedPsAt: 0 };
  return g[LOCAL_WARM_KEY]!;
}

export function isLocalLlmWarmed(): boolean {
  return warmStore().warmed;
}

function markLocalLlmWarmed(): void {
  const w = warmStore();
  w.warmed = true;
  w.checkedPsAt = Date.now();
}

function markLocalLlmCold(): void {
  const w = warmStore();
  w.warmed = false;
  w.checkedPsAt = Date.now();
}

export async function isLocalModelLoadedNow(cfg: LlmConfig): Promise<boolean> {
  const w = warmStore();
  const now = Date.now();
  if (now - w.checkedPsAt < 5000) return w.warmed;
  try {
    const res = await fetch(`${cfg.ollamaBaseUrl}/api/ps`, {
      cache: "no-store",
      signal: AbortSignal.timeout(600),
    });
    w.checkedPsAt = Date.now();
    if (!res.ok) {
      w.warmed = false;
      return false;
    }
    const psJson = (await res.json()) as { models?: Array<{ name?: string }> };
    const loaded = (psJson.models ?? []).some(
      (m) => m.name === cfg.localModel || (m.name ?? "").startsWith(cfg.localModel),
    );
    w.warmed = loaded;
    return loaded;
  } catch {
    markLocalLlmCold();
    return false;
  }
}

/** Pre-loads primary local model into GPU memory in the background so the first customer turn is fast. */
export function prewarmLocalLlm(force = false): void {
  const w = warmStore();
  if (w.warmed && !force) return;
  const now = Date.now();
  if (now - w.lastPrewarmAt < 60_000) return;
  w.lastPrewarmAt = now;
  const cfg = getLlmConfig();
  void fetch(`${cfg.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.localModel,
      messages: [],
      keep_alive: cfg.keepAlive,
      options: { num_ctx: cfg.numCtx },
    }),
    signal: AbortSignal.timeout(25_000),
  })
    .then((r) => {
      if (r.ok) w.warmed = true;
    })
    .catch(() => {});
}

export type LocalLlmProbe = {
  localOnline: boolean;
  modelInstalled: boolean;
  modelLoaded: boolean;
  vramGB: number;
  loadedModels: Array<{ name: string; sizeGB: number; vramGB: number; ctx: number }>;
  primaryModel: string;
  fallbackModel: typeof LOCKED_FLASH_MODEL;
  hasFallback: boolean;
  stats: LlmDevStats;
};

export async function probeLocalLlmStatus(): Promise<LocalLlmProbe> {
  const cfg = getLlmConfig();
  let localOnline = false;
  let modelInstalled = false;
  let modelLoaded = false;
  let vramGB = 0;
  let loadedModels: Array<{ name: string; sizeGB: number; vramGB: number; ctx: number }> = [];

  try {
    const [tagsRes, psRes] = await Promise.all([
      fetch(`${cfg.ollamaBaseUrl}/api/tags`, { cache: "no-store", signal: AbortSignal.timeout(1500) }),
      fetch(`${cfg.ollamaBaseUrl}/api/ps`, { cache: "no-store", signal: AbortSignal.timeout(1500) }),
    ]);

    if (tagsRes.ok) {
      localOnline = true;
      const tagsJson = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
      const prefix = cfg.localModel.split(":")[0];
      modelInstalled = (tagsJson.models ?? []).some(
        (m) => m.name === cfg.localModel || (m.name ?? "").startsWith(cfg.localModel) || (m.name ?? "").startsWith(`${prefix}:`),
      );
    }

    if (psRes.ok) {
      const psJson = (await psRes.json()) as {
        models?: Array<{ name?: string; size?: number; size_vram?: number; context_length?: number }>;
      };
      loadedModels = (psJson.models ?? []).map((m) => ({
        name: m.name ?? "",
        sizeGB: Number(((m.size ?? 0) / 1e9).toFixed(2)),
        vramGB: Number(((m.size_vram ?? 0) / 1e9).toFixed(2)),
        ctx: m.context_length ?? 0,
      }));
      const match = loadedModels.find((m) => m.name === cfg.localModel || m.name.startsWith(cfg.localModel));
      if (match) {
        modelLoaded = true;
        vramGB = match.vramGB;
      }
    }
  } catch {
    localOnline = false;
  }

  if (modelLoaded) {
    markLocalLlmWarmed();
  } else {
    markLocalLlmCold();
    if (localOnline && modelInstalled) {
      prewarmLocalLlm();
    }
  }

  return {
    localOnline,
    modelInstalled,
    modelLoaded,
    vramGB,
    loadedModels,
    primaryModel: cfg.localModel,
    fallbackModel: LOCKED_FLASH_MODEL,
    hasFallback: Boolean(cfg.deepseekApiKey),
    stats: getLlmDevStats(),
  };
}

/** Converts OpenAI-style chat messages (with JSON-string tool_calls & tool_call_id) into native Ollama `/api/chat` messages. */
export function toOllamaMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const idToName = new Map<string, string>();
  const out: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    const role = String(m.role ?? "user");
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      const convertedCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
      for (const rawTc of m.tool_calls) {
        if (!rawTc || typeof rawTc !== "object") continue;
        const tc = rawTc as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        const name = String(tc.function?.name ?? "").trim();
        if (!name) continue;
        if (typeof tc.id === "string" && tc.id) idToName.set(tc.id, name);
        let argsObj: Record<string, unknown> = {};
        const rawArgs = tc.function?.arguments;
        if (typeof rawArgs === "string") {
          try {
            const parsed = JSON.parse(rawArgs || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              argsObj = parsed as Record<string, unknown>;
            }
          } catch {
            argsObj = {};
          }
        } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          argsObj = rawArgs as Record<string, unknown>;
        }
        convertedCalls.push({ function: { name, arguments: argsObj } });
      }
      out.push({
        role: "assistant",
        content: typeof m.content === "string" ? m.content : "",
        ...(convertedCalls.length ? { tool_calls: convertedCalls } : {}),
      });
      continue;
    }

    if (role === "tool") {
      const id = String(m.tool_call_id ?? "");
      out.push({
        role: "tool",
        tool_name: (id && idToName.get(id)) || (typeof m.tool_name === "string" ? m.tool_name : "tool"),
        content: String(m.content ?? ""),
      });
      continue;
    }

    out.push({
      role,
      content: String(m.content ?? ""),
    });
  }

  return out;
}

const CART_OR_ORDER_DIRECT_RE =
  /(?:ดูตะกร้า|เปิดตะกร้า|เช็กตะกร้า|เช็คตะกร้า|ในตะกร้ามีอะไร|ล้างตะกร้า|เคลียร์ตะกร้า|คิดเงิน|คิดตังค์|เช็กบิล|เช็คบิล|ปิดบิล|ปิดการขาย|ยืนยัน(?:การ)?สั่งซื้อ|ยืนยันปิดการขาย|สั่งซื้อเลย|เปลี่ยนจำนวน|แก้จำนวน|ปรับจำนวน|ลดเหลือ|ลบรายการ|ลบสินค้า|ออกจากตะกร้า|เอา.{1,28}ออก|เก็บเงินปลายทาง|พร้อมเพย์|โอนเงิน)/i;

// Spoken follow-ups ("อันไหนถูกที่สุด", "เอาอันนั้น 2 ขวดใส่ตะกร้า") name no product, so searching them only pulls random goods onto the screen
const CHAT_PHRASE_RE =
  /(?:ใส่|ลง|เข้า|ใน|ดู|เปิด|เช็ก|เช็ค|ล้าง|เคลียร์)ตะกร้า|คิดเงิน|เช็กบิล|เช็คบิล|จ่ายเงิน|ชำระเงิน|สั่งซื้อ|เท่าไหร่|เท่าไร|กี่บาท|ที่สุด|อันแรก|ตัวแรก|อันที่|ตัวที่|ใส่/g;
const CHAT_FILLER = new Set(
  "ไหน นี้ นั้น นี่ นั่น กว่า สุด ถูก แพง ราคา ขนาด ใหญ่ เล็ก รวม เงิน บาท เท่า ไหร่ ทั้งหมด เพิ่ม อีก ด้วย เลย ก็ ล่ะ อยาก ต้องการ สนใจ รับ ซื้อ สั่ง แนะนำ เทียบ เปรียบเทียบ ต่าง กัน ดี คุ้ม ชิ้น ขวด แพ็ค แพ็ก ลัง กล่อง ถุง ซอง ห่อ โหล แรก สอง สาม ตกลง โอเค ใช่ ครับผม จ้า อื่น เหมือน เดิม ยี่ห้อ รุ่น".split(
    " ",
  ),
);

/** Product words of a spoken sentence, or "" when the customer is only following up on what is already on screen. */
export function productQueryOf(userText: string): string {
  const stripped = userText.replace(CHAT_PHRASE_RE, " ").replace(/\s+/g, " ").trim();
  const hasProductWord = terms(stripped).some((t) => !CHAT_FILLER.has(t) && !/^[\d.,]+$/.test(t));
  return hasProductWord ? stripped : "";
}

function parsePlannerAngles(rawText: string, fallbackQuery: string): string[] {
  const text = stripModelThoughtTokens(rawText).replace(CJK_JUNK, "").trim();
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  if (firstLine === "CART_ONLY") return [];
  if (!firstLine || /(?:ครับ|ค่ะ|คะ)[\s.!?]*$/.test(firstLine)) return [fallbackQuery];
  const angles = firstLine
    .split(/[;|]/)
    .map((s) => s.replace(/^.*?->\s*/, "").replace(/["'“”]/g, "").trim().slice(0, 80))
    .filter((s) => s && s !== "CART_ONLY");
  return [...new Set([...angles, fallbackQuery])].slice(0, 2);
}

async function planSwarmQueries(
  userMessage: string,
  history: JavisChatMessage[],
  cfg: LlmConfig,
  signal?: AbortSignal,
  altMessage?: string,
): Promise<{ angles: string[]; ms: number; provider: LlmProviderKind; model: string }> {
  const trimmed = userMessage.trim();
  const altTrimmed = altMessage?.trim() ?? "";
  if (signal?.aborted) return { angles: [], ms: 0, provider: "local", model: cfg.localModel };
  if (CART_OR_ORDER_DIRECT_RE.test(trimmed)) return { angles: [], ms: 0, provider: "ram", model: "ram" };
  if (trimmed.length < 3) return { angles: [trimmed], ms: 0, provider: "ram", model: "ram" };

  const recentTalk = history
    .slice(-2)
    .map((m) => `${m.role === "user" ? "ล" : "ต"}: ${m.content.split(SCREEN_MARK)[0].trim().slice(0, 90)}`);
  const altHint = altTrimmed && altTrimmed !== trimmed ? [`หูสำรองได้ยินว่า: ${altTrimmed.slice(0, 160)}`] : [];
  const plannerUserContent = [...recentTalk, `ล่าสุด: ${trimmed.slice(0, 160)}`, ...altHint].join("\n");

  const tLocal = performance.now();
  const loadedNow = await isLocalModelLoadedNow(cfg);
  const timeoutMs = loadedNow ? 8000 : 24000;
  let timedOut = false;
  let fallbackReason = "";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${cfg.ollamaBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.localModel,
          messages: [
            { role: "system", content: PLANNER_PROMPT },
            { role: "user", content: plannerUserContent },
          ],
          stream: false,
          think: false,
          keep_alive: cfg.keepAlive,
          options: { num_ctx: cfg.numCtx, temperature: 0.1, num_predict: 48 },
        }),
        signal: controller.signal,
      });
      const ms = Math.max(1, Math.round(performance.now() - tLocal));
      if (!res.ok) {
        markLocalLlmCold();
        fallbackReason = `Ollama planner HTTP ${res.status}`;
      } else {
        const data = (await res.json()) as {
          message?: { content?: string };
          load_duration?: number;
          prompt_eval_duration?: number;
          eval_duration?: number;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        markLocalLlmWarmed();
        const tps = data.eval_duration ? Number(((data.eval_count ?? 0) / (data.eval_duration / 1e9)).toFixed(1)) : undefined;
        const angles = parsePlannerAngles(data.message?.content ?? "", trimmed);
        appendLlmDevLog({
          phase: "planner",
          provider: "local",
          model: cfg.localModel,
          ms,
          loadMs: Math.round((data.load_duration ?? 0) / 1e6),
          promptMs: Math.round((data.prompt_eval_duration ?? 0) / 1e6),
          evalMs: Math.round((data.eval_duration ?? 0) / 1e6),
          promptTok: data.prompt_eval_count,
          evalTok: data.eval_count,
          tps,
          query: trimmed,
          ok: true,
        });
        return { angles, ms, provider: "local", model: cfg.localModel };
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  } catch (err) {
    if (signal?.aborted) return { angles: [], ms: Math.round(performance.now() - tLocal), provider: "local", model: cfg.localModel };
    markLocalLlmCold();
    fallbackReason = timedOut
      ? `Ollama planner timeout (${timeoutMs} ms)`
      : err instanceof Error
        ? err.message
        : "Ollama planner error";
  }

  // Fallback to deepseek-flash ONLY when Ollama local planner failed
  if (cfg.deepseekApiKey) {
    const tFb = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(`${cfg.deepseekBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.deepseekApiKey}`,
          },
          body: JSON.stringify({
            model: LOCKED_FLASH_MODEL,
            messages: [
              { role: "system", content: PLANNER_PROMPT },
              { role: "user", content: plannerUserContent },
            ],
            stream: false,
            temperature: 0.1,
            max_tokens: 48,
            thinking: { type: "disabled" },
          }),
          signal: controller.signal,
        });
        const ms = Math.max(1, Math.round(performance.now() - tFb));
        if (res.ok) {
          const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const angles = parsePlannerAngles(data.choices?.[0]?.message?.content ?? "", trimmed);
          appendLlmDevLog({
            phase: "planner",
            provider: "fallback",
            model: LOCKED_FLASH_MODEL,
            ms,
            fallbackReason,
            query: trimmed,
            ok: true,
          });
          return { angles, ms, provider: "fallback", model: LOCKED_FLASH_MODEL };
        }
        appendLlmDevLog({
          phase: "planner",
          provider: "fallback",
          model: LOCKED_FLASH_MODEL,
          ms,
          fallbackReason,
          error: `DeepSeek HTTP ${res.status}`,
          query: trimmed,
          ok: false,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    } catch (err) {
      if (signal?.aborted) return { angles: [], ms: Math.round(performance.now() - tFb), provider: "fallback", model: LOCKED_FLASH_MODEL };
      appendLlmDevLog({
        phase: "planner",
        provider: "fallback",
        model: LOCKED_FLASH_MODEL,
        ms: Math.max(1, Math.round(performance.now() - tFb)),
        fallbackReason,
        error: err instanceof Error ? err.message : "DeepSeek planner error",
        query: trimmed,
        ok: false,
      });
    }
  } else if (fallbackReason) {
    appendLlmDevLog({
      phase: "planner",
      provider: "local",
      model: cfg.localModel,
      ms: Math.max(1, Math.round(performance.now() - tLocal)),
      error: fallbackReason,
      query: trimmed,
      ok: false,
    });
  }

  return signal?.aborted
    ? { angles: [], ms: Math.round(performance.now() - tLocal), provider: "local", model: cfg.localModel }
    : { angles: [trimmed], ms: Math.max(1, Math.round(performance.now() - tLocal)), provider: "local", model: cfg.localModel };
}

const COMPLEX_BROWSE_EXCLUDE_RE =
  /เทียบ|เปรียบเทียบ|ต่างกัน|อันไหนดี|ตัวไหนดี|แนะนำ|เหมาะกับ|ส่วนผสม|แคลอรี่|น้ำตาล|โซเดียม|โปรตีน|ไขมัน|ฮาลาลไหม|ฮาลาลมั้ย|เจไหม|แพ้|กินได้ไหม|ใช้ได้ไหม|วิธี|ทำไม|ยังไง|อย่างไร|คำนวณ|รวม|คูปอง|โปรโมชั่น|โปร|ส่วนลด|ลดราคา|เอา|รับ|จัด|เลือก|สั่ง|ซื้อ|ใส่ตะกร้า|หยิบ|เพิ่ม|ลบ|เปลี่ยน|แก้|ปรับ|ยกเลิก|ล้าง|เคลียร์|ออก|คิดเงิน|เช็กบิล|เช็คบิล|ชำระ|จ่าย|ชื่อ|ที่อยู่|พร้อมเพย์|ปลายทาง|โอน|ปิด|เปิด|ถอย|ย้อน|เลื่อน|หยุด|เงียบ|หมุน|ดวล|หน้าแรก|หน้าหลัก|ตะกร้า|ตระกร้า|บิล|ออเดอร์|เบอร์|อันนี้|ตัวนี้|ตัวแรก|ตัวไหน|อันไหน|งบ|ไม่เกิน|ต่ำกว่า|มากกว่า|ระหว่าง|ถึง|กี่บาท|เท่าไหร่|เท่าไร|\d+\s*(?:ชิ้น|อัน|ขวด|แพ็ค|แพ็ก|ลัง|กล่อง|ถุง|ซอง|ห่อ|กระป๋อง|โหล|หลอด|กระสอบ|ถัง|ม้วน|คู่|ชุด)/i;

const BROWSE_PREFIX_RE =
  /^(?:(?:น้องตี๋|ตี๋)\s*)?(?:ช่วย\s*|รบกวน\s*)?(?:กำลัง\s*)?(?:อยาก(?:ได้|ซื้อ|ดู|หา)?|ต้องการ|มองหา|หาซื้อ|สนใจ|ขอ(?:ดู|หา|ซื้อ|ทราบ)?|ดูสินค้า|ดู|หา|ค้นหา|ค้น|เช็ก|เช็ค|แสดง|มี)\s*/i;
const BROWSE_SUFFIX_RE =
  /\s*(?:(?:สัก|ซัก)(?:\s*(?:\d+|หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ))?\s*(?:ชิ้น|อัน|ขวด|แพ็ค|แพ็ก|ลัง|กล่อง|ถุง|ซอง|ห่อ|กระป๋อง|โหล|หลอด|กระสอบ|ถัง|แกลลอน|ม้วน|คู่|ชุด|หน่อย)|ราคาถูกสุด|ราคาถูกที่สุด|ราคาแพงสุด|ราคาแพงที่สุด|ถูกสุด|ถูกที่สุด|แพงสุด|แพงที่สุด|คุ้มสุด|คุ้มที่สุด|เฉลี่ยถูกสุด|ต่อชิ้นถูกสุด|ต่อหน่วยถูกสุด|หรือเปล่า|รึเปล่า|หรือป่าว|หรือปล่าว|อะไรบ้าง|บ้างไหม|บ้างมั้ย|มีไหม|มีมั้ย|ไหม|มั้ย|บ้าง|หน่อย|ให้หน่อย|ที|ด้วย|นะครับ|นะค่ะ|นะคะ|ครับผม|ครับ|ค่ะ|คะ|นะ)\s*$/i;

export function cleanBrowseQuery(userText: string): string {
  let s = userText.trim();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(BROWSE_PREFIX_RE, "").replace(BROWSE_SUFFIX_RE, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim();
}

function detectBrowseSort(text: string): "relevance" | "price_asc" | "price_desc" | "unit_price_asc" {
  if (/คุ้มสุด|คุ้มที่สุด|เฉลี่ยถูกสุด|ต่อชิ้นถูกสุด|ต่อหน่วยถูกสุด/i.test(text)) return "unit_price_asc";
  if (/ถูกสุด|ถูกที่สุด|ราคาถูกสุด|ราคาถูกที่สุด/i.test(text)) return "price_asc";
  if (/แพงสุด|แพงที่สุด|ราคาแพงสุด|ราคาแพงที่สุด/i.test(text)) return "price_desc";
  return "relevance";
}

const BROWSE_INTENT_RE =
  /^(?:(?:น้องตี๋|ตี๋)\s*)?(?:ช่วย\s*|รบกวน\s*)?(?:กำลัง\s*)?(?:อยาก(?:ได้|ดู|หา)|ต้องการ|มองหา|หาซื้อ|ขอดู|ขอหา|ดูสินค้า|ดู|หา|ค้นหา|เช็ก|เช็ค|แสดง|มี)|(?:อะไรบ้าง|บ้างไหม|บ้างมั้ย|มีไหม|มีมั้ย|ถูกสุด|ถูกที่สุด|คุ้มสุด|แพงสุด)(?:ครับ|ค่ะ|คะ|นะครับ|นะ)?$/i;

// Ambient/conversational chatter that must never trigger 0-LLM instant product browsing
const CONVERSATIONAL_CHATTER_RE =
  /^(?:ถูกต้อง|ใช้|ใช่|โอเค|ไหว|รอด|อืม|เออ|เอ่อ|อ่า|อ๋อ|ครับผม|ครับ|ค่ะ|คะ|ให้|ไม่รู้|เยอะ|มาก|คุณผู้ชม|อีกทีเลย|ไปเยี่ยมกัน)(?:ครับ|ค่ะ|คะ|นะ|เลย)*$|(?:แล้วมัน|มันก็|อย่างนี้|อย่างเงี้ย|แบบว่า|ถูกป่ะ|ใช่ป่ะ|สมมุติ|สรุป|วายเฟรม|ไวเฟรม|คอมโพเนนต์|ฟิลเตอร์|โปรเจกต์|โค้ด|พี่|หนู|หนุ่ม|เขา|พวกนั้น|ที่เรา|ให้มัน|ก็เลย|อยู่แล้ว|เนาะ|อ่ะ|ป่ะ|ไง)/i;

/**
 * Pure product browse/search queries ("ขอดูน้ำปลา", "อยากได้น้ำมันพืชสักหนึ่งขวด", "มีบรีสผงซักฟอกราคาถูกสุด")
 * that can be answered deterministically from RAM in ~5 ms with 0 LLM latency and 0 hallucinations.
 */
export function isSimpleBrowseQuery(text: string, productQuery: string): boolean {
  const q = text.trim();
  if (!q || q.length > 64 || productQuery.trim().length < 2) return false;
  if (COMPLEX_BROWSE_EXCLUDE_RE.test(q)) return false;
  if (CONVERSATIONAL_CHATTER_RE.test(q)) return false;
  if (BROWSE_INTENT_RE.test(q)) return true;
  // Bare product name without explicit browse verb ("น้ำปลา", "บรีส", "มาม่า"): must stay short and compact.
  const cleaned = cleanBrowseQuery(q);
  if (cleaned.length < 2 || cleaned.length > 24) return false;
  return q.split(/\s+/).length <= 3 && terms(cleaned).length <= 3;
}

function buildDirectBrowseSpeech(
  searchText: string,
  sort: "relevance" | "price_asc" | "price_desc" | "unit_price_asc",
  items: BrainProductItem[],
): string[] {
  const top = items[0];
  if (!top) return [];
  const label = shortLabel(searchText);
  const price1 = formatSpokenPrice(top.bestPrice);
  const unit1 = top.unitCode || "ชิ้น";
  const title1 = shortProductTitle(top.nameTh, unit1);

  if (sort === "price_asc" && price1) {
    return [`ถูกสุดคือเบอร์ 1 ${title1} ${price1} บาทต่อ${unit1}ครับ`, "สั่งตามเบอร์ได้เลยครับ"];
  }
  if (sort === "unit_price_asc" && price1) {
    return [`คุ้มสุดคือเบอร์ 1 ${title1} ${price1} บาทต่อ${unit1}ครับ`, "สั่งตามเบอร์ได้เลยครับ"];
  }
  if (sort === "price_desc" && price1) {
    return [`ตัวท็อปคือเบอร์ 1 ${title1} ${price1} บาทต่อ${unit1}ครับ`, "สั่งตามเบอร์ได้เลยครับ"];
  }

  const s1 = `พบ ${label} แล้วครับ`;
  if (!price1) {
    return [s1, `เบอร์ 1 ${title1} สั่งตามเบอร์ได้เลยครับ`];
  }
  const s2 =
    items.length === 1
      ? `เบอร์ 1 ${title1} ${price1} บาท รับกี่${unit1}ดีครับ`
      : `เบอร์ 1 ${title1} ${price1} บาทต่อ${unit1} รับเบอร์ไหนดีครับ`;
  return [s1, s2];
}

type RoundMetrics = {
  loadMs?: number;
  promptMs?: number;
  evalMs?: number;
  promptTok?: number;
  evalTok?: number;
  tps?: number;
};

async function* streamOllamaRound(
  messages: Array<Record<string, unknown>>,
  offerTools: boolean,
  cfg: LlmConfig,
  collectedCalls: ParsedToolCall[],
  metricsOut: RoundMetrics,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (signal?.aborted) return;

  const loadedNow = await isLocalModelLoadedNow(cfg);
  const controller = new AbortController();
  const timeoutMs = loadedNow ? 18000 : 30000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const body: Record<string, unknown> = {
      model: cfg.localModel,
      messages: toOllamaMessages(messages),
      stream: true,
      think: false,
      keep_alive: cfg.keepAlive,
      options: {
        num_ctx: cfg.numCtx,
        temperature: 0.15,
        num_predict: 320,
      },
    };
    if (offerTools) body.tools = TOOL_SPECS;

    const res = await fetch(`${cfg.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Ollama status ${res.status}`);
    }

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let held = "";
    let inThink = false;
    let inChannelThought = false;
    let decidedStreamHead = false;

    const processLine = function* (rawLine: string): Generator<string> {
      const line = rawLine.trim();
      if (!line) return;
      let parsed: {
        error?: string;
        done?: boolean;
        load_duration?: number;
        prompt_eval_duration?: number;
        eval_duration?: number;
        prompt_eval_count?: number;
        eval_count?: number;
        message?: {
          content?: string;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: unknown };
          }>;
        };
      };
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (parsed.error) {
        throw new Error(`Ollama: ${parsed.error}`);
      }

      for (const tc of parsed.message?.tool_calls ?? []) {
        const fnName = String(tc.function?.name ?? "").trim();
        if (!fnName) continue;
        let parsedArgs: Record<string, unknown> = {};
        const rawArgs = tc.function?.arguments;
        if (typeof rawArgs === "string") {
          try {
            const j = JSON.parse(rawArgs || "{}");
            if (j && typeof j === "object" && !Array.isArray(j)) parsedArgs = j as Record<string, unknown>;
          } catch {
            parsedArgs = {};
          }
        } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          parsedArgs = rawArgs as Record<string, unknown>;
        }
        collectedCalls.push({
          id: tc.id || `ollama-${collectedCalls.length}`,
          name: fnName,
          args: parsedArgs,
        });
      }

      if (parsed.done) {
        markLocalLlmWarmed();
        metricsOut.loadMs = Math.round((parsed.load_duration ?? 0) / 1e6);
        metricsOut.promptMs = Math.round((parsed.prompt_eval_duration ?? 0) / 1e6);
        metricsOut.evalMs = Math.round((parsed.eval_duration ?? 0) / 1e6);
        metricsOut.promptTok = parsed.prompt_eval_count;
        metricsOut.evalTok = parsed.eval_count;
        metricsOut.tps = parsed.eval_duration
          ? Number(((parsed.eval_count ?? 0) / (parsed.eval_duration / 1e9)).toFixed(1))
          : undefined;
      }

      const chunk = (parsed.message?.content ?? "").replace(CJK_JUNK, "");
      if (!chunk) return;
      held += chunk;

      while (held.length > 0) {
        if (inChannelThought) {
          const chMatch = held.match(/<\|?channel\|?>/i);
          if (!chMatch || chMatch.index === undefined) {
            if (held.length > 2400) held = held.slice(-24);
            break;
          }
          held = held.slice(chMatch.index + chMatch[0].length);
          inChannelThought = false;
          decidedStreamHead = true;
          continue;
        }
        if (inThink) {
          const endIdx = held.indexOf("</think>");
          if (endIdx === -1) {
            held = held.slice(-8);
            break;
          }
          held = held.slice(endIdx + 8);
          inThink = false;
          decidedStreamHead = true;
          continue;
        }
        if (!decidedStreamHead) {
          const leadChannelHead = held.match(/^\s*(?:<\|?channel\|?>)?\s*thought(?:\s|\r?\n|$)/i);
          if (leadChannelHead) {
            inChannelThought = true;
            continue;
          }
          if (held.length < 18 && /^(?:\s*<|\s*t(?:h(?:o(?:u(?:g(?:h(?:t)?)?)?)?)?)?$)/i.test(held)) {
            break;
          }
          decidedStreamHead = true;
        }
        const thinkIdx = held.indexOf("<think>");
        if (thinkIdx !== -1) {
          if (thinkIdx > 0) yield stripModelThoughtTokens(held.slice(0, thinkIdx));
          held = held.slice(thinkIdx + 7);
          inThink = true;
          continue;
        }
        const cutIdx = held.lastIndexOf("<");
        const safeCut = cutIdx === -1 || held.length - cutIdx > 12 ? held.length : cutIdx;
        if (safeCut > 0) {
          const out = stripModelThoughtTokens(held.slice(0, safeCut));
          if (out) yield out;
          held = held.slice(safeCut);
        } else {
          break;
        }
      }
    };

    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) {
        yield* processLine(l);
      }
    }
    if (buffer.trim()) {
      yield* processLine(buffer);
    }
    if (held && !inThink && !inChannelThought) {
      const tail = stripModelThoughtTokens(held);
      if (tail) yield tail;
    }
  } catch (err) {
    if (!signal?.aborted) markLocalLlmCold();
    if (timedOut && !signal?.aborted) {
      throw new Error(`Local Ollama timeout (${timeoutMs} ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted && reader) {
      void reader.cancel().catch(() => {});
    }
  }
}

async function* streamDeepSeekRound(
  messages: Array<Record<string, unknown>>,
  offerTools: boolean,
  cfg: LlmConfig,
  collectedCalls: ParsedToolCall[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (signal?.aborted) return;
  if (!cfg.deepseekApiKey) {
    throw new Error("ยังไม่ได้ตั้งค่า DEEPSEEK_API_KEY สำรอง");
  }
  const body: Record<string, unknown> = {
    model: LOCKED_FLASH_MODEL,
    messages,
    stream: true,
    temperature: 0.15,
    max_tokens: 320,
    thinking: { type: "disabled" },
  };
  if (offerTools) body.tools = TOOL_SPECS;

  const res = await fetch(`${cfg.deepseekBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.deepseekApiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`DeepSeek API status ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let held = "";
  let markup = "";
  const parts = new Map<number, { id: string; name: string; args: string }>();

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      let parsed: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      try {
        parsed = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      for (const ch of parsed.choices ?? []) {
        const delta = ch.delta;
        if (!delta) continue;
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          let slot = parts.get(idx);
          if (!slot) {
            slot = { id: "", name: "", args: "" };
            parts.set(idx, slot);
          }
          if (tc.id) slot.id += tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }

        const chunk = (delta.content ?? "").replace(CJK_JUNK, "");
        if (!chunk) continue;
        if (markup) {
          markup += chunk;
          continue;
        }
        held += chunk;
        const m = DSML_START.exec(held);
        if (m) {
          if (m.index > 0) yield held.slice(0, m.index);
          markup = held.slice(m.index);
          held = "";
          continue;
        }
        const cutIdx = held.lastIndexOf("<");
        const safeCut = cutIdx === -1 || held.length - cutIdx > 14 ? held.length : cutIdx;
        if (safeCut > 0) {
          yield held.slice(0, safeCut);
          held = held.slice(safeCut);
        }
      }
    }
    }
  } finally {
    if (signal?.aborted) {
      void reader.cancel().catch(() => {});
    }
  }

  if (signal?.aborted) return;
  if (held && !markup) yield held;

  if (markup && parts.size === 0 && offerTools) {
    collectedCalls.push(...parseDsmlCalls(markup));
  }
  for (const p of parts.values()) {
    let parsedArgs: Record<string, unknown> = {};
    try {
      const j = JSON.parse(p.args || "{}");
      if (j && typeof j === "object") parsedArgs = j as Record<string, unknown>;
    } catch {
      parsedArgs = {};
    }
    collectedCalls.push({
      id: p.id || `tc-${collectedCalls.length}`,
      name: p.name,
      args: parsedArgs,
    });
  }
}

export async function* runNongTeeTurn(opts: {
  message: string;
  altHeard?: string;
  history?: JavisChatMessage[];
  cartItems?: Array<Partial<CartItem> & { slug: string; qty: number }>;
  customer?: Partial<CustomerCheckoutInfo>;
  visionSlugs?: string[];
  visionSummary?: string;
  /** Products shown on the customer's screen from the previous turn, so "อันนั้น/ตัวแรก" can be resolved. */
  focusSlugs?: string[];
  /** Product whose "how many?" box is open on screen, so a bare "10 แพ็ค" answers it. */
  pendingSlug?: string;
  /** Product page open on the customer's screen (opened by voice or by hand), so "อันนี้" means that product. */
  viewingSlug?: string;
  /** Customer dietary/allergen guard tags so safe items rank first and warnings sound proactively. */
  dietaryTags?: DietaryTagId[];
  /** Coupon the customer picked on screen; every cart recalculation keeps it. */
  couponCode?: string;
  /** Client abort signal so interrupted turns immediately stop DeepSeek & never run stale tools. */
  signal?: AbortSignal;
}): AsyncGenerator<JavisStreamEvent> {
  const userText = opts.message.trim();
  const altText = opts.altHeard?.trim() ?? "";
  const history = (opts.history ?? [])
    .slice(-4)
    .map((m) => ({ role: m.role, content: m.content.split(SCREEN_MARK)[0].trim().slice(0, 220) }))
    .filter((m) => m.content.length > 0);
  const cfg = getLlmConfig();
  const activeDietary: readonly DietaryTagId[] = opts.dietaryTags ?? [];
  const turnT0 = performance.now();
  const turnState: { provider: LlmProviderKind; model: string; fallbackReason: string; tps?: number } = {
    provider: "local",
    model: cfg.localModel,
    fallbackReason: "",
  };

  let currentCart = recalculateCart(opts.cartItems ?? [], opts.couponCode);
  let currentCustomer: Partial<CustomerCheckoutInfo> = { ...(opts.customer ?? {}) };
  let jobSeq = 1;
  const cardCollector = new Map<string, JavisProductCard>();
  let stageSetExplicitly = false;
  const prefetchBlocks: string[] = [];

  const visionSlugs = (opts.visionSlugs ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
  if (visionSlugs.length > 0) {
    const vJobId = jobSeq++;
    const visionItems: BrainProductItem[] = [];
    for (const s of visionSlugs) {
      const p = getProductBySlug(s);
      if (p) {
        visionItems.push(p);
        cardCollector.set(p.slug, toProductCard(p));
        if (prefetchBlocks.length < 6) prefetchBlocks.push(summarizeProductForLlm(p));
      }
    }
    yield {
      type: "team",
      job: {
        id: vJobId,
        worker: "vision",
        label: "ส่องรูปสินค้า",
        task: opts.visionSummary || `ตรงกับสินค้า ${visionItems.length} รายการ`,
        state: visionItems.length > 0 ? "done" : "none",
        ms: 15,
        count: visionItems.length,
      },
    };
    if (cardCollector.size > 0) {
      const cardsArr = sortCardsForDietary([...cardCollector.values()], activeDietary);
      stageSetExplicitly = true;
      yield { type: "cards", cards: cardsArr };
      yield {
        type: "stage",
        mode: cardsArr.length === 1 ? "spotlight" : "showcase",
        spotlight: cardsArr[0] ?? null,
        title: opts.visionSummary ? `📷 พบจากรูป: ${opts.visionSummary}` : "📷 สินค้าที่ค้นพบจากรูปภาพ",
      };
      const vPath = buildBrainPath(opts.visionSummary || userText, cardsArr);
      if (vPath) yield { type: "brain_path", path: vPath };
    }
  }

  yield { type: "status", state: "searching", text: "น้องตี๋กำลังค้นข้อมูลสินค้า…" };

  // Token-Saver Fast-Path:
  // 1) If message references explicit product slug(s) (prod-...) or direct cart/order action -> 0 planner LLM tokens!
  // 2) Try local in-memory BM25 + synonym search first (2ms, 0 LLM tokens). Only call LLM planner when local search gets 0 hits!
  const explicitSlugMatches = [...userText.matchAll(/\b(prod-[a-z0-9-]+)\b/gi)].map((m) => m[1].toLowerCase());
  for (const s of explicitSlugMatches) {
    const p = getProductBySlug(s);
    if (p) {
      cardCollector.set(p.slug, toProductCard(p));
      if (prefetchBlocks.length < 6) prefetchBlocks.push(summarizeProductForLlm(p));
    }
  }

  let angles: string[] = [];
  let plannerMs = 1;
  let prefetchLabel = "สินค้าที่พบ";
  const productQuery = productQueryOf(userText);
  const focusItems = (opts.focusSlugs ?? [])
    .slice(0, 60)
    .map((s) => getProductBySlug(String(s).trim()))
    .filter((p): p is BrainProductItem => Boolean(p));
  const isDirectCartOrOrder = CART_OR_ORDER_DIRECT_RE.test(userText);

  const viewingProduct = opts.viewingSlug ? getProductBySlug(opts.viewingSlug) : null;
  const cardNoOf = (p: BrainProductItem) => focusItems.findIndex((f) => f.slug === p.slug) + 1;
  const viewingNo = viewingProduct ? cardNoOf(viewingProduct) : 0;

  let activePathQuery = userText;
  let pendingStage: {
    cards: JavisProductCard[];
    mode: JavisStageMode;
    spotlight: JavisProductCard | null;
    title: string;
  } | null = null;
  const flushPendingStage = function* (): Generator<JavisStreamEvent> {
    if (!pendingStage) return;
    const ps = pendingStage;
    pendingStage = null;
    const sortedCards = sortCardsForDietary(ps.cards, activeDietary);
    yield { type: "cards", cards: sortedCards };
    if (!stageSetExplicitly) {
      yield { type: "stage", mode: ps.mode, spotlight: sortedCards[0] ?? ps.spotlight, title: ps.title };
    }
    const trace = buildBrainPath(activePathQuery || userText, sortedCards);
    if (trace) yield { type: "brain_path", path: trace };
  };

  if (visionSlugs.length === 0) {
    // A card number always wins; a bare "สองชิ้น" answers the open "how many?" box, else the open product page.
    const pendingProduct = (opts.pendingSlug ? getProductBySlug(opts.pendingSlug) : null) ?? viewingProduct;
    const picks = parseNumberedOrder(userText, focusItems.length);
    const bareQty = !picks && pendingProduct ? parseBareQuantity(userText) : null;
    const pointed = !picks && !bareQty && viewingProduct ? parsePointedOrder(userText) : null;
    const targets: NumberedTarget[] | null = picks
      ? picks.map((pk) => ({ ...pk, product: focusItems[pk.no - 1] ?? null }))
      : bareQty && pendingProduct
        ? [{ ...bareQty, no: cardNoOf(pendingProduct), product: pendingProduct }]
        : pointed && viewingProduct
          ? [{ ...pointed, no: viewingNo, product: viewingProduct }]
          : null;
    if (targets) {
      yield* executeNumberedOrder(targets, focusItems, currentCart);
      return;
    }
    const handledDirectCart = yield* tryDirectCartAction(userText, focusItems, currentCart, opts.couponCode);
    if (handledDirectCart) return;

    // 0-LLM Voice Batch Order Fast-Path ("เอาน้ำปลาทิพรส 2 ขวด น้ำมันพืช 3 ขวด มาม่า 1 แพ็ค")
    const batchSearch = (q: string): JavisProductCard[] => {
      const cleaned = cleanBrowseQuery(q);
      const r1 = searchProductsDetailed({ q: cleaned.length >= 2 ? cleaned : q, pageSize: 8 });
      const items = r1.items.length > 0 || cleaned === q ? r1.items : searchProductsDetailed({ q, pageSize: 8 }).items;
      return items.map(toProductCard);
    };
    const batchPlan =
      resolveBatchOrderWithSearch(userText, batchSearch, activeDietary) ??
      (altText && altText !== userText ? resolveBatchOrderWithSearch(altText, batchSearch, activeDietary) : null);
    if (batchPlan && batchPlan.matchedCount >= 1 && batchPlan.rows.length >= 2) {
      const bMs = Math.max(1, Math.round(performance.now() - turnT0));
      const matchedMap = new Map<string, JavisProductCard>();
      for (const row of batchPlan.rows) {
        if (row.matched && !matchedMap.has(row.matched.slug)) matchedMap.set(row.matched.slug, row.matched);
        for (const alt of row.alternatives) {
          if (matchedMap.size < 24 && !matchedMap.has(alt.slug)) matchedMap.set(alt.slug, alt);
        }
      }
      const bCards = sortCardsForDietary([...matchedMap.values()], activeDietary);
      yield {
        type: "team",
        job: {
          id: jobSeq++,
          worker: "cart",
          label: "จัดชุดสั่งรวดเดียว",
          task: `${batchPlan.matchedCount}/${batchPlan.rows.length} รายการ`,
          state: "done",
          ms: bMs,
          count: batchPlan.matchedCount,
        },
      };
      if (bCards.length > 0) {
        yield { type: "cards", cards: bCards };
        yield {
          type: "stage",
          mode: "showcase",
          spotlight: bCards[0] ?? null,
          title: `📦 จัดชุดสั่งรวดเดียว (${batchPlan.matchedCount}/${batchPlan.rows.length} รายการ)`,
        };
        const bPath = buildBrainPath(
          batchPlan.rows.map((r) => r.query).slice(0, 3).join(" · "),
          bCards,
        );
        if (bPath) yield { type: "brain_path", path: bPath };
      }
      yield { type: "batch_order", plan: batchPlan };
      const warnedRow = batchPlan.rows.find((r) => Boolean(r.dietaryWarn));
      const warnSpoken = warnedRow
        ? ` และระวัง ${warnedRow.matched?.title ?? warnedRow.query} มี${warnedRow.dietaryWarn}นะครับ`
        : "";
      const spoken = `จัดชุดให้ครบ ${batchPlan.matchedCount} รายการแล้วครับ ยอดประมาณ ${batchPlan.totalFormatted}${warnSpoken} ตรวจหรือสลับยี่ห้อบนจอ แล้วพูดว่า ใส่ตะกร้าทั้งชุด หรือกดยืนยันได้เลยครับ`;
      yield { type: "engine", provider: "ram", model: "สั่งรวดเดียว (0 ms AI)", label: "สั่งรวดเดียว", ms: bMs };
      yield { type: "status", state: "speaking", text: "น้องตี๋กำลังพูด…" };
      yield { type: "delta", section: "speech", text: spoken };
      yield { type: "sentence", text: spoken };
      yield {
        type: "done",
        spokenText: spoken,
        screenMarkdown: "",
        model: "สั่งรวดเดียว (0 ms AI)",
        provider: "ram",
        ms: bMs,
      };
      return;
    }
  }

  if (visionSlugs.length === 0 && explicitSlugMatches.length === 0 && !isDirectCartOrOrder && (focusItems.length > 0 || viewingProduct) && (!productQuery || mentionsCardNumber(userText, focusItems.length) || (Boolean(viewingProduct) && pointsAtOpenProduct(userText)))) {
    // Follow-up turn: keep talking about what is on screen (0 search, 0 planner tokens)
    prefetchLabel = "สินค้าบนจอที่ลูกค้ากำลังพูดต่อ (เรียงตามลำดับบนจอ)";
    if (viewingProduct) {
      prefetchLabel +=
        viewingNo > 0
          ? ` — ลูกค้าเปิดดูเบอร์ ${viewingNo} อยู่ คำว่า อันนี้/ตัวนี้ คือเบอร์ ${viewingNo}`
          : ` — ลูกค้าเปิดดู "${viewingProduct.nameTh}" อยู่ คำว่า อันนี้/ตัวนี้ คือสินค้านี้ ส่วนเบอร์ 1-${focusItems.length} คือสินค้าที่เกี่ยวข้องบนจอ`;
    }
    for (const p of focusItems) cardCollector.set(p.slug, toProductCard(p));
    // Cards the customer names by number go first, so "รายละเอียดเบอร์ 9" is never cut by the 6-block cap.
    const pickedNos = cardNumbersIn(userText, focusItems.length);
    const picked = pickedNos.length ? pickedNos.map((no) => focusItems[no - 1]) : viewingProduct ? [viewingProduct] : [];
    const contextPool = [...picked, ...focusItems.filter((p) => !picked.includes(p))];
    for (const p of contextPool) {
      if (prefetchBlocks.length < Math.max(6, picked.length)) prefetchBlocks.push(summarizeProductForLlm(p));
    }
    yield {
      type: "team",
      job: {
        id: jobSeq++,
        worker: "brain",
        label: "จำบริบทบนจอ",
        task: `คุยต่อจากสินค้า ${focusItems.length} รายการ`,
        state: "done",
        ms: 1,
        count: focusItems.length,
      },
    };
    yield { type: "cards", cards: [...cardCollector.values()] };
  } else if (visionSlugs.length === 0 && explicitSlugMatches.length === 0 && !isDirectCartOrOrder) {
    const tLocal = performance.now();
    const browseSort = detectBrowseSort(userText);
    // Clean from original userText when browsing so phrases like "ไม่ใส่ผงชูรส" don't lose "ใส่".
    const cleanedBrowse = cleanBrowseQuery(userText);
    let searchText = cleanedBrowse.length >= 2 ? cleanedBrowse : productQuery || userText;
    let localDirect = searchProductsDetailed({ q: searchText, sort: browseSort, pageSize: 36 });
    let matchedAlt = false;
    if (
      !(localDirect.topStrongMatch && (localDirect.items.length >= 2 || (localDirect.items.length === 1 && searchText.length <= 28))) &&
      altText &&
      altText !== userText
    ) {
      const altClean = cleanBrowseQuery(altText);
      const altSearch = altClean.length >= 2 ? altClean : productQueryOf(altText) || altText;
      const altDirect = searchProductsDetailed({ q: altSearch, sort: browseSort, pageSize: 36 });
      if (altDirect.topStrongMatch && (altDirect.items.length >= 2 || (altDirect.items.length === 1 && altSearch.length <= 28))) {
        localDirect = altDirect;
        searchText = altSearch;
        matchedAlt = true;
      }
    }
    if (localDirect.topStrongMatch && (localDirect.items.length >= 2 || (localDirect.items.length === 1 && searchText.length <= 28))) {
      const localMs = Math.max(1, Math.round(performance.now() - tLocal));
      for (const p of localDirect.items) {
        if (cardCollector.size < 36) cardCollector.set(p.slug, toProductCard(p));
        if (prefetchBlocks.length < 6) prefetchBlocks.push(summarizeProductForLlm(p));
      }
      emitMcpEvent({
        tool: "ask_brain",
        audience: "user",
        rawArg: searchText,
        hits: localDirect.items.slice(0, 4).map((p) => ({ slug: p.slug, title: p.nameTh, folder: "product" })),
        totalHits: localDirect.total,
        ms: localMs,
      });
      yield {
        type: "team",
        job: {
          id: jobSeq++,
          worker: "product",
          label: "ค้นสมองด่วน",
          task: searchText.slice(0, 50),
          state: "done",
          ms: localMs,
          count: localDirect.total,
        },
      };
      if (cardCollector.size > 0) {
        const cardsArr = sortCardsForDietary([...cardCollector.values()], activeDietary);
        activePathQuery = searchText;
        pendingStage = {
          cards: cardsArr,
          mode: cardsArr.length === 1 ? "spotlight" : "showcase",
          spotlight: cardsArr[0] ?? null,
          title: `สินค้าตามบริบท: "${searchText.slice(0, 40)}"`,
        };
      }
      // 0-LLM instant reply for pure product browse/search queries (~5 ms to first sentence!)
      const activeUserForBrowse = matchedAlt ? altText : userText;
      const activeProductQuery = matchedAlt ? productQueryOf(altText) : productQuery;
      if (activeProductQuery && localDirect.items.length > 0 && isSimpleBrowseQuery(activeUserForBrowse, activeProductQuery)) {
        const orderRank = (p: BrainProductItem) => {
          if (!activeDietary.length) return 0;
          const card = cardCollector.get(p.slug);
          const st = card ? evaluateDietaryShield(card, activeDietary).status : "unknown";
          return st === "safe" ? 0 : st === "unknown" ? 1 : 2;
        };
        const orderedItems = activeDietary.length
          ? [...localDirect.items].sort((a, b) => orderRank(a) - orderRank(b))
          : localDirect.items;
        const lines = buildDirectBrowseSpeech(searchText, browseSort, orderedItems);
        if (lines.length > 0) {
          yield* flushPendingStage();
          yield { type: "engine", provider: "ram", model: "ค้นสมองด่วน (0 ms AI)", label: "สมองด่วน", ms: localMs };
          yield { type: "status", state: "speaking", text: "น้องตี๋กำลังพูด…" };
          for (const s of lines) {
            yield { type: "delta", section: "speech", text: s + " " };
            yield { type: "sentence", text: s };
          }
          yield { type: "done", spokenText: lines.join(" "), screenMarkdown: "", model: "ค้นสมองด่วน (0 ms AI)", provider: "ram", ms: localMs };
          return;
        }
      }
    } else {
      const planRes = await planSwarmQueries(userText, history, cfg, opts.signal, altText);
      angles = planRes.angles;
      plannerMs = planRes.ms;
    }
  }

  if (opts.signal?.aborted) return;

  if (angles.length > 0) {
    const planId = jobSeq++;
    yield {
      type: "team",
      job: {
        id: planId,
        worker: "planner",
        label: "วางแผนคำค้น",
        task: angles.join(" ; "),
        state: "done",
        ms: plannerMs,
        count: angles.length,
      },
    };

    yield { type: "status", state: "searching", text: `ลูกทีมค้นสมองสินค้า ${angles.length} มุมพร้อมกัน…` };
    const swarmJobs = angles.map((angle) => ({ id: jobSeq++, angle }));
    for (const sj of swarmJobs) {
      yield {
        type: "team",
        job: { id: sj.id, worker: "product", label: "ค้นสินค้า", task: sj.angle, state: "run" },
      };
    }

    const tSwarm = performance.now();
    const angleResults = await Promise.all(
      swarmJobs.map(async (sj) => {
        const prodRes = searchProductsDetailed({ q: sj.angle, pageSize: 16 });
        const brainHits = search(sj.angle, 2, "all").filter((h) => h.folder !== "product");
        return { sj, prodRes, brainHits, ms: Math.max(1, Math.round(performance.now() - tSwarm)) };
      }),
    );

    const seenSlugs = new Set<string>();
    const sortedAngles = [...angleResults].sort(
      (a, b) => Number(b.prodRes.topStrongMatch) - Number(a.prodRes.topStrongMatch),
    );
    const anyStrong = sortedAngles.some((ar) => ar.prodRes.topStrongMatch && ar.prodRes.items.length > 0);
    let firstMatchedAngle = "";
    for (const ar of sortedAngles) {
      const hasStrong = ar.prodRes.topStrongMatch && ar.prodRes.items.length > 0;
      // If Planner produced product-specific keywords that missed strict topStrongMatch (e.g. "แป้งทาเท้า" -> "แป้งโยคี", "ผงโรยเท้า"),
      // allow a soft title-token fallback only when NO angle had a strong hit and the query is not conversational chatter.
      const hasSoftFallback =
        !anyStrong &&
        !CONVERSATIONAL_CHATTER_RE.test(userText) &&
        ar.prodRes.items.length > 0 &&
        ar.prodRes.appliedTerms.some(
          (t) => t.length >= 2 && normalizeText(ar.prodRes.items[0].nameTh).includes(t),
        );
      const useHit = hasStrong || hasSoftFallback;
      if (useHit) {
        if (!firstMatchedAngle) firstMatchedAngle = ar.sj.angle;
        for (const p of ar.prodRes.items) {
          if (cardCollector.size < 36) cardCollector.set(p.slug, toProductCard(p));
          if (!seenSlugs.has(p.slug) && seenSlugs.size < 6) {
            seenSlugs.add(p.slug);
            prefetchBlocks.push(summarizeProductForLlm(p));
          }
        }
        for (const bh of ar.brainHits.slice(0, 1)) {
          prefetchBlocks.push(`• [${bh.folder}] ${bh.title} (${bh.slug})`);
        }
      }
      emitMcpEvent({
        tool: "ask_brain",
        audience: "user",
        rawArg: ar.sj.angle,
        hits: useHit ? ar.prodRes.items.slice(0, 4).map((p) => ({ slug: p.slug, title: p.nameTh, folder: "product" })) : [],
        totalHits: useHit ? ar.prodRes.total : 0,
        ms: ar.ms,
      });
      yield {
        type: "team",
        job: {
          id: ar.sj.id,
          worker: "product",
          label: "ค้นสินค้า",
          task: ar.sj.angle,
          state: useHit ? "done" : "none",
          ms: ar.ms,
          count: useHit ? ar.prodRes.total : 0,
        },
      };
    }

    if (cardCollector.size > 0) {
      const cardsArr = sortCardsForDietary([...cardCollector.values()], activeDietary);
      activePathQuery = firstMatchedAngle || userText;
      pendingStage = {
        cards: cardsArr,
        mode: cardsArr.length === 1 ? "spotlight" : "showcase",
        spotlight: cardsArr[0] ?? null,
        title: `สินค้าตามบริบท: "${firstMatchedAngle || userText.slice(0, 40)}"`,
      };
    }
  }

  const st = brainStats();
  const customerSummary = [
    currentCustomer.customerName ? `ชื่อ:${currentCustomer.customerName}` : "",
    currentCustomer.shopName ? `ร้าน:${currentCustomer.shopName}` : "",
    currentCustomer.phone ? `เบอร์:${currentCustomer.phone}` : "",
    currentCustomer.address ? `ที่อยู่:${currentCustomer.address}` : "",
    currentCustomer.paymentMethod ? `ชำระ:${currentCustomer.paymentMethod}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  // Every card on screen has a number; tell the model the same numbers the customer sees.
  const withCardNo = (block: string) => {
    const slug = block.startsWith("• [") ? block.slice(3, block.indexOf("|")) : "";
    const no = slug ? [...cardCollector.keys()].indexOf(slug) + 1 : 0;
    return no > 0 ? "• เบอร์ " + no + " " + block.slice(2) : block;
  };

  const dietaryNote =
    activeDietary.length > 0
      ? `เกราะสุขภาพลูกค้า: ${activeDietary.map((id) => DIETARY_TAGS.find((d) => d.id === id)?.shortLabel ?? id).join(", ")} (เตือนลูกค้าทันทีถ้าพบส่วนผสมที่เสี่ยง)`
      : "";

  const contextBlock = [
    formatCartContext(currentCart),
    customerSummary ? `ผู้รับ: ${customerSummary}` : "ผู้รับ: (ยังไม่ระบุ)",
    dietaryNote,
    cardCollector.size > 0 && prefetchBlocks.length
      ? `${prefetchLabel}:\n${prefetchBlocks.map(withCardNo).join("\n")}`
      : `คลังมี ${st.totalProducts} สินค้า แต่ยังไม่ได้แสดงสินค้าสำหรับคำขอล่าสุดนี้ (ห้ามหยิบสินค้าจากข้อความย้อนหลังมาตอบซ้ำ — ถ้าลูกค้าหาสินค้าหรือบอกอาการ ให้เรียก search_products ทันที ห้ามรับปากเปล่าว่าเดี๋ยวหาให้)`,
    "พูดสั้นไม่เกิน 1-2 ประโยค (~85 ตัวอักษร) จบด้วยคำถามปิดสั้นๆ 1 ข้อ",
  ]
    .filter(Boolean)
    .join("\n");

  const altHeardNote = altText && altText !== userText ? `\n(หมายเหตุหูสำรองได้ยิน: ${altText.slice(0, 160)})` : "";
  const llmMessages: Array<Record<string, unknown>> = [
    { role: "system", content: NONG_TEE_SYSTEM_PROMPT },
    ...history,
    {
      role: "user",
      content: `${userText}${altHeardNote}\n\n[${contextBlock}]`,
    },
  ];

  const MAX_ROUNDS = 2;
  let spokenAcc = "";
  let screenAcc = "";
  let speechSentenceBuf = "";
  let emittedSentences = 0;
  let replacedCardsBySearchTool = false;
  const extraToolLogs: string[] = [];

  // Flush the first sentence early (~10-38 chars) so OmniVoice starts speaking ASAP (~450 ms chunk zone),
  // and cap subsequent sentences at 70 chars so TTS never hits the long-sentence latency cliff.
  const flushSpeechSentences = function* (finalFlush = false): Generator<JavisStreamEvent> {
    while (speechSentenceBuf.length >= 10) {
      SENTENCE_END_RE.lastIndex = 0;
      let matchEnd = -1;
      for (const m of speechSentenceBuf.matchAll(SENTENCE_END_RE)) {
        if (m.index !== undefined && m.index + m[0].length >= 10) {
          matchEnd = m.index + m[0].length;
          break;
        }
      }
      const softLimit = emittedSentences === 0 ? 38 : 70;
      if (matchEnd === -1 && speechSentenceBuf.length >= softLimit) {
        const sp = speechSentenceBuf.lastIndexOf(" ", softLimit);
        const fallbackSp = sp >= 20 ? sp : speechSentenceBuf.indexOf(" ", 20);
        if (fallbackSp >= 20) matchEnd = fallbackSp + 1;
      }
      if (matchEnd === -1) break;
      const chunk = speechSentenceBuf.slice(0, matchEnd).trim();
      speechSentenceBuf = speechSentenceBuf.slice(matchEnd);
      if (chunk) {
        emittedSentences += 1;
        yield { type: "sentence", text: chunk };
      }
    }
    if (finalFlush && speechSentenceBuf.trim()) {
      const rest = speechSentenceBuf.trim();
      speechSentenceBuf = "";
      emittedSentences += 1;
      yield { type: "sentence", text: rest };
    }
  };

  try {
    const runRoundWithFallback = async function* (
      round: number,
      roundMessages: Array<Record<string, unknown>>,
      offerTools: boolean,
      calls: ParsedToolCall[],
    ): AsyncGenerator<string> {
      if (turnState.provider === "fallback") {
        const tFb = performance.now();
        let fbChunks = 0;
        try {
          for await (const tok of streamDeepSeekRound(roundMessages, offerTools, cfg, calls, opts.signal)) {
            fbChunks += 1;
            yield tok;
          }
          appendLlmDevLog({
            phase: "chat_round",
            round,
            provider: "fallback",
            model: cfg.fallbackModel,
            ms: Math.max(1, Math.round(performance.now() - tFb)),
            fallbackReason: turnState.fallbackReason || undefined,
            toolCalls: calls.map((c) => c.name),
            ok: fbChunks > 0 || calls.length > 0,
          });
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "DeepSeek error";
          appendLlmDevLog({
            phase: "chat_round",
            round,
            provider: "fallback",
            model: cfg.fallbackModel,
            ms: Math.max(1, Math.round(performance.now() - tFb)),
            fallbackReason: turnState.fallbackReason || undefined,
            error: msg,
            ok: false,
          });
          throw err;
        }
      }

      const tLocal = performance.now();
      const metrics: RoundMetrics = {};
      let localEmitted = 0;
      let localErrMsg = "";
      try {
        for await (const tok of streamOllamaRound(roundMessages, offerTools, cfg, calls, metrics, opts.signal)) {
          localEmitted += 1;
          yield tok;
        }
        if (localEmitted === 0 && calls.length === 0) {
          localErrMsg = "Local model returned empty response";
        } else {
          const roundMs = Math.max(1, Math.round(performance.now() - tLocal));
          if (metrics.tps !== undefined) turnState.tps = metrics.tps;
          appendLlmDevLog({
            phase: "chat_round",
            round,
            provider: "local",
            model: cfg.localModel,
            ms: roundMs,
            loadMs: metrics.loadMs,
            promptMs: metrics.promptMs,
            evalMs: metrics.evalMs,
            promptTok: metrics.promptTok,
            evalTok: metrics.evalTok,
            tps: metrics.tps,
            toolCalls: calls.map((c) => c.name),
            ok: true,
          });
          yield* [];
          return;
        }
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        localErrMsg = err instanceof Error ? err.message : "Ollama connection error";
      }

      // Trigger fallback only if nothing has been emitted directly to the user stream yet
      if (localEmitted > 0 || !cfg.deepseekApiKey) {
        appendLlmDevLog({
          phase: "chat_round",
          round,
          provider: "local",
          model: cfg.localModel,
          ms: Math.max(1, Math.round(performance.now() - tLocal)),
          error: localErrMsg || "Local model error",
          ok: false,
        });
        throw new Error(
          cfg.deepseekApiKey
            ? localErrMsg
            : `Local AI (${cfg.localModel}) ขัดข้อง (${localErrMsg}) และยังไม่ได้ตั้งค่า DEEPSEEK_API_KEY สำรอง`,
        );
      }

      calls.length = 0;
      turnState.provider = "fallback";
      turnState.model = cfg.fallbackModel;
      turnState.fallbackReason = localErrMsg;
      const localFailMs = Math.max(1, Math.round(performance.now() - tLocal));
      appendLlmDevLog({
        phase: "chat_round",
        round,
        provider: "local",
        model: cfg.localModel,
        ms: localFailMs,
        fallbackReason: turnState.fallbackReason,
        error: localErrMsg,
        ok: false,
      });

      const tFb = performance.now();
      let fbChunks = 0;
      try {
        for await (const tok of streamDeepSeekRound(roundMessages, offerTools, cfg, calls, opts.signal)) {
          fbChunks += 1;
          yield tok;
        }
        appendLlmDevLog({
          phase: "chat_round",
          round,
          provider: "fallback",
          model: cfg.fallbackModel,
          ms: Math.max(1, Math.round(performance.now() - tFb)),
          fallbackReason: turnState.fallbackReason,
          toolCalls: calls.map((c) => c.name),
          ok: fbChunks > 0 || calls.length > 0,
        });
      } catch (fbErr) {
        const fbMsg = fbErr instanceof Error ? fbErr.message : "DeepSeek error";
        appendLlmDevLog({
          phase: "chat_round",
          round,
          provider: "fallback",
          model: cfg.fallbackModel,
          ms: Math.max(1, Math.round(performance.now() - tFb)),
          fallbackReason: turnState.fallbackReason,
          error: fbMsg,
          ok: false,
        });
        throw fbErr;
      }
    };

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      if (opts.signal?.aborted) return;
      const isLast = round === MAX_ROUNDS;
      const calls: ParsedToolCall[] = [];
      const providerBeforeRound: LlmProviderKind = turnState.provider;

      yield {
        type: "status",
        state: round === 0 ? "thinking" : "searching",
        text:
          turnState.provider === "fallback"
            ? isLast
              ? "🟡 สำรอง DeepSeek กำลังสรุปคำตอบ…"
              : "🟡 สำรอง DeepSeek กำลังประมวลผล…"
            : isLast
              ? "🧠 Local Gemma 4 กำลังสรุปคำตอบ…"
              : "🧠 Local Gemma 4 กำลังประมวลผล…",
      };

      const roundMessages = isLast
        ? [
            { role: "system", content: NONG_TEE_SYSTEM_PROMPT },
            ...history.map((m) => ({ role: m.role, content: m.content })),
            {
              role: "user",
              content: `${userText}\n\nสถานะล่าสุดหลังดำเนินการ:\n${formatCartContext(currentCart)}\n\n${extraToolLogs.join("\n\n")}\n\n${prefetchBlocks.slice(0, 6).map(withCardNo).join("\n\n")}\n\n(ระบบ: ดำเนินการเครื่องมือครบแล้ว ไม่มีเครื่องมือให้เรียกอีก ยึดสถานะตะกร้าข้างบนเป็นความจริงเท่านั้น ถ้าของที่ลูกค้าสั่งยังไม่อยู่ในตะกร้า ห้ามบอกว่าใส่แล้ว ให้บอกตรงๆ แล้วถามยืนยันสินค้า พูดสรุปสั้นกระชับไม่เกิน 1-2 ประโยค (~85 ตัวอักษร) ได้ใจความ และใส่รายละเอียดเพิ่มเติมหลังบรรทัด [จอ] เฉพาะที่จำเป็น)`,
            },
          ]
        : llmMessages;

      let roundText = "";
      if (!isLast) {
        // Buffer tool-capable rounds until stream ends so Nong Tee never speaks filler BEFORE search/stage finishes.
        let roundRaw = "";
        for await (const tok of runRoundWithFallback(round, roundMessages, true, calls)) {
          if (opts.signal?.aborted) return;
          roundRaw += tok;
        }
        if (turnState.provider !== providerBeforeRound && turnState.provider === "fallback") {
          yield {
            type: "engine",
            provider: "fallback",
            model: cfg.fallbackModel,
            label: "สำรอง DeepSeek",
            fallbackReason: turnState.fallbackReason,
          };
          yield {
            type: "team",
            job: {
              id: jobSeq++,
              worker: "brain",
              label: "สลับสำรอง DeepSeek",
              task: turnState.fallbackReason.slice(0, 48),
              state: "done",
              ms: Math.round(performance.now() - turnT0),
            },
          };
        } else if (round === 0) {
          yield {
            type: "engine",
            provider: "local",
            model: cfg.localModel,
            label: "Local Gemma 4",
            ms: Math.round(performance.now() - turnT0),
            tps: turnState.tps,
          };
        }
        roundText = roundRaw;
        if (!calls.length) {
          yield* flushPendingStage();
          const cleanedRaw = stripModelThoughtTokens(roundRaw);
          const markIdx = cleanedRaw.indexOf(SCREEN_MARK);
          const speechPart = (markIdx !== -1 ? cleanedRaw.slice(0, markIdx) : cleanedRaw).replace(/\*/g, "").trim();
          const screenPart = markIdx !== -1 ? cleanedRaw.slice(markIdx + SCREEN_MARK.length).replace(/^\r?\n/, "") : "";
          if (speechPart) {
            if (round > 0 && spokenAcc && !/\s$/.test(spokenAcc) && !/^\s/.test(speechPart)) {
              spokenAcc += " ";
              speechSentenceBuf += " ";
              yield { type: "delta", section: "speech", text: " " };
            }
            spokenAcc += speechPart;
            speechSentenceBuf += speechPart;
            yield { type: "status", state: "speaking", text: "น้องตี๋กำลังพูด…" };
            yield { type: "delta", section: "speech", text: speechPart };
          }
          yield* flushSpeechSentences(true);
          if (screenPart) {
            screenAcc += screenPart;
            yield { type: "delta", section: "screen", text: screenPart };
          }
          break;
        }
      } else {
        // All tool calls complete — flush final cards & stage to screen BEFORE streaming speech.
        yield* flushPendingStage();
        let inScreen = spokenAcc.length > 0 && screenAcc.length > 0;
        let pendingBuf = "";
        if (round > 0 && !inScreen && spokenAcc && !/\s$/.test(spokenAcc)) {
          spokenAcc += " ";
          yield { type: "delta", section: "speech", text: " " };
        }

        let announcedFallback = providerBeforeRound === "fallback";
        for await (const tok of runRoundWithFallback(round, roundMessages, false, calls)) {
          if (opts.signal?.aborted) return;
          if (!announcedFallback && turnState.provider === "fallback") {
            announcedFallback = true;
            yield {
              type: "engine",
              provider: "fallback",
              model: cfg.fallbackModel,
              label: "สำรอง DeepSeek",
              fallbackReason: turnState.fallbackReason,
            };
          }
          roundText += tok;
          if (inScreen) {
            screenAcc += tok;
            yield { type: "delta", section: "screen", text: tok };
            continue;
          }
          // Spoken text goes to the voice engine, which would read markdown asterisks aloud
          pendingBuf += tok.replace(/\*/g, "");
          const markIdx = pendingBuf.indexOf(SCREEN_MARK);
          if (markIdx !== -1) {
            const before = pendingBuf.slice(0, markIdx);
            const after = pendingBuf.slice(markIdx + SCREEN_MARK.length).replace(/^\r?\n/, "");
            if (before) {
              spokenAcc += before;
              speechSentenceBuf += before;
              yield { type: "status", state: "speaking", text: "น้องตี๋กำลังพูด…" };
              yield { type: "delta", section: "speech", text: before };
              yield* flushSpeechSentences(true);
            } else {
              yield* flushSpeechSentences(true);
            }
            inScreen = true;
            pendingBuf = "";
            if (after) {
              screenAcc += after;
              yield { type: "delta", section: "screen", text: after };
            }
          } else if (pendingBuf.length > 10) {
            const safeLen = pendingBuf.length - 6;
            const emitChunk = pendingBuf.slice(0, safeLen);
            pendingBuf = pendingBuf.slice(safeLen);
            spokenAcc += emitChunk;
            speechSentenceBuf += emitChunk;
            yield { type: "status", state: "speaking", text: "น้องตี๋กำลังพูด…" };
            yield { type: "delta", section: "speech", text: emitChunk };
            yield* flushSpeechSentences(false);
          }
        }

        if (!inScreen && pendingBuf) {
          spokenAcc += pendingBuf;
          speechSentenceBuf += pendingBuf;
          yield { type: "delta", section: "speech", text: pendingBuf };
        }
        yield* flushSpeechSentences(true);
        break;
      }

      llmMessages.push({
        role: "assistant",
        content: roundText || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });

      for (const c of calls) {
        if (opts.signal?.aborted) return;
        const jId = jobSeq++;
        const t0 = performance.now();
        const args = c.args;
        let toolOut = "";
        let workerKind: JavisTeamJob["worker"] = "product";
        let jobLabel = c.name;
        let okState: "done" | "none" = "done";

        if (c.name === "cart_add") {
          workerKind = "cart";
          jobLabel = "เพิ่มเข้าตะกร้า";
          const id = String(args.identifier ?? "").trim();
          const qty = Math.max(1, Math.min(9999, Math.floor(Number(args.qty ?? 1) || 1)));
          const prefUnit = typeof args.unitCode === "string" ? args.unitCode.trim() : undefined;
          const resolved = resolveProductForCart(id, prefUnit);

          if (!resolved) {
            okState = "none";
            toolOut = `ไม่พบสินค้า "${id}" ในสมอง จึงยังไม่ได้เพิ่มเข้าตะกร้า`;
          } else {
            const nextItems = [
              ...currentCart.items,
              {
                slug: resolved.product.slug,
                unitCode: resolved.unitCode,
                unitPrice: resolved.unitPrice,
                qty,
              },
            ];
            currentCart = recalculateCart(nextItems, opts.couponCode);
            cardCollector.set(resolved.product.slug, toProductCard(resolved.product));
            pendingStage = null;
            yield { type: "cart", cart: currentCart, lastChangedSlug: resolved.product.slug };
            yield { type: "cards", cards: [...cardCollector.values()] };
            toolOut = `เพิ่ม "${resolved.product.nameTh}" จำนวน ${qty} ${resolved.unitCode} (ราคา ${formatThaiBaht(resolved.unitPrice)}/${resolved.unitCode}) เข้าตะกร้าสำเร็จ!\n${formatCartContext(currentCart)}`;
          }
        } else if (c.name === "ask_cart_qty") {
          workerKind = "cart";
          jobLabel = "ถามจำนวนใส่ตะกร้า";
          const id = String(args.identifier ?? "").trim();
          const resolved = resolveProductForCart(id);
          if (resolved) {
            const pCard = toProductCard(resolved.product);
            cardCollector.set(resolved.product.slug, pCard);
            stageSetExplicitly = true;
            pendingStage = null;
            yield { type: "cards", cards: [...cardCollector.values()] };
            yield { type: "stage", mode: "spotlight", spotlight: pCard, title: pCard.title };
            yield { type: "ask_qty", product: pCard };
            toolOut = `เปิดกล่องให้เลือกจำนวนสำหรับ "${pCard.title}" (${pCard.priceLabel}/${pCard.unitCode}) บนหน้าจอแล้ว กรุณาถามลูกค้าด้วยเสียงสั้นๆ ว่ารับกี่ ${pCard.unitCode} ดีครับ`;
          } else {
            okState = "none";
            toolOut = `ไม่พบสินค้า "${id}"`;
          }
        } else if (c.name === "cart_update") {
          workerKind = "cart";
          jobLabel = "แก้จำนวนในตะกร้า";
          const id = String(args.identifier ?? "").trim().toLowerCase();
          const newQty = Math.max(0, Math.min(9999, Math.floor(Number(args.qty ?? 0) || 0)));
          let matched = false;
          const updated = currentCart.items
            .map((it) => {
              if (
                it.slug.toLowerCase() === id ||
                it.productCode.toLowerCase() === id ||
                it.barcode === id ||
                it.title.toLowerCase().includes(id)
              ) {
                matched = true;
                return { ...it, qty: newQty };
              }
              return it;
            })
            .filter((it) => it.qty > 0);

          if (!matched) {
            okState = "none";
            toolOut = `ไม่พบรายการ "${id}" ในตะกร้าปัจจุบัน\n${formatCartContext(currentCart)}`;
          } else {
            currentCart = recalculateCart(updated, opts.couponCode);
            stageSetExplicitly = true;
            pendingStage = null;
            yield { type: "cart", cart: currentCart };
            yield { type: "stage", mode: "cart", title: "ปรับปรุงจำนวนในตะกร้าแล้ว" };
            toolOut = `อัปเดตตะกร้าเรียบร้อยแล้ว!\n${formatCartContext(currentCart)}`;
          }
        } else if (c.name === "cart_remove") {
          workerKind = "cart";
          jobLabel = "ลบออกจากตะกร้า";
          const id = String(args.identifier ?? "").trim().toLowerCase();
          if (id === "all" || id === "ทั้งหมด") {
            currentCart = recalculateCart([], opts.couponCode);
            stageSetExplicitly = true;
            pendingStage = null;
            yield { type: "cart", cart: currentCart };
            yield { type: "stage", mode: "cart", title: "ล้างตะกร้าสินค้าเรียบร้อย" };
            toolOut = "ล้างสินค้าทั้งหมดออกจากตะกร้าเรียบร้อยแล้ว (0 รายการ)";
          } else {
            const beforeLen = currentCart.items.length;
            const remaining = currentCart.items.filter(
              (it) =>
                !(
                  it.slug.toLowerCase() === id ||
                  it.productCode.toLowerCase() === id ||
                  it.barcode === id ||
                  it.title.toLowerCase().includes(id)
                ),
            );
            if (remaining.length === beforeLen) {
              okState = "none";
              toolOut = `ไม่พบ "${id}" ในตะกร้าปัจจุบัน\n${formatCartContext(currentCart)}`;
            } else {
              currentCart = recalculateCart(remaining, opts.couponCode);
              stageSetExplicitly = true;
              pendingStage = null;
              yield { type: "cart", cart: currentCart };
              yield { type: "stage", mode: "cart", title: "ลบรายการออกจากตะกร้าแล้ว" };
              toolOut = `ลบรายการออกจากตะกร้าแล้ว!\n${formatCartContext(currentCart)}`;
            }
          }
        } else if (c.name === "cart_view") {
          workerKind = "cart";
          jobLabel = "เปิดดูตะกร้า";
          stageSetExplicitly = true;
          pendingStage = null;
          yield { type: "stage", mode: "cart", title: "สรุปรายการในตะกร้าสินค้า" };
          toolOut = formatCartContext(currentCart);
        } else if (c.name === "checkout_prepare") {
          workerKind = "order";
          jobLabel = "เตรียมปิดการขาย";
          const patch: Partial<CustomerCheckoutInfo> = {};
          if (typeof args.customerName === "string" && args.customerName.trim()) patch.customerName = args.customerName.trim();
          if (typeof args.shopName === "string" && args.shopName.trim()) patch.shopName = args.shopName.trim();
          if (typeof args.phone === "string" && args.phone.trim()) patch.phone = args.phone.trim();
          if (typeof args.address === "string" && args.address.trim()) patch.address = args.address.trim();
          if (typeof args.note === "string" && args.note.trim()) patch.note = args.note.trim();
          if (args.paymentMethod === "promptpay" || args.paymentMethod === "cod" || args.paymentMethod === "transfer") {
            patch.paymentMethod = args.paymentMethod as PaymentMethod;
          }
          currentCustomer = { ...currentCustomer, ...patch };
          stageSetExplicitly = true;
          pendingStage = null;
          yield { type: "customer", customer: currentCustomer };
          yield { type: "stage", mode: "checkout", title: "สรุปยอดและข้อมูลจัดส่งเพื่อปิดการขาย" };
          toolOut = currentCart.items.length
            ? `เปิดหน้าชำระเงินและสรุปบิลบนหน้าจอแล้ว!\n${formatCartContext(currentCart)}\nข้อมูลลูกค้าตอนนี้: ${JSON.stringify(currentCustomer)}`
            : `ยังไม่มีสินค้าในตะกร้า กรุณาช่วยลูกค้าเลือกสินค้าเข้าตะกร้าก่อนปิดบิล`;
        } else if (c.name === "place_order") {
          workerKind = "order";
          jobLabel = "ยืนยันออกใบสั่งซื้อ";
          const patch: Partial<CustomerCheckoutInfo> = {};
          if (typeof args.customerName === "string" && args.customerName.trim()) patch.customerName = args.customerName.trim();
          if (typeof args.shopName === "string" && args.shopName.trim()) patch.shopName = args.shopName.trim();
          if (typeof args.phone === "string" && args.phone.trim()) patch.phone = args.phone.trim();
          if (typeof args.address === "string" && args.address.trim()) patch.address = args.address.trim();
          if (typeof args.note === "string" && args.note.trim()) patch.note = args.note.trim();
          if (args.paymentMethod === "promptpay" || args.paymentMethod === "cod" || args.paymentMethod === "transfer") {
            patch.paymentMethod = args.paymentMethod as PaymentMethod;
          }
          currentCustomer = { ...currentCustomer, ...patch };
          yield { type: "customer", customer: currentCustomer };

          if (currentCart.items.length === 0) {
            okState = "none";
            toolOut = "ไม่สามารถออกใบสั่งซื้อได้เพราะตะกร้ายังว่างอยู่ (0 รายการ)";
          } else {
            const order = saveSalesOrder(currentCart.items, currentCustomer, opts.couponCode);
            currentCart = recalculateCart([], opts.couponCode);
            stageSetExplicitly = true;
            pendingStage = null;
            yield { type: "order", order };
            yield { type: "cart", cart: currentCart };
            yield { type: "stage", mode: "order_confirmed", title: `ยืนยันคำสั่งซื้อ #${order.orderNo}` };
            toolOut = `ปิดการขายสำเร็จ! ออกใบสั่งซื้อเลขที่ ${order.orderNo} ยอดสุทธิ ${order.cart.grandTotalFormatted} (${order.cart.itemCount} รายการ) ช่องทางชำระเงิน: ${order.customer.paymentMethod} ผู้รับ: ${order.customer.customerName} (${order.customer.phone}) ที่อยู่: ${order.customer.address}`;
          }
        } else if (c.name === "calc") {
          workerKind = "calc";
          jobLabel = "คิดเลข Decimal";
          const res = calcDecimalLines(String(args.expressions ?? ""));
          toolOut = `ผลคำนวณ Decimal:\n${res.summary}`;
        } else if (c.name === "inspect_product") {
          workerKind = "product";
          jobLabel = "เจาะลึกสินค้า";
          const id = String(args.identifier ?? "").trim();
          const resolved = resolveProductForCart(id);
          if (resolved) {
            const pCard = toProductCard(resolved.product);
            cardCollector.set(resolved.product.slug, pCard);
            pendingStage = null;
            if (!stageSetExplicitly) {
              yield { type: "stage", mode: "spotlight", spotlight: pCard, title: pCard.title };
            }
            yield { type: "cards", cards: [...cardCollector.values()] };
            const rp = resolved.product;
            toolOut = `${withCardNo(summarizeProductForLlm(rp))}${rp.ingredients ? ` | ส่วนประกอบ:${rp.ingredients.slice(0, 140)}` : ""}`;
          } else {
            okState = "none";
            toolOut = `ไม่พบสินค้า "${id}"`;
          }
        } else if (c.name === "traverse_synapses") {
          workerKind = "synapse";
          jobLabel = "เดินไซแนปส์";
          const slug = String(args.slug ?? "").trim();
          const rawRel = typeof args.relation === "string" ? args.relation.trim() : "";
          const relation = rawRel && isRelationType(rawRel) ? rawRel : undefined;
          const res = traverseGraph({ slug, depth: 2, relation, limit: 44, audience: "all" });
          if (res.start) {
            for (const nb of res.neighbors) {
              const p = getProductBySlug(nb.slug);
              if (p && cardCollector.size < 36) cardCollector.set(p.slug, toProductCard(p));
            }
            pendingStage = null;
            yield { type: "cards", cards: [...cardCollector.values()] };
            toolOut = res.neighbors
              .map((s) => `- [${RELATION_LABEL[s.rel]}] ${s.slug}: ${s.title}${s.priceLabel ? ` (${s.priceLabel})` : ""}`)
              .join("\n");
          } else {
            okState = "none";
            toolOut = `ไม่พบโหนด "${slug}"`;
          }
        } else if (c.name === "screen_control") {
          workerKind = "planner";
          jobLabel = "ควบคุมหน้าจอ";
          const id = SCREEN_COMMAND_IDS.find((x) => x === args.command);
          const no = Number.isInteger(args.no) && Number(args.no) > 0 && Number(args.no) <= 99 ? Number(args.no) : undefined;
          if (id) {
            stageSetExplicitly = true;
            pendingStage = null;
            yield { type: "ui", command: no ? { id, no } : { id } };
            toolOut = "ทำบนหน้าจอแล้ว";
          } else {
            okState = "none";
            toolOut = "ไม่รู้จักคำสั่งหน้าจอนี้";
          }
        } else if (c.name === "brain_overview") {
          workerKind = "brain";
          jobLabel = "สรุปคลังสมอง";
          const top = searchProductsDetailed({ pageSize: 6 });
          toolOut = `สินค้าทั้งหมด ${st.totalProducts} รายการ, ${st.totalBrands} แบรนด์, ${st.totalUnits} หน่วยนับ, หมวดหลัก: ${top.facets.categories.slice(0, 8).map((x) => `${x.label}(${x.count})`).join(", ")}`;
        } else {
          // search_products
          workerKind = "product";
          jobLabel = "ค้นสินค้าละเอียด";
          const q = String(args.query ?? "").trim();
          const unit = typeof args.unit === "string" ? args.unit.trim() : undefined;
          const minPrice = typeof args.minPrice === "string" ? args.minPrice.trim() : undefined;
          const maxPrice = typeof args.maxPrice === "string" ? args.maxPrice.trim() : undefined;
          const multiUnitOnly = Boolean(args.multiUnitOnly);
          const thaiGs1Only = Boolean(args.thaiGs1Only);
          const sortRaw = typeof args.sort === "string" ? args.sort : "relevance";
          const sort =
            sortRaw === "price_asc" || sortRaw === "price_desc" || sortRaw === "unit_price_asc" || sortRaw === "pack_desc"
              ? sortRaw
              : "relevance";
          const limit = Math.min(36, Math.max(1, Number(args.limit ?? 28) || 28));
          const res = searchProductsDetailed({ q, unit, minPrice, maxPrice, multiUnitOnly, thaiGs1Only, sort, pageSize: limit });
          if (res.items.length > 0) {
            // Put fresh tool search hits at card #1..#N instead of appending after stale prefetch cards
            // so both the main stage and the chat quick-pick list immediately show the exact items Nong Tee names.
            if (!replacedCardsBySearchTool) {
              cardCollector.clear();
              replacedCardsBySearchTool = true;
            }
            for (const it of res.items) {
              if (cardCollector.size < 36) cardCollector.set(it.slug, toProductCard(it));
            }
            const cardsArr = sortCardsForDietary([...cardCollector.values()], activeDietary);
            if (activeDietary.length) {
              cardCollector.clear();
              for (const sc of cardsArr) cardCollector.set(sc.slug, sc);
            }
            activePathQuery = q || userText;
            // Defer refreshing the right-hand stage until all searches finish right before speaking.
            pendingStage = {
              cards: cardsArr,
              mode: res.items.length === 1 ? "spotlight" : "showcase",
              spotlight: cardsArr[0] ?? toProductCard(res.items[0]),
              title: q ? `ผลการค้นหา: "${q}"` : "สินค้าที่คัดเลือก",
            };
            toolOut = `พบ ${res.total} รายการ (คัดหลัก ${Math.min(8, res.items.length)}):\n${res.items.slice(0, 8).map((it) => withCardNo(summarizeProductForLlm(it))).join("\n\n")}`;
          } else {
            okState = "none";
            toolOut = `ไม่พบสินค้าตามเงื่อนไข "${q}"`;
          }
        }

        const ms = Math.max(1, Math.round(performance.now() - t0));
        extraToolLogs.push(`[${c.name}] ${toolOut}`);
        llmMessages.push({ role: "tool", tool_call_id: c.id, content: toolOut });
        yield {
          type: "team",
          job: {
            id: jId,
            worker: workerKind,
            label: jobLabel,
            task: String(args.identifier ?? args.query ?? args.customerName ?? "").slice(0, 50) || jobLabel,
            state: okState,
            ms,
          },
        };
      }
    }

    let finalSpoken = stripModelThoughtTokens(spokenAcc).trim();
    if (!finalSpoken && !opts.signal?.aborted) {
      yield* flushPendingStage();
      finalSpoken =
        cardCollector.size > 0
          ? (() => {
              const first = sortCardsForDietary([...cardCollector.values()], activeDietary)[0];
              return `พบสินค้าที่น่าสนใจแล้วครับ เบอร์ 1 ${first.title} ${first.priceLabel} รับเบอร์ไหนดีครับ`;
            })()
          : "ขออภัยครับ เมื่อสักครู่อาจจะฟังไม่ชัดเจน ลองบอกชื่อสินค้าที่ต้องการให้ตี๋ช่วยหาอีกครั้งได้เลยครับ";
      yield { type: "status", state: "speaking", text: "น้องตี๋กำลังพูด…" };
      yield { type: "delta", section: "speech", text: finalSpoken };
      yield { type: "sentence", text: finalSpoken };
    }

    yield {
      type: "done",
      spokenText: finalSpoken,
      screenMarkdown: stripModelThoughtTokens(screenAcc).trim(),
      model: turnState.model,
      provider: turnState.provider,
      ms: Math.max(1, Math.round(performance.now() - turnT0)),
      tps: turnState.tps,
      fallbackReason: turnState.fallbackReason || undefined,
    };
  } catch (err) {
    if (opts.signal?.aborted || (err as { name?: string })?.name === "AbortError") {
      return;
    }
    const msg = err instanceof Error ? err.message : "เชื่อมต่อระบบประมวลผลไม่สำเร็จ";
    yield {
      type: "error",
      message: `ขออภัยครับ ตอนนี้ระบบประมวลผลขัดข้องชั่วคราว (${msg}) ลองถามตี๋ใหม่อีกครั้งนะครับ`,
    };
  }
}
