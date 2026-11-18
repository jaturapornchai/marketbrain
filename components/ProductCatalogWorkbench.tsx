"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatThaiBaht } from "@/lib/decimal-money";
import { toProductCard } from "@/lib/product-card";
import type { CategoryFacetNode, ProductSearchResult } from "@/lib/vault";
import DevicePickerPopover from "./DevicePickerPopover";
import { useJavis } from "./JavisContext";
import ProductVisionScanner, { identifyProductFromFile, type VisionLookupResult } from "./ProductVisionScanner";

type Props = {
  initialData: ProductSearchResult;
  initialParams: {
    q: string;
    category: string;
    brand: string;
    unit: string;
    traits: string[];
    source: string;
    minPrice: string;
    maxPrice: string;
    multiUnitOnly: boolean;
    thaiGs1Only: boolean;
    sort: "relevance" | "price_asc" | "price_desc" | "unit_price_asc" | "pack_desc";
    page: number;
  };
};

const QUICK_CHIPS = [
  { label: "🚫 ไม่ใส่ผงชูรส", q: "ไม่ใส่ผงชูรส" },
  { label: "☪️ ฮาลาล (Halal)", q: "ฮาลาล" },
  { label: "📦 หลายหน่วยนับ/ยกลัง", multiUnit: true },
  { label: "🇹🇭 บาร์โค้ดไทย 885", thaiGs1: true },
  { label: "🧴 บรรจุขวด", unit: "ขวด" },
  { label: "❄️ อาหารแช่แข็ง", q: "แช่แข็ง" },
];

