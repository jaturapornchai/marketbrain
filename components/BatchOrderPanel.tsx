"use client";

import Decimal from "decimal.js";
import { useState } from "react";
import { computeBatchPlanTotal, type BatchOrderMatchRow, type BatchOrderPlan } from "@/lib/batch-order";
import { formatThaiBaht, parseDecimal } from "@/lib/decimal-money";
import type { JavisProductCard } from "@/lib/product-card";

type Props = {
  plan: BatchOrderPlan;
  onChangePlan: (next: BatchOrderPlan) => void;
  onConfirm: (rows: BatchOrderMatchRow[]) => void;
  onClose: () => void;
  onDetail: (card: JavisProductCard) => void;
};

export default function BatchOrderPanel({ plan, onChangePlan, onConfirm, onClose, onDetail }: Props) {
  const [swapRowId, setSwapRowId] = useState<string | null>(null);

  const updateRows = (updater: (rows: BatchOrderMatchRow[]) => BatchOrderMatchRow[]) => {
    const nextRows = updater(plan.rows);
    onChangePlan({
      ...plan,
      rows: nextRows,
      matchedCount: nextRows.filter((r) => Boolean(r.matched)).length,
      totalFormatted: computeBatchPlanTotal(nextRows),
    });
  };

  const selectedRows = plan.rows.filter((r) => r.selected && Boolean(r.matched) && r.qty > 0);

  return (
    <section className="bo-panel" aria-label="จัดชุดสั่งรวดเดียวหลายรายการ">
      <div className="bo-head">
        <div className="bo-title-wrap">
          <span className="bo-badge">⚡ สั่งรวดเดียว</span>
          <h3>จัดชุด {plan.matchedCount}/{plan.rows.length} รายการ</h3>
          <strong className="bo-grand">รวมประมาณ {plan.totalFormatted}</strong>
        </div>
        <div className="bo-head-actions">
          <button
            type="button"
            className="btn primary bo-confirm-btn"
            disabled={selectedRows.length === 0}
            onClick={() => onConfirm(selectedRows)}
          >
            🛒 ใส่ตะกร้าทั้งชุด ({selectedRows.length})
          </button>
          <button type="button" className="jm-close-btn" onClick={onClose} aria-label="ปิดรายการจัดชุด">
            ✕
          </button>
        </div>
      </div>

      <div className="bo-rows">
        {plan.rows.map((row) => {
          const card = row.matched;
          const unitD = parseDecimal(row.unitPrice || card?.bestPrice);
          const lineTotal =
            card && unitD && unitD.gt(0)
              ? formatThaiBaht(unitD.times(new Decimal(row.qty)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2))
              : "ไม่ระบุ";
          const swapOpen = swapRowId === row.id;

          return (
            <div key={row.id} className={`bo-row${row.selected ? "" : " is-dim"}`}>
              <label className="bo-check">
                <input
                  type="checkbox"
                  checked={row.selected && Boolean(card)}
                  disabled={!card}
                  onChange={(e) =>
                    updateRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, selected: e.target.checked } : r)))
                  }
                />
              </label>

              {card?.imageUrl ? (
                <button type="button" className="bo-thumb-btn" onClick={() => onDetail(card)}>
                  <img src={card.imageUrl} alt={card.title} className="bo-thumb" />
                </button>
              ) : (
                <div className="bo-thumb-empty">📦</div>
              )}

              <div className="bo-main">
                <div className="bo-phrase-row">
                  <span className="bo-heard">🗣️ “{row.rawPhrase}”</span>
                  {row.dietaryWarn && <span className="bo-warn">⚠️ พบ{row.dietaryWarn}</span>}
                </div>
                {card ? (
                  <button type="button" className="bo-prod-link" onClick={() => onDetail(card)}>
                    {card.title}
                  </button>
                ) : (
                  <span className="bo-miss">ไม่พบสินค้าที่ตรงกับ “{row.query}”</span>
                )}
              </div>

              <div className="bo-ctrl">
                {card && card.unitOptions.length > 1 ? (
                  <select
                    className="bo-unit-sel"
                    value={row.unitCode}
                    onChange={(e) => {
                      const opt = card.unitOptions.find((u) => u.unitCode === e.target.value);
                      if (!opt) return;
                      updateRows((rows) =>
                        rows.map((r) => (r.id === row.id ? { ...r, unitCode: opt.unitCode, unitPrice: opt.price } : r)),
                      );
                    }}
                  >
                    {card.unitOptions.map((u) => (
                      <option key={u.unitCode} value={u.unitCode}>
                        {u.unitCode} ({u.priceFormatted})
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="bo-unit-pill">{row.unitCode}</span>
                )}

                <div className="bo-qty">
                  <button
                    type="button"
                    className="qty-step-btn sm"
                    onClick={() =>
                      updateRows((rows) =>
                        rows.map((r) => (r.id === row.id ? { ...r, qty: Math.max(1, r.qty - 1) } : r)),
                      )
                    }
                    aria-label="ลดจำนวน"
                  >
                    −
                  </button>
                  <b>{row.qty}</b>
                  <button
                    type="button"
                    className="qty-step-btn sm"
                    onClick={() =>
                      updateRows((rows) =>
                        rows.map((r) => (r.id === row.id ? { ...r, qty: Math.min(999, r.qty + 1) } : r)),
                      )
                    }
                    aria-label="เพิ่มจำนวน"
                  >
                    +
                  </button>
                </div>

                {row.alternatives.length > 1 && (
                  <button
                    type="button"
                    className={`bo-swap-btn${swapOpen ? " active" : ""}`}
                    onClick={() => setSwapRowId(swapOpen ? null : row.id)}
                    title="เปลี่ยนยี่ห้อ/รุ่นอื่นที่คล้ายกัน"
                  >
                    🔄 สลับ
                  </button>
                )}

                <strong className="bo-line-sum">{lineTotal}</strong>
              </div>

              {swapOpen && row.alternatives.length > 1 && (
                <div className="bo-alts">
                  {row.alternatives.map((alt) => (
                    <button
                      key={alt.slug}
                      type="button"
                      className={`bo-alt-chip${alt.slug === card?.slug ? " active" : ""}`}
                      onClick={() => {
                        updateRows((rows) =>
                          rows.map((r) =>
                            r.id === row.id
                              ? {
                                  ...r,
                                  matched: alt,
                                  unitCode: alt.unitCode,
                                  unitPrice: alt.bestPrice ?? "0.00",
                                  selected: true,
                                }
                              : r,
                          ),
                        );
                        setSwapRowId(null);
                      }}
                    >
                      <span>{alt.title}</span>
                      <b>{alt.priceLabel}</b>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
