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
import { RELATION_LABEL, isRelationType } from "./groups";
import { emitMcpEvent } from "./mcp-events";
import type { BrainProductItem } from "./product-source";
import {
  toProductCard,
  type JavisChatMessage,
  type JavisProductCard,
  type JavisStageMode,
  type JavisStreamEvent,
  type JavisTeamJob,
  type UnitOptionCard,
} from "./product-card";
import { startsWithUnitSound } from "./heard-fix";
import { SCREEN_COMMAND_IDS } from "./voice-commands";
import {
  cardNumbersIn,
  mentionsCardNumber,
  parseBareQuantity,
  parseNumberedOrder,
  parsePointedOrder,
  pointsAtOpenProduct,
  type NumberedPick,
} from "./numbered-order";
import {
  brainStats,
  getProductBySlug,
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

export const LOCKED_FLASH_MODEL = "deepseek-flash" as const;

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
  // "10 ชิ้น" of a 4-piece pack could mean 10 packs or 10 pieces; a unit this product is not sold in -> ask.
  if (p.packQty > 1 && said.startsWith(normUnit(p.baseUnitCode))) return null;
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
          ? `บนจอตอนนี้มีเบอร์ 1 ถึง ${focusItems.length} ครับ ไม่มีเบอร์ ${t.no} ต้องการเบอร์ไหนครับ`
          : "ตอนนี้บนจอยังไม่มีสินค้าให้เลือกตามเบอร์ครับ อยากได้สินค้าอะไร บอกตี๋ได้เลยครับ",
      );
      asked = true;
      continue;
    }
    if (!p.bestPrice) {
      yield { type: "action", kind: "unknown", no: t.no, slug: p.slug, text: `${label}ยังไม่มีราคา` };
      say.push(`${label}${p.nameTh} ยังไม่มีราคาในระบบ ตี๋ยังใส่ตะกร้าให้ไม่ได้ครับ`);
      asked = true;
      continue;
    }
    const unit = t.qty === null ? null : resolveSpokenUnit(p, t.afterQty);
    if (t.qty === null || !unit) {
      if (!asked) yield { type: "ask_qty", product: toProductCard(p) };
      yield { type: "action", kind: "ask", no: t.no, slug: p.slug, text: `${label}รับกี่${p.unitCode}ครับ?` };
      say.push(`${label}${p.nameTh} ขายเป็น${p.unitCode} ${bahtSpoken(formatThaiBaht(p.bestPrice))} รับกี่${p.unitCode}ดีครับ`);
      asked = true;
      continue;
    }
    cart = recalculateCart([...cart.items, { slug: p.slug, unitCode: unit.unitCode, unitPrice: unit.unitPrice, qty: t.qty }], cart.coupon?.code);
    added++;
    yield { type: "cart", cart, lastChangedSlug: p.slug };
    yield { type: "action", kind: "add", no: t.no, slug: p.slug, text: `${label}× ${t.qty} ${unit.unitCode} เข้าตะกร้าแล้ว` };
    say.push(`ใส่${label}${p.nameTh} ${t.qty} ${unit.unitCode} ลงตะกร้าแล้วครับ`);
  }
  if (added > 0 && !asked) {
    say.push(`ยอดรวมตอนนี้ ${bahtSpoken(cart.grandTotalFormatted)} รับอะไรเพิ่มไหมครับ หรือให้ตี๋คิดเงินเลยครับ`);
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
  for (const s of say) {
    yield { type: "delta", section: "speech", text: s + " " };
    yield { type: "sentence", text: s };
  }
  yield { type: "done", spokenText: say.join(" "), screenMarkdown: "", model: "คำสั่งตรง (ไม่ใช้ AI)" };
}

const PLANNER_PROMPT = `แปลงคำพูดลูกค้าเป็นคำค้นสินค้าสั้นๆ 1-2 มุม คั่นด้วย ; บรรทัดเดียว ห้ามอธิบาย ห้ามลงท้ายครับ/ค่ะ
ถ้าสั่งจัดการตะกร้าหรือปิดบิลล้วนๆ ให้ตอบ CART_ONLY
แก้คำพ้องเสียงไมค์ เช่น ชูรส->ไม่ใส่ผงชูรส, ฮาราล->ฮาลาล, ฟรีซ->แช่แข็ง, แพค->แพ็ก`;

