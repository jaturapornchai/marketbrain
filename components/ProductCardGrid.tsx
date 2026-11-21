"use client";

import type { CSSProperties } from "react";
import { evaluateDietaryShield, type DietaryTagId } from "@/lib/dietary-shield";
import type { JavisProductCard } from "@/lib/product-card";

export type CardActionFx = {
  slug?: string;
  kind: "add" | "ask" | "unknown" | "cmd";
};

type Props = {
  cards: JavisProductCard[];
  reasons?: Record<string, string>;
  actionFx?: CardActionFx[];
  dietaryTags?: DietaryTagId[];
  startNo?: number;
  onAdd: (card: JavisProductCard) => void;
  onDetail: (card: JavisProductCard) => void;
};

/**
 * Shared numbered product card grid used across the home showcase and "สมองแนะนำของที่เกี่ยวข้อง"
 * (spotlight + cart), so customers see one consistent card layout, badge number, unit count,
 * and quantity picker everywhere.
 */
export default function ProductCardGrid({
  cards,
  reasons,
  actionFx = [],
  dietaryTags = [],
  startNo = 1,
  onAdd,
  onDetail,
}: Props) {
  if (!cards.length) return null;

  return (
    <div className="st-cards-grid">
      {cards.map((c, cardIdx) => {
        const cardNo = startNo + cardIdx;
        const matchedFx = actionFx.findLast((fx) => fx.slug === c.slug);
        const reason = reasons?.[c.slug];
        const dietary = dietaryTags.length > 0 ? evaluateDietaryShield(c, dietaryTags) : null;
        const semanticShown = (c.badges ?? []).slice(0, reason ? 1 : 2);
        const traitsToShow =
          semanticShown.length > 0 || reason || (dietary && dietary.status !== "unknown")
            ? semanticShown.length === 0
              ? c.traits.slice(0, 1)
              : []
            : c.traits.slice(0, 2);
        return (
          <article
            key={c.slug}
            data-slug={c.slug}
            className={`st-card${matchedFx ? ` fx-${matchedFx.kind}` : ""}`}
            style={{ "--card-i": Math.min(cardIdx, 14) } as CSSProperties}
          >
            <button
              type="button"
              className="st-img-btn"
              onClick={() => onDetail(c)}
            >
              {c.imageUrl ? <img src={c.imageUrl} alt={c.title} loading="lazy" /> : <span>📦</span>}
              <span className="p-no-badge" aria-label={`เบอร์ ${cardNo}`}>
                {cardNo}
              </span>
              {c.unitOptions.length > 1 && (
                <span className="p-multi-badge">{c.unitOptions.length} หน่วยนับ</span>
              )}
            </button>

            <div className="st-card-body">
              <div className="p-meta-top">
                <span className="p-brand">{c.brand}</span>
                <span className="p-unit-chip">{c.unitLabel}</span>
              </div>
              <h3 onClick={() => onDetail(c)}>{c.title}</h3>
              <div className="p-price-row">
                <span className="p-price">{c.priceLabel}</span>
                <span className="p-per-unit">/{c.unitCode}</span>
                {c.pricePerBaseLabel && <span className="p-base-calc">({c.pricePerBaseLabel})</span>}
              </div>

              {c.barcode && (
                <div className="st-bc-row" title={`บาร์โค้ด: ${c.barcode}${c.isThaiGs1 ? " (GS1 ไทย 885)" : ""}`}>
                  <span className="st-bc-ico" aria-hidden="true">▌▌</span>
                  <code className="st-bc-code">{c.barcode}</code>
                  {c.isThaiGs1 && <span className="p-gs1">885</span>}
                </div>
              )}

              {(reason || (dietary && dietary.status !== "unknown") || semanticShown.length > 0 || traitsToShow.length > 0) && (
                <div className="p-traits">
                  {dietary?.status === "warn" && (
                    <span className="p-trait-tag p-diet-warn">⚠️ ระวัง: {dietary.warnLabels[0]}</span>
                  )}
                  {dietary?.status === "safe" && (
                    <span className="p-trait-tag p-diet-safe">✅ ผ่านเกราะ</span>
                  )}
                  {reason && <span className="p-trait-tag p-reason-tag">🔗 {reason}</span>}
                  {semanticShown.map((b) => (
                    <span key={b.id} className={`p-trait-tag p-sbadge tone-${b.tone}`} title={b.title}>
                      {b.icon} {b.label}
                    </span>
                  ))}
                  {traitsToShow.map((tr, idx) => (
                    <span key={`${tr}-${idx}`} className="p-trait-tag">
                      {tr}
                    </span>
                  ))}
                </div>
              )}

              <div className="st-card-actions">
                <button
                  type="button"
                  className="btn primary st-add-btn"
                  onClick={() => onAdd(c)}
                  title="ใส่ตะกร้า (เลือกจำนวนและหน่วยนับ)"
                >
                  🛒 ใส่ตะกร้า
                </button>
                <button
                  type="button"
                  className="p-btn-detail st-detail-icon"
                  onClick={() => onDetail(c)}
                  title="ดูรายละเอียดสินค้า"
                  aria-label="ดูรายละเอียดสินค้า"
                >
                  <span aria-hidden="true">🔍</span>
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
