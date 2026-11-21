import Decimal from "decimal.js";
import type { JavisProductCard } from "./product-card";
import { parseDecimal } from "./decimal-money";

export type DietaryTagId =
  | "halal"
  | "no_msg"
  | "no_peanut"
  | "no_dairy"
  | "no_gluten"
  | "no_seafood"
  | "low_sugar"
  | "low_sodium";

export type DietaryTagDef = {
  id: DietaryTagId;
  label: string;
  shortLabel: string;
  icon: string;
  kind: "require" | "avoid" | "limit";
};

export const DIETARY_TAGS: readonly DietaryTagDef[] = [
  { id: "halal", label: "ฮาลาลเท่านั้น", shortLabel: "ฮาลาล", icon: "☪️", kind: "require" },
  { id: "no_msg", label: "ไม่ใส่ผงชูรส", shortLabel: "ไร้ผงชูรส", icon: "🌿", kind: "avoid" },
  { id: "no_peanut", label: "แพ้ถั่ว", shortLabel: "ไร้ถั่ว", icon: "🥜", kind: "avoid" },
  { id: "no_dairy", label: "แพ้นมวัว", shortLabel: "ไร้นมวัว", icon: "🥛", kind: "avoid" },
  { id: "no_gluten", label: "แพ้กลูเตน", shortLabel: "ไร้กลูเตน", icon: "🌾", kind: "avoid" },
  { id: "no_seafood", label: "แพ้อาหารทะเล", shortLabel: "ไร้อาหารทะเล", icon: "🦐", kind: "avoid" },
  { id: "low_sugar", label: "คุมน้ำตาล", shortLabel: "คุมน้ำตาล", icon: "🍬", kind: "limit" },
  { id: "low_sodium", label: "คุมโซเดียม", shortLabel: "คุมโซเดียม", icon: "🧂", kind: "limit" },
] as const;

const TAG_DEF_MAP = new Map<DietaryTagId, DietaryTagDef>(DIETARY_TAGS.map((t) => [t.id, t]));

export type DietaryVerdict = {
  status: "safe" | "warn" | "unknown";
  safeLabels: string[];
  warnLabels: string[];
};

const NEGATION_RE = /(?:ไม่ใส่|ไม่มี|ปลอด|ปราศจาก|ไร้|หลีกเลี่ยง|free\s+from|without|no\s+|non[-\s]?)$/i;

function hasUnnegatedMatch(haystack: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of haystack.matchAll(g)) {
    const idx = m.index ?? 0;
    const prefix = haystack.slice(Math.max(0, idx - 20), idx);
    if (!NEGATION_RE.test(prefix)) return true;
  }
  return false;
}

