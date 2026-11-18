import Shell from "@/components/Shell";
import JavisSalesCockpit from "@/components/JavisSalesCockpit";
import { toProductCard } from "@/lib/product-card";
import { brainStats, formatUpdatedAt, searchProductsDetailed } from "@/lib/vault";

export const dynamic = "force-dynamic";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://marketbrain.bcsmethai.com";

export default function HomePage() {
  const st = brainStats();
  const featured = searchProductsDetailed({ multiUnitOnly: true, pageSize: 12 }).items.map(toProductCard);

  return (
    <>
      <Shell updatedAtText={`อัปเดต ${formatUpdatedAt()}`} />
      <main>
        <JavisSalesCockpit featuredProducts={featured} totalProductsCount={st.totalProducts} />
      </main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "MarketBrain — Javis น้องตี๋ เลขาหาสินค้าและปิดการขาย",
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            url: SITE_URL,
            inLanguage: "th",
            description:
              "ผู้ช่วยเสียงภาษาไทย Javis น้องตี๋ (Local OmniVoice + OpenThai ASR + DeepSeek) ค้นหาสินค้า เปลี่ยนภาพตามบริบท จัดตะกร้า และปิดการขายได้ทันที",
          }).replace(/</g, "\\u003c"),
        }}
      />
    </>
  );
}