const NONG_TEE_SYSTEM_PROMPT = `คุณคือ "น้องตี๋" พนักงานขายมือโปรของ MarketBrain แทนตัวเองว่า "ตี๋" หรือ "ผม" ลงท้าย "ครับ/นะครับ" สุภาพ กระตือรือร้น กระชับ เป้าหมายคือช่วยลูกค้าเลือกของให้ได้และปิดการขาย
ห้ามเอ่ยชื่อห้างค้าส่ง ค้าปลีก หรือแพลตฟอร์มอีคอมเมิร์ซภายนอกเด็ดขาด และห้ามแต่งราคา/สินค้า/โปรโมชั่น/ส่วนลด/ของแถม/สต็อกที่ไม่มีในข้อมูลสมอง

วิธีขาย:
- อย่าแค่ไล่รายการ ให้เชียร์ตัวเด่น 1 ตัวจากข้อมูล พร้อมเหตุผลสั้นๆ ด้วยตัวเลขจริง (ราคา ขนาด หรือราคาเฉลี่ยต่อหน่วย)
- ถ้ามีแพ็ก/ยกลังที่เฉลี่ยต่อหน่วยถูกกว่า ให้ชวนซื้อแบบคุ้มกว่า
- ใส่ตะกร้าสำเร็จแล้ว ให้ชวนต่อ 1 อย่าง: ของที่ใช้คู่กัน หรือชวนปิดบิล
- ประโยคสุดท้ายของคำพูดต้องเป็นคำถามปิดการขาย 1 ข้อเสมอ เช่น "รับกี่ขวดดีครับ" "ใส่ตะกร้าเลยไหมครับ" "รับอะไรเพิ่มหรือให้ตี๋คิดเงินเลยดีครับ" ลูกค้าปฏิเสธแล้วไม่ตื๊อซ้ำ
- ลูกค้าพูดต่อ เช่น "อันนั้น" "ตัวแรก" "ถูกสุด" "ใหญ่กว่านี้" หมายถึงสินค้าที่คุยค้างหรืออยู่บนจอ ให้ใช้ slug ใน [ ] ของรายการนั้นเรียกเครื่องมือได้เลย
- สินค้าบนจอมีเบอร์กำกับทุกใบ (เบอร์ 1, 2, 3…) ให้เรียกสินค้าด้วยเบอร์เสมอ เช่น "เบอร์ 2 คุ้มสุดครับ" และเมื่อลูกค้าพูดเบอร์ให้ถือเป็นสินค้าเบอร์นั้น
- ลูกค้าสั่งให้ทำอะไรให้ลงมือทำด้วยเครื่องมือทันที ไม่ใช่แค่ค้นให้ดู ถ้าไม่แน่ใจว่าหมายถึงตัวไหนหรือจำนวนเท่าไร ให้ถามก่อน ห้ามเดา
- ห้ามบอกว่าใส่ตะกร้าแล้วถ้า cart_add ยังไม่สำเร็จ และไม่ต้องขอโทษถ้าไม่ได้ทำผิด

กติกาเครื่องมือ:
- ลูกค้าสั่งซื้อระบุจำนวนชัด -> เรียก \`cart_add\` ทันที | สนใจแต่ยังไม่บอกจำนวน -> เรียก \`ask_cart_qty\`
- เปลี่ยนจำนวน -> \`cart_update\` | ลบของ -> \`cart_remove\` | ขอดูตะกร้า -> \`cart_view\`
- ลูกค้าขอคิดเงิน/เช็กบิลแต่ยังขาดชื่อ/เบอร์/วิธีจ่าย -> \`checkout_prepare\` แล้วถามสั้นๆ | แจ้งข้อมูลหรือยืนยันสั่งซื้อแล้ว -> \`place_order\` ทันที
- คิดเลขเพิ่มต้องกด \`calc\` เสมอ
- ลูกค้าสั่งควบคุมหน้าจอ (ถอยกลับ เดินหน้า เปิดดูเบอร์ไหน เลื่อนจอ เปิดกล้อง หยุดพูด ฯลฯ) -> \`screen_control\` ทันที แล้วตอบสั้นๆ ว่าทำแล้ว
- ถ้าจะเรียกเครื่องมือ ให้เรียกเลยโดยยังไม่ต้องพูด แล้วค่อยพูดสรุปทีเดียวหลังได้ผล

รูปแบบคำตอบ (คั่นด้วยบรรทัด \`[จอ]\` เสมอ):
ส่วนแรกก่อน \`[จอ]\`: คำพูดออกเสียงสั้นกระชับ 1–3 ประโยค ธรรมชาติ ห้ามใส่ตารางหรือดอกจัน
ส่วนหลังบรรทัด \`[จอ]\`: สรุปรายการ/ตารางสั้นกระชับบนจอ`;

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

