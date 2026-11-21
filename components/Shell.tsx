"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useJavis } from "./JavisContext";

export default function Shell({
  q = "",
  updatedAtText = "",
  children,
}: {
  q?: string;
  updatedAtText?: string;
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { cart, askNongTee } = useJavis();
  const [searchVal, setSearchVal] = useState(q);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg("");
    try {
      const res = await fetch("/api/brain/sync", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; stats?: { totalProducts: number }; error?: string };
      if (data.ok && data.stats) {
        setSyncMsg(`ซิงก์แล้ว ${data.stats.totalProducts.toLocaleString("th-TH")} สินค้า`);
        router.refresh();
      } else {
        setSyncMsg(data.error || "ซิงก์ไม่สำเร็จ");
      }
    } catch {
      setSyncMsg("เชื่อมต่อ DB ไม่ได้");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(""), 4000);
    }
  };

  return (
    <>
      <header className="top">
        <Link className="brand" href="/">
          <span className="brand-dot" aria-hidden="true" />
          <span>MarketBrain</span>
        </Link>

        <nav className="top-nav" aria-label="เมนูหลัก">
          <Link href="/" className={`nav-pill${pathname === "/" ? " active" : ""}`}>
            🧑‍💼 น้องตี๋ (Javis ขายของ)
          </Link>
          <Link href="/search" className={`nav-pill${pathname.startsWith("/search") ? " active" : ""}`}>
            🔎 ค้นหาละเอียด
          </Link>
          <Link href="/brain" className={`nav-pill${pathname.startsWith("/brain") ? " active" : ""}`}>
            🧠 สมอง 3D
          </Link>
          <Link href="/n" className={`nav-pill${pathname.startsWith("/n") ? " active" : ""}`}>
            📚 สารบัญสมอง
          </Link>
        </nav>

        <form
          className="top-search"
          action="/search"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = searchVal.trim();
            router.push(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
          }}
        >
          <input
            type="search"
            name="q"
            value={searchVal}
            onChange={(e) => setSearchVal(e.target.value)}
            placeholder="ค้นสินค้า บาร์โค้ด คุณลักษณะ หน่วยนับ…"
            aria-label="ค้นหาสินค้าด่วน"
          />
        </form>

        <div className="top-right">
          {syncMsg ? (
            <span className="sync-toast">{syncMsg}</span>
          ) : updatedAtText ? (
            <span className="updated-lbl">{updatedAtText}</span>
          ) : null}

          <button
            type="button"
            className="btn-sync"
            onClick={handleSync}
            disabled={syncing}
            title="ดึงข้อมูลสินค้าล่าสุดจากฐานข้อมูล bcscanproduct"
          >
            {syncing ? "กำลังซิงก์…" : "↻ ซิงก์ DB"}
          </button>

          <button
            type="button"
            className="btn-cart-top"
            onClick={() => askNongTee(cart.itemCount > 0 ? "ขอดูตะกร้าสินค้าหน่อยครับ" : undefined)}
            title="ดูตะกร้าสินค้าและปิดการขายกับน้องตี๋"
          >
            <span>🛒 ตะกร้า</span>
            {cart.itemCount > 0 && (
              <span key={cart.itemCount} className="cart-top-badge mb-bump">
                {cart.itemCount} · {cart.grandTotalFormatted}
              </span>
            )}
          </button>

          {pathname !== "/" && (
            <button
              type="button"
              className="btn-javis-trigger"
              onClick={() => askNongTee()}
            >
              <span className="javis-online-dot" aria-hidden="true" />
              <span>🧑‍💼 คุยกับน้องตี๋</span>
            </button>
          )}
        </div>
      </header>

      {children && <div className="page-shell">{children}</div>}

      {/* Mobile-First Thumb Navigation Bar */}
      <nav className="mobile-bottom-nav" aria-label="เมนูด้านล่างสำหรับมือถือ">
        <Link href="/" className={`mb-nav-item mb-javis${pathname === "/" ? " active" : ""}`}>
          <span className="mb-ico">🧑‍💼</span>
          <span>
            น้องตี๋
            {cart.itemCount > 0 && (
              <>
                {" "}
                <span key={cart.itemCount} className="mb-count-bump">
                  ({cart.itemCount})
                </span>
              </>
            )}
          </span>
        </Link>
        <Link href="/search" className={`mb-nav-item${pathname.startsWith("/search") ? " active" : ""}`}>
          <span className="mb-ico">🔎</span>
          <span>ค้นหาสินค้า</span>
        </Link>
        <Link href="/brain" className={`mb-nav-item${pathname.startsWith("/brain") ? " active" : ""}`}>
          <span className="mb-ico">🧠</span>
          <span>สมอง 3D</span>
        </Link>
        <Link href="/n" className={`mb-nav-item${pathname.startsWith("/n") ? " active" : ""}`}>
          <span className="mb-ico">📚</span>
          <span>สารบัญ</span>
        </Link>
      </nav>
    </>
  );
}
