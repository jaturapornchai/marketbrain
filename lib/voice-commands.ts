// Hands-free screen control: "ถอยกลับไป", "เดินหน้า", "ดูเบอร์ 3", "เลื่อนลง", "เปิดกล้อง" ...
// Pure text matching (no LLM, no DB, client-safe) so the robot reacts instantly and costs no tokens.
// Anything not matched here goes to Nong Tee, who can still drive the screen with the screen_control tool.

export const SCREEN_COMMAND_IDS = [
  "back",
  "forward",
  "next",
  "home",
  "showcase",
  "open_no",
  "details",
  "next_item",
  "prev_item",
  "compare",
  "cart",
  "checkout",
  "camera",
  "camera_close",
  "scroll_down",
  "scroll_up",
  "scroll_top",
  "scroll_bottom",
  "stop_talk",
  "repeat",
  "mute",
  "unmute",
  "mic_off",
  "close",
  "orders",
  "history",
  "help",
  "spin",
  "play",
  "play_off",
  "duel",
  "related",
  "take_suggest",
  "page_search",
  "page_brain",
  "page_notes",
] as const;

export type ScreenCommandId = (typeof SCREEN_COMMAND_IDS)[number];

export type ScreenCommand = {
  id: ScreenCommandId;
  /** Card number for open_no, or how many screens for back/forward. */
  no?: number;
  /** Second card number (duel: "เทียบเบอร์ 2 กับ 5"). */
  no2?: number;
};

type CommandDef = { id: ScreenCommandId; label: string; examples: string[]; core: string; needsModal?: boolean };

const NUM_WORDS = "หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ";
const N = `(\\d{1,2}|(?:${NUM_WORDS})+)`;
const STEPS = `(?:${N}(?:หน้า|ครั้ง|ที|ขั้น|สเต็ป|จอ))?`;
const CART = "ตร?ะกร้า(?:สินค้า)?";
const SEE = "(?:ดู|เปิด|โชว์|แสดง|ไปที่|ไปหน้า|ไป|ขอดู)?";

