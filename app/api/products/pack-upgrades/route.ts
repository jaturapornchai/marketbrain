import { computePackUpgrade, type PackUpgradeCandidate, type PackUpgradeSuggestion } from "@/lib/wholesale-tools";
import { getProductBySlug } from "@/lib/vault";

export const dynamic = "force-dynamic";

type ReqItem = {
  slug?: unknown;
  unitCode?: unknown;
  qty?: unknown;
  unitPrice?: unknown;
  packQty?: unknown;
};

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { items?: unknown };
    const rawItems = Array.isArray(body.items) ? (body.items as ReqItem[]).slice(0, 50) : [];
    const upgrades: Record<string, PackUpgradeSuggestion> = {};

    for (const raw of rawItems) {
      const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
      const unitCode = typeof raw.unitCode === "string" ? raw.unitCode.trim() : "";
      const qty = Math.max(0, Math.floor(Number(raw.qty) || 0));
      const unitPrice = typeof raw.unitPrice === "string" ? raw.unitPrice.trim() : "";
      const packQty = Math.max(1, Math.floor(Number(raw.packQty) || 1));
      if (!slug || !unitCode || qty <= 0) continue;

      const prod = getProductBySlug(slug);
      if (!prod) continue;

      const candidates: PackUpgradeCandidate[] = [];
      for (const uc of prod.unitConversions) {
        if (!uc.pricePerUnit) continue;
        const ucPack = Math.max(1, Math.round(uc.standValue || 1));
        candidates.push({
          slug: prod.slug,
          title: prod.nameTh,
          unitCode: uc.unitNameTh || uc.unitCode,
          packQty: ucPack,
          unitPrice: uc.pricePerUnit,
        });
      }

      for (const rel of prod.relatedProducts) {
        if (rel.relationType !== "pack_variant") continue;
        const targetProd =
          (rel.productCode ? getProductBySlug(rel.productCode) : undefined) ??
          (rel.primaryBarcode ? getProductBySlug(rel.primaryBarcode) : undefined);
        if (!targetProd?.bestPrice) continue;
        candidates.push({
          slug: targetProd.slug,
          title: targetProd.nameTh,
          unitCode: targetProd.unitCode,
          packQty: Math.max(1, targetProd.packQty),
          unitPrice: targetProd.bestPrice,
        });
      }

      const suggestion = computePackUpgrade(
        {
          slug: prod.slug,
          unitCode,
          packQty,
          qty,
          unitPrice: unitPrice || prod.bestPrice || "0.00",
        },
        candidates,
      );
      if (suggestion) {
        upgrades[suggestion.itemKey] = suggestion;
      }
    }

    return Response.json({ upgrades });
  } catch {
    return Response.json({ upgrades: {} }, { status: 400 });
  }
}
