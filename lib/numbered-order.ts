// Spoken "order by card number" commands, e.g. "เอาเบอร์ 5 10 ชิ้น", "เบอร์สามสองแพ็ค เบอร์ 1 หนึ่งลัง".
// Pure text parsing (no LLM, no DB) so the action is exact and instant.

const NUM_WORDS = "หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย|พัน";
const NUM = `(\\d{1,4}(?!\\d)|(?:${NUM_WORDS})+)`;
const NUM_WORD_RE = new RegExp(NUM_WORDS, "g");
const DIGIT_OF: Record<string, number> = { หนึ่ง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9 };
const MULT_OF: Record<string, number> = { สิบ: 10, ร้อย: 100, พัน: 1000 };

const PICK_RE = new RegExp(`(?:เบอร์|หมายเลข|เลขที่|อันที่|ตัวที่|รายการที่|ข้อ)\\s*(?:ที่\\s*)?${NUM}`, "g");
const QTY_AFTER_RE = new RegExp(`^(?:\\s|นะ|ครับ|ค่ะ|คะ|เอา|ขอ|รับ|จำนวน|อย่างละ)*${NUM}\\s*(.*)$`);
const QTY_BEFORE_RE = new RegExp(`${NUM}\\s*([^\\d\\s]{0,12})\\s*$`);
const BARE_QTY_RE = new RegExp(`^(?:เอา|ขอ|รับ|จำนวน|\\s)*${NUM}\\s*(.{0,16})$`);
const ORDER_VERB_RE = /เอา|ขอ|รับ|สั่ง|ใส่|เพิ่ม|ซื้อ|หยิบ|จัด/;
// Questions, look-ups and removals are not "add to cart" orders -> leave them to the conversation.
const NOT_ORDER_RE = /ไหม|มั้ย|เท่าไหร่|เท่าไร|กี่|อะไร|ยังไง|อย่างไร|เปล่า|ดู|เทียบ|รายละเอียด|ต่างกัน|ราคา|ออก|ลบ|ไม่เอา|ยกเลิก|เปลี่ยน|ลด/;
const MAX_CARD_NO = 99; // bigger numbers are product names ("เบอร์ 309"), not card numbers

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
export function parseNumberedOrder(text: string, cardsOnScreen: number): NumberedPick[] | null {
  if (NOT_ORDER_RE.test(text)) return null;
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

/** True when the sentence points at a numbered card that is on screen ("เบอร์ 2 กับเบอร์ 3 ต่างกันยังไง"). */
export function mentionsCardNumber(text: string, cardsOnScreen: number): boolean {
  return [...text.matchAll(PICK_RE)].some((m) => {
    const no = parseThaiNumber(m[1]) ?? 0;
    return no >= 1 && no <= cardsOnScreen;
  });
}

/** Answer to "รับกี่แพ็คดีครับ": "10", "สิบแพ็คครับ", "เอา 2 ลัง". */
export function parseBareQuantity(text: string): { qty: number; afterQty: string } | null {
  if (NOT_ORDER_RE.test(text)) return null;
  const m = text.trim().match(BARE_QTY_RE);
  const qty = m ? parseThaiNumber(m[1]) : null;
  return m && qty && qty > 0 ? { qty: Math.min(qty, 9999), afterQty: m[2].trim() } : null;
}
