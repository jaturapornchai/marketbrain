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
import type { LlmDevLogEntry, LlmDevStats, LlmProviderKind } from "@/lib/voice-log";
import { AdaptiveNoiseGate, EchoGuard, isEchoTranscript, playedLevel, wavEnvelope } from "@/lib/echo-guard";
import { BrowserSileroVad } from "@/lib/browser-vad";
import { WebRtcAudioSink, type SinkableAudioEl } from "@/lib/webrtc-audio-sink";
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
import FloatingJavisHud from "./FloatingJavisHud";
import { useJavis } from "./JavisContext";
import CouponStrip from "./CouponStrip";
import { PROMOTIONS, applyCoupon, bestPromotion, findPromotion, parseCouponCommand, type CouponCommand } from "@/lib/promotions";
import ProductVisionScanner, { identifyProductFromFile, type VisionLookupResult } from "./ProductVisionScanner";
import ProductCardGrid from "./ProductCardGrid";

type SinkableAudio = SinkableAudioEl;

type TurnEntry = {
  id: string;
  userText: string;
  imagePreview?: string;
  spokenText: string;
  screenMarkdown: string;
  cards: JavisProductCard[];
  jobs: JavisTeamJob[];
  model: string;
  provider?: LlmProviderKind;
  ms?: number;
  tps?: number;
  fallbackReason?: string;
  error?: string;
  /** Screen-control command ("ถอยกลับไป"), kept out of the conversation history sent to the AI. */
  isCommand?: boolean;
};

type LiveLlmStatus = {
  primaryModel: string;
  fallbackModel: string;
  localOnline: boolean;
  modelInstalled: boolean;
  modelLoaded: boolean;
  hasFallback: boolean;
  activeProvider: LlmProviderKind;
  activeModel: string;
  lastMs: number;
  lastTps?: number;
  lastFallbackReason?: string;
  stats: LlmDevStats;
};

const EMPTY_LLM_STATS: LlmDevStats = {
  localTurns: 0,
  fallbackTurns: 0,
  ramTurns: 0,
  visionLocalCalls: 0,
  errorCount: 0,
  lastProvider: null,
  lastModel: "",
  lastMs: 0,
  lastAt: null,
};

const DEFAULT_LLM_STATUS: LiveLlmStatus = {
  primaryModel: "gemma4:12b",
  fallbackModel: "deepseek-flash",
  localOnline: true,
  modelInstalled: true,
  modelLoaded: false,
  hasFallback: true,
  activeProvider: "local",
  activeModel: "gemma4:12b",
  lastMs: 0,
  stats: EMPTY_LLM_STATS,
};

const PHASE_LABEL_TH: Record<string, string> = {
  planner: "วางแผน",
  chat_round: "แชท",
  vision: "กล้อง",
  turn_summary: "สรุปเทิร์น",
};

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

type HudState = "idle" | "listening" | "searching" | "thinking" | "speaking" | "error";

const GREETING_TEXT =
  "สวัสดีครับ ผมน้องตี๋ เลขาช่วยหาสินค้าและรับออเดอร์ครับ อยากดูสินค้าตัวไหน พูด ส่องกล้องรูปสินค้า หรือพิมพ์บอกตี๋ได้เลยนะครับ";

// 46-byte silent PCM WAV (8kHz 16-bit mono) to prime the single reusable <audio> element on first mobile tap.
const SILENT_WAV_DATA_URI = "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==";

const ECHO_TAIL_MS = 400; // room reverb + output latency after Nong Tee stops speaking

