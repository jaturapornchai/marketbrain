import type { BatchOrderPlan } from "./batch-order";
import type { CartSummary, CustomerCheckoutInfo, SalesOrder } from "./cart-order";
import { formatThaiBaht } from "./decimal-money";
import { extractFdaNumber, extractProductBadges, type ProductSemanticBadge } from "./product-badges";
import type { BrainProductItem } from "./product-source";

export type BrainPathTrace = {
  query: string;
  hubs: Array<{ kind: "category" | "brand" | "trait"; label: string }>;
  products: Array<{ slug: string; no: number; title: string; priceLabel: string }>;
};

export type JavisChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type UnitOptionCard = {
  unitCode: string;
  label: string;
  price: string;
  priceFormatted: string;
  packQty: number;
};

export type JavisProductCard = {
  slug: string;
  productCode: string;
  title: string;
  brand: string;
  category: string;
  priceLabel: string;
  bestPrice: string | null;
  unitCode: string;
  unitLabel: string;
  packQty: number;
  baseUnitCode: string;
  pricePerBaseLabel: string | null;
  barcode: string | null;
  isThaiGs1: boolean;
  fdaNumber?: string | null;
  badges?: ProductSemanticBadge[];
  imageUrl: string | null;
  extraImages: string[];
  traits: string[];
  description: string;
  ingredients: string;
  warnings?: string;
  nutrition?: Record<string, string>;
  unitOptions: UnitOptionCard[];
};

import type { ScreenCommand } from "./voice-commands";
import type { LlmProviderKind } from "./voice-log";

export type JavisStageMode =
  | "welcome"
  | "showcase"
  | "spotlight"
  | "compare"
  | "camera"
  | "cart"
  | "checkout"
  | "order_confirmed";

export type JavisTeamJob = {
  id: number;
  worker: "planner" | "product" | "brain" | "synapse" | "vision" | "cart" | "order" | "calc";
  label: string;
  task: string;
  state: "run" | "done" | "none";
  ms?: number;
  count?: number;
};

export type VisionDetectedProduct = {
  hasProduct: boolean;
  barcode: string;
  brand: string;
  productName: string;
  categoryHint: string;
  unitOrSize: string;
  traitsHint: string[];
  searchQueries: string[];
  summaryTh: string;
};

export type JavisStreamEvent =
  | { type: "status"; state: "searching" | "thinking" | "speaking" | "done" | "error"; text: string }
  | { type: "engine"; provider: LlmProviderKind; model: string; label: string; ms?: number; tps?: number; fallbackReason?: string }
  | { type: "team"; job: JavisTeamJob }
  | { type: "cards"; cards: JavisProductCard[] }
  | { type: "stage"; mode: JavisStageMode; spotlight?: JavisProductCard | null; title?: string }
  | { type: "cart"; cart: CartSummary; lastChangedSlug?: string }
  | { type: "ask_qty"; product: JavisProductCard }
  /** Something the system just did (or needs to ask) for a spoken order by card number; drives the on-screen animation. */
  | { type: "action"; kind: "add" | "ask" | "unknown"; no: number; slug?: string; text: string }
  | { type: "ui"; command: ScreenCommand }
  | { type: "customer"; customer: Partial<CustomerCheckoutInfo> }
  | { type: "order"; order: SalesOrder }
  | { type: "delta"; section: "speech" | "screen"; text: string }
  | { type: "sentence"; text: string }
  | { type: "batch_order"; plan: BatchOrderPlan }
  | { type: "brain_path"; path: BrainPathTrace }
  | {
      type: "done";
      spokenText: string;
      screenMarkdown: string;
      model: string;
      provider?: LlmProviderKind;
      ms?: number;
      tps?: number;
      fallbackReason?: string;
    }
  | { type: "error"; message: string };

export function toProductCard(p: BrainProductItem): JavisProductCard {
  const unitLabel = p.packQty > 1 ? `${p.unitCode} (${p.packQty} ${p.baseUnitCode})` : p.unitCode;
  const pricePerBaseLabel =
    p.pricePerBaseUnit && (p.packQty > 1 || p.unitCode !== p.baseUnitCode)
      ? `${formatThaiBaht(p.pricePerBaseUnit)}/${p.baseUnitCode}`
      : null;

  const unitOptions: UnitOptionCard[] = [];
  if (p.bestPrice) {
    unitOptions.push({
      unitCode: p.unitCode,
      label: unitLabel,
      price: p.bestPrice,
      priceFormatted: formatThaiBaht(p.bestPrice),
      packQty: p.packQty,
    });
  }
  for (const uc of p.unitConversions) {
    if (!uc.pricePerUnit) continue;
    const uName = uc.unitNameTh || uc.unitCode;
    if (unitOptions.some((x) => x.unitCode.toLowerCase() === uName.toLowerCase())) continue;
    unitOptions.push({
      unitCode: uName,
      label: uc.ratioText ? `${uName} (${uc.ratioText})` : uName,
      price: uc.pricePerUnit,
      priceFormatted: formatThaiBaht(uc.pricePerUnit),
      packQty: uc.standValue || 1,
    });
  }

  const nutritionEntries = Object.entries(p.nutrition ?? {}).slice(0, 8);
  const fdaNumber = extractFdaNumber(p);
  const traitValues = [...new Set(p.traits.map((t) => t.valueTh))];
  const badges = extractProductBadges({
    title: p.nameTh,
    category: p.categoryPathTh,
    brand: p.brandTh || p.brandEn,
    fdaNumber,
    traits: traitValues,
    description: p.description,
    features: p.features,
    warnings: p.warnings,
    specs: p.specs,
  });

  return {
    slug: p.slug,
    productCode: p.productCode,
    title: p.nameTh,
    brand: p.brandTh || p.brandEn || "-",
    category: p.categoryLevelsTh[p.categoryLevelsTh.length - 1] ?? p.categoryPathTh,
    priceLabel: formatThaiBaht(p.bestPrice),
    bestPrice: p.bestPrice,
    unitCode: p.unitCode,
    unitLabel,
    packQty: p.packQty,
    baseUnitCode: p.baseUnitCode,
    pricePerBaseLabel,
    barcode: p.primaryBarcode,
    isThaiGs1: p.isThaiGs1,
    fdaNumber,
    badges: badges.length > 0 ? badges : undefined,
    imageUrl: p.imageUrl,
    extraImages: p.extraImages,
    traits: traitValues.slice(0, 5),
    description: p.features || p.description,
    ingredients: p.ingredients,
    warnings: p.warnings || undefined,
    nutrition: nutritionEntries.length > 0 ? Object.fromEntries(nutritionEntries) : undefined,
    unitOptions,
  };
}