export default function ProductCatalogWorkbench({ initialData, initialParams }: Props) {
  const router = useRouter();
  const { askNongTee, sendVisionToNongTee, promptAddToCart, lastAddedNotice } = useJavis();

  const [data, setData] = useState<ProductSearchResult>(initialData);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const [visionBanner, setVisionBanner] = useState<VisionLookupResult | null>(null);
  const [visionBusy, setVisionBusy] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState(initialParams.q);
  const [category, setCategory] = useState(initialParams.category);
  const [brand, setBrand] = useState(initialParams.brand);
  const [unit, setUnit] = useState(initialParams.unit);
  const [traits, setTraits] = useState<string[]>(initialParams.traits);
  const [source, setSource] = useState(initialParams.source);
  const [minPrice, setMinPrice] = useState(initialParams.minPrice);
  const [maxPrice, setMaxPrice] = useState(initialParams.maxPrice);
  const [multiUnitOnly, setMultiUnitOnly] = useState(initialParams.multiUnitOnly);
  const [thaiGs1Only, setThaiGs1Only] = useState(initialParams.thaiGs1Only);
  const [sort, setSort] = useState(initialParams.sort);
  const [page, setPage] = useState(initialParams.page);

  const runQuery = useCallback(
    async (next: Partial<Props["initialParams"]>) => {
      const merged = {
        q: next.q ?? q,
        category: next.category ?? category,
        brand: next.brand ?? brand,
        unit: next.unit ?? unit,
        traits: next.traits ?? traits,
        source: next.source ?? source,
        minPrice: next.minPrice ?? minPrice,
        maxPrice: next.maxPrice ?? maxPrice,
        multiUnitOnly: next.multiUnitOnly ?? multiUnitOnly,
        thaiGs1Only: next.thaiGs1Only ?? thaiGs1Only,
        sort: next.sort ?? sort,
        page: next.page ?? 1,
      };

      setQ(merged.q);
      setCategory(merged.category);
      setBrand(merged.brand);
      setUnit(merged.unit);
      setTraits(merged.traits);
      setSource(merged.source);
      setMinPrice(merged.minPrice);
      setMaxPrice(merged.maxPrice);
      setMultiUnitOnly(merged.multiUnitOnly);
      setThaiGs1Only(merged.thaiGs1Only);
      setSort(merged.sort);
      setPage(merged.page);

      const sp = new URLSearchParams();
      if (merged.q.trim()) sp.set("q", merged.q.trim());
      if (merged.category) sp.set("category", merged.category);
      if (merged.brand) sp.set("brand", merged.brand);
      if (merged.unit) sp.set("unit", merged.unit);
      if (merged.traits.length) sp.set("traits", merged.traits.join(","));
      if (merged.source) sp.set("source", merged.source);
      if (merged.minPrice) sp.set("minPrice", merged.minPrice);
      if (merged.maxPrice) sp.set("maxPrice", merged.maxPrice);
      if (merged.multiUnitOnly) sp.set("multiUnitOnly", "1");
      if (merged.thaiGs1Only) sp.set("thaiGs1Only", "1");
      if (merged.sort !== "relevance") sp.set("sort", merged.sort);
      if (merged.page > 1) sp.set("page", String(merged.page));
      sp.set("pageSize", "36");

      const qs = sp.toString();
      const cleanUrl = qs.replace(/&?pageSize=36/, "").replace(/^\?$/, "");
      window.history.replaceState(null, "", cleanUrl ? `/search?${cleanUrl}` : "/search");

      setLoading(true);
      try {
        const res = await fetch(`/api/products/search?${qs}`);
        if (res.ok) {
          const json = (await res.json()) as ProductSearchResult;
          setData(json);
        }
      } finally {
        setLoading(false);
      }
    },
    [q, category, brand, unit, traits, source, minPrice, maxPrice, multiUnitOnly, thaiGs1Only, sort],
  );

  useEffect(() => {
    setData(initialData);
    setQ(initialParams.q);
  }, [initialData, initialParams.q]);

  const applyVisionSearch = useCallback(
    (res: VisionLookupResult) => {
      setCameraModalOpen(false);
      setVisionBanner(res);
      if (res.matchedQuery) {
        void runQuery({
          q: res.matchedQuery,
          category: "",
          brand: "",
          unit: "",
          traits: [],
          page: 1,
        });
      }
    },
    [runQuery],
  );

  const handlePhotoFile = useCallback(
    async (file: File) => {
      if (visionBusy) return;
      setVisionBusy(true);
      try {
        const res = await identifyProductFromFile(file);
        if (res.ok && (res.cards.length > 0 || res.hasProduct)) {
          applyVisionSearch(res);
        }
      } finally {
        setVisionBusy(false);
      }
    },
    [applyVisionSearch, visionBusy],
  );

  // Ctrl+V paste image directly on /search -> instant product lookup!
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            void handlePhotoFile(f);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handlePhotoFile]);

  const resetAllFilters = () => {
    setVisionBanner(null);
    void runQuery({
      q: "",
      category: "",
      brand: "",
      unit: "",
      traits: [],
      source: "",
      minPrice: "",
      maxPrice: "",
      multiUnitOnly: false,
      thaiGs1Only: false,
      sort: "relevance",
      page: 1,
    });
  };

  const toggleTrait = (slug: string) => {
    const next = traits.includes(slug) ? traits.filter((x) => x !== slug) : [...traits, slug];
    void runQuery({ traits: next, page: 1 });
  };

  const activeFilterCount =
    (category ? 1 : 0) +
    (brand ? 1 : 0) +
    (unit ? 1 : 0) +
    traits.length +
    (source ? 1 : 0) +
    (minPrice || maxPrice ? 1 : 0) +
    (multiUnitOnly ? 1 : 0) +
    (thaiGs1Only ? 1 : 0);

  const renderCategoryTree = (nodes: CategoryFacetNode[]) => (
    <ul className="cat-tree">
      {nodes.map((n) => {
        const active = category === n.slug;
        return (
          <li key={n.slug}>
            <button
              type="button"
              className={`facet-row${active ? " active" : ""}`}
              onClick={() => void runQuery({ category: active ? "" : n.slug, page: 1 })}
            >
              <span className="facet-lbl">{n.label}</span>
              <span className="facet-cnt">{n.count}</span>
            </button>
            {n.children.length > 0 &&
              (active ||
                n.children.some((c) => c.slug === category || c.children.some((g) => g.slug === category))) && (
                <div className="cat-sub">{renderCategoryTree(n.children)}</div>
              )}
          </li>
        );
      })}
    </ul>
  );

  const filterPanelContent = (
    <div className="filter-sections">
      <div className="filter-head-row">
        <h3>ตัวกรองสมองสินค้า</h3>
        {(activeFilterCount > 0 || q.trim()) && (
          <button type="button" className="btn-reset-sm" onClick={resetAllFilters}>
            ล้างทั้งหมด
          </button>
        )}
      </div>

      <section className="f-box">
        <h4>ตัวเลือกพิเศษ</h4>
        <label className="f-check">
          <input
            type="checkbox"
            checked={multiUnitOnly}
            onChange={(e) => void runQuery({ multiUnitOnly: e.target.checked, page: 1 })}
          />
          <span>เฉพาะสินค้าหลายหน่วยนับ / แพ็ค-ลัง</span>
        </label>
        <label className="f-check">
          <input
            type="checkbox"
            checked={thaiGs1Only}
            onChange={(e) => void runQuery({ thaiGs1Only: e.target.checked, page: 1 })}
          />
          <span>เฉพาะบาร์โค้ดไทย GS1 (885)</span>
        </label>
      </section>

      <section className="f-box">
        <h4>ช่วงราคาขาย (บาท)</h4>
        <div className="price-inputs">
          <input
            type="number"
            inputMode="decimal"
            placeholder="ต่ำสุด"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            onBlur={() => void runQuery({ minPrice, page: 1 })}
          />
          <span>–</span>
          <input
            type="number"
            inputMode="decimal"
            placeholder="สูงสุด"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            onBlur={() => void runQuery({ maxPrice, page: 1 })}
          />
          <button type="button" className="btn-apply-price" onClick={() => void runQuery({ minPrice, maxPrice, page: 1 })}>
            กรอง
          </button>
        </div>
      </section>

      <section className="f-box">
        <h4>กลุ่มและหมวดหมู่สินค้า</h4>
        {renderCategoryTree(data.facets.categories)}
      </section>

      <section className="f-box">
        <h4>หน่วยนับสินค้า</h4>
        <div className="unit-pills">
          {data.facets.units.slice(0, 22).map((u) => {
            const active = unit === u.slug;
            return (
              <button
                key={u.slug}
                type="button"
                className={`u-pill${active ? " active" : ""}`}
                onClick={() => void runQuery({ unit: active ? "" : u.slug, page: 1 })}
              >
                <span>{u.label}</span>
                <small>{u.count}</small>
              </button>
            );
          })}
        </div>
      </section>

      <section className="f-box">
        <h4>คุณลักษณะเด่น (เลือกได้หลายข้อ)</h4>
        <div className="facet-scroll">
          {data.facets.traits.slice(0, 35).map((t) => {
            const active = traits.includes(t.slug);
            return (
              <button
                key={t.slug}
                type="button"
                className={`facet-row${active ? " active" : ""}`}
                onClick={() => toggleTrait(t.slug)}
              >
                <span className="facet-lbl">
                  {t.group ? <em className="trait-grp">{t.group}: </em> : null}
                  {t.label}
                </span>
                <span className="facet-cnt">{t.count}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="f-box">
        <h4>แบรนด์ / ยี่ห้อ</h4>
        <div className="facet-scroll">
          {data.facets.brands.slice(0, 35).map((b) => {
            const active = brand === b.slug;
            return (
              <button
                key={b.slug}
                type="button"
                className={`facet-row${active ? " active" : ""}`}
                onClick={() => void runQuery({ brand: active ? "" : b.slug, page: 1 })}
              >
                <span className="facet-lbl">{b.label}</span>
                <span className="facet-cnt">{b.count}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );

  return (
    <div className="wb-root">
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handlePhotoFile(f);
        }}
      />

      {lastAddedNotice && <div className="jc-toast">🛒 {lastAddedNotice}</div>}

      <section className="wb-hero">
        <div className="wb-head-row">
          <div>
            <h1>ค้นหาสินค้าแบบละเอียดเต็มจอ</h1>
            <p className="wb-sub">
              กรองครบทั้งกลุ่มสินค้า แบรนด์ คุณลักษณะ ส่วนผสม หน่วยนับ บาร์โค้ด หรือส่องกล้อง/อัปโหลดรูปสินค้าเพื่อค้นหาทันที
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <DevicePickerPopover
              buttonClassName="btn"
              onOpenCameraScanner={() => setCameraModalOpen(true)}
              onSelectPhotoFile={(f) => void handlePhotoFile(f)}
            />
            <button
              type="button"
              className="btn-ask-muay-banner"
              onClick={() =>
                askNongTee(
                  q.trim()
                    ? `ตี๋ ช่วยคัดและแนะนำสินค้าที่คุ้มที่สุดเกี่ยวกับ "${q.trim()}" ให้หน่อยครับ`
                    : undefined,
                )
              }
            >
              🧑‍💼 คุยกับน้องตี๋เพื่อเลือกและปิดการขาย
            </button>
          </div>
        </div>

        <form
          className="wb-search-bar"
          onSubmit={(e) => {
            e.preventDefault();
            void runQuery({ q, page: 1 });
          }}
        >
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="พิมพ์ชื่อสินค้า บาร์โค้ด 885... คุณลักษณะ แบรนด์ หรือกด 📷 ส่องรูปสินค้า…"
            aria-label="ค้นหาสินค้าแบบละเอียด"
          />
          <button
            type="button"
            className="wb-cam-btn"
            onClick={() => setCameraModalOpen(true)}
            title="เปิดกล้องส่องหาสินค้าทันที"
          >
            📷 กล้อง
          </button>
          <button
            type="button"
            className="wb-cam-btn"
            disabled={visionBusy}
            onClick={() => photoInputRef.current?.click()}
            title="อัปโหลดรูปสินค้าหรือวางรูป (Ctrl+V) เพื่อค้นหาทันที"
          >
            {visionBusy ? "กำลังค้นรูป…" : "🖼️ รูปสินค้า"}
          </button>
          <button type="submit" className="wb-search-btn">
            ค้นหา
          </button>
          <button type="button" className="wb-mobile-filter-btn" onClick={() => setMobileFilterOpen(true)}>
            ⚙️ ตัวกรอง {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
          </button>
        </form>

        <div className="wb-quick-strip" role="group" aria-label="ทางลัดกรองด่วน">
          {QUICK_CHIPS.map((ch) => (
            <button
              key={ch.label}
              type="button"
              className="wb-qchip"
              onClick={() => {
                if (ch.q) void runQuery({ q: ch.q, page: 1 });
                else if (ch.multiUnit) void runQuery({ multiUnitOnly: !multiUnitOnly, page: 1 });
                else if (ch.thaiGs1) void runQuery({ thaiGs1Only: !thaiGs1Only, page: 1 });
                else if (ch.unit) void runQuery({ unit: unit === ch.unit ? "" : ch.unit, page: 1 });
              }}
            >
              {ch.label}
            </button>
          ))}
        </div>

        {visionBanner && (
          <div className="wb-vision-banner">
            <img src={visionBanner.snapshotDataUrl} alt="รูปที่ค้นหา" className="wb-vision-thumb" />
            <div className="wb-vision-meta">
              <strong>
                📷 ผลส่องรูปสินค้า: {visionBanner.detected.summaryTh || visionBanner.matchedQuery}
              </strong>
              <span className="muted">
                คำค้นที่ใช้จับคู่: <code>{visionBanner.matchedQuery}</code> · พบ {visionBanner.cards.length} รายการตรงในสมอง ({visionBanner.ms} ms)
              </span>
            </div>
            <div className="wb-vision-acts">
              {visionBanner.cards.length > 0 && (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    const desc = visionBanner.detected.summaryTh || visionBanner.matchedQuery;
                    sendVisionToNongTee({
                      prompt: `ลูกค้าส่งรูปสินค้า (${desc}) ช่วยสรุปราคา หน่วยนับ และถามจำนวนใส่ตะกร้าให้เลยครับ`,
                      visionSlugs: visionBanner.cards.map((c) => c.slug),
                      visionSummary: desc,
                      imagePreview: visionBanner.snapshotDataUrl,
                      cards: visionBanner.cards,
                    });
                  }}
                >
                  🧑‍💼 ส่งให้น้องตี๋ปิดการขาย
                </button>
              )}
              <button type="button" className="btn-reset-sm" onClick={() => setVisionBanner(null)}>
                ซ่อนแถบรูป
              </button>
            </div>
          </div>
        )}
      </section>

      <div className="wb-layout">
        <aside className="wb-sidebar">{filterPanelContent}</aside>

        <main className="wb-main">
          <div className="wb-toolbar">
            <div className="wb-count">
              พบสินค้า <strong>{data.total.toLocaleString("th-TH")}</strong> รายการ
              {loading && <span className="wb-loading-tag">กำลังกรอง…</span>}
            </div>

            <div className="wb-controls">
              <select
                value={sort}
                onChange={(e) =>
                  void runQuery({
                    sort: e.target.value as Props["initialParams"]["sort"],
                    page: 1,
                  })
                }
                aria-label="เรียงลำดับสินค้า"
                className="wb-sort"
              >
                <option value="relevance">เรียง: ตรงคำค้นที่สุด</option>
                <option value="price_asc">ราคาขาย: ต่ำ → สูง</option>
                <option value="price_desc">ราคาขาย: สูง → ต่ำ</option>
                <option value="unit_price_asc">คุ้มค่า: ราคาต่อหน่วยย่อยต่ำสุด</option>
                <option value="pack_desc">ขนาดบรรจุ: ยกลัง/แพ็คใหญ่ก่อน</option>
              </select>

              <div className="wb-view-toggle" role="group" aria-label="สลับมุมมอง">
                <button type="button" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}>
                  การ์ด
                </button>
                <button type="button" aria-pressed={viewMode === "table"} onClick={() => setViewMode("table")}>
                  ตาราง
                </button>
              </div>
            </div>
          </div>

          {data.items.length === 0 ? (
            <div className="wb-empty">
              <p>ไม่พบสินค้าที่ตรงกับตัวกรองปัจจุบันครับ</p>
              <div className="wb-empty-actions">
                <button type="button" className="btn primary" onClick={resetAllFilters}>
                  ล้างตัวกรองทั้งหมด
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => askNongTee(`ตี๋ ช่วยหาสินค้าใกล้เคียงกับ "${q || "สินค้าขายดี"}" ในสมองให้หน่อยครับ`)}
                >
                  🧑‍💼 ให้น้องตี๋ช่วยค้นหลายมุม
                </button>
              </div>
            </div>
          ) : viewMode === "grid" ? (
            <div className="prod-grid">
              {data.items.map((p) => {
                const pCard = toProductCard(p);
                return (
                  <article key={p.slug} className="p-card">
                    <Link href={`/n/${encodeURIComponent(p.slug)}`} className="p-img-wrap">
                      {p.imageUrl ? (
                        <img src={p.imageUrl} alt={p.nameTh} loading="lazy" />
                      ) : (
                        <div className="p-noimg">📦</div>
                      )}
                      {p.unitConversions.length > 1 && (
                        <span className="p-multi-badge">{p.unitConversions.length} หน่วยนับ</span>
                      )}
                    </Link>

                    <div className="p-body">
                      <div className="p-meta-top">
                        <span className="p-brand">{p.brandTh || p.brandEn || "ทั่วไป"}</span>
                        <span className="p-unit-chip">
                          {p.unitCode}
                          {p.packQty > 1 ? ` ×${p.packQty}` : ""}
                        </span>
                      </div>

                      <Link href={`/n/${encodeURIComponent(p.slug)}`} className="p-title">
                        {p.nameTh}
                      </Link>

                      <p className="p-cat">{p.categoryPathTh}</p>

                      <div className="p-price-row">
                        <span className="p-price">{formatThaiBaht(p.bestPrice)}</span>
                        <span className="p-per-unit">/{p.unitCode}</span>
                        {p.pricePerBaseUnit && p.packQty > 1 && (
                          <span className="p-base-calc">
                            (เฉลี่ย {formatThaiBaht(p.pricePerBaseUnit)}/{p.baseUnitCode})
                          </span>
                        )}
                      </div>

                      {p.primaryBarcode && (
                        <div className="p-bc-row">
                          <code>{p.primaryBarcode}</code>
                          {p.isThaiGs1 && <span className="p-gs1">GS1 ไทย</span>}
                        </div>
                      )}

                      {pCard.traits.length > 0 && (
                        <div className="p-traits">
                          {pCard.traits.slice(0, 3).map((tr, ti) => (
                            <span key={`${tr}-${ti}`} className="p-trait-tag">
                              {tr}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="p-foot">
                        <button
                          type="button"
                          className="p-btn-muay"
                          onClick={() => promptAddToCart(pCard)}
                        >
                          🛒 ใส่ตะกร้า
                        </button>
                        <Link href={`/n/${encodeURIComponent(p.slug)}`} className="p-btn-detail">
                          รายละเอียด
                        </Link>
                        <button
                          type="button"
                          className="p-btn-3d"
                          onClick={() => router.push(`/brain?focus=${encodeURIComponent(p.slug)}`)}
                          title="ดูการเชื่อมโยงในสมอง 3D"
                        >
                          🧠
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="p-table-wrap">
              <table className="p-table">
                <thead>
                  <tr>
                    <th>สินค้า</th>
                    <th>แบรนด์ / กลุ่ม</th>
                    <th>หน่วยนับ & บรรจุ</th>
                    <th className="num">ราคาขาย</th>
                    <th className="num">เฉลี่ย/หน่วยย่อย</th>
                    <th>คุณลักษณะเด่น</th>
                    <th>สั่งซื้อ / ดู</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p) => {
                    const pCard = toProductCard(p);
                    return (
                      <tr key={p.slug}>
                        <td>
                          <div className="pt-prod">
                            {p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" />}
                            <div>
                              <Link href={`/n/${encodeURIComponent(p.slug)}`}>{p.nameTh}</Link>
                              {p.primaryBarcode && <div className="pt-bc">#{p.primaryBarcode}</div>}
                            </div>
                          </div>
                        </td>
                        <td>
                          <b>{p.brandTh || p.brandEn || "-"}</b>
                          <div className="pt-sub">{p.categoryLevelsTh.slice(0, 2).join(" > ")}</div>
                        </td>
                        <td>
                          <span className="p-unit-chip">{p.unitCode}</span>
                          {p.packQty > 1 && (
                            <div className="pt-sub">
                              บรรจุ {p.packQty} {p.baseUnitCode}
                            </div>
                          )}
                        </td>
                        <td className="num">
                          <strong>{formatThaiBaht(p.bestPrice)}</strong>
                        </td>
                        <td className="num">{formatThaiBaht(p.pricePerBaseUnit)}</td>
                        <td>
                          <div className="p-traits">
                            {pCard.traits.slice(0, 3).map((tr, ti) => (
                              <span key={`${tr}-${ti}`} className="p-trait-tag">
                                {tr}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>
                          <div className="pt-acts">
                            <button type="button" className="p-btn-muay" onClick={() => promptAddToCart(pCard)}>
                              🛒 ใส่ตะกร้า
                            </button>
                            <Link href={`/n/${encodeURIComponent(p.slug)}`} className="p-btn-detail">
                              เปิดดู
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {data.totalPages > 1 && (
            <div className="wb-pager">
              <button
                type="button"
                className="btn-page"
                disabled={page <= 1}
                onClick={() => void runQuery({ page: page - 1 })}
              >
                ‹ หน้าก่อน
              </button>
              <span>
                หน้า <b>{data.page}</b> / {data.totalPages}
              </span>
              <button
                type="button"
                className="btn-page"
                disabled={page >= data.totalPages}
                onClick={() => void runQuery({ page: page + 1 })}
              >
                หน้าถัดไป ›
              </button>
            </div>
          )}
        </main>
      </div>

      {cameraModalOpen && (
        <div className="qty-backdrop" onClick={(e) => e.target === e.currentTarget && setCameraModalOpen(false)}>
          <div className="qty-modal" style={{ maxWidth: 680 }}>
            <ProductVisionScanner
              onProductFound={applyVisionSearch}
              onClose={() => setCameraModalOpen(false)}
            />
          </div>
        </div>
      )}

      {mobileFilterOpen && (
        <div className="mf-backdrop" onClick={(e) => e.target === e.currentTarget && setMobileFilterOpen(false)}>
          <div className="mf-sheet">
            <div className="mf-sheet-head">
              <h3>ตัวกรองสินค้าแบบละเอียด</h3>
              <button type="button" className="jm-close-btn" onClick={() => setMobileFilterOpen(false)}>
                ✕
              </button>
            </div>
            <div className="mf-sheet-body">{filterPanelContent}</div>
            <div className="mf-sheet-foot">
              <button type="button" className="btn primary mf-done-btn" onClick={() => setMobileFilterOpen(false)}>
                ดูผลลัพธ์ ({data.total.toLocaleString("th-TH")} รายการ)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
