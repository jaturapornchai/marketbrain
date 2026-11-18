// Thai normalization & human-friendly labels for categories, product attributes (traits), nutrition, and sources

export const CATEGORY_THAI_FALLBACK: Record<string, string> = {
  "dry-grocery": "ของแห้งและเครื่องปรุง",
  grocery: "สินค้าอุปโภคบริโภค",
  "sauce-seasoning": "ซอสและเครื่องปรุงรส",
  "sweet-and-sour-sauces": "น้ำจิ้มและซอสเปรี้ยวหวาน",
  "snacks-confectionery": "ขนมขบเคี้ยวและลูกอม",
  snacks: "ขนมขบเคี้ยว",
  beverages: "เครื่องดื่ม",
  drinks: "เครื่องดื่ม",
  "alcoholic-beverages": "เครื่องดื่มแอลกอฮอล์",
  "alcoholic-drinks": "เครื่องดื่มแอลกอฮอล์",
  "household-supplies": "ของใช้ในบ้าน",
  "home-care": "ผลิตภัณฑ์ดูแลบ้านและซักล้าง",
  "personal-care": "ของใช้ส่วนตัว",
  "health-beauty": "สุขภาพและความงาม",
  meat: "เนื้อสัตว์และแปรรูป",
  "fish-seafood": "อาหารทะเลและประมง",
  "fruit-vegetables": "ผักและผลไม้",
  "mom-baby": "แม่และเด็ก",
  "pet-supplies": "อาหารและของใช้สัตว์เลี้ยง",
  pets: "สัตว์เลี้ยง",
  "office-supplies": "อุปกรณ์สำนักงานและร้านค้า",
  kitchen: "อุปกรณ์ครัวและบรรจุภัณฑ์อาหาร",
  "kitchen-dining": "ครัวและโต๊ะอาหาร",
  lifestyle: "ของใช้ทั่วไปในชีวิตประจำวัน",
  dairy: "นมและผลิตภัณฑ์จากนม",
  "frozen-food": "อาหารแช่แข็ง",
  bakery: "เบเกอรี่และขนมปัง",
};

export const SOURCE_THAI_LABEL: Record<string, string> = {
  "wholesale-main": "คลังค้าส่งมาตรฐาน",
  "retail-modern": "คลังค้าปลีกมาตรฐาน",
  convenience: "คลังสินค้าสะดวกซื้อ",
  supermarket: "คลังซูเปอร์มาร์เก็ต",
  hypermarket: "คลังไฮเปอร์มาร์เก็ต",
  openfoodfacts: "ฐานข้อมูลโภชนาการสากล",
  universal: "คลังสินค้าอุปโภคบริโภคไทย",
};

export const ATTR_GROUP_THAI: Record<string, string> = {
  packaging: "บรรจุภัณฑ์",
  flavor: "รสชาติ/กลิ่น",
  nutrition_claim: "จุดเด่นสุขภาพ/โภชนาการ",
  storage_type: "การเก็บรักษา",
  form: "ลักษณะเนื้อสินค้า",
  pack_type: "รูปแบบแพ็ก",
  certification: "มาตรฐานรับรอง",
  freshness_state: "ความสด/อุณหภูมิ",
  diet_type: "ประเภทอาหารเฉพาะกลุ่ม",
  meal_occasion: "โอกาสรับประทาน",
  cuisine: "สัญชาติอาหาร",
  texture: "เนื้อสัมผัส",
  condiment_type: "ประเภทเครื่องปรุง",
  beverage_type: "ประเภทเครื่องดื่ม",
  target_user: "กลุ่มผู้ใช้",
  consistency: "ลักษณะเนื้อสัมผัส",
  ingredient_base: "วัตถุดิบหลัก",
};

export const ATTR_KEY_THAI: Record<string, string> = {
  "How to Preserve": "วิธีเก็บรักษา",
  "Country of Origin": "ประเทศผู้ผลิต",
  "Net Weight": "น้ำหนักสุทธิ",
  "Shelf Life": "อายุการเก็บรักษา",
};