const ACTION_FX_MS = 3600; // how long the "what I just did" banner stays

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
  const cards = x.cards.slice(0, 60).map((c) => c.slug).join(",");
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
async function fetchRelated(seeds: string[], limit = 24): Promise<RelatedSet | null> {
  if (!seeds.length) return null;
  try {
    const r = await fetch(`/api/products/related?slugs=${encodeURIComponent(seeds.slice(0, 8).join(","))}&limit=${limit}`);
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
  const stageBodyRef = useRef<HTMLDivElement>(null);
  const prevStageListKeyRef = useRef<string | null>(null);
  const router = useRouter();
  const [screenHist, setScreenHist] = useState<{ list: ScreenSnap[]; idx: number }>({ list: [], idx: -1 });
  const screenHistRef = useRef(screenHist);
  screenHistRef.current = screenHist;
  const [helpOpen, setHelpOpen] = useState(false);
  const [couponPulse, setCouponPulse] = useState(0);
  const [wheelOpen, setWheelOpen] = useState(false);
  const [wheelSpinKey, setWheelSpinKey] = useState(0);
  const [playOpen, setPlayOpen] = useState(false);
  const [missions, setMissions] = useState<Partial<Record<MissionKey, boolean>>>({});
  const [budget, setBudget] = useState("");
  const [duel, setDuel] = useState<{ a: JavisProductCard; b: JavisProductCard; noA: number; noB: number } | null>(null);
  const budgetWarnRef = useRef<"" | "near" | "over">("");
  const prevPiecesRef = useRef<Map<string, number> | null>(null);
  const [related, setRelated] = useState<RelatedSet | null>(null);
  const [spotRelated, setSpotRelated] = useState<{ slug: string; set: RelatedSet } | null>(null);
  const [stageRelated, setStageRelated] = useState<{ key: string; set: RelatedSet } | null>(null);
  // Visible related cards shown in the shared numbered ProductCardGrid across showcase/spotlight/cart screens.
  const stageRelatedKey = useMemo(
    () =>
      (stageMode === "welcome" || stageMode === "showcase") && stageTitle !== "🔗 สมองแนะนำของที่เกี่ยวข้อง"
        ? stageCards.slice(0, 6).map((c) => c.slug).join(",")
        : "",
    [stageMode, stageTitle, stageCards],
  );
  const showcaseRelatedAll = useMemo(() => {
    if (!stageRelatedKey || stageRelated?.key !== stageRelatedKey) return [];
    const shownSet = new Set(stageCards.map((c) => c.slug));
    return stageRelated.set.cards.filter((c) => !shownSet.has(c.slug));
  }, [stageRelatedKey, stageRelated, stageCards]);
  const showcaseRelatedShown = useMemo(() => showcaseRelatedAll.slice(0, 24), [showcaseRelatedAll]);
  const spotRelatedAll = useMemo(
    () =>
      stageMode === "spotlight" && spotlight && spotRelated?.slug === spotlight.slug
        ? spotRelated.set.cards.filter((c) => c.slug !== spotlight.slug)
        : [],
    [stageMode, spotlight, spotRelated],
  );
  const spotRelatedShown = useMemo(() => spotRelatedAll.slice(0, 24), [spotRelatedAll]);
  const cartRelatedAll = useMemo(() => {
    if (stageMode !== "cart" || !related) return [];
    const inCart = new Set(cart.items.map((it) => it.slug));
    return related.cards.filter((c) => !inCart.has(c.slug));
  }, [stageMode, related, cart.items]);
  const cartRelatedShown = useMemo(() => cartRelatedAll.slice(0, 24), [cartRelatedAll]);
  // Single source of truth for numbered voice/text orders ("เอาเบอร์ 2 สองชิ้น", "ดูเบอร์ 3"):
  // always matches the exact numbered ProductCardGrid the customer sees right now.
  const activeNumberedCards = useMemo(() => {
    if (stageMode === "spotlight" && spotRelatedShown.length > 0) return spotRelatedShown;
    if (stageMode === "cart" && cartRelatedShown.length > 0) return cartRelatedShown;
    if ((stageMode === "welcome" || stageMode === "showcase") && showcaseRelatedShown.length > 0) {
      return [...stageCards, ...showcaseRelatedShown];
    }
    return stageCards;
  }, [stageMode, spotRelatedShown, cartRelatedShown, showcaseRelatedShown, stageCards]);
  const activeNumberedCardsRef = useRef(activeNumberedCards);
  activeNumberedCardsRef.current = activeNumberedCards;
  const scrollStageToTop = useCallback((smooth = true) => {
    const behavior: ScrollBehavior = smooth ? "smooth" : "auto";
    const body = stageBodyRef.current ?? document.querySelector<HTMLElement>(".jc-stage-body");
    if (body && body.scrollTop > 0) body.scrollTo({ top: 0, behavior });
    if (typeof window !== "undefined" && window.scrollY > 0) window.scrollTo({ top: 0, behavior });
  }, []);

  useEffect(() => {
    const listKey = stageCards.map((c) => c.slug).join(",");
    if (prevStageListKeyRef.current === null) {
      prevStageListKeyRef.current = listKey;
      return;
    }
    if (listKey && listKey !== prevStageListKeyRef.current) {
      prevStageListKeyRef.current = listKey;
      const raf = requestAnimationFrame(() => scrollStageToTop(true));
      return () => cancelAnimationFrame(raf);
    }
    prevStageListKeyRef.current = listKey;
  }, [stageCards, scrollStageToTop]);

  const openProductSpotlight = useCallback(
    (card: JavisProductCard) => {
      setSpotlight(card);
      setStageMode("spotlight");
      setStageTitle(card.title);
      setMobileTab("stage");
      requestAnimationFrame(() => scrollStageToTop(true));
    },
    [scrollStageToTop],
  );
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
  const [llmStatus, setLlmStatus] = useState<LiveLlmStatus>(DEFAULT_LLM_STATUS);
  const [devLogOpen, setDevLogOpen] = useState(false);
  const [devLogs, setDevLogs] = useState<LlmDevLogEntry[]>([]);
  const [devLogsLoading, setDevLogsLoading] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const devLogOpenRef = useRef(false);
  devLogOpenRef.current = devLogOpen;
  const dockPopRef = useRef<HTMLDivElement>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [callActive, setCallActive] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [audioUnlockNeeded, setAudioUnlockNeeded] = useState(false);
  const [visionUploading, setVisionUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [activeMicStreamState, setActiveMicStreamState] = useState<MediaStream | null>(null);
  const [hudSatEvent, setHudSatEvent] = useState<{ id: string; color: string } | null>(null);
  const [mobileTab, setMobileTab] = useState<"stage" | "cart">("stage");
  const stageModeInitRef = useRef(true);
  useEffect(() => {
    if (stageModeInitRef.current) {
      stageModeInitRef.current = false;
      return;
    }
    if (stageMode === "cart") setMobileTab("cart");
    else if (stageMode !== "welcome") setMobileTab("stage");
  }, [stageMode]);

  useEffect(() => {
    if (!chatOpen && !devLogOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (dockPopRef.current && !dockPopRef.current.contains(e.target as Node)) {
        setChatOpen(false);
        setDevLogOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setChatOpen(false);
        setDevLogOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [chatOpen, devLogOpen]);

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

  // Audio playback queue for Local OmniVoice sentences.
  // Routes TTS through a local WebRTC loopback AEC3 sink + master GainNode (smooth ducking)
  // on Chromium/Firefox, and direct unlocked AudioContext (VoiceProcessingIO AEC) on iOS Safari.
  const audioQueueRef = useRef<Array<{ text: string; promise: Promise<{ url: string; dur: number; buf: ArrayBuffer } | null> }>>([]);
  const stagePaintGateRef = useRef<Promise<void>>(Promise.resolve());
  const markStagePaintedSoon = useCallback(() => {
    stagePaintGateRef.current = new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      } else {
        resolve();
      }
    });
  }, []);
  const ttsAudioRef = useRef<SinkableAudio | null>(null);
  const ttsSinkRef = useRef<WebRtcAudioSink | null>(null);
  const getTtsSink = useCallback(() => {
    if (!ttsSinkRef.current) ttsSinkRef.current = new WebRtcAudioSink();
    if (ttsAudioRef.current) ttsSinkRef.current.attachElement(ttsAudioRef.current);
    return ttsSinkRef.current;
  }, []);
  const audioUnlockedRef = useRef(false);
  const unlockResumeRef = useRef<(() => void) | null>(null);
  const activeCancelRef = useRef<(() => void) | null>(null);
  const playbackGenRef = useRef(0);
  const isPlayingLoopRef = useRef(false);
  const playingEnvRef = useRef<Float32Array | null>(null); // loudness envelope of the sentence being played
  const recentBotSpokenRef = useRef<Array<{ text: string; at: number }>>([]);
  const lastBotAudioMsRef = useRef(0);
  const userLevelRef = useRef(0);
  const currentBotTimeSec = (): number | null => {
    const sinkSec = ttsSinkRef.current?.currentTimeSec() ?? null;
    if (sinkSec !== null) return sinkSec;
    const audio = ttsAudioRef.current;
    if (audio && !audio.srcObject && !audio.paused && audio.src && audio.src !== SILENT_WAV_DATA_URI) {
      return audio.currentTime;
    }
    return null;
  };
  const botLevelGetterRef = useRef<() => number>(() => 0);
  botLevelGetterRef.current = () => {
    if (!isPlayingLoopRef.current) return 0;
    const t = currentBotTimeSec();
    return t !== null ? playedLevel(playingEnvRef.current, t) : 0;
  };
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

  // WebAudio Mic + AudioWorklet + Client-Side Silero VAD v5 + Local OpenThai ASR refs
  const callActiveRef = useRef(callActive);
  callActiveRef.current = callActive;
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micGraphGenRef = useRef(0);
  const vadRef = useRef<BrowserSileroVad | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const speakingDetectedRef = useRef(false);
  const speechStartMsRef = useRef(0);
  const lastVoiceMsRef = useRef(0);
  const lastPartialMsRef = useRef(0);
  const sendingSttRef = useRef(false);

  const refreshDevLogs = useCallback(async () => {
    setDevLogsLoading(true);
    try {
      const res = await fetch("/api/dev/llm?limit=25", { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as {
        primaryModel?: string;
        fallbackModel?: string;
        ollamaOnline?: boolean;
        modelInstalled?: boolean;
        modelLoaded?: boolean;
        hasFallback?: boolean;
        stats?: LlmDevStats;
        recentLogs?: LlmDevLogEntry[];
      };
      if (Array.isArray(d.recentLogs)) setDevLogs(d.recentLogs);
      setLlmStatus((prev) => ({
        ...prev,
        primaryModel: d.primaryModel || prev.primaryModel,
        fallbackModel: d.fallbackModel || prev.fallbackModel,
        localOnline: d.ollamaOnline ?? prev.localOnline,
        modelInstalled: d.modelInstalled ?? prev.modelInstalled,
        modelLoaded: d.modelLoaded ?? prev.modelLoaded,
        hasFallback: d.hasFallback ?? prev.hasFallback,
        stats: d.stats ?? prev.stats,
        activeProvider: d.stats?.lastProvider ?? prev.activeProvider,
        activeModel: d.stats?.lastModel || prev.activeModel,
        lastMs: d.stats?.lastMs ?? prev.lastMs,
        lastTps: d.stats?.lastTps ?? prev.lastTps,
        lastFallbackReason: d.stats?.lastFallbackReason ?? prev.lastFallbackReason,
      }));
    } catch {
      // ignore dev log fetch failure
    } finally {
      setDevLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch("/api/voice/status", { cache: "no-store" })
      .then((r) => r.json())
      .then(
        (d: {
          ok?: boolean;
          llm?: {
            localOnline?: boolean;
            modelInstalled?: boolean;
            modelLoaded?: boolean;
            primaryModel?: string;
            fallbackModel?: string;
            hasFallback?: boolean;
            stats?: LlmDevStats;
          };
        }) => {
          setVoiceEngineOnline(Boolean(d.ok));
          if (d.llm) {
            const st = d.llm.stats;
            setLlmStatus((prev) => ({
              ...prev,
              primaryModel: d.llm?.primaryModel || prev.primaryModel,
              fallbackModel: d.llm?.fallbackModel || prev.fallbackModel,
              localOnline: d.llm?.localOnline ?? prev.localOnline,
              modelInstalled: d.llm?.modelInstalled ?? prev.modelInstalled,
              modelLoaded: d.llm?.modelLoaded ?? prev.modelLoaded,
              hasFallback: d.llm?.hasFallback ?? prev.hasFallback,
              stats: st ?? prev.stats,
              activeProvider: st?.lastProvider ?? prev.activeProvider,
              activeModel: st?.lastModel || d.llm?.primaryModel || prev.activeModel,
              lastMs: st?.lastMs ?? prev.lastMs,
              lastTps: st?.lastTps ?? prev.lastTps,
              lastFallbackReason: st?.lastFallbackReason ?? prev.lastFallbackReason,
            }));
          }
        },
      )
      .catch(() => setVoiceEngineOnline(false));
  }, []);

  // Dynamically switch active audio output sink if user changes speaker mid-speech
  useEffect(() => {
    void getTtsSink().setSinkId(speakerDeviceId);
  }, [speakerDeviceId, getTtsSink]);

  /**
   * Unlocks audio playback once per session on mobile Safari / Android Chrome:
   * resumes the TTS AudioContext (stays unlocked for all async future TTS turns)
   * and primes the single reusable <audio> element inside the same user gesture.
   */
  const unlockAudioPlayback = useCallback(() => {
    audioUnlockedRef.current = true;
    void audioCtxRef.current?.resume().catch(() => {});

    const sink = getTtsSink();
    sink.unlock();

    if (unlockResumeRef.current) {
      const resume = unlockResumeRef.current;
      unlockResumeRef.current = null;
      setAudioUnlockNeeded(false);
      resume();
      return;
    }

    const audio = ttsAudioRef.current;
    if (audio && !sink.isLoopbackActive && !audio.srcObject && !isPlayingLoopRef.current && (!audio.src || audio.paused)) {
      audio.src = SILENT_WAV_DATA_URI;
      void audio.play().catch(() => {});
    }
  }, [getTtsSink]);

  // Capture the user's very first tap/click/key anywhere so future async TTS turns play without ever asking again.
  useEffect(() => {
    const events: Array<keyof WindowEventMap> = ["touchstart", "touchend", "pointerdown", "click", "keydown"];
    const onFirstGesture = () => {
      unlockAudioPlayback();
      // On iOS Safari, touchstart may not finish resuming until touchend/click; detach only once AudioContext is running.
      if (ttsSinkRef.current?.contextState === "running" && !unlockResumeRef.current) {
        for (const ev of events) window.removeEventListener(ev, onFirstGesture, true);
      }
    };
    for (const ev of events) window.addEventListener(ev, onFirstGesture, true);
    return () => {
      for (const ev of events) window.removeEventListener(ev, onFirstGesture, true);
    };
  }, [unlockAudioPlayback]);

  const stopAllAudioPlayback = useCallback(() => {
    playbackGenRef.current += 1;
    audioQueueRef.current = [];
    unlockResumeRef.current = null;
    ttsSinkRef.current?.stopActive();
    const audio = ttsAudioRef.current;
    if (audio && !ttsSinkRef.current?.isLoopbackActive && !audio.srcObject) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.volume = 1;
    }
    const cancel = activeCancelRef.current;
    activeCancelRef.current = null;
    cancel?.();
    if (isPlayingLoopRef.current) {
      lastBotAudioMsRef.current = performance.now();
    }
    isPlayingLoopRef.current = false;
    playingEnvRef.current = null;
    setAudioUnlockNeeded(false);
    setKaraokeProgress(100);
  }, []);

  const drainAudioQueue = useCallback(async () => {
    if (isPlayingLoopRef.current) return;
    isPlayingLoopRef.current = true;
    const gen = playbackGenRef.current;
    try {
      while (audioQueueRef.current.length > 0 && playbackGenRef.current === gen) {
        const item = audioQueueRef.current.shift()!;
        if (!ttsEnabledRef.current) continue;
        const resolved = await item.promise;
        if (!resolved || !ttsEnabledRef.current || playbackGenRef.current !== gen) {
          if (resolved) URL.revokeObjectURL(resolved.url);
          continue;
        }
        await stagePaintGateRef.current;
        if (!ttsEnabledRef.current || playbackGenRef.current !== gen) {
          URL.revokeObjectURL(resolved.url);
          continue;
        }

        const nowSpoken = performance.now();
        recentBotSpokenRef.current = [
          ...recentBotSpokenRef.current.filter((e) => nowSpoken - e.at < 15000),
          { text: item.text, at: nowSpoken },
        ];
        lastBotAudioMsRef.current = nowSpoken;

        setHudState("speaking");
        setLiveKaraokeText(item.text);
        setKaraokeProgress(0);
        playingEnvRef.current = wavEnvelope(resolved.buf);

        await new Promise<void>((resolve) => {
          let settled = false;
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
            if (settled) return;
            settled = true;
            if (anim) clearInterval(anim);
            setKaraokeProgress(100);
            lastBotAudioMsRef.current = performance.now();
            URL.revokeObjectURL(resolved.url);
            if (activeCancelRef.current === finish) activeCancelRef.current = null;
            if (unlockResumeRef.current === resumePlayback) unlockResumeRef.current = null;
            resolve();
          };
          activeCancelRef.current = finish;

          const playViaSink = async (): Promise<boolean> => {
            const sink = getTtsSink();
            if (speakerDeviceIdRef.current) {
              await sink.setSinkId(speakerDeviceIdRef.current);
            }
            const started = await sink.playBuffer(
              resolved.buf,
              finish,
              () => !settled && playbackGenRef.current === gen,
            );
            if (!started) return false;
            if (!settled && playbackGenRef.current === gen) {
              startProgressAnim();
              setAudioUnlockNeeded(false);
            }
            return true;
          };

          const playViaElement = async (): Promise<boolean> => {
            const audio = ttsAudioRef.current;
            if (!audio) return false;
            try {
              audio.onended = null;
              audio.onerror = null;
              audio.pause();
              if (audio.srcObject) audio.srcObject = null;
              audio.volume = 1;
              if (audio.setSinkId && speakerDeviceIdRef.current) {
                await audio.setSinkId(speakerDeviceIdRef.current).catch(() => {});
              }
              if (settled || playbackGenRef.current !== gen) return true;
              audio.src = resolved.url;
              audio.currentTime = 0;
              audio.onended = finish;
              audio.onerror = finish;
              startProgressAnim();
              await audio.play();
              setAudioUnlockNeeded(false);
              return true;
            } catch {
              if (anim) clearInterval(anim);
              audio.onended = null;
              audio.onerror = null;
              return false;
            }
          };

          const playNow = async () => {
            if (settled || playbackGenRef.current !== gen) return;
            if (await playViaSink()) return;
            if (await playViaElement()) return;

            // Still blocked only before the very first gesture on mobile/desktop: wait once for any tap/click/key.
            if (anim) clearInterval(anim);
            unlockResumeRef.current = resumePlayback;
            setAudioUnlockNeeded(true);
          };

          const resumePlayback = () => {
            void playNow();
          };

          void playNow();
        });
      }
    } finally {
      if (playbackGenRef.current === gen) {
        isPlayingLoopRef.current = false;
        playingEnvRef.current = null;
        lastBotAudioMsRef.current = performance.now();
        ttsSinkRef.current?.setDuck(false);
        if (!busyRef.current && !speakingDetectedRef.current) {
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
    }
  }, [getTtsSink]);

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
          const buf = await res.arrayBuffer();
          const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
          return { url, dur, buf };
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
        const buf = await r.arrayBuffer();
        const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        return { url, dur, buf };
      })
      .catch(() => null);
    audioQueueRef.current.push({ text: GREETING_TEXT, promise });
    void drainAudioQueue();
  }, [drainAudioQueue]);

  const logVoiceClient = useCallback((payload: { kind: "screen_cmd" | "budget_cmd" | "coupon_cmd" | "echo_drop"; heard: string; cmd?: string; reply?: string; stage?: string }) => {
    void fetch("/api/voice/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }, []);
  const lastSentTurnRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const sendTurnRef = useRef<(text: string, extra?: { altHeard?: string }) => Promise<void> | void>(() => {});
  const sendTurn = useCallback(
    async (
      rawText: string,
      extra?: {
        displayUserText?: string;
        imagePreview?: string;
        visionSlugs?: string[];
        visionSummary?: string;
        altHeard?: string;
      },
    ) => {
      const q = rawText.trim();
      if (!q) return;
      const nowTurn = performance.now();
      if (!extra?.visionSlugs && lastSentTurnRef.current.text === q && nowTurn - lastSentTurnRef.current.at < 450) {
        return;
      }
      lastSentTurnRef.current = { text: q, at: nowTurn };

      // "ถอยกลับไป", "ดูเบอร์ 3", "เลื่อนลง" ... run on the screen at once (no AI, works even while busy).
      const screenCmd =
        q && !extra?.visionSlugs
          ? parseScreenCommand(q, { modalOpen: Boolean(qtyModalSlugRef.current) || modalOpenRef.current })
          : null;
      if (screenCmd) {
        setInput("");
        setLiveUserHeard("");
        logVoiceClient({ kind: "screen_cmd", heard: q, cmd: `${screenCmd.id}${screenCmd.no ? "#" + screenCmd.no : ""}`, stage: stageMode });
        runScreenCommandRef.current(screenCmd, q);
        return;
      }
      // "งบ 500 บาท" -> budget bar, 0 tokens
      const budgetCmd = q && !extra?.visionSlugs ? parseBudget(q, parseThaiNumber) : null;
      if (budgetCmd !== null) {
        setInput("");
        setLiveUserHeard("");
        logVoiceClient({ kind: "budget_cmd", heard: q, cmd: `budget:${budgetCmd}`, stage: stageMode });
        runBudgetRef.current(budgetCmd, q);
        return;
      }
      // "ใช้คูปอง", "ยกเลิกคูปอง", "มีโปรอะไรบ้าง" -> exact, 0 tokens
      const couponCmd = q && !extra?.visionSlugs ? parseCouponCommand(q) : null;
      if (couponCmd) {
        setInput("");
        setLiveUserHeard("");
        logVoiceClient({ kind: "coupon_cmd", heard: q, cmd: `coupon:${couponCmd.action}`, stage: stageMode });
        runCouponCommandRef.current(couponCmd, q);
        return;
      }
      // Never drop a new customer command while a previous turn is still finishing: abort the stale turn and run this one immediately.
      if (busyRef.current && abortRef.current) {
        const stale = abortRef.current;
        abortRef.current = null;
        stale.abort();
      }
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
      // Card numbers the customer sees right now (home showcase OR related grid on spotlight/cart) = focusSlugs[no - 1].
      const focusSlugs = activeNumberedCardsRef.current.slice(0, 60).map((c) => c.slug);

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
          model: llmStatus.primaryModel || "gemma4:12b",
          provider: "local",
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
            altHeard: extra?.altHeard,
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
          if (value) buf += decoder.decode(value, { stream: !done });
          const blocks = done ? buf.split("\n\n") : (() => { const parts = buf.split("\n\n"); buf = parts.pop() ?? ""; return parts; })();
          if (done) buf = "";

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
              const satColor =
                ev.job.worker === "calc" || ev.job.worker === "order" || ev.job.worker === "cart"
                  ? "#e879f9"
                  : ev.job.worker === "vision"
                    ? "#2dd4bf"
                    : ev.job.worker === "planner"
                      ? "#60a5fa"
                      : "#fb923c";
              setHudSatEvent({ id: `${turnId}-${ev.job.id}-${ev.job.state}`, color: satColor });
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
              const prevSlugs = stageCardsRef.current.map((c) => c.slug).join(",");
              const nextSlugs = ev.cards.map((c) => c.slug).join(",");
              const isNewCardSet = Boolean(ev.cards[0]?.slug && nextSlugs !== prevSlugs);
              setStageCards(ev.cards);
              if (ev.cards.length > 0) {
                markMission("search");
                setMobileTab("stage");
                // Always switch the right-hand stage to showcase when a brand-new search result arrives
                // so products never stay hidden behind welcome/camera/compare/old spotlight screens.
                if (isNewCardSet) {
                  setStageMode((m) => (m === "cart" || m === "checkout" ? m : "showcase"));
                  requestAnimationFrame(() => scrollStageToTop(true));
                }
              }
              markStagePaintedSoon();
              // The customer moved on to other products: a "how many?" box for an old one must not cover them.
              if (qtyModalSlugRef.current && !ev.cards.some((c) => c.slug === qtyModalSlugRef.current)) closeQtyModal();
              // Same cards again (follow-up turn): stay on the product the customer has open.
              if (ev.cards[0]) setSpotlight((prev) => (prev && ev.cards.some((c) => c.slug === prev.slug) ? prev : ev.cards[0]));
              setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, cards: ev.cards } : t)));
            } else if (ev.type === "stage") {
              setStageMode(ev.mode);
              if (ev.title) setStageTitle(ev.title);
              if (ev.spotlight) setSpotlight(ev.spotlight);
              setMobileTab(ev.mode === "cart" ? "cart" : "stage");
              requestAnimationFrame(() => scrollStageToTop(true));
              markStagePaintedSoon();
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
              // Keep the current view when the picked numbered card is already visible (e.g. related grid on spotlight/cart).
              const cardOnCurrentView = ev.slug
                ? activeNumberedCardsRef.current.some((c) => c.slug === ev.slug)
                : false;
              if (!cardOnCurrentView) setStageMode("showcase");
              actionFxTimersRef.current.push(
                setTimeout(
                  () => document.querySelector(`.st-card.fx-${ev.kind}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
                  80,
                ),
              );
              if (ev.kind === "add") {
                // Keep the customer on the product screen so they can keep shopping immediately (live cart updates in place).
                closeQtyModal();
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
            } else if (ev.type === "engine") {
              setLlmStatus((prev) => ({
                ...prev,
                localOnline: ev.provider === "local" ? true : ev.provider === "fallback" ? false : prev.localOnline,
                modelLoaded: ev.provider === "local" ? true : prev.modelLoaded,
                activeProvider: ev.provider,
                activeModel: ev.model,
                lastMs: ev.ms ?? prev.lastMs,
                lastTps: ev.tps ?? prev.lastTps,
                lastFallbackReason: ev.fallbackReason,
              }));
              setTurns((prev) =>
                prev.map((t) =>
                  t.id === turnId
                    ? {
                        ...t,
                        model: ev.model,
                        provider: ev.provider,
                        ms: ev.ms ?? t.ms,
                        tps: ev.tps ?? t.tps,
                        fallbackReason: ev.fallbackReason,
                      }
                    : t,
                ),
              );
            } else if (ev.type === "done") {
              const prov: LlmProviderKind = ev.provider ?? "local";
              setLlmStatus((prev) => ({
                ...prev,
                localOnline: prov === "local" ? true : prov === "fallback" ? false : prev.localOnline,
                modelLoaded: prov === "local" ? true : prev.modelLoaded,
                activeProvider: prov,
                activeModel: ev.model,
                lastMs: ev.ms ?? prev.lastMs,
                lastTps: ev.tps ?? prev.lastTps,
                lastFallbackReason: ev.fallbackReason,
                stats: {
                  ...prev.stats,
                  localTurns: prev.stats.localTurns + (prov === "local" ? 1 : 0),
                  fallbackTurns: prev.stats.fallbackTurns + (prov === "fallback" ? 1 : 0),
                  ramTurns: prev.stats.ramTurns + (prov === "ram" ? 1 : 0),
                  lastProvider: prov,
                  lastModel: ev.model,
                  lastMs: ev.ms ?? prev.stats.lastMs,
                  lastTps: ev.tps ?? prev.stats.lastTps,
                  lastFallbackReason: ev.fallbackReason,
                  lastAt: new Date().toISOString(),
                },
              }));
              setTurns((prev) =>
                prev.map((t) =>
                  t.id === turnId
                    ? {
                        ...t,
                        spokenText: ev.spokenText || t.spokenText,
                        screenMarkdown: ev.screenMarkdown || t.screenMarkdown,
                        model: ev.model,
                        provider: prov,
                        ms: ev.ms ?? t.ms,
                        tps: ev.tps ?? t.tps,
                        fallbackReason: ev.fallbackReason,
                      }
                    : t,
                ),
              );
              if (devLogOpenRef.current) void refreshDevLogs();
            } else if (ev.type === "error") {
              setHudState("error");
              setStatusText(ev.message);
              setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, error: ev.message } : t)));
            }
          }
          if (done) break;
        }
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") {
          const msg = err instanceof Error ? err.message : "เชื่อมต่อขัดข้อง";
          setHudState("error");
          setStatusText(msg);
          setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, error: msg } : t)));
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(false);
          busyRef.current = false;
        }
        if (!isPlayingLoopRef.current && !speakingDetectedRef.current && !busyRef.current) {
          setHudState("listening");
          setStatusText(
            callActiveRef.current
              ? "🟢 น้องตี๋กำลังฟังเสียงของคุณอยู่ครับ…"
              : "🟢 น้องตี๋พร้อมคุยต่อหรือส่องรูปสินค้าได้เลยครับ",
          );
        }
      }
    },
    [cart.items, closeQtyModal, customer, enqueueOmniVoiceSentence, logVoiceClient, markStagePaintedSoon, promptAddToCart, replaceServerCart, stageMode, stopAllAudioPlayback, turns, updateCustomer],
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
  }, [turns, liveUserHeard, chatOpen]);

  // ---------- Full-Duplex Mic Pipeline (HPF 95 Hz + AudioWorklet 32 ms + Silero VAD v5 + WebRTC AEC3 + 2-Stage Barge-in) ----------
  const teardownMicGraph = useCallback(() => {
    micGraphGenRef.current += 1;
    pcmChunksRef.current = [];
    speakingDetectedRef.current = false;
    ttsSinkRef.current?.setDuck(false);
    if (vadRef.current) {
      const oldVad = vadRef.current;
      vadRef.current = null;
      void oldVad.release();
    }
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
      // Prefer W3C echoCancellation: "all" (Chrome 130+ system/all AEC), falling back cleanly to boolean true.
      const buildConstraints = (ec: boolean | "all", deviceId?: string): MediaTrackConstraints => ({
        echoCancellation: ec as unknown as boolean,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      });
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: buildConstraints("all", preferredMicId || undefined) });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: buildConstraints(true, preferredMicId || undefined) });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ audio: buildConstraints(true) });
        }
      }

      teardownMicGraph();
      const graphGen = micGraphGenRef.current;
      stream.getAudioTracks().forEach((t) => {
        t.enabled = !micMutedRef.current;
      });
      micStreamRef.current = stream;
      setActiveMicStreamState(stream);

      // Let the OS choose its native hardware sample rate (avoids iOS Safari 16 kHz mismatch bugs);
      // the AudioWorklet downsamples cleanly to 16 kHz / 512-sample (32 ms) frames.
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);

      // High-Pass Filter at 95 Hz: strips AC hum, fan rumble, breath pops & table knocks before VAD/STT.
      const hpf = ctx.createBiquadFilter();
      hpf.type = "highpass";
      hpf.frequency.value = 95;
      hpf.Q.value = 0.707;
      source.connect(hpf);

      // Load self-hosted Silero VAD v5 WASM asynchronously; Tier-A adaptive gate runs immediately until ready.
      void BrowserSileroVad.create().then((vad) => {
        if (!vad) return;
        if (micGraphGenRef.current !== graphGen) {
          void vad.release();
          return;
        }
        vadRef.current = vad;
      });

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

      const IDLE_PREROLL_FRAMES = 10; // 320 ms ring buffer so first syllables are never clipped
      const MIN_ONSET_FRAMES = 5; // 160 ms of real voice before opening STT (blocks clicks/knocks)
      const MIN_FINAL_VOICED_FRAMES = 7; // ~224 ms minimum voiced speech to finalize a turn
      const EARLY_STT_SILENCE_MS = 240; // start speculative GPU Whisper STT early (0 ms wait at turn end)
      const SILENCE_END_MS = 540; // snappy end-of-turn confirmation after silence
      const MAX_UTTERANCE_FRAMES = 480; // ~15 s safety cap so ambient noise never builds huge STT buffers

      const echoGuard = new EchoGuard();
      const noiseGate = new AdaptiveNoiseGate();
      let wasPlaying = false;
      let idlePreroll: Float32Array[] = [];
      let bargePreroll: Float32Array[] = [];
      let onsetFrames = 0;
      let onsetMisses = 0;
      let voicedFrames = 0;
      let echoTailUntil = 0;
      let lastPlayed = 0;
      let lastSoundingMs = 0;
      let partialCtrl: AbortController | null = null;
      const cancelPartialStt = () => {
        if (partialCtrl) {
          partialCtrl.abort();
          partialCtrl = null;
          sendingSttRef.current = false;
        }
      };
      type FinalSttRes = {
        text?: string;
        altText?: string;
        picked?: string;
        voiced?: boolean;
        gate?: { allow: boolean; prob: number; reason: string; ms: number };
      };
      let earlyStt: {
        ctrl: AbortController;
        promise: Promise<FinalSttRes | null>;
      } | null = null;
      const cancelEarlyStt = () => {
        if (earlyStt) {
          earlyStt.ctrl.abort();
          earlyStt = null;
        }
      };
      const postFinalStt = (pcm: Float32Array, signal?: AbortSignal) =>
        fetch("/api/voice/stt", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-sample-rate": "16000",
            "x-audio-format": "f32le",
            "x-partial": "0",
            "x-pending": qtyModalSlugRef.current ? "1" : "0",
            "x-focus": activeNumberedCardsRef.current.length > 0 || viewingSlugRef.current ? "1" : "0",
          },
          body: pcm.buffer as ArrayBuffer,
          signal,
        })
          .then((r) => (r.ok ? (r.json() as Promise<FinalSttRes>) : null))
          .catch(() => null);

      const handleFrame = async (frame512: Float32Array, rms: number) => {
        if (micGraphGenRef.current !== graphGen) return;
        if (!callActiveRef.current || micMutedRef.current) {
          userLevelRef.current = 0;
          return;
        }
        userLevelRef.current = rms;
        const now = performance.now();
        const vad = vadRef.current;
        const speechProb = vad ? await vad.process(frame512) : null;
        if (micGraphGenRef.current !== graphGen) return;

        const playing = isPlayingLoopRef.current;
        if (playing !== wasPlaying) {
          wasPlaying = playing;
          echoGuard.resetRun();
          ttsSinkRef.current?.setDuck(false);
          bargePreroll = [];
          onsetFrames = 0;
          onsetMisses = 0;
          if (playing) {
            cancelPartialStt();
            cancelEarlyStt();
            pcmChunksRef.current = [];
            idlePreroll = [];
            speakingDetectedRef.current = false;
            voicedFrames = 0;
            setLiveUserHeard("");
          } else {
            echoTailUntil = now + ECHO_TAIL_MS; // room reverb + output latency after Nong Tee stops
          }
        }

        if (playing) {
          const botSec = currentBotTimeSec();
          let played = 0;
          if (botSec !== null) {
            played = lastPlayed = playedLevel(playingEnvRef.current, botSec);
            lastSoundingMs = now;
          } else if (now - lastSoundingMs < ECHO_TAIL_MS) {
            played = lastPlayed;
          }
          const decision = echoGuard.hear(
            rms,
            played,
            speechProb,
            Boolean(ttsSinkRef.current?.isLoopbackActive),
          );
          if (decision === "echo") {
            ttsSinkRef.current?.setDuck(false);
            bargePreroll.push(frame512);
            if (bargePreroll.length > 4) bargePreroll.shift();
            return;
          }
          if (decision === "duck") {
            // Stage 1 (~96 ms): smoothly duck Nong Tee to 15% without dropping his sentence yet.
            ttsSinkRef.current?.setDuck(true);
            bargePreroll.push(frame512);
            if (bargePreroll.length > 18) bargePreroll.shift();
            return;
          }

          // Stage 2 (~192–256 ms): confirmed barge-in -> hard-stop audio + abort in-flight LLM stream.
          bargePreroll.push(frame512);
          stopAllAudioPlayback();
          if (abortRef.current) {
            const ac = abortRef.current;
            abortRef.current = null;
            ac.abort();
            setBusy(false);
            busyRef.current = false;
          }
          wasPlaying = false;
          setHudState("listening");
          setStatusText("น้องตี๋หยุดฟังคุณพูดแทรกครับ…");
          speakingDetectedRef.current = true;
          speechStartMsRef.current = now;
          lastVoiceMsRef.current = now;
          voicedFrames = bargePreroll.length;
          pcmChunksRef.current = bargePreroll;
          bargePreroll = [];
          idlePreroll = [];
          echoGuard.resetRun();
          return;
        }
        if (now < echoTailUntil) return;

        const isVoice = noiseGate.isVoiceFrame(rms, speechProb, speakingDetectedRef.current);

        if (!speakingDetectedRef.current) {
          idlePreroll.push(frame512);
          if (idlePreroll.length > IDLE_PREROLL_FRAMES) idlePreroll.shift();

          if (isVoice) {
            onsetFrames += 1;
            onsetMisses = 0;
            if (onsetFrames >= MIN_ONSET_FRAMES) {
              speakingDetectedRef.current = true;
              speechStartMsRef.current = now;
              lastVoiceMsRef.current = now;
              voicedFrames = onsetFrames;
              pcmChunksRef.current = [...idlePreroll];
              idlePreroll = [];
              onsetFrames = 0;
            }
          } else {
            onsetMisses += 1;
            if (onsetMisses >= 2) {
              onsetFrames = 0;
              onsetMisses = 0;
            }
          }
          return;
        }

        if (pcmChunksRef.current.length < MAX_UTTERANCE_FRAMES) {
          pcmChunksRef.current.push(frame512);
        }

        if (isVoice) {
          cancelEarlyStt();
          lastVoiceMsRef.current = now;
          voicedFrames += 1;

          // Incremental live partial transcription every ~650 ms (guarded by Silero VAD on both ends)
          if (!sendingSttRef.current && now - lastPartialMsRef.current > 650 && voicedFrames >= 8) {
            lastPartialMsRef.current = now;
            const merged = mergePcm(pcmChunksRef.current);
            const pCtrl = new AbortController();
            partialCtrl = pCtrl;
            sendingSttRef.current = true;
            fetch("/api/voice/stt", {
              method: "POST",
              headers: {
                "Content-Type": "application/octet-stream",
                "x-sample-rate": "16000",
                "x-audio-format": "f32le",
                "x-partial": "1",
              },
              body: merged.buffer,
              signal: pCtrl.signal,
            })
              .then((r) => (r.ok ? r.json() : { text: "" }))
              .then((d: { text?: string }) => {
                if (d.text && speakingDetectedRef.current) setLiveUserHeard(d.text);
              })
              .catch(() => {})
              .finally(() => {
                if (partialCtrl === pCtrl) partialCtrl = null;
                sendingSttRef.current = false;
              });
          }
          return;
        }

        const silenceMs = now - lastVoiceMsRef.current;

        // Speculative early final STT at 240 ms silence so GPU Whisper finishes before SILENCE_END_MS (540 ms).
        if (
          silenceMs >= EARLY_STT_SILENCE_MS &&
          !earlyStt &&
          voicedFrames >= MIN_FINAL_VOICED_FRAMES &&
          pcmChunksRef.current.length >= 11
        ) {
          cancelPartialStt();
          const snap = mergePcm(pcmChunksRef.current);
          const ctrl = new AbortController();
          earlyStt = { ctrl, promise: postFinalStt(snap, ctrl.signal) };
        }

        if (silenceMs >= SILENCE_END_MS) {
          cancelPartialStt();
          const pendingSpec = earlyStt;
          earlyStt = null;
          const captured = pendingSpec ? null : mergePcm(pcmChunksRef.current);
          const spokenFrames = voicedFrames;
          pcmChunksRef.current = [];
          speakingDetectedRef.current = false;
          voicedFrames = 0;
          vadRef.current?.reset();

          const sttPromise =
            pendingSpec?.promise ??
            (spokenFrames >= MIN_FINAL_VOICED_FRAMES && captured && captured.length >= 16000 * 0.35
              ? postFinalStt(captured)
              : null);

          if (sttPromise) {
            setStatusText("กำลังถอดเสียงภาษาไทย…");
            void sttPromise
              .then((d) => {
                const finalWords = (d?.text ?? "").trim();
                setLiveUserHeard("");
                if (d?.voiced && finalWords) {
                  // Layer-3 text echo guard: drop residual echo sentences mirroring what Nong Tee just spoke.
                  const nowDone = performance.now();
                  if (nowDone - lastBotAudioMsRef.current < 8000) {
                    const recentSpoken = recentBotSpokenRef.current
                      .filter((e) => nowDone - e.at < 15000)
                      .map((e) => e.text)
                      .join(" ");
                    if (isEchoTranscript(finalWords, recentSpoken)) {
                      logVoiceClient({ kind: "echo_drop", heard: finalWords });
                      setHudState("listening");
                      setStatusText("🟢 น้องตี๋กำลังฟังเสียงของคุณอยู่ครับ…");
                      return;
                    }
                  }
                  // Zero-latency micro-noise filter drops only blank/filler ("อืม", "..."); all customer speech goes straight to Nong Tee.
                  if (d.gate && d.gate.allow === false) {
                    setHudState("listening");
                    setStatusText("🟢 น้องตี๋กำลังฟังเสียงของคุณอยู่ครับ…");
                    return;
                  }
                  const altWords = typeof d.altText === "string" ? d.altText.trim() : "";
                  // Latest sendTurn, not the one captured when the mic started (stale cart/history wiped the cart).
                  void sendTurnRef.current(finalWords, altWords && altWords !== finalWords ? { altHeard: altWords } : undefined);
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
      };

      // Strictly serialize async Silero VAD frame processing while capping backlog so latency never builds up.
      const pendingFrames: Array<{ frame: Float32Array; rms: number }> = [];
      let drainingFrames = false;
      const enqueueFrame = (frame: Float32Array, rms: number) => {
        if (pendingFrames.length >= 4) pendingFrames.shift();
        pendingFrames.push({ frame, rms });
        if (drainingFrames) return;
        drainingFrames = true;
        void (async () => {
          try {
            while (pendingFrames.length > 0 && micGraphGenRef.current === graphGen) {
              const next = pendingFrames.shift()!;
              await handleFrame(next.frame, next.rms);
            }
          } finally {
            drainingFrames = false;
          }
        })();
      };

      // Silent sink keeps AudioWorklet / ScriptProcessor active across browsers without ever outputting audio.
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      silentGain.connect(ctx.destination);

      let workletAttached = false;
      if (ctx.audioWorklet && typeof AudioWorkletNode === "function") {
        try {
          await ctx.audioWorklet.addModule("/vad/mic-capture.worklet.js");
          if (micGraphGenRef.current !== graphGen) return;
          const worklet = new AudioWorkletNode(ctx, "mb-mic-capture", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
          });
          worklet.port.onmessage = (ev: MessageEvent<{ frame: Float32Array; rms: number }>) => {
            if (ev.data?.frame) enqueueFrame(ev.data.frame, ev.data.rms);
          };
          hpf.connect(worklet);
          worklet.connect(silentGain);
          workletAttached = true;
        } catch {
          workletAttached = false;
        }
      }

      if (!workletAttached) {
        // Fallback for older browsers without AudioWorklet: downsample to 16 kHz / 512-sample frames inline.
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        const ratio = ctx.sampleRate / 16000;
        let outFrame = new Float32Array(512);
        let outIdx = 0;
        let phase = 0;
        proc.onaudioprocess = (ev) => {
          const ch = ev.inputBuffer.getChannelData(0);
          while (phase < ch.length) {
            const i0 = Math.floor(phase);
            const i1 = Math.min(ch.length - 1, i0 + 1);
            const frac = phase - i0;
            outFrame[outIdx++] = ch[i0] * (1 - frac) + ch[i1] * frac;
            phase += ratio;
            if (outIdx === 512) {
              let sumSq = 0;
              for (let i = 0; i < 512; i++) sumSq += outFrame[i] * outFrame[i];
              enqueueFrame(outFrame, Math.sqrt(sumSq / 512));
              outFrame = new Float32Array(512);
              outIdx = 0;
            }
          }
          phase -= ch.length;
        };
        hpf.connect(proc);
        proc.connect(silentGain);
      }
    },
    [logVoiceClient, stopAllAudioPlayback, teardownMicGraph],
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
      ttsSinkRef.current?.dispose();
      ttsSinkRef.current = null;
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
    const cards = activeNumberedCardsRef.current;
    const navCards = stageCardsRef.current;
    let reply = "";
    let speak = true;
    const showCardFrom = (list: JavisProductCard[], idx: number) => {
      const c = list[idx];
      if (!c) return false;
      openProductSpotlight(c);
      const price = c.bestPrice ? `ราคา ${c.bestPrice.replace(/\.00$/, "")} บาท ต่อ${c.unitLabel}` : "";
      reply = `เบอร์ ${idx + 1} ${c.title} ${price}ครับ`;
      return true;
    };
    const showCard = (idx: number) => showCardFrom(cards, idx);
    const spotIdx = () => navCards.findIndex((c) => c.slug === spotlight?.slug);
    const moveHistory = (dir: -1 | 1) => {
      const steps = Math.min(cmd.no ?? 1, 20);
      const snap = goScreenHistory(dir * steps);
      if (snap) reply = `${dir < 0 ? "ถอยกลับไป" : "เดินหน้าไป"}ที่ ${snapLabel(snap)} แล้วครับ`;
      else reply = dir < 0 ? "ถอยกลับไม่ได้แล้วครับ นี่คือหน้าแรกสุดที่ดูมา" : "เดินหน้าไม่ได้แล้วครับ นี่คือหน้าล่าสุด";
    };
    const moveItem = (dir: -1 | 1) => {
      const cur = stageMode === "spotlight" ? spotIdx() : -1;
      const next = cur < 0 ? 0 : cur + dir;
      if (!showCardFrom(navCards, next)) reply = dir > 0 ? `นี่คือตัวสุดท้ายแล้วครับ บนจอมี ${navCards.length} เบอร์` : "นี่คือเบอร์ 1 ตัวแรกแล้วครับ";
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
        reply = `บนจอมีสินค้า ${navCards.length} เบอร์ครับ พูดว่า ดูเบอร์ไหน หรือ เอาเบอร์ไหนกี่ชิ้น ได้เลย`;
        break;
      case "open_no":
        markMission("open");
        if (!showCard((cmd.no ?? 0) - 1)) reply = `บนจอมีเบอร์ 1 ถึง ${cards.length} ครับ ไม่มีเบอร์ ${cmd.no}`;
        break;
      case "details": {
        // Never guess: open the product already in spotlight, or the only card, else ask for the number.
        const cur = stageMode === "spotlight" ? spotIdx() : -1;
        if (cur >= 0) showCardFrom(navCards, cur);
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
          if (last) reportCommand(`🔗 แนะนำ: ${last.title}`, undefined, false);
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
    const seeds = inView.length ? inView : cart.items.length ? cart.items.map((it) => it.slug) : stageCardsRef.current.slice(0, 6).map((c) => c.slug);
    if (!seeds.length) return reportCommand("ยังไม่มีสินค้าให้สมองหาของเกี่ยวข้องครับ บอกชื่อสินค้าก่อนนะครับ", heard, true);
    const r = await fetchRelated(seeds, 48);
    if (!r?.cards.length) return reportCommand("สมองยังไม่พบของที่เกี่ยวข้องกับตัวนี้ครับ", heard, true);
    setRelated(r);
    setStageCards(r.cards);
    setSpotlight(r.cards[0]);
    setStageMode("showcase");
    setStageTitle("🔗 สมองแนะนำของที่เกี่ยวข้อง");
    reportCommand(`สมองพบของที่เกี่ยวข้อง ${r.cards.length} รายการครับ พูดว่า ใส่เบอร์ 1 หรือ ดูเบอร์ 2 ได้เลยครับ`, heard, true);
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
    // Show related recommendations visually on screen (silent — never speak cross-sell aloud).
    void fetchRelated([grown.slug], 36).then((r) => {
      if (!r?.cards.length) return;
      setRelated(r);
      const pick = nextSuggestion(r.cards);
      if (!pick) return;
      reportCommand(`🔗 แนะนำ: ${pick.title}`, undefined, false);
    });
  }, [cart.items, markMission]);

  useEffect(() => {
    if (!stageRelatedKey || stageRelated?.key === stageRelatedKey) return;
    const seeds = stageRelatedKey.split(",").filter(Boolean);
    if (!seeds.length) return;
    let alive = true;
    void fetchRelated(seeds, 36).then((r) => alive && r && setStageRelated({ key: stageRelatedKey, set: r }));
    return () => {
      alive = false;
    };
  }, [stageRelatedKey, stageRelated?.key]);

  useEffect(() => {
    if (stageMode !== "spotlight" || !spotlight) return;
    const slug = spotlight.slug;
    if (spotRelated?.slug === slug) return;
    let alive = true;
    void fetchRelated([slug], 36).then((r) => alive && r && setSpotRelated({ slug, set: r }));
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
          onClick={unlockAudioPlayback}
        >
          🔊 น้องตี๋เริ่มทำงานแล้วครับ — แตะตรงไหนก็ได้ 1 ครั้งเพื่อเปิดเสียงพูดของน้องตี๋
        </button>
      )}

      <h1 className="sr-only">น้องตี๋ · Javis ปิดการขาย MarketBrain</h1>

      {/* ==================== TOP NONG TEE COMMAND DOCK (REPLACES LEFT SIDEBAR) ==================== */}
      <div className="jc-top-dock" ref={dockPopRef} role="region" aria-label="แถบควบคุมเลขาน้องตี๋และค้นหาด้วยเสียง">
        <div className="jc-dock-row">
          <button
            type="button"
            className="jc-dock-orb jm-hud"
            data-state={hudState}
            aria-expanded={chatOpen}
            aria-label="เปิดประวัติสนทนากับเลขาน้องตี๋"
            title={`น้องตี๋ · ${statusText}`}
            onClick={() => {
              setDevLogOpen(false);
              setChatOpen((v) => !v);
            }}
          >
            <svg viewBox="0 0 44 44" aria-hidden="true">
              <circle cx="22" cy="22" r="19" className="jm-ring-bg" />
              <circle cx="22" cy="22" r="19" className="jm-ring-spin" />
            </svg>
            <span aria-hidden="true">🧑‍💼</span>
          </button>

          <span
            className="mb-wave jc-dock-wave"
            data-state={hudState}
            title={voiceEngineOnline ? "OmniVoice GPU พร้อมทำงาน" : statusText}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>

          <div className="jc-dock-icons" role="group" aria-label="ควบคุมเสียงและอุปกรณ์">
            <button
              type="button"
              className={`jc-icon-btn is-call${callActive ? " active" : ""}`}
              aria-pressed={callActive}
              aria-label={callActive ? "พักสายไมค์สด" : "เปิดไมค์สดคุยกับน้องตี๋"}
              title={callActive ? "พักสายไมค์สด" : "เปิดไมค์สดคุยกับน้องตี๋"}
              onClick={() => void startLiveCall()}
            >
              <span aria-hidden="true">{callActive ? "📴" : "📞"}</span>
            </button>

            {callActive && (
              <button
                type="button"
                className={`jc-icon-btn is-mic${micMuted ? " muted" : ""}`}
                aria-pressed={micMuted}
                aria-label={micMuted ? "เปิดไมค์" : "ปิดไมค์ชั่วคราว"}
                title={micMuted ? "เปิดไมค์" : "ปิดไมค์ชั่วคราวโดยสายไม่หลุด"}
                onClick={toggleMicMute}
              >
                <span aria-hidden="true">{micMuted ? "🔇" : "🎙️"}</span>
              </button>
            )}

            <button
              type="button"
              className={`jc-icon-btn is-spk${ttsEnabled ? " on" : " muted"}${ttsEnabled && hudState === "speaking" ? " speaking" : ""}`}
              aria-pressed={ttsEnabled}
              aria-label={ttsEnabled ? "ปิดเสียงพูดของน้องตี๋" : "เปิดเสียงพูดของน้องตี๋"}
              title={ttsEnabled ? "ปิดเสียงพูดของน้องตี๋" : "เปิดเสียงพูดของน้องตี๋"}
              onClick={() => {
                if (ttsEnabled) stopAllAudioPlayback();
                setTtsEnabled((v) => !v);
              }}
            >
              <span aria-hidden="true">{ttsEnabled ? "🔊" : "🔇"}</span>
            </button>

            <DevicePickerPopover
              iconOnly
              buttonClassName="jc-icon-btn is-gear"
              activeMicStream={activeMicStreamState}
              onOpenCameraScanner={() => setStageMode("camera")}
              onSelectPhotoFile={(f) => void handleQuickPhotoFile(f)}
            />
          </div>

          <form
            className="jc-dock-form"
            onSubmit={(e) => {
              e.preventDefault();
              void sendTurn(input);
            }}
          >
            <button
              type="button"
              className={`jc-dock-in-btn${stageMode === "camera" ? " active" : ""}`}
              onClick={() => setStageMode(stageMode === "camera" ? "showcase" : "camera")}
              title="เปิดกล้องส่องหาสินค้า"
              aria-label="เปิดกล้องส่องหาสินค้า"
            >
              📷
            </button>
            <button
              type="button"
              className={`jc-dock-in-btn${visionUploading ? " spinning" : ""}`}
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
              placeholder="พูดหรือพิมพ์คุย วางรูป (Ctrl+V) เช่น เอาไฮคิว 5 กล่อง…"
              aria-label="พิมพ์ข้อความคุยกับน้องตี๋"
              disabled={busy}
            />
            {busy ? (
              <button
                type="button"
                className="jc-dock-stop-btn"
                onClick={() => abortRef.current?.abort()}
                title="หยุดการตอบ"
                aria-label="หยุดการตอบ"
              >
                ⏹ หยุด
              </button>
            ) : (
              <button
                type="submit"
                className="jc-dock-send-btn"
                disabled={!input.trim()}
                title="ส่งข้อความ"
                aria-label="ส่งข้อความ"
              >
                ➤
              </button>
            )}
          </form>

          <div className="jc-dock-right">
            <button
              type="button"
              className="jc-dock-engine-pill"
              data-provider={
                llmStatus.activeProvider === "fallback"
                  ? "fallback"
                  : !llmStatus.localOnline
                    ? "offline"
                    : llmStatus.activeProvider === "ram"
                      ? "ram"
                      : "local"
              }
              title={
                llmStatus.lastFallbackReason
                  ? `สลับสำรองเพราะ: ${llmStatus.lastFallbackReason}`
                  : `${voiceEngineOnline ? "OmniVoice GPU · " : ""}หลัก: ${llmStatus.primaryModel}${llmStatus.lastTps ? ` (${llmStatus.lastTps} t/s)` : ""} · L:${llmStatus.stats.localTurns} R:${llmStatus.stats.ramTurns} B:${llmStatus.stats.fallbackTurns}`
              }
              aria-expanded={devLogOpen}
              onClick={() => {
                const next = !devLogOpen;
                setChatOpen(false);
                setDevLogOpen(next);
                if (next) void refreshDevLogs();
              }}
            >
              <span className="jc-led" aria-hidden="true" />
              <span className="jc-dock-engine-txt">
                {llmStatus.activeProvider === "fallback"
                  ? `สำรอง DeepSeek${llmStatus.lastMs ? ` · ${fmtMs(llmStatus.lastMs)}` : ""}`
                  : !llmStatus.localOnline
                    ? "Local ออฟไลน์"
                    : llmStatus.activeProvider === "ram"
                      ? `สมองด่วน${llmStatus.lastMs ? ` · ${fmtMs(llmStatus.lastMs)}` : ""}`
                      : `gemma4${
                          llmStatus.lastMs
                            ? ` · ${fmtMs(llmStatus.lastMs)}`
                            : llmStatus.modelLoaded
                              ? " · พร้อม"
                              : " · อุ่น"
                        }`}
              </span>
              {voiceEngineOnline && <span className="jc-gpu-dot" title="OmniVoice GPU พร้อม" aria-hidden="true" />}
            </button>

            <button
              type="button"
              className={`jc-icon-btn is-chat${chatOpen ? " active" : ""}`}
              aria-expanded={chatOpen}
              aria-label="ประวัติคุยกับน้องตี๋"
              title="ประวัติคุยกับน้องตี๋"
              onClick={() => {
                setDevLogOpen(false);
                setChatOpen((v) => !v);
              }}
            >
              <span aria-hidden="true">💬</span>
              {turns.length > 0 && <span className="jc-icon-badge">{turns.length}</span>}
            </button>

            <button
              type="button"
              className={`jc-icon-btn is-log${devLogOpen ? " active" : ""}`}
              aria-expanded={devLogOpen}
              aria-label="บันทึกการทำงาน AI (Dev Log)"
              title={`บันทึกการทำงาน AI (L:${llmStatus.stats.localTurns} R:${llmStatus.stats.ramTurns} B:${llmStatus.stats.fallbackTurns})`}
              onClick={() => {
                const next = !devLogOpen;
                setChatOpen(false);
                setDevLogOpen(next);
                if (next) void refreshDevLogs();
              }}
            >
              <span aria-hidden="true">📋</span>
            </button>
          </div>
        </div>

        <div className="jc-dock-ticker" role="status" aria-live="polite">
          {liveUserHeard ? (
            <p className="jc-tick-heard">🎤 ได้ยินว่า: “{liveUserHeard}”</p>
          ) : liveKaraokeText ? (
            <div className="jc-tick-karaoke">
              <span aria-hidden="true">🔊</span>
              <KaraokeWords text={liveKaraokeText} pct={karaokeProgress} />
            </div>
          ) : busy && latestJobs.length > 0 ? (
            <div className="jc-tick-jobs">
              <span className="jc-tick-status">{statusText}</span>
              {latestJobs.slice(-3).map((j) => (
                <span key={j.id} className={`jc-wchip st-${j.state}`}>
                  <i className="jm-dot" />
                  <b>{j.label}</b>
                  {j.ms !== undefined && <small>{j.ms}ms</small>}
                </span>
              ))}
            </div>
          ) : latestTurn?.spokenText ? (
            <div className="jc-tick-reply">
              <button
                type="button"
                className="jc-tick-reply-btn"
                onClick={() => {
                  setDevLogOpen(false);
                  setChatOpen(true);
                }}
                title="คลิกเพื่อดูประวัติสนทนาทั้งหมด"
              >
                <span aria-hidden="true">🧑‍💼</span>
                <span className="jc-tick-text">{latestTurn.spokenText}</span>
              </button>
              <div className="jc-tick-actions">
                {latestTurn.model && (
                  <span className={`jc-turn-engine p-${latestTurn.provider || "local"}`}>
                    {latestTurn.provider === "ram"
                      ? "⚡ สมองด่วน"
                      : latestTurn.provider === "fallback"
                        ? "🟡 สำรอง"
                        : "🟢 gemma4"}
                    {latestTurn.ms !== undefined ? ` · ${fmtMs(latestTurn.ms)}` : ""}
                  </span>
                )}
                <button
                  type="button"
                  className="jc-tick-speak"
                  onClick={() => enqueueOmniVoiceSentence(latestTurn.spokenText)}
                  title="ฟังคำตอบนี้อีกครั้ง"
                  aria-label="ฟังคำตอบนี้อีกครั้ง"
                >
                  🔊
                </button>
              </div>
            </div>
          ) : (
            <div className="jc-tick-idle">
              <span className="jc-tick-status">{statusText}</span>
              <div className="jc-tick-chips">
                {QUICK_SCENARIOS.slice(0, 3).map((sc) => (
                  <button
                    key={sc.label}
                    type="button"
                    className="jc-tick-chip"
                    onClick={() => void sendTurn(sc.prompt)}
                  >
                    <span>{sc.icon}</span>
                    <span>{sc.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {chatOpen && (
          <div className="jc-chat-popover" role="dialog" aria-label="ประวัติสนทนากับเลขาน้องตี๋">
            <div className="jc-pop-head">
              <div className="jc-pop-title">
                <b>🧑‍💼 น้องตี๋ · ประวัติสนทนา</b>
                <span className={`jc-voice-pill${voiceEngineOnline ? " online" : ""}`}>
                  {voiceEngineOnline ? "OmniVoice GPU" : "Active"}
                </span>
              </div>
              <button type="button" className="jm-close-btn" onClick={() => setChatOpen(false)} aria-label="ปิดหน้าต่างแชท">
                ✕
              </button>
            </div>
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
                      onClick={() => {
                        setChatOpen(false);
                        setStageMode("camera");
                      }}
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
                        onClick={() => {
                          setChatOpen(false);
                          void sendTurn(sc.prompt);
                        }}
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
                        <div className="jc-b-head-left">
                          <b>🧑‍💼 น้องตี๋</b>
                          {(t.spokenText || t.error) && t.model && (
                            <span
                              className={`jc-turn-engine p-${t.provider || "local"}`}
                              title={
                                t.fallbackReason
                                  ? `${t.model} (สำรองเพราะ: ${t.fallbackReason})`
                                  : `${t.model}${t.tps ? ` · ${t.tps} t/s` : ""}`
                              }
                            >
                              {t.provider === "ram"
                                ? "⚡ สมองด่วน"
                                : t.provider === "fallback"
                                  ? "🟡 สำรอง"
                                  : "🟢 gemma4"}
                              {t.ms !== undefined ? ` · ${fmtMs(t.ms)}` : ""}
                            </span>
                          )}
                        </div>
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
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        )}

        {devLogOpen && (
          <div className="jc-dev-popover" role="region" aria-label="บันทึกการทำงาน AI (Dev Log)">
            <div className="jc-dev-drawer-head">
              <b>
                บันทึกการทำงาน AI (.data/llm-dev.jsonl) · L:{llmStatus.stats.localTurns} R:{llmStatus.stats.ramTurns} B:{llmStatus.stats.fallbackTurns}
              </b>
              <div className="jc-dev-drawer-acts">
                <button
                  type="button"
                  className="jc-dev-mini-btn"
                  disabled={devLogsLoading}
                  onClick={() => void refreshDevLogs()}
                >
                  {devLogsLoading ? "…" : "รีเฟรช"}
                </button>
                <button type="button" className="jc-dev-mini-btn" onClick={() => setDevLogOpen(false)}>
                  ปิด
                </button>
              </div>
            </div>
            <div className="jc-dev-log-list">
              {devLogs.length === 0 ? (
                <p className="jc-dev-empty">ยังไม่มีรายการบันทึก AI ล่าสุด (ลองค้นหาหรือคุยกับน้องตี๋ครับ)</p>
              ) : (
                devLogs.map((row, idx) => (
                  <div key={`${row.ts || idx}-${row.phase}-${idx}`} className="jc-dev-row" data-err={row.ok === false ? "1" : undefined}>
                    <span className="jc-dev-time">
                      {row.ts ? new Date(row.ts).toLocaleTimeString("th-TH", { hour12: false }) : "--:--:--"}
                    </span>
                    <span className="jc-dev-phase">{PHASE_LABEL_TH[row.phase] || row.phase}</span>
                    <span className={`jc-dev-prov p-${row.provider}`}>
                      {row.provider === "local" ? "Local" : row.provider === "fallback" ? "สำรอง" : "RAM"}
                    </span>
                    <span className="jc-dev-model">{row.model}</span>
                    <span className="jc-dev-ms">
                      {row.ms}ms{row.tps ? ` · ${row.tps}t/s` : ""}
                    </span>
                    {row.query && <span className="jc-dev-q">“{row.query}”</span>}
                    {row.toolCalls && row.toolCalls.length > 0 && (
                      <span className="jc-dev-tools">[{row.toolCalls.join(", ")}]</span>
                    )}
                    {row.fallbackReason && <span className="jc-dev-warn">สำรอง: {row.fallbackReason}</span>}
                    {row.error && <span className="jc-dev-err">ERR: {row.error}</span>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile-only View Switcher (< 768px): Products vs Cart */}
      <nav className="jc-mobile-tabs" aria-label="สลับมุมมองบนมือถือ">
        <button
          type="button"
          className={`jc-mtab${mobileTab === "stage" ? " active" : ""}`}
          aria-pressed={mobileTab === "stage"}
          onClick={() => setMobileTab("stage")}
        >
          🛍️ สินค้า{stageCards.length > 0 ? ` (${stageCards.length})` : ""}
        </button>
        <button
          type="button"
          className={`jc-mtab${mobileTab === "cart" ? " active" : ""}`}
          aria-pressed={mobileTab === "cart"}
          onClick={() => setMobileTab("cart")}
        >
          🛒 ตะกร้า
          {cart.itemCount > 0 && (
            <>
              {" "}
              <span key={cart.itemCount} className="mb-count-bump">
                ({cart.itemCount})
              </span>
            </>
          )}
        </button>
      </nav>

      <div className="jc-grid" data-mtab={mobileTab}>
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
              🛒 ตะกร้า
              <span key={cart.itemCount} className="mb-count-bump">
                ({cart.itemCount})
              </span>
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

          <div className="jc-stage-body" ref={stageBodyRef}>
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
                    <button type="button" className="btn" onClick={() => void showRelated(undefined)}>
                      🔗 สินค้าเกี่ยวข้องทั้งหมด
                    </button>
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

                <ProductCardGrid
                  cards={stageCards}
                  reasons={stageTitle === "🔗 สมองแนะนำของที่เกี่ยวข้อง" ? related?.reasons : undefined}
                  actionFx={actionFx}
                  onAdd={promptAddToCart}
                  onDetail={openProductSpotlight}
                />

                {showcaseRelatedShown.length > 0 && stageRelated && (
                  <RelatedStrip
                    title="🔗 สินค้าที่เกี่ยวข้องจากสมอง"
                    startNo={stageCards.length + 1}
                    cards={showcaseRelatedShown}
                    reasons={stageRelated.set.reasons}
                    totalCount={showcaseRelatedAll.length}
                    actionFx={actionFx}
                    onAdd={promptAddToCart}
                    onDetail={openProductSpotlight}
                    onShowAll={() => void showRelated(undefined)}
                  />
                )}
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

                {spotRelatedShown.length > 0 && spotRelated && (
                  <RelatedStrip
                    cards={spotRelatedShown}
                    reasons={spotRelated.set.reasons}
                    totalCount={spotRelatedAll.length}
                    actionFx={actionFx}
                    onAdd={promptAddToCart}
                    onDetail={openProductSpotlight}
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

                {cartRelatedShown.length > 0 && related && (
                  <RelatedStrip
                    cards={cartRelatedShown}
                    reasons={related.reasons}
                    totalCount={cartRelatedAll.length}
                    actionFx={actionFx}
                    onAdd={promptAddToCart}
                    onDetail={openProductSpotlight}
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
                        <strong key={cart.grandTotalFormatted} className="mb-total-pulse">
                          {cart.grandTotalFormatted}
                        </strong>
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
            <h3>
              🛒 ตะกร้าสด{" "}
              <span key={cart.itemCount} className="mb-count-bump">
                ({cart.itemCount})
              </span>
            </h3>
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
              <strong key={cart.grandTotalFormatted} className="mb-total-pulse">
                {cart.grandTotalFormatted}
              </strong>
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

      <audio ref={ttsAudioRef} playsInline preload="auto" hidden />

      <FloatingJavisHud
        state={hudState}
        micLive={callActive && !micMuted}
        userLevelRef={userLevelRef}
        botLevelGetterRef={botLevelGetterRef}
        satelliteEvent={hudSatEvent}
        onClickToggle={() => {
          unlockAudioPlayback();
          if (!callActiveRef.current) void startLiveCall();
          else toggleMicMute();
        }}
      />
    </div>
  );
}
