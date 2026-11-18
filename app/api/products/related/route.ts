import { toProductCard, type JavisProductCard } from "@/lib/product-card";
import { connectedNeighbors, getProductBySlug } from "@/lib/vault";

export const dynamic = "force-dynamic";

const SLUG_RE = /^[\p{L}\p{N}._:-]{1,120}$/u;

// Products never link to each other directly: they meet through category / brand / trait hubs.
const HUB_REASON: Record<string, string> = {
  in_category: "กลุ่มเดียวกัน",
  has_brand: "แบรนด์เดียวกัน",
  has_trait: "คุณลักษณะคล้ายกัน",
};

/**
 * Products that share the most hubs with the given ones (brain similarity, not purchase
 * history) — so the UI says "เกี่ยวข้อง", never "ซื้อคู่กันบ่อย".
 * GET /api/products/related?slugs=a,b,c
 */
export async function GET(req: Request): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("slugs") ?? "";
  const seeds = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => SLUG_RE.test(s)))].slice(0, 6);
  if (!seeds.length) return Response.json({ cards: [], reasons: {} }, { status: 400 });

  const hubRel = new Map<string, string>();
  for (const hub of connectedNeighbors(seeds, "all", 40)) {
    if (HUB_REASON[hub.rel]) hubRel.set(hub.slug, hub.rel);
  }

  const seedSet = new Set(seeds);
  const cards: JavisProductCard[] = [];
  const reasons: Record<string, string> = {};
  for (const nb of connectedNeighbors([...hubRel.keys()], "all", 200)) {
    if (seedSet.has(nb.slug) || reasons[nb.slug]) continue;
    const p = getProductBySlug(nb.slug);
    if (!p) continue;
    cards.push(toProductCard(p));
    reasons[p.slug] = HUB_REASON[hubRel.get(nb.via) ?? ""] ?? "เกี่ยวข้องกัน";
    if (cards.length >= 12) break;
  }
  return Response.json({ cards, reasons }, { headers: { "Cache-Control": "no-store" } });
}
