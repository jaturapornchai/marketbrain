// Snaps misheard words to the spelling the system knows, before anything decides what the sentence means.
// The listener writes what it hears ("ปิดใหม่" for "ปิดไมค์", "บริส" for "บรีส", "หนึ่งรัง" for "หนึ่งลัง"),
// while every decision after it (screen command, order, product search) matches on spelling.
// Pure text rules on Thai sounds: no LLM, no network, no DB.
import { NUM_WORDS, parseNumberedOrder, parsePointedOrder, parseThaiNumber } from "./numbered-order";
import { COMMAND_WORDS, parseBudget, parseScreenCommand } from "./voice-commands";

// ---------- Sound key: two spellings that are said the same way get the same key ----------
// Syllable-initial consonants keep their sound class; finals collapse the way Thai finals do (ก ค -> K).
const INITIAL: Record<string, string> = {};
const FINAL: Record<string, string> = {};
const INITIAL_CLASSES = ["คขฆ", "ชฉฌ", "สซศษ", "ยญ", "ดฎ", "ตฏ", "ทฐฑฒถธ", "นณ", "พผภ", "ฟฝ", "ลรฬ", "หฮ"];
const FINAL_CLASSES: Array<[string, string]> = [
  ["K", "กขคฆ"],
  ["T", "จฉชฌซศษสฎฏฐฑฒดตถทธ"],
  ["P", "บปผพภฝฟ"],
  ["N", "นณญรลฬ"],
  ["M", "ม"],
  ["G", "ง"],
  ["Y", "ย"],
  ["W", "ว"],
];
for (const members of INITIAL_CLASSES) for (const m of members) INITIAL[m] = members[0];
for (const [symbol, members] of FINAL_CLASSES) for (const m of members) FINAL[m] = symbol;

const CONSONANT_RE = /[ก-ฮ]/;
const VOWEL_MARKS = "ะัาิึุ";
const LEADING_VOWELS = "เแโ";
const CLUSTER_HEADS = "กขคฆตปผพภบดทฟ";

/** Spelling differences that make no sound: tone marks, silent letters, short/long vowels, leading ห. */
function normalizeSpelling(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^ก-๙a-z0-9]/g, "")
    .replace(/ํา/g, "ำ")
    .replace(/เห็น/g, "เฮน") // the one common word where ห before น is really said
    .replace(/(เ[ก-ฮ])ย์/g, "$1ย") // "เลย์" is heard as "เลย"
    .replace(/[ทตดสศ]ร์/g, "")
    .replace(/[ก-ฮ][ิุ]?์/g, "")
    .replace(/[็-๎ๆฯฺ]/g, "")
    .replace(/รร(?=[ก-ฮ])/g, "ั")
    .replace(/รร/g, "ัน")
    .replace(/ห(?=[งญนมยรลว])/g, "")
    .replace(/[ไใ]([กขคฆตปผพภบดทฟ][รลว])(?![ะ-ฺ])/g, "$1าย")
    .replace(/[ไใ]([ก-ฮ])/g, "$1าย")
    .replace(/ัย/g, "าย")
    .replace(/ายย/g, "าย")
    .replace(/ำ/g, "ัม")
    .replace(/ี/g, "ิ")
    .replace(/ื/g, "ึ")
    .replace(/ู/g, "ุ");
}

const isVowelMark = (ch: string | undefined): boolean => !!ch && VOWEL_MARKS.includes(ch);

/**
 * Same key = said the same way ("ซันไลต์" = "สันไลด์", "แปรง" = "แปลง", "ปิดไมค์" = "ปิดใหม่").
 * Two bare consonants after a finished syllable can be read two ways ("กาแฟ|ลด" or "กาแฟล|ด");
 * `pairUp` picks the first reading, so a word is compared under both (see soundKeys).
 */
