import Decimal from "decimal.js";
import type { CartItem, CartSummary } from "./cart-order";
import { formatThaiBaht, parseDecimal, toMoneyString } from "./decimal-money";
import { NUM_WORDS } from "./numbered-order";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type PackUpgradeCandidate = {
  slug: string;
  title: string;
  unitCode: string;
  packQty: number;
  unitPrice: string;
};

export type PackUpgradeSuggestion = {
  itemKey: string;
  fromUnitCode: string;
  fromQty: number;
  targetSlug: string;
  targetTitle: string;
  targetUnitCode: string;
  targetPackQty: number;
  targetUnitPrice: string;
  targetUnitPriceFormatted: string;
  targetQty: number;
  perBaseSaving: string;
  perBaseSavingFormatted: string;
  totalSaving: string;
  totalSavingFormatted: string;
  targetTotalFormatted: string;
  reasonTh: string;
};

export type CartMarginLine = {
  itemKey: string;
  costPerBaseFormatted: string;
  sellPerBaseFormatted: string;
  sellLineTotalFormatted: string;
  lineProfitFormatted: string;
  baseUnits: number;
};

export type CartMarginSummary = {
  marginPct: number;
  totalCostFormatted: string;
  totalRevenueFormatted: string;
  totalProfitFormatted: string;
  lines: Record<string, CartMarginLine>;
};

export function cartItemKey(slug: string, unitCode: string): string {
  return `${slug}::${unitCode}`;
}

/**
 * Check whether upgrading a cart line to a larger multi-pack / wholesale unit yields genuine
 * per-base-unit savings using exact Decimal arithmetic (ROUND_HALF_UP).
 */
