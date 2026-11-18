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
import {
  brainStats,
  getNote,
  getProductBySlug,
  search,
  searchProductsDetailed,
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

function summarizeProductForLlm(p: BrainProductItem): string {
  const convTxt =
    p.unitConversions.length > 0
      ? p.unitConversions
          .map((u) => `${u.unitNameTh}(${u.ratioText || `${u.standValue}:${u.divideValue}`})=${formatThaiBaht(u.pricePerUnit)}`)
          .join(", ")
      : `${p.unitCode}`;
  const traitTxt = [...new Set(p.traits.map((t) => t.fullLabelTh))].join(", ") || "-";
  return [
    `• [${p.productCode}] ${p.nameTh} (slug: ${p.slug})`,
    `  แบรนด์: ${p.brandTh || p.brandEn || "-"} | หมวด: ${p.categoryPathTh}`,
    `  ราคาขาย: ${formatThaiBaht(p.bestPrice)} / ${p.unitCode}${p.packQty > 1 ? ` (บรรจุ ${p.packQty} ${p.baseUnitCode}, เฉลี่ย ${formatThaiBaht(p.pricePerBaseUnit)}/${p.baseUnitCode})` : ""}`,
    `  บาร์โค้ด: ${p.primaryBarcode ?? "-"}${p.isThaiGs1 ? " (GS1 ไทย 885)" : ""} | หน่วยนับที่มี: ${convTxt}`,
    `  คุณลักษณะ: ${traitTxt}`,
    p.features ? `  จุดเด่น: ${p.features.replace(/\s+/g, " ").slice(0, 150)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCartContext(cart: CartSummary): string {
  if (!cart.items.length) return "ตะกร้าสินค้าปัจจุบัน: (ยังว่างอยู่ 0 รายการ)";
  const lines = cart.items.map(
    (it, idx) =>
      `${idx + 1}. [${it.productCode}] ${it.title} (slug: ${it.slug}) — จำนวน ${it.qty} ${it.unitCode} × ${it.unitPriceFormatted} = ${it.lineTotalFormatted}`,
  );
  return `ตะกร้าสินค้าปัจจุบัน (${cart.itemCount} รายการ, รวม ${cart.totalPieces} หน่วย, ยอดสุทธิ ${cart.grandTotalFormatted}):\n${lines.join("\n")}`;
}

const PLANNER_PROMPT = `คุณคือตัววางแผนคำค้นสมองสินค้าของ "น้องตี๋" (Javis)
แปลงคำพูดล่าสุดของลูกค้าให้เป็นคำค้นสินค้าในคลังสมอง 1 ถึง 3 แง่มุม คั่นด้วย ; บรรทัดเดียวเท่านั้น ห้ามอธิบาย ห้ามลงท้ายครับ/ค่ะ
- ถ้าลูกค้าสั่งจัดการตะกร้าหรือปิดการขายโดยตรง (เช่น "ดูตะกร้าหน่อย", "ลบตัวแรกออก", "คิดเงินเลย", "เอา 3 ขวด") ให้ดึงชื่อสินค้าที่เพิ่งคุยกันมาเป็นคำค้นสั้นๆ หรือถ้าไม่มีชื่อสินค้าให้ตอบคำว่า CART_ONLY
- แก้คำที่ได้ยินเพี้ยนจากเสียงไมค์ (เช่น ชูรส -> ไม่ใส่ผงชูรส, ฮาราล -> ฮาลาล, ฟรีซ -> แช่แข็ง, แพค -> แพ็ก)`;

const NONG_TEE_SYSTEM_PROMPT = `คุณคือ "น้องตี๋" (Javis เลขาส่วนตัวและพนักงานขายมืออาชีพประจำระบบสมองสินค้า MarketBrain)
ผู้ชายหนุ่มอารมณ์ดี คล่องแคล่ว สุภาพ เป็นกันเอง แทนตัวเองว่า "ตี๋" หรือ "ผม" และลงท้ายด้วย "ครับ" หรือ "นะครับ" เสมอ
กฎเหล็กสำคัญ: ห้ามเอ่ยชื่อห้างค้าส่ง ห้างค้าปลีก หรือแพลตฟอร์มอีคอมเมิร์ซภายนอกทุกชนิดในคำพูดและข้อความบนจอเด็ดขาด!

ภารกิจหลักของน้องตี๋:
1. ช่วยลูกค้าหาสินค้า เปรียบเทียบขนาดบรรจุ/แพ็ค/ยกลัง ดูคุณลักษณะ (ไม่ใส่ผงชูรส, ฮาลาล, แช่แข็ง, บรรจุภัณฑ์, ส่วนผสม) จากข้อมูลจริงในสมองเท่านั้น (ห้ามเดาหรือแต่งตัวเลขราคา บาร์โค้ด หรือสินค้าที่ไม่มีในผลค้นเด็ดขาด!)
2. ช่วยจัดการตะกร้าสินค้าแบบสดๆ ระหว่างคุย:
   - เมื่อลูกค้าบอกว่าจะเอาสินค้าพร้อมระบุจำนวนชัดเจน (เช่น "เอาไฮคิว 5 กล่อง", "เพิ่มมาม่า 2 แพ็ค") -> ต้องเรียกเครื่องมือ \`cart_add\` ทันที!
   - เมื่อลูกค้าบอกว่าจะเอาสินค้าแต่ยังไม่ระบุจำนวน (เช่น "เอาตัวนี้ใส่ตะกร้าหน่อย") -> ให้เรียก \`ask_cart_qty\` เพื่อให้หน้าจอเด้งปุ่มเลือกจำนวนให้ลูกค้ากดสะดวกๆ พร้อมถามลูกค้าว่า "รับกี่หน่วยดีครับ?"
   - เมื่อลูกค้าสั่งเปลี่ยนจำนวน -> เรียก \`cart_update\` | สั่งลบของ -> เรียก \`cart_remove\` | ขอดูตะกร้า/เช็กยอด -> เรียก \`cart_view\`
3. ช่วยแนะนำความคุ้มค่าและปิดการขาย (Sales Closer):
   - หากมีขนาดแพ็คหรือยกลังที่ราคาเฉลี่ยต่อชิ้นคุ้มกว่า แนะนำลูกค้าสั้นๆ อย่างเป็นธรรมชาติ
   - เมื่อลูกค้าพอใจสินค้าในตะกร้าหรือบอก "พอแค่นี้ / คิดเงินเลย / ปิดบิลเลย / สั่งซื้อเลย":
     - ขั้นแรก หากยังไม่มีชื่อผู้รับ เบอร์โทร หรือวิธีชำระเงิน ให้เรียก \`checkout_prepare\` เพื่อเปิดหน้าสรุปบิลและชำระเงินบนจอ พร้อมถามชื่อ เบอร์โทร ที่อยู่จัดส่ง และวิธีชำระเงิน (พร้อมเพย์ QR / เก็บเงินปลายทาง COD / โอนบัญชี) สั้นๆ
     - เมื่อลูกค้าแจ้งข้อมูลจัดส่งหรือยืนยันสั่งซื้อ ("ยืนยันสั่งซื้อเลย / เก็บเงินปลายทาง ส่งร้านลุงจืด 089...") -> เรียก \`place_order\` เพื่อออกใบสั่งซื้อและปิดการขายทันที!
4. ทุกการคำนวณตัวเลขเพิ่มเติมนอกเหนือจากตะกร้า ต้องกดเครื่องมือ \`calc\` เสมอ ห้ามคิดเลขในใจ
5. รูปแบบคำตอบต้องแบ่งเป็น 2 ส่วนคั่นด้วยบรรทัด \`[จอ]\` เสมอ:
   - ส่วนแรก (ก่อนบรรทัด \`[จอ]\`): เป็นคำพูดที่น้องตี๋พูดออกลำโพงด้วยเสียงจริง สรุปสั้นกระชับ 2–4 ประโยค ฟังเข้าใจง่ายเป็นธรรมชาติ (ห้ามใส่ตาราง โค้ด หรือเครื่องหมายดอกจันยาวๆ ในส่วนคำพูด)
   - ส่วนที่สอง (ขึ้นบรรทัดใหม่เขียน \`[จอ]\` บรรทัดเดียว แล้วตามด้วย Markdown): สรุปตารางเปรียบเทียบสินค้า หรือสรุปรายการในตะกร้า/ใบสั่งซื้อให้อ่านง่ายบนหน้าจอ`;

const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "ค้นหาสินค้าในสมองเพื่อแสดงภาพแกลเลอรีสินค้าบนหน้าจอตามบริบทที่คุย",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "คำค้นสินค้า คุณลักษณะ แบรนด์ หรือบาร์โค้ด" },
          unit: { type: "string", description: "กรองหน่วยนับ เช่น ชิ้น, ขวด, ซอง, กล่อง, แพ็ค, โหล, ลัง" },
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
      description: "เจาะลึกสินค้า 1 รายการและเปลี่ยนภาพบนหน้าจอเป็นโหมด Spotlight ของสินค้านั้นขนาดใหญ่",
      parameters: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "slug, รหัสสินค้า (BCS...), บาร์โค้ด หรือชื่อสินค้า" },
        },
        required: ["identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "traverse_synapses",
      description: "เดินไซแนปส์ในสมองเพื่อหาขนาดแพ็ค/ยกลังคู่เทียบ หรือสินค้าในหมวด/คุณลักษณะเดียวกัน",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          relation: { type: "string" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cart_add",
      description: "เพิ่มสินค้าเข้าตะกร้าตามจำนวนที่ลูกค้าสั่ง แล้วสลับภาพหน้าจอไปแสดงตะกร้าสด",
      parameters: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "slug (เช่น prod-bcs...), รหัสสินค้า, บาร์โค้ด หรือชื่อสินค้า" },
          qty: { type: "integer", description: "จำนวนที่ต้องการเพิ่ม (เช่น 1, 2, 5, 12)" },
          unitCode: { type: "string", description: "หน่วยนับที่ต้องการ (ถ้าไม่ระบุจะใช้หน่วยหลักของสินค้า)" },
        },
        required: ["identifier", "qty"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_cart_qty",
      description: "เด้งกล่องถามจำนวนและหน่วยนับของสินค้าบนหน้าจอ เมื่อลูกค้าสนใจจะใส่ตะกร้าแต่ยังไม่บอกจำนวน",
      parameters: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "slug, รหัสสินค้า หรือชื่อสินค้า" },
        },
        required: ["identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cart_update",
      description: "แก้ไขจำนวนรวมของสินค้าที่มีอยู่ในตะกร้า (ถ้าระบุ qty เป็น 0 จะลบออก)",
      parameters: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "slug, รหัสสินค้า หรือชื่อสินค้าในตะกร้า" },
          qty: { type: "integer", description: "จำนวนใหม่ที่ต้องการตั้ง" },
        },
        required: ["identifier", "qty"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cart_remove",
      description: "ลบสินค้าออกจากตะกร้า (ส่ง identifier='all' หากลูกค้าสั่งล้างตะกร้าทั้งหมด)",
      parameters: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "slug, รหัสสินค้า, ชื่อสินค้า หรือ 'all'" },
        },
        required: ["identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cart_view",
      description: "เปิดดูรายการในตะกร้าสินค้าบนหน้าจอหลักพร้อมสรุปยอดรวมสุทธิ",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkout_prepare",
      description: "สลับหน้าจอไปโหมดสรุปปิดการขาย/ชำระเงิน พร้อมบันทึกข้อมูลผู้รับเท่าที่ลูกค้าบอกมาแล้ว",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string", description: "ชื่อผู้สั่งซื้อ" },
          shopName: { type: "string", description: "ชื่อร้านค้าหรือบริษัท" },
          phone: { type: "string", description: "เบอร์โทรศัพท์" },
          address: { type: "string", description: "ที่อยู่จัดส่ง" },
          paymentMethod: { type: "string", enum: ["promptpay", "cod", "transfer"], description: "วิธีชำระเงิน" },
          note: { type: "string", description: "หมายเหตุเพิ่มเติม" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "place_order",
      description: "ยืนยันปิดการขายและออกใบสั่งซื้อทันที เมื่อมีสินค้าในตะกร้าและลูกค้ายืนยันสั่งซื้อแล้ว",
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
      description: "เครื่องคิดเลข Decimal (ROUND_HALF_UP 2 ตำแหน่ง) ส่งบรรทัดละ 1 สูตร 'หัวข้อ: สูตร'",
      parameters: {
        type: "object",
        properties: {
          expressions: { type: "string" },
        },
        required: ["expressions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "brain_overview",
      description: "ดูภาพรวมสถิติคลังสมองสินค้า หมวดหมู่ แบรนด์ และหน่วยนับ",
      parameters: { type: "object", properties: {} },
    },
  },
];

function getDeepSeekConfig(requestedModel?: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || "";
  const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, "");
  const defaultModel = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash";
  const proModel = process.env.DEEPSEEK_PRO_MODEL?.trim() || "deepseek-v4-pro";
  const model = requestedModel === proModel || requestedModel === "deepseek-v4-pro" ? proModel : defaultModel;
  return { apiKey, baseUrl, model };
}

