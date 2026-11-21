import { stripBotEcho } from "@/lib/echo-guard";
import { chooseBestHeard, fixHeard } from "@/lib/heard-fix";
import { cleanBrowseQuery } from "@/lib/nong-tee";
import { getRecentServerTts } from "@/lib/recent-tts";
import { heardVocab, searchProductsDetailed } from "@/lib/vault";
import { classifyVoiceIntent } from "@/lib/voice-gate";
import { appendVoiceLog } from "@/lib/voice-log";

export const dynamic = "force-dynamic";

const VOICE_URL = process.env.LOCAL_VOICE_URL || "http://127.0.0.1:3091";

/** Misheard words -> the system's own spelling. A failure here must never lose what the customer said. */
function correctHeard(text: string): string {
  try {
    return fixHeard(text, heardVocab());
  } catch {
    return text;
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return Response.json({ text: "", voiced: false });

    const sr = req.headers.get("x-sample-rate") || "16000";
    const fmt = req.headers.get("x-audio-format") || "f32le";
    const partial = req.headers.get("x-partial") || "0";
    const pendingQty = req.headers.get("x-pending") === "1";
    const hasFocus = req.headers.get("x-focus") === "1";
    const srNum = Math.max(8000, Number.parseInt(sr, 10) || 16000);
    const pcmSec = fmt === "f32le" ? Math.round((buf.byteLength / (4 * srNum)) * 100) / 100 : undefined;

    const t0 = performance.now();
    const res = await fetch(`${VOICE_URL}/stt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-sample-rate": sr,
        "x-audio-format": fmt,
        "x-partial": partial,
      },
      body: buf,
      signal: req.signal,
    });
    const sidecarMs = Math.round(performance.now() - t0);

    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    if (!res.ok) {
      return Response.json({ ok: false, text: "", voiced: false, error: `STT ${res.status}` }, { status: 502 });
    }
    const payload = (await res.json()) as Record<string, unknown>;
    // Final transcripts only: partials are just the live caption and are replaced within a second.
    if (partial !== "1" && typeof payload.text === "string" && payload.text.trim()) {
      const skipEcho = req.headers.get("x-skip-echo-guard") === "1";
      const echoCheck = skipEcho
        ? { text: payload.text.trim(), wasEcho: false, stripped: false }
        : stripBotEcho(payload.text, getRecentServerTts());
      if (echoCheck.wasEcho) {
        appendVoiceLog({
          kind: "echo_drop",
          source: "server_tts",
          raw: payload.text,
          pcmSec,
          sidecarMs,
          ms: Math.round(performance.now() - t0),
        });
        return Response.json({ ok: true, text: "", voiced: false, echoDropped: true });
      }
      const rawEar2 = typeof payload.ear2 === "string" ? payload.ear2 : "";
      const echoCheck2 = !rawEar2.trim()
        ? { text: "", wasEcho: false, stripped: false }
        : skipEcho
          ? { text: rawEar2.trim(), wasEcho: false, stripped: false }
          : stripBotEcho(rawEar2, getRecentServerTts());
      const cleanEar2 = echoCheck2.wasEcho ? "" : echoCheck2.text;

      const tFix = performance.now();
      let chosen = { text: echoCheck.text, altText: "", picked: "ear1" as "ear1" | "ear2" };
      try {
        const vocab = heardVocab();
        chosen = chooseBestHeard(echoCheck.text, cleanEar2, vocab, (q) => {
          try {
            const stripped = cleanBrowseQuery(q);
            const qq = stripped.length >= 2 ? stripped : q;
            const r = searchProductsDetailed({ q: qq, pageSize: 3 });
            return { strong: Boolean(r.topStrongMatch && r.items.length > 0), total: r.total };
          } catch {
            return { strong: false, total: 0 };
          }
        });
      } catch {
        chosen = { text: correctHeard(echoCheck.text), altText: cleanEar2 ? correctHeard(cleanEar2) : "", picked: "ear1" };
      }
      const text = chosen.text;
      const fixMs = Math.round(performance.now() - tFix);
      const gate = await classifyVoiceIntent(text, { pendingQty, hasFocus, signal: req.signal });
      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      appendVoiceLog({
        kind: gate.allow ? "stt" : "chatter_drop",
        raw: payload.text,
        ear2: rawEar2 || undefined,
        fixed: text,
        altText: chosen.altText || undefined,
        picked: chosen.picked,
        changed: text !== payload.text,
        echoStripped: echoCheck.stripped || undefined,
        gateAllow: gate.allow,
        gateReason: gate.reason,
        ear1Ms: typeof payload.ear1Ms === "number" ? payload.ear1Ms : undefined,
        ear2Ms: typeof payload.ear2Ms === "number" ? payload.ear2Ms : undefined,
        pcmSec,
        sidecarMs,
        fixMs,
        ms: Math.round(performance.now() - t0),
      });
      return Response.json({
        ok: true,
        ...payload,
        text,
        altText: chosen.altText,
        picked: chosen.picked,
        ...(text !== payload.text ? { heard: payload.text } : {}),
        gate,
      });
    }
    return Response.json({ ok: true, ...payload });
  } catch (err) {
    if (req.signal.aborted || (err as { name?: string })?.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return Response.json({ ok: false, text: "", voiced: false, error: "Local STT offline" }, { status: 503 });
  }
}
