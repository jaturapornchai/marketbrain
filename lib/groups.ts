// Brain lobes (top-level groups) + typed product synapses shared by server pages, MCP, Javis Nong Muay, and 3D client
export type Audience = "user" | "dev" | "both";
export type AudienceFilter = "all" | "user" | "dev";

export type GroupMeta = {
  label: string;
  shortLabel: string;
  color: string;
  audience: Audience;
};

export const GROUPS: Record<string, GroupMeta> = {
  root: { label: "แกนกลางสมองสินค้า", shortLabel: "แกนกลาง", color: "#ffffff", audience: "both" },
  product: { label: "สินค้าอุปโภคบริโภค", shortLabel: "สินค้า", color: "#38bdf8", audience: "user" },
  category: { label: "กลุ่มและหมวดหมู่สินค้า", shortLabel: "กลุ่มสินค้า", color: "#4ade80", audience: "user" },
  brand: { label: "แบรนด์ / ยี่ห้อ", shortLabel: "แบรนด์", color: "#fbbf24", audience: "user" },
  unit: { label: "หน่วยนับและอัตราบรรจุ", shortLabel: "หน่วยนับ", color: "#f472b6", audience: "user" },
  trait: { label: "คุณลักษณะเด่นและมาตรฐาน", shortLabel: "คุณลักษณะ", color: "#a78bfa", audience: "user" },
  family: { label: "ตระกูลสินค้าหลายขนาด/แพ็ก", shortLabel: "ตระกูลแพ็ก", color: "#2dd4bf", audience: "user" },
  source: { label: "แหล่งร้านค้าและตลาดไทย", shortLabel: "แหล่งร้านค้า", color: "#fb923c", audience: "user" },
  schema: { label: "โครงสร้างข้อมูลและ API (Dev)", shortLabel: "สเปก Dev", color: "#95abff", audience: "dev" },
};

export const GROUP_ORDER = Object.keys(GROUPS);

export const ZONE_LABEL: Record<Audience, string> = {
  user: "ผู้ซื้อ/ร้านค้า",
  dev: "นักพัฒนา",
  both: "แกนกลาง",
};

export const MODE_OPTIONS: readonly [AudienceFilter, string][] = [
  ["all", "ทั้งหมด"],
  ["user", "ค้นหาสินค้า"],
  ["dev", "สเปกข้อมูล (Dev)"],
];

export const groupOf = (folder: string): GroupMeta =>
  GROUPS[folder] ?? { label: folder, shortLabel: folder, color: "#c9d1ff", audience: "user" };

export function matchesAudience(aud: Audience, filter: AudienceFilter = "all"): boolean {
  return filter === "all" || aud === "both" || aud === filter;
}

export function normalizeAudienceFilter(value?: string | null): AudienceFilter {
  return value === "user" || value === "dev" ? value : "all";
}

export const RELATION_TYPES = [
  "in_category",
  "sub_category",
  "has_brand",
  "uses_unit",
  "converts_unit",
  "has_trait",
  "in_family",
  "pack_variant",
  "sold_at",
  "brand_in_cat",
  "hub_map",
  "uses_table",
  "exposes_api",
  "follows_rule",
  "bridges_zone",
  "related",
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export const RELATION_LABEL: Record<RelationType, string> = {
  in_category: "อยู่ในกลุ่มสินค้า",
  sub_category: "หมวดหมู่ย่อยของ",
  has_brand: "แบรนด์/ยี่ห้อ",
  uses_unit: "หน่วยนับหลัก",
  converts_unit: "แปลงหน่วยบรรจุ",
  has_trait: "คุณลักษณะเด่น",
  in_family: "ตระกูลสินค้าเดียวกัน",
  pack_variant: "ขนาดแพ็ก/ลังคู่เทียบ",
  sold_at: "จำหน่ายที่แหล่ง",
  brand_in_cat: "แบรนด์ในหมวดหมู่",
  hub_map: "แผนที่หลัก",
  uses_table: "อ้างอิงตารางข้อมูล",
  exposes_api: "สเปก API/MCP",
  follows_rule: "กติกามาตรฐาน",
  bridges_zone: "เชื่อมข้อมูล-สินค้า",
  related: "เชื่อมโยงใกล้เคียง",
};

const RELATION_SET = new Set<string>(RELATION_TYPES);
export const isRelationType = (v: string): v is RelationType => RELATION_SET.has(v);

export function inferRelation(fromFolder: string, toFolder: string): RelationType {
  if (fromFolder === "root" || toFolder === "root") return "hub_map";
  if (fromFolder === "category" && toFolder === "category") return "sub_category";
  if (toFolder === "category") return fromFolder === "brand" ? "brand_in_cat" : "in_category";
  if (toFolder === "brand") return "has_brand";
  if (toFolder === "unit") return "uses_unit";
  if (toFolder === "trait") return "has_trait";
  if (toFolder === "family") return "in_family";
  if (toFolder === "source") return "sold_at";
  if (toFolder === "schema") return "uses_table";
  return "related";
}
