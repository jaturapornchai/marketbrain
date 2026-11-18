// Demo promotion coupons. Pure + client-safe (Decimal.js only): the browser shows the same
// discount the server charges, and the server always recomputes it before saving an order.
import Decimal from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type Promotion = {
  code: string;
  title: string;
  /** "percent" = value % off (capped by maxDiscount); "amount" = value baht off. */
  kind: "percent" | "amount";
  value: string;
  maxDiscount: string | null;
  minSpend: string;
  /** Words a customer may say instead of the code ("ใช้คูปองสิบเปอร์เซ็นต์"). */
  spoken: string[];
  color: "gold" | "rose" | "emerald";
};

export const PROMOTIONS: Promotion[] = [
  {
    code: "DEMO10",
    title: "ลด 10% ต้อนรับลูกค้าใหม่ (สูงสุด 200 บาท)",
    kind: "percent",
    value: "10",
    maxDiscount: "200.00",
    minSpend: "0.00",
    spoken: ["demo10", "เดโม", "สิบเปอร์เซ็นต์", "10เปอร์เซ็นต์", "10%", "ลูกค้าใหม่", "ต้อนรับ"],
    color: "gold",
  },
  {
    code: "SAVE50",
    title: "ซื้อครบ 500 บาท ลดทันที 50 บาท",
    kind: "amount",
    value: "50.00",
    maxDiscount: null,
    minSpend: "500.00",
    spoken: ["save50", "เซฟ", "ห้าสิบบาท", "50บาท", "ครบห้าร้อย", "ครบ500"],
    color: "rose",
  },
  {
    code: "BIG300",
    title: "ซื้อครบ 3,000 บาท ลดทันที 300 บาท",
    kind: "amount",
    value: "300.00",
    maxDiscount: null,
    minSpend: "3000.00",
    spoken: ["big300", "บิ๊ก", "สามร้อยบาท", "300บาท", "ครบสามพัน", "ครบ3000"],
    color: "emerald",
  },
];

export type AppliedCoupon = {
  code: string;
  title: string;
  /** false when the cart has not reached minSpend yet (kept so the customer sees what is missing). */
  applied: boolean;
  discount: string;
  discountFormatted: string;
  /** Short Thai note for the screen ("ซื้อเพิ่มอีก ฿120 เพื่อใช้คูปองนี้"). */
  note: string;
};

type PricedCart = {
  subtotal: string;
  grandTotal: string;
  grandTotalFormatted: string;
  discount?: string;
  discountFormatted?: string;
  coupon?: AppliedCoupon | null;
};

export function formatBaht(decStr: string): string {
  const [i, d = "00"] = decStr.split(".");
  const commas = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return d === "00" ? `฿${commas}` : `฿${commas}.${d}`;
}

export function findPromotion(code: string | null | undefined): Promotion | undefined {
  const c = String(code ?? "").trim().toUpperCase();
  return c ? PROMOTIONS.find((p) => p.code === c) : undefined;
}

/** Discount of one promotion on a subtotal (0 when minSpend is not reached). Rounded once, HALF_UP, 2 dp. */
export function promotionDiscount(p: Promotion, subtotal: Decimal): Decimal {
  if (subtotal.lt(new Decimal(p.minSpend))) return new Decimal(0);
  let d =
    p.kind === "percent"
      ? subtotal.times(new Decimal(p.value)).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : new Decimal(p.value);
  if (p.maxDiscount) d = Decimal.min(d, new Decimal(p.maxDiscount));
  return Decimal.min(d, subtotal); // never below ฿0
}