const CART_INTENT_ONLY = /^(?:ดูตะกร้า|เปิดตะกร้า|เช็กตะกร้า|ในตะกร้ามีอะไรบ้าง|ล้างตะกร้า|เคลียร์ตะกร้า|คิดเงิน|คิดตังค์|เช็กบิล|ปิดบิล|ปิดการขาย|ยืนยันสั่งซื้อ|สั่งซื้อเลย)(?:\s*(?:ครับ|ค่ะ|หน่อย|เลย))*$/i;

async function planSwarmQueries(
  userMessage: string,
  history: JavisChatMessage[],
  cfg: { apiKey: string; baseUrl: string; model: string },
): Promise<string[]> {
  const trimmed = userMessage.trim();
  if (CART_INTENT_ONLY.test(trimmed)) return [];
  if (!cfg.apiKey || trimmed.length < 3) return [trimmed];

  const recentTalk = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "ลูกค้า" : "น้องตี๋"}: ${m.content.split(SCREEN_MARK)[0].trim().slice(0, 140)}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-flash",
        messages: [
          { role: "system", content: PLANNER_PROMPT },
          { role: "user", content: [...recentTalk, `ลูกค้า (ล่าสุด): ${trimmed}`].join("\n") },
        ],
        stream: false,
        temperature: 0.15,
        max_tokens: 90,
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
      .map((s) => s.trim().slice(0, 100))
      .filter((s) => s && s !== "CART_ONLY");
    return [...new Set([...angles, trimmed])].slice(0, 3);
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
    model: cfg.model,
    messages,
    stream: true,
    temperature: 0.2,
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
  model?: string;
  cartItems?: Array<Partial<CartItem> & { slug: string; qty: number }>;
  customer?: Partial<CustomerCheckoutInfo>;
  visionSlugs?: string[];
  visionSummary?: string;
}): AsyncGenerator<JavisStreamEvent> {
  const userText = opts.message.trim();
  const history = (opts.history ?? []).slice(-8);
  const cfg = getDeepSeekConfig(opts.model);

  if (!cfg.apiKey) {
    yield {
      type: "error",
      message: "ยังไม่ได้ตั้งค่า DEEPSEEK_API_KEY ใน .env.local ครับ",
    };
    return;
  }

  let currentCart = recalculateCart(opts.cartItems ?? []);
  let currentCustomer: Partial<CustomerCheckoutInfo> = { ...(opts.customer ?? {}) };
  let jobSeq = 1;
  const cardCollector = new Map<string, JavisProductCard>();
  let stageSetExplicitly = false;
  const prefetchBlocks: string[] = [];

  const visionSlugs = (opts.visionSlugs ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  if (visionSlugs.length > 0) {
    const vJobId = jobSeq++;
    const visionItems: BrainProductItem[] = [];
    for (const s of visionSlugs) {
      const p = getProductBySlug(s);
      if (p) {
        visionItems.push(p);
        cardCollector.set(p.slug, toProductCard(p));
        prefetchBlocks.push(summarizeProductForLlm(p));
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

  yield { type: "status", state: "searching", text: "น้องตี๋กำลังวิเคราะห์บริบทคำถาม…" };

  // Step 1: Multi-Angle Swarm Planner (skipped when vision already resolved products)
  const angles = visionSlugs.length > 0 ? [] : await planSwarmQueries(userText, history, cfg);

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
        const prodRes = searchProductsDetailed({ q: sj.angle, pageSize: 8 });
        const brainHits = search(sj.angle, 4, "all").filter((h) => h.folder !== "product");
        return { sj, prodRes, brainHits, ms: Math.max(1, Math.round(performance.now() - tSwarm)) };
      }),
    );

    const seenSlugs = new Set<string>();
    for (const ar of angleResults) {
      for (const p of ar.prodRes.items) {
        if (cardCollector.size < 16) cardCollector.set(p.slug, toProductCard(p));
        if (!seenSlugs.has(p.slug) && seenSlugs.size < 10) {
          seenSlugs.add(p.slug);
          prefetchBlocks.push(summarizeProductForLlm(p));
        }
      }
      for (const bh of ar.brainHits.slice(0, 2)) {
        prefetchBlocks.push(`• [โหนดสมอง ${bh.folder}] ${bh.title} (${bh.slug}) — ${bh.snippet}`);
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

  const contextBlock = [
    formatCartContext(currentCart),
    customerSummary ? `ข้อมูลผู้สั่งซื้อที่บันทึกไว้แล้ว: ${customerSummary}` : "ข้อมูลผู้สั่งซื้อ: (ยังไม่ได้ระบุ)",
    prefetchBlocks.length
      ? `ผลค้นสมองสินค้า (${st.totalProducts} สินค้าในคลัง):\n${prefetchBlocks.join("\n\n")}`
      : `คลังสมองมีทั้งหมด ${st.totalProducts} สินค้า สามารถเรียก search_products เพิ่มเติมได้หากต้องการ`,
  ].join("\n\n");

  const llmMessages: Array<Record<string, unknown>> = [
    { role: "system", content: NONG_TEE_SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: `${userText}\n\n(สถานะระบบปัจจุบัน:\n${contextBlock}\nหมายเหตุ: ใช้ราคาและข้อมูลจริงจากสมองเท่านั้น หากลูกค้าสั่งเพิ่ม/ลด/ลบ/ดูตะกร้า หรือปิดการขาย ต้องเรียก tool ที่เกี่ยวข้องก่อนตอบเสมอ และคั่นคำพูดกับรายละเอียดบนจอด้วยบรรทัด [จอ])`,
    },
  ];

  const MAX_ROUNDS = 3;
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
              content: `${userText}\n\nสถานะล่าสุดหลังดำเนินการ:\n${formatCartContext(currentCart)}\n\n${extraToolLogs.join("\n\n")}\n\n${prefetchBlocks.slice(0, 6).join("\n\n")}\n\n(ระบบ: ดำเนินการเครื่องมือครบแล้ว ไม่มีเครื่องมือให้เรียกอีก ตอบสรุปให้ลูกค้าฟังอย่างเป็นธรรมชาติและใส่รายละเอียดหลังบรรทัด [จอ] ทันที)`,
            },
          ]
        : llmMessages;

      let roundText = "";
      let inScreen = spokenAcc.length > 0 && screenAcc.length > 0;
      let pendingBuf = "";

      for await (const tok of streamDeepSeekRound(roundMessages, !isLast, cfg, calls)) {
        roundText += tok;
        if (inScreen) {
          screenAcc += tok;
          yield { type: "delta", section: "screen", text: tok };
          continue;
        }
        pendingBuf += tok;
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
            currentCart = recalculateCart(nextItems);
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
            currentCart = recalculateCart(updated);
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
            currentCart = recalculateCart([]);
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
              currentCart = recalculateCart(remaining);
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
            const order = saveSalesOrder(currentCart.items, currentCustomer);
            currentCart = recalculateCart([]);
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
            const note = getNote(resolved.product.slug);
            toolOut = note ? note.body.slice(0, 4000) : summarizeProductForLlm(resolved.product);
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
            toolOut = `พบ ${res.total} รายการ:\n${res.items.map(summarizeProductForLlm).join("\n\n")}`;
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
