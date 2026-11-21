import { probeLocalLlmStatus } from "@/lib/nong-tee";

export const dynamic = "force-dynamic";

const VOICE_URL = process.env.LOCAL_VOICE_URL || "http://127.0.0.1:3091";

export async function GET(): Promise<Response> {
  const [voiceResult, llm] = await Promise.all([
    fetch(`${VOICE_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(1500) })
      .then(async (res) => (res.ok ? ((await res.json()) as Record<string, unknown>) : null))
      .catch(() => null),
    probeLocalLlmStatus(),
  ]);

  if (!voiceResult) {
    return Response.json({ ok: false, error: "Local voice engine offline", llm }, { status: 503 });
  }
  return Response.json({ ...voiceResult, llm });
}