const HALAL_SAFE_RE = /ฮาลาล|halal/i;
const HALAL_WARN_RE = /หมู|สุกร|เบคอน|แฮม|มันหมู|แอลกอฮอล์|สุรา|เหล้า|เบียร์|ไวน์|วิสกี้|pork|lard|bacon|ham|alcohol|wine|beer|whisky|rum/i;
const NO_MSG_SAFE_RE = /ไม่ใส่ผงชูรส|ไม่มีผงชูรส|ปลอดผงชูรส|no\s+msg/i;
const NO_MSG_WARN_RE = /ผงชูรส|โมโนโซเดียม|monosodium\s+glutamate|\bins\s*621\b|\be621\b|\bmsg\b/i;
const PEANUT_SAFE_RE = /ไม่มีถั่ว|ปลอดถั่ว|nut[-\s]*free|peanut[-\s]*free/i;
const PEANUT_WARN_RE = /ถั่วลิสง|ถั่วอบ|ถั่วต่างๆ|อัลมอนด์|เม็ดมะม่วง|วอลนัท|ฮาเซลนัท|แมคคาเดเมีย|พิสตาชิโอ|ถั่ว(?!ฝักยาว)|peanut|tree\s*nut|almond|cashew|walnut|hazelnut|pistachio|soy(?:bean)?/i;
const DAIRY_SAFE_RE = /ไม่มีนมวัว|ปราศจากนม|ไร้นม|dairy[-\s]*free|lactose[-\s]*free|non[-\s]*dairy/i;
const DAIRY_WARN_RE = /นมวัว|นมโค|นมผง|ครีมเทียม|เวย์|เคซีน|แลคโตส|ชีส|เนย|โยเกิร์ต|นมสด|milk\s*powder|whole\s*milk|skim\s*milk|\bmilk\b|dairy|whey|casein|lactose|butter|cheese|yogurt/i;
const PLANT_MILK_RE = /นมถั่วเหลือง|นมอัลมอนด์|นมข้าว|soy\s*milk|almond\s*milk|oat\s*milk/i;
const GLUTEN_SAFE_RE = /ปลอดกลูเตน|ไม่มีกลูเตน|gluten[-\s]*free/i;
const GLUTEN_WARN_RE = /กลูเตน|แป้งสาลี|ข้าวสาลี|ข้าวบาร์เลย์|ข้าวไรย์|gluten|wheat|barley|\brye\b|malt/i;
const SEAFOOD_SAFE_RE = /ไม่มีอาหารทะเล|seafood[-\s]*free/i;
const SEAFOOD_WARN_RE = /อาหารทะเล|กุ้ง|ปู(?!นา|พรม)|หอย|ปลาหมึก|หมึก|เนื้อปลา|น้ำปลา|กะปิ|แซลมอน|ทูน่า|shrimp|prawn|crab|shellfish|squid|octopus|seafood|fish\s*sauce|anchovy|tuna|salmon/i;
const LOW_SUGAR_SAFE_RE = /ไม่เติมน้ำตาล|ไม่มีน้ำตาล|ปราศจากน้ำตาล|0%\s*น้ำตาล|สูตรไม่มีน้ำตาล|sugar[-\s]*free|no\s+sugar\s+added|zero\s+sugar|low\s+sugar/i;
const LOW_SUGAR_WARN_RE = /น้ำตาล|ไซรัป|น้ำเชื่อม|ฟรุกโตส|sugar|syrup|fructose|sucrose|glucose/i;
const LOW_SODIUM_SAFE_RE = /โซเดียมต่ำ|ลดโซเดียม|low\s+sodium|reduced\s+sodium/i;

function parseNutritionNumber(nutrition: Record<string, string> | undefined, keys: string[]): Decimal | null {
  if (!nutrition) return null;
  for (const k of keys) {
    const raw = nutrition[k];
    if (!raw) continue;
    const d = parseDecimal(raw);
    if (d && d.isFinite() && d.gte(0)) return d;
  }
  return null;
}

/**
 * Evaluate a product against active customer dietary/allergen rules using ONLY real product fields.
 * Never guesses: items without food evidence return `status: "unknown"`.
 */
