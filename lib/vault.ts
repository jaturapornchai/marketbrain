import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { marked } from "marked";
import {
  GROUP_ORDER,
  RELATION_LABEL,
  groupOf,
  inferRelation,
  isRelationType,
  matchesAudience,
  type Audience,
  type AudienceFilter,
  type RelationType,
} from "./groups";
import { compareMoney, formatThaiBaht, moneyInRange } from "./decimal-money";
import { NUTRITION_KEY_THAI, SOURCE_THAI_LABEL, toCleanSlug } from "./trait-dictionary";
import {
  readCachedBrainSnapshot,
  syncBrainSnapshotFromDb,
  type BrainProductItem,
  type BrainSnapshot,
  type BrainUnitItem,
} from "./product-source";

export type Edge = {
  slug: string;
  rel: RelationType;
  inferred?: boolean;
};

export type ImageMedia = {
  alt: string;
  url: string;
};

export type VideoMedia = {
  title: string;
  url: string;
  videoId?: string;
  listId?: string;
  thumbnailUrl?: string;
  embedUrl: string;
};

export type WebPageLink = {
  title: string;
  url: string;
};

export type NoteMedia = {
  images: ImageMedia[];
  videos: VideoMedia[];
  webPages: WebPageLink[];
};

export type MediaItem = {
  kind: "youtube" | "image" | "webpage";
  title: string;
  url: string;
  noteSlug: string;
  noteTitle: string;
};

export type Note = {
  slug: string;
  folder: string;
  audience: Audience;
  title: string;
  subtitle?: string;
  priceLabel?: string;
  unitLabel?: string;
  barcode?: string | null;
  imageUrl?: string | null;
  tags: string[];
  aliases: string[];
  sources: string[];
  body: string;
  links: string[];
  backlinks: string[];
  outEdges: Edge[];
  inEdges: Edge[];
  media?: NoteMedia;
  haystack: { title: string; meta: string; body: string };
};

export type SearchHit = {
  slug: string;
  title: string;
  folder: string;
  audience: Audience;
  tags: string[];
  score: number;
  snippet: string;
  priceLabel?: string;
  unitLabel?: string;
  barcode?: string | null;
  imageUrl?: string | null;
  images?: ImageMedia[];
};

export type TraverseStep = {
  slug: string;
  title: string;
  folder: string;
  audience: Audience;
  hop: number;
  via: string;
  rel: RelationType;
  direction: "out" | "in";
  priceLabel?: string;
  unitLabel?: string;
  imageUrl?: string | null;
};

export type TraverseOptions = {
  slug: string;
  toSlug?: string;
  depth?: number;
  direction?: "both" | "out" | "in";
  relation?: RelationType;
  folder?: string;
  audience?: AudienceFilter;
  limit?: number;
};

export type TraverseResult = {
  start: Note | null;
  target?: Note | null;
  mode: "neighborhood" | "path";
  neighbors: TraverseStep[];
  path?: TraverseStep[];
};

export type GraphNode = {
  slug: string;
  title: string;
  folder: string;
  audience: Audience;
  degree: number;
  keywords: string;
  priceLabel?: string;
  unitLabel?: string;
  barcode?: string | null;
  imageUrl?: string | null;
  pos: [number, number, number];
};

export type BrainStats = {
  totalNotes: number;
  totalSynapses: number;
  totalProducts: number;
  totalCategories: number;
  totalBrands: number;
  totalUnits: number;
  totalTraits: number;
  totalFamilies: number;
  totalSources: number;
  syncedAt: string;
};

export type GraphData = {
  nodes: GraphNode[];
  links: [number, number][];
  rels: RelationType[];
  stats: BrainStats;
};

export type VaultRow = {
  slug: string;
  title: string;
  folder: string;
  audience: Audience;
  tags: string[];
  priceLabel?: string;
  unitLabel?: string;
  imageUrl?: string | null;
};

export type CategoryFacetNode = {
  slug: string;
  label: string;
  pathLabel: string;
  depth: number;
  parentSlug: string | null;
  count: number;
  children: CategoryFacetNode[];
};

export type FacetBucket = {
  slug: string;
  label: string;
  group?: string;
  count: number;
};

export type ProductSearchQuery = {
  q?: string;
  category?: string;
  brand?: string;
  unit?: string;
  traits?: string[];
  source?: string;
  minPrice?: string;
  maxPrice?: string;
  multiUnitOnly?: boolean;
  thaiGs1Only?: boolean;
  sort?: "relevance" | "price_asc" | "price_desc" | "unit_price_asc" | "pack_desc";
  page?: number;
  pageSize?: number;
};

export type ProductSearchResult = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  appliedTerms: string[];
  items: BrainProductItem[];
  facets: {
    categories: CategoryFacetNode[];
    brands: FacetBucket[];
    units: FacetBucket[];
    traits: FacetBucket[];
    sources: FacetBucket[];
  };
};

