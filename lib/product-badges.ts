export type ProductBadgeTone =
  | "fda"
  | "med"
  | "tis"
  | "halal"
  | "age"
  | "cold"
  | "pet"
  | "elec"
  | "clean"
  | "veg"
  | "baby"
  | "warn";

export type ProductSemanticBadge = {
  id: string;
  icon: string;
  label: string;
  title: string;
  tone: ProductBadgeTone;
};

export const SEMANTIC_BADGE_DEFS = [
  { id: "fda", bit: 1 << 0, icon: "🛡️", label: "อ.ย.", tone: "fda" },
  { id: "med", bit: 1 << 1, icon: "💊", label: "ยา", tone: "med" },
  { id: "tis", bit: 1 << 2, icon: "🏛️", label: "มอก.", tone: "tis" },
  { id: "age20", bit: 1 << 3, icon: "🔞", label: "20+", tone: "age" },
  { id: "halal", bit: 1 << 4, icon: "☪️", label: "ฮาลาล", tone: "halal" },
  { id: "frozen", bit: 1 << 5, icon: "❄️", label: "แช่แข็ง", tone: "cold" },
  { id: "chilled", bit: 1 << 6, icon: "🧊", label: "แช่เย็น", tone: "cold" },
  { id: "pet", bit: 1 << 7, icon: "🐾", label: "สัตว์เลี้ยง", tone: "pet" },
  { id: "elec", bit: 1 << 8, icon: "⚡", label: "ไฟฟ้า", tone: "elec" },
  { id: "no_msg", bit: 1 << 9, icon: "🌿", label: "ไร้ผงชูรส", tone: "clean" },
  { id: "veg", bit: 1 << 10, icon: "🥬", label: "เจ/วีแกน", tone: "veg" },
  { id: "baby", bit: 1 << 11, icon: "👶", label: "แม่และเด็ก", tone: "baby" },
  { id: "warn", bit: 1 << 12, icon: "⚠️", label: "มีคำเตือน", tone: "warn" },
] as const;

export const BADGE_BIT_BY_ID: Record<string, number> = Object.fromEntries(
  SEMANTIC_BADGE_DEFS.map((d) => [d.id, d.bit]),
);

export function computeBadgeMask(badges: readonly ProductSemanticBadge[]): number {
  let mask = 0;
  for (const b of badges) {
    mask |= BADGE_BIT_BY_ID[b.id] ?? 0;
  }
  return mask;
}

const FDA_NUM_RE = /\b\d{2}-\d-(?:\d{5}-\d-\d{4}|\d{10})\b/;
const FDA_LABEL_RE = /อย\.|เลขที่จดแจ้ง|เลขจดแจ้ง|เลขที่ใบรับจดแจ้ง|ทะเบียนยา/;

/**
 * Extract verified Thai FDA / cosmetic notification registration number from structured fields only.
 */
export function extractFdaNumber(raw: {
  fdaNumber?: string | null;
  specs?: Array<{ label: string; value: string }>;
  description?: string;
  features?: string;
}): string | null {
  const direct = (raw.fdaNumber ?? "").trim();
  if (direct && direct !== "null") return direct;
  const specText = (raw.specs ?? []).map((s) => `${s.label} ${s.value}`).join(" ");
  const blob = [specText, raw.features ?? "", raw.description ?? ""].join(" ");
  const m = blob.match(FDA_NUM_RE);
  return m ? m[0] : null;
}

const MED_POS_RE =
  /ยาสามัญ|ยาแก้|ยาหม่อง|ยาดม|ยาเม็ด|ยาน้ำ|ยาธาตุ|ยาหยอด|เวชภัณฑ์|พาราเซตามอล|แก้ปวด|ลดไข้|แก้ไอ|ผื่นคัน|คาลาไมน์|แผลสด|เบตาดีน|pharmacy|medicine/i;
const MED_NEG_TITLE_RE =
  /ยาสีฟัน|น้ำยาซัก|น้ำยาล้าง|น้ำยาถู|น้ำยาปรับ|น้ำยาบ้วนปาก|น้ำยาเช็ด|น้ำยาเคลือบ|น้ำยาดัด|เปลี่ยนสีผม/i;

const TIS_RE = /มอก\.|\bTIS\s*\d/i;

const ALCOHOL_POS_RE =
  /เบียร์|ไวน์|สุรา|เหล้า|วิสกี้|วอดก้า|บรั่นดี|แอลกอฮอล์|\bbeer\b|\bwine\b|\bspirits\b|\bwhisky\b|\bwhiskey\b|\bvodka\b/i;
const ALCOHOL_SANITIZER_RE =
  /แอลกอฮอล์.*(?:ล้างมือ|เช็ด|แผล|สเปรย์|เจล|ฆ่าเชื้อ|ทำความสะอาด|70%|75%|95%)|(?:ล้างมือ|เช็ดแผล|สเปรย์|เจล|ศิริบัญชา|ทำความสะอาด).*แอลกอฮอล์|alcohol\s*(?:pad|gel|spray|wipe|hand)|isopropyl|rubbing/i;

const HALAL_RE = /ฮาลาล|\bhalal\b/i;
const FROZEN_RE = /แช่แข็ง|\bfrozen\b/i;
const CHILLED_RE = /แช่เย็น|\bchilled\b/i;
const PET_RE =
  /อาหารแมว|อาหารสุนัข|อาหารหมา|ขนมแมว|ขนมหมา|ทรายแมว|สัตว์เลี้ยง|pet\s*(?:food|supplies|care)|cat\s*food|dog\s*food/i;