export function soundKey(raw: string, pairUp = false): string {
  const s = normalizeSpelling(raw);
  let key = "";
  let needInitial = true; // the next consonant starts a syllable
  let hasVowel = false; // the syllable being read already has a written vowel
  let leadingVowel = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (LEADING_VOWELS.includes(c)) {
      key += c;
      needInitial = true;
      leadingVowel = true;
      continue;
    }
    if (VOWEL_MARKS.includes(c)) {
      key += c;
      hasVowel = true;
      continue;
    }
    if (!CONSONANT_RE.test(c)) {
      key += c; // Latin letter or digit
      needInitial = true;
      hasVowel = false;
      leadingVowel = false;
      continue;
    }
    const next = s[i + 1] ?? "";
    const semi = c === "อ" || c === "ว";
    const after = s[i + 2] ?? "";
    const startsSyllable =
      needInitial ||
      isVowelMark(next) ||
      (!semi && (next === "อ" || next === "ว")) ||
      ((next === "ร" || next === "ล") && CLUSTER_HEADS.includes(c) && (isVowelMark(after) || after === "อ")) ||
      // "ลด", "รส", "ผง": a consonant pair that is a syllable of its own.
      (pairUp && hasVowel && !semi && CONSONANT_RE.test(next) && !"อวย".includes(next) && !isVowelMark(after) && after !== "อ" && after !== "ว");
    if (startsSyllable) {
      key += INITIAL[c] ?? c;
      hasVowel = needInitial && leadingVowel;
      needInitial = false;
      leadingVowel = false;
      continue;
    }
    const last = key[key.length - 1];
    // อ/ว written as the vowel ("คอม", "สวน"), and the tails of เ-ีย / เ-ือ.
    if ((semi && !hasVowel) || (c === "ย" && last === "ิ") || (c === "อ" && last === "ึ")) {
      key += c === "อ" ? "O" : c === "ว" ? "U" : "I";
      hasVowel = true;
      continue;
    }
    key += FINAL[c] ?? c;
    needInitial = true;
    hasVowel = false;
  }
  return key;
}

/** Every reading of the word (one key, or two when a consonant pair is ambiguous). */
function soundKeys(raw: string): string[] {
  const plain = soundKey(raw);
  const paired = soundKey(raw, true);
  return paired === plain ? [plain] : [plain, paired];
}

// ---------- What counts as "the system already understands this" ----------
const MAX_CARDS = 99;
const isDecision = (t: string): boolean =>
  parseScreenCommand(t, { modalOpen: true }) !== null ||
  parseNumberedOrder(t, MAX_CARDS) !== null ||
  parsePointedOrder(t) !== null ||
  parseBudget(t, parseThaiNumber) !== null;

type Snap = { a: number; b: number; text: string; weight: number };

const COMBINING_RE = /[ะ-ฺ็-๎ๆ]/;
/** A word cannot begin or end between a letter and its vowel/tone mark, after a leading vowel, or before a silent letter ("เบอ|ร์"). */
const canCutAt = (t: string, p: number): boolean =>
  p === 0 ||
  p === t.length ||
  (!COMBINING_RE.test(t[p]) && !/[เแโไใ]/.test(t[p - 1]) && !/^[ก-ฮ]?[ก-ฮ][ิุ]?์/.test(t.slice(p, p + 4)));

/** Longest replacements first, never two on the same letters; returns the rewritten text. */
function applySnaps(compact: string, snaps: Snap[], originalIndex?: number[], original?: string): string {
  const chosen: Snap[] = [];
  for (const s of [...snaps].sort((x, y) => y.b - y.a - (x.b - x.a) || y.weight - x.weight)) {
    if (chosen.every((c) => s.b <= c.a || s.a >= c.b)) chosen.push(s);
  }
  let out = original ?? compact;
  for (const s of chosen.sort((x, y) => y.a - x.a)) {
    const from = originalIndex ? originalIndex[s.a] : s.a;
    const to = originalIndex ? originalIndex[s.b - 1] + 1 : s.b;
    out = out.slice(0, from) + s.text + out.slice(to);
  }
  return out;
}

// ---------- Stage: the listener sometimes writes the whole sentence twice ("ปิดกล้องปิดกล้อง") ----------
function collapseRepeat(t: string): string {
  const compact = t.replace(/\s+/g, "");
  const half = compact.length / 2;
  return half >= 4 && Number.isInteger(half) && compact.slice(0, half) === compact.slice(half) ? compact.slice(0, half) : t;
}

