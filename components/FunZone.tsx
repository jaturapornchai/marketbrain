"use client";

// Demo "fun layer" for the cockpit: sounds, confetti, fly-to-cart, count-up totals, lucky wheel,
// missions, value duel, thinking brain, karaoke words and the budget bar.
// Money is never computed with binary floats here: totals animate as integer satang and every
// price comparison uses Decimal.js; floats are used only for pixel widths/angles.

import Decimal from "decimal.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CartSummary } from "@/lib/cart-order";
import type { JavisProductCard, JavisTeamJob } from "@/lib/product-card";
import { PROMOTIONS, formatBaht, type Promotion } from "@/lib/promotions";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/* ---------------- sound + confetti + fly ---------------- */

let fxCtx: AudioContext | null = null;
/** Short "ติ๊ง" (two bell notes) made in the browser, no audio file. */
export function playTing(kind: "add" | "win" = "add") {
  try {
    fxCtx ??= new AudioContext();
    const ctx = fxCtx;
    const notes = kind === "win" ? [784, 988, 1319] : [1046, 1568];
    notes.forEach((hz, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t = ctx.currentTime + i * 0.09;
      o.type = "sine";
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.5);
    });
  } catch {}
}

const CONFETTI_COLORS = ["#ea580c", "#e11d48", "#d97706", "#059669", "#0284c7", "#a855f7", "#facc15"];
export function burstConfetti(pieces = 110) {
  if (typeof document === "undefined") return;
  const box = document.createElement("div");
  box.className = "fx-confetti";
  for (let i = 0; i < pieces; i++) {
    const p = document.createElement("i");
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    p.style.animationDelay = `${Math.random() * 0.5}s`;
    p.style.animationDuration = `${1.8 + Math.random() * 1.4}s`;
    p.style.setProperty("--dx", `${(Math.random() - 0.5) * 240}px`);
    p.style.setProperty("--rot", `${Math.random() * 900 - 450}deg`);
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3600);
}

const visible = (el: Element | null): el is HTMLElement => Boolean(el && (el as HTMLElement).offsetParent !== null);

