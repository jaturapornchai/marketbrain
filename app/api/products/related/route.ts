import { toProductCard, type JavisProductCard } from "@/lib/product-card";
import { connectedNeighbors, getProductBySlug, searchProductsDetailed } from "@/lib/vault";

export const dynamic = "force-dynamic";

const SLUG_RE = /^[\p{L}\p{N}._:-]{1,120}$/u;

// Products meet through shared graph hubs or explicit relations — always sourced from the real catalog.
const HUB_REASON: Record<string, string> = {
  in_category: "กลุ่มเดียวกัน",
  has_brand: "แบรนด์เดียวกัน",
  has_trait: "คุณลักษณะคล้ายกัน",
  same_family: "รุ่น/ขนาดเดียวกัน",
  related_product: "สินค้าเกี่ยวข้อง",
};

/**
 * Rich brain-synapse related products for Showcase, Spotlight, Cart, and "ดูของที่เกี่ยวข้อง".
 * GET /api/products/related?slugs=a,b,c&limit=24
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const raw = url.searchParams.get("slugs") ?? "";
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(48, Math.max(1, limitRaw)) : 24;

  const seeds = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => SLUG_RE.test(s)))].slice(0, 10);
  if (!seeds.length) return Response.json({ cards: [], reasons: {} }, { status: 400 });

  const seedSet = new Set(seeds);
  const cards: JavisProductCard[] = [];
  const reasons: Record<string, string> = {};

  const pushProduct = (slug: string, reason: string) => {
    if (cards.length >= limit || seedSet.has(slug) || reasons[slug]) return;
    const p = getProductBySlug(slug);
    if (!p) return;
    cards.push(toProductCard(p));
    reasons[p.slug] = reason;
  };

  // Step A: direct product-to-product graph edges (same family, explicit related_product)
  for (const nb of connectedNeighbors(seeds, "all", limit, 60)) {
    pushProduct(nb.slug, HUB_REASON[nb.rel] ?? "สินค้าเกี่ยวข้อง");
    if (cards.length >= limit) break;
  }

  // Step B: shared category / brand / trait / family hubs (wide graph traversal)
  if (cards.length < limit) {
    const hubRel = new Map<string, string>();
    for (const hub of connectedNeighbors(seeds, "all", 64, 80)) {
      if (HUB_REASON[hub.rel]) hubRel.set(hub.slug, hub.rel);
    }
    if (hubRel.size > 0) {
      for (const nb of connectedNeighbors([...hubRel.keys()], "all", 500, 140)) {
        pushProduct(nb.slug, HUB_REASON[hubRel.get(nb.via) ?? ""] ?? "เกี่ยวข้องกัน");
        if (cards.length >= limit) break;
      }
    }
  }

  // Step C: real catalog backfill by category then brand so wide grids stay richly populated
  if (cards.length < limit) {
    const seenCats = new Set<string>();
    const seenBrands = new Set<string>();
    const seedItems = seeds.map((s) => getProductBySlug(s)).filter((p): p is NonNullable<typeof p> => Boolean(p));

    for (const seed of seedItems) {
      for (const catSlug of [...seed.categorySlugs].reverse()) {
        if (cards.length >= limit) break;
        if (!catSlug || seenCats.has(catSlug)) continue;
        seenCats.add(catSlug);
        const catRes = searchProductsDetailed({ category: catSlug, pageSize: limit });
        for (const it of catRes.items) {
          if (cards.length >= limit) break;
          if (!seedSet.has(it.slug) && !reasons[it.slug]) {
            cards.push(toProductCard(it));
            reasons[it.slug] = "กลุ่มเดียวกัน";
          }
        }
      }
      if (cards.length >= limit) break;
    }

    if (cards.length < limit) {
      for (const seed of seedItems) {
        if (cards.length >= limit) break;
        const bSlug = seed.brandSlug;
        if (!bSlug || seenBrands.has(bSlug)) continue;
        seenBrands.add(bSlug);
        const brandRes = searchProductsDetailed({ brand: bSlug, pageSize: limit });
        for (const it of brandRes.items) {
          if (cards.length >= limit) break;
          if (!seedSet.has(it.slug) && !reasons[it.slug]) {
            cards.push(toProductCard(it));
            reasons[it.slug] = "แบรนด์เดียวกัน";
          }
        }
      }
    }
  }

  return Response.json({ cards, reasons }, { headers: { "Cache-Control": "no-store" } });
}
