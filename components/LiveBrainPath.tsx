"use client";

import Link from "next/link";
import type { BrainPathTrace, JavisProductCard } from "@/lib/product-card";

type Props = {
  trace: BrainPathTrace | null;
  cards: JavisProductCard[];
  onPickCard: (card: JavisProductCard) => void;
  onClose: () => void;
};

const HUB_KIND_LABEL: Record<BrainPathTrace["hubs"][number]["kind"], string> = {
  category: "หมวดสินค้า",
  brand: "แบรนด์",
  trait: "จุดเด่น",
};

/**
 * Calm, non-cluttered 3-column synapse trail (Query -> up to 3 Hubs -> top 4 Products).
 * Opt-in via the 🧠 button so the main selling stage never distracts customers.
 */
export default function LiveBrainPath({ trace, cards, onPickCard, onClose }: Props) {
  if (!trace || (!trace.hubs.length && !trace.products.length)) return null;

  return (
    <section className="lbp-card" aria-label="เส้นทางสมองรอบล่าสุด">
      <div className="lbp-head">
        <div className="lbp-title-group">
          <span className="lbp-pill">🧠 เส้นทางสมอง</span>
          <span className="lbp-sub">แสดงเฉพาะจุดเชื่อมจริง 3 ขั้น ไม่ลายตา</span>
        </div>
        <div className="lbp-head-actions">
          <Link href="/brain" className="lbp-3d-link">
            เปิดสมอง 3D ↗
          </Link>
          <button type="button" className="lbp-close" onClick={onClose} aria-label="ซ่อนเส้นทางสมอง">
            ซ่อน
          </button>
        </div>
      </div>

      <div key={`${trace.query}-${trace.products[0]?.slug ?? ""}`} className="lbp-flow">
        <div className="lbp-col lbp-col-q">
          <span className="lbp-col-lbl">คำค้นล่าสุด</span>
          <div className="lbp-node is-query">💬 “{trace.query}”</div>
        </div>

        <svg className="lbp-wires" viewBox="0 0 60 96" preserveAspectRatio="none" aria-hidden="true">
          <path d="M2,48 C28,48 30,18 58,18" />
          <path d="M2,48 C28,48 30,48 58,48" />
          <path d="M2,48 C28,48 30,78 58,78" />
        </svg>

        <div className="lbp-col lbp-col-hubs">
          <span className="lbp-col-lbl">จุดเชื่อมสมอง ({trace.hubs.length})</span>
          <div className="lbp-stack">
            {trace.hubs.map((h) => (
              <div key={`${h.kind}-${h.label}`} className={`lbp-node is-hub kind-${h.kind}`}>
                <small>{HUB_KIND_LABEL[h.kind]}</small>
                <span>{h.label}</span>
              </div>
            ))}
          </div>
        </div>

        <svg className="lbp-wires" viewBox="0 0 60 96" preserveAspectRatio="none" aria-hidden="true">
          <path d="M2,18 C28,18 32,14 58,14" />
          <path d="M2,48 C28,48 32,48 58,48" />
          <path d="M2,78 C28,78 32,82 58,82" />
        </svg>

        <div className="lbp-col lbp-col-prods">
          <span className="lbp-col-lbl">สินค้าที่ตรงจุด (คลิกดูได้)</span>
          <div className="lbp-prod-grid">
            {trace.products.map((p) => {
              const card = cards.find((c) => c.slug === p.slug);
              return (
                <button
                  key={p.slug}
                  type="button"
                  className="lbp-node is-prod"
                  disabled={!card}
                  onClick={() => card && onPickCard(card)}
                >
                  <span className="lbp-pno">{p.no}</span>
                  <span className="lbp-pname">{p.title}</span>
                  <b className="lbp-pprice">{p.priceLabel}</b>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
