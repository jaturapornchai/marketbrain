import { appendVoiceLog } from "@/lib/voice-log";

export const dynamic = "force-dynamic";

const ALLOWED_KINDS = new Set(["screen_cmd", "budget_cmd", "coupon_cmd", "echo_drop"]);

export async function POST(req: Request): Promise<Response> {
  try {
    const len = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > 2048) {
      return Response.json({ ok: false }, { status: 413 });
    }
    const body = (await req.json()) as Record<string, unknown>;
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!ALLOWED_KINDS.has(kind)) {
      return Response.json({ ok: false }, { status: 400 });
    }
    appendVoiceLog({
      kind,
      heard: typeof body.heard === "string" ? body.heard.slice(0, 200) : "",
      cmd: typeof body.cmd === "string" ? body.cmd.slice(0, 80) : undefined,
      reply: typeof body.reply === "string" ? body.reply.slice(0, 200) : undefined,
      stage: typeof body.stage === "string" ? body.stage.slice(0, 40) : undefined,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
}
