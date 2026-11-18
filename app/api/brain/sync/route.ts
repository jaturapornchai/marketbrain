import { brainStats, refreshBrainFromDatabase } from "@/lib/vault";

export const dynamic = "force-dynamic";

let lastPublicSyncMs = 0;

function isLocalRequest(req: Request): boolean {
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").toLowerCase();
  const forwardedFor = req.headers.get("x-forwarded-for") || "";
  return !forwardedFor && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));
}

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, stats: brainStats() });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const local = isLocalRequest(req);
    const now = Date.now();
    if (!local && now - lastPublicSyncMs < 60_000) {
      return Response.json({ ok: true, cached: true, ms: 0, stats: brainStats() });
    }
    if (!local) lastPublicSyncMs = now;

    const t0 = performance.now();
    const stats = await refreshBrainFromDatabase();
    const ms = Math.round(performance.now() - t0);
    return Response.json({ ok: true, ms, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ซิงก์ข้อมูลจากฐานข้อมูลไม่สำเร็จ";
    return Response.json({ ok: false, error: msg, stats: brainStats() }, { status: 500 });
  }
}
