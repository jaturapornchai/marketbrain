import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import AskTeeNoteButton from "@/components/AskTeeNoteButton";
import Shell from "@/components/Shell";
import {
  RELATION_LABEL,
  ZONE_LABEL,
  groupOf,
  matchesAudience,
  normalizeAudienceFilter,
  type AudienceFilter,
  type RelationType,
} from "@/lib/groups";
import { toProductCard } from "@/lib/product-card";
import { formatUpdatedAt, getNote, getProductBySlug, noteDescription, renderNote, traverseGraph } from "@/lib/vault";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://marketbrain.bcsmethai.com";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ mode?: string }>;
};

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const n = getNote(decodeURIComponent((await params).slug));
  if (!n) return { title: "ไม่พบเซลล์ความรู้ · MarketBrain" };
  const desc = noteDescription(n);
  const url = `${SITE_URL}/n/${encodeURIComponent(n.slug)}`;
  return {
    title: `${n.title} · MarketBrain สมองสินค้า`,
    description: desc,
    alternates: { canonical: `/n/${encodeURIComponent(n.slug)}` },
    openGraph: {
      title: `${n.title} · MarketBrain`,
      description: desc,
      url,
      type: "article",
      locale: "th_TH",
      siteName: "MarketBrain",
      ...(n.imageUrl ? { images: [{ url: n.imageUrl, alt: n.title }] } : {}),
    },
  };
}

export default async function NoteDetailPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { mode: rawMode } = await searchParams;
  const n = getNote(decodeURIComponent(slug));
  if (!n) notFound();

  const prod = getProductBySlug(n.slug);
  const productCard = prod ? toProductCard(prod) : null;
  const requestedMode = normalizeAudienceFilter(rawMode);
  const backMode: AudienceFilter = n.audience === "both" ? requestedMode : n.audience;
  const linkSuffix = backMode !== "all" ? `?mode=${backMode}` : "";

  const edgeItem = (s: string, rel: RelationType) => {
    const nbProd = getProductBySlug(s);
    const nbCard = nbProd ? toProductCard(nbProd) : null;
    return (
      <li key={`${s}-${rel}`} className="edge-item">
        <div className="edge-main">
          <Link href={`/n/${encodeURIComponent(s)}${linkSuffix}`}>{getNote(s)?.title ?? s}</Link>
          <span className="chip rel">{RELATION_LABEL[rel]}</span>
        </div>
        {nbProd && (
          <div className="edge-meta">
            {nbProd.primaryBarcode && <code className="edge-bc">▌▌ {nbProd.primaryBarcode}</code>}
            {nbProd.isThaiGs1 && <span className="p-gs1">885</span>}
            {(nbCard?.badges ?? []).slice(0, 2).map((b) => (
              <span key={b.id} className={`p-trait-tag p-sbadge tone-${b.tone}`} title={b.title}>
                {b.icon} {b.label}
              </span>
            ))}
          </div>
        )}
      </li>
    );
  };

  const visibleOut = n.outEdges
    .filter((e) => {
      const nb = getNote(e.slug);
      return nb && matchesAudience(nb.audience, backMode);
    })
    .slice(0, 35);

  const visibleIn = n.inEdges
    .filter((e) => {
      const nb = getNote(e.slug);
      return nb && matchesAudience(nb.audience, backMode);
    })
    .slice(0, 35);

  const hop2 = traverseGraph({ slug: n.slug, depth: 2, audience: backMode, limit: 16 })
    .neighbors.filter((s) => s.hop === 2)
    .slice(0, 10);

  return (
    <Shell updatedAtText={`อัปเดต ${formatUpdatedAt()}`}>
      <div className="page">
        <p className="crumb">
          <Link href="/">น้องตี๋ Javis</Link> / <Link href="/search">ค้นหาสินค้า</Link> /{" "}
          <span style={{ color: groupOf(n.folder).color }}>{groupOf(n.folder).label}</span>
        </p>

        <AskTeeNoteButton slug={n.slug} title={n.title} productCard={productCard} />

        <div className="note-grid">
          <article className="note-article">
            <div className="chips">
              <span className={`chip zone zone-${n.audience}`}>{ZONE_LABEL[n.audience]}</span>
              <span className="chip" style={{ color: groupOf(n.folder).color }}>
                {groupOf(n.folder).shortLabel}
              </span>
              {[...new Set(n.tags)].map((t) => (
                <span className="chip" key={t}>
                  #{t}
                </span>
              ))}
              {productCard?.barcode && <code className="edge-bc">▌▌ {productCard.barcode}</code>}
              {productCard?.fdaNumber && <span className="p-trait-tag p-sbadge tone-fda">🛡️ อ.ย. {productCard.fdaNumber}</span>}
              {(productCard?.badges ?? []).map((b) => (
                <span key={b.id} className={`p-trait-tag p-sbadge tone-${b.tone}`} title={b.title}>
                  {b.icon} {b.label}
                </span>
              ))}
            </div>
            <div className="md" dangerouslySetInnerHTML={{ __html: renderNote(n) }} />
          </article>

          <aside className="side">
            {visibleOut.length > 0 && (
              <section className="card">
                <h3>ไซแนปส์เชื่อมออก ({n.outEdges.length})</h3>
                <ul className="edge-list">{visibleOut.map((e) => edgeItem(e.slug, e.rel))}</ul>
              </section>
            )}
            {visibleIn.length > 0 && (
              <section className="card">
                <h3>เซลล์ที่เชื่อมเข้ามา ({n.inEdges.length})</h3>
                <ul className="edge-list">{visibleIn.map((e) => edgeItem(e.slug, e.rel))}</ul>
              </section>
            )}
            {hop2.length > 0 && (
              <section className="card">
                <h3>เชื่อมโยงต่ออีกทอด (2-hop)</h3>
                <ul className="edge-list">{hop2.map((s) => edgeItem(s.slug, s.rel))}</ul>
              </section>
            )}
          </aside>
        </div>

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(
              prod
                ? {
                    "@context": "https://schema.org",
                    "@type": "Product",
                    name: prod.nameTh,
                    sku: prod.productCode,
                    gtin13: prod.primaryBarcode ?? undefined,
                    brand: prod.brandTh ? { "@type": "Brand", name: prod.brandTh } : undefined,
                    category: prod.categoryPathTh,
                    image: prod.imageUrl ?? undefined,
                    description: prod.features || prod.description || prod.nameTh,
                    offers: prod.bestPrice
                      ? {
                          "@type": "Offer",
                          priceCurrency: "THB",
                          price: prod.bestPrice,
                          availability: "https://schema.org/InStock",
                        }
                      : undefined,
                  }
                : {
                    "@context": "https://schema.org",
                    "@type": "TechArticle",
                    headline: n.title,
                    description: noteDescription(n),
                    inLanguage: "th",
                    url: `${SITE_URL}/n/${encodeURIComponent(n.slug)}`,
                  },
            ).replace(/</g, "\\u003c"),
          }}
        />
      </div>
    </Shell>
  );
}
