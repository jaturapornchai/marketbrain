// Spoken "order by card number" commands, e.g. "เอาเบอร์ 5 10 ชิ้น", "เบอร์สามสองแพ็ค เบอร์ 1 หนึ่งลัง".
// Pure text parsing (no LLM, no DB) so the action is exact and instant.

export const NUM_WORDS = "หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย|พัน";
const NUM = `(\\d{1,4}(?!\\d)|(?:${NUM_WORDS})+)`;
const NUM_WORD_RE = new RegExp(NUM_WORDS, "g");
const DIGIT_OF: Record<string, number> = { หนึ่ง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9 };
const MULT_OF: Record<string, number> = { สิบ: 10, ร้อย: 100, พัน: 1000 };

const PICK_RE = new RegExp(`(?:เบอร์|หมายเลข|เลขที่|อันที่|ตัวที่|รายการที่|ข้อ)\\s*(?:ที่\\s*)?${NUM}`, "g");
const QTY_AFTER_RE = new RegExp(`^(?:\\s|นะ|ครับ|ค่ะ|คะ|เอา|ขอ|รับ|จำนวน|อย่างละ)*${NUM}\\s*(.*)$`);
const QTY_BEFORE_RE = new RegExp(`${NUM}\\s*([^\\d\\s]{0,12})\\s*$`);
const BARE_QTY_RE = new RegExp(`^(?:เอา|ขอ|รับ|จำนวน|\\s)*${NUM}\\s*(.{0,16})$`);
const ORDER_VERB_RE = /เอา|ขอ|รับ|สั่ง|ใส่|เพิ่ม|ซื้อ|หยิบ|จัด|เลือก|กด|จิ้ม/;
// "เอาอันนี้สองชิ้น", "ใส่ตัวนี้ลงตะกร้า", "ใส่ตะกร้าเลย 3 แพ็ค": the product page that is open.
const POINTED_RE = new RegExp(
  `^(?:ขอ|ช่วย|งั้น|ก็|\\s)*(?:เอา|ใส่|หยิบ|รับ|สั่ง|ซื้อ|เพิ่ม|จัด|เลือก)\\s*(?:(?:สินค้า|ของ)?(?:อัน|ตัว|ชิ้น|รายการ)?(?:นี้|นี่)|(?:ลง|ใส่|เข้า)?ตะกร้า)(?:แหละ|เลย|ด้วย|มา|ลงตะกร้า|ใส่ตะกร้า|เข้าตะกร้า|ครับ|ค่ะ|คะ|นะ|\\s)*(?:${NUM}\\s*(.{0,16}))?$`,
);
const POINTS_AT_OPEN_RE = /(?:อัน|ตัว|ชิ้น|สินค้า|ของ|รุ่น|ยี่ห้อ|แบบ)(?:นี้|นี่)/;
// "สองร้อยบาท" is money, never a quantity.
const MONEY_AFTER_RE = /^(?:บาท|฿|สตางค์|เปอร์เซ็นต์|%)/;
// Strip polite trailing request endings ("ได้ไหมครับ") before checking question words so
// "เอาเบอร์ 1 สองขวดได้ไหมครับ" is recognized as an order instead of a question.
const POLITE_END_RE = /(?:ได้ไหม|ได้มั้ย|ได้เปล่า|หน่อย|ด้วย|นะครับ|นะค่ะ|นะคะ|ครับผม|ครับ|ค่ะ|คะ|นะ|\s)+$/i;
// Questions, look-ups and removals are not "add to cart" orders -> leave them to the conversation.
const NOT_ORDER_RE = /ไหม|มั้ย|เท่าไหร่|เท่าไร|กี่|อะไร|ยังไง|อย่างไร|เปล่า|ดู|เทียบ|รายละเอียด|ต่างกัน|ราคา|ออก|ลบ|ไม่เอา|ยกเลิก|เปลี่ยน|ลดจำนวน|ลดเหลือ|ลดลง/;
const MAX_CARD_NO = 99; // bigger numbers are product names ("เบอร์ 309"), not card numbers

function normalizeOrderText(raw: string, cardsOnScreen: number): string {
  let t = raw.trim().replace(/(?:อัน|ตัว|ชิ้น|รายการ|ใบ)แรก/g, "เบอร์ 1 ");
  if (cardsOnScreen > 0) {
    t = t.replace(/(?:อัน|ตัว|ชิ้น|รายการ|ใบ)สุดท้าย/g, `เบอร์ ${cardsOnScreen} `);
  }
  return t;
}

export type NumberedPick = {
  /** Card number the customer said (1-based). */
  no: number;
  /** Quantity, or null when the customer did not say one. */
  qty: number | null;
  /** Raw words right after the quantity (starts with the unit word when one was said). */
  afterQty: string;
};

/** "12" | "สิบสอง" | "ยี่สิบเอ็ด" -> number (null if not a number). */
export function parseThaiNumber(text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number.parseInt(t, 10);
  const words = t.match(NUM_WORD_RE);
  if (!words || words.join("") !== t) return null;
  let total = 0;
  let cur = 0;
  for (const w of words) {
    if (w in MULT_OF) {
      total += (cur || 1) * MULT_OF[w];
      cur = 0;
    } else {
      cur = DIGIT_OF[w];
    }
  }
  return total + cur;
}