/** A copy of the product picture flies from its card into the cart button. */
export function flyToCart(slug: string) {
  if (typeof document === "undefined") return;
  const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(slug) : slug;
  const src =
    [...document.querySelectorAll(`[data-slug="${safe}"] img, .st-spotlight .sp-img-stage img, img.qty-prod-img`)].find(visible) ??
    null;
  const target = [...document.querySelectorAll("[data-cart-target]")].find(visible);
  if (!src || !target) return;
  const a = src.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const ghost = (src as HTMLImageElement).cloneNode(true) as HTMLImageElement;
  ghost.className = "fx-fly";
  Object.assign(ghost.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  document.body.appendChild(ghost);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  ghost
    .animate(
      [
        { transform: "translate(0,0) scale(1) rotate(0)", opacity: 1 },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 120}px) scale(.6) rotate(-12deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy}px) scale(.12) rotate(8deg)`, opacity: 0.4 },
      ],
      { duration: 850, easing: "cubic-bezier(.5,0,.6,1)" },
    )
    .finished.then(() => {
      ghost.remove();
      target.classList.remove("fx-cart-bump");
      void target.offsetWidth;
      target.classList.add("fx-cart-bump");
    })
    .catch(() => ghost.remove());
}

/* ---------------- count-up baht ---------------- */

const toSatang = (dec: string) => {
  const [i, d = "00"] = (dec || "0").split(".");
  return Number.parseInt(i, 10) * 100 + Number.parseInt((d + "00").slice(0, 2), 10);
};
const fromSatang = (s: number) => `${Math.floor(s / 100)}.${String(s % 100).padStart(2, "0")}`;

/** Total that rolls up/down to the new value; the final text is always the exact formatted amount. */
export function CountUpBaht({ value, formatted, className }: { value: string; formatted: string; className?: string }) {
  const [shown, setShown] = useState(formatted);
  const [rolling, setRolling] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    const from = toSatang(prev.current);
    const to = toSatang(value);
    prev.current = value;
    if (from === to) {
      setShown(formatted);
      return;
    }
    const t0 = performance.now();
    const ms = 700;
    let raf = 0;
    setRolling(true);
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      if (k < 1) {
        setShown(formatBaht(fromSatang(Math.round(from + (to - from) * eased))));
        raf = requestAnimationFrame(step);
      } else {
        setShown(formatted);
        setRolling(false);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, formatted]);
  return <span className={`${className ?? ""}${rolling ? " fx-rolling" : ""}`}>{shown}</span>;
}

/* ---------------- missions ---------------- */

export const MISSIONS = [
  { key: "search", icon: "🔎", label: "ถามหาสินค้า", say: "มีน้ำปลาอะไรบ้าง" },
  { key: "open", icon: "👀", label: "เปิดดูตามเบอร์", say: "ขอดูรายละเอียดเบอร์ 2" },
  { key: "add", icon: "🛒", label: "สั่งตามเบอร์", say: "เอาเบอร์ 1 สามชิ้น" },
  { key: "duel", icon: "🥊", label: "ดวลความคุ้ม", say: "เทียบเบอร์ 1 กับ 2" },
  { key: "spin", icon: "🎡", label: "หมุนวงล้อลุ้นคูปอง", say: "หมุนวงล้อ" },
  { key: "budget", icon: "🎯", label: "ตั้งงบช้อป", say: "งบ 500 บาท" },
  { key: "back", icon: "↩️", label: "สั่งหน้าจอด้วยเสียง", say: "ถอยกลับไป" },
  { key: "order", icon: "🎉", label: "ปิดบิลสำเร็จ", say: "เช็คบิล" },
] as const;
export type MissionKey = (typeof MISSIONS)[number]["key"];

export function PlayPanel({
  done,
  onSay,
  onClose,
}: {
  done: Partial<Record<MissionKey, boolean>>;
  onSay: (text: string) => void;
  onClose: () => void;
}) {
  const count = MISSIONS.filter((m) => done[m.key]).length;
  const pct = Math.round((count / MISSIONS.length) * 100);
  return (
    <section className="fz-play" aria-label="ภารกิจลองเล่น">
      <div className="fz-play-head">
        <b>🎮 ลองเล่นเลย! ภารกิจนักช้อป</b>
        <span className="fz-play-score">
          {count}/{MISSIONS.length} {count === MISSIONS.length ? "🏆 นักช้อปตัวจริง!" : ""}
        </span>
        <button type="button" className="btn-reset-sm" onClick={onClose}>
          ซ่อน
        </button>
      </div>
      <div className="fz-play-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <p className="fz-play-tip">แตะภารกิจ หรือพูดประโยคตามนี้กับน้องตี๋ได้เลย ไม่ต้องจับเมาส์</p>
      <div className="fz-play-grid">
        {MISSIONS.map((m) => (
          <button key={m.key} type="button" className={`fz-mission${done[m.key] ? " done" : ""}`} onClick={() => onSay(m.say)}>
            <span className="fz-m-icon">{done[m.key] ? "✅" : m.icon}</span>
            <span className="fz-m-body">
              <b>{m.label}</b>
              <small>พูดว่า “{m.say}”</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ---------------- lucky wheel ---------------- */

const WHEEL: Promotion[] = [PROMOTIONS[0], PROMOTIONS[1], PROMOTIONS[2], PROMOTIONS[0], PROMOTIONS[1], PROMOTIONS[0]];
const WHEEL_FILL: Record<Promotion["color"], string> = { gold: "#f59e0b", rose: "#f43f5e", emerald: "#10b981" };

function randomIndex(n: number): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}

export function LuckyWheel({ onWin, onClose, spinKey }: { onWin: (p: Promotion) => void; onClose: () => void; spinKey: number }) {
  const [angle, setAngle] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [won, setWon] = useState<Promotion | null>(null);
  const seg = 360 / WHEEL.length;
  const spin = () => {
    if (spinning) return;
    const idx = randomIndex(WHEEL.length);
    setWon(null);
    setSpinning(true);
    // pointer is at the top: land the middle of segment idx under it
    setAngle((a) => a - (a % 360) + 360 * 6 + (360 - (idx * seg + seg / 2)));
    setTimeout(() => {
      setSpinning(false);
      setWon(WHEEL[idx]);
      onWin(WHEEL[idx]);
    }, 4300);
  };
  const spinRef = useRef(spin);
  spinRef.current = spin;
  useEffect(() => {
    const t = setTimeout(() => spinRef.current(), 450); // every spoken "หมุนวงล้อ" spins at once
    return () => clearTimeout(t);
  }, [spinKey]);
  const paths = WHEEL.map((p, i) => {
    const a0 = ((i * seg - 90) * Math.PI) / 180;
    const a1 = (((i + 1) * seg - 90) * Math.PI) / 180;
    const r = 120;
    const mid = (((i + 0.5) * seg - 90) * Math.PI) / 180;
    return {
      p,
      d: `M130 130 L${130 + r * Math.cos(a0)} ${130 + r * Math.sin(a0)} A${r} ${r} 0 0 1 ${130 + r * Math.cos(a1)} ${130 + r * Math.sin(a1)} Z`,
      tx: 130 + 76 * Math.cos(mid),
      ty: 130 + 76 * Math.sin(mid),
      rot: (i + 0.5) * seg,
    };
  });
  return (
    <div className="fz-overlay" role="dialog" aria-label="วงล้อนำโชค" onClick={(e) => e.target === e.currentTarget && !spinning && onClose()}>
      <div className="fz-wheel-card">
        <h3>🎡 วงล้อนำโชค ลุ้นคูปองส่วนลด</h3>
        <div className="fz-wheel-wrap">
          <span className="fz-wheel-pin">▼</span>
          <svg viewBox="0 0 260 260" className="fz-wheel" style={{ transform: `rotate(${angle}deg)` }}>
            {paths.map((x, i) => (
              <g key={i}>
                <path d={x.d} fill={WHEEL_FILL[x.p.color]} stroke="#fff" strokeWidth="3" opacity={i % 2 ? 0.85 : 1} />
                <text x={x.tx} y={x.ty} transform={`rotate(${x.rot} ${x.tx} ${x.ty})`} textAnchor="middle" dominantBaseline="middle" className="fz-wheel-txt">
                  {x.p.kind === "percent" ? `${x.p.value}%` : `฿${new Decimal(x.p.value).toFixed(0)}`}
                </text>
              </g>
            ))}
            <circle cx="130" cy="130" r="22" fill="#fff" stroke="#ea580c" strokeWidth="4" />
            <text x="130" y="131" textAnchor="middle" dominantBaseline="middle" fontSize="18">🎁</text>
          </svg>
        </div>
        {won ? (
          <p className="fz-wheel-win">
            ได้คูปอง <b>{won.code}</b> — {won.title}
          </p>
        ) : (
          <p className="fz-wheel-tip">{spinning ? "กำลังหมุน… ลุ้นๆ!" : "พูดว่า “หมุนวงล้อ” หรือกดปุ่ม"}</p>
        )}
        <div className="fz-wheel-btns">
          <button type="button" className="btn primary" onClick={spin} disabled={spinning}>
            {won ? "🔁 หมุนอีกรอบ" : "🎯 หมุนเลย"}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={spinning}>
            {won ? "ไปที่ตะกร้า" : "ปิด"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- value duel ---------------- */

/** Price per base unit (e.g. per piece) as Decimal; null when the card has no price. */
export function perBasePrice(c: JavisProductCard): Decimal | null {
  if (!c.bestPrice) return null;
  const pack = c.packQty > 0 ? c.packQty : 1;
  return new Decimal(c.bestPrice).dividedBy(pack).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export type DuelResult = { winner: 0 | 1 | null; text: string };

export function judgeDuel(a: JavisProductCard, b: JavisProductCard, noA: number, noB: number): DuelResult {
  const pa = perBasePrice(a);
  const pb = perBasePrice(b);
  if (!pa || !pb) return { winner: null, text: "มีตัวหนึ่งยังไม่มีราคาในระบบ เลยตัดสินไม่ได้ครับ" };
  if (a.baseUnitCode !== b.baseUnitCode)
    return { winner: null, text: `หน่วยนับต่างกัน (${a.baseUnitCode} กับ ${b.baseUnitCode}) เทียบความคุ้มตรงๆ ไม่ได้ครับ` };
  const cmp = pa.comparedTo(pb);
  if (cmp === 0) return { winner: null, text: `เสมอกันครับ ตก${a.baseUnitCode}ละ ${pa.toFixed(2)} บาทเท่ากัน` };
  const [w, l, pw, pl, nw] = cmp < 0 ? [a, b, pa, pb, noA] : [b, a, pb, pa, noB];
  void l;
  const save = pl.minus(pw).toFixed(2);
  return {
    winner: cmp < 0 ? 0 : 1,
    text: `เบอร์ ${nw} ชนะครับ! ${w.title} ตก${w.baseUnitCode}ละ ${pw.toFixed(2)} บาท ถูกกว่า${w.baseUnitCode}ละ ${save} บาท`,
  };
}

export function DuelView({
  a,
  b,
  noA,
  noB,
  onClose,
  onAdd,
}: {
  a: JavisProductCard;
  b: JavisProductCard;
  noA: number;
  noB: number;
  onClose: () => void;
  onAdd: (c: JavisProductCard) => void;
}) {
  const res = judgeDuel(a, b, noA, noB);
  const side = (c: JavisProductCard, no: number, i: 0 | 1) => {
    const per = perBasePrice(c);
    return (
      <div className={`fz-duel-side${res.winner === i ? " win" : res.winner === null ? "" : " lose"}`}>
        {res.winner === i && <span className="fz-duel-crown">🏆 คุ้มกว่า</span>}
        <span className="p-no-badge">{no}</span>
        <div className="fz-duel-img">{c.imageUrl ? <img src={c.imageUrl} alt={c.title} /> : <span>📦</span>}</div>
        <b className="fz-duel-title">{c.title}</b>
        <span className="fz-duel-price">
          {c.priceLabel} / {c.unitLabel}
        </span>
        <span className="fz-duel-per">{per ? `ตก${c.baseUnitCode}ละ ฿${per.toFixed(2)}` : "ยังไม่มีราคา"}</span>
        <button type="button" className="btn primary" onClick={() => onAdd(c)}>
          🛒 ใส่ตะกร้า
        </button>
      </div>
    );
  };
  return (
    <div className="fz-overlay" role="dialog" aria-label="ดวลความคุ้ม" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="fz-duel">
        <h3>🥊 ดวลความคุ้ม เบอร์ {noA} ปะทะ เบอร์ {noB}</h3>
        <div className="fz-duel-ring">
          {side(a, noA, 0)}
          <span className="fz-duel-vs">VS</span>
          {side(b, noB, 1)}
        </div>
        <p className="fz-duel-verdict">{res.text}</p>
        <button type="button" className="btn" onClick={onClose}>
          ปิด
        </button>
      </div>
    </div>
  );
}

/* ---------------- thinking brain ---------------- */

/** While Nong Tee works: the real worker jobs and the products found light up around a brain. */
export function ThinkingBrain({ jobs, cards }: { jobs: JavisTeamJob[]; cards: JavisProductCard[] }) {
  const nodes = [
    ...jobs.slice(-4).map((j) => ({ key: `j${j.id}`, label: j.label, kind: j.state === "done" ? "done" : "run" })),
    ...cards.slice(0, 6).map((c, i) => ({ key: `c${c.slug}`, label: `${i + 1}. ${c.title.slice(0, 18)}`, kind: "card" })),
  ];
  return (
    <div className="fz-brain" aria-label="น้องตี๋กำลังคิด">
      <svg viewBox="0 0 300 170">
        {nodes.map((n, i) => {
          const a = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
          const x = 150 + 118 * Math.cos(a);
          const y = 85 + 62 * Math.sin(a);
          return (
            <g key={n.key} className={`fz-bn ${n.kind}`} style={{ animationDelay: `${i * 0.12}s` }}>
              <line x1="150" y1="85" x2={x} y2={y} />
              <circle cx={x} cy={y} r="6" />
              <text x={x} y={y + (y > 85 ? 16 : -10)} textAnchor="middle">
                {n.label}
              </text>
            </g>
          );
        })}
        <circle cx="150" cy="85" r="24" className="fz-bcore" />
        <text x="150" y="87" textAnchor="middle" dominantBaseline="middle" fontSize="22">
          🧠
        </text>
      </svg>
      <span className="fz-brain-cap">น้องตี๋กำลังค้นในสมองสินค้า…</span>
    </div>
  );
}

/* ---------------- karaoke words ---------------- */

/** Nong Tee's sentence lit word by word in time with his voice (pct = playback progress). */
export function KaraokeWords({ text, pct }: { text: string; pct: number }) {
  const words = useMemo(() => {
    const seg =
      typeof Intl !== "undefined" && "Segmenter" in Intl
        ? [...new Intl.Segmenter("th", { granularity: "word" }).segment(text)].map((s) => s.segment)
        : text.split(/(\s+)/);
    const total = Math.max(1, text.length);
    let acc = 0;
    return seg.map((w) => {
      const start = (acc / total) * 100;
      acc += w.length;
      return { w, start, end: (acc / total) * 100 };
    });
  }, [text]);
  return (
    <p className="jc-k-bot fz-kwords">
      {words.map((x, i) => (
        <span key={i} className={pct >= x.end ? "lit" : pct > x.start ? "now" : ""}>
          {x.w}
        </span>
      ))}
    </p>
  );
}

/* ---------------- budget bar ---------------- */

export function BudgetBar({ budget, cart, onClear }: { budget: string; cart: CartSummary; onClear: () => void }) {
  const b = new Decimal(budget);
  const spent = new Decimal(cart.grandTotal || "0");
  const left = b.minus(spent);
  const ratio = b.gt(0) ? spent.dividedBy(b) : new Decimal(0);
  const width = `${Math.min(100, ratio.times(100).toDecimalPlaces(1).toNumber())}%`; // pixels only
  const level = ratio.gt(1) ? "over" : ratio.gte(0.8) ? "near" : "ok";
  return (
    <div className={`fz-budget ${level}`} aria-label="งบช้อป">
      <span className="fz-budget-label">🎯 งบ {formatBaht(b.toFixed(2))}</span>
      <div className="fz-budget-bar">
        <i style={{ width }} />
      </div>
      <span className="fz-budget-left">
        {left.gte(0) ? `เหลือ ${formatBaht(left.toFixed(2))}` : `เกินงบ ${formatBaht(left.negated().toFixed(2))}!`}
      </span>
      <button type="button" className="btn-reset-sm" onClick={onClear} title="ยกเลิกงบ">
        ✕
      </button>
    </div>
  );
}

/* ---------------- pay countdown ---------------- */

/** "ชำระภายใน 14:32" under the PromptPay QR (demo: 15 minutes from the order time). */
export function PayCountdown({ createdAt, minutes = 15 }: { createdAt: string; minutes?: number }) {
  const deadline = new Date(createdAt).getTime() + minutes * 60_000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((deadline - now) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <div className={`fz-countdown${left <= 60 ? " hurry" : ""}`}>
      {left > 0 ? (
        <>
          ⏱️ สแกนจ่ายภายใน <b>{mm}:{ss}</b>
        </>
      ) : (
        "หมดเวลาสแกน กรุณาให้ร้านออก QR ใหม่ครับ"
      )}
    </div>
  );
}

/** "🔗 สมองแนะนำของที่เกี่ยวข้อง" row: brain-hub neighbours, tap to add. */
export function RelatedStrip({
  cards,
  reasons,
  excludeSlugs,
  onAdd,
  onShowAll,
}: {
  cards: JavisProductCard[];
  reasons: Record<string, string>;
  excludeSlugs: string[];
  onAdd: (c: JavisProductCard) => void;
  onShowAll: () => void;
}) {
  const shown = cards.filter((c) => !excludeSlugs.includes(c.slug)).slice(0, 6);
  if (!shown.length) return null;
  return (
    <div className="fz-related">
      <div className="fz-related-head">
        <b>🔗 สมองแนะนำของที่เกี่ยวข้อง</b>
        <button type="button" className="btn-reset-sm" onClick={onShowAll}>
          ดูบนจอทั้งหมด
        </button>
      </div>
      <p className="fz-play-tip">พูดว่า “ดูของที่เกี่ยวข้อง” แล้วสั่งตามเบอร์ได้เลย</p>
      <div className="fz-related-row">
        {shown.map((c) => (
          <button type="button" key={c.slug} className="fz-rel-card" data-slug={c.slug} onClick={() => onAdd(c)}>
            <span className="fz-rel-img">{c.imageUrl ? <img src={c.imageUrl} alt={c.title} loading="lazy" /> : "📦"}</span>
            <span className="fz-rel-title">{c.title}</span>
            <span className="fz-rel-meta">
              <b>{c.priceLabel}</b>
              <small>{reasons[c.slug]}</small>
            </span>
            <span className="fz-rel-add">🛒 ใส่ตะกร้า</span>
          </button>
        ))}
      </div>
    </div>
  );
}
