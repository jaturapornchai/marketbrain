import type { CartItem, CustomerCheckoutInfo } from "@/lib/cart-order";
import { runNongTeeTurn, type JavisChatMessage } from "@/lib/nong-tee";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128 * 1024;

export async function POST(req: Request): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return Response.json({ error: "ขนาดข้อมูลเกินกำหนด (สูงสุด 128 KB)" }, { status: 413 });
  }

  let body: {
    message?: unknown;
    history?: unknown;
    cartItems?: unknown;
    customer?: unknown;
    visionSlugs?: unknown;
    visionSummary?: unknown;
    focusSlugs?: unknown;
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
    ? body.focusSlugs.filter((x): x is string => typeof x === "string" && x.length <= 160).slice(0, 6)
    : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of runNongTeeTurn({
          message,
          history,
          cartItems,
          customer,
          visionSlugs,
          visionSummary,
          focusSlugs,
        })) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "เกิดข้อผิดพลาดที่ไม่คาดคิด";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`));
      } finally {
        controller.close();
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