// Order matters: the first match wins ("กลับหน้าแรก" is home, not back).
const COMMANDS: CommandDef[] = [
  { id: "spin", label: "หมุนวงล้อนำโชคลุ้นคูปอง", examples: ["หมุนวงล้อ", "ลุ้นโชค"], core: "(?:หมุน|สุ่ม)(?:วงล้อ|ลุ้นโชค|โชค|รางวัล|ชิงโชค)?(?:นำโชค)?(?:อีก)?(?:รอบ|ครั้ง|ที)?|เล่น(?:วงล้อ|ลุ้นโชค|โชค|รางวัล|ชิงโชค)(?:นำโชค)?(?:อีก)?(?:รอบ|ครั้ง|ที)?|วงล้อ(?:นำโชค)?|ลุ้นรางวัล|ลุ้นโชค|ชิงโชค|เสี่ยงโชค" },
  { id: "play_off", label: "ซ่อนภารกิจ", examples: ["ซ่อนภารกิจ"], core: "(?:ซ่อน|ปิด|เก็บ|ไม่เอา)(?:ภารกิจ|เกม|แผงเกม)" },
  { id: "play", label: "เปิดภารกิจลองเล่น", examples: ["ลองเล่น", "มีภารกิจอะไร"], core: "เล่น(?:เกม)?(?:อะไรได้บ้าง|อะไรดี|อะไร)?|(?:มี)?ภารกิจ(?:อะไร)?(?:บ้าง)?(?:ทั้งหมด)?|เกม" },
  { id: "duel", label: "ดวลความคุ้ม 2 เบอร์", examples: ["เทียบเบอร์ 2 กับ 5", "ดวลเบอร์หนึ่งกับสาม"], core: `(?:เทียบ|ดวล|ชน|เปรียบเทียบ|แข่ง)(?:ความคุ้ม|ราคา)?(?:ระหว่าง)?(?:เบอร์|หมายเลข|อันที่|ตัวที่)?${N}(?:กับ|และ|vs|ชน|แข่งกับ)(?:เบอร์|หมายเลข|อันที่|ตัวที่)?${N}(?:อันไหน|ตัวไหน|ไหน)?(?:คุ้มกว่า|ถูกกว่า|ดีกว่า)?(?:กัน)?|(?:เบอร์|หมายเลข)${N}(?:กับ|vs|ชน)(?:เบอร์|หมายเลข)?${N}(?:อันไหน|ตัวไหน|ไหน)?(?:คุ้มกว่า|ถูกกว่า|ดีกว่า)?(?:กัน)?` },
  { id: "related", label: "ดูของที่เกี่ยวข้องจากสมอง", examples: ["ดูของที่เกี่ยวข้อง", "มีอะไรใกล้เคียงอีกไหม"], core: "(?:ขอ)?(?:ดู)?(?:มี)?(?:สินค้า|ของ|อะไร)?(?:ที่)?(?:เกี่ยวข้อง|ใกล้เคียง|คล้าย(?:ๆ|กัน)?)(?:กัน)?(?:อีก)?(?:ไหม|บ้าง|มั้ย)?" },
  { id: "take_suggest", label: "เอาตัวที่น้องตี๋แนะนำ", examples: ["เอาด้วย", "ใส่ตัวที่แนะนำ"], core: "(?:เอา|ใส่|หยิบ|รับ)(?:ตัว|อัน|ชิ้น)?(?:ที่แนะนำ|นั้น)?ด้วย(?:เลย)?|(?:เอา|ใส่|หยิบ|รับ)(?:ตัว|อัน|ชิ้น)?ที่แนะนำ(?:เลย)?" },
  { id: "help", label: "ดูคำสั่งทั้งหมด", examples: ["สั่งอะไรได้บ้าง", "ช่วยเหลือ"], core: "(?:สั่ง|ใช้|พูด|ทำ)อะไรได้(?:บ้าง)?|มีคำสั่งอะไร(?:บ้าง)?|(?:ดู)?คำสั่ง(?:เสียง)?(?:ทั้งหมด)?|ช่วยเหลือ|วิธีใช้(?:งาน)?|ใช้(?:งาน)?ยังไง|ใช้(?:งาน)?อย่างไร" },
  { id: "home", label: "กลับหน้าแรก", examples: ["กลับหน้าแรก", "หน้าหลัก"], core: "(?:กลับ)?(?:ไป)?(?:ที่)?(?:หน้าแรก|หน้าหลัก|หน้าโฮม|โฮม|จุดเริ่มต้น)" },
  { id: "back", label: "ถอยกลับหน้าที่แล้ว", examples: ["ถอยกลับไป", "หน้าที่แล้ว", "ย้อนกลับ 2 หน้า"], core: `(?:(?:ถอยกลับ|ถอยหลัง|ถอย|ย้อนกลับ|ย้อนหลัง|ย้อน|กลับ)(?:ไป)?(?:หน้า|จอ|อัน)?(?:ที่แล้ว|ก่อนหน้า|ก่อน|เดิม|เก่า|เมื่อกี้|เมื่อกี๊|เมื้อกี้)?|(?:หน้า|จอ)(?:ที่แล้ว|ก่อนหน้า|ก่อน|เดิม|เก่า|เมื่อกี้|เมื่อกี๊))${STEPS}` },
  { id: "forward", label: "เดินหน้า (หน้าถัดไปในประวัติ)", examples: ["เดินหน้า", "ไปข้างหน้า", "หน้าถัดไป"], core: `(?:เดินหน้า|ไปข้างหน้า|ข้างหน้า|หน้าถัดไป|หน้าต่อไป|จอถัดไป|ไปหน้าต่อไป|ทำซ้ำ)${STEPS}` },
  { id: "next_item", label: "ดูสินค้าตัวถัดไป", examples: ["ตัวถัดไป", "อันต่อไป"], core: "(?:ตัว|อัน|ชิ้น|รายการ|สินค้า|เบอร์)(?:ถัดไป|ต่อไป|หน้า|ใหม่)" },
  { id: "prev_item", label: "ดูสินค้าตัวก่อนหน้า", examples: ["ตัวก่อนหน้า", "อันที่แล้ว"], core: "(?:ตัว|อัน|ชิ้น|รายการ|สินค้า|เบอร์)(?:ก่อนหน้า|ที่แล้ว|ก่อน|เมื่อกี้)" },
  { id: "next", label: "ถัดไป", examples: ["ถัดไป", "ต่อไป"], core: "ถัดไป|ต่อไป|ไปต่อ|เอาต่อ" },
  { id: "open_no", label: "เปิดดูสินค้าตามเบอร์", examples: ["ดูเบอร์ 3", "ขยายเบอร์ห้า"], core: `(?:ดู|เปิด|ขยาย|ซูม|โชว์|แสดง|เจาะ|ขอดู|ขอ|เลือกดู|กดดู|กด|คลิก|จิ้ม|เช็ก|เช็ค|ส่อง|รายละเอียด|ข้อมูล|ของ)*(?:เบอร์|หมายเลข|เลขที่|อันที่|ตัวที่|รายการที่|ชิ้นที่)(?:ที่)?${N}(?:ให้ดู|ดู|ใหญ่ๆ?|ชัดๆ?|ให้ละเอียด|ละเอียดๆ?|รายละเอียด|ข้อมูล)*|(?:ดู|เปิด|ขยาย|โชว์|แสดง|เจาะ|ขอดู|กดดู|เลือกดู)(?:รายละเอียด|ข้อมูล)?(?:ตัว|อัน|ชิ้น|รายการ|ใบ)แรก` },
  // Bare "ขอดูรายละเอียด" names no card: the screen resolves it (current spotlight / only card / ask which number).
  { id: "details", label: "ดูรายละเอียดตัวที่เปิดอยู่", examples: ["ขอดูรายละเอียด", "ดูข้อมูลตัวนี้"], core: `(?:ดู|เปิด|ขอดู|ขอ)*(?:รายละเอียด|ข้อมูล)(?:สินค้า)?(?:ตัวนี้|อันนี้|ชิ้นนี้|ตัวนั้น|อันนั้น|นี้)?` },
  { id: "showcase", label: "ดูภาพสินค้าบนจอ", examples: ["ดูสินค้า", "ภาพสินค้า"], core: `${SEE}(?:ภาพสินค้า|รูปสินค้า|รายการสินค้า|สินค้าทั้งหมด|สินค้าบนจอ|แกลเลอรี่?|การ์ดสินค้า|หน้าสินค้า|สินค้า)` },
  { id: "compare", label: "ดูตารางเปรียบเทียบ", examples: ["ดูตารางเปรียบเทียบ"], core: `${SEE}(?:ตาราง)?(?:เปรียบเทียบ|เทียบราคา)|ตารางเทียบ` },
  { id: "cart", label: "ดูตะกร้า", examples: ["ดูตะกร้า", "ในตะกร้ามีอะไรบ้าง"], core: `${SEE}${CART}|(?:สรุป|เช็ค|เช็ก|เปิดหน้า|ไปหน้า)${CART}|ใน${CART}มีอะไร(?:บ้าง)?` },
  { id: "checkout", label: "ไปหน้าปิดการขาย/ชำระเงิน", examples: ["คิดเงิน", "เช็คบิล", "ไปหน้าจ่ายเงิน"], core: `${SEE}(?:ปิดการขาย|ชำระเงิน|จ่ายเงิน|จ่ายตังค์|จ่ายตัง|เช็คบิล|เช็กบิล|เช็คยอด|เช็กยอด|คิดเงิน|คิดตังค์|คิดตัง|เก็บเงิน|คิดบิล|สรุปบิล|สรุปยอด)` },
  { id: "camera_close", label: "ปิดกล้อง", examples: ["ปิดกล้อง"], core: "ปิดกล้อง|เลิกส่อง|หยุดส่อง|หยุดสแกน|เลิกสแกน" },
  { id: "camera", label: "เปิดกล้องส่องสินค้า", examples: ["เปิดกล้อง", "สแกนบาร์โค้ด"], core: "(?:เปิด|ใช้)?กล้อง(?:หาสินค้า|ส่องสินค้า)?|ส่องสินค้า|สแกน(?:บาร์โค้ด|สินค้า)?" },
  { id: "scroll_top", label: "ขึ้นบนสุด", examples: ["ขึ้นบนสุด"], core: "(?:ขึ้น|ไป|เลื่อน|เลื่อนขึ้น|กลับขึ้น)?(?:ไป)?บนสุด|กลับขึ้นบน" },
  { id: "scroll_bottom", label: "ลงล่างสุด", examples: ["ลงล่างสุด"], core: "(?:ลง|ไป|เลื่อน|เลื่อนลง)?(?:ไป)?ล่างสุด" },
  { id: "scroll_down", label: "เลื่อนจอลง", examples: ["เลื่อนลง", "ลงอีก"], core: "(?:เลื่อน|สกรอล|สกอล|ไถ|ขยับ)(?:หน้า|จอ)?ลง(?:อีก)?|ลงอีก|ลงล่าง|ดูข้างล่าง|ดูต่อ|ลง" },
  { id: "scroll_up", label: "เลื่อนจอขึ้น", examples: ["เลื่อนขึ้น", "ขึ้นอีก"], core: "(?:เลื่อน|สกรอล|สกอล|ไถ|ขยับ)(?:หน้า|จอ)?ขึ้น(?:อีก)?|ขึ้นอีก|ขึ้นข้างบน|ดูข้างบน|ขึ้น" },
  { id: "stop_talk", label: "หยุดพูด", examples: ["หยุด", "เงียบ"], core: "หยุด(?:พูด|ก่อน)?|เงียบ(?:ก่อน)?|พอ(?:แล้ว|ก่อน)?|ชู่+ว?|ชิ" },
  { id: "repeat", label: "พูดซ้ำอีกครั้ง", examples: ["พูดอีกที", "ว่าไงนะ"], core: "พูด(?:อีกที|อีกครั้ง|ใหม่|ซ้ำ)|ทวน(?:อีกที|ใหม่)?|ว่าไงนะ|อะไรนะ|ไม่ได้ยิน|ได้ยินไม่ชัด|ฟังไม่ทัน|ไม่ทัน" },
  { id: "mute", label: "ปิดเสียงน้องตี๋", examples: ["ปิดเสียง"], core: "ปิดเสียง(?:พูด|น้องตี๋)?|ไม่ต้องพูด|ไม่ต้องอ่าน|ปิดลำโพง" },
  { id: "unmute", label: "เปิดเสียงน้องตี๋", examples: ["เปิดเสียง"], core: "เปิดเสียง(?:พูด|น้องตี๋)?|พูดได้แล้ว|อ่านให้ฟัง|เปิดลำโพง" },
  { id: "mic_off", label: "ปิดไมค์ (เลิกฟัง)", examples: ["ปิดไมค์", "เลิกฟัง"], core: "ปิดไมค์(?:ก่อน)?|ปิดไมโครโฟน(?:ก่อน)?|เลิกฟัง(?:ก่อน)?|หยุดฟัง(?:ก่อน)?|ลาก่อน|บ๊?ายบาย|บาย" },
  { id: "close", label: "ปิดหน้าต่างที่เด้งขึ้นมา", examples: ["ปิด", "ยกเลิก"], core: "ปิด(?:หน้าต่าง|ป๊?อปอัพ|อันนี้|หน้านี้)?|ยกเลิก|ไม่เอาแล้ว|ไม่เอา", needsModal: true },
  { id: "orders", label: "ดูบิลขายย้อนหลัง", examples: ["ดูบิลขาย", "ประวัติการสั่งซื้อ"], core: `${SEE}(?:บิลขาย|บิลเก่า|ประวัติ(?:การ)?(?:สั่งซื้อ|ขาย|บิล|ออเดอร์)|ใบสั่งซื้อ(?:เก่า)?|ออเดอร์เก่า)` },
  { id: "history", label: "ดูประวัติหน้าจอ", examples: ["ดูประวัติหน้าจอ", "เคยดูอะไรไปบ้าง"], core: `${SEE}ประวัติ(?:หน้าจอ|ที่ดู|การดู)?|เคยดูอะไร(?:ไป)?(?:บ้าง)?|ดูอะไรไปแล้วบ้าง` },
  { id: "page_search", label: "เปิดหน้าค้นหาละเอียด", examples: ["ไปหน้าค้นหา"], core: `${SEE}(?:หน้า)?ค้นหาละเอียด|${SEE}หน้าค้นหา(?:สินค้า)?` },
  { id: "page_brain", label: "เปิดสมอง 3 มิติ", examples: ["เปิดสมองสามมิติ"], core: `${SEE}สมอง(?:สามมิติ|3มิติ|3d|3ดี|สามดี)` },
  { id: "page_notes", label: "เปิดสารบัญสมอง", examples: ["เปิดสารบัญ"], core: `${SEE}สารบัญ(?:สมอง)?` },
];