/** Re-prices a cart with a coupon code. Idempotent: always starts again from the subtotal. */
export function applyCoupon<T extends PricedCart>(cart: T, code: string | null | undefined): T {
  const subtotal = new Decimal(cart.subtotal || "0");
  const p = findPromotion(code);
  let discount = new Decimal(0);
  let coupon: AppliedCoupon | null = null;
  if (p) {
    discount = promotionDiscount(p, subtotal);
    const applied = discount.gt(0);
    const gap = new Decimal(p.minSpend).minus(subtotal);
    coupon = {
      code: p.code,
      title: p.title,
      applied,
      discount: discount.toFixed(2),
      discountFormatted: formatBaht(discount.toFixed(2)),
      note: applied
        ? `ลดไปแล้ว ${formatBaht(discount.toFixed(2))}`
        : gap.gt(0)
          ? `ซื้อเพิ่มอีก ${formatBaht(gap.toFixed(2))} เพื่อใช้คูปองนี้`
          : "ใส่สินค้าลงตะกร้าก่อนครับ",
    };
  }
  const grand = subtotal.minus(discount).toFixed(2);
  return {
    ...cart,
    discount: discount.toFixed(2),
    discountFormatted: formatBaht(discount.toFixed(2)),
    coupon,
    grandTotal: grand,
    grandTotalFormatted: formatBaht(grand),
  };
}

/** Coupon giving the biggest discount right now (or the welcome coupon when none is reachable yet). */
export function bestPromotion(subtotal: string): Promotion {
  const s = new Decimal(subtotal || "0");
  let best = PROMOTIONS[0];
  let bestD = promotionDiscount(best, s);
  for (const p of PROMOTIONS.slice(1)) {
    const d = promotionDiscount(p, s);
    if (d.gt(bestD)) [best, bestD] = [p, d];
  }
  return best;
}

/** Nearest coupon the customer can unlock by buying a bit more: "ซื้อเพิ่มอีก ฿120 ได้ลด ฿50". */
export function nextPromotionHint(subtotal: string, activeCode?: string | null): string {
  const s = new Decimal(subtotal || "0");
  if (s.lte(0)) return "";
  const activeD = (() => {
    const a = findPromotion(activeCode);
    return a ? promotionDiscount(a, s) : new Decimal(0);
  })();
  const next = PROMOTIONS.filter((p) => s.lt(new Decimal(p.minSpend)))
    .map((p) => ({ p, gap: new Decimal(p.minSpend).minus(s), gain: new Decimal(p.value) }))
    .filter((x) => x.p.kind === "amount" && x.gain.gt(activeD))
    .sort((a, b) => a.gap.comparedTo(b.gap))[0];
  return next ? `ซื้อเพิ่มอีก ${formatBaht(next.gap.toFixed(2))} ใช้คูปอง ${next.p.code} ลดได้ ${formatBaht(next.gain.toFixed(2))}` : "";
}

export type CouponCommand = { action: "apply"; code: string | null } | { action: "remove" } | { action: "list" };

// Bare "โปร" only when it is clearly the promotion word, not "โปรตีน/โปรแกรม".
const COUPON_WORD_RE =
  /คูปอง|คูปอน|โค้ด|โค๊ด|โปรโมชั่น|โปรโมชัน|โปร(?=$|อะไร|ไหม|มั้ย|บ้าง|ลด|ครับ|ค่ะ|คะ|หน่อย|นะ|ด้วย|วันนี้|ที่|เด็ด|พิเศษ)|ส่วนลด|coupon|promo/i;

/** Spoken/typed coupon commands, parsed without AI. null = not about coupons. */
export function parseCouponCommand(text: string): CouponCommand | null {
  const t = text.replace(/[\s.,!?'"“”]+/g, "").toLowerCase();
  if (t.length > 50 || !COUPON_WORD_RE.test(t)) return null;
  if (/ยกเลิก|ไม่ใช้|ไม่เอา|เอาออก|ลบ|ถอด/.test(t)) return { action: "remove" };
  const named = PROMOTIONS.find((p) => t.includes(p.code.toLowerCase()) || p.spoken.some((w) => t.includes(w.toLowerCase())));
  if (named) return { action: "apply", code: named.code };
  if (/ใช้|ขอ|เอา|ใส่|กด|เปิด|รับ|ช่วยลด|ลดให้/.test(t) && !/มีไหม|มีมั้ย|อะไรบ้าง|บ้าง/.test(t)) return { action: "apply", code: null };
  if (/มี|ดู|อะไร|บ้าง|ไหม|มั้ย|แสดง|โชว์/.test(t)) return { action: "list" };
  return null;
}
