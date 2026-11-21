import { GREET_TEXT_CANONICAL, recordServerTts } from "@/lib/recent-tts";
import { toSpokenThai } from "@/lib/spoken-thai";

export const dynamic = "force-dynamic";

const VOICE_URL = process.env.LOCAL_VOICE_URL || "http://127.0.0.1:3091";

export async function GET(): Promise<Response> {
  try {
    const res = await fetch(`${VOICE_URL}/greet.wav`, { cache: "no-store" });
    if (!res.ok) return Response.json({ error: "Voice service unavailable" }, { status: 503 });
    recordServerTts(GREET_TEXT_CANONICAL);
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
    // Say units in full ("155 ก." -> "155 กรัม"); the screen keeps the short form.
    const text = typeof body.text === "string" ? toSpokenThai(body.text.trim().slice(0, 600)) : "";
    if (!text) return Response.json({ error: "Empty text" }, { status: 400 });

    let res: Response | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(`${VOICE_URL}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        lastErr = null;
        if (res.ok || res.status < 500) break;
      } catch (err) {
        lastErr = err;
        res = null;
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }

    if (!res) throw lastErr ?? new Error("Voice service unreachable");
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      console.error("[api/voice/tts] upstream error", res.status, detail);
      return Response.json({ error: `TTS status ${res.status}`, detail }, { status: 502 });
    }

    const dur = res.headers.get("X-Audio-Duration") || "2.0";
    const genMs = res.headers.get("X-Gen-Ms") || "0";
    // Skip recording synthetic UAT/test probes (x-skip-echo-record: 1) so automated TTS->STT round-trip tests pass cleanly.
    if (req.headers.get("x-skip-echo-record") !== "1") {
      recordServerTts(text);
    }
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