/**
 * Finds card-number orders in a customer sentence.
 * Returns null when the sentence is not an order by number (question, removal, product name, ...).
 */
export function parseNumberedOrder(rawText: string, cardsOnScreen: number): NumberedPick[] | null {
  const coreCheck = rawText.trim().replace(POLITE_END_RE, "");
  if (NOT_ORDER_RE.test(coreCheck)) return null;
  const text = normalizeOrderText(rawText.trim().replace(/(?:ได้ไหม|ได้มั้ย|ได้เปล่า)(?:ครับ|ค่ะ|คะ|นะ|\s)*$/i, "").trim(), cardsOnScreen);
  const matches = [...text.matchAll(PICK_RE)];
  if (matches.length === 0) return null;

  const picks: NumberedPick[] = [];
  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    const tail = text.slice(start + m[0].length, matches[i + 1]?.index ?? text.length);
    let no = parseThaiNumber(m[1]) ?? 0;
    let qty: number | null = null;
    let afterQty = "";

    // Spoken words run together: "เบอร์สามสองแพ็ค" = card 3 x 2 (two digit words in a row),
    // "เบอร์ห้าสิบชิ้น" = card 5 x 10, not card 50, when only a few cards are on screen.
    const words = /^\d/.test(m[1]) ? null : m[1].match(NUM_WORD_RE);
    if (words && words.length > 1) {
      let cut = words.findIndex((w, k) => k > 0 && w in DIGIT_OF && w !== "เอ็ด" && words[k - 1] in DIGIT_OF && words[k - 1] !== "ยี่");
      if (cut < 0 && no > cardsOnScreen && words[0] in DIGIT_OF) cut = 1;
      const first = cut > 0 ? parseThaiNumber(words.slice(0, cut).join("")) : null;
      const rest = cut > 0 ? parseThaiNumber(words.slice(cut).join("")) : null;
      if (first && rest) {
        no = first;
        qty = rest;
        afterQty = tail.trim();
      }
    }
    if (qty === null) {
      const q = tail.match(QTY_AFTER_RE);
      if (q) {
        qty = parseThaiNumber(q[1]);
        afterQty = q[2].trim();
      } else if (matches.length === 1) {
        // "ขอ 2 แพ็ค เบอร์ 3"
        const before = text.slice(0, start).match(QTY_BEFORE_RE);
        if (before) {
          qty = parseThaiNumber(before[1]);
          afterQty = before[2].trim();
        }
      }
    }
    picks.push({ no, qty: qty && qty > 0 ? Math.min(qty, 9999) : null, afterQty });
  });

  if (picks.some((p) => p.no < 1 || p.no > MAX_CARD_NO)) return null;
  const isOrder = picks.some((p) => p.qty !== null) || ORDER_VERB_RE.test(text);
  return isOrder ? picks : null;
}

/** On-screen card numbers the sentence points at ("เบอร์ 2 กับเบอร์ 3 ต่างกันยังไง" -> [2, 3]). */
export function cardNumbersIn(text: string, cardsOnScreen: number): number[] {
  const nos = [...text.matchAll(PICK_RE)].map((m) => parseThaiNumber(m[1]) ?? 0);
  return [...new Set(nos.filter((no) => no >= 1 && no <= cardsOnScreen))];
}

/** True when the sentence points at a numbered card that is on screen. */
export function mentionsCardNumber(text: string, cardsOnScreen: number): boolean {
  return cardNumbersIn(text, cardsOnScreen).length > 0;
}

/** Answer to "รับกี่แพ็คดีครับ": "10", "สิบแพ็คครับ", "เอา 2 ลัง". */
export function parseBareQuantity(text: string): { qty: number; afterQty: string } | null {
  const coreCheck = text.trim().replace(POLITE_END_RE, "");
  if (NOT_ORDER_RE.test(coreCheck)) return null;
  const m = text.trim().match(BARE_QTY_RE);
  const qty = m ? parseThaiNumber(m[1]) : null;
  return m && qty && qty > 0 && !MONEY_AFTER_RE.test(m[2].trim()) ? { qty: Math.min(qty, 9999), afterQty: m[2].trim() } : null;
}

/** Order for the product page that is open: "เอาอันนี้สองชิ้น" -> qty 2, "ใส่ตะกร้าเลย" -> qty null (ask). */
export function parsePointedOrder(text: string): { qty: number | null; afterQty: string } | null {
  const coreCheck = text.trim().replace(POLITE_END_RE, "");
  if (NOT_ORDER_RE.test(coreCheck)) return null;
  const m = text.trim().match(POINTED_RE);
  if (!m) return null;
  const afterQty = (m[2] ?? "").trim();
  if (MONEY_AFTER_RE.test(afterQty)) return null;
  const qty = m[1] ? parseThaiNumber(m[1]) : null;
  return { qty: qty && qty > 0 ? Math.min(qty, 9999) : null, afterQty };
}

/** True when the sentence points at the thing in front of the customer ("ตัวนี้มีผงชูรสไหม"). */
export function pointsAtOpenProduct(text: string): boolean {
  return POINTS_AT_OPEN_RE.test(text);
}
