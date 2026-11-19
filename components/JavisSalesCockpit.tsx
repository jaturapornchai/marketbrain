"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import type { PaymentMethod, SalesOrder } from "@/lib/cart-order";
import type {
  JavisChatMessage,
  JavisProductCard,
  JavisStageMode,
  JavisStreamEvent,
  JavisTeamJob,
} from "@/lib/product-card";
import { BARGE_FRAMES, EchoGuard, playedLevel, wavEnvelope } from "@/lib/echo-guard";
import { parseBudget, parseScreenCommand, screenCommandHelp, type ScreenCommand } from "@/lib/voice-commands";
import { parseThaiNumber } from "@/lib/numbered-order";
import { RelatedStrip,
  BudgetBar,
  CountUpBaht,
  DuelView,
  KaraokeWords,
  LuckyWheel,
  MISSIONS,
  PayCountdown,
  PlayPanel,
  ThinkingBrain,
  burstConfetti,
  flyToCart,
  judgeDuel,
  playTing,
  type MissionKey,
} from "./FunZone";
import { useRouter } from "next/navigation";
import DevicePickerPopover from "./DevicePickerPopover";
import { useJavis } from "./JavisContext";
import CouponStrip from "./CouponStrip";
import { PROMOTIONS, applyCoupon, bestPromotion, findPromotion, parseCouponCommand, type CouponCommand } from "@/lib/promotions";
import ProductVisionScanner, { identifyProductFromFile, type VisionLookupResult } from "./ProductVisionScanner";

type SinkableAudio = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

type TurnEntry = {
  id: string;
  userText: string;
  imagePreview?: string;
  spokenText: string;
  screenMarkdown: string;
  cards: JavisProductCard[];
  jobs: JavisTeamJob[];
  model: string;
  error?: string;
  /** Screen-control command ("ถอยกลับไป"), kept out of the conversation history sent to the AI. */
  isCommand?: boolean;
};

type HudState = "idle" | "listening" | "searching" | "thinking" | "speaking" | "error";

const GREETING_TEXT =
  "สวัสดีครับ ผมน้องตี๋ เลขาช่วยหาสินค้าและรับออเดอร์ครับ อยากดูสินค้าตัวไหน พูด ส่องกล้องรูปสินค้า หรือพิมพ์บอกตี๋ได้เลยนะครับ";

const ECHO_TAIL_MS = 400; // room reverb + output latency after Nong Tee stops speaking

const ACTION_FX_MS = 3600; // how long the "what I just did" banner stays
const ACTION_PICK_MS = 1300; // time to show the picked card before switching to the cart

type ActionFx = { id: string; kind: "add" | "ask" | "unknown" | "cmd"; slug?: string; text: string };

// One remembered screen, so "ถอยกลับไป" / "เดินหน้า" can move through what the customer has seen.
type ScreenSnap = {
  mode: JavisStageMode;
  cards: JavisProductCard[];
  spotlight: JavisProductCard | null;
  title: string;
};
const SCREEN_HISTORY_MAX = 40;
const SCREEN_SETTLE_MS = 700; // a screen counts as "seen" after it stays this long

const MODE_LABEL: Record<JavisStageMode, string> = {
  welcome: "หน้าแรก",
  showcase: "ภาพสินค้า",
  spotlight: "เจาะลึกสินค้า",
  compare: "ตารางเปรียบเทียบ",
  camera: "กล้องหาสินค้า",
  cart: "ตะกร้า",
  checkout: "หน้าปิดการขาย",
  order_confirmed: "ใบยืนยันสั่งซื้อ",
};

function snapKey(x: ScreenSnap): string {
  const mode = x.mode === "welcome" ? "showcase" : x.mode;
  const cards = x.cards.slice(0, 12).map((c) => c.slug).join(",");
  return `${mode}|${mode === "spotlight" ? (x.spotlight?.slug ?? "") : ""}|${cards}`;
}

function snapLabel(x: ScreenSnap): string {
  if (x.mode === "spotlight" && x.spotlight) return x.spotlight.title;
  if (x.mode === "showcase" || x.mode === "welcome") return x.title || MODE_LABEL.showcase;
  return MODE_LABEL[x.mode];
}

/** "฿1,234.50" -> "1,234.50 บาท" for the voice. */
function bahtSpoken(formatted: string): string {
  return `${formatted.replace(/฿\s*/, "").replace(/\.00$/, "")} บาท`;
}

const COMMAND_HELP: Array<{ id: string; label: string; examples: string[] }> = [
  ...screenCommandHelp(),
  { id: "coupon", label: "ใช้คูปองส่วนลด", examples: ["ใช้คูปอง", "มีโปรอะไรบ้าง", "ยกเลิกคูปอง"] },
  { id: "budget", label: "ตั้งงบช้อป", examples: ["งบ 500 บาท", "ยกเลิกงบ"] },
];

const QUICK_SCENARIOS = [
  { icon: "🌶️", label: "น้ำจิ้ม/ซอส ไม่ใส่ผงชูรส", prompt: "ตี๋ หาน้ำจิ้มไก่หรือซอสที่ไม่ใส่ผงชูรสให้หน่อยครับ" },
  { icon: "☪️", label: "สินค้าฮาลาลขายดี", prompt: "ตี๋ ขอดูสินค้าที่ได้เครื่องหมายฮาลาลในหมวดเครื่องปรุงหน่อยครับ" },
  { icon: "📦", label: "สินค้าแพ็ค/ยกลังสุดคุ้ม", prompt: "ตี๋ แนะนำสินค้าแบบแพ็คหรือยกลังที่ราคาต่อชิ้นคุ้มๆ ให้ดูหน่อยครับ" },
  { icon: "🍜", label: "บะหมี่/อาหารแห้ง", prompt: "ตี๋ ขอดูบะหมี่กึ่งสำเร็จรูปหรือของแห้งขายดีสำหรับร้านโชห่วยหน่อยครับ" },
];

function renderSafeMd(md: string): string {
  if (!md.trim()) return "";
  return marked.parse(md.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ""), { async: false, gfm: true }) as string;
}

type RelatedSet = { cards: JavisProductCard[]; reasons: Record<string, string> };

/** Brain synapse neighbours (similarity, not purchase data). */
async function fetchRelated(seeds: string[]): Promise<RelatedSet | null> {
  if (!seeds.length) return null;
  try {
    const r = await fetch(`/api/products/related?slugs=${encodeURIComponent(seeds.slice(0, 6).join(","))}`);
    return r.ok ? ((await r.json()) as RelatedSet) : null;
  } catch {
    return null;
  }
}