export function evaluateDietaryShield(
  item: Pick<JavisProductCard, "title" | "traits" | "ingredients" | "warnings" | "nutrition" | "description">,
  activeTags: readonly DietaryTagId[],
): DietaryVerdict {
  if (!activeTags.length) return { status: "unknown", safeLabels: [], warnLabels: [] };

  const traitsStr = item.traits.join(" ");
  const hasFoodEvidence = Boolean(
    item.ingredients.trim() ||
      (item.warnings && item.warnings.trim()) ||
      (item.nutrition && Object.keys(item.nutrition).length > 0) ||
      /ฮาลาล|ไม่ใส่ผงชูรส|โซเดียม|น้ำตาล|โปรตีน|ไขมัน|นม|ถั่ว|กลูเตน|อาหารทะเล/i.test(traitsStr),
  );
  const fullText = [item.title, traitsStr, item.ingredients, item.warnings ?? "", item.description].join(" \n ");

  const safeLabels: string[] = [];
  const warnLabels: string[] = [];

  for (const tagId of activeTags) {
    const def = TAG_DEF_MAP.get(tagId);
    if (!def) continue;

    if (tagId === "halal") {
      if (HALAL_WARN_RE.test(fullText)) warnLabels.push(def.shortLabel);
      else if (HALAL_SAFE_RE.test(fullText)) safeLabels.push(def.shortLabel);
    } else if (tagId === "no_msg") {
      if (NO_MSG_SAFE_RE.test(fullText)) safeLabels.push(def.shortLabel);
      else if (hasUnnegatedMatch(fullText, NO_MSG_WARN_RE)) warnLabels.push(def.shortLabel);
      else if (item.ingredients.trim()) safeLabels.push(def.shortLabel);
    } else if (tagId === "no_peanut") {
      if (PEANUT_SAFE_RE.test(fullText)) safeLabels.push(def.shortLabel);
      else if (hasUnnegatedMatch(fullText, PEANUT_WARN_RE)) warnLabels.push(def.shortLabel);
      else if (item.ingredients.trim()) safeLabels.push(def.shortLabel);
    } else if (tagId === "no_dairy") {
      if (DAIRY_SAFE_RE.test(fullText)) safeLabels.push(def.shortLabel);
      else if (hasUnnegatedMatch(fullText, DAIRY_WARN_RE) && !(PLANT_MILK_RE.test(fullText) && !/นมวัว|นมโค|whole\s*milk|skim\s*milk|lactose|whey|casein/i.test(fullText))) {
        warnLabels.push(def.shortLabel);
      } else if (item.ingredients.trim()) {
        safeLabels.push(def.shortLabel);
      }
    } else if (tagId === "no_gluten") {
      if (GLUTEN_SAFE_RE.test(fullText)) safeLabels.push(def.shortLabel);
      else if (hasUnnegatedMatch(fullText, GLUTEN_WARN_RE)) warnLabels.push(def.shortLabel);
      else if (item.ingredients.trim()) safeLabels.push(def.shortLabel);
    } else if (tagId === "no_seafood") {
      if (SEAFOOD_SAFE_RE.test(fullText)) safeLabels.push(def.shortLabel);
      else if (hasUnnegatedMatch(fullText, SEAFOOD_WARN_RE)) warnLabels.push(def.shortLabel);
      else if (item.ingredients.trim()) safeLabels.push(def.shortLabel);
    } else if (tagId === "low_sugar") {
      const sugar = parseNutritionNumber(item.nutrition, ["sugars_100g", "sugars"]);
      if (sugar) {
        if (sugar.gt(12)) warnLabels.push(`${def.shortLabel} (${sugar.toFixed(0)}ก./100ก.)`);
        else if (sugar.lte(5)) safeLabels.push(def.shortLabel);
      } else if (LOW_SUGAR_SAFE_RE.test(fullText)) {
        safeLabels.push(def.shortLabel);
      } else if (hasUnnegatedMatch(item.ingredients, LOW_SUGAR_WARN_RE)) {
        warnLabels.push(def.shortLabel);
      }
    } else if (tagId === "low_sodium") {
      const sod = parseNutritionNumber(item.nutrition, ["sodium_100g", "sodium"]);
      if (sod) {
        // Nutrition fields can be stored either as grams (<= 20, threshold 0.6g) or mg (> 20, threshold 600mg).
        const isHigh = (sod.lte(20) && sod.gt("0.6")) || sod.gt(600);
        const isLow = (sod.lte(20) && sod.lte("0.3")) || (sod.gt(20) && sod.lte(300));
        if (isHigh) warnLabels.push(def.shortLabel);
        else if (isLow) safeLabels.push(def.shortLabel);
      } else if (LOW_SODIUM_SAFE_RE.test(fullText)) {
        safeLabels.push(def.shortLabel);
      } else if (hasUnnegatedMatch(item.ingredients, /เกลือเสริมไอโอดีน|เกลือบริโภค|salt|sodium\s+chloride|น้ำปลา|ซีอิ๊ว/i)) {
        warnLabels.push(def.shortLabel);
      }
    }
  }

  if (warnLabels.length > 0) return { status: "warn", safeLabels, warnLabels };
  if (safeLabels.length > 0 && hasFoodEvidence) return { status: "safe", safeLabels, warnLabels };
  return { status: "unknown", safeLabels: [], warnLabels: [] };
}

export type ParsedDietaryCommand = {
  action: "add" | "remove" | "clear";
  tags: DietaryTagId[];
};

const CLEAR_SHIELD_RE = /(?:ล้าง|ปิด|ยกเลิก|ลบ|เอาออก)(?:โปรไฟล์)?(?:เกราะ|สุขภาพ|แพ้อาหาร|ภูมิแพ้|มังสวิรัติ|ฮาลาล|ทั้งหมด)?.*(?:เกราะสุขภาพ|โปรไฟล์สุขภาพ|แพ้อาหาร)/i;
const PRODUCT_INTENT_GUARD_RE = /(?:ขอดู|หา|ค้น|มี.*(?:ไหม|มั้ย)|ราคา|เบอร์\s*\d|ใส่ตะกร้า|น้ำจิ้ม|ซอส|น้ำปลา|บะหมี่|มาม่า|ขนม|น้ำมัน|กาแฟ|ชา|นม(?!วัว)|ข้าว)/i;

