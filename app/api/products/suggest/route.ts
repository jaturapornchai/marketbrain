import { suggestProducts } from "@/lib/vault";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  const res = suggestProducts(q);
  return Response.json(res, {
    headers: { "Cache-Control": "no-store" },
  });
}
