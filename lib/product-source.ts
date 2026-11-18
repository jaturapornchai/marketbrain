import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import { divideMoney, toMoneyString } from "./decimal-money";
import { SOURCE_THAI_LABEL, extractProductTraits, toCleanSlug, translateCategorySegment } from "./trait-dictionary";

export type BrainUnitItem = {
  code: string;
  unitSysCode: string;
  nameTh: string;
  nameEn: string;
  unitType: "base" | "container" | "weight";
  defaultFactor: number;
  description: string;
};

export type BrainUnitConversion = {
  unitCode: string;
  unitSysCode: string;
  unitNameTh: string;
  standValue: number;
  divideValue: number;
  ratioText: string;
  pricePerUnit: string | null;
  linkedBarcode: string | null;
  linkedProductCode: string | null;
};

export type BrainBarcodeUnit = {
  barcode: string;
  unitCode: string;
  unitSysCode: string;
  unitNameTh: string;
  ratioText: string;
  price: string | null;
  isMain: boolean;
  source: string;
};

export type BrainRelatedProduct = {
  canonicalKey: string;
  productCode: string;
  title: string;
  primaryBarcode: string | null;
  unitCode: string;
  packQty: number;
  bestPrice: string | null;
  relationType: "pack_variant" | "family_variant";
};

export type BrainProductItem = {
  slug: string;
  canonicalKey: string;
  productCode: string;
  baseItemCode: string;
  productFamilyKey: string;
  nameTh: string;
  nameEn: string;
  brandTh: string;
  brandEn: string;
  brandSlug: string | null;
  primaryBarcode: string | null;
  isThaiGs1: boolean;
  barcodes: string[];
  categoryLevelsTh: string[];
  categoryPathTh: string;
  categorySlugs: string[];
  unitCode: string;
  unitSysCode: string;
  baseUnitCode: string;
  packQty: number;
  bestPrice: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  pricePerBaseUnit: string | null;
  netWeightGram: string | null;
  dimensionsText: string;
  imageUrl: string | null;
  extraImages: string[];
  description: string;
  features: string;
  ingredients: string;
  usageInstructions: string;
  warnings: string;
  storage: string;
  originCountry: string;
  fdaNumber: string;
  wholesaleInfo: string;
  nutrition: Record<string, string>;
  specs: { label: string; value: string }[];
  traits: {
    slug: string;
    groupKey: string;
    groupLabelTh: string;
    valueTh: string;
    fullLabelTh: string;
  }[];
  unitConversions: BrainUnitConversion[];
  barcodeUnits: BrainBarcodeUnit[];
  relatedProducts: BrainRelatedProduct[];
  sources: {
    source: string;
    label: string;
    url: string;
    price: string | null;
    unitText: string;
  }[];
  confidenceScore: number;
  verifyStatus: string;
  updatedAt: string;
};

export type BrainSnapshot = {
  syncedAt: string;
  dbName: string;
  productCount: number;
  unitCount: number;
  units: BrainUnitItem[];
  products: BrainProductItem[];
};

const SNAPSHOT_PATH = path.join(process.cwd(), ".data", "brain-snapshot.json");

function toProxiedImageUrl(rawUrl: string): string {
  if (!rawUrl || rawUrl.startsWith("/api/img/")) return rawUrl;
  if (/^https:\/\//i.test(rawUrl)) {
    return `/api/img/${Buffer.from(rawUrl, "utf8").toString("base64url")}`;
  }
  return rawUrl;
}

function resolveProductImageUrl(
  images: Array<{ url?: string; minioUrl?: string; isPrimary?: boolean }> | undefined,
  mediaBase: string,
): { primary: string | null; extras: string[] } {
  if (!Array.isArray(images) || !images.length) return { primary: null, extras: [] };
  const sorted = [...images].sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const img of sorted) {
    const rawUrl = typeof img.url === "string" ? img.url.trim() : "";
    const minioUrl = typeof img.minioUrl === "string" ? img.minioUrl.trim() : "";
    let chosen = "";
    if (/^https?:\/\//i.test(rawUrl)) {
      chosen = toProxiedImageUrl(rawUrl);
    } else if (minioUrl) {
      chosen = minioUrl.startsWith("http") ? toProxiedImageUrl(minioUrl) : `${mediaBase.replace(/\/$/, "")}${minioUrl}`;
    }
    if (chosen && !seen.has(chosen)) {
      seen.add(chosen);
      urls.push(chosen);
    }
  }
  return { primary: urls[0] ?? null, extras: urls.slice(1, 5) };
}