// ---------- Stage: unit word right after a quantity ----------
// Only pairs measured on real audio: unit words are too short for a sound rule ("ก่อน" would become "ก้อน").
const UNIT_HEARD: Record<string, string> = { รัง: "ลัง" };
// What may follow a unit word: the end, a polite word, or the next item.
const AFTER_UNIT = "(?=$|\\s|ครับ|ค่ะ|คะ|นะ|เลย|ด้วย|พอ|ก่อน|เบอร์|และ|กับ|แล้ว)";
const AFTER_UNIT_RE = new RegExp(`^${AFTER_UNIT}`);
const UNIT_RE = new RegExp(`(\\d|${NUM_WORDS})(\\s*)(${Object.keys(UNIT_HEARD).join("|")})${AFTER_UNIT}`, "g");

/**
 * True when `said` begins with a word said the same way as `unit` ("โลครับ" for something sold by the "โหล").
 * Safe only against the units one product is really sold in: across all unit words, sound alone is too loose.
 */
export function startsWithUnitSound(said: string, unit: string): boolean {
  const key = soundKey(unit);
  if (key.length < 2) return false;
  for (let len = 2; len <= Math.min(said.length, unit.length + 2); len++) {
    if (AFTER_UNIT_RE.test(said.slice(len)) && soundKey(said.slice(0, len)) === key) return true;
  }
  return false;
}

// ---------- Stage: command words (kept only when the sentence then IS a command) ----------
const COMMAND_BY_KEY = new Map(COMMAND_WORDS.flatMap((w) => soundKeys(w).map((k): [string, string] => [k, w])));
const MAX_COMMAND_WORD = Math.max(...COMMAND_WORDS.map((w) => w.length)) + 3;
// Heard in a way the sound rule cannot bridge; measured on real audio.
const COMMAND_HEARD: Array<[RegExp, string]> = [
  [/หอยกลับ/g, "ถอยกลับ"],
  [/บิว/g, "บิล"],
];

