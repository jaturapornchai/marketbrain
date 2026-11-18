"use client";

import type { CartSummary } from "@/lib/cart-order";
import { PROMOTIONS, formatBaht, nextPromotionHint, promotionDiscount } from "@/lib/promotions";
import Decimal from "decimal.js";

/** Coupon tickets on the cart screen: tap (or say "ใช้คูปอง") to apply; the active one gets a stamp. */
export default function CouponStrip({
  cart,
  couponCode,
  onPick,
  pulseKey,
}: {
  cart: CartSummary;
  couponCode: string;
  onPick: (code: string) => void;
  /** Changes every time a coupon is applied, so the stamp animation replays. */
  pulseKey: number;
}) {
  const subtotal = new Decimal(cart.subtotal || "0");
  const hint = nextPromotionHint(cart.subtotal, couponCode);
  return (
    <section className="cart-coupons" aria-label="คูปองส่วนลด">
      <div className="cc-head">
        <b>🎟️ คูปองส่วนลดวันนี้</b>
        <span>พูดว่า “ใช้คูปอง” น้องตี๋เลือกใบที่คุ้มที่สุดให้</span>
      </div>
      <div className="cc-list">
        {PROMOTIONS.map((p) => {
          const active = p.code === couponCode;
          const reach = promotionDiscount(p, subtotal).gt(0);
          return (
            <button
              key={active ? `${p.code}-${pulseKey}` : p.code}
              type="button"
              className={`cc-ticket c-${p.color}${active ? " active" : ""}${reach ? "" : " locked"}`}
              onClick={() => onPick(active ? "" : p.code)}
              title={active ? "แตะอีกครั้งเพื่อเอาคูปองออก" : "แตะเพื่อใช้คูปองนี้"}
            >
              <span className="cc-val">{p.kind === "percent" ? `${p.value}%` : formatBaht(p.value)}</span>
              <span className="cc-body">
                <b>{p.code}</b>
                <small>{p.title}</small>
              </span>
              <span className="cc-state">{active ? (cart.coupon?.applied ? "✓ ใช้อยู่" : "รอยอดถึง") : "ใช้"}</span>
              {active && cart.coupon?.applied && <i className="cc-stamp">ลดแล้ว!</i>}
            </button>
          );
        })}
      </div>
      {cart.coupon && <p className={`cc-note${cart.coupon.applied ? " ok" : ""}`}>{cart.coupon.note}</p>}
      {hint && <p className="cc-hint">💡 {hint}</p>}
    </section>
  );
}
