"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { formatThaiBaht } from "@/lib/decimal-money";
import { DIETARY_TAGS, type DietaryTagId } from "@/lib/dietary-shield";
import { toProductCard } from "@/lib/product-card";
import type { SearchScope } from "@/lib/smart-search";
import type { CategoryFacetNode, ProductSearchResult, ProductSuggestionResponse } from "@/lib/vault";
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
    exclude: string;
    badges: string[];
    dietary: DietaryTagId[];
    scope: SearchScope;
    noAutoCorrect: boolean;
    sort: "relevance" | "price_asc" | "price_desc" | "unit_price_asc" | "pack_desc";
    page: number;
  };
};

type QuickChip =
  | { label: string; badge: string }
  | { label: string; multiUnit: true }
  | { label: string; thaiGs1: true };

const QUICK_CHIPS: readonly QuickChip[] = [
  { label: "🛡️ มี อ.ย.", badge: "fda" },
  { label: "💊 ยา", badge: "med" },
  { label: "🏛️ มอก.", badge: "tis" },
  { label: "☪️ ฮาลาล", badge: "halal" },
  { label: "🌿 ไร้ผงชูรส", badge: "no_msg" },
  { label: "🥬 เจ/วีแกน", badge: "veg" },
  { label: "🐾 สัตว์เลี้ยง", badge: "pet" },
  { label: "⚡ ไฟฟ้า", badge: "elec" },
  { label: "❄️ แช่แข็ง", badge: "frozen" },
  { label: "📦 หลายหน่วยนับ", multiUnit: true },
  { label: "🇹🇭 บาร์โค้ดไทย 885", thaiGs1: true },
];

const SCOPE_TABS: ReadonlyArray<{ id: SearchScope; label: string }> = [
  { id: "all", label: "ทั้งหมด" },
  { id: "title", label: "ชื่อ & แบรนด์" },
  { id: "code", label: "บาร์โค้ด / รหัส / อ.ย." },
  { id: "ingredients", label: "ส่วนผสม & สเปก" },
];

const PRICE_PRESETS = [
  { label: "≤ ฿50", min: "", max: "50" },
  { label: "฿50–200", min: "50", max: "200" },
  { label: "฿200–1,000", min: "200", max: "1000" },
  { label: "> ฿1,000", min: "1000", max: "" },
] as const;

const SMART_EXAMPLES = [
  "สว่านมากิต้า งบ 2000",
  "น้ำปลา -ทิพรส ราคาถูกสุด",
  "fish sauce",
  "20-1-6500032418",
] as const;

const RECENT_STORAGE_KEY = "mb_recent_searches_v1";