function fixCommandWords(text: string): string | null {
  const squashed = text.replace(/[\s.,!?"'“”]+/g, "");
  if (squashed.length > 44) return null;
  let t = squashed;
  for (const [heard, meant] of COMMAND_HEARD) t = t.replace(heard, meant);
  const snaps: Snap[] = [];
  for (let a = 0; a < t.length; a++) {
    if (!canCutAt(t, a)) continue;
    for (let b = Math.min(t.length, a + MAX_COMMAND_WORD); b >= a + 2; b--) {
      if (!canCutAt(t, b)) continue;
      const span = t.slice(a, b);
      const word = soundKeys(span).map((k) => COMMAND_BY_KEY.get(k)).find(Boolean);
      if (word && word !== span) snaps.push({ a, b, text: word, weight: 0 });
    }
  }
  const fixed = applySnaps(t, snaps);
  return fixed !== squashed && isDecision(fixed) ? fixed : null;
}

// ---------- Stage: catalogue words (brand and product names as the catalogue spells them) ----------
type VocabHit = { text: string; compact: string; weight: number; brand: boolean };
export type HeardVocab = {
  /** Sound key -> the catalogue spelling a customer most likely means. */
  byKey: Map<string, VocabHit>;
  /** Every catalogue word with its spaces removed: already right, never touched. */
  exact: Set<string>;
  /** English brand name (letters only, lower case) -> brand name as the catalogue writes it. */
  latin: Map<string, string>;
  maxLen: number;
};

type VocabProduct = { nameTh?: string | null; brandTh?: string | null; brandEn?: string | null };

const THAI_WORD_RE = /^[ก-๙]{2,}(?:-[ก-๙]+)*$/; // "แอล-คาร์นิทีน" is one word
const MIN_KEY = 4; // shorter keys are everyday one-syllable words ("ขาย" = "ไข่")
const BRAND_WEIGHT = 5;
const latinKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Builds the listener's vocabulary from the products in the brain (call once per brain load). */
export function buildHeardVocab(products: ReadonlyArray<VocabProduct>): HeardVocab {
  const weightOf = new Map<string, number>();
  const brandLed = new Set<string>(); // a brand name, or a phrase that begins with one
  const add = (text: string, weight: number, brand = false) => {
    weightOf.set(text, (weightOf.get(text) ?? 0) + weight);
    if (brand) brandLed.add(text);
  };
  const latin = new Map<string, string>();
  for (const p of products) {
    const brand = (p.brandTh ?? "").trim();
    if (brand) add(brand, BRAND_WEIGHT, true);
    if (brand && p.brandEn && latinKey(p.brandEn).length >= 3) latin.set(latinKey(p.brandEn), brand);
    const words = (p.nameTh ?? "").split(/[\s,()/+*]+/).filter((w) => THAI_WORD_RE.test(w));
    for (const w of new Set(words)) add(w, 1);
    // "brand + first word" is how a product is asked for out loud ("เลย์ คลาสสิค").
    if (words.length >= 2) add(`${words[0]} ${words[1]}`, 1, words[0] === brand);
  }
  add("น้องตี๋", 1000);
  const vocab: HeardVocab = { byKey: new Map(), exact: new Set(), latin, maxLen: 0 };
  for (const [text, weight] of weightOf) {
    const compact = text.replace(/[\s-]+/g, "");
    if (!/^[ก-๙0-9]+$/.test(compact)) continue; // Latin names go through `latin`
    vocab.exact.add(compact);
    for (const key of soundKeys(compact)) {
      if (key.length < MIN_KEY) continue;
      vocab.maxLen = Math.max(vocab.maxLen, compact.length);
      const best = vocab.byKey.get(key);
      if (!best || weight > best.weight) vocab.byKey.set(key, { text, compact, weight, brand: brandLed.has(text) });
    }
  }
  return vocab;
}

// Everyday words that are never a product name, even when one sounds the same ("ครับ" / "คลับ").
const EVERYDAY = new Set(
  (
    "ครับ ครับผม คับ ค่ะ คะ ค่า จ้า จ้ะ นะ หน่อย ด้วย เลย สิ ซิ ที ไหม มั้ย หรือ หรือเปล่า เปล่า ไหน อะไร ยังไง อย่างไร ทำไม " +
    "เท่าไหร่ เท่าไร กี่ ขอ ขอดู ดู เอา รับ สั่ง ซื้อ ใส่ เพิ่ม หยิบ จัด หา ค้นหา มี ไม่มี ไม่ ใช่ ไม่ใช่ ได้ ไม่ได้ อยาก อยากได้ ต้องการ " +
    "ช่วย แนะนำ บอก ถาม ตอบ ขาย ราคา บาท ถูก แพง คุ้ม ลด ส่วนลด ของ สินค้า ตัว อัน ชิ้น อันนี้ ตัวนี้ อันไหน ตัวไหน แบบไหน แบบ ยี่ห้อ รุ่น " +
    "ขนาด เล็ก กลาง ใหญ่ มาก น้อย ที่สุด กว่า ดี ดีกว่า เหมือน เหมือนกัน ต่างกัน อื่น อย่างอื่น ทั้งหมด บ้าง อีก แล้ว ก่อน หลัง ตอนนี้ วันนี้ " +
    "พรุ่งนี้ สำหรับ กับ และ หรือ ที่ ใน บน จาก ให้ ไป มา อยู่ เป็น คือ ว่า ก็ จะ ต้อง ควร เคย ยัง พอ เท่านั้น ประมาณ น้องตี๋ ตี๋ ผม ฉัน เรา คุณ " +
    "พี่ น้อง ลุง ป้า สวัสดี ขอบคุณ ขอโทษ โอเค ตกลง ใช่ไหม ได้ไหม มีไหม เอาไหม ทำอะไร ใช้ ทำ กิน ดื่ม ทาน อร่อย หอม สะอาด ใหม่ เก่า " +
    "ตะกร้า เบอร์ รายการ จำนวน หน่วย รวม ยอด จ่าย เงิน โอน ส่ง จัดส่ง ที่อยู่ ชื่อ เบอร์โทร โทร"
  ).split(" "),
);
const MAX_EVERYDAY = Math.max(...[...EVERYDAY].map((w) => w.length));
const TAIL_RE = /(?:ไหม|มั้ย|หรือเปล่า|บ้าง|หน่อย|ด้วย|นะ|ครับผม|ครับ|คับ|ค่ะ|คะ|จ้า|จ้ะ)+$/;

// Node's own Thai dictionary tells a correctly spelled everyday word from a misheard one, with no word list to keep.
const thaiWords = new Intl.Segmenter("th", { granularity: "word" });
const dictWordCache = new Map<string, boolean>();
/**
 * A real word stays whole between two other words; a misheard one mostly breaks up or sticks to its neighbour.
 * An unknown syllable can pass too, which only means it is left as heard.
 */
function isDictWord(w: string): boolean {
  let ok = dictWordCache.get(w);
  if (ok === undefined) {
    const parts = Array.from(thaiWords.segment(`ดี${w}ดี`), (x) => x.segment);
    ok = parts.length === 3 && parts[1] === w;
    if (dictWordCache.size < 50000) dictWordCache.set(w, ok);
  }
  return ok;
}
/** Where the dictionary's words fall in a sentence, as [start, end) pairs. */
function dictWordSpans(compact: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (const { segment } of thaiWords.segment(compact)) {
    if (segment.length >= 2 && isDictWord(segment)) spans.push([at, at + segment.length]);
    at += segment.length;
  }
  return spans;
}
const MIN_COMMON = 5; // a catalogue word on this many products is a real word, not a one-off spelling

/** Punctuation, "ๆ" and "฿" are hard stops: a correction never reaches across one or removes it ("แปรงสีฟัน+ยาสีฟัน", "อสร."). */
const snapToCatalog = (text: string, vocab: HeardVocab): string =>
  text.replace(/[ก-ฺเ-ๅ็-๙0-9][ก-ฺเ-ๅ็-๙0-9\s-]*/g, (run) => snapRun(run, vocab));

function snapRun(text: string, vocab: HeardVocab): string {
  const originalIndex: number[] = [];
  let compact = "";
  for (let i = 0; i < text.length; i++) {
    if (/[\s-]/.test(text[i])) continue; // spaces and hyphens are not said
    originalIndex.push(i);
    compact += text[i];
  }
  const n = compact.length;
  if (n < 3 || n > 160) return text;

  const isWord = (w: string) => vocab.exact.has(w) || EVERYDAY.has(w);
  const maxWord = Math.max(vocab.maxLen, MAX_EVERYDAY);
  // Catalogue words that are already spelled right: a replacement may hold one whole, never cut through or sit inside it.
  const rightWords: Array<[number, number]> = [];
  const wordEndsAt = new Set<number>();
  const wordStartsAt = new Set<number>();
  for (let a = 0; a < n; a++) {
    for (let b = a + 2; b <= Math.min(n, a + maxWord); b++) {
      const w = compact.slice(a, b);
      if (!isWord(w)) continue;
      wordStartsAt.add(a);
      wordEndsAt.add(b);
      if (b - a >= 4 && vocab.exact.has(w)) rightWords.push([a, b]);
    }
  }
  const dictSegs = dictWordSpans(compact);
  const cutsDictWord = (p: number) => dictSegs.some(([x, y]) => x < p && p < y);
  /** How many dictionary words the letters a..b are, end to end (0 = not just dictionary words). */
  const dictWordsIn = (a: number, b: number): number => {
    let p = a, count = 0;
    for (const [x, y] of dictSegs) {
      if (x < p) continue;
      if (x !== p || y > b) return 0;
      p = y; count++;
      if (p === b) return count;
    }
    return 0;
  };
  const fullKey = soundKey(compact);
  const syllableBreak = new Map<number, boolean>();
  const isSyllableBreak = (p: number): boolean => {
    let ok = syllableBreak.get(p);
    if (ok === undefined) {
      ok = soundKey(compact.slice(0, p)) + soundKey(compact.slice(p)) === fullKey;
      syllableBreak.set(p, ok);
    }
    return ok;
  };
  const canStart = (a: number) => canCutAt(compact, a) && !cutsDictWord(a) && (a === 0 || wordEndsAt.has(a) || isSyllableBreak(a));
  // The question/polite ending of a sentence is never part of a product name ("…เบบี้ไหมครับ" is not "เบบี้ มายด์").
  const tailStart = n - (TAIL_RE.exec(compact)?.[0].length ?? 0);
  const canEnd = (b: number) => b <= tailStart && canCutAt(compact, b) && !cutsDictWord(b) && (b === tailStart || wordStartsAt.has(b) || isSyllableBreak(b));

  /** True when the letters a..b can be read as words of the given kind, end to end. */
  const madeOf = (a: number, b: number, isPiece: (w: string) => boolean): boolean => {
    const reach = new Set([a]);
    for (let p = a; p < b; p++) {
      if (!reach.has(p)) continue;
      for (let q = p + 2; q <= b; q++) if (isPiece(compact.slice(p, q))) reach.add(q);
    }
    return reach.has(b);
  };
  /** Real words end to end: nothing there was misheard. */
  const allWords = (a: number, b: number) => madeOf(a, b, isWord);
  /** Long catalogue words end to end: even a brand that sounds the same is not what was said ("ดาร์ลี่ ยาสีฟัน"). */
  const strongWords = (a: number, b: number) => madeOf(a, b, (w) => w.length >= 4 && vocab.exact.has(w) && !EVERYDAY.has(w));
  /**
   * Words the catalogue or the dictionary knows were heard right and stay, except where short real words add up to a
   * name by accident: a brand ("เลย คลาสสิก", "เท่า แก่ น้อย"), or three or more words that are one common catalogue
   * word ("แปลง สี ฟัน" for "แปรงสีฟัน").
   */
  const heardRight = (a: number, b: number, hit: VocabHit): boolean => {
    const dictWords = dictWordsIn(a, b);
    if (hit.brand) return strongWords(a, b) || dictWords === 1;
    if (allWords(a, b)) return true;
    const oneCommonWord = !hit.text.includes(" ") && hit.weight >= MIN_COMMON;
    return dictWords >= 1 && !(dictWords >= 3 && oneCommonWord);
  };

  const snaps: Snap[] = [];
  for (let a = 0; a < n; a++) {
    if (!canStart(a)) continue;
    for (let b = Math.min(n, a + vocab.maxLen + 3); b >= a + 3; b--) {
      if (!canEnd(b)) continue;
      const span = compact.slice(a, b);
      if (isWord(span)) continue;
      const hit = soundKeys(span).map((k) => vocab.byKey.get(k)).find(Boolean);
      if (!hit || hit.compact === span) continue;
      const clashes = rightWords.some(([x, y]) => (x <= a && b <= y) || (x < a && a < y) || (x < b && b < y));
      if (!clashes && !heardRight(a, b, hit)) snaps.push({ a, b, text: hit.text, weight: hit.weight });
    }
  }
  return snaps.length ? applySnaps(compact, snaps, originalIndex, text) : text;
}

// ---------- Stage: the listener answers in English for a brand it knows by its English name ----------
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const [ra, rb] = a.length === b.length ? [a.slice(i + 1), b.slice(i + 1)] : a.length > b.length ? [a.slice(i + 1), b.slice(i)] : [a.slice(i), b.slice(i + 1)];
  return ra === rb;
}

const MIN_NEAR_BRAND = 8; // shorter English words are too close to each other ("roll on" is not "Collon")

function brandForLatin(words: string, vocab: HeardVocab, oneWord: boolean): string | null {
  const k = latinKey(words);
  if (k.length < 3) return null;
  const same = vocab.latin.get(k);
  if (same) return same;
  // One letter off is accepted only for one long word, the way a misheard brand is written ("ROYALCNIN").
  if (!oneWord || k.length < MIN_NEAR_BRAND) return null;
  let found: string | null = null;
  for (const [name, brand] of vocab.latin) {
    if (!withinOneEdit(name, k)) continue;
    if (found && found !== brand) return null; // two brands this close: not sure, leave it as heard
    found = brand;
  }
  return found;
}

function snapLatinBrands(text: string, vocab: HeardVocab): string {
  return text.replace(/[A-Za-z][A-Za-z0-9'&.-]*(?:\s+[A-Za-z][A-Za-z0-9'&.-]*)*/g, (run) => {
    const words = run.split(/\s+/);
    const out: string[] = [];
    for (let i = 0; i < words.length; ) {
      let taken = 0;
      for (let j = words.length; j > i && !taken; j--) {
        const brand = brandForLatin(words.slice(i, j).join(""), vocab, j - i === 1);
        if (!brand) continue;
        out.push(brand);
        taken = j - i;
      }
      if (!taken) out.push(words[i]);
      i += taken || 1;
    }
    return out.join(" ");
  });
}

/**
 * What the listener heard -> what the customer most likely said, in the system's own spelling.
 * A sentence the system already understands is returned as heard.
 */
export function fixHeard(heard: string, vocab?: HeardVocab | null): string {
  let t = collapseRepeat(heard.trim());
  if (!t) return t;
  t = t.replace(UNIT_RE, (_m, num: string, gap: string, unit: string) => num + gap + UNIT_HEARD[unit]);
  if (isDecision(t)) return t;
  const command = fixCommandWords(t);
  if (command) return command;
  return vocab ? snapLatinBrands(snapToCatalog(t, vocab), vocab) : t;
}