export default function JavisSalesCockpit({
  featuredProducts,
  totalProductsCount,
}: {
  featuredProducts: JavisProductCard[];
  totalProductsCount: number;
}) {
  const {
    cart,
    couponCode,
    setCouponCode,
    customer,
    pendingPrompt,
    pendingVision,
    lastAddedNotice,
    micDeviceId,
    speakerDeviceId,
    clearPendingPrompt,
    clearPendingVision,
    promptAddToCart,
    qtyModalProduct,
    closeQtyModal,
    updateCartQty,
    removeFromCart,
    clearCart,
    replaceServerCart,
    updateCustomer,
  } = useJavis();

  const [stageMode, setStageMode] = useState<JavisStageMode>("welcome");
  const [stageTitle, setStageTitle] = useState("สินค้าแนะนำพร้อมขายในสมอง");
  const [stageCards, setStageCards] = useState<JavisProductCard[]>(featuredProducts);
  const [spotlight, setSpotlight] = useState<JavisProductCard | null>(featuredProducts[0] ?? null);
  // What the system just did for a spoken order ("เบอร์ 5 × 10 เข้าตะกร้าแล้ว"), shown as a banner + card highlight
  const [actionFx, setActionFx] = useState<ActionFx[]>([]);
  const actionFxTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const stageCardsRef = useRef(stageCards);
  stageCardsRef.current = stageCards;
  const router = useRouter();
  const [screenHist, setScreenHist] = useState<{ list: ScreenSnap[]; idx: number }>({ list: [], idx: -1 });
  const screenHistRef = useRef(screenHist);
  screenHistRef.current = screenHist;
  const [helpOpen, setHelpOpen] = useState(false);
  const [couponPulse, setCouponPulse] = useState(0);
  const [wheelOpen, setWheelOpen] = useState(false);
  const [wheelSpinKey, setWheelSpinKey] = useState(0);
  const [playOpen, setPlayOpen] = useState(true);
  const [missions, setMissions] = useState<Partial<Record<MissionKey, boolean>>>({});
  const [budget, setBudget] = useState("");
  const [duel, setDuel] = useState<{ a: JavisProductCard; b: JavisProductCard; noA: number; noB: number } | null>(null);
  const budgetWarnRef = useRef<"" | "near" | "over">("");
  const prevPiecesRef = useRef<Map<string, number> | null>(null);
  const [related, setRelated] = useState<RelatedSet | null>(null);
  const [spotRelated, setSpotRelated] = useState<{ slug: string; set: RelatedSet } | null>(null);
  // Continuous cross-sell: the item Nong Tee offered last ("เอาด้วย" takes it) + everything offered so far.
  const suggestRef = useRef<{ card: JavisProductCard | null; offered: Set<string> }>({ card: null, offered: new Set() });
  const nextSuggestion = (cards: JavisProductCard[]) => {
    const inCart = new Set(cart.items.map((it) => it.slug));
    const pick = cards.find((c) => !inCart.has(c.slug) && !suggestRef.current.offered.has(c.slug)) ?? null;
    if (pick) suggestRef.current = { card: pick, offered: suggestRef.current.offered.add(pick.slug) };
    return pick;
  };
  const lastOrderNoRef = useRef("");
  const markMission = useCallback((key: MissionKey) => {
    setMissions((prev) => {
      if (prev[key]) return prev;
      const next = { ...prev, [key]: true };
      try {
        localStorage.setItem("mb_missions_v1", JSON.stringify(next));
      } catch {}
      if (MISSIONS.every((m) => next[m.key])) setTimeout(() => burstConfetti(160), 300);
      return next;
    });
  }, []);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("mb_missions_v1");
      if (raw) setMissions(JSON.parse(raw) as Partial<Record<MissionKey, boolean>>);
    } catch {}
  }, []);
  const runCouponCommandRef = useRef<(cmd: CouponCommand, heard: string) => void>(() => {});
  const runBudgetRef = useRef<(amount: string, heard: string) => void>(() => {});
  const couponCodeRef = useRef(couponCode);
  couponCodeRef.current = couponCode;
  const modalOpenRef = useRef(false);
  const runScreenCommandRef = useRef<(cmd: ScreenCommand, heard?: string) => void>(() => {});
  const qtyModalSlugRef = useRef("");
  qtyModalSlugRef.current = qtyModalProduct?.slug ?? "";
  // The product page that is open right now (opened by voice or by a tap) = what "อันนี้" means.
  const viewingSlugRef = useRef("");
  viewingSlugRef.current = stageMode === "spotlight" && spotlight ? spotlight.slug : "";
  const [lastChangedSlug, setLastChangedSlug] = useState<string>("");
  const [confirmedOrder, setConfirmedOrder] = useState<SalesOrder | null>(null);
  const [recentOrders, setRecentOrders] = useState<SalesOrder[]>([]);
  const [ordersModalOpen, setOrdersModalOpen] = useState(false);

  // Nong Tee starts active immediately on page load!
  const [hudState, setHudState] = useState<HudState>("listening");
  const [statusText, setStatusText] = useState("🟢 น้องตี๋เริ่มทำงานแล้วครับ พูดคุย ส่องรูปสินค้า หรือพิมพ์สั่งได้เลย");
  const [voiceEngineOnline, setVoiceEngineOnline] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [callActive, setCallActive] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [audioUnlockNeeded, setAudioUnlockNeeded] = useState(false);
  const [visionUploading, setVisionUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [activeMicStreamState, setActiveMicStreamState] = useState<MediaStream | null>(null);

  const [input, setInput] = useState("");
  const [liveUserHeard, setLiveUserHeard] = useState("");
  const [liveKaraokeText, setLiveKaraokeText] = useState("");
  const [karaokeProgress, setKaraokeProgress] = useState(100);
  const [turns, setTurns] = useState<TurnEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [placingOrderManual, setPlacingOrderManual] = useState(false);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const quickPhotoInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoStartedRef = useRef(false);
  const blockedAudioRef = useRef<SinkableAudio | null>(null);

  // Audio playback queue for Local OmniVoice sentences
  const audioQueueRef = useRef<Array<{ text: string; promise: Promise<{ url: string; dur: number } | null> }>>([]);
  const playingAudioRef = useRef<SinkableAudio | null>(null);
  const isPlayingLoopRef = useRef(false);
  const playingEnvRef = useRef<Float32Array | null>(null); // loudness envelope of the sentence being played
  const ttsEnabledRef = useRef(ttsEnabled);
  ttsEnabledRef.current = ttsEnabled;
  const speakerDeviceIdRef = useRef(speakerDeviceId);
  speakerDeviceIdRef.current = speakerDeviceId;
  const micDeviceIdRef = useRef(micDeviceId);
  micDeviceIdRef.current = micDeviceId;
  const micMutedRef = useRef(micMuted);
  micMutedRef.current = micMuted;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // WebAudio Mic + Local OpenThai ASR Streaming refs
  const callActiveRef = useRef(callActive);
  callActiveRef.current = callActive;
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const speakingDetectedRef = useRef(false);
  const speechStartMsRef = useRef(0);
  const lastVoiceMsRef = useRef(0);
  const lastPartialMsRef = useRef(0);
  const sendingSttRef = useRef(false);

  useEffect(() => {
    fetch("/api/voice/status")
      .then((r) => r.json())
      .then((d: { ok?: boolean }) => setVoiceEngineOnline(Boolean(d.ok)))
      .catch(() => setVoiceEngineOnline(false));
  }, []);

  // Dynamically switch active audio output sink if user changes speaker mid-speech
  useEffect(() => {
    const cur = playingAudioRef.current;
    if (cur && cur.setSinkId) {
      void cur.setSinkId(speakerDeviceId).catch(() => {});
    }
  }, [speakerDeviceId]);

  const stopAllAudioPlayback = useCallback(() => {
    audioQueueRef.current = [];
    if (blockedAudioRef.current) {
      blockedAudioRef.current.pause();
      blockedAudioRef.current.src = "";
      blockedAudioRef.current = null;
    }
    if (playingAudioRef.current) {
      playingAudioRef.current.pause();
      playingAudioRef.current.src = "";
      playingAudioRef.current = null;
    }
    isPlayingLoopRef.current = false;
    setAudioUnlockNeeded(false);
    setKaraokeProgress(100);
  }, []);

  const drainAudioQueue = useCallback(async () => {
    if (isPlayingLoopRef.current) return;
    isPlayingLoopRef.current = true;
    try {
      while (audioQueueRef.current.length > 0) {
        const item = audioQueueRef.current.shift()!;
        if (!ttsEnabledRef.current) continue;
        const resolved = await item.promise;
        if (!resolved || !ttsEnabledRef.current) continue;

        setHudState("speaking");
        setLiveKaraokeText(item.text);
        setKaraokeProgress(0);

        await new Promise<void>((resolve) => {
          const audio = new Audio(resolved.url) as SinkableAudio;
          playingAudioRef.current = audio;
          playingEnvRef.current = null;
          void fetch(resolved.url)
            .then((r) => r.arrayBuffer())
            .then((b) => {
              if (playingAudioRef.current === audio) playingEnvRef.current = wavEnvelope(b);
            })
            .catch(() => {});
          const durMs = Math.max(400, resolved.dur * 1000);
          let tStart = performance.now();
          let anim: ReturnType<typeof setInterval> | null = null;

          const startProgressAnim = () => {
            tStart = performance.now();
            if (anim) clearInterval(anim);
            anim = setInterval(() => {
              const pct = Math.min(100, ((performance.now() - tStart) / durMs) * 100);
              setKaraokeProgress(pct);
            }, 45);
          };

          const finish = () => {
            if (anim) clearInterval(anim);
            setKaraokeProgress(100);
            URL.revokeObjectURL(resolved.url);
            if (playingAudioRef.current === audio) playingAudioRef.current = null;
            if (blockedAudioRef.current === audio) blockedAudioRef.current = null;
            resolve();
          };

          audio.onended = finish;
          audio.onerror = finish;

          (async () => {
            if (audio.setSinkId && speakerDeviceIdRef.current) {
              await audio.setSinkId(speakerDeviceIdRef.current).catch(() => {});
            }
            try {
              startProgressAnim();
              await audio.play();
              setAudioUnlockNeeded(false);
            } catch {
              // Browser paused autoplay before first gesture: keep audio ready & play on first tap anywhere!
              if (anim) clearInterval(anim);
              blockedAudioRef.current = audio;
              setAudioUnlockNeeded(true);
              const unlockOnce = () => {
                window.removeEventListener("pointerdown", unlockOnce, true);
                window.removeEventListener("keydown", unlockOnce, true);
                setAudioUnlockNeeded(false);
                void audioCtxRef.current?.resume().catch(() => {});
                if (blockedAudioRef.current === audio) {
                  startProgressAnim();
                  audio.play().catch(finish);
                } else {
                  finish();
                }
              };
              window.addEventListener("pointerdown", unlockOnce, { once: true, capture: true });
              window.addEventListener("keydown", unlockOnce, { once: true, capture: true });
            }
          })();
        });
      }
    } finally {
      isPlayingLoopRef.current = false;
      if (!busyRef.current) {
        setHudState("listening");
        setStatusText(
          callActiveRef.current
            ? micMutedRef.current
              ? "🔇 ปิดไมค์ชั่วคราว (พิมพ์คุยหรือส่องรูปสินค้าได้ตลอดครับ)"
              : "🟢 น้องตี๋กำลังทำงานและฟังเสียงของคุณอยู่ครับ…"
            : "🟢 น้องตี๋พร้อมทำงานครับ พิมพ์คุย ส่องรูปสินค้า หรือกดเปิดไมค์สดได้เลย",
        );
      }
    }
  }, []);

  const enqueueOmniVoiceSentence = useCallback(
    (sentence: string) => {
      if (!ttsEnabledRef.current || !sentence.trim()) return;
      const clean = sentence.trim();
      const promise = fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      })
        .then(async (res) => {
          if (!res.ok) return null;
          const dur = Number(res.headers.get("X-Audio-Duration") || "2.2") || 2.2;
          const blob = await res.blob();
          return { url: URL.createObjectURL(blob), dur };
        })
        .catch(() => null);

      audioQueueRef.current.push({ text: clean, promise });
      void drainAudioQueue();
    },
    [drainAudioQueue],
  );

  const enqueuePrewarmedGreeting = useCallback(() => {
    if (!ttsEnabledRef.current) return;
    const promise = fetch("/api/voice/tts")
      .then(async (r) => {
        if (!r.ok) return null;
        const dur = Number(r.headers.get("X-Audio-Duration") || "5") || 5;
        const blob = await r.blob();
        return { url: URL.createObjectURL(blob), dur };
      })
      .catch(() => null);
    audioQueueRef.current.push({ text: GREETING_TEXT, promise });
    void drainAudioQueue();
  }, [drainAudioQueue]);

  const sendTurnRef = useRef<(text: string) => Promise<void> | void>(() => {});
  const sendTurn = useCallback(
    async (
      rawText: string,
      extra?: {
        displayUserText?: string;
        imagePreview?: string;
        visionSlugs?: string[];
        visionSummary?: string;
      },
    ) => {
      const q = rawText.trim();
      // "ถอยกลับไป", "ดูเบอร์ 3", "เลื่อนลง" ... run on the screen at once (no AI, works even while busy).
      const screenCmd =
        q && !extra?.visionSlugs
          ? parseScreenCommand(q, { modalOpen: Boolean(qtyModalSlugRef.current) || modalOpenRef.current })
          : null;
      if (screenCmd) {
        setInput("");
        setLiveUserHeard("");
        runScreenCommandRef.current(screenCmd, q);
        return;
      }
      // "งบ 500 บาท" -> budget bar, 0 tokens
      const budgetCmd = q && !extra?.visionSlugs ? parseBudget(q, parseThaiNumber) : null;
      if (budgetCmd !== null) {
        setInput("");
        setLiveUserHeard("");
        runBudgetRef.current(budgetCmd, q);
        return;
      }
      // "ใช้คูปอง", "ยกเลิกคูปอง", "มีโปรอะไรบ้าง" -> exact, 0 tokens
      const couponCmd = q && !extra?.visionSlugs ? parseCouponCommand(q) : null;
      if (couponCmd) {
        setInput("");
        setLiveUserHeard("");
        runCouponCommandRef.current(couponCmd, q);
        return;
      }
      if (!q || busyRef.current) return;
      setWheelOpen(false);
      setDuel(null);

      stopAllAudioPlayback();
      setBusy(true);
      busyRef.current = true;
      setInput("");
      setLiveUserHeard("");
      setHudState("searching");
      setStatusText(
        extra?.visionSlugs?.length
          ? "📷 น้องตี๋เจอสินค้าจากรูปแล้ว กำลังสรุปราคาและหน่วยนับ…"
          : "น้องตี๋กำลังค้นสมองและจัดรายการ…",
      );

      const turnId = `turn-${Date.now()}`;
      // Token-Saver Mode: send only last 2 turns' spoken text (never send large [จอ] markdown tables)
      const historyPayload: JavisChatMessage[] = turns.filter((t) => !t.isCommand).slice(-2).flatMap((t) => [
        { role: "user" as const, content: t.userText.slice(0, 200) },
        { role: "assistant" as const, content: t.spokenText.slice(0, 240) },
      ]);

      // What the customer is looking at right now, so "อันนั้น/ตัวแรก" in the next sentence still means something
      // Card numbers the customer sees = position in this list, so "เบอร์ 5" means focusSlugs[4].
      const focusSlugs = stageCardsRef.current.slice(0, 12).map((c) => c.slug);

      setTurns((prev) => [
        ...prev,
        {
          id: turnId,
          userText: extra?.displayUserText || q,
          imagePreview: extra?.imagePreview,
          spokenText: "",
          screenMarkdown: "",
          cards: [],
          jobs: [],
          model: "deepseek-flash",
        },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/javis/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: q,
            history: historyPayload,
            cartItems: cart.items,
            customer,
            visionSlugs: extra?.visionSlugs,
            visionSummary: extra?.visionSummary,
            focusSlugs,
            pendingSlug: qtyModalSlugRef.current || undefined,
            viewingSlug: viewingSlugRef.current || undefined,
            couponCode: couponCodeRef.current || undefined,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const errJ = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJ.error || `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const blocks = buf.split("\n\n");
          buf = blocks.pop() ?? "";

          for (const b of blocks) {
            const line = b.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            let ev: JavisStreamEvent;
            try {
              ev = JSON.parse(line.slice(6)) as JavisStreamEvent;
            } catch {
              continue;
            }

            if (ev.type === "status") {
              setStatusText(ev.text);
              if (!isPlayingLoopRef.current && (ev.state === "searching" || ev.state === "thinking")) {
                setHudState(ev.state);
              }
            } else if (ev.type === "team") {
              setTurns((prev) =>
                prev.map((t) => {
                  if (t.id !== turnId) return t;
                  const has = t.jobs.some((j) => j.id === ev.job.id);
                  return {
                    ...t,
                    jobs: has ? t.jobs.map((j) => (j.id === ev.job.id ? ev.job : j)) : [...t.jobs, ev.job],
                  };
                }),
              );
            } else if (ev.type === "cards") {
              setStageCards(ev.cards);
              if (ev.cards.length > 0) markMission("search");
              // The customer moved on to other products: a "how many?" box for an old one must not cover them.
              if (qtyModalSlugRef.current && !ev.cards.some((c) => c.slug === qtyModalSlugRef.current)) closeQtyModal();
              // Same cards again (follow-up turn): stay on the product the customer has open.
              if (ev.cards[0]) setSpotlight((prev) => (prev && ev.cards.some((c) => c.slug === prev.slug) ? prev : ev.cards[0]));
              setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, cards: ev.cards } : t)));
            } else if (ev.type === "stage") {
              setStageMode(ev.mode);
              if (ev.title) setStageTitle(ev.title);
              if (ev.spotlight) setSpotlight(ev.spotlight);
            } else if (ev.type === "cart") {
              replaceServerCart(ev.cart);
              if (ev.lastChangedSlug) setLastChangedSlug(ev.lastChangedSlug);
            } else if (ev.type === "ask_qty") {
              promptAddToCart(ev.product);
            } else if (ev.type === "ui") {
              // Nong Tee understood a free-form screen command; he speaks his own reply.
              runScreenCommandRef.current(ev.command);
            } else if (ev.type === "action") {
              const fx: ActionFx = { id: `${turnId}-${ev.no}-${ev.kind}-${performance.now()}`, kind: ev.kind, slug: ev.slug, text: ev.text };
              setActionFx((prev) => [...prev.slice(-2), fx]);
              actionFxTimersRef.current.push(
                setTimeout(() => setActionFx((prev) => prev.filter((x) => x.id !== fx.id)), ACTION_FX_MS),
              );
              // Always show the numbered cards so the customer sees which one the system means.
              setStageMode("showcase");
              actionFxTimersRef.current.push(
                setTimeout(
                  () => document.querySelector(`.st-card.fx-${ev.kind}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
                  80,
                ),
              );
              if (ev.kind === "add") {
                // Show which numbered card was picked first, then move to the cart.
                closeQtyModal();
                actionFxTimersRef.current.push(
                  setTimeout(() => {
                    setStageMode("cart");
                    setStageTitle("อัปเดตตะกร้าสินค้าแล้ว");
                  }, ACTION_PICK_MS),
                );
              }
            } else if (ev.type === "customer") {
              updateCustomer(ev.customer);
            } else if (ev.type === "order") {
              setConfirmedOrder(ev.order);
              setCouponCode("");
            } else if (ev.type === "sentence") {
              enqueueOmniVoiceSentence(ev.text);
            } else if (ev.type === "delta") {
              setTurns((prev) =>
                prev.map((t) => {
                  if (t.id !== turnId) return t;
                  return ev.section === "speech"
                    ? { ...t, spokenText: t.spokenText + ev.text }
                    : { ...t, screenMarkdown: t.screenMarkdown + ev.text };
                }),
              );
            } else if (ev.type === "done") {
              setTurns((prev) =>
                prev.map((t) =>
                  t.id === turnId
                    ? {
                        ...t,
                        spokenText: ev.spokenText || t.spokenText,
                        screenMarkdown: ev.screenMarkdown || t.screenMarkdown,
                        model: ev.model,
                      }
                    : t,
                ),
              );
            } else if (ev.type === "error") {
              setHudState("error");
              setStatusText(ev.message);
              setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, error: ev.message } : t)));
            }
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") {
          const msg = err instanceof Error ? err.message : "เชื่อมต่อขัดข้อง";
          setHudState("error");
          setStatusText(msg);
          setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, error: msg } : t)));
        }
      } finally {
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
        if (!isPlayingLoopRef.current) {
          setHudState("listening");
          setStatusText(
            callActiveRef.current
              ? "🟢 น้องตี๋กำลังฟังเสียงของคุณอยู่ครับ…"
              : "🟢 น้องตี๋พร้อมคุยต่อหรือส่องรูปสินค้าได้เลยครับ",
          );
        }
      }
    },
    [cart.items, closeQtyModal, customer, enqueueOmniVoiceSentence, promptAddToCart, replaceServerCart, stopAllAudioPlayback, turns, updateCustomer],
  );
  sendTurnRef.current = sendTurn;

  // Consume external text prompt sent from /search or /n/[slug]
  useEffect(() => {
    if (pendingPrompt && !busy) {
      const p = pendingPrompt;
      clearPendingPrompt();
      void sendTurn(p);
    }
  }, [pendingPrompt, busy, clearPendingPrompt, sendTurn]);

  // Consume external vision lookup sent from /search
  useEffect(() => {
    if (pendingVision && !busy) {
      const pv = pendingVision;
      clearPendingVision();
      if (pv.cards.length > 0) {
        setStageCards(pv.cards);
        setSpotlight(pv.cards[0]);
        setStageMode(pv.cards.length === 1 ? "spotlight" : "showcase");
        setStageTitle(`📷 พบจากรูป: ${pv.visionSummary}`);
      }
      void sendTurn(pv.prompt, {
        displayUserText: `📷 ส่งรูปสินค้า: ${pv.visionSummary}`,
        imagePreview: pv.imagePreview,
        visionSlugs: pv.visionSlugs,
        visionSummary: pv.visionSummary,
      });
    }
  }, [pendingVision, busy, clearPendingVision, sendTurn]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [turns, liveUserHeard]);

  // ---------- Local OpenThai 2.0 ASR Live Call Loop (with Device Selection, Mute, Barge-in & Auto-Start) ----------
  const teardownMicGraph = useCallback(() => {
    pcmChunksRef.current = [];
    speakingDetectedRef.current = false;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    setActiveMicStreamState(null);
  }, []);

  const stopLiveCall = useCallback(() => {
    setCallActive(false);
    callActiveRef.current = false;
    setMicMuted(false);
    micMutedRef.current = false;
    teardownMicGraph();
    setLiveUserHeard("");
    setHudState("idle");
    setStatusText("พักสายไมค์แล้ว (พิมพ์คุย ส่องกล้องรูปสินค้า หรือกดเปิดไมค์ใหม่ได้ตลอดครับ)");
  }, [teardownMicGraph]);

  const attachMicStream = useCallback(
    async (preferredMicId: string) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("NO_MEDIA_DEVICES");
      }
      const baseAudio = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: preferredMicId ? { ...baseAudio, deviceId: { exact: preferredMicId } } : baseAudio,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
      }

      teardownMicGraph();
      stream.getAudioTracks().forEach((t) => {
        t.enabled = !micMutedRef.current;
      });
      micStreamRef.current = stream;
      setActiveMicStreamState(stream);

      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);

      const mergePcm = (chunks: Float32Array[]) => {
        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        const out = new Float32Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        return out;
      };

      // Echo guard: the speaker's own sound must never be heard as the customer (see lib/echo-guard.ts).
      const echoGuard = new EchoGuard();
      let wasPlaying = false;
      let preroll: Float32Array[] = [];
      let echoTailUntil = 0;
      let lastPlayed = 0;
      let lastSoundingMs = 0;

      proc.onaudioprocess = (ev) => {
        if (!callActiveRef.current || micMutedRef.current) return;
        const inputData = ev.inputBuffer.getChannelData(0);
        let sumSq = 0;
        for (let i = 0; i < inputData.length; i++) sumSq += inputData[i] * inputData[i];
        const rms = Math.sqrt(sumSq / inputData.length);
        const now = performance.now();

        const playing = isPlayingLoopRef.current;
        if (playing !== wasPlaying) {
          wasPlaying = playing;
          echoGuard.resetRun();
          preroll = [];
          if (playing) {
            pcmChunksRef.current = [];
            speakingDetectedRef.current = false;
            setLiveUserHeard("");
          } else {
            echoTailUntil = now + ECHO_TAIL_MS; // room reverb + output latency after he stops
          }
        }

        if (playing) {
          const audio = playingAudioRef.current;
          let played = 0;
          if (audio && !audio.paused) {
            played = lastPlayed = playedLevel(playingEnvRef.current, audio.currentTime);
            lastSoundingMs = now;
          } else if (now - lastSoundingMs < ECHO_TAIL_MS) {
            played = lastPlayed;
          }
          const customerFrames = echoGuard.hear(rms, played);
          if (customerFrames === 0) {
            preroll = [];
            return;
          }
          preroll.push(new Float32Array(inputData));
          if (customerFrames < BARGE_FRAMES) return;

          // Barge-in: customer clearly louder than the echo for ~0.5s -> stop talking and listen.
          stopAllAudioPlayback();
          wasPlaying = false;
          setHudState("listening");
          setStatusText("น้องตี๋หยุดฟังคุณพูดแทรกครับ…");
          speakingDetectedRef.current = true;
          speechStartMsRef.current = now;
          lastVoiceMsRef.current = now;
          pcmChunksRef.current = preroll;
          preroll = [];
          echoGuard.resetRun();
          return;
        }
        if (now < echoTailUntil) return;

        if (rms > 0.014) {
          if (!speakingDetectedRef.current) {
            speakingDetectedRef.current = true;
            speechStartMsRef.current = now;
          }
          lastVoiceMsRef.current = now;
          pcmChunksRef.current.push(new Float32Array(inputData));

          // Incremental live partial transcription every ~650ms
          if (!sendingSttRef.current && now - lastPartialMsRef.current > 650 && pcmChunksRef.current.length >= 3) {
            lastPartialMsRef.current = now;
            const merged = mergePcm(pcmChunksRef.current);
            sendingSttRef.current = true;
            fetch("/api/voice/stt", {
              method: "POST",
              headers: {
                "Content-Type": "application/octet-stream",
                "x-sample-rate": String(ctx.sampleRate),
                "x-audio-format": "f32le",
                "x-partial": "1",
              },
              body: merged.buffer,
            })
              .then((r) => r.json())
              .then((d: { text?: string }) => {
                if (d.text && speakingDetectedRef.current) setLiveUserHeard(d.text);
              })
              .catch(() => {})
              .finally(() => {
                sendingSttRef.current = false;
              });
          }
        } else if (speakingDetectedRef.current) {
          pcmChunksRef.current.push(new Float32Array(inputData));
          const silenceMs = now - lastVoiceMsRef.current;

          if (silenceMs >= 950 && !busyRef.current) {
            const captured = mergePcm(pcmChunksRef.current);
            pcmChunksRef.current = [];
            speakingDetectedRef.current = false;

            if (captured.length >= ctx.sampleRate * 0.35) {
              setStatusText("กำลังถอดเสียงภาษาไทย…");
              fetch("/api/voice/stt", {
                method: "POST",
                headers: {
                  "Content-Type": "application/octet-stream",
                  "x-sample-rate": String(ctx.sampleRate),
                  "x-audio-format": "f32le",
                  "x-partial": "0",
                },
                body: captured.buffer,
              })
                .then((r) => r.json())
                .then((d: { text?: string; voiced?: boolean }) => {
                  const finalWords = (d.text ?? "").trim();
                  setLiveUserHeard("");
                  if (d.voiced && finalWords) {
                    // Latest sendTurn, not the one captured when the mic started (stale cart/history wiped the cart).
                    void sendTurnRef.current(finalWords);
                  } else {
                    setHudState("listening");
                    setStatusText("🟢 น้องตี๋กำลังฟังเสียงของคุณอยู่ครับ…");
                  }
                })
                .catch(() => {
                  setLiveUserHeard("");
                  setHudState("listening");
                });
            } else {
              setLiveUserHeard("");
            }
          }
        }
      };

      source.connect(proc);
      proc.connect(ctx.destination);
    },
    [stopAllAudioPlayback, teardownMicGraph],
  );

  const startLiveCall = useCallback(
    async (opts?: { autoStart?: boolean }) => {
      if (!opts?.autoStart && callActiveRef.current) {
        stopLiveCall();
        return;
      }

      if (!pendingPrompt && !pendingVision) {
        enqueuePrewarmedGreeting();
      }

      try {
        await attachMicStream(micDeviceIdRef.current);
        setCallActive(true);
        callActiveRef.current = true;
        setMicMuted(false);
        micMutedRef.current = false;
        setHudState("listening");
        setStatusText("🟢 น้องตี๋เริ่มทำงานและฟังเสียงภาษาไทยสดอยู่ครับ…");
      } catch {
        setHudState("listening");
        setStatusText("🟢 น้องตี๋เริ่มทำงานแล้วครับ (พิมพ์คุย ส่องกล้องรูปสินค้า หรือกดเปิดไมค์ได้เลย)");
      }
    },
    [attachMicStream, enqueuePrewarmedGreeting, pendingPrompt, pendingVision, stopLiveCall],
  );

  // AUTO-START NONG TEE IMMEDIATELY ON PAGE LOAD ("เปิดมาให้ น้องตี๋ทำงานเลย")
  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    const savedMic = (() => {
      try {
        return localStorage.getItem("mb.dev.audioinput") || "";
      } catch {
        return "";
      }
    })();
    micDeviceIdRef.current = savedMic;
    void startLiveCall({ autoStart: true });
  }, [startLiveCall]);

  // Switch microphone live mid-call if user picks a different Mic in DevicePickerPopover
  const prevMicIdRef = useRef(micDeviceId);
  useEffect(() => {
    if (prevMicIdRef.current === micDeviceId) return;
    prevMicIdRef.current = micDeviceId;
    if (callActiveRef.current) {
      void attachMicStream(micDeviceId).catch(() => {});
    }
  }, [micDeviceId, attachMicStream]);

  useEffect(() => {
    return () => {
      stopAllAudioPlayback();
      if (callActiveRef.current) teardownMicGraph();
    };
  }, [stopAllAudioPlayback, teardownMicGraph]);

  const toggleMicMute = () => {
    const nextMuted = !micMuted;
    setMicMuted(nextMuted);
    micMutedRef.current = nextMuted;
    micStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setStatusText(
      nextMuted
        ? "🔇 ปิดไมค์ชั่วคราว (สายยังอยู่ พิมพ์คุยหรือส่องรูปสินค้าได้ตลอดครับ)"
        : "🟢 เปิดไมค์แล้ว น้องตี๋กำลังฟังเสียงของคุณอยู่ครับ…",
    );
  };

  // ---------- Instant Visual Product Lookup ("ถ้ามีรูปสินค้า ไปหาเลย") ----------
  const handleVisionResult = useCallback(
    (res: VisionLookupResult) => {
      const desc = res.detected.summaryTh || res.matchedQuery || res.detected.productName || "รูปสินค้า";
      if (res.cards.length > 0) {
        setStageCards(res.cards);
        setSpotlight(res.cards[0]);
        setStageMode(res.cards.length === 1 ? "spotlight" : "showcase");
        setStageTitle(`📷 พบสินค้าจากรูป: ${desc}`);

        const promptText = res.exactMatch
          ? `ลูกค้าส่งรูปสินค้า (${desc}) ระบบส่องเจอสินค้าตรงกันในคลังแล้ว ช่วยแนะนำชื่อสินค้า ราคา หน่วยบรรจุ และถามลูกค้าทันทีเลยว่าจะรับกี่หน่วยเข้าตะกร้าดีครับ`
          : `ลูกค้าส่งรูปสินค้า (${desc}) รุ่นตรงเป๊ะยังไม่มีในคลัง แต่ระบบดึงสินค้าใกล้เคียงในหมวด "${res.matchedQuery}" มาแสดงบนจอแล้ว ช่วยแจ้งลูกค้าอย่างจริงใจและแนะนำตัวเลือกบนจอพร้อมราคาให้เลยครับ`;

        void sendTurn(promptText, {
          displayUserText: `📷 ค้นหาจากรูปสินค้า: ${desc}`,
          imagePreview: res.snapshotDataUrl,
          visionSlugs: res.cards.map((c) => c.slug),
          visionSummary: desc,
        });
      } else {
        void sendTurn(`ตี๋ ช่วยค้นหาสินค้าที่เกี่ยวกับ "${desc}" ในคลังสมองให้หน่อยครับ`, {
          displayUserText: `📷 ค้นหาจากรูปสินค้า: ${desc}`,
          imagePreview: res.snapshotDataUrl,
        });
      }
    },
    [sendTurn],
  );

  const handleQuickPhotoFile = useCallback(
    async (file: File) => {
      if (visionUploading) return;
      setVisionUploading(true);
      setHudState("searching");
      setStatusText(`📷 กำลังส่องรูปสินค้า "${file.name}" เพื่อค้นหาในสมองทันที…`);
      try {
        const res = await identifyProductFromFile(file);
        if (res.ok && (res.cards.length > 0 || res.hasProduct)) {
          handleVisionResult(res);
        } else {
          setHudState("listening");
          setStatusText(res.error || "ยังไม่เห็นฉลากสินค้าในรูปชัดเจน ลองถ่ายใกล้ฉลากหรือบาร์โค้ดอีกครั้งนะครับ");
        }
      } catch {
        setHudState("listening");
        setStatusText("ไม่สามารถอ่านรูปภาพนี้ได้ ลองเลือกรูปใหม่อีกครั้งนะครับ");
      } finally {
        setVisionUploading(false);
      }
    },
    [handleVisionResult, visionUploading],
  );

  // Global Ctrl+V Image Paste anywhere on `/` -> immediately find product!
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            void handleQuickPhotoFile(f);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleQuickPhotoFile]);

  const handleManualPlaceOrder = async () => {
    if (!cart.items.length || placingOrderManual) return;
    setPlacingOrderManual(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "place_order",
          items: cart.items,
          customer,
          couponCode: couponCode || undefined,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; order?: SalesOrder; error?: string };
      if (data.ok && data.order) {
        setConfirmedOrder(data.order);
        clearCart();
        setCouponCode(""); // one coupon per order
        setStageMode("order_confirmed");
        setStageTitle(`ยืนยันคำสั่งซื้อสำเร็จ #${data.order.orderNo}`);
        enqueueOmniVoiceSentence(
          `ปิดการขายเรียบร้อยแล้วครับ เลขที่ใบสั่งซื้อ ${data.order.orderNo} ยอดสุทธิ ${data.order.cart.grandTotalFormatted} ขอบคุณมากเลยนะครับ`,
        );
      } else {
        setStatusText(data.error || "ไม่สามารถยืนยันคำสั่งซื้อได้");
      }
    } finally {
      setPlacingOrderManual(false);
    }
  };

  const openOrdersHistory = async () => {
    setOrdersModalOpen(true);
    try {
      const res = await fetch("/api/orders");
      const d = (await res.json()) as { orders?: SalesOrder[] };
      if (Array.isArray(d.orders)) setRecentOrders(d.orders);
    } catch {
      // ignore
    }
  };

  const copyOrderSummary = (ord: SalesOrder) => {
    const lines = [
      `🧾 ใบสรุปคำสั่งซื้อ #${ord.orderNo}`,
      `ผู้รับ: ${ord.customer.customerName}${ord.customer.shopName ? ` (${ord.customer.shopName})` : ""}`,
      `โทร: ${ord.customer.phone} | ที่อยู่: ${ord.customer.address}`,
      `ชำระเงิน: ${ord.customer.paymentMethod === "promptpay" ? "สแกนจ่าย PromptPay" : ord.customer.paymentMethod === "cod" ? "เก็บเงินปลายทาง (COD)" : "โอนบัญชีธนาคาร"}`,
      `---`,
      ...ord.cart.items.map((it, i) => `${i + 1}. ${it.title} (${it.qty} ${it.unitCode} × ${it.unitPriceFormatted}) = ${it.lineTotalFormatted}`),
      `---`,
      `💰 ยอดสุทธิรวมทั้งสิ้น: ${ord.cart.grandTotalFormatted}`,
    ];
    void navigator.clipboard?.writeText(lines.join("\n"));
    setStatusText(`คัดลอกสรุปใบสั่งซื้อ #${ord.orderNo} ลงคลิปบอร์ดแล้วครับ`);
  };

  // Remember each screen the customer settles on, so voice "ถอยกลับไป" / "เดินหน้า" can move through them.
  useEffect(() => {
    const timer = setTimeout(() => {
      const snap: ScreenSnap = { mode: stageMode, cards: stageCards, spotlight, title: stageTitle };
      setScreenHist((h) => {
        const cur = h.list[h.idx];
        if (cur && snapKey(cur) === snapKey(snap)) return h;
        const list = [...h.list.slice(0, h.idx + 1), snap].slice(-SCREEN_HISTORY_MAX);
        return { list, idx: list.length - 1 };
      });
    }, SCREEN_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [stageMode, stageCards, spotlight, stageTitle]);

  modalOpenRef.current = ordersModalOpen || helpOpen || wheelOpen || Boolean(duel);

  const goScreenHistory = useCallback((delta: number): ScreenSnap | null => {
    const h = screenHistRef.current;
    const target = Math.max(0, Math.min(h.list.length - 1, h.idx + delta));
    if (target === h.idx || !h.list[target]) return null;
    const snap = h.list[target];
    setStageCards(snap.cards);
    setSpotlight(snap.spotlight);
    setStageMode(snap.mode);
    setStageTitle(snap.title);
    setScreenHist({ list: h.list, idx: target });
    return snap;
  }, []);

  const scrollStage = useCallback((where: "down" | "up" | "top" | "bottom") => {
    const body = document.querySelector<HTMLElement>(".jc-stage-body");
    const inBody = Boolean(body && body.scrollHeight > body.clientHeight + 4);
    const el: HTMLElement | Window = inBody && body ? body : window;
    const page = (inBody && body ? body.clientHeight : window.innerHeight) * 0.75;
    const bottom = inBody && body ? body.scrollHeight : document.documentElement.scrollHeight;
    if (where === "top") el.scrollTo({ top: 0, behavior: "smooth" });
    else if (where === "bottom") el.scrollTo({ top: bottom, behavior: "smooth" });
    else el.scrollBy({ top: where === "down" ? page : -page, behavior: "smooth" });
  }, []);

  const runScreenCommand = (cmd: ScreenCommand, heard?: string) => {
    const cards = stageCardsRef.current;
    let reply = "";
    let speak = true;
    const showCard = (idx: number) => {
      const c = cards[idx];
      if (!c) return false;
      setSpotlight(c);
      setStageMode("spotlight");
      setStageTitle(c.title);
      const price = c.bestPrice ? `ราคา ${c.bestPrice.replace(/\.00$/, "")} บาท ต่อ${c.unitLabel}` : "";
      reply = `เบอร์ ${idx + 1} ${c.title} ${price}ครับ`;
      return true;
    };
    const spotIdx = () => cards.findIndex((c) => c.slug === spotlight?.slug);
    const moveHistory = (dir: -1 | 1) => {
      const steps = Math.min(cmd.no ?? 1, 20);
      const snap = goScreenHistory(dir * steps);
      if (snap) reply = `${dir < 0 ? "ถอยกลับไป" : "เดินหน้าไป"}ที่ ${snapLabel(snap)} แล้วครับ`;
      else reply = dir < 0 ? "ถอยกลับไม่ได้แล้วครับ นี่คือหน้าแรกสุดที่ดูมา" : "เดินหน้าไม่ได้แล้วครับ นี่คือหน้าล่าสุด";
    };
    const moveItem = (dir: -1 | 1) => {
      const cur = stageMode === "spotlight" ? spotIdx() : -1;
      const next = cur < 0 ? 0 : cur + dir;
      if (!showCard(next)) reply = dir > 0 ? `นี่คือตัวสุดท้ายแล้วครับ บนจอมี ${cards.length} เบอร์` : "นี่คือเบอร์ 1 ตัวแรกแล้วครับ";
    };

    // Moving anywhere else closes the wheel / duel, so voice alone never gets stuck behind an overlay.
    if (!["spin", "duel", "stop_talk", "mute", "unmute", "repeat", "mic_off", "help"].includes(cmd.id)) {
      setWheelOpen(false);
      setDuel(null);
      // A "how many?" box somebody left open must not cover the screen the customer just asked for.
      if (!cmd.id.startsWith("scroll_") && cmd.id !== "take_suggest") closeQtyModal();
    }
    switch (cmd.id) {
      case "back":
        moveHistory(-1);
        markMission("back");
        break;
      case "forward":
        moveHistory(1);
        markMission("back");
        break;
      case "spin":
        setWheelOpen(true);
        setWheelSpinKey((n) => n + 1);
        reply = "หมุนวงล้อนำโชคเลยครับ ลุ้นๆ";
        break;
      case "play_off":
        setPlayOpen(false);
        reply = "ซ่อนภารกิจแล้วครับ พูดว่า ลองเล่น เพื่อเปิดใหม่ได้ครับ";
        break;
      case "play":
        setPlayOpen(true);
        setStageMode("showcase");
        setTimeout(() => document.querySelector(".fz-play")?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
        reply = `มีภารกิจนักช้อป ${MISSIONS.length} ข้อครับ ทำครบได้ถ้วยรางวัล ลองพูดว่า หมุนวงล้อ ดูก่อนก็ได้ครับ`;
        break;
      case "duel": {
        const a = cards[(cmd.no ?? 0) - 1];
        const b = cards[(cmd.no2 ?? 0) - 1];
        if (!a || !b) {
          reply = `บนจอมีเบอร์ 1 ถึง ${cards.length} ครับ บอกสองเบอร์ที่อยากเทียบได้เลย`;
          break;
        }
        setDuel({ a, b, noA: cmd.no!, noB: cmd.no2! });
        reply = judgeDuel(a, b, cmd.no!, cmd.no2!).text;
        markMission("duel");
        break;
      }
      case "next":
        if (stageMode === "spotlight") moveItem(1);
        else moveHistory(1);
        break;
      case "next_item":
        moveItem(1);
        break;
      case "prev_item":
        moveItem(-1);
        break;
      case "home":
        setStageCards(featuredProducts);
        setSpotlight(featuredProducts[0] ?? null);
        setStageMode("showcase");
        setStageTitle("สินค้าแนะนำพร้อมขายในสมอง");
        scrollStage("top");
        reply = "กลับหน้าแรกแล้วครับ";
        break;
      case "showcase":
        setStageMode("showcase");
        reply = `บนจอมีสินค้า ${cards.length} เบอร์ครับ พูดว่า ดูเบอร์ไหน หรือ เอาเบอร์ไหนกี่ชิ้น ได้เลย`;
        break;
      case "open_no":
        markMission("open");
        if (!showCard((cmd.no ?? 0) - 1)) reply = `บนจอมีเบอร์ 1 ถึง ${cards.length} ครับ ไม่มีเบอร์ ${cmd.no}`;
        break;
      case "details": {
        // Never guess: open the product already in spotlight, or the only card, else ask for the number.
        const cur = stageMode === "spotlight" ? spotIdx() : -1;
        if (cur >= 0) showCard(cur);
        else if (cards.length === 1) showCard(0);
        else reply = cards.length > 1 ? `ดูรายละเอียดเบอร์ไหนครับ บนจอมีเบอร์ 1 ถึง ${cards.length}` : "ยังไม่มีสินค้าบนจอครับ บอกชื่อสินค้าที่อยากดูได้เลยครับ";
        break;
      }
      case "compare":
        if (latestTurn?.screenMarkdown) {
          setStageMode("compare");
          reply = "นี่คือตารางเปรียบเทียบครับ";
        } else reply = "ยังไม่มีตารางเปรียบเทียบครับ ลองพูดว่า เทียบเบอร์ 1 กับเบอร์ 2";
        break;
      case "cart":
        setStageMode("cart");
        reply = cart.items.length
          ? `ในตะกร้ามี ${cart.items.length} รายการ ยอดรวม ${bahtSpoken(cart.grandTotalFormatted)}ครับ`
          : "ตะกร้ายังว่างอยู่ครับ";
        break;
      case "checkout":
        if (!cart.items.length) {
          setStageMode("cart");
          reply = "ตะกร้ายังว่างอยู่ครับ เลือกสินค้าก่อนนะครับ";
        } else {
          setStageMode("checkout");
          reply = `ยอดรวม ${bahtSpoken(cart.grandTotalFormatted)}ครับ บอกชื่อ เบอร์โทร และวิธีจ่ายเงินได้เลยครับ`;
          const last = related ? nextSuggestion(related.cards) : null;
          if (last) reply += ` ก่อนจ่าย ตี๋แนะนำ ${last.title} ราคา ${bahtSpoken(last.priceLabel)} รับด้วยไหมครับ พูดว่า เอาด้วย ได้เลยครับ`;
        }
        break;
      case "camera":
        setStageMode("camera");
        reply = "เปิดกล้องแล้วครับ ยกสินค้าหรือบาร์โค้ดให้กล้องเห็นได้เลย";
        break;
      case "camera_close":
        setStageMode("showcase");
        reply = "ปิดกล้องแล้วครับ";
        break;
      case "scroll_down":
      case "scroll_up":
      case "scroll_top":
      case "scroll_bottom": {
        const where = cmd.id.slice(7) as "down" | "up" | "top" | "bottom";
        scrollStage(where);
        reply = { down: "เลื่อนลง", up: "เลื่อนขึ้น", top: "ขึ้นบนสุด", bottom: "ลงล่างสุด" }[where];
        speak = false;
        break;
      }
      case "stop_talk":
        stopAllAudioPlayback();
        abortRef.current?.abort();
        reply = "หยุดแล้ว";
        speak = false;
        break;
      case "repeat": {
        const last = turns.findLast((t) => !t.isCommand && t.spokenText)?.spokenText;
        reply = last ?? "ยังไม่มีอะไรให้พูดซ้ำครับ";
        break;
      }
      case "mute":
        stopAllAudioPlayback();
        setTtsEnabled(false);
        ttsEnabledRef.current = false;
        reply = "ปิดเสียงน้องตี๋แล้ว";
        speak = false;
        break;
      case "unmute":
        setTtsEnabled(true);
        ttsEnabledRef.current = true;
        reply = "เปิดเสียงแล้วครับ";
        break;
      case "mic_off":
        stopLiveCall();
        reply = "ปิดไมค์แล้วครับ กดเปิดไมค์เมื่ออยากคุยต่อนะครับ";
        break;
      case "close":
        closeQtyModal();
        setOrdersModalOpen(false);
        setHelpOpen(false);
        setWheelOpen(false);
        setDuel(null);
        reply = "ปิดแล้วครับ";
        break;
      case "orders":
        void openOrdersHistory();
        reply = "เปิดบิลขายย้อนหลังให้แล้วครับ";
        break;
      case "history": {
        const h = screenHistRef.current;
        const recent = h.list.slice(Math.max(0, h.idx - 2), h.idx + 1).map(snapLabel).reverse();
        document.querySelector(".jc-hist-nav")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        reply = h.list.length
          ? `ดูมาแล้ว ${h.list.length} หน้าจอครับ ล่าสุดคือ ${recent.join(" ก่อนหน้านั้น ")} พูดว่า ถอยกลับไป เพื่อย้อนดูได้ครับ`
          : "ยังไม่มีประวัติหน้าจอครับ";
        break;
      }
      case "related":
        void showRelated(heard);
        return;
      case "take_suggest": {
        // The offered item first; with none, "เอาด้วย" on a product page means that product.
        const c = suggestRef.current.card ?? (stageMode === "spotlight" ? spotlight : null);
        if (c) {
          suggestRef.current.card = null;
          promptAddToCart(c);
          reply = `ได้เลยครับ ${c.title} รับจำนวนเท่าไหร่ดีครับ`;
        } else reply = "ตอนนี้ยังไม่มีของที่ตี๋แนะนำครับ บอกชื่อสินค้าหรือเบอร์บนจอได้เลยครับ";
        break;
      }
      case "help":
        setHelpOpen(true);
        reply = "นี่คือคำสั่งเสียงทั้งหมดครับ พูดตามตัวอย่างบนจอได้เลย";
        break;
      case "page_search":
      case "page_brain":
      case "page_notes":
        router.push({ page_search: "/search", page_brain: "/brain", page_notes: "/n" }[cmd.id]);
        reply = "กำลังเปิดหน้าให้ครับ";
        speak = false;
        break;
    }

    reportCommand(reply, heard, speak);
  };
  runScreenCommandRef.current = runScreenCommand;

  /** "ดูของที่เกี่ยวข้อง": neighbours of the product in view (else the cart, else the cards) as numbered cards. */
  const showRelated = async (heard: string | undefined) => {
    const inView = stageMode === "spotlight" && spotlight ? [spotlight.slug] : [];
    const seeds = inView.length ? inView : cart.items.length ? cart.items.map((it) => it.slug) : stageCardsRef.current.slice(0, 3).map((c) => c.slug);
    if (!seeds.length) return reportCommand("ยังไม่มีสินค้าให้สมองหาของเกี่ยวข้องครับ บอกชื่อสินค้าก่อนนะครับ", heard, true);
    const r = await fetchRelated(seeds);
    if (!r?.cards.length) return reportCommand("สมองยังไม่เจอของที่เกี่ยวข้องกับตัวนี้ครับ", heard, true);
    setRelated(r);
    setStageCards(r.cards);
    setSpotlight(r.cards[0]);
    setStageMode("showcase");
    setStageTitle("🔗 สมองแนะนำของที่เกี่ยวข้อง");
    reportCommand(`สมองเจอของที่เกี่ยวข้อง ${r.cards.length} รายการครับ พูดว่า ใส่เบอร์ 1 หรือ ดูเบอร์ 2 ได้เลยครับ`, heard, true);
  };

  /** Chip + chat line + spoken answer for a command run on the screen (no AI). */
  const reportCommand = (reply: string, heard: string | undefined, speak: boolean) => {
    const fx: ActionFx = { id: `cmd-${performance.now()}`, kind: "cmd", text: reply.replace(/ครับ.*$/, "").trim() || reply };
    setActionFx((prev) => [...prev.slice(-2), fx]);
    actionFxTimersRef.current.push(setTimeout(() => setActionFx((prev) => prev.filter((x) => x.id !== fx.id)), ACTION_FX_MS));
    if (heard === undefined) return; // came from Nong Tee's own reply, he already speaks
    setTurns((prev) => [
      ...prev,
      { id: `cmd-${Date.now()}`, userText: heard, spokenText: reply, screenMarkdown: "", cards: [], jobs: [], model: "คำสั่งเสียง", isCommand: true },
    ]);
    if (speak && reply) enqueueOmniVoiceSentence(reply);
    setHudState(callActiveRef.current ? "listening" : "idle");
  };

  const runCouponCommand = (cmd: CouponCommand, heard: string) => {
    let reply = "";
    if (cmd.action === "remove") {
      setCouponCode("");
      reply = couponCode ? `เอาคูปองออกแล้วครับ ยอดรวม ${bahtSpoken(applyCoupon(cart, "").grandTotalFormatted)}` : "ตอนนี้ยังไม่ได้ใช้คูปองครับ";
    } else if (cmd.action === "list") {
      reply = `วันนี้มีคูปอง ${PROMOTIONS.length} ใบครับ ${PROMOTIONS.map((p) => p.title).join(" ")} พูดว่า ใช้คูปอง ได้เลยครับ`;
    } else {
      const p = findPromotion(cmd.code) ?? bestPromotion(cart.subtotal);
      const priced = applyCoupon(cart, p.code);
      setCouponCode(p.code);
      setCouponPulse((n) => n + 1);
      reply = priced.coupon?.applied
        ? `ใช้คูปอง ${p.title} แล้วครับ ลดไป ${bahtSpoken(priced.discountFormatted ?? "฿0")} เหลือจ่าย ${bahtSpoken(priced.grandTotalFormatted)}`
        : cart.items.length
          ? `เก็บคูปอง ${p.title} ไว้ให้แล้วครับ ${priced.coupon?.note ?? ""}`
          : `เก็บคูปอง ${p.title} ไว้ให้แล้วครับ ใส่สินค้าแล้วระบบลดให้อัตโนมัติครับ`;
    }
    setWheelOpen(false);
    setStageMode("cart");
    setStageTitle("คูปองส่วนลด");
    setTimeout(() => document.querySelector(".cart-coupons")?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
    reportCommand(reply, heard, true);
  };
  runCouponCommandRef.current = runCouponCommand;

  const runBudget = (amount: string, heard: string) => {
    budgetWarnRef.current = "";
    setWheelOpen(false);
    setDuel(null);
    if (amount === "0") {
      setBudget("");
      reportCommand("ยกเลิกงบแล้วครับ ช้อปได้เต็มที่เลยครับ", heard, true);
      return;
    }
    setBudget(amount);
    markMission("budget");
    reportCommand(`ตั้งงบ ${amount} บาทแล้วครับ ตี๋จะคอยเตือนเมื่อใกล้ถึงงบครับ`, heard, true);
  };
  runBudgetRef.current = runBudget;

  // Something new went into the cart (voice, card number, button): picture flies in + "ติ๊ง".
  useEffect(() => {
    const now = new Map(cart.items.map((it) => [`${it.slug}::${it.unitCode}`, it.qty]));
    const prev = prevPiecesRef.current;
    prevPiecesRef.current = now;
    if (!prev) return;
    const grown = cart.items.find((it) => (now.get(`${it.slug}::${it.unitCode}`) ?? 0) > (prev.get(`${it.slug}::${it.unitCode}`) ?? 0));
    if (!grown) return;
    flyToCart(grown.slug);
    playTing("add");
    markMission("add");
    // Always suggest one related item after an add (no AI call): picked from brain hubs, spoken once per item.
    void fetchRelated([grown.slug]).then((r) => {
      if (!r?.cards.length) return;
      setRelated(r);
      const pick = nextSuggestion(r.cards);
      if (!pick) return;
      const say = `ตี๋แนะนำ ${pick.title} ราคา ${bahtSpoken(pick.priceLabel)} รับด้วยไหมครับ พูดว่า เอาด้วย ได้เลยครับ`;
      reportCommand(`🔗 แนะนำ: ${pick.title}`, undefined, false);
      enqueueOmniVoiceSentence(say);
    });
  }, [cart.items, markMission]);

  useEffect(() => {
    if (stageMode !== "spotlight" || !spotlight) return;
    const slug = spotlight.slug;
    if (spotRelated?.slug === slug) return;
    let alive = true;
    void fetchRelated([slug]).then((r) => alive && r && setSpotRelated({ slug, set: r }));
    return () => {
      alive = false;
    };
  }, [stageMode, spotlight, spotRelated?.slug]);

  // Budget voice warnings, once per level.
  useEffect(() => {
    if (!budget || !cart.items.length) return;
    const b = Number.parseInt(budget, 10) * 100;
    const [i, d = "00"] = cart.grandTotal.split(".");
    const spent = Number.parseInt(i, 10) * 100 + Number.parseInt(d.slice(0, 2), 10); // integer satang
    const level = spent > b ? "over" : spent * 10 >= b * 8 ? "near" : "";
    if (!level || level === budgetWarnRef.current) return;
    budgetWarnRef.current = level;
    enqueueOmniVoiceSentence(
      level === "over"
        ? `เกินงบ ${budget} บาทแล้วนะครับ ลองเอาบางอย่างออก หรือพูดว่า ใช้คูปอง ช่วยลดได้ครับ`
        : `ใกล้ถึงงบแล้วครับ ยอดตอนนี้ ${bahtSpoken(cart.grandTotalFormatted)}`,
    );
  }, [budget, cart.grandTotal, cart.grandTotalFormatted, cart.items.length, enqueueOmniVoiceSentence]);

  // Order closed: confetti + win jingle.
  useEffect(() => {
    if (!confirmedOrder || confirmedOrder.orderNo === lastOrderNoRef.current) return;
    lastOrderNoRef.current = confirmedOrder.orderNo;
    suggestRef.current = { card: null, offered: new Set() }; // new order, fresh offers
    burstConfetti();
    playTing("win");
    markMission("order");
    setBudget("");
  }, [confirmedOrder, markMission]);

  const latestTurn = turns.findLast((t) => !t.isCommand) ?? null;
  const latestJobs = useMemo(() => latestTurn?.jobs ?? [], [latestTurn]);

  return (
    <div
      className={`jc-root${dragActive ? " drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("image/"));
        if (f) void handleQuickPhotoFile(f);
      }}
    >
      <input
        ref={quickPhotoInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handleQuickPhotoFile(f);
        }}
      />

      {lastAddedNotice && <div className="jc-toast">🛒 {lastAddedNotice}</div>}

      {audioUnlockNeeded && (
        <button
          type="button"
          className="jc-unlock-banner"
          onClick={() => {
            setAudioUnlockNeeded(false);
            void audioCtxRef.current?.resume().catch(() => {});
            void blockedAudioRef.current?.play().catch(() => {});
          }}
        >
          🔊 น้องตี๋เริ่มทำงานแล้วครับ — แตะตรงไหนก็ได้ 1 ครั้งเพื่อเปิดเสียงพูดของน้องตี๋
        </button>
      )}

      <div className="jc-grid">
        {/* ==================== LEFT COLUMN: NONG TEE VOICE & CHAT ==================== */}
        <section className="jc-left" aria-label="สนทนากับเลขาน้องตี๋">
          <div className="jc-agent-bar">
            <div className="jm-hud" data-state={hudState}>
              <svg viewBox="0 0 44 44">
                <circle cx="22" cy="22" r="19" className="jm-ring-bg" />
                <circle cx="22" cy="22" r="19" className="jm-ring-spin" />
              </svg>
              <span>🧑‍💼</span>
            </div>
            <div className="jc-agent-meta">
              <div className="jc-agent-title-row">
                <h1>น้องตี๋ · Javis ปิดการขาย</h1>
                <span className={`jc-voice-pill${voiceEngineOnline ? " online" : ""}`}>
                  {voiceEngineOnline ? "OmniVoice GPU" : "Active"}
                </span>
              </div>
              <p className="jc-status-line" data-state={hudState}>
                {statusText}
              </p>
            </div>
          </div>

          {/* Call, Mic Mute, Speaker, Device Picker & Model Controls — single clean baseline */}
          <div className="jc-call-controls">
            <button
              type="button"
              className={`jc-call-btn${callActive ? " active" : ""}`}
              onClick={() => void startLiveCall()}
            >
              {callActive ? "📴 พักสาย" : "📞 เปิดไมค์สด"}
            </button>

            {callActive && (
              <button
                type="button"
                className={`jc-ctrl-pill${micMuted ? " muted" : ""}`}
                aria-pressed={micMuted}
                onClick={toggleMicMute}
                title="เปิดหรือปิดไมโครโฟนชั่วคราวโดยสายไม่หลุด"
              >
                {micMuted ? "🔇 เปิดไมค์" : "🎙️ ปิดไมค์"}
              </button>
            )}

            <button
              type="button"
              className="jc-ctrl-pill"
              aria-pressed={ttsEnabled}
              onClick={() => {
                if (ttsEnabled) stopAllAudioPlayback();
                setTtsEnabled((v) => !v);
              }}
              title="เปิดหรือปิดเสียงพูดของน้องตี๋"
            >
              {ttsEnabled ? "🔊 เสียง" : "🔇 เงียบ"}
            </button>

            <DevicePickerPopover
              activeMicStream={activeMicStreamState}
              onOpenCameraScanner={() => setStageMode("camera")}
              onSelectPhotoFile={(f) => void handleQuickPhotoFile(f)}
            />
          </div>

          {(liveKaraokeText || liveUserHeard) && (
            <div className="jc-karaoke-box">
              {liveUserHeard ? (
                <p className="jc-k-user">🎤 ได้ยินว่า: “{liveUserHeard}”</p>
              ) : (
                <KaraokeWords text={liveKaraokeText} pct={karaokeProgress} />
              )}
            </div>
          )}

          {latestJobs.length > 0 && (
            <div className="jc-workers-strip">
              {latestJobs.slice(-4).map((j) => (
                <span key={j.id} className={`jc-wchip st-${j.state}`}>
                  <i className="jm-dot" />
                  <b>{j.label}</b>
                  {j.ms !== undefined && <small>{j.ms}ms</small>}
                </span>
              ))}
            </div>
          )}

          <div className="jc-chat-stream" ref={chatScrollRef}>
            {turns.length === 0 ? (
              <div className="jc-chat-welcome">
                <p className="jc-greet-bubble">
                  <strong>🟢 สวัสดีครับ! น้องตี๋พร้อมรับคำสั่งแล้วครับ 🙏</strong>
                  <br />
                  พูดสั่งด้วยเสียงได้เลย หรือกด <b>📷 ส่องกล้อง / ส่งรูปสินค้า</b> ถ้าน้องตี๋เห็นรูปสินค้าจะวิ่งค้นในสมองและหยิบมาให้เลือกใส่ตะกร้าทันทีครับ!
                </p>

                <div className="jc-vision-quick-row">
                  <button
                    type="button"
                    className="btn primary jc-vbtn-main"
                    onClick={() => setStageMode("camera")}
                  >
                    📷 เปิดกล้องส่องหาสินค้า
                  </button>
                  <button
                    type="button"
                    className="btn jc-vbtn-sub"
                    disabled={visionUploading}
                    onClick={() => quickPhotoInputRef.current?.click()}
                  >
                    {visionUploading ? "🔍 กำลังค้นรูป…" : "🖼️ เลือกรูปสินค้าไปหาเลย"}
                  </button>
                </div>

                <div className="jc-scenario-list">
                  {QUICK_SCENARIOS.map((sc) => (
                    <button
                      key={sc.label}
                      type="button"
                      className="jc-scenario-btn"
                      onClick={() => void sendTurn(sc.prompt)}
                    >
                      <span>{sc.icon}</span>
                      <span>{sc.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((t) => (
                <article key={t.id} className="jc-turn-card">
                  <div className="jc-u-msg">
                    {t.imagePreview && (
                      <img src={t.imagePreview} alt="รูปสินค้าที่ค้นหา" className="jc-u-thumb" />
                    )}
                    <div>
                      <span>คุณ:</span> {t.userText}
                    </div>
                  </div>
                  <div className="jc-b-msg">
                    <div className="jc-b-head">
                      <b>🧑‍💼 น้องตี๋</b>
                      {t.spokenText && (
                        <button
                          type="button"
                          className="jc-replay-sm"
                          onClick={() => enqueueOmniVoiceSentence(t.spokenText)}
                        >
                          🔊 ฟังเสียง
                        </button>
                      )}
                    </div>
                    {t.error ? (
                      <p className="jm-error">{t.error}</p>
                    ) : (
                      <p className="jc-b-spoken">
                        {t.spokenText || "น้องตี๋กำลังค้นสมองและเตรียมคำตอบสักครู่ครับ…"}
                      </p>
                    )}

                    {t.cards.length > 0 && (
                      <div className="jc-ans-products">
                        <div className="jc-ans-lbl">กดเลือกใส่ตะกร้า (ระบุจำนวนได้) หรือแตะดูภาพใหญ่:</div>
                        {t.cards.slice(0, 5).map((c) => (
                          <div key={c.slug} className="jc-ans-item">
                            <button
                              type="button"
                              className="jc-ans-pick"
                              onClick={() => {
                                setSpotlight(c);
                                setStageMode("spotlight");
                                setStageTitle(c.title);
                              }}
                            >
                              {c.imageUrl ? <img src={c.imageUrl} alt="" /> : <span>📦</span>}
                              <span className="jc-ans-name">{c.title}</span>
                              <strong className="jc-ans-price">{c.priceLabel}</strong>
                            </button>
                            <button
                              type="button"
                              className="jc-ans-addbtn"
                              onClick={() => promptAddToCart(c)}
                            >
                              🛒 ใส่ตะกร้า
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>

          <form
            className="jc-input-bar"
            onSubmit={(e) => {
              e.preventDefault();
              void sendTurn(input);
            }}
          >
            <button
              type="button"
              className={`jc-cam-icon-btn${stageMode === "camera" ? " active" : ""}`}
              onClick={() => setStageMode(stageMode === "camera" ? "showcase" : "camera")}
              title="เปิดกล้องส่องหาสินค้า"
              aria-label="เปิดกล้องส่องหาสินค้า"
            >
              📷
            </button>
            <button
              type="button"
              className="jc-cam-icon-btn"
              disabled={visionUploading}
              onClick={() => quickPhotoInputRef.current?.click()}
              title="เลือกรูปสินค้าหรือวางรูป (Ctrl+V) เพื่อค้นหาทันที"
              aria-label="เลือกรูปสินค้าเพื่อค้นหา"
            >
              🖼️
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="พิมพ์คุย วางรูป (Ctrl+V) หรือสั่ง เช่น เอาไฮคิว 5 กล่อง…"
              aria-label="พิมพ์ข้อความคุยกับน้องตี๋"
              disabled={busy}
            />
            {busy ? (
              <button type="button" className="jm-stop-btn" onClick={() => abortRef.current?.abort()}>
                หยุด
              </button>
            ) : (
              <button type="submit" className="jc-send-btn" disabled={!input.trim()}>
                ส่ง
              </button>
            )}
          </form>
        </section>

        {/* ==================== CENTER COLUMN: CONTEXT-DRIVEN VISUAL STAGE ==================== */}
        <section className="jc-stage" aria-label="หน้าจอแสดงภาพตามบริบทการสนทนา">
          <div className="jc-hist-nav" aria-label="ประวัติหน้าจอ">
            <button
              type="button"
              className="jc-hist-btn"
              disabled={screenHist.idx <= 0}
              onClick={() => runScreenCommand({ id: "back" })}
              title='พูดว่า "ถอยกลับไป"'
            >
              ◀ ถอยกลับ
            </button>
            <span className="jc-hist-pos">
              หน้าจอ {Math.max(screenHist.idx + 1, 0)}/{screenHist.list.length}
            </span>
            <button
              type="button"
              className="jc-hist-btn"
              disabled={screenHist.idx >= screenHist.list.length - 1}
              onClick={() => runScreenCommand({ id: "forward" })}
              title='พูดว่า "เดินหน้า"'
            >
              เดินหน้า ▶
            </button>
            <button type="button" className="jc-hist-btn jc-hist-help" onClick={() => setHelpOpen(true)}>
              🎙️ คำสั่งเสียง
            </button>
            <button type="button" className="jc-hist-btn fz-spin-btn" onClick={() => setWheelOpen(true)} title='พูดว่า "หมุนวงล้อ"'>
              🎡 วงล้อนำโชค
            </button>
            <button
              type="button"
              className="jc-hist-btn"
              onClick={() => {
                setPlayOpen(true);
                setStageMode("showcase");
              }}
              title='พูดว่า "ลองเล่น"'
            >
              🎮 ภารกิจ {MISSIONS.filter((m) => missions[m.key]).length}/{MISSIONS.length}
            </button>
          </div>
          {budget && <BudgetBar budget={budget} cart={cart} onClear={() => setBudget("")} />}
          <div className="jc-stage-tabs">
            <button
              type="button"
              className={`jc-stab${stageMode === "welcome" || stageMode === "showcase" ? " active" : ""}`}
              onClick={() => setStageMode("showcase")}
            >
              🖼️ ภาพสินค้า ({stageCards.length})
            </button>
            <button
              type="button"
              className={`jc-stab${stageMode === "camera" ? " active" : ""}`}
              onClick={() => setStageMode("camera")}
            >
              📷 กล้องหาสินค้า
            </button>
            {spotlight && (
              <button
                type="button"
                className={`jc-stab${stageMode === "spotlight" ? " active" : ""}`}
                onClick={() => setStageMode("spotlight")}
              >
                🔍 เจาะลึกสินค้า
              </button>
            )}
            {latestTurn?.screenMarkdown && (
              <button
                type="button"
                className={`jc-stab${stageMode === "compare" ? " active" : ""}`}
                onClick={() => setStageMode("compare")}
              >
                📊 ตารางเปรียบเทียบ
              </button>
            )}
            <button
              type="button"
              className={`jc-stab${stageMode === "cart" ? " active" : ""}`}
              onClick={() => setStageMode("cart")}
              data-cart-target
            >
              🛒 ตะกร้า ({cart.itemCount})
            </button>
            <button
              type="button"
              className={`jc-stab${stageMode === "checkout" ? " active" : ""}`}
              onClick={() => setStageMode("checkout")}
            >
              💳 ปิดการขาย
            </button>
            <button type="button" className="jc-stab jc-stab-orders" onClick={() => void openOrdersHistory()}>
              🧾 บิลขาย
            </button>
          </div>

          <div className="jc-stage-body">
            {busy && <ThinkingBrain jobs={latestJobs} cards={latestTurn?.cards ?? []} />}
            {wheelOpen && (
              <LuckyWheel
                onWin={(p) => {
                  setCouponCode(p.code);
                  setCouponPulse((n) => n + 1);
                  burstConfetti();
                  playTing("win");
                  markMission("spin");
                  enqueueOmniVoiceSentence(`ยินดีด้วยครับ ได้คูปอง ${p.title} ใส่ให้ในตะกร้าแล้วครับ`);
                }}
                spinKey={wheelSpinKey}
                onClose={() => {
                  setWheelOpen(false);
                  if (couponCodeRef.current) setStageMode("cart");
                }}
              />
            )}
            {duel && (
              <DuelView
                {...duel}
                onClose={() => setDuel(null)}
                onAdd={(c) => {
                  setDuel(null);
                  promptAddToCart(c);
                }}
              />
            )}
            {helpOpen && (
              <div className="jc-help" role="dialog" aria-label="คำสั่งเสียงทั้งหมด">
                <div className="jc-help-head">
                  <b>🎙️ พูดสั่งได้เลย ไม่ต้องแตะเมาส์</b>
                  <button type="button" className="btn" onClick={() => setHelpOpen(false)}>
                    ปิด
                  </button>
                </div>
                <div className="jc-help-grid">
                  <div className="jc-help-item">
                    <b>ใส่ตะกร้าตามเบอร์</b>
                    <span>“เอาเบอร์ 5 สิบชิ้น” · “เบอร์ 2 สองแพ็ค”</span>
                  </div>
                  {COMMAND_HELP.map((c) => (
                    <div key={c.id} className="jc-help-item">
                      <b>{c.label}</b>
                      <span>{c.examples.map((e) => `“${e}”`).join(" · ")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {actionFx.length > 0 && (
              <div className="jc-action-fx" role="status" aria-live="polite">
                {actionFx.map((fx) => (
                  <div key={fx.id} className={`jc-action-chip ${fx.kind}`}>
                    <span className="jc-action-icon">
                      {fx.kind === "add" ? "✅" : fx.kind === "ask" ? "❓" : fx.kind === "cmd" ? "🤖" : "⚠️"}
                    </span>
                    <span>{fx.text}</span>
                    {fx.kind === "add" && <span className="jc-action-cart">🛒</span>}
                  </div>
                ))}
              </div>
            )}
            {stageMode === "camera" && (
              <ProductVisionScanner
                onProductFound={handleVisionResult}
                onClose={() => setStageMode("showcase")}
              />
            )}

            {(stageMode === "welcome" || stageMode === "showcase") && (
              <div className="st-showcase">
                {playOpen && (
                  <PlayPanel done={missions} onSay={(t) => void sendTurnRef.current(t)} onClose={() => setPlayOpen(false)} />
                )}
                <div className="st-head">
                  <div>
                    <h2>{stageTitle}</h2>
                    <p className="muted">
                      คลังสมองเชื่อมโยงสินค้าจริง {totalProductsCount.toLocaleString("th-TH")} รายการ · ภาพเปลี่ยนอัตโนมัติตามเรื่องที่คุยหรือรูปที่ส่อง
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="btn" onClick={() => setStageMode("camera")}>
                      📷 ส่องกล้องหาสินค้า
                    </button>
                    {latestTurn?.screenMarkdown && (
                      <button type="button" className="btn" onClick={() => setStageMode("compare")}>
                        📊 ดูตารางสรุปจากน้องตี๋
                      </button>
                    )}
                  </div>
                </div>

                <div className="st-cards-grid">
                  {stageCards.map((c, cardIdx) => (
                    <article
                      key={c.slug}
                      data-slug={c.slug}
                      className={`st-card${actionFx.some((fx) => fx.slug === c.slug) ? ` fx-${actionFx.findLast((fx) => fx.slug === c.slug)!.kind}` : ""}`}
                    >
                      <button
                        type="button"
                        className="st-img-btn"
                        onClick={() => {
                          setSpotlight(c);
                          setStageMode("spotlight");
                        }}
                      >
                        {c.imageUrl ? <img src={c.imageUrl} alt={c.title} loading="lazy" /> : <span>📦</span>}
                        <span className="p-no-badge" aria-label={`เบอร์ ${cardIdx + 1}`}>
                          {cardIdx + 1}
                        </span>
                        {c.unitOptions.length > 1 && (
                          <span className="p-multi-badge">{c.unitOptions.length} หน่วยนับ</span>
                        )}
                      </button>

                      <div className="st-card-body">
                        <div className="p-meta-top">
                          <span className="p-brand">{c.brand}</span>
                          <span className="p-unit-chip">{c.unitLabel}</span>
                        </div>
                        <h3
                          onClick={() => {
                            setSpotlight(c);
                            setStageMode("spotlight");
                          }}
                        >
                          {c.title}
                        </h3>
                        <div className="p-price-row">
                          <span className="p-price">{c.priceLabel}</span>
                          <span className="p-per-unit">/{c.unitCode}</span>
                          {c.pricePerBaseLabel && <span className="p-base-calc">({c.pricePerBaseLabel})</span>}
                        </div>

                        {c.traits.length > 0 && (
                          <div className="p-traits">
                            {c.traits.slice(0, 3).map((tr, idx) => (
                              <span key={`${tr}-${idx}`} className="p-trait-tag">
                                {tr}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="st-card-actions">
                          <button
                            type="button"
                            className="btn primary st-add-btn"
                            onClick={() => promptAddToCart(c)}
                          >
                            🛒 ใส่ตะกร้า (เลือกจำนวน)
                          </button>
                          <button
                            type="button"
                            className="p-btn-detail"
                            onClick={() => {
                              setSpotlight(c);
                              setStageMode("spotlight");
                            }}
                          >
                            ดูละเอียด
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}

            {stageMode === "spotlight" && spotlight && (
              <div className="st-spotlight">
                <div className="sp-top-bar">
                  <button type="button" className="btn" onClick={() => setStageMode("showcase")}>
                    ‹ กลับหน้ารวมสินค้า
                  </button>
                  <Link href={`/n/${encodeURIComponent(spotlight.slug)}`} className="btn">
                    🧠 เปิดหน้าเซลล์สมองเต็ม
                  </Link>
                </div>

                <div className="sp-hero">
                  <div className="sp-img-stage">
                    {spotlight.imageUrl ? (
                      <img src={spotlight.imageUrl} alt={spotlight.title} />
                    ) : (
                      <div className="p-noimg">📦</div>
                    )}
                  </div>

                  <div className="sp-details">
                    <span className="p-brand">{spotlight.brand} · {spotlight.category}</span>
                    <h2>{spotlight.title}</h2>
                    <div className="sp-price-box">
                      <strong className="sp-big-price">{spotlight.priceLabel}</strong>
                      <span>/ {spotlight.unitLabel}</span>
                      {spotlight.pricePerBaseLabel && (
                        <span className="p-base-calc">เฉลี่ย {spotlight.pricePerBaseLabel}</span>
                      )}
                    </div>

                    {spotlight.barcode && (
                      <p className="muted">
                        บาร์โค้ด: <code>{spotlight.barcode}</code>{" "}
                        {spotlight.isThaiGs1 && <span className="p-gs1">GS1 ไทย 885</span>} · รหัส: <code>{spotlight.productCode}</code>
                      </p>
                    )}

                    {spotlight.traits.length > 0 && (
                      <div className="p-traits">
                        {spotlight.traits.map((tr, i) => (
                          <span key={`${tr}-${i}`} className="p-trait-tag">
                            {tr}
                          </span>
                        ))}
                      </div>
                    )}

                    {spotlight.unitOptions.length > 0 && (
                      <div className="sp-units-box">
                        <h4>หน่วยนับและราคาในสมอง:</h4>
                        <div className="qty-unit-pills">
                          {spotlight.unitOptions.map((uo) => (
                            <span key={uo.unitCode} className="qty-upill">
                              <span>{uo.label}</span>
                              <b>{uo.priceFormatted}</b>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="sp-cta-row">
                      <button
                        type="button"
                        className="btn primary sp-buy-btn"
                        onClick={() => promptAddToCart(spotlight)}
                      >
                        🛒 กดใส่ตะกร้า (เลือกจำนวน/หน่วย)
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          void sendTurn(`ตี๋ ช่วยหาสินค้าตัวอื่นที่คล้ายกับ "${spotlight.title}" มาเปรียบเทียบความคุ้มค่าให้ดูหน่อยครับ`)
                        }
                      >
                        🧑‍💼 ให้น้องตี๋เทียบตัวอื่น
                      </button>
                    </div>

                    {spotlight.description && <p className="sp-desc">{spotlight.description}</p>}
                    {spotlight.ingredients && (
                      <p className="sp-desc">
                        <b>ส่วนประกอบ:</b> {spotlight.ingredients}
                      </p>
                    )}
                  </div>
                </div>

                {spotRelated?.slug === spotlight.slug && (
                  <RelatedStrip
                    cards={spotRelated.set.cards}
                    reasons={spotRelated.set.reasons}
                    excludeSlugs={[spotlight.slug]}
                    onAdd={promptAddToCart}
                    onShowAll={() => void showRelated(undefined)}
                  />
                )}

                {latestTurn?.screenMarkdown && (
                  <div
                    className="jm-screen-md md"
                    style={{ marginTop: 16 }}
                    dangerouslySetInnerHTML={{ __html: renderSafeMd(latestTurn.screenMarkdown) }}
                  />
                )}
              </div>
            )}

            {stageMode === "compare" && (
              <div className="st-compare">
                <div className="st-head">
                  <h2>📊 ตารางเปรียบเทียบและรายละเอียดจากน้องตี๋</h2>
                  <button type="button" className="btn" onClick={() => setStageMode("showcase")}>
                    🖼️ ดูภาพสินค้า
                  </button>
                </div>
                {latestTurn?.screenMarkdown ? (
                  <div
                    className="jm-screen-md md"
                    dangerouslySetInnerHTML={{ __html: renderSafeMd(latestTurn.screenMarkdown) }}
                  />
                ) : (
                  <p className="muted">ยังไม่มีตารางเปรียบเทียบในรอบนี้ครับ</p>
                )}
                {stageCards.length > 0 && (
                  <div className="cmp-quick-buy">
                    <h3>เลือกกดใส่ตะกร้าจากรายการที่เปรียบเทียบ:</h3>
                    <div className="jc-ans-products">
                      {stageCards.slice(0, 8).map((c, cardIdx) => (
                        <div key={c.slug} className="jc-ans-item">
                          <div className="jc-ans-pick">
                            <span className="p-no-badge inline">{cardIdx + 1}</span>
                            {c.imageUrl ? <img src={c.imageUrl} alt="" /> : <span>📦</span>}
                            <span className="jc-ans-name">{c.title}</span>
                            <strong className="jc-ans-price">{c.priceLabel}/{c.unitCode}</strong>
                          </div>
                          <button type="button" className="jc-ans-addbtn" onClick={() => promptAddToCart(c)}>
                            🛒 ใส่ตะกร้า
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {stageMode === "cart" && (
              <div className="st-cart">
                <div className="st-head">
                  <h2>🛒 ตะกร้าสินค้าของคุณ ({cart.itemCount} รายการ)</h2>
                  {cart.items.length > 0 && (
                    <button type="button" className="btn-reset-sm" onClick={clearCart}>
                      ล้างตะกร้าทั้งหมด
                    </button>
                  )}
                </div>

                <CouponStrip
                  cart={cart}
                  couponCode={couponCode}
                  pulseKey={couponPulse}
                  onPick={(code) => {
                    setCouponCode(code);
                    if (code) setCouponPulse((n) => n + 1);
                  }}
                />

                {cart.items.length === 0 ? (
                  <div className="wb-empty">
                    <p>ตะกร้ายังว่างอยู่ครับ บอกน้องตี๋ ส่องกล้องรูปสินค้า หรือเลือกจากหน้าภาพสินค้าได้เลยครับ</p>
                    <button type="button" className="btn primary" onClick={() => setStageMode("showcase")}>
                      🖼️ ไปเลือกชมสินค้า
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="cart-list-full">
                      {cart.items.map((it) => (
                        <div
                          key={`${it.slug}-${it.unitCode}`}
                          className={`cart-row-card${lastChangedSlug === it.slug ? " highlight" : ""}`}
                        >
                          {it.imageUrl ? (
                            <img src={it.imageUrl} alt={it.title} className="cart-row-img" />
                          ) : (
                            <div className="jm-prod-noimg">📦</div>
                          )}
                          <div className="cart-row-info">
                            <span className="p-brand">{it.brand}</span>
                            <h4>{it.title}</h4>
                            <span className="muted">
                              ราคา {it.unitPriceFormatted} / {it.unitCode}
                            </span>
                          </div>
                          <div className="cart-row-qty">
                            <button
                              type="button"
                              className="qty-step-btn sm"
                              onClick={() => updateCartQty(it.slug, it.unitCode, it.qty - 1)}
                            >
                              −
                            </button>
                            <span className="cart-qty-num">{it.qty}</span>
                            <button
                              type="button"
                              className="qty-step-btn sm"
                              onClick={() => updateCartQty(it.slug, it.unitCode, it.qty + 1)}
                            >
                              +
                            </button>
                          </div>
                          <div className="cart-row-total">
                            <strong>{it.lineTotalFormatted}</strong>
                            <button
                              type="button"
                              className="cart-del-btn"
                              onClick={() => removeFromCart(it.slug, it.unitCode)}
                            >
                              ลบ
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="cart-grand-box">
                      <div>
                        <span>รวมทั้งหมด {cart.totalPieces} หน่วย ({cart.itemCount} รายการ)</span>
                        {cart.coupon?.applied && (
                          <span className="cart-disc-line">
                            ยอดสินค้า {cart.subtotalFormatted} · 🎟️ {cart.coupon.code} −{cart.coupon.discountFormatted}
                          </span>
                        )}
                        <strong className="cart-grand-num">
                          <CountUpBaht value={cart.grandTotal} formatted={cart.grandTotalFormatted} />
                        </strong>
                      </div>
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => setStageMode("checkout")}
                      >
                        💳 ไปหน้าปิดการขาย / ชำระเงิน →
                      </button>
                    </div>
                  </>
                )}

                {related && (
                  <RelatedStrip
                    cards={related.cards}
                    reasons={related.reasons}
                    excludeSlugs={cart.items.map((it) => it.slug)}
                    onAdd={promptAddToCart}
                    onShowAll={() => void showRelated(undefined)}
                  />
                )}
              </div>
            )}

            {stageMode === "checkout" && (
              <div className="st-checkout">
                <h2>💳 สรุปใบสั่งซื้อ & ปิดการขาย</h2>
                <p className="muted">
                  กรอกข้อมูลด้านล่าง หรือพูดบอกน้องตี๋ด้วยเสียง เช่น “ส่งร้านลุงจืด เบอร์ 089-xxx-xxxx เก็บเงินปลายทาง ยืนยันสั่งซื้อเลย”
                </p>

                {cart.items.length === 0 ? (
                  <div className="wb-empty">
                    <p>ยังไม่มีสินค้าในตะกร้าครับ</p>
                    <button type="button" className="btn primary" onClick={() => setStageMode("showcase")}>
                      ไปเลือกสินค้าก่อน
                    </button>
                  </div>
                ) : (
                  <div className="chk-grid">
                    <div className="chk-form">
                      <label>
                        <span>ชื่อผู้รับสินค้า *</span>
                        <input
                          type="text"
                          value={customer.customerName}
                          onChange={(e) => updateCustomer({ customerName: e.target.value })}
                          placeholder="เช่น ลุงจืด / คุณสมชาย"
                        />
                      </label>
                      <label>
                        <span>ชื่อร้านค้า / บริษัท (ถ้ามี)</span>
                        <input
                          type="text"
                          value={customer.shopName}
                          onChange={(e) => updateCustomer({ shopName: e.target.value })}
                          placeholder="เช่น ร้านโชห่วยรุ่งเรือง"
                        />
                      </label>
                      <label>
                        <span>เบอร์โทรศัพท์ติดต่อ *</span>
                        <input
                          type="text"
                          value={customer.phone}
                          onChange={(e) => updateCustomer({ phone: e.target.value })}
                          placeholder="08x-xxx-xxxx"
                        />
                      </label>
                      <label>
                        <span>ที่อยู่จัดส่ง</span>
                        <input
                          type="text"
                          value={customer.address}
                          onChange={(e) => updateCustomer({ address: e.target.value })}
                          placeholder="บ้านเลขที่ ถนน ตำบล อำเภอ จังหวัด"
                        />
                      </label>
                      <label>
                        <span>วิธีชำระเงิน</span>
                        <div className="pm-options">
                          {(
                            [
                              ["promptpay", "📱 สแกนจ่าย PromptPay QR"],
                              ["cod", "🚚 เก็บเงินปลายทาง (COD)"],
                              ["transfer", "🏦 โอนบัญชีธนาคาร"],
                            ] as const
                          ).map(([val, lbl]) => (
                            <button
                              key={val}
                              type="button"
                              className={`pm-btn${customer.paymentMethod === val ? " active" : ""}`}
                              onClick={() => updateCustomer({ paymentMethod: val as PaymentMethod })}
                            >
                              {lbl}
                            </button>
                          ))}
                        </div>
                      </label>
                    </div>

                    <div className="chk-summary-card">
                      <h3>สรุปรายการสั่งซื้อ ({cart.itemCount} รายการ)</h3>
                      <ul className="chk-item-list">
                        {cart.items.map((it) => (
                          <li key={`${it.slug}-${it.unitCode}`}>
                            <span>
                              {it.title} × {it.qty} {it.unitCode}
                            </span>
                            <b>{it.lineTotalFormatted}</b>
                          </li>
                        ))}
                      </ul>
                      {cart.coupon?.applied && (
                        <div className="chk-disc-line">
                          <span>🎟️ คูปอง {cart.coupon.code}</span>
                          <b>−{cart.coupon.discountFormatted}</b>
                        </div>
                      )}
                      <div className="chk-total-line">
                        <span>ยอดสุทธิทั้งสิ้น</span>
                        <strong>{cart.grandTotalFormatted}</strong>
                      </div>
                      <button
                        type="button"
                        className="btn primary chk-submit-btn"
                        disabled={placingOrderManual}
                        onClick={() => void handleManualPlaceOrder()}
                      >
                        {placingOrderManual ? "กำลังออกใบสั่งซื้อ…" : `✅ ยืนยันปิดการขาย (${cart.grandTotalFormatted})`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {stageMode === "order_confirmed" && confirmedOrder && (
              <div className="st-receipt">
                <div className="rc-banner">
                  <span className="rc-check">🎉</span>
                  <div>
                    <h2>ปิดการขายสำเร็จ! ใบสั่งซื้อ #{confirmedOrder.orderNo}</h2>
                    <p>บันทึกคำสั่งซื้อเรียบร้อยแล้ว · ขอบคุณที่อุดหนุนครับ</p>
                  </div>
                </div>

                <div className="rc-grid">
                  <div className="rc-details">
                    <h3>ข้อมูลจัดส่งและชำระเงิน</h3>
                    <p><b>ผู้รับ:</b> {confirmedOrder.customer.customerName} {confirmedOrder.customer.shopName ? `(${confirmedOrder.customer.shopName})` : ""}</p>
                    <p><b>เบอร์โทร:</b> {confirmedOrder.customer.phone}</p>
                    <p><b>ที่อยู่จัดส่ง:</b> {confirmedOrder.customer.address}</p>
                    <p>
                      <b>วิธีชำระเงิน:</b>{" "}
                      {confirmedOrder.customer.paymentMethod === "promptpay"
                        ? "สแกนจ่าย PromptPay QR"
                        : confirmedOrder.customer.paymentMethod === "cod"
                          ? "เก็บเงินปลายทาง (COD)"
                          : "โอนบัญชีธนาคาร"}
                    </p>

                    <table className="p-table" style={{ marginTop: 12 }}>
                      <thead>
                        <tr>
                          <th>รายการสินค้า</th>
                          <th>จำนวน</th>
                          <th className="num">ราคา/หน่วย</th>
                          <th className="num">รวม</th>
                        </tr>
                      </thead>
                      <tbody>
                        {confirmedOrder.cart.items.map((it) => (
                          <tr key={`${it.slug}-${it.unitCode}`}>
                            <td>{it.title}</td>
                            <td>{it.qty} {it.unitCode}</td>
                            <td className="num">{it.unitPriceFormatted}</td>
                            <td className="num"><b>{it.lineTotalFormatted}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {confirmedOrder.cart.coupon?.applied && (
                      <div className="chk-disc-line">
                        <span>
                          ยอดสินค้า {confirmedOrder.cart.subtotalFormatted} · 🎟️ คูปอง {confirmedOrder.cart.coupon.code}
                        </span>
                        <b>−{confirmedOrder.cart.coupon.discountFormatted}</b>
                      </div>
                    )}
                    <div className="chk-total-line">
                      <span>ยอดสุทธิรวมทั้งสิ้น</span>
                      <strong>{confirmedOrder.cart.grandTotalFormatted}</strong>
                    </div>

                    <div className="rc-actions">
                      <button type="button" className="btn primary" onClick={() => copyOrderSummary(confirmedOrder)}>
                        📋 คัดลอกสรุปบิลส่ง LINE
                      </button>
                      <button type="button" className="btn" onClick={() => window.print()}>
                        🖨️ พิมพ์ใบสั่งซื้อ
                      </button>
                      <button type="button" className="btn" onClick={() => setStageMode("showcase")}>
                        🛍️ รับออเดอร์ใหม่ต่อ
                      </button>
                    </div>
                  </div>

                  {confirmedOrder.customer.paymentMethod === "promptpay" && (
                    <div className="rc-qr-box">
                      <div className="rc-qr-head">THAI QR PAYMENT · พร้อมเพย์</div>
                      <PayCountdown createdAt={confirmedOrder.createdAt} />
                      <svg viewBox="0 0 160 160" className="rc-qr-svg" aria-label="PromptPay QR">
                        <rect width="160" height="160" fill="#ffffff" rx="8" />
                        <rect x="14" y="14" width="38" height="38" fill="none" stroke="#0f172a" strokeWidth="6" />
                        <rect x="24" y="24" width="18" height="18" fill="#0f172a" />
                        <rect x="108" y="14" width="38" height="38" fill="none" stroke="#0f172a" strokeWidth="6" />
                        <rect x="118" y="24" width="18" height="18" fill="#0f172a" />
                        <rect x="14" y="108" width="38" height="38" fill="none" stroke="#0f172a" strokeWidth="6" />
                        <rect x="24" y="118" width="18" height="18" fill="#0f172a" />
                        <path d="M64 20h10v10H64zM82 20h14v10H82zM64 38h18v10H64zM64 62h34v10H64zM20 64h32v10H20zM108 64h34v10h-34zM64 82h14v22H64zM86 82h20v12H86zM114 82h28v14h-28zM64 114h24v30H64zM98 108h44v12H98zM98 128h18v18H98zM124 128h18v18h-18z" fill="#0f172a" />
                      </svg>
                      <strong>{confirmedOrder.cart.grandTotalFormatted}</strong>
                      <small className="muted">อ้างอิง #{confirmedOrder.orderNo}</small>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ==================== RIGHT COLUMN (DESKTOP): PERSISTENT LIVE CART ==================== */}
        <aside className="jc-right-cart" aria-label="ตะกร้าสินค้าสด">
          <div className="rcart-head">
            <h3>🛒 ตะกร้าสด ({cart.itemCount})</h3>
            {cart.items.length > 0 && (
              <button type="button" className="btn-reset-sm" onClick={clearCart}>
                ล้าง
              </button>
            )}
          </div>

          <div className="rcart-list">
            {cart.items.length === 0 ? (
              <p className="rcart-empty">
                ยังไม่มีสินค้าในตะกร้าครับ
                <br />
                พูดสั่งน้องตี๋ ส่องกล้องรูปสินค้า หรือกดปุ่ม <b>🛒 ใส่ตะกร้า</b> ได้เลยครับ
              </p>
            ) : (
              cart.items.map((it) => (
                <div key={`${it.slug}-${it.unitCode}`} className="rcart-item">
                  {it.imageUrl && <img src={it.imageUrl} alt="" />}
                  <div className="rcart-info">
                    <h5>{it.title}</h5>
                    <span>
                      {it.unitPriceFormatted}/{it.unitCode}
                    </span>
                    <div className="rcart-ctrl">
                      <button type="button" onClick={() => updateCartQty(it.slug, it.unitCode, it.qty - 1)}>
                        −
                      </button>
                      <b>{it.qty}</b>
                      <button type="button" onClick={() => updateCartQty(it.slug, it.unitCode, it.qty + 1)}>
                        +
                      </button>
                      <strong className="rcart-line-sum">{it.lineTotalFormatted}</strong>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="rcart-foot">
            <div className="rcart-total">
              <span>ยอดรวมสุทธิ</span>
              <strong>{cart.grandTotalFormatted}</strong>
            </div>
            <button
              type="button"
              className="btn primary rcart-checkout-btn"
              disabled={cart.items.length === 0}
              onClick={() => setStageMode("checkout")}
            >
              ✅ ปิดการขาย / ชำระเงิน
            </button>
          </div>
        </aside>
      </div>

      {cart.items.length > 0 && stageMode !== "cart" && stageMode !== "checkout" && (
        <div className="jc-mobile-cart-bar" data-cart-target>
          <div>
            <strong>🛒 {cart.itemCount} รายการ ({cart.totalPieces} หน่วย)</strong>
            <CountUpBaht className="jc-mcart-sum" value={cart.grandTotal} formatted={cart.grandTotalFormatted} />
          </div>
          <div className="jc-mcart-btns">
            <button type="button" className="btn" onClick={() => setStageMode("cart")}>
              ดูตะกร้า
            </button>
            <button type="button" className="btn primary" onClick={() => setStageMode("checkout")}>
              ปิดการขาย ›
            </button>
          </div>
        </div>
      )}

      {ordersModalOpen && (
        <div className="qty-backdrop" onClick={(e) => e.target === e.currentTarget && setOrdersModalOpen(false)}>
          <div className="qty-modal" style={{ maxWidth: 640 }}>
            <div className="qty-head">
              <h3>🧾 ประวัติบิลที่ปิดการขายแล้ว ({recentOrders.length})</h3>
              <button type="button" className="jm-close-btn" onClick={() => setOrdersModalOpen(false)}>
                ✕
              </button>
            </div>
            <div style={{ maxHeight: "65vh", overflowY: "auto", display: "grid", gap: 10 }}>
              {recentOrders.length === 0 ? (
                <p className="muted">ยังไม่มีประวัติคำสั่งซื้อครับ</p>
              ) : (
                recentOrders.map((o) => (
                  <div key={o.orderNo} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <div>
                      <b>#{o.orderNo}</b> · <span>{o.customer.customerName}</span>
                      <div className="muted">
                        {o.cart.itemCount} รายการ ({o.cart.totalPieces} หน่วย) · ชำระ: {o.customer.paymentMethod}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <strong style={{ color: "var(--emerald)", display: "block" }}>{o.cart.grandTotalFormatted}</strong>
                      <button
                        type="button"
                        className="mcp-mini-btn"
                        onClick={() => {
                          setConfirmedOrder(o);
                          setStageMode("order_confirmed");
                          setOrdersModalOpen(false);
                        }}
                      >
                        เปิดดูบิล
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
