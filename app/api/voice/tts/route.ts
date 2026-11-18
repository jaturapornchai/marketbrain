export const dynamic = "force-dynamic";

const VOICE_URL = process.env.LOCAL_VOICE_URL || "http://127.0.0.1:3091";

export async function GET(): Promise<Response> {
  try {
    const res = await fetch(`${VOICE_URL}/greet.wav`, { cache: "no-store" });
    if (!res.ok) return Response.json({ error: "Voice service unavailable" }, { status: 503 });
    const dur = res.headers.get("X-Audio-Duration") || "3.5";
    return new Response(await res.arrayBuffer(), {
      headers: {
        "Content-Type": "audio/wav",
        "X-Audio-Duration": dur,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "Local OmniVoice service offline" }, { status: 503 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { text?: string };
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 600) : "";
    if (!text) return Response.json({ error: "Empty text" }, { status: 400 });

    const res = await fetch(`${VOICE_URL}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      return Response.json({ error: `TTS status ${res.status}` }, { status: 502 });
    }

    const dur = res.headers.get("X-Audio-Duration") || "2.0";
    const genMs = res.headers.get("X-Gen-Ms") || "0";
    return new Response(await res.arrayBuffer(), {
      headers: {
        "Content-Type": "audio/wav",
        "X-Audio-Duration": dur,
        "X-Gen-Ms": genMs,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "Local OmniVoice service offline" }, { status: 503 });
  }
}