/**
 * Words the commands above are built from. The listener snaps sound-alikes to these spellings
 * ("ปิดใหม่" -> "ปิดไมค์", lib/heard-fix.ts); add the word here when a new command is misheard.
 */
export const COMMAND_WORDS = [
  "น้องตี๋", "เบอร์", "ถอยกลับ", "ถอยหลัง", "ย้อนกลับ", "หน้าที่แล้ว", "เดินหน้า", "ถัดไป", "ต่อไป", "ก่อนหน้า",
  "หน้าหลัก", "หน้าแรก", "รายละเอียด", "ข้อมูล", "สินค้า", "เปรียบเทียบ", "เทียบ", "ดวล", "ตะกร้า",
  "คิดเงิน", "เช็คบิล", "จ่ายเงิน", "ชำระเงิน", "ปิดการขาย", "เปิดกล้อง", "ปิดกล้อง", "สแกน", "บาร์โค้ด",
  "บนสุด", "ล่างสุด", "เลื่อนลง", "เลื่อนขึ้น", "หยุด", "เงียบ", "พูดอีกที", "ปิดเสียง", "เปิดเสียง", "ปิดไมค์",
  "หมุนวงล้อ", "ลุ้นโชค", "ภารกิจ", "ลองเล่น", "เกี่ยวข้อง", "ใกล้เคียง", "แนะนำ", "ช่วยเหลือ",
  "บิลขาย", "ประวัติ", "สั่งซื้อ", "หน้าจอ", "ค้นหา", "สมอง", "สามมิติ", "สารบัญ",
];