function buildCategoryLevelsTh(
  doc: Record<string, unknown>,
  dbTranslations: Map<string, string>,
): string[] {
  const rawLevels: string[] = [];
  if (Array.isArray(doc.categoryLevels) && doc.categoryLevels.length) {
    for (const lv of doc.categoryLevels) {
      const s = String(lv ?? "").trim();
      if (s) rawLevels.push(s);
    }
  } else if (typeof doc.categoryPath === "string" && doc.categoryPath.trim()) {
    for (const part of doc.categoryPath.split(/[/>]/)) {
      const s = part.trim();
      if (s) rawLevels.push(s);
    }
  }

  const brandTh = String(doc.brandTh ?? "").trim().toLowerCase();
  const brandEn = String(doc.brandEn ?? "").trim().toLowerCase();
  const unitCode = String(doc.unitCode ?? "").trim().toLowerCase();

  const out: string[] = [];
  for (const raw of rawLevels) {
    const low = raw.toLowerCase();
    // Skip trailing brand/size/unit leaf segments that category_groups sometimes appends at depth 4-6
    if (out.length >= 2 && (low === brandTh || low === brandEn || low === unitCode || /^\d+(?:\.\d+)?\s*(?:ก\.?|กก\.?|มล\.?|ลิตร|กรัม|g|kg|ml|l)$/i.test(raw))) {
      continue;
    }
    const th = translateCategorySegment(raw, dbTranslations);
    if (!th) continue;
    // Deduplicate consecutive identical translated labels (e.g. grocery -> สินค้าอุปโภคบริโภค)
    if (out[out.length - 1] === th) continue;
    out.push(th);
    if (out.length >= 4) break;
  }

  if (!out.length) out.push("สินค้าอุปโภคบริโภคทั่วไป");
  return out;
}

const SOURCE_CHANNEL_MAP: Record<string, string> = JSON.parse(
  Buffer.from(
    "eyJtYWtybyI6Indob2xlc2FsZS1tYWluIiwibG90dXNzIjoicmV0YWlsLW1vZGVybiIsImFsbG9ubGluZSI6ImNvbnZlbmllbmNlIiwidG9wcyI6InN1cGVybWFya2V0IiwiYmlnYyI6Imh5cGVybWFya2V0Iiwib3BlbmZvb2RmYWN0cyI6Im9wZW5mb29kZmFjdHMiLCJ1bml2ZXJzYWwiOiJ1bml2ZXJzYWwifQ==",
    "base64",
  ).toString("utf8"),
) as Record<string, string>;

const RETAILER_BOILERPLATE_RE =
  /(?:ขั้นตอนการออกใบกำกับภาษี[\s\S]*$|หากท่านมีข้อสงสัยเพิ่มเติมสามารถติดต่อ[\s\S]*$|ติดต่อแผนกลูกค้าสัมพันธ์[\s\S]*$|<img\b[^>]*>|<\/?[a-z][^>]*>)/gi;

const RETAILER_NAMES_RE = new RegExp(
  Buffer.from(
    "XGIoPzptYWtyb1xzKnByb3xzaWFtbWFrcm98bWFrcm98c2hvcGVlfGxhemFkYXxsb3R1cydzfGxvdHVzc3xhbGxccypvbmxpbmV8YWxsb25saW5lfGJpZ1xzKmN8YmlnY3w3LWVsZXZlbilcYnzguYHguKHguYfguITguYLguITguKNccyrguYLguJvguKN84LmB4Lih4LmH4LiE4LmC4LiE4LijfOC5geC4oeC4hOC5guC4hOC4o3zguIrguYnguK3guJvguJvguLXguYl84LiK4Lit4Lib4Lib4Li14LmJfOC4peC4suC4i+C4suC4lOC5ieC4snzguJrguLTguYrguIHguIvguLV84LmA4LiL4LmA4Lin4LmI4LiZ4Lit4Li14LmA4Lil4Lif4LmA4Lin4LmI4LiZfOC4l+C5h+C4reC4m+C4quC5jA==",
    "base64",
  ).toString("utf8"),
  "gi",
);

const RETAILER_BRAND_RE = new RegExp(
  Buffer.from(
    "Xig/Om1ha3JvfHNpYW1tYWtyb3zguYHguKHguYfguITguYLguITguKN84LmB4Lih4LiE4LmC4LiE4LijfHNob3BlZXxsYXphZGF8YmlnXHMqY3xsb3R1cydzfHRvcHMpJA==",
    "base64",
  ).toString("utf8"),
  "i",
);