const VAULT_DIR = path.join(process.cwd(), "vault");
const WIKILINK = /\[\[(?:([a-z_]+)::)?([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const VALID_AUDIENCES = new Set<Audience>(["user", "dev", "both"]);

export const normalizeText = (s: string) =>
  s
    .toLowerCase()
    .replace(/สต๊อก/g, "สต็อก")
    .replace(/แพ็ค/g, "แพ็ก")
    .replace(/น้ํา/g, "น้ำ")
    .replace(/กํา/g, "กำ")
    .replace(/สํา/g, "สำ")
    .replace(/จํา/g, "จำ")
    .replace(/ทํา/g, "ทำ")
    .replace(/ดํา/g, "ดำ")
    .replace(/คํา/g, "คำ")
    .replace(/(?<!ผง)ชูรส/g, "ผงชูรส")
    .replace(/ก\.ก\.|กก\./g, "กก")
    .replace(/ม\.ล\.|มล\./g, "มล")
    .replace(/กรัม/g, "ก");

const segmenter = new Intl.Segmenter("th", { granularity: "word" });
const STOP = new Set(
  "คือ อะไร ยังไง อย่างไร ไหม มั้ย หรือ และ ที่ ของ การ ความ ใน ให้ ได้ มี เป็น จะ ว่า กับ แล้ว บ้าง ช่วย หน่อย ครับ ค่ะ คะ นะ เรา ผม ตี๋ น้องตี๋ หา ดู ขอ เอา ตัว อัน แบบ ไม่ ใส่ the a an of to is are how what in on and or for with".split(
    " ",
  ),
);

const COMPOUND_CLAIMS = [
  "ไม่ใส่ผงชูรส",
  "ไร้ผงชูรส",
  "ไม่มีผงชูรส",
  "ไม่เจือสี",
  "ไม่ใส่สี",
  "ไม่มีน้ำตาล",
  "ไม่เติมน้ำตาล",
  "ไม่มีกลูเตน",
  "ไร้กลูเตน",
  "ไม่ใช้วัตถุกันเสีย",
  "ไม่ใส่วัตถุกันเสีย",
  "ไม่ใส่สารกันบูด",
];

const SYNONYM_GROUPS: string[][] = [
  ["ไม่ใส่ผงชูรส", "no_msg", "ไร้ผงชูรส", "ไม่มีผงชูรส"],
  ["ฮาลาล", "halal", "อิสลาม"],
  ["ยกลัง", "ลัง", "หีบ", "carton", "uctn", "ขายส่ง"],
  ["แพ็ก", "แพ็ค", "pack", "upck", "multipack", "แพ็กหลายชิ้น"],
  ["โหล", "12ชิ้น", "udz", "dozen"],
  ["ขวด", "bottle", "ubtl"],
  ["ซอง", "ถุง", "ห่อ", "bag", "pouch", "ubag", "upkt"],
  ["กระป๋อง", "can", "ucan"],
  ["กล่อง", "box", "ubox"],
  ["กระสอบ", "sack", "ubg"],
  ["แช่แข็ง", "frozen", "ฟรีซ"],
  ["ไม่เจือสี", "ไม่ใส่สี", "no_coloring"],
  ["ไม่มีน้ำตาล", "ไม่เติมน้ำตาล", "sugar_free", "no_added_sugar", "หวานน้อย"],
  ["ไม่มีกลูเตน", "ไร้กลูเตน", "gluten_free"],
  ["บาร์โค้ดไทย", "สินค้าไทย", "885", "gs1"],
  ["น้ำจิ้ม", "ซอส", "น้ำปลา", "ซีอิ๊ว", "เครื่องปรุง"],
  ["ขนม", "ขนมขบเคี้ยว", "สแน็ก", "snack"],
  ["นม", "เครื่องดื่ม", "น้ำดื่ม", "กาแฟ", "ชา"],
  ["สบู่", "ยาสีฟัน", "แชมพู", "ของใช้ส่วนตัว"],
  ["ผงซักฟอก", "น้ำยาล้างจาน", "น้ำยาปรับผ้านุ่ม", "ของใช้ในบ้าน"],
];

const SYNONYM_MAP = (() => {
  const m = new Map<string, Set<string>>();
  for (const grp of SYNONYM_GROUPS) {
    const norm = grp.map(normalizeText);
    for (const w of norm) {
      if (!m.has(w)) m.set(w, new Set());
      for (const other of norm) if (other !== w) m.get(w)!.add(other);
    }
  }
  return m;
})();

export function expandSynonyms(primaryTerms: string[]): string[] {
  const seen = new Set(primaryTerms);
  const out: string[] = [];
  for (const t of primaryTerms) {
    for (const syn of SYNONYM_MAP.get(t) ?? []) {
      if (seen.has(syn) || STOP.has(syn)) continue;
      seen.add(syn);
      out.push(syn);
      if (out.length >= 10) return out;
    }
  }
  return out;
}

const TOKEN_SEG_CACHE = new Map<string, string[]>();

function tokenizeShortText(normText: string): string[] {
  if (!normText) return [];
  const cached = TOKEN_SEG_CACHE.get(normText);
  if (cached) return cached;

  const out: string[] = [];
  for (const s of segmenter.segment(normText)) {
    if (!s.isWordLike) continue;
    const w = s.segment.trim();
    if (w.length > 1 && !STOP.has(w)) {
      out.push(w);
      if (w.includes("_") || w.includes("-")) {
        for (const sub of w.split(/[_-]+/)) {
          if (sub.length > 1 && !STOP.has(sub)) out.push(sub);
        }
      }
    }
  }
  if (TOKEN_SEG_CACHE.size < 25000) {
    TOKEN_SEG_CACHE.set(normText, out);
  }
  return out;
}

function tokenizeBodyFast(normText: string): string[] {
  if (!normText) return [];
  const out: string[] = [];
  let rest = normText;
  for (const cp of COMPOUND_CLAIMS) {
    if (rest.includes(cp)) {
      out.push(cp);
      rest = rest.split(cp).join(" ");
    }
  }
  const chunks = rest.split(/[\s,;|/()[\]{}:"'`•·>\n\r]+/);
  for (const chunk of chunks) {
    if (!chunk || chunk.length <= 1 || STOP.has(chunk)) continue;
    if (/^[a-z0-9_.-]+$/.test(chunk)) {
      out.push(chunk);
      if (chunk.includes("_") || chunk.includes("-")) {
        for (const p of chunk.split(/[_-]+/)) {
          if (p.length > 1 && !STOP.has(p)) out.push(p);
        }
      }
    } else if (chunk.length <= 42) {
      for (const tok of tokenizeShortText(chunk)) out.push(tok);
    } else {
      for (const s of segmenter.segment(chunk)) {
        if (s.isWordLike && s.segment.length > 1 && !STOP.has(s.segment)) {
          out.push(s.segment);
        }
      }
    }
  }
  return out;
}

export function terms(q: string): string[] {
  const norm = normalizeText(q.trim());
  if (!norm) return [];
  return [...new Set(tokenizeBodyFast(norm))];
}

const linkTarget = (raw: string) => path.basename(raw.trim()).toLowerCase();

function walkVaultMd(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    if (e.name.startsWith(".")) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walkVaultMd(p);
    return e.isFile() && e.name.endsWith(".md") ? [p] : [];
  });
}

function buildProductMarkdown(p: BrainProductItem, familySlug: string | null): string {
  const lines: string[] = [];
  if (p.imageUrl) {
    lines.push(`![${p.nameTh}](${p.imageUrl})`, "");
  }
  lines.push(`# ${p.nameTh}`);
  if (p.nameEn && p.nameEn !== p.nameTh) {
    lines.push(`*ชื่อภาษาอังกฤษ: ${p.nameEn}*`);
  }
  lines.push("");

  lines.push("## ข้อมูลหลักและราคา");
  lines.push("| รายการ | รายละเอียด |");
  lines.push("|---|---|");
  lines.push(`| **รหัสสินค้า** | \`${p.productCode}\` |`);
  if (p.primaryBarcode) {
    lines.push(`| **บาร์โค้ดหลัก** | \`${p.primaryBarcode}\`${p.isThaiGs1 ? " *(GS1 ประเทศไทย 885)*" : ""} |`);
  }
  if (p.barcodes.length > 1) {
    lines.push(`| **บาร์โค้ดทั้งหมด** | ${p.barcodes.map((b) => `\`${b}\``).join(", ")} |`);
  }
  if (p.brandTh || p.brandEn) {
    const bLabel = [p.brandTh, p.brandEn && p.brandEn !== p.brandTh ? `(${p.brandEn})` : ""].filter(Boolean).join(" ");
    lines.push(`| **แบรนด์ / ยี่ห้อ** | ${p.brandSlug ? `[[has_brand::${p.brandSlug}|${bLabel}]]` : bLabel} |`);
  }
  lines.push(`| **กลุ่มสินค้า** | ${p.categoryPathTh} |`);
  lines.push(`| **ราคาขายดีที่สุด** | **${formatThaiBaht(p.bestPrice)}** / ${p.unitCode} |`);
  if (p.minPrice && p.maxPrice && p.minPrice !== p.maxPrice) {
    lines.push(`| **ช่วงราคาตลาด** | ${formatThaiBaht(p.minPrice)} – ${formatThaiBaht(p.maxPrice)} |`);
  }
  if (p.pricePerBaseUnit && (p.packQty > 1 || p.unitCode !== p.baseUnitCode)) {
    lines.push(`| **ราคาเฉลี่ยต่อหน่วยย่อย** | ${formatThaiBaht(p.pricePerBaseUnit)} / ${p.baseUnitCode} (บรรจุ ${p.packQty} ${p.baseUnitCode}) |`);
  }
  lines.push(`| **หน่วยนับหลัก** | \`${p.unitCode}\`${p.unitSysCode ? ` (\`${p.unitSysCode}\`)` : ""} |`);
  if (p.dimensionsText || p.netWeightGram) {
    lines.push(`| **ขนาด / น้ำหนักสุทธิ** | ${p.dimensionsText || `${p.netWeightGram} กรัม`} |`);
  }
  if (p.fdaNumber) lines.push(`| **เลข อย.** | \`${p.fdaNumber}\` |`);
  if (p.originCountry) lines.push(`| **ประเทศต้นกำเนิด** | ${p.originCountry} |`);

  if (p.unitConversions.length > 0 || p.barcodeUnits.length > 0) {
    lines.push("", "## หน่วยนับและอัตราการแปลงหน่วย");
    lines.push("| หน่วยนับ | อัตราส่วน | ราคาต่อหน่วย | บาร์โค้ดผูกหน่วย |");
    lines.push("|---|---|---|---|");
    if (p.unitConversions.length > 0) {
      for (const uc of p.unitConversions) {
        lines.push(
          `| **${uc.unitNameTh}** (\`${uc.unitSysCode || uc.unitCode}\`) | ${uc.ratioText || `${uc.standValue}:${uc.divideValue}`} | ${formatThaiBaht(uc.pricePerUnit)} | ${uc.linkedBarcode ? `\`${uc.linkedBarcode}\`` : "-"} |`,
        );
      }
    } else {
      for (const bu of p.barcodeUnits) {
        lines.push(
          `| **${bu.unitNameTh}** (\`${bu.unitSysCode || bu.unitCode}\`) | ${bu.ratioText || "1 หน่วย"} | ${formatThaiBaht(bu.price)} | \`${bu.barcode}\` |`,
        );
      }
    }
  }

  if (p.traits.length > 0 || p.specs.length > 0) {
    lines.push("", "## คุณลักษณะและสเปกสินค้า");
    if (p.traits.length > 0) {
      lines.push(
        "- **ป้ายคุณลักษณะเชื่อมสมอง**: " +
          p.traits.map((t) => `[[has_trait::${t.slug}|${t.fullLabelTh}]]`).join(" · "),
      );
    }
    for (const sp of p.specs) {
      lines.push(`- **${sp.label}**: ${sp.value}`);
    }
  }

  if (p.features || p.description) {
    lines.push("", "## รายละเอียดเพิ่มเติม");
    if (p.features) lines.push(p.features);
    if (p.description && p.description !== p.features) lines.push("", p.description);
  }

  if (p.ingredients) {
    lines.push("", "## ส่วนประกอบ / ส่วนผสม", p.ingredients);
  }

  const nutriEntries = Object.entries(p.nutrition);
  if (nutriEntries.length > 0) {
    lines.push("", "## ข้อมูลโภชนาการ");
    lines.push("| สารอาหาร | ปริมาณ |");
    lines.push("|---|---|");
    for (const [k, v] of nutriEntries) {
      lines.push(`| ${NUTRITION_KEY_THAI[k] ?? k} | ${v} |`);
    }
  }

  if (p.storage || p.usageInstructions || p.warnings || p.wholesaleInfo) {
    lines.push("", "## การใช้งานและการเก็บรักษา");
    if (p.usageInstructions) lines.push(`- **วิธีใช้**: ${p.usageInstructions}`);
    if (p.storage) lines.push(`- **การเก็บรักษา**: ${p.storage}`);
    if (p.warnings) lines.push(`- **คำเตือน / ข้อควรระวัง**: ${p.warnings}`);
    if (p.wholesaleInfo) lines.push(`- **ข้อมูลขายส่ง**: ${p.wholesaleInfo}`);
  }

  if (familySlug || p.relatedProducts.length > 0) {
    lines.push("", "## ตระกูลสินค้าและขนาดบรรจุคู่เทียบ");
    if (familySlug) lines.push(`- ตระกูลสินค้าเดียวกัน: [[in_family::${familySlug}]]`);
    for (const rp of p.relatedProducts) {
      lines.push(
        `- **${rp.title}** — หน่วย \`${rp.unitCode}\` (บรรจุ ${rp.packQty}) ราคา ${formatThaiBaht(rp.bestPrice)}${rp.primaryBarcode ? ` · บาร์โค้ด \`${rp.primaryBarcode}\`` : ""}`,
      );
    }
  }

  if (p.sources.length > 0) {
    lines.push("", "## ช่องทางจัดจำหน่ายอ้างอิง");
    const uniqueChannels = new Map<string, { label: string; price: string | null; unitText: string }>();
    for (const s of p.sources) {
      if (!uniqueChannels.has(s.source)) uniqueChannels.set(s.source, s);
    }
    for (const s of uniqueChannels.values()) {
      const priceTxt = s.price ? ` (${formatThaiBaht(s.price)}${s.unitText ? ` / ${s.unitText}` : ""})` : "";
      lines.push(`- **${s.label}**${priceTxt}`);
    }
  }

  return lines.join("\n");
}

type Posting = {
  idx: Int32Array;
  raw: Float32Array;
  idf: number;
};

type SearchIndex = {
  notes: Note[];
  slugToIdx: Map<string, number>;
  avgLen: number;
  postings: Map<string, Posting>;
  bodies: string[];
  titles: string[];
  metas: string[];
  neighborIdx: Int32Array[];
  neighborWeights: Float32Array[];
  baseBuf: Float64Array;
  matchBuf: Int32Array;
};

type CategoryInternal = {
  slug: string;
  label: string;
  pathLabel: string;
  depth: number;
  parentSlug: string | null;
  productSlugs: string[];
  childrenSlugs: string[];
};

type VaultBundle = {
  builtAt: number;
  syncedAt: string;
  notes: Map<string, Note>;
  productsBySlug: Map<string, BrainProductItem>;
  productByBarcode: Map<string, BrainProductItem>;
  productByCode: Map<string, BrainProductItem>;
  productsList: BrainProductItem[];
  unitsList: BrainUnitItem[];
  categoriesMap: Map<string, CategoryInternal>;
  categoryDescendantSlugs: Map<string, Set<string>>;
  productFamilyMap: Map<string, string>;
  stats: BrainStats;
  graphs: Map<AudienceFilter, GraphData>;
  rendered: Map<string, string>;
  rows: Map<AudienceFilter, VaultRow[]>;
  folders: Map<AudienceFilter, string[]>;
  grouped: Map<AudienceFilter, [string, Note[]][]>;
  searches: Map<string, SearchHit[]>;
  indexes: Map<AudienceFilter, SearchIndex>;
  productPostings: Map<string, Int32Array>;
};

let bundleCache: VaultBundle | null = null;

function ensureSnapshotSync(): BrainSnapshot {
  const cached = readCachedBrainSnapshot();
  if (cached && cached.products.length > 0) return cached;
  return {
    syncedAt: new Date().toISOString(),
    dbName: "bcscanproduct",
    productCount: 0,
    unitCount: 0,
    units: [],
    products: [],
  };
}

function addEdgeUnique(note: Note, targetSlug: string, rel: RelationType, inferred = false) {
  if (!targetSlug || targetSlug === note.slug) return;
  if (note.outEdges.some((e) => e.slug === targetSlug)) return;
  note.outEdges.push({ slug: targetSlug, rel, inferred });
  note.links.push(targetSlug);
}

function buildBundleFromSnapshot(snap: BrainSnapshot): VaultBundle {
  const notes = new Map<string, Note>();
  const rawMdLinks = new Map<string, { target: string; explicitRel?: RelationType }[]>();

  // 1) Load static hub/playbook/schema notes from vault/*.md
  for (const file of walkVaultMd(VAULT_DIR)) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
    let meta: Record<string, unknown> = {};
    if (fm) {
      try {
        meta = ((parseYaml(fm[1]) as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }
    const body = fm ? text.slice(fm[0].length) : text;
    const slug = path.basename(file, ".md").toLowerCase();
    const relParts = path.relative(VAULT_DIR, file).split(path.sep);
    const folder = relParts.length > 1 ? relParts[0] : "root";
    const rawAud = typeof meta.audience === "string" ? meta.audience.trim().toLowerCase() : "";
    const audience: Audience = VALID_AUDIENCES.has(rawAud as Audience)
      ? (rawAud as Audience)
      : groupOf(folder).audience;
    const title = String(meta.title ?? body.match(/^#\s+(.+)$/m)?.[1] ?? slug);
    const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
    const aliases = Array.isArray(meta.aliases) ? meta.aliases.map(String) : [];
    const parsedLinks = [...body.matchAll(WIKILINK)].map((m) => ({
      target: linkTarget(m[2]),
      explicitRel: m[1] && isRelationType(m[1]) ? m[1] : undefined,
    }));
    rawMdLinks.set(slug, parsedLinks);
    notes.set(slug, {
      slug,
      folder,
      audience,
      title,
      tags,
      aliases,
      sources: [],
      body,
      links: [],
      backlinks: [],
      outEdges: [],
      inEdges: [],
      haystack: {
        title: normalizeText(title),
        meta: normalizeText([slug, folder, ...tags, ...aliases].join(" ")),
        body: normalizeText(body),
      },
    });
  }

  const productsBySlug = new Map<string, BrainProductItem>();
  const productByBarcode = new Map<string, BrainProductItem>();
  const productByCode = new Map<string, BrainProductItem>();
  const categoriesMap = new Map<string, CategoryInternal>();
  const brandBuckets = new Map<
    string,
    { slug: string; nameTh: string; nameEn: string; products: BrainProductItem[]; catSlugs: Set<string> }
  >();
  const unitSlugByCode = new Map<string, string>();
  const unitProductsMain = new Map<string, BrainProductItem[]>();
  const unitProductsConv = new Map<string, BrainProductItem[]>();
  const traitBuckets = new Map<
    string,
    { slug: string; groupLabelTh: string; valueTh: string; fullLabelTh: string; products: BrainProductItem[] }
  >();
  const familyGroups = new Map<string, { key: string; code: string; products: BrainProductItem[] }>();
  const sourceBuckets = new Map<string, { id: string; label: string; products: BrainProductItem[] }>();

  // Register unit master nodes first
  for (const u of snap.units) {
    const uSlug = toCleanSlug("unit", u.unitSysCode || u.code);
    unitSlugByCode.set(u.code.toLowerCase(), uSlug);
    if (u.unitSysCode) unitSlugByCode.set(u.unitSysCode.toLowerCase(), uSlug);
    unitSlugByCode.set(u.nameTh.toLowerCase(), uSlug);
  }

  // Group products into categories, brands, traits, families, units, and sources
  for (const p of snap.products) {
    productsBySlug.set(p.slug, p);
    productByCode.set(p.productCode.toLowerCase(), p);
    for (const bc of p.barcodes) {
      if (!productByBarcode.has(bc)) productByBarcode.set(bc, p);
    }

    // Categories hierarchy
    for (let d = 0; d < p.categoryLevelsTh.length; d++) {
      const cSlug = p.categorySlugs[d];
      const parentSlug = d > 0 ? p.categorySlugs[d - 1] : null;
      let cNode = categoriesMap.get(cSlug);
      if (!cNode) {
        cNode = {
          slug: cSlug,
          label: p.categoryLevelsTh[d],
          pathLabel: p.categoryLevelsTh.slice(0, d + 1).join(" > "),
          depth: d + 1,
          parentSlug,
          productSlugs: [],
          childrenSlugs: [],
        };
        categoriesMap.set(cSlug, cNode);
        if (parentSlug) {
          const pNode = categoriesMap.get(parentSlug);
          if (pNode && !pNode.childrenSlugs.includes(cSlug)) {
            pNode.childrenSlugs.push(cSlug);
          }
        }
      }
      if (d === p.categoryLevelsTh.length - 1) {
        cNode.productSlugs.push(p.slug);
      }
    }

    // Brands
    if (p.brandSlug) {
      let b = brandBuckets.get(p.brandSlug);
      if (!b) {
        b = {
          slug: p.brandSlug,
          nameTh: p.brandTh || p.brandEn,
          nameEn: p.brandEn,
          products: [],
          catSlugs: new Set(),
        };
        brandBuckets.set(p.brandSlug, b);
      }
      b.products.push(p);
      if (p.categorySlugs[0]) b.catSlugs.add(p.categorySlugs[0]);
    }

    // Units
    let mainUSlug =
      unitSlugByCode.get(p.unitCode.toLowerCase()) ??
      (p.unitSysCode ? unitSlugByCode.get(p.unitSysCode.toLowerCase()) : undefined);
    if (!mainUSlug) {
      mainUSlug = toCleanSlug("unit", p.unitSysCode || p.unitCode);
      unitSlugByCode.set(p.unitCode.toLowerCase(), mainUSlug);
    }
    const uMainArr = unitProductsMain.get(mainUSlug) ?? [];
    uMainArr.push(p);
    unitProductsMain.set(mainUSlug, uMainArr);

    for (const uc of p.unitConversions) {
      const cCode = uc.unitCode.toLowerCase();
      if (cCode === p.unitCode.toLowerCase()) continue;
      let convSlug =
        unitSlugByCode.get(cCode) ??
        (uc.unitSysCode ? unitSlugByCode.get(uc.unitSysCode.toLowerCase()) : undefined);
      if (!convSlug) {
        convSlug = toCleanSlug("unit", uc.unitSysCode || uc.unitCode);
        unitSlugByCode.set(cCode, convSlug);
      }
      const arr = unitProductsConv.get(convSlug) ?? [];
      arr.push(p);
      unitProductsConv.set(convSlug, arr);
    }

    // Traits
    for (const tr of p.traits) {
      let tb = traitBuckets.get(tr.slug);
      if (!tb) {
        tb = {
          slug: tr.slug,
          groupLabelTh: tr.groupLabelTh,
          valueTh: tr.valueTh,
          fullLabelTh: tr.fullLabelTh,
          products: [],
        };
        traitBuckets.set(tr.slug, tb);
      }
      tb.products.push(p);
    }

    // Families (group multi-size / multi-pack siblings)
    const famKey = p.baseItemCode || p.productFamilyKey;
    if (famKey) {
      let fg = familyGroups.get(famKey);
      if (!fg) {
        fg = { key: famKey, code: p.baseItemCode || toCleanSlug("grp", famKey).toUpperCase(), products: [] };
        familyGroups.set(famKey, fg);
      }
      fg.products.push(p);
    }

    // Sources
    const seenSrc = new Set<string>();
    for (const s of p.sources) {
      if (seenSrc.has(s.source)) continue;
      seenSrc.add(s.source);
      let sb = sourceBuckets.get(s.source);
      if (!sb) {
        sb = { id: s.source, label: SOURCE_THAI_LABEL[s.source] ?? s.label, products: [] };
        sourceBuckets.set(s.source, sb);
      }
      sb.products.push(p);
    }
  }

  // Compute category descendants for fast subtree filtering + counts
  const categoryDescendantSlugs = new Map<string, Set<string>>();
  function collectCatDescendants(slug: string): Set<string> {
    const existing = categoryDescendantSlugs.get(slug);
    if (existing) return existing;
    const set = new Set<string>([slug]);
    const node = categoriesMap.get(slug);
    if (node) {
      for (const ch of node.childrenSlugs) {
        for (const sub of collectCatDescendants(ch)) set.add(sub);
      }
    }
    categoryDescendantSlugs.set(slug, set);
    return set;
  }
  for (const cSlug of categoriesMap.keys()) collectCatDescendants(cSlug);

  // 2) Create Category Notes
  for (const c of categoriesMap.values()) {
    const descSet = categoryDescendantSlugs.get(c.slug)!;
    let totalInSubtree = 0;
    const sampleProducts: BrainProductItem[] = [];
    for (const subSlug of descSet) {
      const subNode = categoriesMap.get(subSlug);
      if (!subNode) continue;
      totalInSubtree += subNode.productSlugs.length;
      for (const ps of subNode.productSlugs) {
        if (sampleProducts.length >= 24) break;
        const prod = productsBySlug.get(ps);
        if (prod) sampleProducts.push(prod);
      }
    }
    const bodyLines = [
      `# กลุ่มสินค้า: ${c.pathLabel}`,
      "",
      `- **ระดับหมวดหมู่**: ชั้นที่ ${c.depth}`,
      `- **จำนวนสินค้าในกลุ่มนี้ (รวมหมวดย่อย)**: ${totalInSubtree.toLocaleString("th-TH")} รายการ`,
    ];
    if (c.parentSlug && categoriesMap.has(c.parentSlug)) {
      bodyLines.push(`- **หมวดหมู่แม่**: [[sub_category::${c.parentSlug}|${categoriesMap.get(c.parentSlug)!.pathLabel}]]`);
    }
    if (c.childrenSlugs.length > 0) {
      bodyLines.push(
        "- **หมวดหมู่ย่อย**: " +
          c.childrenSlugs
            .map((cs) => `[[sub_category::${cs}|${categoriesMap.get(cs)?.label ?? cs}]]`)
            .join(" · "),
      );
    }
    if (sampleProducts.length > 0) {
      bodyLines.push("", "## ตัวอย่างสินค้าในกลุ่มนี้");
      for (const sp of sampleProducts) {
        bodyLines.push(`- [[in_category::${sp.slug}|${sp.nameTh}]] — ${formatThaiBaht(sp.bestPrice)} / ${sp.unitCode}`);
      }
    }
    const body = bodyLines.join("\n");
    const note: Note = {
      slug: c.slug,
      folder: "category",
      audience: "user",
      title: `หมวด: ${c.pathLabel}`,
      subtitle: `${totalInSubtree.toLocaleString("th-TH")} สินค้า`,
      tags: ["กลุ่มสินค้า", `ชั้นที่${c.depth}`, c.label],
      aliases: [c.label, c.pathLabel],
      sources: [],
      body,
      links: [],
      backlinks: [],
      outEdges: [],
      inEdges: [],
      haystack: {
        title: normalizeText(`${c.label} ${c.pathLabel}`),
        meta: normalizeText(`กลุ่มสินค้า หมวดหมู่ ${c.pathLabel}`),
        body: normalizeText(body),
      },
    };
    if (c.parentSlug) addEdgeUnique(note, c.parentSlug, "sub_category");
    else addEdgeUnique(note, "index", "hub_map");
    notes.set(c.slug, note);
  }

  // 3) Create Brand Notes
  for (const b of brandBuckets.values()) {
    const label = b.nameEn && b.nameEn.toLowerCase() !== b.nameTh.toLowerCase() ? `${b.nameTh} (${b.nameEn})` : b.nameTh;
    const sortedByPrice = [...b.products].filter((x) => x.bestPrice).sort((x, y) => compareMoney(x.bestPrice, y.bestPrice));
    const minP = sortedByPrice[0]?.bestPrice;
    const maxP = sortedByPrice[sortedByPrice.length - 1]?.bestPrice;
    const bodyLines = [
      `# แบรนด์: ${label}`,
      "",
      `- **จำนวนสินค้าในสมอง**: ${b.products.length.toLocaleString("th-TH")} รายการ`,
      minP ? `- **ช่วงราคาสินค้า**: ${formatThaiBaht(minP)} – ${formatThaiBaht(maxP)}` : "",
      "",
      "## รายการสินค้าของแบรนด์นี้",
      ...b.products.slice(0, 40).map((p) => `- [[has_brand::${p.slug}|${p.nameTh}]] — ${formatThaiBaht(p.bestPrice)} / ${p.unitCode}${p.primaryBarcode ? ` (\`${p.primaryBarcode}\`)` : ""}`),
    ].filter(Boolean);
    const body = bodyLines.join("\n");
    const note: Note = {
      slug: b.slug,
      folder: "brand",
      audience: "user",
      title: `แบรนด์: ${label}`,
      subtitle: `${b.products.length} สินค้า`,
      imageUrl: b.products[0]?.imageUrl ?? null,
      tags: ["แบรนด์", b.nameTh, ...(b.nameEn ? [b.nameEn] : [])],
      aliases: [b.nameTh, b.nameEn].filter(Boolean),
      sources: [],
      body,
      links: [],
      backlinks: [],
      outEdges: [],
      inEdges: [],
      haystack: {
        title: normalizeText(`แบรนด์ ยี่ห้อ ${label}`),
        meta: normalizeText(`${b.nameTh} ${b.nameEn} แบรนด์ ยี่ห้อ`),
        body: normalizeText(b.products.slice(0, 25).map((p) => p.nameTh).join(" ")),
      },
    };
    for (const cSlug of b.catSlugs) addEdgeUnique(note, cSlug, "brand_in_cat");
    notes.set(b.slug, note);
  }

  // 4) Create Unit Notes
  const allUnitSlugs = new Set<string>([
    ...snap.units.map((u) => toCleanSlug("unit", u.unitSysCode || u.code)),
    ...unitProductsMain.keys(),
    ...unitProductsConv.keys(),
  ]);
  const unitMetaBySlug = new Map<string, BrainUnitItem>();
  for (const u of snap.units) {
    unitMetaBySlug.set(toCleanSlug("unit", u.unitSysCode || u.code), u);
  }
  for (const uSlug of allUnitSlugs) {
    const meta = unitMetaBySlug.get(uSlug);
    const mainProds = unitProductsMain.get(uSlug) ?? [];
    const convProds = unitProductsConv.get(uSlug) ?? [];
    if (!meta && mainProds.length === 0 && convProds.length === 0) continue;
    const nameTh = meta?.nameTh ?? mainProds[0]?.unitCode ?? convProds[0]?.unitCode ?? uSlug.replace(/^unit-/, "");
    const sysCode = meta?.unitSysCode ?? mainProds[0]?.unitSysCode ?? "";
    const unitTypeTh =
      meta?.unitType === "container" ? "หน่วยบรรจุ/แพ็ก/ลัง" : meta?.unitType === "weight" ? "หน่วยน้ำหนัก/ปริมาตร" : "หน่วยฐานขายปลีก";
    const bodyLines = [
      `# หน่วยนับ: ${nameTh}${sysCode ? ` (\`${sysCode}\`)` : ""}`,
      "",
      `- **ประเภทหน่วยนับ**: ${unitTypeTh}`,
      meta?.defaultFactor && meta.defaultFactor > 1 ? `- **อัตราบรรจุมาตรฐาน**: ${meta.defaultFactor} หน่วยย่อย` : "",
      meta?.description ? `- **คำอธิบาย**: ${meta.description}` : "",
      `- **สินค้าที่ใช้เป็นหน่วยขายหลัก**: ${mainProds.length.toLocaleString("th-TH")} รายการ`,
      `- **สินค้าที่แปลงหน่วยบรรจุมายังหน่วยนี้**: ${convProds.length.toLocaleString("th-TH")} รายการ`,
    ].filter(Boolean);
    const sample = [...mainProds.slice(0, 20), ...convProds.slice(0, 10)];
    if (sample.length > 0) {
      bodyLines.push("", "## ตัวอย่างสินค้าที่ใช้หน่วยนับนี้");
      for (const sp of sample.slice(0, 25)) {
        bodyLines.push(`- [[uses_unit::${sp.slug}|${sp.nameTh}]] — ${formatThaiBaht(sp.bestPrice)} / ${sp.unitCode}`);
      }
    }
    const body = bodyLines.join("\n");
    const note: Note = {
      slug: uSlug,
      folder: "unit",
      audience: "user",
      title: `หน่วยนับ: ${nameTh}${sysCode ? ` (${sysCode})` : ""}`,
      subtitle: `${(mainProds.length + convProds.length).toLocaleString("th-TH")} สินค้า`,
      tags: ["หน่วยนับ", nameTh, ...(sysCode ? [sysCode] : [])],
      aliases: [nameTh, sysCode, meta?.nameEn ?? ""].filter(Boolean),
      sources: [],
      body,
      links: [],
      backlinks: [],
      outEdges: [],
      inEdges: [],
      haystack: {
        title: normalizeText(`หน่วยนับ ${nameTh} ${sysCode} ${meta?.nameEn ?? ""}`),
        meta: normalizeText(`หน่วยนับ อัตราบรรจุ ${unitTypeTh} ${nameTh} ${sysCode}`),
        body: normalizeText(body),
      },
    };
    addEdgeUnique(note, "index", "hub_map");
    notes.set(uSlug, note);
  }

  // 5) Create Trait (Attribute) Notes
  for (const tb of traitBuckets.values()) {
    const bodyLines = [
      `# คุณลักษณะสินค้า: ${tb.fullLabelTh}`,
      "",
      `- **หมวดคุณลักษณะ**: ${tb.groupLabelTh}`,
      `- **ค่าคุณลักษณะ**: ${tb.valueTh}`,
      `- **จำนวนสินค้าที่มีคุณลักษณะนี้**: ${tb.products.length.toLocaleString("th-TH")} รายการ`,
      "",
      "## รายการสินค้าที่มีคุณลักษณะนี้",
      ...tb.products.slice(0, 35).map((p) => `- [[has_trait::${p.slug}|${p.nameTh}]] — ${formatThaiBaht(p.bestPrice)} / ${p.unitCode}`),
    ];
    const body = bodyLines.join("\n");
    const note: Note = {
      slug: tb.slug,
      folder: "trait",
      audience: "user",
      title: tb.fullLabelTh,
      subtitle: `${tb.products.length.toLocaleString("th-TH")} สินค้า`,
      tags: ["คุณลักษณะ", tb.groupLabelTh, tb.valueTh],
      aliases: [tb.valueTh, tb.fullLabelTh],
      sources: [],
      body,
      links: [],
      backlinks: [],
      outEdges: [],
      inEdges: [],
      haystack: {
        title: normalizeText(tb.fullLabelTh),
        meta: normalizeText(`คุณลักษณะ คุณสมบัติ ${tb.groupLabelTh} ${tb.valueTh}`),
        body: normalizeText(tb.products.slice(0, 20).map((p) => p.nameTh).join(" ")),
      },
    };
    addEdgeUnique(note, "index", "hub_map");
    notes.set(tb.slug, note);
  }

  // 6) Create Family Notes (only families with >= 2 variants or explicit relatedProducts)
  const productFamilyMap = new Map<string, string>();
  for (const fg of familyGroups.values()) {
    if (fg.products.length < 2) continue;
    const fSlug = toCleanSlug("fam", fg.code || fg.key);
    const sorted = [...fg.products].sort((a, b) => a.packQty - b.packQty || compareMoney(a.bestPrice, b.bestPrice));
    const rep = sorted[0];
    const title = `ตระกูลสินค้า: ${rep.brandTh || rep.brandEn || ""} ${rep.nameTh.slice(0, 48)} (${sorted.length} ขนาด/แพ็ก)`.trim();
    const bodyLines = [
      `# ${title}`,
      "",
      "ตารางเปรียบเทียบขนาดบรรจุ หน่วยนับ และความคุ้มค่าของสินค้าตระกูลเดียวกัน:",
      "",
      "| สินค้า | หน่วยขาย | บรรจุ | ราคาขาย | เฉลี่ยต่อหน่วยย่อย | บาร์โค้ด |",
      "|---|---|---|---|---|---|",
      ...sorted.map(
        (p) =>
          `| [[pack_variant::${p.slug}|${p.nameTh}]] | ${p.unitCode} | ${p.packQty} ${p.baseUnitCode} | **${formatThaiBaht(p.bestPrice)}** | ${formatThaiBaht(p.pricePerBaseUnit)} / ${p.baseUnitCode} | \`${p.primaryBarcode ?? "-"}\` |`,
      ),
    ];
    const body = bodyLines.join("\n");
    const note: Note = {
      slug: fSlug,
      folder: "family",
      audience: "user",
      title,
      subtitle: `${sorted.length} ขนาดบรรจุ`,
      imageUrl: rep.imageUrl,
      tags: ["ตระกูลสินค้า", "เทียบขนาดแพ็ก", ...(rep.brandTh ? [rep.brandTh] : [])],
      aliases: [fg.code, rep.nameTh],
      sources: [],
      body,
      links: [],
      backlinks: [],
      outEdges: [],
      inEdges: [],
      haystack: {
        title: normalizeText(title),
        meta: normalizeText(`ตระกูลสินค้า ยกแพ็ก ยกลัง เทียบราคา ${fg.code}`),
        body: normalizeText(sorted.map((p) => `${p.nameTh} ${p.unitCode}`).join(" ")),
      },
    };
    for (const p of sorted) {
      productFamilyMap.set(p.slug, fSlug);
      addEdgeUnique(note, p.slug, "pack_variant");
    }
    if (rep.categorySlugs[rep.categorySlugs.length - 1]) {
      addEdgeUnique(note, rep.categorySlugs[rep.categorySlugs.length - 1], "in_category");
    }
    notes.set(fSlug, note);
  }

  // 7) Create Source Notes
  for (const sb of sourceBuckets.values()) {
    const sSlug = toCleanSlug("src", sb.id);
    const body = [
      `# แหล่งข้อมูลสินค้า: ${sb.label}`,
      "",
      `- **รหัสแหล่งที่มา**: \`${sb.id}\``,
      `- **จำนวนสินค้าที่ตรวจพบ**: ${sb.products.length.toLocaleString("th-TH")} รายการ`,
      "",
      "## ตัวอย่างสินค้าจากแหล่งนี้",
      ...sb.products.slice(0, 30).map((p) => `- [[sold_at::${p.slug}|${p.nameTh}]] — ${formatThaiBaht(p.bestPrice)} / ${p.unitCode}`),
    ].join("\n");
    const note: Note = {
      slug: sSlug,
      folder: "source",
      audience: "user",
      title: `ร้านค้า: ${sb.label}`,
      subtitle: `${sb.products.length.toLocaleString("th-TH")} สินค้า`,
      tags: ["แหล่งร้านค้า", sb.id, sb.label],
      aliases: [sb.id, sb.label],
      sources: [],
      body,
      links: [],
      backlinks: [],
      outEdges: [],
      inEdges: [],
      haystack: {
        title: normalizeText(`ร้านค้า แหล่งที่มา ${sb.label} ${sb.id}`),
        meta: normalizeText(`ร้านค้า ตลาดไทย ${sb.label}`),
        body: normalizeText(sb.label),
      },
    };
    addEdgeUnique(note, "index", "hub_map");
    notes.set(sSlug, note);
  }

  // 8) Create Product Notes & Rich Synapses
  for (const p of snap.products) {
    const famSlug = productFamilyMap.get(p.slug) ?? null;
    const priceLabel = formatThaiBaht(p.bestPrice);
    const unitLabel = p.packQty > 1 ? `${p.unitCode} (${p.packQty} ${p.baseUnitCode})` : p.unitCode;
    const body = buildProductMarkdown(p, famSlug);

    const traitText = p.traits.map((t) => `${t.groupLabelTh} ${t.valueTh}`).join(" ");
    const specText = p.specs.map((s) => `${s.label} ${s.value}`).join(" ");
    const unitConvText = p.unitConversions.map((u) => `${u.unitNameTh} ${u.unitSysCode} ${u.ratioText}`).join(" ");

    const note: Note = {
      slug: p.slug,
      folder: "product",
      audience: "user",
      title: p.nameTh,
      subtitle: `${priceLabel} / ${unitLabel}`,
      priceLabel,
      unitLabel,
      barcode: p.primaryBarcode,
      imageUrl: p.imageUrl,
      tags: [
        p.unitCode,
        ...(p.brandTh ? [p.brandTh] : []),
        ...(p.categoryLevelsTh[0] ? [p.categoryLevelsTh[0]] : []),
        ...p.traits.slice(0, 3).map((t) => t.valueTh),
      ],
      aliases: [p.productCode, p.nameEn, ...p.barcodes].filter(Boolean),
      sources: p.sources.map((s) => s.url).filter(Boolean),
      body,
      links: [],
      backlinks: [],
      outEdges: [],
      inEdges: [],
      media: {
        images: [
          ...(p.imageUrl ? [{ alt: p.nameTh, url: p.imageUrl }] : []),
          ...p.extraImages.map((u) => ({ alt: p.nameTh, url: u })),
        ],
        videos: [],
        webPages: p.sources.filter((s) => s.url).map((s) => ({ title: `${p.nameTh} (${s.label})`, url: s.url })),
      },
      haystack: {
        title: normalizeText(`${p.nameTh} ${p.nameEn} ${p.productCode} ${p.barcodes.join(" ")}`),
        meta: normalizeText(
          `${p.brandTh} ${p.brandEn} ${p.categoryPathTh} ${p.unitCode} ${p.unitSysCode} ${unitConvText} ${traitText}`,
        ),
        body: normalizeText(
          `${specText} ${p.features} ${p.ingredients} ${p.description} ${p.storage} ${p.fdaNumber} ${p.originCountry}`,
        ),
      },
    };

    // Connect product -> leaf category
    const leafCat = p.categorySlugs[p.categorySlugs.length - 1];
    if (leafCat && notes.has(leafCat)) addEdgeUnique(note, leafCat, "in_category");

    // Connect product -> brand
    if (p.brandSlug && notes.has(p.brandSlug)) addEdgeUnique(note, p.brandSlug, "has_brand");

    // Connect product -> main unit & converted units
    const mainUSlug =
      unitSlugByCode.get(p.unitCode.toLowerCase()) ??
      (p.unitSysCode ? unitSlugByCode.get(p.unitSysCode.toLowerCase()) : undefined);
    if (mainUSlug && notes.has(mainUSlug)) addEdgeUnique(note, mainUSlug, "uses_unit");

    for (const uc of p.unitConversions) {
      const cuSlug =
        unitSlugByCode.get(uc.unitCode.toLowerCase()) ??
        (uc.unitSysCode ? unitSlugByCode.get(uc.unitSysCode.toLowerCase()) : undefined);
      if (cuSlug && cuSlug !== mainUSlug && notes.has(cuSlug)) {
        addEdgeUnique(note, cuSlug, "converts_unit");
      }
      if (uc.linkedProductCode) {
        const sib = productByCode.get(uc.linkedProductCode.toLowerCase());
        if (sib && sib.slug !== p.slug) addEdgeUnique(note, sib.slug, "pack_variant");
      }
    }

    // Connect product -> traits
    for (const tr of p.traits) {
      if (notes.has(tr.slug)) addEdgeUnique(note, tr.slug, "has_trait");
    }

    // Connect product -> family & explicit relatedProducts
    if (famSlug && notes.has(famSlug)) addEdgeUnique(note, famSlug, "in_family");
    for (const rp of p.relatedProducts) {
      const sib =
        (rp.productCode ? productByCode.get(rp.productCode.toLowerCase()) : undefined) ??
        (rp.primaryBarcode ? productByBarcode.get(rp.primaryBarcode) : undefined);
      if (sib && sib.slug !== p.slug) addEdgeUnique(note, sib.slug, "pack_variant");
    }

    // Connect product -> sources
    for (const s of p.sources) {
      const sSlug = toCleanSlug("src", s.source);
      if (notes.has(sSlug)) addEdgeUnique(note, sSlug, "sold_at");
    }

    notes.set(p.slug, note);
  }

  // Resolve static markdown wikilinks
  for (const [slug, linksList] of rawMdLinks) {
    const n = notes.get(slug);
    if (!n) continue;
    for (const item of linksList) {
      const target = notes.get(item.target);
      if (!target || target.slug === slug) continue;
      addEdgeUnique(n, target.slug, item.explicitRel ?? inferRelation(n.folder, target.folder));
    }
  }

  // Populate reverse edges / backlinks across the entire brain
  let totalSynapses = 0;
  for (const n of notes.values()) {
    for (const e of n.outEdges) {
      const target = notes.get(e.slug);
      if (!target) continue;
      totalSynapses++;
      target.backlinks.push(n.slug);
      target.inEdges.push({ slug: n.slug, rel: e.rel, inferred: e.inferred });
    }
  }

  // Build fast inverted index over productsList for instant faceted product search
  const productsList = snap.products;
  const tempProdPostings = new Map<string, number[]>();
  for (let i = 0; i < productsList.length; i++) {
    const p = productsList[i];
    const pNote = notes.get(p.slug)!;
    const tokSet = new Set<string>([
      ...tokenizeBodyFast(pNote.haystack.title),
      ...tokenizeBodyFast(pNote.haystack.meta),
      ...tokenizeBodyFast(pNote.haystack.body),
    ]);
    for (const bc of p.barcodes) tokSet.add(bc.toLowerCase());
    tokSet.add(p.productCode.toLowerCase());
    for (const tok of tokSet) {
      let arr = tempProdPostings.get(tok);
      if (!arr) {
        arr = [];
        tempProdPostings.set(tok, arr);
      }
      arr.push(i);
    }
  }
  const productPostings = new Map<string, Int32Array>();
  for (const [tok, arr] of tempProdPostings) {
    productPostings.set(tok, Int32Array.from(arr));
  }

  const stats: BrainStats = {
    totalNotes: notes.size,
    totalSynapses,
    totalProducts: productsList.length,
    totalCategories: categoriesMap.size,
    totalBrands: brandBuckets.size,
    totalUnits: [...notes.values()].filter((n) => n.folder === "unit").length,
    totalTraits: traitBuckets.size,
    totalFamilies: [...notes.values()].filter((n) => n.folder === "family").length,
    totalSources: sourceBuckets.size,
    syncedAt: snap.syncedAt,
  };

  return {
    builtAt: Date.now(),
    syncedAt: snap.syncedAt,
    notes,
    productsBySlug,
    productByBarcode,
    productByCode,
    productsList,
    unitsList: snap.units,
    categoriesMap,
    categoryDescendantSlugs,
    productFamilyMap,
    stats,
    graphs: new Map(),
    rendered: new Map(),
    rows: new Map(),
    folders: new Map(),
    grouped: new Map(),
    searches: new Map(),
    indexes: new Map(),
    productPostings,
  };
}

function getBundle(): VaultBundle {
  if (!bundleCache) {
    bundleCache = buildBundleFromSnapshot(ensureSnapshotSync());
  }
  return bundleCache;
}

export async function refreshBrainFromDatabase(): Promise<BrainStats> {
  const snap = await syncBrainSnapshotFromDb();
  bundleCache = buildBundleFromSnapshot(snap);
  return bundleCache.stats;
}

export function brainStats(): BrainStats {
  return getBundle().stats;
}

export function vault(): Map<string, Note> {
  return getBundle().notes;
}

const toSlug = (raw: string) =>
  linkTarget(raw.replace(/^\s*\[\[|\]\]\s*$/g, "").replace(/^[a-z_]+::/, "").split(/[|#]/)[0]).replace(/\.md$/, "");

export function getNote(slugOrCode: string): Note | undefined {
  const b = getBundle();
  const clean = toSlug(slugOrCode);
  const direct = b.notes.get(clean);
  if (direct) return direct;
  const byBc = b.productByBarcode.get(clean);
  if (byBc) return b.notes.get(byBc.slug);
  const byCode = b.productByCode.get(clean);
  if (byCode) return b.notes.get(byCode.slug);
  return b.notes.get(`prod-${clean}`);
}

export function getProductBySlug(slugOrCode: string): BrainProductItem | undefined {
  const b = getBundle();
  const clean = toSlug(slugOrCode);
  return (
    b.productsBySlug.get(clean) ??
    b.productByBarcode.get(clean) ??
    b.productByCode.get(clean) ??
    b.productsBySlug.get(`prod-${clean}`)
  );
}

// Fast O(N + E) 3D Brain Lobe Layout (handles thousands of neurons in ~20ms without O(N^2) lag)
function computeBrainLayoutFast(
  nodes: { folder: string; degree: number }[],
  links: [number, number][],
): [number, number, number][] {
  const n = nodes.length;
  if (!n) return [];
  const Rx = 6.4;
  const Ry = 4.9;
  const Rz = 7.6;
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const folders = [...new Set(nodes.map((x) => x.folder))].filter((f) => f !== "root").sort();
  const centers = new Map<string, [number, number, number]>([["root", [0, 0.4, 0]]]);
  folders.forEach((f, i) => {
    const y = 1 - (2 * (i + 0.5)) / Math.max(1, folders.length);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * 2.399963 + 0.5;
    centers.set(f, [Math.cos(phi) * r * Rx * 0.58, y * Ry * 0.48, Math.sin(phi) * r * Rz * 0.58]);
  });

  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const cz = new Float64Array(n);

  // Place nodes in golden-angle shells around their lobe center so they never clump
  const lobeCounters = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const f = nodes[i].folder;
    const k = lobeCounters.get(f) ?? 0;
    lobeCounters.set(f, k + 1);
    const c = centers.get(f) ?? [0, 0, 0];
    cx[i] = c[0];
    cy[i] = c[1];
    cz[i] = c[2];
    const radius = f === "root" ? 0.6 : Math.min(3.4, 0.45 + Math.cbrt(k + 1) * 0.36);
    const theta = k * 2.399963;
    const u = ((k * 0.6180339887) % 1) * 2 - 1;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    px[i] = c[0] + Math.cos(theta) * s * radius + (rand() - 0.5) * 0.35;
    py[i] = c[1] + u * radius * 0.85 + (rand() - 0.5) * 0.35;
    pz[i] = c[2] + Math.sin(theta) * s * radius + (rand() - 0.5) * 0.35;
  }

  const invRx2 = 1 / (Rx * Rx);
  const invRy2 = 1 / (Ry * Ry);
  const invRz2 = 1 / (Rz * Rz);

  // 45 spring-relaxation iterations along synapses + skull boundary containment: O(N + E)
  for (let it = 0; it < 45; it++) {
    const alpha = (1 - it / 45) * 0.045;
    for (let li = 0; li < links.length; li++) {
      const a = links[li][0];
      const b = links[li][1];
      const dx = px[b] - px[a];
      const dy = py[b] - py[a];
      const dz = pz[b] - pz[a];
      const dist = Math.hypot(dx, dy, dz) || 0.01;
      const force = ((dist - 2.1) * alpha) / dist;
      px[a] += dx * force;
      py[a] += dy * force;
      pz[a] += dz * force;
      px[b] -= dx * force;
      py[b] -= dy * force;
      pz[b] -= dz * force;
    }
    for (let i = 0; i < n; i++) {
      px[i] += (cx[i] - px[i]) * 0.03;
      py[i] += (cy[i] - py[i]) * 0.03;
      pz[i] += (cz[i] - pz[i]) * 0.03;
      const k = px[i] * px[i] * invRx2 + py[i] * py[i] * invRy2 + pz[i] * pz[i] * invRz2;
      if (k > 0.82) {
        const s = Math.sqrt(0.82 / k);
        px[i] *= s;
        py[i] *= s;
        pz[i] *= s;
      }
    }
  }

  const out: [number, number, number][] = new Array(n);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  for (let i = 0; i < n; i++) out[i] = [r3(px[i]), r3(py[i]), r3(pz[i])];
  return out;
}

// Curated high-signal 3D graph (keeps mobile payload light ~250KB & 60FPS while representing every lobe & top products)
export function graph(filter: AudienceFilter = "all"): GraphData {
  const b = getBundle();
  const cached = b.graphs.get(filter);
  if (cached) return cached;

  const allNotes = [...b.notes.values()].filter((n) => matchesAudience(n.audience, filter));
  const selectedNotes: Note[] = [];
  const chosenSlugs = new Set<string>();

  const pickNote = (n: Note) => {
    if (chosenSlugs.has(n.slug)) return;
    chosenSlugs.add(n.slug);
    selectedNotes.push(n);
  };

  // Always include root, sources, units, schema, top categories, top traits, top families, top brands, and representative products across all categories
  for (const n of allNotes) {
    if (n.folder === "root" || n.folder === "source" || n.folder === "schema" || n.folder === "unit") {
      pickNote(n);
    }
  }

  const byDegreeDesc = (folder: string, cap: number) =>
    allNotes
      .filter((n) => n.folder === folder)
      .sort((a, c) => c.links.length + c.backlinks.length - (a.links.length + a.backlinks.length))
      .slice(0, cap);

  for (const n of byDegreeDesc("category", 180)) pickNote(n);
  for (const n of byDegreeDesc("trait", 140)) pickNote(n);
  for (const n of byDegreeDesc("family", 150)) pickNote(n);
  for (const n of byDegreeDesc("brand", 200)) pickNote(n);

  // Pick representative products evenly across top-level categories + multi-unit rich products (~950 products -> ~1,750 total 3D neurons)
  const prodNotes = allNotes
    .filter((n) => n.folder === "product")
    .sort((a, c) => c.outEdges.length - a.outEdges.length);
  const perCatCount = new Map<string, number>();
  for (const pn of prodNotes) {
    if (selectedNotes.length >= 1750) break;
    const p = b.productsBySlug.get(pn.slug);
    const catKey = p?.categorySlugs[0] ?? "misc";
    const cCount = perCatCount.get(catKey) ?? 0;
    if (cCount < 45) {
      perCatCount.set(catKey, cCount + 1);
      pickNote(pn);
    }
  }

  const index = new Map(selectedNotes.map((n, i) => [n.slug, i]));
  const seen = new Map<string, number>();
  const links: [number, number][] = [];
  const rels: RelationType[] = [];
  const degree = new Int32Array(selectedNotes.length);

  selectedNotes.forEach((n, i) => {
    for (const e of n.outEdges) {
      const j = index.get(e.slug);
      if (j === undefined) continue;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.set(key, links.length);
      links.push([i, j]);
      rels.push(e.rel);
      degree[i]++;
      degree[j]++;
    }
  });

  const nodesMeta = selectedNotes.map((n, i) => ({ folder: n.folder, degree: degree[i] }));
  const positions = computeBrainLayoutFast(nodesMeta, links);

  const built: GraphData = {
    nodes: selectedNotes.map((n, i) => ({
      slug: n.slug,
      title: n.title,
      folder: n.folder,
      audience: n.audience,
      degree: degree[i],
      keywords: normalizeText([n.barcode ?? "", ...n.tags.slice(0, 4), ...n.aliases.slice(0, 3)].join(" ")).slice(0, 120),
      priceLabel: n.priceLabel,
      unitLabel: n.unitLabel,
      barcode: n.barcode,
      imageUrl: n.imageUrl,
      pos: positions[i],
    })),
    links,
    rels,
    stats: b.stats,
  };

  b.graphs.set(filter, built);
  return built;
}

export function listVaultRows(filter: AudienceFilter = "all"): VaultRow[] {
  const b = getBundle();
  const cached = b.rows.get(filter);
  if (cached) return cached;
  const rows = [...b.notes.values()]
    .filter((n) => matchesAudience(n.audience, filter))
    .map((n) => ({
      slug: n.slug,
      title: n.title,
      folder: n.folder,
      audience: n.audience,
      tags: n.tags,
      priceLabel: n.priceLabel,
      unitLabel: n.unitLabel,
      imageUrl: n.imageUrl,
    }));
  b.rows.set(filter, rows);
  return rows;
}

export function vaultFolders(filter: AudienceFilter = "all"): string[] {
  const b = getBundle();
  const cached = b.folders.get(filter);
  if (cached) return cached;
  const folders = [...new Set(listVaultRows(filter).map((n) => n.folder))].sort();
  b.folders.set(filter, folders);
  return folders;
}

export function groupedVaultNotes(filter: AudienceFilter = "all", perGroupLimit = 120): [string, { total: number; notes: Note[] }][] {
  const b = getBundle();
  const byFolder = new Map<string, Note[]>();
  for (const n of b.notes.values()) {
    if (!matchesAudience(n.audience, filter)) continue;
    let list = byFolder.get(n.folder);
    if (!list) {
      list = [];
      byFolder.set(n.folder, list);
    }
    list.push(n);
  }
  const ordered = [...byFolder.entries()]
    .sort(([a], [c]) => {
      const ia = GROUP_ORDER.indexOf(a);
      const ic = GROUP_ORDER.indexOf(c);
      return (ia === -1 ? 999 : ia) - (ic === -1 ? 999 : ic);
    })
    .map(([folder, list]): [string, { total: number; notes: Note[] }] => {
      const sorted = [...list].sort(
        (a, c) => c.links.length + c.backlinks.length - (a.links.length + a.backlinks.length) || a.title.localeCompare(c.title, "th"),
      );
      return [folder, { total: list.length, notes: sorted.slice(0, perGroupLimit) }];
    });
  return ordered;
}

// ---------- Full-Vault BM25 + Synonym + 1-Hop Graph Boost Search ----------
const k1 = 1.2;
const bm25b = 0.75;

function getSearchIndex(b: VaultBundle, filter: AudienceFilter): SearchIndex {
  const existing = b.indexes.get(filter);
  if (existing) return existing;

  const notes = [...b.notes.values()].filter((n) => matchesAudience(n.audience, filter));
  const N = notes.length;
  const slugToIdx = new Map(notes.map((n, i) => [n.slug, i]));
  const bodies = notes.map((n) => n.haystack.body);
  const titles = notes.map((n) => n.haystack.title);
  const metas = notes.map((n) => n.haystack.meta);
  const avgLen = Math.max(1, bodies.reduce((s, x) => s + x.length, 0) / Math.max(1, N));

  const tempPostings = new Map<string, { idx: number[]; raw: number[] }>();
  for (let i = 0; i < N; i++) {
    const titleToks = new Set(tokenizeBodyFast(titles[i]));
    const metaToks = new Set(tokenizeBodyFast(metas[i]));
    const bodyFreq = new Map<string, number>();
    for (const w of tokenizeBodyFast(bodies[i])) {
      const prev = bodyFreq.get(w) ?? 0;
      if (prev < 12) bodyFreq.set(w, prev + 1);
    }
    const norm = k1 * (1 - bm25b + (bm25b * bodies[i].length) / avgLen);
    const allToks = new Set<string>([...titleToks, ...metaToks, ...bodyFreq.keys()]);
    for (const t of allToks) {
      const tf = bodyFreq.get(t) ?? 0;
      const bodyBm25 = tf ? ((tf * (k1 + 1)) / (tf + norm)) * 2.4 : 0;
      const raw = (titleToks.has(t) ? 11 : 0) + (metaToks.has(t) ? 6.5 : 0) + bodyBm25;
      if (!raw) continue;
      let bucket = tempPostings.get(t);
      if (!bucket) {
        bucket = { idx: [], raw: [] };
        tempPostings.set(t, bucket);
      }
      bucket.idx.push(i);
      bucket.raw.push(raw);
    }
  }

  const postings = new Map<string, Posting>();
  for (const [t, bucket] of tempPostings) {
    postings.set(t, {
      idx: Int32Array.from(bucket.idx),
      raw: Float32Array.from(bucket.raw),
      idf: Math.log(1 + N / (1 + bucket.idx.length)),
    });
  }

  const neighborIdx: Int32Array[] = [];
  const neighborWeights: Float32Array[] = [];
  for (let i = 0; i < N; i++) {
    const n = notes[i];
    const wMap = new Map<number, number>();
    for (const e of n.outEdges) {
      if (e.slug === "index") continue;
      const j = slugToIdx.get(e.slug);
      if (j !== undefined && j !== i) wMap.set(j, 1.1);
    }
    for (const e of n.inEdges.slice(0, 32)) {
      if (e.slug === "index") continue;
      const j = slugToIdx.get(e.slug);
      if (j !== undefined && j !== i && !wMap.has(j)) wMap.set(j, 0.9);
    }
    neighborIdx.push(Int32Array.from(wMap.keys()));
    neighborWeights.push(Float32Array.from(wMap.values()));
  }

  const built: SearchIndex = {
    notes,
    slugToIdx,
    avgLen,
    postings,
    bodies,
    titles,
    metas,
    neighborIdx,
    neighborWeights,
    baseBuf: new Float64Array(N),
    matchBuf: new Int32Array(N),
  };
  b.indexes.set(filter, built);
  return built;
}

export function noteDescription(n: Note): string {
  if (n.subtitle) return `${n.title} — ${n.subtitle}`;
  const clean = n.body
    .split("\n")
    .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("![") && !l.startsWith("|"))
    ?.replace(/[*_`[\]]/g, "")
    .trim();
  return (clean || n.title).slice(0, 160);
}

export function search(q: string, limit = 10, filter: AudienceFilter = "all"): SearchHit[] {
  const b = getBundle();
  const trimmed = q.trim();
  if (!trimmed) return [];

  const cacheKey = `${filter}\0${limit}\0${trimmed}`;
  const cached = b.searches.get(cacheKey);
  if (cached) return cached;

  // Instant exact barcode / productCode hit boost
  const exactProd = b.productByBarcode.get(trimmed) ?? b.productByCode.get(trimmed.toLowerCase());
  const ts = terms(trimmed);
  if (!ts.length && !exactProd) return [];

  const idx = getSearchIndex(b, filter);
  const N = idx.notes.length;
  if (!N) return [];

  const synTerms = expandSynonyms(ts);
  const base = idx.baseBuf;
  const matched = idx.matchBuf;
  base.fill(0);
  matched.fill(0);

  for (let ti = 0; ti < ts.length; ti++) {
    const p = idx.postings.get(ts[ti]);
    if (!p) continue;
    for (let k = 0; k < p.idx.length; k++) {
      const docId = p.idx[k];
      base[docId] += p.raw[k] * p.idf;
      matched[docId]++;
    }
  }

  for (let si = 0; si < synTerms.length; si++) {
    const sp = idx.postings.get(synTerms[si]);
    if (!sp) continue;
    const w = sp.idf * 0.35;
    for (let k = 0; k < sp.idx.length; k++) {
      base[sp.idx[k]] += sp.raw[k] * w;
    }
  }

  if (exactProd) {
    const exactId = idx.slugToIdx.get(exactProd.slug);
    if (exactId !== undefined) base[exactId] += 250;
  }

  const phrase = normalizeText(trimmed);
  const ranked: { idx: number; score: number }[] = [];
  for (let i = 0; i < N; i++) {
    let sc = base[i];
    if (sc <= 0 && phrase.length >= 3 && idx.titles[i].includes(phrase)) {
      sc = 45;
    }
    if (sc <= 0) continue;
    if (ts.length > 1 && matched[i] === ts.length) sc *= 1.45;
    if (phrase.length >= 3 && idx.titles[i].includes(phrase)) sc += 25;

    // 1-hop synapse boost
    const nbs = idx.neighborIdx[i];
    const nbW = idx.neighborWeights[i];
    let topNb = 0;
    for (let ni = 0; ni < nbs.length; ni++) {
      const nbSc = base[nbs[ni]] * nbW[ni];
      if (nbSc > topNb) topNb = nbSc;
    }
    ranked.push({ idx: i, score: sc + topNb * 0.08 });
  }

  ranked.sort((a, c) => c.score - a.score);
  const hits: SearchHit[] = ranked.slice(0, limit).map(({ idx: docId, score }) => {
    const note = idx.notes[docId];
    return {
      slug: note.slug,
      title: note.title,
      folder: note.folder,
      audience: note.audience,
      tags: note.tags,
      score: Math.round(score),
      snippet: note.subtitle ? `${note.subtitle} · ${note.tags.join(", ")}` : noteDescription(note),
      priceLabel: note.priceLabel,
      unitLabel: note.unitLabel,
      barcode: note.barcode,
      imageUrl: note.imageUrl,
      images: note.media?.images.slice(0, 2),
    };
  });

  if (b.searches.size >= 256) {
    const oldest = b.searches.keys().next().value;
    if (oldest !== undefined) b.searches.delete(oldest);
  }
  b.searches.set(cacheKey, hits);
  return hits;
}

// ---------- Detailed Faceted Product Search Engine ----------
export function searchProductsDetailed(params: ProductSearchQuery): ProductSearchResult {
  const b = getBundle();
  const q = (params.q ?? "").trim();
  const category = params.category?.trim() || "";
  const brand = params.brand?.trim() || "";
  const unit = params.unit?.trim().toLowerCase() || "";
  const traitFilter = (params.traits ?? []).map((t) => t.trim()).filter(Boolean);
  const source = params.source?.trim() || "";
  const minPrice = params.minPrice?.trim() || null;
  const maxPrice = params.maxPrice?.trim() || null;
  const multiUnitOnly = Boolean(params.multiUnitOnly);
  const thaiGs1Only = Boolean(params.thaiGs1Only);
  const sort = params.sort ?? "relevance";
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(60, Math.max(6, Math.floor(params.pageSize ?? 24)));

  const qTerms = q ? terms(q) : [];
  const synTerms = qTerms.length ? expandSynonyms(qTerms) : [];
  const normPhrase = normalizeText(q);

  // Score candidate products if query `q` is provided
  let scores: Float64Array | null = null;
  let strictMatch: Uint8Array | null = null;
  let strictCount = 0;
  if (q) {
    scores = new Float64Array(b.productsList.length);
    const matchedCount = new Int32Array(b.productsList.length);

    const exact = b.productByBarcode.get(q) ?? b.productByCode.get(q.toLowerCase());
    if (exact) {
      const eIdx = b.productsList.indexOf(exact);
      if (eIdx >= 0) scores[eIdx] += 500;
    }

    for (const t of qTerms) {
      const post = b.productPostings.get(t);
      if (post) {
        const idf = Math.log(1 + b.productsList.length / (1 + post.length));
        for (let k = 0; k < post.length; k++) {
          scores[post[k]] += 12 * idf;
          matchedCount[post[k]]++;
        }
      }
    }
    // Synonyms only widen recall: count the single best synonym hit, never a sum that could outrank a real term match
    const synBest = new Float64Array(b.productsList.length);
    for (const st of synTerms) {
      const post = b.productPostings.get(st);
      if (post) {
        const synScore = 4.5 * Math.log(1 + b.productsList.length / (1 + post.length));
        for (let k = 0; k < post.length; k++) {
          if (synScore > synBest[post[k]]) synBest[post[k]] = synScore;
        }
      }
    }
    strictMatch = new Uint8Array(b.productsList.length);

    // Substring fallback on normalized title/brand/barcode so partial Thai/code queries always find matches
    for (let i = 0; i < b.productsList.length; i++) {
      const p = b.productsList[i];
      scores[i] += synBest[i];
      const allTerms = qTerms.length > 0 && matchedCount[i] === qTerms.length;
      if (qTerms.length > 1 && allTerms) {
        scores[i] *= 1.6;
      }
      let phraseHit = false;
      if (normPhrase.length >= 2) {
        const hayTitle = normalizeText(`${p.nameTh} ${p.nameEn} ${p.brandTh} ${p.brandEn} ${p.productCode}`);
        // A term that is in the product name itself says far more than one buried in the description
        for (const t of qTerms) if (hayTitle.includes(t)) scores[i] += 18;
        if (hayTitle.includes(normPhrase)) {
          scores[i] += 35;
          phraseHit = true;
        } else if (p.barcodes.some((bc) => bc.includes(q))) {
          scores[i] += 80;
          phraseHit = true;
        }
      }
      if (allTerms || phraseHit || p === exact) {
        strictMatch[i] = 1;
        strictCount++;
      }
    }
  }

  const allowedCatSet = category ? (b.categoryDescendantSlugs.get(category) ?? new Set([category])) : null;

  // Filter and simultaneously aggregate dynamic facet counts
  const catCounts = new Map<string, number>();
  const brandCounts = new Map<string, { label: string; count: number }>();
  const unitCounts = new Map<string, { label: string; count: number }>();
  const traitCounts = new Map<string, { label: string; group: string; count: number }>();
  const srcCounts = new Map<string, { label: string; count: number }>();

  const matchedIndices: number[] = [];
  // Sorting by price/pack throws relevance away, so loose (synonym / partial) matches must not reach the top
  const strictOnly = sort !== "relevance" && strictCount > 0 ? strictMatch : null;

  for (let i = 0; i < b.productsList.length; i++) {
    if (scores && scores[i] <= 0) continue;
    if (strictOnly && !strictOnly[i]) continue;
    const p = b.productsList[i];

    if (multiUnitOnly && p.unitConversions.length <= 1 && p.packQty <= 1) continue;
    if (thaiGs1Only && !p.isThaiGs1) continue;
    if (!moneyInRange(p.bestPrice, minPrice, maxPrice)) continue;

    const passCat = !allowedCatSet || p.categorySlugs.some((cs) => allowedCatSet.has(cs));
    const passBrand = !brand || p.brandSlug === brand;
    const passUnit =
      !unit ||
      p.unitCode.toLowerCase() === unit ||
      p.unitSysCode.toLowerCase() === unit ||
      p.unitConversions.some((uc) => uc.unitCode.toLowerCase() === unit || uc.unitSysCode.toLowerCase() === unit);
    const passTraits =
      traitFilter.length === 0 || traitFilter.every((tf) => p.traits.some((pt) => pt.slug === tf));
    const passSource = !source || p.sources.some((s) => s.source === source);

    // Count facets with contextual cross-filtering
    if (passBrand && passUnit && passTraits && passSource) {
      for (const cs of p.categorySlugs) catCounts.set(cs, (catCounts.get(cs) ?? 0) + 1);
    }
    if (passCat && passUnit && passTraits && passSource && p.brandSlug) {
      const label = p.brandTh || p.brandEn;
      const cur = brandCounts.get(p.brandSlug);
      brandCounts.set(p.brandSlug, { label, count: (cur?.count ?? 0) + 1 });
    }
    if (passCat && passBrand && passTraits && passSource) {
      const uSet = new Set<string>([p.unitCode, ...p.unitConversions.map((u) => u.unitCode)]);
      for (const uc of uSet) {
        const key = uc.toLowerCase();
        const cur = unitCounts.get(key);
        unitCounts.set(key, { label: uc, count: (cur?.count ?? 0) + 1 });
      }
    }
    if (passCat && passBrand && passUnit && passSource) {
      for (const tr of p.traits) {
        const cur = traitCounts.get(tr.slug);
        traitCounts.set(tr.slug, { label: tr.valueTh, group: tr.groupLabelTh, count: (cur?.count ?? 0) + 1 });
      }
    }
    if (passCat && passBrand && passUnit && passTraits) {
      const seenS = new Set<string>();
      for (const s of p.sources) {
        if (seenS.has(s.source)) continue;
        seenS.add(s.source);
        const cur = srcCounts.get(s.source);
        srcCounts.set(s.source, { label: s.label, count: (cur?.count ?? 0) + 1 });
      }
    }

    if (passCat && passBrand && passUnit && passTraits && passSource) {
      matchedIndices.push(i);
    }
  }

  // Sort matched products
  matchedIndices.sort((ia, ib) => {
    const pa = b.productsList[ia];
    const pb = b.productsList[ib];
    if (sort === "price_asc") return compareMoney(pa.bestPrice, pb.bestPrice);
    if (sort === "price_desc") return compareMoney(pb.bestPrice, pa.bestPrice);
    if (sort === "unit_price_asc") return compareMoney(pa.pricePerBaseUnit, pb.pricePerBaseUnit);
    if (sort === "pack_desc") return pb.packQty - pa.packQty || pb.unitConversions.length - pa.unitConversions.length;
    if (scores) return scores[ib] - scores[ia] || pb.confidenceScore - pa.confidenceScore;
    return pb.unitConversions.length - pa.unitConversions.length || compareMoney(pa.bestPrice, pb.bestPrice);
  });

  const total = matchedIndices.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const items = matchedIndices.slice(start, start + pageSize).map((idx) => b.productsList[idx]);

  // Build hierarchical Category Tree (depths 1..3 for clean UI navigation)
  function buildCatTree(parentSlug: string | null, depth: number): CategoryFacetNode[] {
    if (depth > 3) return [];
    const list: CategoryFacetNode[] = [];
    for (const c of b.categoriesMap.values()) {
      if (c.parentSlug !== parentSlug) continue;
      const cnt = catCounts.get(c.slug) ?? 0;
      if (cnt <= 0 && c.slug !== category) continue;
      list.push({
        slug: c.slug,
        label: c.label,
        pathLabel: c.pathLabel,
        depth: c.depth,
        parentSlug: c.parentSlug,
        count: cnt,
        children: buildCatTree(c.slug, depth + 1),
      });
    }
    return list.sort((x, y) => y.count - x.count || x.label.localeCompare(y.label, "th"));
  }

  return {
    total,
    page: safePage,
    pageSize,
    totalPages,
    appliedTerms: qTerms,
    items,
    facets: {
      categories: buildCatTree(null, 1).slice(0, 30),
      brands: [...brandCounts.entries()]
        .map(([slug, v]) => ({ slug, label: v.label, count: v.count }))
        .sort((x, y) => y.count - x.count)
        .slice(0, 45),
      units: [...unitCounts.entries()]
        .map(([slug, v]) => ({ slug, label: v.label, count: v.count }))
        .sort((x, y) => y.count - x.count)
        .slice(0, 35),
      traits: [...traitCounts.entries()]
        .map(([slug, v]) => ({ slug, label: v.label, group: v.group, count: v.count }))
        .sort((x, y) => y.count - x.count)
        .slice(0, 45),
      sources: [...srcCounts.entries()]
        .map(([slug, v]) => ({ slug, label: v.label, count: v.count }))
        .sort((x, y) => y.count - x.count),
    },
  };
}

// ---------- Graph Traversal & Neighborhood Context ----------
const edgeListFor = (n: Note, dir: "both" | "out" | "in") => {
  const out = dir !== "in" ? n.outEdges.map((e) => ({ slug: e.slug, rel: e.rel, direction: "out" as const })) : [];
  const inn = dir !== "out" ? n.inEdges.map((e) => ({ slug: e.slug, rel: e.rel, direction: "in" as const })) : [];
  return [...out, ...inn];
};

function bfsPath(
  all: Map<string, Note>,
  startSlug: string,
  targetSlug: string,
  dir: "both" | "out" | "in",
  filter: AudienceFilter,
  relation: RelationType | undefined,
): TraverseStep[] | null {
  if (startSlug === targetSlug) return [];
  const visited = new Set<string>([startSlug]);
  const parent = new Map<string, { prev: string; step: TraverseStep }>();
  const queue: { slug: string; hop: number }[] = [{ slug: startSlug, hop: 0 }];

  for (let qi = 0; qi < queue.length; qi++) {
    const { slug, hop } = queue[qi];
    if (hop >= 5) continue;
    const node = all.get(slug);
    if (!node) continue;
    for (const e of edgeListFor(node, dir)) {
      if (relation && e.rel !== relation) continue;
      if (visited.has(e.slug)) continue;
      const nb = all.get(e.slug);
      if (!nb || !matchesAudience(nb.audience, filter)) continue;
      if (e.slug === "index" && e.slug !== targetSlug) continue;
      visited.add(e.slug);
      const step: TraverseStep = {
        slug: nb.slug,
        title: nb.title,
        folder: nb.folder,
        audience: nb.audience,
        hop: hop + 1,
        via: slug,
        rel: e.rel,
        direction: e.direction,
        priceLabel: nb.priceLabel,
        unitLabel: nb.unitLabel,
        imageUrl: nb.imageUrl,
      };
      parent.set(nb.slug, { prev: slug, step });
      if (nb.slug === targetSlug) {
        const out: TraverseStep[] = [];
        let cur: string | undefined = targetSlug;
        while (cur && cur !== startSlug) {
          const ent = parent.get(cur);
          if (!ent) break;
          out.push(ent.step);
          cur = ent.prev;
        }
        return out.reverse();
      }
      queue.push({ slug: nb.slug, hop: hop + 1 });
    }
  }
  return null;
}

export function traverseGraph(opts: TraverseOptions): TraverseResult {
  const filter = opts.audience ?? "all";
  const dir = opts.direction ?? "both";
  const all = vault();
  const start = getNote(opts.slug);
  if (!start || !matchesAudience(start.audience, filter)) {
    return { start: null, mode: opts.toSlug ? "path" : "neighborhood", neighbors: [] };
  }

  if (opts.toSlug) {
    const target = getNote(opts.toSlug);
    if (!target || !matchesAudience(target.audience, filter)) {
      return { start, target: null, mode: "path", neighbors: [], path: [] };
    }
    const foundPath = bfsPath(all, start.slug, target.slug, dir, filter, opts.relation) ?? [];
    return { start, target, mode: "path", neighbors: foundPath, path: foundPath };
  }

  const maxDepth = Math.min(3, Math.max(1, opts.depth ?? 2));
  const maxLimit = Math.min(50, Math.max(1, opts.limit ?? 24));
  const visited = new Set<string>([start.slug]);
  const found: TraverseStep[] = [];
  const queue: { slug: string; hop: number }[] = [{ slug: start.slug, hop: 0 }];

  for (let qi = 0; qi < queue.length; qi++) {
    const { slug, hop } = queue[qi];
    if (hop >= maxDepth) continue;
    if (hop >= 1 && slug === "index" && start.slug !== "index") continue;
    const node = all.get(slug);
    if (!node) continue;
    // Cap fan-out on huge category/unit hubs during hop >= 1 so BFS stays instant
    const edges = edgeListFor(node, dir);
    const iterEdges = hop >= 1 && edges.length > 40 ? edges.slice(0, 40) : edges;
    for (const e of iterEdges) {
      if (opts.relation && e.rel !== opts.relation) continue;
      if (visited.has(e.slug)) continue;
      const nb = all.get(e.slug);
      if (!nb || !matchesAudience(nb.audience, filter)) continue;
      visited.add(e.slug);
      const nextHop = hop + 1;
      found.push({
        slug: nb.slug,
        title: nb.title,
        folder: nb.folder,
        audience: nb.audience,
        hop: nextHop,
        via: slug,
        rel: e.rel,
        direction: e.direction,
        priceLabel: nb.priceLabel,
        unitLabel: nb.unitLabel,
        imageUrl: nb.imageUrl,
      });
      queue.push({ slug: nb.slug, hop: nextHop });
    }
  }

  const folderFilter = opts.folder?.trim().toLowerCase();
  const neighbors = found
    .filter((s) => !folderFilter || s.folder === folderFilter)
    .sort((a, c) => a.hop - c.hop || (a.folder === "product" ? -1 : 1) - (c.folder === "product" ? -1 : 1))
    .slice(0, maxLimit);

  return { start, mode: "neighborhood", neighbors };
}

export function connectedNeighbors(
  seedSlugs: string[],
  filter: AudienceFilter = "all",
  limit = 8,
): (TraverseStep & { shared: number })[] {
  const all = vault();
  const seeds = new Set(seedSlugs);
  const acc = new Map<string, { step: TraverseStep; shared: number }>();

  for (const seedSlug of seedSlugs) {
    const seed = all.get(seedSlug);
    if (!seed || !matchesAudience(seed.audience, filter)) continue;
    for (const e of edgeListFor(seed, "both").slice(0, 30)) {
      if (seeds.has(e.slug) || e.slug === "index") continue;
      const nb = all.get(e.slug);
      if (!nb || !matchesAudience(nb.audience, filter)) continue;
      const prev = acc.get(e.slug);
      if (!prev) {
        acc.set(e.slug, {
          step: {
            slug: nb.slug,
            title: nb.title,
            folder: nb.folder,
            audience: nb.audience,
            hop: 1,
            via: seedSlug,
            rel: e.rel,
            direction: e.direction,
            priceLabel: nb.priceLabel,
            unitLabel: nb.unitLabel,
            imageUrl: nb.imageUrl,
          },
          shared: 1,
        });
      } else {
        prev.shared++;
      }
    }
  }

  return [...acc.values()]
    .sort((a, c) => c.shared - a.shared)
    .slice(0, limit)
    .map(({ step, shared }) => ({ ...step, shared }));
}

export function excerpt(body: string, ts: string[], budget: number): string {
  if (body.length <= budget) return body;
  const parts = body.split(/\n(?=## )/);
  const keep = new Set([0]);
  let used = parts[0].length;
  const scored = parts
    .map((p, idx) => {
      const np = normalizeText(p);
      let sc = 0;
      for (const t of ts) if (np.includes(t)) sc += 2;
      return { idx, sc };
    })
    .slice(1)
    .sort((a, c) => c.sc - a.sc);

  for (const { idx } of scored) {
    if (used + parts[idx].length <= budget) {
      keep.add(idx);
      used += parts[idx].length;
    }
  }
  return parts.filter((_, idx) => keep.has(idx)).join("\n").slice(0, budget);
}

export function findMedia(opts: {
  query?: string;
  kind?: "all" | "image" | "youtube" | "webpage";
  audience?: AudienceFilter;
  limit?: number;
}): { items: MediaItem[]; matchedNotes: { slug: string; title: string; folder: string }[] } {
  const filter = opts.audience ?? "user";
  const kind = opts.kind ?? "all";
  const maxLimit = Math.min(40, Math.max(1, opts.limit ?? 12));
  const q = opts.query?.trim() ?? "";
  const all = vault();

  const hits = q && q !== "*" ? search(q, 16, filter) : listVaultRows(filter).slice(0, 30);
  const items: MediaItem[] = [];
  const used = new Map<string, { slug: string; title: string; folder: string }>();
  const seenUrl = new Set<string>();

  for (const h of hits) {
    const n = all.get(h.slug);
    if (!n?.media) continue;
    if (kind === "all" || kind === "image") {
      for (const img of n.media.images) {
        if (items.length >= maxLimit || seenUrl.has(img.url)) continue;
        seenUrl.add(img.url);
        items.push({ kind: "image", title: img.alt, url: img.url, noteSlug: n.slug, noteTitle: n.title });
        used.set(n.slug, { slug: n.slug, title: n.title, folder: n.folder });
      }
    }
    if (kind === "all" || kind === "webpage") {
      for (const wp of n.media.webPages) {
        if (items.length >= maxLimit || seenUrl.has(wp.url)) continue;
        seenUrl.add(wp.url);
        items.push({ kind: "webpage", title: wp.title, url: wp.url, noteSlug: n.slug, noteTitle: n.title });
        used.set(n.slug, { slug: n.slug, title: n.title, folder: n.folder });
      }
    }
    if (items.length >= maxLimit) break;
  }

  return { items, matchedNotes: [...used.values()] };
}

// ---------- Safe Markdown Renderer (supports real product images) ----------
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

marked.use({
  gfm: true,
  renderer: {
    html: ({ text }) => (/^\s*<!--[\s\S]*-->\s*$/.test(text) ? "" : escapeHtml(text)),
    image({ href, title, text }) {
      const src = (href ?? "").trim();
      const safeAlt = escapeHtml(text || title || "รูปสินค้า");
      if (!/^https?:\/\//i.test(src)) return `<span class="muted">[รูปสินค้า: ${safeAlt}]</span>`;
      const safeSrc = escapeHtml(src);
      return `<figure class="md-fig"><a class="md-fig-link" href="${safeSrc}" target="_blank" rel="noopener noreferrer"><img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async" /></a><figcaption class="md-fig-cap"><span>${safeAlt}</span><a href="${safeSrc}" target="_blank" rel="noopener noreferrer">เปิดรูปเต็ม ↗</a></figcaption></figure>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safeHref = escapeHtml(href ?? "#");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      if (/^https?:\/\//i.test(href ?? "")) {
        return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      return `<a href="${safeHref}"${titleAttr}>${text}</a>`;
    },
  },
  walkTokens(t) {
    if ((t.type === "link" || t.type === "image") && /^\s*(javascript|data|vbscript):/i.test(t.href)) t.href = "#";
  },
});

export function renderNote(n: Note): string {
  const b = getBundle();
  const isVaultNote = b.notes.get(n.slug) === n;
  if (isVaultNote) {
    const cached = b.rendered.get(n.slug);
    if (cached !== undefined) return cached;
  }
  const notes = b.notes;
  const body = n.body.replace(WIKILINK, (_m, _rel: string | undefined, target: string, _h, label?: string) => {
    const slug = linkTarget(target);
    const text = (label ?? notes.get(slug)?.title ?? target).replace(/[[\]]/g, "");
    return `[${text}](${notes.has(slug) ? `/n/${encodeURIComponent(slug)}` : "#missing"})`;
  });
  const html = marked.parse(body, { async: false });
  if (isVaultNote && b.rendered.size < 1000) b.rendered.set(n.slug, html);
  return html;
}

export function formatUpdatedAt(): string {
  const iso = getBundle().syncedAt || process.env.BUILD_TIME || new Date().toISOString();
  return (
    new Intl.DateTimeFormat("th-TH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Bangkok",
    }).format(new Date(iso)) + " น."
  );
}

export { RELATION_LABEL };
