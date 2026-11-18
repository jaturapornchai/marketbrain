export const dynamic = "force-dynamic";

const VOICE_URL = process.env.LOCAL_VOICE_URL || "http://127.0.0.1:3091";

export async function GET(): Promise<Response> {
  try {
    const res = await fetch(`${VOICE_URL}/health`, { cache: "no-store" });
    if (!res.ok) return Response.json({ ok: false }, { status: 503 });
    return Response.json(await res.json());
  } catch {
    return Response.json({ ok: false, error: "Local voice engine offline" }, { status: 503 });
  }
}