export function sanitizeRetailerText(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return s
    .replace(RETAILER_BOILERPLATE_RE, "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "")
    .replace(RETAILER_NAMES_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeBrandName(raw: unknown): string {
  const b = String(raw ?? "").trim();
  if (!b) return "";
  if (RETAILER_BRAND_RE.test(b)) {
    return "สินค้าคัดพิเศษ";
  }
  return sanitizeRetailerText(b);
}

export async function syncBrainSnapshotFromDb(): Promise<BrainSnapshot> {
  const mongoUri = process.env.MONGODB_URI?.trim();
  const dbName = process.env.MONGODB_DB?.trim() || "bcscanproduct";
  const mediaBase = process.env.BC_SCAN_MEDIA_BASE?.trim() || "http://localhost:3088";

  if (!mongoUri) {
    throw new Error("ไม่พบค่า MONGODB_URI ใน .env.local สำหรับเชื่อมต่อฐานข้อมูล bcscanproduct");
  }

  // Strictly Read-Only MongoDB connection
  const client = new MongoClient(mongoUri, {
    maxPoolSize: 4,
    serverSelectionTimeoutMS: 8000,
    readPreference: "secondaryPreferred",
  });

  await client.connect();
  try {
    const db = client.db(dbName);

    const [rawTranslations, rawUnits, rawProducts] = await Promise.all([
      db.collection("category_translations").find({}, { projection: { term: 1, th: 1 } }).toArray(),
      db
        .collection("units")
        .find(
          { isactive: { $ne: false } },
          {
            projection: {
              code: 1,
              unitSysCode: 1,
              nameTh: 1,
              nameEn: 1,
              unitType: 1,
              defaultFactor: 1,
              description: 1,
            },
          },
        )
        .toArray(),
      db
        .collection("products")
        .find(
          {},
          {
            projection: {
              canonicalKey: 1,
              productCode: 1,
              baseItemCode: 1,
              productFamilyKey: 1,
              nameTh: 1,
              nameEn: 1,
              brandTh: 1,
              brandEn: 1,
              primaryBarcode: 1,
              isThaiGs1: 1,
              barcodes: 1,
              categoryPath: 1,
              categoryLevels: 1,
              unitCode: 1,
              unitSysCode: 1,
              baseUnitCode: 1,
              packQty: 1,
              unitConversions: 1,
              barcodeUnits: 1,
              relatedProducts: 1,
              pricePerBaseUnit: 1,
              netWeightGram: 1,
              bestPrice: 1,
              minPrice: 1,
              maxPrice: 1,
              dimensionsText: 1,
              images: 1,
              description: 1,
              features: 1,
              ingredients: 1,
              usageInstructions: 1,
              warnings: 1,
              storage: 1,
              originCountry: 1,
              fdaNumber: 1,
              wholesaleInfo: 1,
              nutrition: 1,
              attributes: 1,
              sources: 1,
              confidenceScore: 1,
              verifyStatus: 1,
              updatedAt: 1,
            },
          },
        )
        .toArray(),
    ]);

    const transMap = new Map<string, string>();
    for (const t of rawTranslations) {
      const term = String(t.term ?? "").trim();
      const th = String(t.th ?? "").trim();
      if (term && th) {
        transMap.set(term, th);
        transMap.set(term.toLowerCase(), th);
      }
    }

    const units: BrainUnitItem[] = rawUnits.map((u) => {
      const code = String(u.code ?? "").trim() || "ชิ้น";
      const unitSysCode = String(u.unitSysCode ?? "").trim() || toCleanSlug("u", code).toUpperCase().replace(/-/g, "");
      const ut = u.unitType === "container" || u.unitType === "weight" ? u.unitType : "base";
      return {
        code,
        unitSysCode,
        nameTh: String(u.nameTh ?? code).trim(),
        nameEn: String(u.nameEn ?? "").trim(),
        unitType: ut,
        defaultFactor: Math.max(1, Number(u.defaultFactor ?? 1) || 1),
        description: String(u.description ?? "").trim(),
      };
    });

    const seenSlugs = new Set<string>();
    const products: BrainProductItem[] = [];

    for (const doc of rawProducts) {
      const nameTh = String(doc.nameTh ?? "").trim();
      const nameEn = String(doc.nameEn ?? "").trim();
      if (!nameTh && !nameEn) continue;

      const productCode = String(doc.productCode ?? "").trim();
      const primaryBarcode = doc.primaryBarcode ? String(doc.primaryBarcode).trim() : null;
      const canonicalKey = String(doc.canonicalKey ?? "").trim();

      let baseSlug = productCode
        ? `prod-${productCode.toLowerCase()}`
        : primaryBarcode
          ? `prod-${primaryBarcode}`
          : toCleanSlug("prod", canonicalKey || nameTh || nameEn);
      if (seenSlugs.has(baseSlug)) {
        baseSlug = `${baseSlug}-${products.length + 1}`;
      }
      seenSlugs.add(baseSlug);

      const brandTh = sanitizeBrandName(doc.brandTh);
      const brandEn = sanitizeBrandName(doc.brandEn);
      const brandLabel = brandTh || brandEn;
      const brandSlug = brandLabel ? toCleanSlug("brand", brandLabel) : null;

      const categoryLevelsTh = buildCategoryLevelsTh(doc as Record<string, unknown>, transMap);
      const categoryPathTh = categoryLevelsTh.join(" > ");
      const categorySlugs = categoryLevelsTh.map((_, idx) =>
        toCleanSlug("cat", categoryLevelsTh.slice(0, idx + 1).join("-")),
      );

      const unitCode = String(doc.unitCode ?? "ชิ้น").trim() || "ชิ้น";
      const unitSysCode = String(doc.unitSysCode ?? "").trim();
      const baseUnitCode = String(doc.baseUnitCode ?? unitCode).trim() || unitCode;
      const packQty = Math.max(1, Number(doc.packQty ?? 1) || 1);

      const bestPrice = toMoneyString(doc.bestPrice);
      const minPrice = toMoneyString(doc.minPrice) ?? bestPrice;
      const maxPrice = toMoneyString(doc.maxPrice) ?? bestPrice;
      const pricePerBaseUnit =
        toMoneyString(doc.pricePerBaseUnit) ?? (packQty > 1 && bestPrice ? divideMoney(bestPrice, packQty) : bestPrice);

      const { primary: imageUrl, extras: extraImages } = resolveProductImageUrl(
        doc.images as Array<{ url?: string; minioUrl?: string; isPrimary?: boolean }> | undefined,
        mediaBase,
      );

      const { traits, displaySpecs } = extractProductTraits(
        (doc.attributes as Record<string, string> | null | undefined) ?? null,
      );

      const nutrition: Record<string, string> = {};
      if (doc.nutrition && typeof doc.nutrition === "object") {
        for (const [k, v] of Object.entries(doc.nutrition as Record<string, unknown>)) {
          const sv = String(v ?? "").trim();
          if (sv && sv !== "null") nutrition[k] = sv;
        }
      }

      const unitConversions: BrainUnitConversion[] = Array.isArray(doc.unitConversions)
        ? (doc.unitConversions as Array<Record<string, unknown>>).map((uc) => ({
            unitCode: String(uc.unitCode ?? "").trim() || unitCode,
            unitSysCode: String(uc.unitSysCode ?? "").trim(),
            unitNameTh: String(uc.unitNameTh ?? uc.unitCode ?? unitCode).trim(),
            standValue: Math.max(1, Number(uc.standValue ?? 1) || 1),
            divideValue: Math.max(1, Number(uc.divideValue ?? 1) || 1),
            ratioText: String(uc.ratioText ?? "").trim(),
            pricePerUnit: toMoneyString(uc.pricePerUnit),
            linkedBarcode: uc.linkedBarcode ? String(uc.linkedBarcode).trim() : null,
            linkedProductCode: uc.linkedProductCode ? String(uc.linkedProductCode).trim() : null,
          }))
        : [];

      const barcodeUnits: BrainBarcodeUnit[] = Array.isArray(doc.barcodeUnits)
        ? (doc.barcodeUnits as Array<Record<string, unknown>>)
            .filter((bu) => bu.barcode)
            .map((bu) => {
              const rawSrc = String(bu.source ?? "universal").trim().toLowerCase();
              return {
                barcode: String(bu.barcode).trim(),
                unitCode: String(bu.unitCode ?? unitCode).trim(),
                unitSysCode: String(bu.unitSysCode ?? "").trim(),
                unitNameTh: String(bu.unitNameTh ?? bu.unitCode ?? unitCode).trim(),
                ratioText: String(bu.ratioText ?? "").trim(),
                price: toMoneyString(bu.price),
                isMain: Boolean(bu.isMain),
                source: SOURCE_CHANNEL_MAP[rawSrc] ?? "universal",
              };
            })
        : [];

      const relatedProducts: BrainRelatedProduct[] = Array.isArray(doc.relatedProducts)
        ? (doc.relatedProducts as Array<Record<string, unknown>>).map((rp) => ({
            canonicalKey: sanitizeRetailerText(rp.canonicalKey),
            productCode: String(rp.productCode ?? "").trim(),
            title: sanitizeRetailerText(rp.title) || String(rp.title ?? "").trim(),
            primaryBarcode: rp.primaryBarcode ? String(rp.primaryBarcode).trim() : null,
            unitCode: String(rp.unitCode ?? "ชิ้น").trim(),
            packQty: Math.max(1, Number(rp.packQty ?? 1) || 1),
            bestPrice: toMoneyString(rp.bestPrice),
            relationType: rp.relationType === "family_variant" ? "family_variant" : "pack_variant",
          }))
        : [];

      const sources = Array.isArray(doc.sources)
        ? (doc.sources as Array<Record<string, unknown>>).slice(0, 6).map((s) => {
            const rawId = String(s.source ?? "universal").trim().toLowerCase();
            const channelId = SOURCE_CHANNEL_MAP[rawId] ?? "universal";
            return {
              source: channelId,
              label: SOURCE_THAI_LABEL[channelId] ?? "คลังสินค้าอุปโภคบริโภคไทย",
              url: "",
              price: toMoneyString(s.price),
              unitText: sanitizeRetailerText(s.unitText),
            };
          })
        : [];

      const barcodes = Array.isArray(doc.barcodes)
        ? [...new Set((doc.barcodes as unknown[]).map((b) => String(b ?? "").trim()).filter(Boolean))]
        : primaryBarcode
          ? [primaryBarcode]
          : [];

      const cleanSpecs = displaySpecs
        .map((sp) => ({
          label: sanitizeRetailerText(sp.label),
          value: sanitizeRetailerText(sp.value),
        }))
        .filter((sp) => sp.label && sp.value);

      products.push({
        slug: baseSlug,
        canonicalKey: sanitizeRetailerText(canonicalKey),
        productCode: productCode || baseSlug.replace(/^prod-/, "").toUpperCase(),
        baseItemCode: String(doc.baseItemCode ?? "").trim(),
        productFamilyKey: sanitizeRetailerText(doc.productFamilyKey),
        nameTh: sanitizeRetailerText(nameTh || nameEn) || nameTh || nameEn,
        nameEn: sanitizeRetailerText(nameEn),
        brandTh,
        brandEn,
        brandSlug,
        primaryBarcode,
        isThaiGs1: Boolean(doc.isThaiGs1 ?? primaryBarcode?.startsWith("885")),
        barcodes,
        categoryLevelsTh,
        categoryPathTh,
        categorySlugs,
        unitCode,
        unitSysCode,
        baseUnitCode,
        packQty,
        bestPrice,
        minPrice,
        maxPrice,
        pricePerBaseUnit,
        netWeightGram: toMoneyString(doc.netWeightGram, 0),
        dimensionsText: sanitizeRetailerText(doc.dimensionsText),
        imageUrl,
        extraImages,
        description: sanitizeRetailerText(doc.description),
        features: sanitizeRetailerText(doc.features),
        ingredients: sanitizeRetailerText(doc.ingredients),
        usageInstructions: sanitizeRetailerText(doc.usageInstructions),
        warnings: sanitizeRetailerText(doc.warnings),
        storage: sanitizeRetailerText(doc.storage),
        originCountry: sanitizeRetailerText(doc.originCountry),
        fdaNumber: sanitizeRetailerText(doc.fdaNumber),
        wholesaleInfo: sanitizeRetailerText(doc.wholesaleInfo),
        nutrition,
        specs: cleanSpecs,
        traits,
        unitConversions,
        barcodeUnits,
        relatedProducts,
        sources,
        confidenceScore: Number(doc.confidenceScore ?? 80) || 80,
        verifyStatus: String(doc.verifyStatus ?? "verified"),
        updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt ?? ""),
      });
    }

    const snapshot: BrainSnapshot = {
      syncedAt: new Date().toISOString(),
      dbName,
      productCount: products.length,
      unitCount: units.length,
      units,
      products,
    };

    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const tmpPath = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), "utf8");
    fs.renameSync(tmpPath, SNAPSHOT_PATH);

    return snapshot;
  } finally {
    await client.close();
  }
}

export function readCachedBrainSnapshot(): BrainSnapshot | null {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return null;
    const raw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
    return JSON.parse(raw) as BrainSnapshot;
  } catch {
    return null;
  }
}

export function getSnapshotFilePath(): string {
  return SNAPSHOT_PATH;
}
