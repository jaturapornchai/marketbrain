import {
  listSalesOrders,
  recalculateCart,
  saveSalesOrder,
  type CartItem,
  type CustomerCheckoutInfo,
  type SalesOrder,
} from "@/lib/cart-order";

export const dynamic = "force-dynamic";

const MAX_ORDER_BYTES = 128 * 1024;

function isLocalRequest(req: Request): boolean {
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").toLowerCase();
  const forwardedFor = req.headers.get("x-forwarded-for") || "";
  return !forwardedFor && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));
}

function maskPiiForPublic(order: SalesOrder): SalesOrder {
  const rawPhone = order.customer.phone || "";
  const digits = rawPhone.replace(/\D/g, "");
  const maskedPhone =
    digits.length >= 7 ? `${digits.slice(0, 3)}-***-${digits.slice(-3)}` : rawPhone ? "***" : "-";
  const rawName = order.customer.customerName || "";
  const maskedName = rawName.length > 2 ? `${rawName.slice(0, 2)}***` : rawName;
  return {
    ...order,
    customer: {
      ...order.customer,
      customerName: maskedName,
      phone: maskedPhone,
      address: order.customer.address ? "(ซ่อนข้อมูลที่อยู่เพื่อความเป็นส่วนตัว)" : "-",
    },
  };
}

export async function GET(req: Request): Promise<Response> {
  const local = isLocalRequest(req);
  const rawOrders = listSalesOrders(30);
  const orders = local ? rawOrders : rawOrders.map(maskPiiForPublic);
  return Response.json({ orders }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_ORDER_BYTES) {
    return Response.json({ ok: false, error: "ขนาดข้อมูลเกินกำหนด" }, { status: 413 });
  }
  try {
    const body = (await req.json()) as {
      action?: "recalc" | "place_order";
      items?: Array<Partial<CartItem> & { slug: string; qty: number }>;
      customer?: Partial<CustomerCheckoutInfo>;
    };

    const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
    if (body.action === "recalc") {
      return Response.json({ ok: true, cart: recalculateCart(items) });
    }

    const order = saveSalesOrder(items, body.customer ?? {});
    return Response.json({ ok: true, order });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ไม่สามารถสร้างคำสั่งซื้อได้";
    return Response.json({ ok: false, error: msg }, { status: 400 });
  }
}
