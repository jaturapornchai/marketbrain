export const dynamic = "force-dynamic";

const VOICE_URL = process.env.LOCAL_VOICE_URL || "http://127.0.0.1:3091";

export async function POST(req: Request): Promise<Response> {
  try {
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return Response.json({ text: "", voiced: false });

    const sr = req.headers.get("x-sample-rate") || "16000";
    const fmt = req.headers.get("x-audio-format") || "f32le";
    const partial = req.headers.get("x-partial") || "0";

    const res = await fetch(`${VOICE_URL}/stt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-sample-rate": sr,
        "x-audio-format": fmt,
        "x-partial": partial,
      },
      body: buf,
    });

    if (!res.ok) {
      return Response.json({ ok: false, text: "", voiced: false, error: `STT ${res.status}` }, { status: 502 });
    }
    const payload = (await res.json()) as Record<string, unknown>;
    return Response.json({ ok: true, ...payload });
  } catch {
    return Response.json({ ok: false, text: "", voiced: false, error: "Local OpenThai STT offline" }, { status: 503 });
  }
}
