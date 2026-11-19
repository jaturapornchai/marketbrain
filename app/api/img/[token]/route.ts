export const dynamic = "force-dynamic";

const PRIVATE_HOST_RE =
  /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fc|\[?fd|\[?fe80)/i;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  if (!token || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return new Response("Invalid image token", { status: 400 });
  }

  let targetUrl: URL;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8").trim();
    targetUrl = new URL(decoded);
  } catch {
    return new Response("Malformed image token", { status: 400 });
  }

  if (targetUrl.protocol !== "https:" || PRIVATE_HOST_RE.test(targetUrl.hostname)) {
    return new Response("Disallowed image origin", { status: 403 });
  }

  try {
    const upstream = await fetch(targetUrl.href, {
      headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(12000),
    });
    if (!upstream.ok || !upstream.body) {
      return new Response("Upstream image unavailable", { status: 404 });
    }
    const ct = upstream.headers.get("content-type") || "image/jpeg";
    // Some source buckets label real JPEGs "binary/octet-stream" (storage default) instead of an image type.
    const untyped = ct === "application/octet-stream" || ct === "binary/octet-stream";
    if (!ct.startsWith("image/") && !untyped) {
      return new Response("Unsupported media type", { status: 415 });
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": untyped ? "image/jpeg" : ct,
        "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Image fetch timeout", { status: 504 });
  }
}