export function computePackUpgrade(
  item: Pick<CartItem, "slug" | "unitCode" | "packQty" | "qty" | "unitPrice">,
  candidates: PackUpgradeCandidate[],
): PackUpgradeSuggestion | null {
  const curPack = Math.max(1, Math.floor(item.packQty || 1));
  const curUnitD = parseDecimal(item.unitPrice);
  if (!curUnitD || curUnitD.lte(0) || item.qty <= 0 || !candidates.length) return null;

  const totalBase = item.qty * curPack;
  const curPerBase = curUnitD.div(curPack);

  let best: { cand: PackUpgradeCandidate; targetQty: number; perBaseSaving: Decimal; totalSaving: Decimal; candTotal: Decimal; candUnitD: Decimal } | null = null;

  for (const cand of candidates) {
    const candPack = Math.floor(cand.packQty || 0);
    if (candPack <= curPack) continue;
    const candUnitD = parseDecimal(cand.unitPrice);
    if (!candUnitD || candUnitD.lte(0)) continue;

    // Only suggest once requested base quantity reaches at least half of the larger pack.
    if (totalBase < Math.ceil(candPack * 0.5)) continue;

    const candPerBase = candUnitD.div(candPack);
    const perBaseSaving = curPerBase.minus(candPerBase);
    if (perBaseSaving.lte(0)) continue;

    const pctSaved = perBaseSaving.div(curPerBase);
    if (perBaseSaving.lt("0.25") && pctSaved.lt("0.03")) continue;

    const targetQty = Math.max(1, Math.ceil(totalBase / candPack));
    const equivBase = targetQty * candPack;
    const totalSaving = perBaseSaving.times(equivBase).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (totalSaving.lt("1.00")) continue;

    const candTotal = candUnitD.times(targetQty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (!best || totalSaving.gt(best.totalSaving)) {
      best = { cand, targetQty, perBaseSaving, totalSaving, candTotal, candUnitD };
    }
  }

  if (!best) return null;

  const perBaseStr = toMoneyString(best.perBaseSaving, 2) ?? "0.00";
  const totalSavingStr = best.totalSaving.toFixed(2);
  const targetPriceStr = best.candUnitD.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const perBaseFmt = formatThaiBaht(perBaseStr);
  const totalSavingFmt = formatThaiBaht(totalSavingStr);

  return {
    itemKey: cartItemKey(item.slug, item.unitCode),
    fromUnitCode: item.unitCode,
    fromQty: item.qty,
    targetSlug: best.cand.slug,
    targetTitle: best.cand.title,
    targetUnitCode: best.cand.unitCode,
    targetPackQty: best.cand.packQty,
    targetUnitPrice: targetPriceStr,
    targetUnitPriceFormatted: formatThaiBaht(targetPriceStr),
    targetQty: best.targetQty,
    perBaseSaving: perBaseStr,
    perBaseSavingFormatted: perBaseFmt,
    totalSaving: totalSavingStr,
    totalSavingFormatted: totalSavingFmt,
    targetTotalFormatted: formatThaiBaht(best.candTotal.toFixed(2)),
    reasonTh: `เปลี่ยนเป็น ${best.cand.unitCode} (${best.cand.packQty}) x${best.targetQty} ถูกกว่าหน่วยละ ${perBaseFmt} (คุ้มขึ้น ${totalSavingFmt})`,
  };
}

/**
 * Compute per-base-unit wholesale cost, retail suggested selling price, and projected profit
 * across all lines in the cart using exact Decimal arithmetic (ROUND_HALF_UP).
 */
export function computeRetailMargin(cart: Pick<CartSummary, "items">, marginPct: number): CartMarginSummary | null {
  if (!Number.isFinite(marginPct) || marginPct <= 0 || marginPct > 300 || !cart.items.length) {
    return null;
  }

  const factor = new Decimal(marginPct).div(100).plus(1);
  let totalCost = new Decimal(0);
  let totalRevenue = new Decimal(0);
  const lines: Record<string, CartMarginLine> = {};

  for (const it of cart.items) {
    const unitD = parseDecimal(it.unitPrice);
    if (!unitD || unitD.lte(0) || it.qty <= 0) continue;

    const packQty = Math.max(1, Math.floor(it.packQty || 1));
    const baseUnits = it.qty * packQty;
    const costPerBase = unitD.div(packQty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const sellPerBase = unitD.div(packQty).times(factor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const lineCost = (parseDecimal(it.lineTotal) ?? unitD.times(it.qty)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const sellLineTotal = sellPerBase.times(baseUnits).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const lineProfit = sellLineTotal.minus(lineCost).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    totalCost = totalCost.plus(lineCost);
    totalRevenue = totalRevenue.plus(sellLineTotal);

    lines[cartItemKey(it.slug, it.unitCode)] = {
      itemKey: cartItemKey(it.slug, it.unitCode),
      costPerBaseFormatted: formatThaiBaht(costPerBase.toFixed(2)),
      sellPerBaseFormatted: formatThaiBaht(sellPerBase.toFixed(2)),
      sellLineTotalFormatted: formatThaiBaht(sellLineTotal.toFixed(2)),
      lineProfitFormatted: formatThaiBaht(lineProfit.toFixed(2)),
      baseUnits,
    };
  }

  const totalProfit = totalRevenue.minus(totalCost).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return {
    marginPct,
    totalCostFormatted: formatThaiBaht(totalCost.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)),
    totalRevenueFormatted: formatThaiBaht(totalRevenue.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)),
    totalProfitFormatted: formatThaiBaht(totalProfit.toFixed(2)),
    lines,
  };
}

const MARGIN_NUM_RE = new RegExp(
  `(?:ตั้ง|คิด|บวก|กำหนด|เปิด|ปรับ|ขอ)?(?:ราคาขายปลีก)?(?:กำไร|มาร์จิ้น)(?:ขายปลีก)?(?:ไว้|ที่|เพิ่ม)?(\\d{1,3}|(?:${NUM_WORDS})+)(?:%|เปอร์เซ็นต์|เปอเซนต์|เปอเซ็น)?`,
  "i",
);

/**
 * Parse voice command for retail margin calculator:
 * "ตั้งกำไร 20%" -> 20, "คิดกำไรสามสิบเปอร์เซ็นต์" -> 30, "ปิดคิดกำไร" -> 0, else null.
 */
export function parseMarginCommand(raw: string, toNum: (s: string) => number | null): number | null {
  const t = raw.replace(/[\s.!?ๆ"'“”]+/g, "").replace(/(?:ครับผม|ครับ|คับ|ค่ะ|คะ|นะ|หน่อย|เลย|ให้ด้วย|ด้วย)+$/g, "").toLowerCase();
  if (!t || t.length > 60) return null;
  if (!t.includes("กำไร") && !t.includes("มาร์จิ้น")) return null;
  if (/^(?:ปิด|ยกเลิก|ซ่อน|ลบ|เอาออก)(?:คิด)?(?:กำไร|มาร์จิ้น)|(?:กำไร|มาร์จิ้น)(?:ปิด|ยกเลิก|ออก)/.test(t)) {
    return 0;
  }
  const m = t.match(MARGIN_NUM_RE);
  if (!m?.[1]) return null;
  const val = /^\d+$/.test(m[1]) ? Number.parseInt(m[1], 10) : toNum(m[1]);
  if (val === null || !Number.isFinite(val) || val < 1 || val > 300) return null;
  return val;
}