const ELEC_RE =
  /หลอดไฟ|ปลั๊กพ่วง|สว่าน|สายไฟ|แบตเตอรี่|ถ่านไฟฉาย|เครื่องเจียร|สวิตช์ไฟ|เต้ารับ|เบรกเกอร์|\d+(?:\.\d+)?\s*(?:วัตต์|watts?)\b/i;
const NO_MSG_RE = /ไม่ใส่ผงชูรส|ไม่มีผงชูรส|ปลอดผงชูรส|\bno\s+msg\b/i;
const VEG_RE = /วีแกน|มังสวิรัติ|อาหารเจ|จากพืช|\bvegan\b|\bplant[-\s]?based\b/i;
const BABY_RE = /ผ้าอ้อมเด็ก|นมผงเด็ก|ทารก|สำหรับเด็ก|แม่และเด็ก|mom\s*&\s*baby|\bbaby\b/i;

/**
 * Derive compact, truthful semantic badges strictly from real product metadata with negative guards.
 */
export function extractProductBadges(input: {
  title: string;
  category?: string;
  brand?: string;
  fdaNumber?: string | null;
  traits?: string[];
  description?: string;
  features?: string;
  warnings?: string;
  specs?: Array<{ label: string; value: string }>;
}): ProductSemanticBadge[] {
  const badges: ProductSemanticBadge[] = [];
  const specsStr = (input.specs ?? []).map((s) => `${s.label}:${s.value}`).join(" ");
  const traitsStr = (input.traits ?? []).join(" ");
  const core = [input.title, input.category ?? "", traitsStr].join(" ");
  const blob = [
    input.title,
    input.category ?? "",
    input.brand ?? "",
    traitsStr,
    specsStr,
    input.features ?? "",
    input.description ?? "",
    input.warnings ?? "",
  ].join(" ");

  const fda = extractFdaNumber(input);
  if (fda || FDA_LABEL_RE.test(blob)) {
    badges.push({
      id: "fda",
      icon: "🛡️",
      label: "อ.ย.",
      title: fda ? `เลข อ.ย./จดแจ้ง: ${fda}` : "มีข้อมูลเลข อ.ย. / เลขที่จดแจ้ง",
      tone: "fda",
    });
  }

  if (MED_POS_RE.test(blob) && !MED_NEG_TITLE_RE.test(input.title)) {
    badges.push({
      id: "med",
      icon: "💊",
      label: "ยา",
      title: "ผลิตภัณฑ์ยา / เวชภัณฑ์ / ดูแลอาการ",
      tone: "med",
    });
  }

  if (TIS_RE.test(blob)) {
    badges.push({
      id: "tis",
      icon: "🏛️",
      label: "มอก.",
      title: "มีข้อมูลมาตรฐานผลิตภัณฑ์อุตสาหกรรม (มอก.)",
      tone: "tis",
    });
  }

  if (ALCOHOL_POS_RE.test(core) && !ALCOHOL_SANITIZER_RE.test(blob)) {
    badges.push({
      id: "age20",
      icon: "🔞",
      label: "20+",
      title: "เครื่องดื่มแอลกอฮอล์ (จำกัดอายุ 20 ปีขึ้นไป)",
      tone: "age",
    });
  }

  if (HALAL_RE.test(blob)) {
    badges.push({
      id: "halal",
      icon: "☪️",
      label: "ฮาลาล",
      title: "รับรองมาตรฐานฮาลาล",
      tone: "halal",
    });
  }

  if (FROZEN_RE.test(blob)) {
    badges.push({
      id: "frozen",
      icon: "❄️",
      label: "แช่แข็ง",
      title: "สินค้าแช่แข็ง / เก็บในช่องแช่แข็ง",
      tone: "cold",
    });
  } else if (CHILLED_RE.test(blob)) {
    badges.push({
      id: "chilled",
      icon: "🧊",
      label: "แช่เย็น",
      title: "สินค้าแช่เย็น / เก็บในที่เย็น",
      tone: "cold",
    });
  }

  if (PET_RE.test(blob)) {
    badges.push({
      id: "pet",
      icon: "🐾",
      label: "สัตว์เลี้ยง",
      title: "สินค้าสำหรับสัตว์เลี้ยง",
      tone: "pet",
    });
  }

  if (ELEC_RE.test(blob)) {
    badges.push({
      id: "elec",
      icon: "⚡",
      label: "ไฟฟ้า",
      title: "เครื่องใช้ไฟฟ้า / อุปกรณ์ไฟฟ้า / กำลังไฟ",
      tone: "elec",
    });
  }

  if (NO_MSG_RE.test(blob)) {
    badges.push({
      id: "no_msg",
      icon: "🌿",
      label: "ไร้ผงชูรส",
      title: "ไม่ใส่ผงชูรส",
      tone: "clean",
    });
  }

  if (VEG_RE.test(blob)) {
    badges.push({
      id: "veg",
      icon: "🥬",
      label: "เจ/วีแกน",
      title: "สูตรมังสวิรัติ / วีแกน / จากพืช",
      tone: "veg",
    });
  }

  if (BABY_RE.test(blob)) {
    badges.push({
      id: "baby",
      icon: "👶",
      label: "แม่และเด็ก",
      title: "สินค้าสำหรับแม่และเด็ก",
      tone: "baby",
    });
  }

  const warnText = (input.warnings ?? "").trim();
  if (warnText) {
    badges.push({
      id: "warn",
      icon: "⚠️",
      label: "มีคำเตือน",
      title: `คำเตือนบนฉลาก: ${warnText.slice(0, 120)}`,
      tone: "warn",
    });
  }

  return badges;
}