export const NUTRITION_KEY_THAI: Record<string, string> = {
  "energy-kcal": "พลังงาน (กิโลแคลอรี)",
  "energy-kcal_100g": "พลังงานต่อ 100 กรัม (kcal)",
  fat: "ไขมัน",
  fat_100g: "ไขมันต่อ 100 กรัม (ก.)",
  "saturated-fat": "ไขมันอิ่มตัว",
  "saturated-fat_100g": "ไขมันอิ่มตัวต่อ 100 กรัม (ก.)",
  carbohydrates: "คาร์โบไฮเดรต",
  carbohydrates_100g: "คาร์โบไฮเดรตต่อ 100 กรัม (ก.)",
  sugars: "น้ำตาล",
  sugars_100g: "น้ำตาลต่อ 100 กรัม (ก.)",
  proteins: "โปรตีน",
  proteins_100g: "โปรตีนต่อ 100 กรัม (ก.)",
  sodium: "โซเดียม",
  sodium_100g: "โซเดียมต่อ 100 กรัม (ก.)",
  salt: "เกลือ",
  fiber: "ใยอาหาร",
};

export type ParsedTrait = {
  slug: string;
  groupKey: string;
  groupLabelTh: string;
  valueTh: string;
  fullLabelTh: string;
  rawKey: string;
};

export function toCleanSlug(prefix: string, raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/::/g, "-")
    .replace(/[^a-z0-9\u0E00-\u0E7F]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!cleaned) {
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `${prefix}-${(h >>> 0).toString(16)}`;
  }
  return `${prefix}-${cleaned}`;
}

export function translateCategorySegment(
  rawSeg: string,
  dbTranslations?: Map<string, string>,
): string {
  const seg = rawSeg.trim();
  if (!seg) return "";
  // If already contains Thai characters, keep it clean
  if (/[\u0E00-\u0E7F]/.test(seg)) return seg;
  const low = seg.toLowerCase();
  if (CATEGORY_THAI_FALLBACK[low]) return CATEGORY_THAI_FALLBACK[low];
  const fromDb = dbTranslations?.get(seg) ?? dbTranslations?.get(low);
  if (fromDb && /[\u0E00-\u0E7F]/.test(fromDb)) {
    // Guard known mistranslation in auto-dict ("dry-grocery" -> "เครื่องดื่มแห้ง")
    if (low === "dry-grocery") return "ของแห้งและเครื่องปรุง";
    return fromDb;
  }
  return seg.replace(/[-_]+/g, " ");
}

const SKIP_TRAIT_NODE_KEYS = new Set([
  "ชื่อสินค้า",
  "หมายเหตุ",
  "ขนาด/ปริมาณ",
  "ขนาดแพ็กผู้ผลิต",
  "จำนวนต่อหน่วย",
  "น้ำหนักสุทธิ (กรัม)",
  "How to Preserve",
]);

export function extractProductTraits(
  attributes?: Record<string, string> | null,
): {
  traits: ParsedTrait[];
  displaySpecs: { label: string; value: string }[];
} {
  const traits: ParsedTrait[] = [];
  const displaySpecs: { label: string; value: string }[] = [];
  if (!attributes || typeof attributes !== "object") return { traits, displaySpecs };

  const seenSlugs = new Set<string>();

  for (const [rawKey, rawVal] of Object.entries(attributes)) {
    const val = String(rawVal ?? "").trim();
    if (!val || val === "-" || val.toLowerCase() === "null") continue;
    if (rawKey === "ชื่อสินค้า") continue;

    if (rawKey.includes("::")) {
      const [grpRaw, subRaw] = rawKey.split("::", 2);
      const grpLabel = ATTR_GROUP_THAI[grpRaw] ?? grpRaw.replace(/_/g, " ");
      const valueTh = val;
      const slug = toCleanSlug("trait", `${grpRaw}-${subRaw || val}`);
      displaySpecs.push({ label: grpLabel, value: valueTh });
      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        traits.push({
          slug,
          groupKey: grpRaw,
          groupLabelTh: grpLabel,
          valueTh,
          fullLabelTh: `${grpLabel}: ${valueTh}`,
          rawKey,
        });
      }
      continue;
    }

    const label = ATTR_KEY_THAI[rawKey] ?? rawKey;
    displaySpecs.push({ label, value: val });

    // Promote high-value Thai attributes (e.g. สารก่อภูมิแพ้) into graph trait nodes
    if (!SKIP_TRAIT_NODE_KEYS.has(rawKey) && val.length <= 45) {
      const slug = toCleanSlug("trait", `${rawKey}-${val}`);
      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        traits.push({
          slug,
          groupKey: rawKey,
          groupLabelTh: label,
          valueTh: val,
          fullLabelTh: `${label}: ${val}`,
          rawKey,
        });
      }
    }
  }

  return { traits, displaySpecs };
}
