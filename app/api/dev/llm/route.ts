import { probeLocalLlmStatus } from "@/lib/nong-tee";
import { readRecentLlmDevLogs } from "@/lib/voice-log";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? "30");
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 30;
  const status = await probeLocalLlmStatus();
  const recentLogs = readRecentLlmDevLogs(limit);

  return Response.json({
    ok: true,
    primaryModel: status.primaryModel,
    fallbackModel: status.fallbackModel,
    ollamaOnline: status.localOnline,
    modelInstalled: status.modelInstalled,
    modelLoaded: status.modelLoaded,
    vramGB: status.vramGB,
    loadedModels: status.loadedModels,
    hasFallback: status.hasFallback,
    stats: status.stats,
    recentLogs,
  });
}