// Polite words around a command: "น้องตี๋ ช่วยถอยกลับไปหน่อยครับ" -> core "ถอยกลับไป".
const PREFIX = "(?:น้องตี๋|ตี๋|น้อง|ครับผม|ครับ|คับ|ค่ะ|คะ|นะ|ช่วย|ขอ|โปรด|กรุณา|รบกวน|พา|ลอง|ที|เออ|อ่า|เอ่อ|โอเค|ok|เดี๋ยว|อยาก|จะ|งั้น|ก็|ให้|ขอให้)*";
const SUFFIX = "(?:ครับผม|ครับ|คับ|ค่ะ|คะ|ค่า|นะ|หน่อย|ด้วย|เลย|สิ|ซิ|ซี่|ที|ให้|ให้ดู|ให้หน่อย|จ้า|จ้ะ|จ๊ะ|ไป|มา|ได้ไหม|ได้มั้ย|ได้เปล่า|อีก|อีกที|เดี๋ยวนี้|ทีนะ|น้องตี๋|ตี๋)*";

const COMPILED = COMMANDS.map((c) => ({ ...c, re: new RegExp(`^${PREFIX}(?:${c.core})${SUFFIX}$`, "i") }));

const DIGIT_OF: Record<string, number> = { หนึ่ง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9 };

function toNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const words = raw.match(new RegExp(NUM_WORDS, "g")) ?? [];
  let total = 0;
  let cur = 0;
  for (const w of words) {
    if (w === "สิบ") {
      total += (cur || 1) * 10;
      cur = 0;
    } else {
      cur = DIGIT_OF[w] ?? 0;
    }
  }
  return total + cur || undefined;
}

/**
 * Turns a whole spoken sentence into a screen command, or null when it is anything else
 * (product question, order, chat) so the sentence goes to Nong Tee as usual.
 */
export function parseScreenCommand(text: string, ctx: { modalOpen?: boolean } = {}): ScreenCommand | null {
  const t = text.replace(/[\s.,!?ๆ"'“”]+/g, "").toLowerCase();
  if (!t || t.length > 60) return null;
  for (const c of COMPILED) {
    if (c.needsModal && !ctx.modalOpen) continue;
    const m = t.match(c.re);
    if (!m) continue;
    const [no, no2] = m.slice(1).filter((g) => g !== undefined).map(toNumber);
    if (c.id === "duel") return no && no2 && no !== no2 ? { id: c.id, no, no2 } : null;
    if (c.id === "open_no" && !no) return { id: c.id, no: 1 }; // "ดูตัวแรก" / "เปิดอันแรก"
    return no ? { id: c.id, no } : { id: c.id };
  }
  return null;
}

/** Command list for the on-screen help panel. */
export function screenCommandHelp(): Array<{ id: ScreenCommandId; label: string; examples: string[] }> {
  return COMMANDS.filter((c) => c.id !== "next").map(({ id, label, examples }) => ({ id, label, examples }));
}

const BUDGET_RE = new RegExp(
  `^${PREFIX}(?:ตั้ง|กำหนด|มี|ใช้)?งบ(?:ประมาณ)?(?:ไว้|มี|อยู่|แค่|ไม่เกิน)?(?:ที่)?([\\d,]{1,7}|[ก-๙]{2,30}?)(?:บาท)?(?:ไม่เกินนี้|เท่านั้น)?${SUFFIX}$`,
  "i",
);

/**
 * "งบ 500 บาท" / "ตั้งงบห้าร้อย" -> "500"; "ยกเลิกงบ" -> "0"; anything else -> null.
 * Returns a whole-baht decimal string (money stays out of binary floats).
 */
export function parseBudget(text: string, toNum: (s: string) => number | null): string | null {
  const t = text.replace(/[\s.!?ๆ"'“”]+/g, "").toLowerCase();
  if (!t.includes("งบ") || t.length > 40) return null;
  if (/(?:ยกเลิก|ลบ|ไม่ต้อง|ไม่มี|เอาออก|ปิด)งบ|งบ(?:ออก|ยกเลิก)/.test(t)) return "0";
  const m = t.match(BUDGET_RE);
  if (!m) return null;
  const n = /^[\d,]+$/.test(m[1]) ? Number.parseInt(m[1].replace(/,/g, ""), 10) : toNum(m[1]);
  return n && n > 0 && n <= 1_000_000 ? String(n) : null;
}
