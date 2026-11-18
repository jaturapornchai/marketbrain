import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { formatThaiBaht, parseDecimal, toMoneyString } from "./decimal-money";
import type { BrainProductItem } from "./product-source";
import { getProductBySlug, searchProductsDetailed } from "./vault";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type CartItem = {
  slug: string;
  productCode: string;
  barcode: string | null;
  title: string;
  brand: string;
  category: string;
  imageUrl: string | null;
  unitCode: string;
  packQty: number;
  baseUnitCode: string;
  unitPrice: string; // Decimal string e.g. "31.00"
  unitPriceFormatted: string;
  qty: number;
  lineTotal: string; // Decimal string e.g. "155.00"
  lineTotalFormatted: string;
};

export type CartSummary = {
  items: CartItem[];
  itemCount: number;
  totalPieces: number;
  subtotal: string;
  subtotalFormatted: string;
  grandTotal: string;
  grandTotalFormatted: string;
};

export type PaymentMethod = "promptpay" | "cod" | "transfer";

export type CustomerCheckoutInfo = {
  customerName: string;
  shopName: string;
  phone: string;
  address: string;
  note: string;
  paymentMethod: PaymentMethod;
};

export type SalesOrder = {
  orderNo: string;
  createdAt: string;
  status: "confirmed";
  customer: CustomerCheckoutInfo;
  cart: CartSummary;
};

const ORDERS_PATH = path.join(process.cwd(), ".data", "orders.jsonl");

