import { DIETARY_TAGS, type DietaryTagId } from "@/lib/dietary-shield";
import { BADGE_BIT_BY_ID } from "@/lib/product-badges";
import type { SearchScope } from "@/lib/smart-search";
import { searchProductsDetailed, type ProductSearchQuery } from "@/lib/vault";

export const dynamic = "force-dynamic";

const ALLOWED_DIETARY = new Set<string>(DIETARY_TAGS.map((t) => t.id));

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sp = url.searchParams;

  const sortParam = sp.get("sort") ?? "relevance";
  const sort: ProductSearchQuery["sort"] =
    sortParam === "price_asc" ||
    sortParam === "price_desc" ||
    sortParam === "unit_price_asc" ||
    sortParam === "pack_desc"
      ? sortParam
      : "relevance";

  const scopeParam = sp.get("scope") ?? "all";
  const scope: SearchScope =
    scopeParam === "title" || scopeParam === "code" || scopeParam === "ingredients" ? scopeParam : "all";

  const traitsRaw = sp.get("traits") ?? "";
  const traits = traitsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);

  const badges = (sp.get("badges") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => Boolean(BADGE_BIT_BY_ID[x]))
    .slice(0, 13);

  const dietary = (sp.get("dietary") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is DietaryTagId => ALLOWED_DIETARY.has(x))
    .slice(0, 8);

  const page = Math.max(1, Math.min(500, Number(sp.get("page") ?? "1") || 1));
  const pageSize = Math.max(6, Math.min(60, Number(sp.get("pageSize") ?? "24") || 24));

  const res = searchProductsDetailed({
    q: (sp.get("q") ?? "").slice(0, 200),
    category: (sp.get("category") ?? "").slice(0, 100),
    brand: (sp.get("brand") ?? "").slice(0, 100),
    unit: (sp.get("unit") ?? "").slice(0, 40),
    traits,
    source: (sp.get("source") ?? "").slice(0, 40),
    minPrice: (sp.get("minPrice") ?? "").slice(0, 20),
    maxPrice: (sp.get("maxPrice") ?? "").slice(0, 20),
    multiUnitOnly: sp.get("multiUnitOnly") === "1" || sp.get("multiUnitOnly") === "true",
    thaiGs1Only: sp.get("thaiGs1Only") === "1" || sp.get("thaiGs1Only") === "true",
    exclude: (sp.get("exclude") ?? "").slice(0, 120),
    badges,
    dietary,
    scope,
    noAutoCorrect: sp.get("noAutoCorrect") === "1" || sp.get("noAutoCorrect") === "true",
    sort,
    page,
    pageSize,
  });

  return Response.json(res, {
    headers: { "Cache-Control": "no-store" },
  });
}
