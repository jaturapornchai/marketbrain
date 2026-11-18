import type { MetadataRoute } from "next";
import { listVaultRows } from "@/lib/vault";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://marketbrain.bcsmethai.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date(process.env.BUILD_TIME ?? Date.now());
  const rows = listVaultRows("all").slice(0, 5000);
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/search`, lastModified, changeFrequency: "daily", priority: 0.95 },
    { url: `${SITE_URL}/brain`, lastModified, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE_URL}/n`, lastModified, changeFrequency: "daily", priority: 0.85 },
    ...rows.map((n) => ({
      url: `${SITE_URL}/n/${encodeURIComponent(n.slug)}`,
      lastModified,
      changeFrequency: "weekly" as const,
      priority: n.folder === "product" ? 0.7 : 0.65,
    })),
  ];
}
