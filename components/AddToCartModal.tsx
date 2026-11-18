"use client";

import { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { useJavis } from "./JavisContext";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

const PRESET_QTYS = [1, 2, 3, 6, 12, 24];

export default function AddToCartModal() {
  const { qtyModalProduct, closeQtyModal, addToCart } = useJavis();
  const [qty, setQty] = useState(1);
  const [selectedUnitIdx, setSelectedUnitIdx] = useState(0);

  useEffect(() => {
    if (qtyModalProduct) {
      setQty(1);
      setSelectedUnitIdx(0);
    }
  }, [qtyModalProduct]);

  useEffect(() => {
    if (!qtyModalProduct) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeQtyModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [qtyModalProduct, closeQtyModal]);

  const activeUnit = useMemo(() => {
    if (!qtyModalProduct) return null;
    if (qtyModalProduct.unitOptions.length > 0) {
      return qtyModalProduct.unitOptions[selectedUnitIdx] ?? qtyModalProduct.unitOptions[0];
    }
    return {
      unitCode: qtyModalProduct.unitCode,
      label: qtyModalProduct.unitLabel,
      price: qtyModalProduct.bestPrice ?? "0.00",
      priceFormatted: qtyModalProduct.priceLabel,
      packQty: qtyModalProduct.packQty,
    };
  }, [qtyModalProduct, selectedUnitIdx]);

  const totalFormatted = useMemo(() => {
    if (!activeUnit) return "฿0";
    try {
      const unitD = new Decimal(activeUnit.price || "0");
      const tot = unitD.times(new Decimal(Math.max(1, qty))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
      const [i, d] = tot.split(".");
      const commas = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return d === "00" ? `฿${commas}` : `฿${commas}.${d}`;
    } catch {
      return activeUnit.priceFormatted;
    }
  }, [activeUnit, qty]);

  if (!qtyModalProduct || !activeUnit) return null;

  return (
    <div className="qty-backdrop" onClick={(e) => e.target === e.currentTarget && closeQtyModal()}>
      <div className="qty-modal" role="dialog" aria-modal="true" aria-label="เลือกจำนวนสินค้าใส่ตะกร้า">
        <div className="qty-head">
          <h3>🛒 เลือกจำนวนใส่ตะกร้า</h3>
          <button type="button" className="jm-close-btn" onClick={closeQtyModal} aria-label="ปิด">
            ✕
          </button>
        </div>

        <div className="qty-prod-row">
          {qtyModalProduct.imageUrl ? (
            <img src={qtyModalProduct.imageUrl} alt={qtyModalProduct.title} className="qty-prod-img" />
          ) : (
            <div className="qty-prod-noimg">📦</div>
          )}
          <div className="qty-prod-meta">
            <span className="jm-p-brand">{qtyModalProduct.brand}</span>
            <h4>{qtyModalProduct.title}</h4>
            <div className="qty-unit-price">
              <strong>{activeUnit.priceFormatted}</strong>
              <span>/ {activeUnit.unitCode}</span>
            </div>
          </div>
        </div>

        {qtyModalProduct.unitOptions.length > 1 && (
          <div className="qty-section">
            <label className="qty-lbl">เลือกหน่วยบรรจุ:</label>
            <div className="qty-unit-pills">
              {qtyModalProduct.unitOptions.map((uo, idx) => (
                <button
                  key={uo.unitCode}
                  type="button"
                  className={`qty-upill${idx === selectedUnitIdx ? " active" : ""}`}
                  onClick={() => setSelectedUnitIdx(idx)}
                >
                  <span>{uo.label}</span>
                  <b>{uo.priceFormatted}</b>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="qty-section">
          <label className="qty-lbl">กดเลือกจำนวนด่วน หรือระบุเอง:</label>
          <div className="qty-presets">
            {PRESET_QTYS.map((n) => (
              <button
                key={n}
                type="button"
                className={`qty-preset-btn${qty === n ? " active" : ""}`}
                onClick={() => setQty(n)}
              >
                {n} {activeUnit.unitCode}
              </button>
            ))}
          </div>

          <div className="qty-stepper-row">
            <button
              type="button"
              className="qty-step-btn"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              aria-label="ลดจำนวน"
            >
              −
            </button>
            <input
              type="number"
              min={1}
              max={9999}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Math.min(9999, Number(e.target.value) || 1)))}
              className="qty-input"
              aria-label="จำนวนสินค้า"
            />
            <button
              type="button"
              className="qty-step-btn"
              onClick={() => setQty((q) => Math.min(9999, q + 1))}
              aria-label="เพิ่มจำนวน"
            >
              +
            </button>
          </div>
        </div>

        <div className="qty-summary-bar">
          <div>
            <span className="qty-sum-lbl">รวมเป็นเงิน ({qty} {activeUnit.unitCode})</span>
            <strong className="qty-sum-val">{totalFormatted}</strong>
          </div>
          <button
            type="button"
            className="btn primary qty-confirm-btn"
            onClick={() => addToCart(qtyModalProduct, qty, activeUnit.unitCode, activeUnit.price)}
          >
            ✅ ยืนยันใส่ตะกร้า
          </button>
        </div>
      </div>
    </div>
  );
}