function downsampleTo16k(chunks: Float32Array[], sampleRate: number): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  if (sampleRate === 16000 || total === 0) return merged;
  const ratio = sampleRate / 16000;
  const outLen = Math.max(1, Math.floor(total / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(total - 1, i0 + 1);
    const frac = idx - i0;
    out[i] = merged[i0] * (1 - frac) + merged[i1] * frac;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightText({ text, terms }: { text: string; terms: string[] }) {
  const cleanTerms = useMemo(
    () =>
      [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2 && !t.startsWith("sz_")))]
        .sort((a, b) => b.length - a.length)
        .slice(0, 6),
    [terms],
  );
  if (!cleanTerms.length || !text) return <>{text}</>;
  const re = new RegExp(`(${cleanTerms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(re);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, idx) =>
        idx % 2 === 1 ? (
          <mark key={idx} className="wb-hl">
            {part}
          </mark>
        ) : (
          <Fragment key={idx}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export default function ProductCatalogWorkbench({ initialData, initialParams }: Props) {
  const router = useRouter();
  const {
    askNongTee,
    sendVisionToNongTee,
    promptAddToCart,
    lastAddedNotice,
    dietaryTags: globalDietaryTags,
    micDeviceId,
  } = useJavis();

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
  const [exclude, setExclude] = useState(initialParams.exclude);
  const [excludeInput, setExcludeInput] = useState(initialParams.exclude);
  const [badges, setBadges] = useState<string[]>(initialParams.badges);
  const [dietary, setDietary] = useState<DietaryTagId[]>(initialParams.dietary);
  const [scope, setScope] = useState<SearchScope>(initialParams.scope);
  const [noAutoCorrect, setNoAutoCorrect] = useState(initialParams.noAutoCorrect);
  const [sort, setSort] = useState(initialParams.sort);
  const [page, setPage] = useState(initialParams.page);

  const [brandFilterText, setBrandFilterText] = useState("");
  const [traitFilterText, setTraitFilterText] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ProductSuggestionResponse | null>(null);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceNote, setVoiceNote] = useState("");

  const searchWrapRef = useRef<HTMLDivElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const stopVoiceRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RECENT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setRecentSearches(parsed.filter((x) => typeof x === "string").slice(0, 6));
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  const recordRecentSearch = useCallback((term: string) => {
    const clean = term.trim();
    if (clean.length < 2) return;
    setRecentSearches((prev) => {
      const next = [clean, ...prev.filter((x) => x.toLowerCase() !== clean.toLowerCase())].slice(0, 6);
      try {
        window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

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
        exclude: next.exclude ?? exclude,
        badges: next.badges ?? badges,
        dietary: next.dietary ?? dietary,
        scope: next.scope ?? scope,
        noAutoCorrect: next.noAutoCorrect ?? false,
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
      setExclude(merged.exclude);
      setExcludeInput(merged.exclude);
      setBadges(merged.badges);
      setDietary(merged.dietary);
      setScope(merged.scope);
      setNoAutoCorrect(merged.noAutoCorrect);
      setSort(merged.sort);
      setPage(merged.page);
      setSuggestOpen(false);
      if (merged.q.trim()) recordRecentSearch(merged.q);

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
      if (merged.exclude.trim()) sp.set("exclude", merged.exclude.trim());
      if (merged.badges.length) sp.set("badges", merged.badges.join(","));
      if (merged.dietary.length) sp.set("dietary", merged.dietary.join(","));
      if (merged.scope !== "all") sp.set("scope", merged.scope);
      if (merged.noAutoCorrect) sp.set("noAutoCorrect", "1");
      if (merged.sort !== "relevance") sp.set("sort", merged.sort);
      if (merged.page > 1) sp.set("page", String(merged.page));
      sp.set("pageSize", "36");

      const qs = sp.toString();
      const cleanUrl = qs.replace(/&?pageSize=36/, "").replace(/^\?$/, "");
      window.history.replaceState(null, "", cleanUrl ? `/search?${cleanUrl}` : "/search");

      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setLoading(true);
      try {
        const res = await fetch(`/api/products/search?${qs}`, { signal: controller.signal });
        if (res.ok && searchAbortRef.current === controller) {
          const json = (await res.json()) as ProductSearchResult;
          setData(json);
        }
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") {
          // Preserve current view on transient fetch abort/network errors
        }
      } finally {
        if (searchAbortRef.current === controller) {
          setLoading(false);
        }
      }
    },
    [
      q,
      category,
      brand,
      unit,
      traits,
      source,
      minPrice,
      maxPrice,
      multiUnitOnly,
      thaiGs1Only,
      exclude,
      badges,
      dietary,
      scope,
      sort,
      recordRecentSearch,
    ],
  );

  useEffect(() => {
    setData(initialData);
    setQ(initialParams.q);
    setExclude(initialParams.exclude);
    setExcludeInput(initialParams.exclude);
    setBadges(initialParams.badges);
    setDietary(initialParams.dietary);
    setScope(initialParams.scope);
    setNoAutoCorrect(initialParams.noAutoCorrect);
  }, [initialData, initialParams]);

  // Debounced live autocomplete suggestions
  useEffect(() => {
    if (!suggestOpen) return;
    const trimmed = q.trim();
    if (!trimmed) {
      setSuggestions(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      suggestAbortRef.current?.abort();
      const controller = new AbortController();
      suggestAbortRef.current = controller;
      try {
        const res = await fetch(`/api/products/suggest?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (res.ok && suggestAbortRef.current === controller) {
          const json = (await res.json()) as ProductSuggestionResponse;
          setSuggestions(json);
        }
      } catch {
        // Ignore aborted suggest calls
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [q, suggestOpen]);

  // Close autocomplete on outside click
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setSuggestOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const toggleVoiceSearch = useCallback(async () => {
    if (voiceListening) {
      stopVoiceRef.current?.();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceNote("เบราว์เซอร์นี้ไม่รองรับไมโครโฟนครับ");
      return;
    }
    setVoiceNote("กำลังฟังเสียงพูด… กดอีกครั้งเพื่อส่งคำค้น");
    setVoiceListening(true);

    let stopped = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
      });
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      proc.onaudioprocess = (ev) => {
        if (stopped) return;
        chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(ctx.destination);

      const finish = async () => {
        if (stopped) return;
        stopped = true;
        window.clearTimeout(autoStopTimer);
        stopVoiceRef.current = null;
        setVoiceListening(false);
        proc.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        const sr = ctx.sampleRate || 16000;
        void ctx.close();

        const pcm = downsampleTo16k(chunks, sr);
        if (pcm.length < 1600) {
          setVoiceNote("ไม่ได้ยินเสียงชัดเจน ลองพูดอีกครั้งครับ");
          return;
        }
        setVoiceNote("กำลังถอดเสียงภาษาไทย…");
        try {
          const buf = new ArrayBuffer(pcm.byteLength);
          new Float32Array(buf).set(pcm);
          const res = await fetch("/api/voice/stt", {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-sample-rate": "16000",
              "x-audio-format": "f32le",
              "x-skip-echo-guard": "1",
            },
            body: buf,
          });
          if (res.ok) {
            const payload = (await res.json()) as { text?: string };
            const heard = (payload.text ?? "").trim();
            if (heard) {
              setVoiceNote(`ได้ยินว่า: "${heard}"`);
              void runQuery({ q: heard, page: 1 });
              return;
            }
          }
          setVoiceNote("ยังไม่พบคำค้นจากเสียง ลองพูดช้าๆ ใกล้ไมค์ครับ");
        } catch {
          setVoiceNote("ถอดเสียงไม่สำเร็จ กรุณาลองใหม่");
        }
      };

      const autoStopTimer = window.setTimeout(() => void finish(), 5500);
      stopVoiceRef.current = () => void finish();
    } catch {
      setVoiceListening(false);
      setVoiceNote("เปิดไมโครโฟนไม่ได้ กรุณาอนุญาตสิทธิ์ไมค์ครับ");
    }
  }, [micDeviceId, runQuery, voiceListening]);

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
    setBrandFilterText("");
    setTraitFilterText("");
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
      exclude: "",
      badges: [],
      dietary: [],
      scope: "all",
      noAutoCorrect: false,
      sort: "relevance",
      page: 1,
    });
  };

  const toggleTrait = (slug: string) => {
    const next = traits.includes(slug) ? traits.filter((x) => x !== slug) : [...traits, slug];
    void runQuery({ traits: next, page: 1 });
  };

  const toggleBadge = (id: string) => {
    const next = badges.includes(id) ? badges.filter((x) => x !== id) : [...badges, id];
    void runQuery({ badges: next, page: 1 });
  };

  const toggleDietary = (id: DietaryTagId) => {
    const next = dietary.includes(id) ? dietary.filter((x) => x !== id) : [...dietary, id];
    void runQuery({ dietary: next, page: 1 });
  };

  const activeFilterCount =
    (category ? 1 : 0) +
    (brand ? 1 : 0) +
    (unit ? 1 : 0) +
    traits.length +
    badges.length +
    dietary.length +
    (exclude.trim() ? 1 : 0) +
    (scope !== "all" ? 1 : 0) +
    (source ? 1 : 0) +
    (minPrice || maxPrice ? 1 : 0) +
    (multiUnitOnly ? 1 : 0) +
    (thaiGs1Only ? 1 : 0);

  const highlightTerms = useMemo(() => {
    const list = [...data.appliedTerms];
    for (const pair of data.bilingualPairs ?? []) {
      list.push(pair.from, pair.to);
    }
    const cleanQ = (data.correctedTo ?? q).trim();
    if (cleanQ && !cleanQ.includes("-") && !/\s/.test(cleanQ)) list.push(cleanQ);
    return list;
  }, [data.appliedTerms, data.bilingualPairs, data.correctedTo, q]);

  const filteredBrands = useMemo(() => {
    const kw = brandFilterText.trim().toLowerCase();
    if (!kw) return data.facets.brands.slice(0, 35);
    return data.facets.brands.filter((b) => b.label.toLowerCase().includes(kw) || b.slug.includes(kw));
  }, [brandFilterText, data.facets.brands]);

  const filteredTraits = useMemo(() => {
    const kw = traitFilterText.trim().toLowerCase();
    if (!kw) return data.facets.traits.slice(0, 35);
    return data.facets.traits.filter(
      (t) => t.label.toLowerCase().includes(kw) || (t.group ?? "").toLowerCase().includes(kw),
    );
  }, [traitFilterText, data.facets.traits]);

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

      {data.facets.badges.length > 0 && (
        <section className="f-box">
          <h4>ป้ายมาตรฐาน & ประเภทสินค้า</h4>
          <div className="wb-badge-pills">
            {data.facets.badges.map((bf) => {
              const active = badges.includes(bf.id);
              return (
                <button
                  key={bf.id}
                  type="button"
                  className={`u-pill${active ? " active" : ""}`}
                  onClick={() => toggleBadge(bf.id)}
                >
                  <span>
                    {bf.icon} {bf.label}
                  </span>
                  <small>{bf.count.toLocaleString("th-TH")}</small>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="f-box">
        <div className="filter-head-row">
          <h4>เกราะสุขภาพ & แพ้อาหาร</h4>
          {globalDietaryTags.length > 0 && (
            <button
              type="button"
              className="btn-link-sm"
              onClick={() => void runQuery({ dietary: [...globalDietaryTags], page: 1 })}
            >
              ใช้เกราะของฉัน
            </button>
          )}
        </div>
        <div className="wb-dietary-list">
          {DIETARY_TAGS.map((dt) => (
            <label key={dt.id} className="f-check">
              <input
                type="checkbox"
                checked={dietary.includes(dt.id)}
                onChange={() => toggleDietary(dt.id)}
              />
              <span>
                {dt.icon} {dt.label}
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="f-box">
        <h4>ตัดคำที่ไม่ต้องการออก</h4>
        <div className="price-inputs">
          <input
            type="text"
            placeholder="เช่น ทิพรส น้ำตาล หมู"
            value={excludeInput}
            onChange={(e) => setExcludeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runQuery({ exclude: excludeInput, page: 1 });
              }
            }}
          />
          <button
            type="button"
            className="btn-apply-price"
            onClick={() => void runQuery({ exclude: excludeInput, page: 1 })}
          >
            ตัดออก
          </button>
        </div>
      </section>

      <section className="f-box">
        <h4>ช่วงราคาขาย (บาท)</h4>
        <div className="wb-price-presets">
          {PRICE_PRESETS.map((pr) => {
            const active = minPrice === pr.min && maxPrice === pr.max;
            return (
              <button
                key={pr.label}
                type="button"
                className={`u-pill${active ? " active" : ""}`}
                onClick={() =>
                  void runQuery({
                    minPrice: active ? "" : pr.min,
                    maxPrice: active ? "" : pr.max,
                    page: 1,
                  })
                }
              >
                {pr.label}
              </button>
            );
          })}
        </div>
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
        <input
          type="search"
          className="wb-facet-search"
          placeholder="กรองชื่อคุณลักษณะ…"
          value={traitFilterText}
          onChange={(e) => setTraitFilterText(e.target.value)}
        />
        <div className="facet-scroll">
          {filteredTraits.map((t) => {
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
        <input
          type="search"
          className="wb-facet-search"
          placeholder="กรองชื่อแบรนด์…"
          value={brandFilterText}
          onChange={(e) => setBrandFilterText(e.target.value)}
        />
        <div className="facet-scroll">
          {filteredBrands.map((b) => {
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
              รองรับค้นสองภาษา ไทย ↔ อังกฤษ, บาร์โค้ด/เลข อ.ย., พิมพ์ผิด/ลืมสลับแป้นภาษา, งบราคา (-ตัดคำออก), เกราะสุขภาพ และพูด/ส่องรูปค้นหาทันที
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

        <div ref={searchWrapRef} className="wb-search-wrap">
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
              onFocus={() => setSuggestOpen(true)}
              onChange={(e) => {
                setQ(e.target.value);
                setSuggestOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSuggestOpen(false);
              }}
              placeholder="พิมพ์ชื่อไทย/อังกฤษ บาร์โค้ด เลข อ.ย. งบราคา (-ตัดคำ) หรือกด 🎤 พูด / 📷 ส่องรูป…"
              aria-label="ค้นหาสินค้าแบบละเอียด"
            />
            <button
              type="button"
              className={`wb-cam-btn wb-voice-btn${voiceListening ? " listening" : ""}`}
              onClick={() => void toggleVoiceSearch()}
              title="พูดภาษาไทยเพื่อค้นหาสินค้าทันที"
            >
              {voiceListening ? "⏹️ หยุดพูด" : "🎤 พูดค้นหา"}
            </button>
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

          {suggestOpen && (
            <div className="wb-suggest-pop" role="listbox" aria-label="คำแนะนำการค้นหา">
              {!q.trim() ? (
                <>
                  {recentSearches.length > 0 && (
                    <div className="wb-sug-sec">
                      <div className="wb-sug-title">ค้นหาล่าสุด</div>
                      <div className="wb-sug-pills">
                        {recentSearches.map((rs) => (
                          <button
                            key={rs}
                            type="button"
                            className="wb-sug-pill"
                            onClick={() => void runQuery({ q: rs, page: 1 })}
                          >
                            🕒 {rs}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="wb-sug-sec">
                    <div className="wb-sug-title">ตัวอย่างคำค้นอัจฉริยะ (ลองคลิกได้)</div>
                    <div className="wb-sug-pills">
                      {SMART_EXAMPLES.map((ex) => (
                        <button
                          key={ex}
                          type="button"
                          className="wb-sug-pill"
                          onClick={() => void runQuery({ q: ex, page: 1 })}
                        >
                          ⚡ {ex}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {suggestions?.queries.length ? (
                    <div className="wb-sug-sec">
                      <div className="wb-sug-title">
                        {suggestions.flippedQuery ? "⌨️ แปลงแป้นภาษา / คำแนะนำ" : "คำค้นที่เกี่ยวข้อง"}
                      </div>
                      <div className="wb-sug-pills">
                        {suggestions.queries.map((sq) => (
                          <button
                            key={sq}
                            type="button"
                            className="wb-sug-pill"
                            onClick={() => void runQuery({ q: sq, page: 1 })}
                          >
                            🔎 {sq}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {suggestions?.brands.length ? (
                    <div className="wb-sug-sec">
                      <div className="wb-sug-title">แบรนด์ที่ตรงคำค้น</div>
                      <div className="wb-sug-pills">
                        {suggestions.brands.map((br) => (
                          <button
                            key={br.slug}
                            type="button"
                            className="wb-sug-pill"
                            onClick={() => void runQuery({ q: "", brand: br.slug, page: 1 })}
                          >
                            🏷️ {br.label} ({br.count})
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {suggestions?.categories.length ? (
                    <div className="wb-sug-sec">
                      <div className="wb-sug-title">หมวดหมู่ที่ตรงคำค้น</div>
                      <div className="wb-sug-pills">
                        {suggestions.categories.map((ct) => (
                          <button
                            key={ct.slug}
                            type="button"
                            className="wb-sug-pill"
                            onClick={() => void runQuery({ q: "", category: ct.slug, page: 1 })}
                          >
                            📂 {ct.label} ({ct.count})
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {suggestions?.products.length ? (
                    <div className="wb-sug-sec">
                      <div className="wb-sug-title">สินค้าตรงคำค้น (กดดูหรือเลือกซื้อทันที)</div>
                      <div className="wb-sug-prods">
                        {suggestions.products.map((sp) => (
                          <Link
                            key={sp.slug}
                            href={`/n/${encodeURIComponent(sp.slug)}`}
                            className="wb-sug-prod"
                            onClick={() => setSuggestOpen(false)}
                          >
                            {sp.imageUrl ? <img src={sp.imageUrl} alt="" /> : <span className="wb-sug-noimg">📦</span>}
                            <span className="wb-sug-pinfo">
                              <b>{sp.nameTh}</b>
                              <small>
                                {sp.brandTh || "ทั่วไป"}
                                {sp.primaryBarcode ? ` · ${sp.primaryBarcode}` : ""}
                              </small>
                            </span>
                            <span className="wb-sug-price">
                              {formatThaiBaht(sp.bestPrice)}/{sp.unitCode}
                            </span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {suggestions &&
                    !suggestions.queries.length &&
                    !suggestions.brands.length &&
                    !suggestions.categories.length &&
                    !suggestions.products.length && (
                      <div className="wb-sug-empty">ไม่พบคำแนะนำตรงๆ — กด Enter เพื่อค้นหาและแก้คำผิดอัตโนมัติครับ</div>
                    )}
                </>
              )}
            </div>
          )}
        </div>

        {voiceNote && <div className="wb-voice-status">{voiceNote}</div>}

        <div className="wb-scope-bar" role="group" aria-label="ขอบเขตการค้นหา">
          <span className="wb-scope-lbl">ค้นใน:</span>
          {SCOPE_TABS.map((sc) => (
            <button
              key={sc.id}
              type="button"
              className={`wb-scope-pill${scope === sc.id ? " active" : ""}`}
              onClick={() => void runQuery({ scope: sc.id, page: 1 })}
            >
              {sc.label}
            </button>
          ))}
        </div>

        <div className="wb-quick-strip" role="group" aria-label="ทางลัดกรองด่วน">
          {QUICK_CHIPS.map((ch) => {
            const isActive =
              ("badge" in ch && badges.includes(ch.badge)) ||
              ("multiUnit" in ch && multiUnitOnly) ||
              ("thaiGs1" in ch && thaiGs1Only);
            return (
              <button
                key={ch.label}
                type="button"
                aria-pressed={isActive}
                className={`wb-qchip${isActive ? " active" : ""}`}
                onClick={() => {
                  if ("badge" in ch) toggleBadge(ch.badge);
                  else if ("multiUnit" in ch) void runQuery({ multiUnitOnly: !multiUnitOnly, page: 1 });
                  else if ("thaiGs1" in ch) void runQuery({ thaiGs1Only: !thaiGs1Only, page: 1 });
                }}
              >
                {ch.label}
              </button>
            );
          })}
        </div>

        {data.correctedTo && (
          <div className="wb-corr-banner">
            <span>
              {data.correctionReason === "keyboard_layout"
                ? `⌨️ ดูเหมือนลืมเปลี่ยนแป้นภาษา: แสดงผลคำว่า "${data.correctedTo}" แทน "${data.correctedFrom}"`
                : `✨ แก้คำสะกดอัตโนมัติ: แสดงผล "${data.correctedTo}" แทน "${data.correctedFrom}"`}
            </span>
            {data.didYouMean?.map((alt) => (
              <button key={alt} type="button" className="btn-link-sm" onClick={() => void runQuery({ q: alt, page: 1 })}>
                ลอง “{alt}”
              </button>
            ))}
            {data.correctedFrom && (
              <button
                type="button"
                className="btn-reset-sm"
                onClick={() => void runQuery({ q: data.correctedFrom, noAutoCorrect: true, page: 1 })}
              >
                ค้น “{data.correctedFrom}” ตามเดิม
              </button>
            )}
          </div>
        )}

        {(activeFilterCount > 0 || data.parsedHints?.length || data.bilingualPairs?.length) && (
          <div className="wb-active-bar">
            {data.bilingualPairs?.map((bp) => (
              <span key={`${bp.from}-${bp.to}`} className="wb-hint-pill">
                🌐 {bp.from} ↔ {bp.to}
              </span>
            ))}
            {data.parsedHints?.map((h) => (
              <span key={h} className="wb-hint-pill">
                ⚡ {h}
              </span>
            ))}
            {scope !== "all" && (
              <button type="button" className="wb-chip-rm" onClick={() => void runQuery({ scope: "all", page: 1 })}>
                ขอบเขต: {SCOPE_TABS.find((s) => s.id === scope)?.label} ✕
              </button>
            )}
            {category && (
              <button type="button" className="wb-chip-rm" onClick={() => void runQuery({ category: "", page: 1 })}>
                หมวด: {category} ✕
              </button>
            )}
            {brand && (
              <button type="button" className="wb-chip-rm" onClick={() => void runQuery({ brand: "", page: 1 })}>
                แบรนด์: {brand} ✕
              </button>
            )}
            {unit && (
              <button type="button" className="wb-chip-rm" onClick={() => void runQuery({ unit: "", page: 1 })}>
                หน่วย: {unit} ✕
              </button>
            )}
            {badges.map((bid) => (
              <button key={bid} type="button" className="wb-chip-rm" onClick={() => toggleBadge(bid)}>
                ป้าย: {data.facets.badges.find((b) => b.id === bid)?.label ?? bid} ✕
              </button>
            ))}
            {dietary.map((did) => (
              <button key={did} type="button" className="wb-chip-rm" onClick={() => toggleDietary(did)}>
                {DIETARY_TAGS.find((d) => d.id === did)?.shortLabel ?? did} ✕
              </button>
            ))}
            {exclude.trim() && (
              <button type="button" className="wb-chip-rm" onClick={() => void runQuery({ exclude: "", page: 1 })}>
                ตัดออก: -{exclude.trim()} ✕
              </button>
            )}
            {(minPrice || maxPrice) && (
              <button
                type="button"
                className="wb-chip-rm"
                onClick={() => void runQuery({ minPrice: "", maxPrice: "", page: 1 })}
              >
                ราคา: {minPrice || "0"}–{maxPrice || "∞"} ✕
              </button>
            )}
            {multiUnitOnly && (
              <button type="button" className="wb-chip-rm" onClick={() => void runQuery({ multiUnitOnly: false, page: 1 })}>
                หลายหน่วยนับ ✕
              </button>
            )}
            {thaiGs1Only && (
              <button type="button" className="wb-chip-rm" onClick={() => void runQuery({ thaiGs1Only: false, page: 1 })}>
                บาร์โค้ดไทย 885 ✕
              </button>
            )}
            {activeFilterCount > 0 && (
              <button type="button" className="btn-reset-sm" onClick={resetAllFilters}>
                ล้างตัวกรอง
              </button>
            )}
          </div>
        )}

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
              {typeof data.elapsedMs === "number" && <span className="wb-speed-pill">{data.elapsedMs} ms</span>}
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
              <p>ไม่พบสินค้าที่ตรงกับเงื่อนไขปัจจุบันครับ</p>
              {data.didYouMean?.length ? (
                <div className="wb-empty-dym">
                  <span>หรือหมายถึง:</span>
                  {data.didYouMean.map((dym) => (
                    <button key={dym} type="button" className="wb-sug-pill" onClick={() => void runQuery({ q: dym, page: 1 })}>
                      🔎 {dym}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="wb-empty-actions">
                {scope !== "all" && (
                  <button type="button" className="btn" onClick={() => void runQuery({ scope: "all", page: 1 })}>
                    ค้นหาในทุกส่วนแทน
                  </button>
                )}
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
              {data.items.map((p, pIdx) => {
                const pCard = toProductCard(p);
                return (
                  <article key={p.slug} className="p-card" style={{ "--card-i": Math.min(pIdx, 14) } as CSSProperties}>
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
                        <HighlightText text={p.nameTh} terms={highlightTerms} />
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
                          {pCard.fdaNumber && <span className="p-trait-tag p-sbadge tone-fda">🛡️ อ.ย.</span>}
                        </div>
                      )}

                      {((pCard.badges?.length ?? 0) > 0 || pCard.traits.length > 0) && (
                        <div className="p-traits">
                          {(pCard.badges ?? []).slice(0, 3).map((b) => (
                            <span key={b.id} className={`p-trait-tag p-sbadge tone-${b.tone}`} title={b.title}>
                              {b.icon} {b.label}
                            </span>
                          ))}
                          {pCard.traits.slice(0, pCard.badges?.length ? 2 : 3).map((tr, ti) => (
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
                              <Link href={`/n/${encodeURIComponent(p.slug)}`}>
                                <HighlightText text={p.nameTh} terms={highlightTerms} />
                              </Link>
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
                            {(pCard.badges ?? []).slice(0, 2).map((b) => (
                              <span key={b.id} className={`p-trait-tag p-sbadge tone-${b.tone}`} title={b.title}>
                                {b.icon} {b.label}
                              </span>
                            ))}
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
