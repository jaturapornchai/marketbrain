import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://marketbrain.bcsmethai.com";

const CRAWLERS = [
  "*",
  "Googlebot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: CRAWLERS.map((userAgent) => ({
      userAgent,
      allow: "/",
      disallow: ["/mcp", "/api/"],
    })),
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
