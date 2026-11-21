import type { CartItem, CustomerCheckoutInfo } from "@/lib/cart-order";
import { DIETARY_TAGS, type DietaryTagId } from "@/lib/dietary-shield";
import { PRIMARY_LOCAL_MODEL, runNongTeeTurn, type JavisChatMessage } from "@/lib/nong-tee";
import { appendLlmDevLog, appendVoiceLog, type LlmProviderKind } from "@/lib/voice-log";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128 * 1024;

export async function POST(req: Request): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return Response.json({ error: "ขนาดข้อมูลเกินกำหนด (สูงสุด 128 KB)" }, { status: 413 });
  }

  let body: {
    message?: unknown;
    altHeard?: unknown;
    history?: unknown;
    cartItems?: unknown;
    customer?: unknown;
    visionSlugs?: unknown;
    visionSummary?: unknown;
    focusSlugs?: unknown;
    pendingSlug?: unknown;
    viewingSlug?: unknown;
    couponCode?: unknown;
    dietaryTags?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "รูปแบบข้อมูล JSON ไม่ถูกต้อง" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim().slice(0, 600) : "";
  if (!message) {
    return Response.json({ error: "กรุณาพิมพ์หรือพูดสิ่งที่ต้องการให้น้องตี๋ช่วยครับ" }, { status: 400 });
  }
  const rawAltHeard = typeof body.altHeard === "string" ? body.altHeard.trim().slice(0, 240) : "";
  const altHeard = rawAltHeard && rawAltHeard !== message ? rawAltHeard : undefined;

  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history: JavisChatMessage[] = rawHistory
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        Boolean(m) &&
        typeof m === "object" &&
        ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") &&
        typeof (m as { content?: unknown }).content === "string",
    )
    .slice(-4)
    .map((m) => ({ role: m.role, content: m.content.split("[จอ]")[0].trim().slice(0, 240) }));

  const cartItems = Array.isArray(body.cartItems)
    ? (body.cartItems as Array<Partial<CartItem> & { slug: string; qty: number }>).slice(0, 100)
    : [];

  const customer =
    body.customer && typeof body.customer === "object"
      ? (body.customer as Partial<CustomerCheckoutInfo>)
      : {};

  const visionSlugs = Array.isArray(body.visionSlugs)
    ? body.visionSlugs.filter((x): x is string => typeof x === "string").slice(0, 8)
    : undefined;
  const visionSummary = typeof body.visionSummary === "string" ? body.visionSummary.trim().slice(0, 180) : undefined;

  const focusSlugs = Array.isArray(body.focusSlugs)
    ? body.focusSlugs.filter((x): x is string => typeof x === "string" && x.length <= 160).slice(0, 60)
    : undefined;

  const validDietaryIds = new Set<string>(DIETARY_TAGS.map((t) => t.id));
  const dietaryTags = Array.isArray(body.dietaryTags)
    ? (body.dietaryTags.filter((x): x is DietaryTagId => typeof x === "string" && validDietaryIds.has(x)) as DietaryTagId[]).slice(0, 8)
    : undefined;

  const encoder = new TextEncoder();
  const t0 = performance.now();
  let streamClosed = false;
  const markClosed = () => {
    streamClosed = true;
  };
  req.signal.addEventListener("abort", markClosed, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      streamClosed = true;
    },
    async start(controller) {
      const tools: string[] = [];
      const actions: string[] = [];
      let doneModel = "";
      let doneProvider: LlmProviderKind = "local";
      let doneFallbackReason = "";
      let doneTps: number | undefined;
      let doneSpoken = "";
      let errMsg = "";
      let aborted = false;

      const safeEnqueue = (payload: unknown): boolean => {
        if (streamClosed || req.signal.aborted) {
          aborted = true;
          return false;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          return true;
        } catch {
          streamClosed = true;
          aborted = true;
          return false;
        }
      };

      try {
        for await (const ev of runNongTeeTurn({
          message,
          altHeard,
          history,
          cartItems,
          customer,
          visionSlugs,
          visionSummary,
          focusSlugs,
          dietaryTags,
          couponCode: typeof body.couponCode === "string" && body.couponCode.length <= 20 ? body.couponCode : undefined,
          pendingSlug: typeof body.pendingSlug === "string" && body.pendingSlug.length <= 160 ? body.pendingSlug : undefined,
          viewingSlug: typeof body.viewingSlug === "string" && body.viewingSlug.length <= 160 ? body.viewingSlug : undefined,
          signal: req.signal,
        })) {
          if (streamClosed || req.signal.aborted) {
            aborted = true;
            break;
          }
          if (ev.type === "team" && ev.job.state !== "run") {
            tools.push(`${ev.job.worker}:${ev.job.label}(${ev.job.state})`);
          } else if (ev.type === "engine") {
            doneProvider = ev.provider;
            doneModel = ev.model;
            if (ev.tps !== undefined) doneTps = ev.tps;
            if (ev.fallbackReason) doneFallbackReason = ev.fallbackReason;
          } else if (ev.type === "action") {
            actions.push(`${ev.kind}:${ev.text}`);
          } else if (ev.type === "ui") {
            actions.push(`ui:${ev.command.id}${ev.command.no ? "#" + ev.command.no : ""}`);
          } else if (ev.type === "done") {
            doneModel = ev.model;
            if (ev.provider) doneProvider = ev.provider;
            if (ev.tps !== undefined) doneTps = ev.tps;
            if (ev.fallbackReason) doneFallbackReason = ev.fallbackReason;
            doneSpoken = ev.spokenText;
          } else if (ev.type === "error") {
            errMsg = ev.message;
          }
          if (!safeEnqueue(ev)) break;
        }
      } catch (err) {
        if (req.signal.aborted || streamClosed || (err as { name?: string })?.name === "AbortError") {
          aborted = true;
        } else {
          const msg = err instanceof Error ? err.message : "เกิดข้อผิดพลาดที่ไม่คาดคิด";
          errMsg = msg;
          safeEnqueue({ type: "error", message: msg });
        }
      } finally {
        req.signal.removeEventListener("abort", markClosed);
        const totalMs = Math.round(performance.now() - t0);
        appendVoiceLog({
          kind: "chat",
          message,
          altHeard,
          focusCount: focusSlugs?.length ?? 0,
          viewingSlug: typeof body.viewingSlug === "string" ? body.viewingSlug : undefined,
          pendingSlug: typeof body.pendingSlug === "string" ? body.pendingSlug : undefined,
          cartCount: cartItems.length,
          provider: doneProvider,
          model: doneModel,
          tps: doneTps,
          fallbackReason: doneFallbackReason || undefined,
          tools,
          actions,
          spoken: doneSpoken.slice(0, 200),
          aborted: aborted || undefined,
          error: errMsg || undefined,
          ms: totalMs,
        });
        appendLlmDevLog({
          phase: "turn_summary",
          provider: doneProvider,
          model: doneModel || PRIMARY_LOCAL_MODEL,
          ms: totalMs,
          tps: doneTps,
          toolCalls: tools,
          fallbackReason: doneFallbackReason || undefined,
          error: errMsg || undefined,
          query: message,
          altHeard,
          spoken: doneSpoken.slice(0, 200),
          ok: !errMsg && !aborted,
        });
        if (!streamClosed) {
          streamClosed = true;
          try {
            controller.close();
          } catch {
            // Stream already closed by client disconnect
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