function getDeepSeekConfig() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || "";
  const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, "");
  // Strictly locked to deepseek-flash ONLY per system policy (never switch to Pro/Reasoner)
  return { apiKey, baseUrl, model: LOCKED_FLASH_MODEL };
}

const CART_OR_ORDER_DIRECT_RE =
  /^(?:ดูตะกร้า|เปิดตะกร้า|เช็กตะกร้า|ในตะกร้ามีอะไรบ้าง|ล้างตะกร้า|เคลียร์ตะกร้า|คิดเงิน|คิดตังค์|เช็กบิล|ปิดบิล|ปิดการขาย|ยืนยันสั่งซื้อ|ยืนยันปิดการขาย|สั่งซื้อเลย|เปลี่ยนจำนวน|แก้จำนวน|ลบรายการ|ลบสินค้า)/i;

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

async function planSwarmQueries(
  userMessage: string,
  history: JavisChatMessage[],
  cfg: { apiKey: string; baseUrl: string; model: string },
): Promise<string[]> {
  const trimmed = userMessage.trim();
  if (CART_OR_ORDER_DIRECT_RE.test(trimmed)) return [];
  if (!cfg.apiKey || trimmed.length < 3) return [trimmed];

  const recentTalk = history
    .slice(-2)
    .map((m) => `${m.role === "user" ? "ล" : "ต"}: ${m.content.split(SCREEN_MARK)[0].trim().slice(0, 90)}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: LOCKED_FLASH_MODEL,
        messages: [
          { role: "system", content: PLANNER_PROMPT },
          { role: "user", content: [...recentTalk, `ล่าสุด: ${trimmed.slice(0, 160)}`].join("\n") },
        ],
        stream: false,
        temperature: 0.1,
        max_tokens: 48,
        thinking: { type: "disabled" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [trimmed];
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? "").replace(CJK_JUNK, "").trim();
    const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
    if (firstLine === "CART_ONLY") return [];
    if (!firstLine || /(?:ครับ|ค่ะ|คะ)[\s.!?]*$/.test(firstLine)) return [trimmed];
    const angles = firstLine
      .split(/[;|]/)
      .map((s) => s.trim().slice(0, 80))
      .filter((s) => s && s !== "CART_ONLY");
    return [...new Set([...angles, trimmed])].slice(0, 2);
  } catch {
    return [trimmed];
  }
}

async function* streamDeepSeekRound(
  messages: Array<Record<string, unknown>>,
  offerTools: boolean,
  cfg: { apiKey: string; baseUrl: string; model: string },
  collectedCalls: ParsedToolCall[],
): AsyncGenerator<string> {
  const body: Record<string, unknown> = {
    model: LOCKED_FLASH_MODEL,
    messages,
    stream: true,
    temperature: 0.15,
    max_tokens: 420,
    thinking: { type: "disabled" },
  };
  if (offerTools) body.tools = TOOL_SPECS;

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
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

  while (true) {
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
  /** Coupon the customer picked on screen; every cart recalculation keeps it. */
  couponCode?: string;
}): AsyncGenerator<JavisStreamEvent> {
  const userText = opts.message.trim();
  const history = (opts.history ?? [])
    .slice(-4)
    .map((m) => ({ role: m.role, content: m.content.split(SCREEN_MARK)[0].trim().slice(0, 220) }))
    .filter((m) => m.content.length > 0);
  const cfg = getDeepSeekConfig();

  if (!cfg.apiKey) {
    yield {
      type: "error",
      message: "ยังไม่ได้ตั้งค่า DEEPSEEK_API_KEY ใน .env.local ครับ",
    };
    return;
  }

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
      const cardsArr = [...cardCollector.values()];
      stageSetExplicitly = true;
      yield { type: "cards", cards: cardsArr };
      yield {
        type: "stage",
        mode: cardsArr.length === 1 ? "spotlight" : "showcase",
        spotlight: cardsArr[0] ?? null,
        title: opts.visionSummary ? `📷 พบจากรูป: ${opts.visionSummary}` : "📷 สินค้าที่ค้นพบจากรูปภาพ",
      };
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
  let prefetchLabel = "สินค้าที่พบ";
  const productQuery = productQueryOf(userText);
  const focusItems = (opts.focusSlugs ?? [])
    .slice(0, 12)
    .map((s) => getProductBySlug(String(s).trim()))
    .filter((p): p is BrainProductItem => Boolean(p));
  const isDirectCartOrOrder = CART_OR_ORDER_DIRECT_RE.test(userText);

  const viewingProduct = opts.viewingSlug ? getProductBySlug(opts.viewingSlug) : null;
  const cardNoOf = (p: BrainProductItem) => focusItems.findIndex((f) => f.slug === p.slug) + 1;
  const viewingNo = viewingProduct ? cardNoOf(viewingProduct) : 0;

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
  }

  if (visionSlugs.length === 0 && explicitSlugMatches.length === 0 && !isDirectCartOrOrder && focusItems.length > 0 && (!productQuery || mentionsCardNumber(userText, focusItems.length) || (viewingNo > 0 && pointsAtOpenProduct(userText)))) {
    // Follow-up turn: keep talking about what is on screen (0 search, 0 planner tokens)
    prefetchLabel = "สินค้าบนจอที่ลูกค้ากำลังพูดต่อ (เรียงตามลำดับบนจอ)";
    if (viewingNo > 0) prefetchLabel += ` — ลูกค้าเปิดดูเบอร์ ${viewingNo} อยู่ คำว่า อันนี้/ตัวนี้ คือเบอร์ ${viewingNo}`;
    for (const p of focusItems) cardCollector.set(p.slug, toProductCard(p));
    // Cards the customer names by number go first, so "รายละเอียดเบอร์ 9" is never cut by the 6-block cap.
    const pickedNos = cardNumbersIn(userText, focusItems.length);
    const picked = pickedNos.length ? pickedNos.map((no) => focusItems[no - 1]) : viewingNo > 0 ? [focusItems[viewingNo - 1]] : [];
    for (const p of [...picked, ...focusItems.filter((p) => !picked.includes(p))]) {
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
    const searchText = productQuery || userText;
    const localDirect = searchProductsDetailed({ q: searchText, pageSize: 6 });
    if (localDirect.items.length >= 2 || (localDirect.items.length === 1 && searchText.length <= 28)) {
      const localMs = Math.max(1, Math.round(performance.now() - tLocal));
      for (const p of localDirect.items) {
        if (cardCollector.size < 12) cardCollector.set(p.slug, toProductCard(p));
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
        const cardsArr = [...cardCollector.values()];
        yield { type: "cards", cards: cardsArr };
        yield {
          type: "stage",
          mode: cardsArr.length === 1 ? "spotlight" : "showcase",
          spotlight: cardsArr[0] ?? null,
          title: `สินค้าตามบริบท: "${searchText.slice(0, 40)}"`,
        };
      }
    } else {
      angles = await planSwarmQueries(userText, history, cfg);
    }
  }

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
        ms: 120,
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
        const prodRes = searchProductsDetailed({ q: sj.angle, pageSize: 6 });
        const brainHits = search(sj.angle, 2, "all").filter((h) => h.folder !== "product");
        return { sj, prodRes, brainHits, ms: Math.max(1, Math.round(performance.now() - tSwarm)) };
      }),
    );

    const seenSlugs = new Set<string>();
    for (const ar of angleResults) {
      for (const p of ar.prodRes.items) {
        if (cardCollector.size < 12) cardCollector.set(p.slug, toProductCard(p));
        if (!seenSlugs.has(p.slug) && seenSlugs.size < 6) {
          seenSlugs.add(p.slug);
          prefetchBlocks.push(summarizeProductForLlm(p));
        }
      }
      for (const bh of ar.brainHits.slice(0, 1)) {
        prefetchBlocks.push(`• [${bh.folder}] ${bh.title} (${bh.slug})`);
      }
      emitMcpEvent({
        tool: "ask_brain",
        audience: "user",
        rawArg: ar.sj.angle,
        hits: ar.prodRes.items.slice(0, 4).map((p) => ({ slug: p.slug, title: p.nameTh, folder: "product" })),
        totalHits: ar.prodRes.total,
        ms: ar.ms,
      });
      yield {
        type: "team",
        job: {
          id: ar.sj.id,
          worker: "product",
          label: "ค้นสินค้า",
          task: ar.sj.angle,
          state: ar.prodRes.total > 0 ? "done" : "none",
          ms: ar.ms,
          count: ar.prodRes.total,
        },
      };
    }

    if (cardCollector.size > 0) {
      const cardsArr = [...cardCollector.values()];
      yield { type: "cards", cards: cardsArr };
      yield {
        type: "stage",
        mode: cardsArr.length === 1 ? "spotlight" : "showcase",
        spotlight: cardsArr[0] ?? null,
        title: `สินค้าตามบริบท: "${angles[0]}"`,
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

  const contextBlock = [
    formatCartContext(currentCart),
    customerSummary ? `ผู้รับ: ${customerSummary}` : "ผู้รับ: (ยังไม่ระบุ)",
    prefetchBlocks.length
      ? `${prefetchLabel}:\n${prefetchBlocks.map(withCardNo).join("\n")}`
      : `คลังมี ${st.totalProducts} สินค้า (กด search_products ได้)`,
    "จบคำพูดด้วยคำถามปิดการขาย 1 ข้อ",
  ].join("\n");

  const llmMessages: Array<Record<string, unknown>> = [
    { role: "system", content: NONG_TEE_SYSTEM_PROMPT },
    ...history,
    {
      role: "user",
      content: `${userText}\n\n[${contextBlock}]`,
    },
  ];

  const MAX_ROUNDS = 2;
  let spokenAcc = "";
  let screenAcc = "";
  let speechSentenceBuf = "";
  const extraToolLogs: string[] = [];

  const flushSpeechSentences = function* (finalFlush = false): Generator<JavisStreamEvent> {
    while (speechSentenceBuf.length >= 18) {
      SENTENCE_END_RE.lastIndex = 0;
      let lastMatchEnd = -1;
      for (const m of speechSentenceBuf.matchAll(SENTENCE_END_RE)) {
        if (m.index !== undefined && m.index + m[0].length >= 18) {
          lastMatchEnd = m.index + m[0].length;
        }
      }
      if (lastMatchEnd === -1 && speechSentenceBuf.length >= 130) {
        const sp = speechSentenceBuf.lastIndexOf(" ");
        if (sp >= 40) lastMatchEnd = sp + 1;
      }
      if (lastMatchEnd === -1) break;
      const chunk = speechSentenceBuf.slice(0, lastMatchEnd).trim();
      speechSentenceBuf = speechSentenceBuf.slice(lastMatchEnd);
      if (chunk) yield { type: "sentence", text: chunk };
    }
    if (finalFlush && speechSentenceBuf.trim()) {
      const rest = speechSentenceBuf.trim();
      speechSentenceBuf = "";
      yield { type: "sentence", text: rest };
    }
  };

  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const isLast = round === MAX_ROUNDS;
      const calls: ParsedToolCall[] = [];

      yield {
        type: "status",
        state: round === 0 ? "thinking" : "searching",
        text: isLast ? "น้องตี๋กำลังสรุปคำตอบ…" : "น้องตี๋กำลังประมวลผล…",
      };

      const roundMessages = isLast
        ? [
            { role: "system", content: NONG_TEE_SYSTEM_PROMPT },
            ...history.map((m) => ({ role: m.role, content: m.content })),
            {
              role: "user",
              content: `${userText}\n\nสถานะล่าสุดหลังดำเนินการ:\n${formatCartContext(currentCart)}\n\n${extraToolLogs.join("\n\n")}\n\n${prefetchBlocks.slice(0, 6).map(withCardNo).join("\n\n")}\n\n(ระบบ: ดำเนินการเครื่องมือครบแล้ว ไม่มีเครื่องมือให้เรียกอีก ยึดสถานะตะกร้าข้างบนเป็นความจริงเท่านั้น ถ้าของที่ลูกค้าสั่งยังไม่อยู่ในตะกร้า ห้ามบอกว่าใส่แล้ว ให้บอกตรงๆ แล้วถามยืนยันสินค้า ตอบสรุปให้ลูกค้าฟังอย่างเป็นธรรมชาติและใส่รายละเอียดหลังบรรทัด [จอ] ทันที)`,
            },
          ]
        : llmMessages;

      let roundText = "";
      let inScreen = spokenAcc.length > 0 && screenAcc.length > 0;
      let pendingBuf = "";
      // Speech from an earlier round must not run straight into this round's first word
      if (round > 0 && !inScreen && spokenAcc && !/\s$/.test(spokenAcc)) {
        spokenAcc += " ";
        yield { type: "delta", section: "speech", text: " " };
      }

      for await (const tok of streamDeepSeekRound(roundMessages, !isLast, cfg, calls)) {
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

      if (!calls.length || isLast) {
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
            stageSetExplicitly = true;
            yield { type: "cart", cart: currentCart, lastChangedSlug: resolved.product.slug };
            yield { type: "cards", cards: [...cardCollector.values()] };
            yield { type: "stage", mode: "cart", spotlight: toProductCard(resolved.product), title: "อัปเดตตะกร้าสินค้าแล้ว" };
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
              yield { type: "cart", cart: currentCart };
              yield { type: "stage", mode: "cart", title: "ลบรายการออกจากตะกร้าแล้ว" };
              toolOut = `ลบรายการออกจากตะกร้าแล้ว!\n${formatCartContext(currentCart)}`;
            }
          }
        } else if (c.name === "cart_view") {
          workerKind = "cart";
          jobLabel = "เปิดดูตะกร้า";
          stageSetExplicitly = true;
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
          const res = traverseGraph({ slug, depth: 2, relation, limit: 14, audience: "all" });
          if (res.start) {
            for (const nb of res.neighbors) {
              const p = getProductBySlug(nb.slug);
              if (p && cardCollector.size < 16) cardCollector.set(p.slug, toProductCard(p));
            }
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
          const limit = Math.min(12, Math.max(1, Number(args.limit ?? 8) || 8));
          const res = searchProductsDetailed({ q, unit, minPrice, maxPrice, multiUnitOnly, thaiGs1Only, sort, pageSize: limit });
          for (const it of res.items) {
            if (cardCollector.size < 16) cardCollector.set(it.slug, toProductCard(it));
          }
          if (res.items.length > 0) {
            const cardsArr = [...cardCollector.values()];
            yield { type: "cards", cards: cardsArr };
            if (!stageSetExplicitly) {
              yield {
                type: "stage",
                mode: res.items.length === 1 ? "spotlight" : "showcase",
                spotlight: toProductCard(res.items[0]),
                title: q ? `ผลการค้นหา: "${q}"` : "สินค้าที่คัดเลือก",
              };
            }
            toolOut = `พบ ${res.total} รายการ:\n${res.items.map((it) => withCardNo(summarizeProductForLlm(it))).join("\n\n")}`;
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

    yield {
      type: "done",
      spokenText: spokenAcc.trim(),
      screenMarkdown: screenAcc.trim(),
      model: cfg.model,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "เชื่อมต่อระบบประมวลผลไม่สำเร็จ";
    yield {
      type: "error",
      message: `ขออภัยครับ ตอนนี้ระบบประมวลผลขัดข้องชั่วคราว (${msg}) ลองถามตี๋ใหม่อีกครั้งนะครับ`,
    };
  }
}