const TAG_PATTERNS: Array<{ id: DietaryTagId; re: RegExp }> = [
  { id: "halal", re: /ฮาลาล|halal/i },
  { id: "no_msg", re: /ไม่ใส่ผงชูรส|ไม่มีผงชูรส|ไร้ผงชูรส|ไม่เอาผงชูรส/i },
  { id: "no_peanut", re: /แพ้ถั่ว|ไม่กินถั่ว|ไม่เอาถั่ว|ไร้ถั่ว/i },
  { id: "no_dairy", re: /แพ้นม(?:วัว|โค)?|ไม่กินนมวัว|ไม่เอานมวัว|ไร้นมวัว/i },
  { id: "no_gluten", re: /แพ้กลูเตน|ไม่กินกลูเตน|ไร้กลูเตน|ปราศจากกลูเตน/i },
  { id: "no_seafood", re: /แพ้อาหารทะเล|ไม่กินอาหารทะเล|แพ้กุ้ง/i },
  { id: "low_sugar", re: /คุมน้ำตาล|ลดน้ำตาล|เบาหวาน|ไม่เอาหวาน|ไม่กินหวาน|งดน้ำตาล/i },
  { id: "low_sodium", re: /คุมโซเดียม|ลดโซเดียม|ลดเค็ม|คุมเค็ม|ความดัน/i },
];

const COMPOUND_ALLERGEN_PATTERNS: Array<{ id: DietaryTagId; re: RegExp }> = [
  { id: "no_peanut", re: /ถั่ว(?!ฝักยาว)/i },
  { id: "no_dairy", re: /นมวัว|นมโค|ผลิตภัณฑ์นม|แลคโตส/i },
  { id: "no_gluten", re: /กลูเตน|แป้งสาลี/i },
  { id: "no_seafood", re: /อาหารทะเล|กุ้ง/i },
];

/**
 * Parse explicit voice/text dietary shield preferences without hijacking product searches
 * like "ขอดูน้ำจิ้มไก่ไม่ใส่ผงชูรส".
 */
export function parseDietaryCommand(raw: string): ParsedDietaryCommand | null {
  const t = raw.trim();
  if (!t || t.length > 90) return null;

  if (
    CLEAR_SHIELD_RE.test(t) ||
    /^(?:ล้าง|ปิด|ยกเลิก)(?:เกราะสุขภาพ|โปรไฟล์สุขภาพ|แพ้อาหาร|เกราะ)$/i.test(t.replace(/[\sครับค่ะคะนะ]+/g, ""))
  ) {
    return { action: "clear", tags: [] };
  }

  const hasAllergyVerb = /(?:แพ้|ไม่กิน|ไม่เอา|งด|หลีกเลี่ยง|ห้าม)/i.test(t);
  const matchedSet = new Set<DietaryTagId>();
  for (const { id, re } of TAG_PATTERNS) {
    if (re.test(t)) matchedSet.add(id);
  }
  if (hasAllergyVerb) {
    for (const { id, re } of COMPOUND_ALLERGEN_PATTERNS) {
      if (re.test(t)) matchedSet.add(id);
    }
  }
  const matched = DIETARY_TAGS.map((d) => d.id).filter((id) => matchedSet.has(id));
  if (!matched.length) return null;

  const hasExplicitProfileVerb = /(?:ผม|ฉัน|หนู|เรา|ตั้ง|เปิด|เพิ่ม|ปิด|ยกเลิก|เอาออก|เอาเฉพาะ|ขอเฉพาะ|เป็นโรค|แพ้)/i.test(t);
  if (PRODUCT_INTENT_GUARD_RE.test(t) && !hasExplicitProfileVerb) {
    return null;
  }

  const isRemove = /^(?:ปิด|ยกเลิก|เอาออก|ลบ)/.test(t.trim()) || /(?:เลิกแพ้|เลิกคุม)/i.test(t);
  return { action: isRemove ? "remove" : "add", tags: matched };
}
