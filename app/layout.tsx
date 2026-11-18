import type { Metadata, Viewport } from "next";
import { Mitr, Noto_Sans_Thai } from "next/font/google";
import AddToCartModal from "@/components/AddToCartModal";
import { JavisProvider } from "@/components/JavisContext";
import "./globals.css";

const body = Noto_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});
const head = Mitr({
  subsets: ["thai", "latin"],
  weight: ["400", "500"],
  variable: "--font-head",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://marketbrain.bcsmethai.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "MarketBrain — น้องตี๋ Javis เลขาหาสินค้า & สมองสินค้าไทย",
  description:
    "คุยด้วยเสียงภาษาไทยกับน้องตี๋ (Javis Local OmniVoice + OpenThai ASR + DeepSeek) ค้นหาสินค้า เปลี่ยนภาพตามบริบท จัดตะกร้า และปิดการขายได้ทันที",
  alternates: { canonical: "/" },
  openGraph: {
    title: "MarketBrain — น้องตี๋ Javis เลขาหาสินค้า & ปิดการขาย",
    description:
      "พูดคุยหาสินค้า เปลี่ยนภาพตามบริบท จัดตะกร้า และปิดการขายได้ทันทีจากสมองสินค้าจริง 6,300+ รายการ",
    url: SITE_URL,
    siteName: "MarketBrain",
    locale: "th_TH",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#070a18",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={`${body.variable} ${head.variable}`}>
      <body>
        <JavisProvider>
          {children}
          <AddToCartModal />
        </JavisProvider>
      </body>
    </html>
  );
}
