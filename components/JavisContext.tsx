"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import Decimal from "decimal.js";
import type { CartItem, CartSummary, CustomerCheckoutInfo } from "@/lib/cart-order";
import type { JavisProductCard } from "@/lib/product-card";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

const CART_STORAGE_KEY = "mb_nongtee_cart_v1";
const CUSTOMER_STORAGE_KEY = "mb_nongtee_customer_v1";
const DEV_MIC_KEY = "mb.dev.audioinput";
const DEV_SPK_KEY = "mb.dev.audiooutput";
const DEV_CAM_KEY = "mb.dev.videoinput";

export type PendingVisionPayload = {
  prompt: string;
  visionSlugs: string[];
  visionSummary: string;
  imagePreview?: string;
  cards: JavisProductCard[];
};

function formatBahtClient(decStr: string): string {
  const [i, d] = decStr.split(".");
  const commas = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return d === "00" ? `฿${commas}` : `฿${commas}.${d}`;
}

export function computeClientCart(items: CartItem[]): CartSummary {
  let sum = new Decimal(0);
  let pieces = 0;
  const normalized = items
    .filter((it) => it.qty > 0)
    .map((it) => {
      const unitD = new Decimal(it.unitPrice || "0");
      const lineD = unitD.times(new Decimal(it.qty)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const lineStr = lineD.toFixed(2);
      sum = sum.plus(lineD);
      pieces += it.qty;
      return {
        ...it,
        unitPrice: unitD.toFixed(2),
        unitPriceFormatted: formatBahtClient(unitD.toFixed(2)),
        lineTotal: lineStr,
        lineTotalFormatted: formatBahtClient(lineStr),
      };
    });
  const totalStr = sum.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return {
    items: normalized,
    itemCount: normalized.length,
    totalPieces: pieces,
    subtotal: totalStr,
    subtotalFormatted: formatBahtClient(totalStr),
    grandTotal: totalStr,
    grandTotalFormatted: formatBahtClient(totalStr),
  };
}

const EMPTY_CART: CartSummary = {
  items: [],
  itemCount: 0,
  totalPieces: 0,
  subtotal: "0.00",
  subtotalFormatted: "฿0",
  grandTotal: "0.00",
  grandTotalFormatted: "฿0",
};

const DEFAULT_CUSTOMER: CustomerCheckoutInfo = {
  customerName: "",
  shopName: "",
  phone: "",
  address: "",
  note: "",
  paymentMethod: "promptpay",
};

type JavisContextValue = {
  cart: CartSummary;
  customer: CustomerCheckoutInfo;
  pendingPrompt: string;
  pendingVision: PendingVisionPayload | null;
  qtyModalProduct: JavisProductCard | null;
  lastAddedNotice: string;
  micDeviceId: string;
  speakerDeviceId: string;
  cameraDeviceId: string;
  setMicDeviceId: (id: string) => void;
  setSpeakerDeviceId: (id: string) => void;
  setCameraDeviceId: (id: string) => void;
  askNongTee: (prompt?: string) => void;
  clearPendingPrompt: () => void;
  sendVisionToNongTee: (payload: PendingVisionPayload) => void;
  clearPendingVision: () => void;
  promptAddToCart: (product: JavisProductCard) => void;
  closeQtyModal: () => void;
  addToCart: (product: JavisProductCard, qty: number, unitCode?: string, unitPrice?: string) => void;
  updateCartQty: (slug: string, unitCode: string, qty: number) => void;
  removeFromCart: (slug: string, unitCode: string) => void;
  clearCart: () => void;
  replaceServerCart: (next: CartSummary) => void;
  updateCustomer: (patch: Partial<CustomerCheckoutInfo>) => void;
};

const JavisContext = createContext<JavisContextValue>({
  cart: EMPTY_CART,
  customer: DEFAULT_CUSTOMER,
  pendingPrompt: "",
  pendingVision: null,
  qtyModalProduct: null,
  lastAddedNotice: "",
  micDeviceId: "",
  speakerDeviceId: "",
  cameraDeviceId: "",
  setMicDeviceId: () => {},
  setSpeakerDeviceId: () => {},
  setCameraDeviceId: () => {},
  askNongTee: () => {},
  clearPendingPrompt: () => {},
  sendVisionToNongTee: () => {},
  clearPendingVision: () => {},
  promptAddToCart: () => {},
  closeQtyModal: () => {},
  addToCart: () => {},
  updateCartQty: () => {},
  removeFromCart: () => {},
  clearCart: () => {},
  replaceServerCart: () => {},
  updateCustomer: () => {},
});

export function JavisProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [cart, setCart] = useState<CartSummary>(EMPTY_CART);
  const [customer, setCustomer] = useState<CustomerCheckoutInfo>(DEFAULT_CUSTOMER);
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [pendingVision, setPendingVision] = useState<PendingVisionPayload | null>(null);
  const [qtyModalProduct, setQtyModalProduct] = useState<JavisProductCard | null>(null);
  const [lastAddedNotice, setLastAddedNotice] = useState("");
  const [micDeviceId, setMicState] = useState("");
  const [speakerDeviceId, setSpeakerState] = useState("");
  const [cameraDeviceId, setCameraState] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const rawCart = localStorage.getItem(CART_STORAGE_KEY);
      if (rawCart) {
        const parsed = JSON.parse(rawCart) as CartItem[];
        if (Array.isArray(parsed)) setCart(computeClientCart(parsed));
      }
      const rawCust = localStorage.getItem(CUSTOMER_STORAGE_KEY);
      if (rawCust) {
        const pc = JSON.parse(rawCust) as Partial<CustomerCheckoutInfo>;
        if (pc && typeof pc === "object") setCustomer((prev) => ({ ...prev, ...pc }));
      }
      setMicState(localStorage.getItem(DEV_MIC_KEY) || "");
      setSpeakerState(localStorage.getItem(DEV_SPK_KEY) || "");
      setCameraState(localStorage.getItem(DEV_CAM_KEY) || "");
    } catch {
      // ignore storage errors
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart.items));
    } catch {
      // ignore
    }
  }, [cart, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(customer));
    } catch {
      // ignore
    }
  }, [customer, hydrated]);

  const setMicDeviceId = useCallback((id: string) => {
    setMicState(id);
    try {
      localStorage.setItem(DEV_MIC_KEY, id);
    } catch {
      // ignore
    }
  }, []);

  const setSpeakerDeviceId = useCallback((id: string) => {
    setSpeakerState(id);
    try {
      localStorage.setItem(DEV_SPK_KEY, id);
    } catch {
      // ignore
    }
  }, []);

  const setCameraDeviceId = useCallback((id: string) => {
    setCameraState(id);
    try {
      localStorage.setItem(DEV_CAM_KEY, id);
    } catch {
      // ignore
    }
  }, []);

  const askNongTee = useCallback(
    (prompt?: string) => {
      if (prompt && prompt.trim()) {
        setPendingPrompt(prompt.trim());
      }
      if (pathname !== "/") {
        router.push("/");
      }
    },
    [pathname, router],
  );

  const clearPendingPrompt = useCallback(() => {
    setPendingPrompt("");
  }, []);

  const sendVisionToNongTee = useCallback(
    (payload: PendingVisionPayload) => {
      setPendingVision(payload);
      if (pathname !== "/") {
        router.push("/");
      }
    },
    [pathname, router],
  );

  const clearPendingVision = useCallback(() => {
    setPendingVision(null);
  }, []);

  const promptAddToCart = useCallback((product: JavisProductCard) => {
    setQtyModalProduct(product);
  }, []);

  const closeQtyModal = useCallback(() => {
    setQtyModalProduct(null);
  }, []);

  const addToCart = useCallback(
    (product: JavisProductCard, qty: number, unitCode?: string, unitPrice?: string) => {
      const cleanQty = Math.max(1, Math.min(9999, Math.floor(qty) || 1));
      const chosenUnit = unitCode || product.unitCode || "ชิ้น";
      const chosenPrice = unitPrice || product.bestPrice || "0.00";
      setCart((prev) => {
        const existingIdx = prev.items.findIndex(
          (x) => x.slug === product.slug && x.unitCode === chosenUnit,
        );
        const nextItems = [...prev.items];
        if (existingIdx >= 0) {
          nextItems[existingIdx] = {
            ...nextItems[existingIdx],
            qty: Math.min(9999, nextItems[existingIdx].qty + cleanQty),
          };
        } else {
          nextItems.push({
            slug: product.slug,
            productCode: product.productCode,
            barcode: product.barcode,
            title: product.title,
            brand: product.brand,
            category: product.category,
            imageUrl: product.imageUrl,
            unitCode: chosenUnit,
            packQty: product.packQty,
            baseUnitCode: product.baseUnitCode,
            unitPrice: chosenPrice,
            unitPriceFormatted: "",
            qty: cleanQty,
            lineTotal: "0.00",
            lineTotalFormatted: "",
          });
        }
        return computeClientCart(nextItems);
      });
      setQtyModalProduct(null);
      setLastAddedNotice(`เพิ่ม "${product.title}" × ${cleanQty} ${chosenUnit} ลงตะกร้าแล้วครับ`);
      setTimeout(() => setLastAddedNotice(""), 3200);
    },
    [],
  );

  const updateCartQty = useCallback((slug: string, unitCode: string, qty: number) => {
    setCart((prev) => {
      const nextItems = prev.items
        .map((it) => (it.slug === slug && it.unitCode === unitCode ? { ...it, qty: Math.max(0, Math.floor(qty)) } : it))
        .filter((it) => it.qty > 0);
      return computeClientCart(nextItems);
    });
  }, []);

  const removeFromCart = useCallback((slug: string, unitCode: string) => {
    setCart((prev) => computeClientCart(prev.items.filter((it) => !(it.slug === slug && it.unitCode === unitCode))));
  }, []);

  const clearCart = useCallback(() => {
    setCart(EMPTY_CART);
  }, []);

  const replaceServerCart = useCallback((next: CartSummary) => {
    setCart(next);
  }, []);

  const updateCustomer = useCallback((patch: Partial<CustomerCheckoutInfo>) => {
    setCustomer((prev) => ({ ...prev, ...patch }));
  }, []);

  return (
    <JavisContext.Provider
      value={{
        cart,
        customer,
        pendingPrompt,
        pendingVision,
        qtyModalProduct,
        lastAddedNotice,
        micDeviceId,
        speakerDeviceId,
        cameraDeviceId,
        setMicDeviceId,
        setSpeakerDeviceId,
        setCameraDeviceId,
        askNongTee,
        clearPendingPrompt,
        sendVisionToNongTee,
        clearPendingVision,
        promptAddToCart,
        closeQtyModal,
        addToCart,
        updateCartQty,
        removeFromCart,
        clearCart,
        replaceServerCart,
        updateCustomer,
      }}
    >
      {children}
    </JavisContext.Provider>
  );
}

export function useJavis() {
  return useContext(JavisContext);
}