export function recalculateCart(rawItems: Array<Partial<CartItem> & { slug: string; qty: number }>): CartSummary {
  const merged = new Map<string, CartItem>();

  for (const raw of rawItems) {
    const qty = Math.max(0, Math.min(9999, Math.floor(Number(raw.qty) || 0)));
    if (qty <= 0 || !raw.slug) continue;

    // Verify against real product in brain if available (Zero-Guessing price guard)
    const realProd = getProductBySlug(raw.slug);
    const desiredUnit = (raw.unitCode ?? realProd?.unitCode ?? "ชิ้น").trim();
    const key = `${realProd?.slug ?? raw.slug}::${desiredUnit}`;

    let unitPriceStr = toMoneyString(raw.unitPrice) ?? "0.00";
    let packQty = raw.packQty ?? 1;
    let baseUnitCode = raw.baseUnitCode ?? desiredUnit;

    if (realProd) {
      const matchedConv = realProd.unitConversions.find(
        (u) =>
          u.unitCode.toLowerCase() === desiredUnit.toLowerCase() ||
          u.unitNameTh.toLowerCase() === desiredUnit.toLowerCase(),
      );
      if (matchedConv?.pricePerUnit) {
        unitPriceStr = matchedConv.pricePerUnit;
        packQty = matchedConv.standValue || realProd.packQty;
      } else if (realProd.bestPrice) {
        unitPriceStr = realProd.bestPrice;
        packQty = realProd.packQty;
      }
      baseUnitCode = realProd.baseUnitCode;
    }

    const prev = merged.get(key);
    const finalQty = Math.min(9999, (prev?.qty ?? 0) + qty);
    const unitDec = parseDecimal(unitPriceStr) ?? new Decimal(0);
    const lineDec = unitDec.times(new Decimal(finalQty)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const lineStr = lineDec.toFixed(2);

    merged.set(key, {
      slug: realProd?.slug ?? raw.slug,
      productCode: realProd?.productCode ?? raw.productCode ?? raw.slug.toUpperCase(),
      barcode: realProd?.primaryBarcode ?? raw.barcode ?? null,
      title: realProd?.nameTh ?? raw.title ?? raw.slug,
      brand: realProd ? realProd.brandTh || realProd.brandEn || "-" : raw.brand || "-",
      category: realProd ? (realProd.categoryLevelsTh[0] ?? realProd.categoryPathTh) : raw.category || "-",
      imageUrl: realProd?.imageUrl ?? raw.imageUrl ?? null,
      unitCode: desiredUnit,
      packQty,
      baseUnitCode,
      unitPrice: unitDec.toFixed(2),
      unitPriceFormatted: formatThaiBaht(unitDec.toFixed(2)),
      qty: finalQty,
      lineTotal: lineStr,
      lineTotalFormatted: formatThaiBaht(lineStr),
    });
  }

  const items = [...merged.values()];
  let sumDec = new Decimal(0);
  let totalPieces = 0;

  for (const it of items) {
    sumDec = sumDec.plus(new Decimal(it.lineTotal));
    totalPieces += it.qty;
  }

  const totalStr = sumDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return {
    items,
    itemCount: items.length,
    totalPieces,
    subtotal: totalStr,
    subtotalFormatted: formatThaiBaht(totalStr),
    grandTotal: totalStr,
    grandTotalFormatted: formatThaiBaht(totalStr),
  };
}

export function resolveProductForCart(
  identifier: string,
  preferredUnit?: string,
): { product: BrainProductItem; unitCode: string; unitPrice: string } | null {
  const clean = identifier.trim();
  if (!clean) return null;

  let prod = getProductBySlug(clean);
  if (!prod) {
    const searchRes = searchProductsDetailed({ q: clean, pageSize: 3 });
    prod = searchRes.items[0];
  }
  if (!prod || !prod.bestPrice) return null;

  let chosenUnit = prod.unitCode;
  let chosenPrice = prod.bestPrice;

  if (preferredUnit && preferredUnit.trim()) {
    const uLow = preferredUnit.trim().toLowerCase();
    const conv = prod.unitConversions.find(
      (c) => c.unitCode.toLowerCase() === uLow || c.unitNameTh.toLowerCase() === uLow,
    );
    if (conv?.pricePerUnit) {
      chosenUnit = conv.unitNameTh || conv.unitCode;
      chosenPrice = conv.pricePerUnit;
    }
  }

  return { product: prod, unitCode: chosenUnit, unitPrice: chosenPrice };
}

function generateOrderNo(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `MB-${y}${m}${d}-${rand}`;
}

export function saveSalesOrder(
  cartItems: Array<Partial<CartItem> & { slug: string; qty: number }>,
  customer: Partial<CustomerCheckoutInfo>,
): SalesOrder {
  const verifiedCart = recalculateCart(cartItems);
  if (verifiedCart.items.length === 0) {
    throw new Error("ไม่มีสินค้าในตะกร้าสำหรับเปิดคำสั่งซื้อ");
  }
  if (parseDecimal(verifiedCart.grandTotal)?.lte(0)) {
    throw new Error("ยอดรวมคำสั่งซื้อต้องมากกว่า 0 บาท");
  }

  const pm: PaymentMethod =
    customer.paymentMethod === "cod" || customer.paymentMethod === "transfer"
      ? customer.paymentMethod
      : "promptpay";

  const order: SalesOrder = {
    orderNo: generateOrderNo(),
    createdAt: new Date().toISOString(),
    status: "confirmed",
    customer: {
      customerName: (customer.customerName ?? "").trim() || "ลูกค้าหน้าร้าน / สั่งผ่านน้องตี๋",
      shopName: (customer.shopName ?? "").trim(),
      phone: (customer.phone ?? "").trim() || "-",
      address: (customer.address ?? "").trim() || "รับสินค้า / แจ้งที่อยู่เพิ่มเติม",
      note: (customer.note ?? "").trim(),
      paymentMethod: pm,
    },
    cart: verifiedCart,
  };

  fs.mkdirSync(path.dirname(ORDERS_PATH), { recursive: true });
  fs.appendFileSync(ORDERS_PATH, JSON.stringify(order) + "\n", "utf8");
  return order;
}

export function listSalesOrders(limit = 30): SalesOrder[] {
  try {
    if (!fs.existsSync(ORDERS_PATH)) return [];
    const lines = fs
      .readFileSync(ORDERS_PATH, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim());
    const parsed: SalesOrder[] = [];
    for (const line of lines.slice(-limit).reverse()) {
      try {
        parsed.push(JSON.parse(line) as SalesOrder);
      } catch {
        // skip malformed line
      }
    }
    return parsed;
  } catch {
    return [];
  }
}
