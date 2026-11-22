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
    .replace(/(?:[ทตดสศ]ร์|ษณ์|นทร์)/g, "")
    .replace(/[ก-ฮ][ิุ]?์/g, "")
    .replace(/[็-๎ๆฯฺ]/g, "")
    .replace(/([ัิีุู])ตร(?![ะ-ฺอวย])/g, "$1ต")
    .replace(/เ([ก-ฮ])ชร(?![ะ-ฺอวย])/g, "เ$1ช")
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
    // Bare consonant + final ร carries an unwritten "ออ" vowel ("จร" = "จอน", "พร" = "พอน").
    key += !hasVowel && c === "ร" ? "ON" : (FINAL[c] ?? c);
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
  [/หอย(กลับ|หลัง)/g, "ถอย$1"],
  [/บิว/g, "บิล"],
  [/เช็[คก]ดิว/g, "เช็คบิล"],
  [/checkbuild/gi, "เช็คบิล"],
  [/ดูด(ตร?ะกร้า)/g, "ดู$1"],
  [/นะละหลัก/g, "หน้าหลัก"],
  // Whisper occasionally mishears "เบอร์" before a number as "เวิร์ส/เวอร์/เบิร์ด/เบิ้ล/เบอ/เปอ/เพอร์" ("เอาเวิร์สสี่สามชิ้น").
  [
    /(^|เอา|ขอ|รับ|สั่ง|ใส่|หยิบ|จัด|เลือก|ดู|เปิด|ขยาย|กด|ลบ|เทียบ|ดวล|เปลี่ยน|แก้|ปรับ|กับ|และ)(?:เวิร์ส|เวิร์ด|เวอร์|เบิร์ด|เบิร์ก|เบิ้ล|เบอ|เปอ|เพอร์)(?=(?:\d|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ))/g,
    "$1เบอร์",
  ],
];

function fixCommandWords(text: string): string | null {
  const squashed = text.replace(/[\s.,!?"'“”]+/g, "");
  if (squashed.length > 60) return null;
  let t = squashed;
  for (const [heard, meant] of COMMAND_HEARD) t = t.replace(heard, meant);
  if (t !== squashed && isDecision(t)) return t;
  const snaps: Snap[] = [];
  for (let a = 0; a < t.length; a++) {
    if (!canCutAt(t, a)) continue;
    for (let b = Math.min(t.length, a + MAX_COMMAND_WORD); b >= a + 2; b--) {
      if (!canCutAt(t, b)) continue;
      const span = t.slice(a, b);
      const word = soundKeys(span).map((k) => COMMAND_BY_KEY.get(k)).find(Boolean);
      // Keep already-right command words as anchors so a shorter sub-span (e.g. "น้าหลัก" inside "หน้าหลัก") cannot duplicate "ห".
      if (word) snaps.push({ a, b, text: word, weight: word === span ? 1 : 0 });
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
  /** Compact Thai brand spellings from the catalogue (used to tell a real brand from a minor spelling variant). */
  brands: Set<string>;
  /** English brand name (letters only, lower case) -> brand name as the catalogue writes it. */
  latin: Map<string, string>;
  /** Unique phonetic-loose English brand key (>=6 letters) -> Thai brand name ("formos" -> "โฟร์โมสต์"). */
  latinLoose: Map<string, string>;
  /** "brandTh|enLineKey" -> Thai product-line word from real products ("ไฮยีน|expertwash" -> "เอ็กซ์เพิร์ทวอช"). */
  latinByBrand: Map<string, string>;
  /** English product-line key owned by a single Thai brand -> full "brandTh subTh" + its English brand key. */
  latinUniqueLine: Map<string, { full: string; brandEn: string; words: number }>;
  maxLen: number;
};

type VocabProduct = { nameTh?: string | null; nameEn?: string | null; brandTh?: string | null; brandEn?: string | null };

const THAI_WORD_RE = /^[ก-๙]{2,}(?:-[ก-๙]+)*$/; // "แอล-คาร์นิทีน" is one word
const MIN_KEY = 4; // shorter keys are everyday one-syllable words ("ขาย" = "ไข่")
const BRAND_WEIGHT = 5;
const latinKey = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
// Drops silent mid-word 'e', double letters, and Thai-dropped final -t/-d after s/n/l/r ("foremost" -> "formos").
const looseLatin = (k: string) =>
  k
    .replace(/([a-z])\1+/g, "$1")
    .replace(/([a-z])e(?=[a-z])/g, "$1")
    .replace(/([snlr])[td]$/g, "$1");

/** Builds the listener's vocabulary from the products in the brain (call once per brain load). */
export function buildHeardVocab(products: ReadonlyArray<VocabProduct>): HeardVocab {
  const weightOf = new Map<string, number>();
  const brandLed = new Set<string>(); // a brand name, or a phrase that begins with one
  const add = (text: string, weight: number, brand = false) => {
    weightOf.set(text, (weightOf.get(text) ?? 0) + weight);
    if (brand) brandLed.add(text);
  };
  const enVotes = new Map<string, Map<string, number>>();
  const brandLineVotes = new Map<string, Map<string, number>>();
  const lineOwners = new Map<string, Map<string, { subTh: string; count: number; brandEn: string; words: number }>>();
  for (const p of products) {
    const brand = (p.brandTh ?? "").trim();
    const brandEn = (p.brandEn ?? "").trim();
    if (brand) add(brand, BRAND_WEIGHT, true);
    const bKey = brandEn ? latinKey(brandEn) : "";
    if (brand && bKey.length >= 3) {
      let votes = enVotes.get(bKey);
      if (!votes) {
        votes = new Map();
        enVotes.set(bKey, votes);
      }
      votes.set(brand, (votes.get(brand) ?? 0) + 1);
    }
    const words = (p.nameTh ?? "").split(/[\s,()/+*]+/).filter((w) => THAI_WORD_RE.test(w));
    for (const w of new Set(words)) add(w, 1);
    // "brand + first word" is how a product is asked for out loud ("เลย์ คลาสสิค").
    if (words.length >= 2) add(`${words[0]} ${words[1]}`, 1, words[0] === brand);

    // Pair English product-line words right after brandEn in nameEn with the Thai word right after brandTh in nameTh.
    const nameTh = (p.nameTh ?? "").trim();
    const nameEn = (p.nameEn ?? "").trim();
    if (brand && brandEn && /[ก-๙]/.test(brand) && nameTh.startsWith(brand) && nameEn) {
      const subTh = nameTh.slice(brand.length).trim().split(/[\s,()/+*]+/)[0] ?? "";
      if (THAI_WORD_RE.test(subTh) && subTh.length >= 4) {
        const esc = brandEn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m = nameEn.match(new RegExp(`^${esc}\\s+(.+)`, "i"));
        const enWords = m ? m[1].replace(/&/g, " and ").split(/[^A-Za-z]+/).filter((w) => w.length >= 2) : [];
        for (let len = 1; len <= Math.min(3, enWords.length); len++) {
          const ek = latinKey(enWords.slice(0, len).join(""));
          if (ek.length < 5) continue;
          const bk = `${brand}|${ek}`;
          let bv = brandLineVotes.get(bk);
          if (!bv) {
            bv = new Map();
            brandLineVotes.set(bk, bv);
          }
          bv.set(subTh, (bv.get(subTh) ?? 0) + 1);

          let owners = lineOwners.get(ek);
          if (!owners) {
            owners = new Map();
            lineOwners.set(ek, owners);
          }
          const ok = `${brand}|${subTh}`;
          const prev = owners.get(ok);
          owners.set(ok, { subTh, count: (prev?.count ?? 0) + 1, brandEn: bKey, words: len });
        }
      }
    }
  }
  add("น้องตี๋", 1000);
  // Pick the most frequent Thai spelling for each English brand name (never let a 1-off English spelling overwrite it).
  const latin = new Map<string, string>();
  for (const [k, votes] of enVotes) {
    const best = [...votes.entries()].sort((a, b) => Number(/[ก-๙]/.test(b[0])) - Number(/[ก-๙]/.test(a[0])) || b[1] - a[1])[0];
    if (best) latin.set(k, best[0]);
  }
  const latinLoose = new Map<string, string>();
  const looseClash = new Set<string>();
  for (const [k, brand] of latin) {
    if (k.length < 6 || !/[ก-๙]/.test(brand)) continue;
    const lk = looseLatin(k);
    if (lk.length < 5 || looseClash.has(lk)) continue;
    const prev = latinLoose.get(lk);
    if (!prev) latinLoose.set(lk, brand);
    else if (prev !== brand) {
      latinLoose.delete(lk);
      looseClash.add(lk);
    }
  }
  const MIN_LINE_PRODUCTS = 3;
  const latinByBrand = new Map<string, string>();
  for (const [bk, votes] of brandLineVotes) {
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= MIN_LINE_PRODUCTS) latinByBrand.set(bk, best[0]);
  }
  const latinUniqueLine = new Map<string, { full: string; brandEn: string; words: number }>();
  for (const [ek, owners] of lineOwners) {
    const brands = new Set([...owners.keys()].map((k) => k.split("|")[0]));
    if (brands.size !== 1) continue;
    const [onlyBrand] = brands;
    const best = [...owners.values()].sort((a, b) => b.count - a.count)[0];
    if (best && best.count >= MIN_LINE_PRODUCTS) {
      latinUniqueLine.set(ek, { full: `${onlyBrand} ${best.subTh}`, brandEn: best.brandEn, words: best.words });
    }
  }
  const vocab: HeardVocab = { byKey: new Map(), exact: new Set(), brands: new Set(), latin, latinLoose, latinByBrand, latinUniqueLine, maxLen: 0 };
  const addKey = (key: string, hit: VocabHit, overwriteHigher: boolean) => {
    if (key.length < MIN_KEY) return;
    const best = vocab.byKey.get(key);
    if (!best || (overwriteHigher && hit.weight > best.weight)) vocab.byKey.set(key, hit);
  };
  for (const [text, weight] of weightOf) {
    const compact = text.replace(/[\s-]+/g, "");
    if (!/^[ก-๙0-9]+$/.test(compact)) continue; // Latin names go through `latin`
    vocab.exact.add(compact);
    const isBrand = brandLed.has(text);
    if (isBrand && !text.includes(" ")) vocab.brands.add(compact);
    const hit: VocabHit = { text, compact, weight, brand: isBrand };
    for (const key of soundKeys(compact)) {
      if (key.length < MIN_KEY) continue;
      vocab.maxLen = Math.max(vocab.maxLen, compact.length);
      addKey(key, hit, true);
    }
  }
  // Secondary keys for long multi-syllable brands (never overwrite a primary key):
  // 1) geminate N before ล/น ("คอลเล็คชัน" ~ "คอเล็กชัน"), 2) dropped silent mark at end ("บุฟเฟต์" ~ "บุฟเฟต").
  for (const [text, weight] of weightOf) {
    if (!brandLed.has(text)) continue;
    const compact = text.replace(/[\s-]+/g, "");
    if (compact.length < 10 || !/^[ก-๙0-9]+$/.test(compact)) continue;
    const hit: VocabHit = { text, compact, weight, brand: true };
    for (const key of soundKeys(compact)) {
      const degem = key.replace(/N(?=[เแโ]?[ลน])/g, "");
      if (degem !== key) addKey(degem, hit, false);
    }
    if (/[ตทด]์$/.test(compact)) {
      for (const key of soundKeys(compact.replace(/์$/g, ""))) addKey(key, hit, false);
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
    "คล้าย หลาย อ๋อ ถ้า เหลือ ไหว จริง น่า ถูกต้อง กรุณา รบกวน " +
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
    // Retry with a neutral frame only when `w` fused into a compound with "ดี" (e.g. ผู้ดี, ใจดี, พอดี, น้ำดี).
    if (!ok && parts.length === 2 && (parts[0] === `ดี${w}` || parts[1] === `${w}ดี`)) {
      const alt = Array.from(thaiWords.segment(`และ${w}และ`), (x) => x.segment);
      ok = alt.length === 3 && alt[1] === w;
    }
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

// Brands and product phrases heard far enough from Thai sound rules that soundKey cannot bridge them (measured on real audio).
// Every rule checks that the target actually exists in `vocab` (built from the real brain), so nothing is guessed.
const CATALOG_HEARD: Array<[RegExp, string, string]> = [
  [/คนนอ/g, "คนอร์", "คนอร์"],
  [/กันนิเย/g, "การ์นิเย่", "การ์นิเย่"],
  [/ทองกระเด้น/g, "ทองการ์เด้น", "ทองการ์เด้น"],
  [/ครูมะ/g, "คุมะ", "คุมะ"],
  [/อาเลารี่/g, "อลาวรี่", "อลาวรี่"],
  [/อาเจ็ด/g, "อาท เจ็ท", "อาทเจ็ท"],
  [/เอโร่?โก(?!ลด์)/g, "เอโร่ โกลด์", "เอโร่โกลด์"],
  [/สไลด์(\s*น้ำยาล้างจาน)/g, "ซันไลต์$1", "ซันไลต์"],
  [/เพศสัตว์/g, "เภสัช", "เภสัช"],
  [/ปลาชูหน้า/g, "ปลาทูน่า", "ปลาทูน่า"],
  [/เดมิเกลส์/g, "เดมิเกลซ", "ผงปรุงเดมิเกลซ"],
  [/ถั่วลิสงบเกลือ/g, "ถั่วลิสงอบเกลือ", "ถั่วลิสงอบเกลือ"],
  [/แซนวิชโฮวีด/g, "แซนด์วิชโฮลวีท", "ขนมปังแซนด์วิชโฮลวีทเนื้อละเอียด"],
  [/สเปรย์(\s*สตรอเบอ)/g, "สเปรด$1", "สเปรดสตรอเบอร์รี่"],
  [/พาสเตอร์ไรส์/g, "พาสเจอร์ไรซ์", "นมพาสเจอร์ไรซ์"],
  [/ไบคอน/g, "เบคอน", "เบคอน"],
  [/สว่าง(\s*(?:ไฟฟ้า|ไร้สาย|กระแทก|โรตารี่|มือ|เจาะ))/g, "สว่าน$1", "สว่านไฟฟ้า"],
  [/ก็ได้อาจชำระ/g, "กระดาษชำระ", "กระดาษชำระ"],
];

function applyCatalogHeard(text: string, vocab: HeardVocab): string {
  let out = text;
  for (const [heard, meant, requiredCompact] of CATALOG_HEARD) {
    if (vocab.exact.has(requiredCompact)) out = out.replace(heard, meant);
  }
  return out;
}

/** Punctuation, "ๆ" and "฿" are hard stops: a correction never reaches across one or removes it ("แปรงสีฟัน+ยาสีฟัน", "อสร."). */
const snapToCatalog = (text: string, vocab: HeardVocab): string =>
  applyCatalogHeard(text, vocab).replace(/[ก-ฺเ-ๅ็-๙0-9][ก-ฺเ-ๅ็-๙0-9\s-]*/g, (run) => snapRun(run, vocab));

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
  // ICU sometimes glues a stray trailing consonant from a misheard word onto the next known word ("บุฟเฟต|กาแฟ" -> "ตกาแฟ", "พรส|บีบี" -> "สบีบี").
  // Requires p >= 2 so there is actually a preceding word to leak a consonant from (never chop the first letter of a real word like "ก|รุณา").
  const isGluedPrefixCut = (p: number) =>
    p >= 2 &&
    isSyllableBreak(p) &&
    wordStartsAt.has(p) &&
    dictSegs.some(([x, y]) => x === p - 1 && p < y && !vocab.exact.has(compact.slice(x, y)) && !EVERYDAY.has(compact.slice(x, y)));
  // Or fuses a short everyday prefix with the start of a brand ("ดูดิ|โด" for "ดู ดีโด้").
  const isEverydayPrefixCut = (p: number) =>
    isSyllableBreak(p) &&
    dictSegs.some(([x, y]) => x < p && p < y && EVERYDAY.has(compact.slice(x, p)) && !vocab.exact.has(compact.slice(x, y)) && !EVERYDAY.has(compact.slice(x, y)));
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
  const canStart = (a: number) =>
    canCutAt(compact, a) &&
    (!cutsDictWord(a) || isGluedPrefixCut(a) || isEverydayPrefixCut(a)) &&
    (a === 0 || wordEndsAt.has(a) || isSyllableBreak(a));
  // The question/polite ending of a sentence is never part of a product name ("…เบบี้ไหมครับ" is not "เบบี้ มายด์").
  const tailStart = n - (TAIL_RE.exec(compact)?.[0].length ?? 0);
  const canEnd = (b: number) =>
    b <= tailStart &&
    canCutAt(compact, b) &&
    (!cutsDictWord(b) || isGluedPrefixCut(b)) &&
    (b === tailStart || wordStartsAt.has(b) || isSyllableBreak(b));

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
  /** True when `a..b` starts with a non-brand spelling variant of `hit`'s own brand (e.g. "โพรเทคสบู่ก้อน" -> "โพรเทคส์ สบู่ก้อน"). */
  const misheardLeadingBrand = (a: number, b: number, hit: VocabHit): boolean => {
    const sp = hit.text.indexOf(" ");
    if (sp < 0) return false;
    const brandPart = hit.text.slice(0, sp);
    if (!vocab.brands.has(brandPart)) return false;
    const tailPart = hit.text.slice(sp + 1).replace(/[\s-]+/g, "");
    if (!tailPart || b - a <= tailPart.length + 1) return false;
    const tailSpan = compact.slice(b - tailPart.length, b);
    if (tailSpan !== tailPart) return false;
    const headSpan = compact.slice(a, b - tailPart.length);
    return !vocab.brands.has(headSpan) && soundKeys(headSpan).some((k) => soundKeys(brandPart).includes(k));
  };
  /**
   * Words the catalogue or the dictionary knows were heard right and stay, except where short real words add up to a
   * name by accident: a brand ("เลย คลาสสิก", "เท่า แก่ น้อย"), or three or more words that are one common catalogue
   * word ("แปลง สี ฟัน" for "แปรงสีฟัน").
   */
  const heardRight = (a: number, b: number, hit: VocabHit): boolean => {
    const dictWords = dictWordsIn(a, b);
    if (hit.brand) {
      if (misheardLeadingBrand(a, b, hit)) return false;
      // Never rewrite 2 real Thai dictionary words into a single-word brand (e.g. "มาหลาย" -> "มาลัย", "อ๋อคิด" -> "ออร์คิด", "ใหม่ดี" -> "ไมล์ดี้").
      // Multi-word brands ("เลย์ คลาสสิค") and 3-word compounds ("เท่า แก่ น้อย" -> "เถ้าแก่น้อย") still snap normally.
      if (dictWords === 2 && !hit.text.includes(" ")) return true;
      return strongWords(a, b) || dictWords === 1;
    }
    if (allWords(a, b)) return true;
    const oneCommonWord = !hit.text.includes(" ") && hit.weight >= MIN_COMMON;
    return dictWords >= 1 && !(dictWords >= 3 && oneCommonWord);
  };

  const snaps: Snap[] = [];
  for (let a = 0; a < n; a++) {
    if (!canStart(a)) continue;
    const everydayCut = cutsDictWord(a) && !isGluedPrefixCut(a);
    for (let b = Math.min(n, a + vocab.maxLen + 3); b >= a + 3; b--) {
      if (!canEnd(b)) continue;
      const span = compact.slice(a, b);
      if (isWord(span)) continue;
      const hit = soundKeys(span).map((k) => vocab.byKey.get(k)).find(Boolean);
      if (!hit || hit.compact === span) continue;
      if (everydayCut && !hit.brand) continue;
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
  // Plural -s spoken on an English brand ("PS Foods" -> "PS FOOD" -> "พีเอสฟู้ดส์").
  if (k.endsWith("s") && k.length >= 6) {
    const singular = vocab.latin.get(k.slice(0, -1));
    if (singular) return singular;
  }
  if (!oneWord) return null;
  // One letter off is accepted only for one long word, the way a misheard brand is written ("ROYALCNIN").
  if (k.length >= MIN_NEAR_BRAND) {
    let found: string | null = null;
    for (const [name, brand] of vocab.latin) {
      if (!withinOneEdit(name, k)) continue;
      if (found && found !== brand) return null; // two brands this close: not sure, leave it as heard
      found = brand;
    }
    if (found) return found;
  }
  // Unique phonetic-loose brand key ("Formos" -> "foremost" -> "โฟร์โมสต์").
  return k.length >= 6 ? (vocab.latinLoose.get(looseLatin(k)) ?? null) : null;
}

/** True when a misheard English word sounds plausibly like the brandEn that owns a unique product line ("brief" ~ "breeze", "area" ~ "laurier"). */
function looksLikeBrandEn(word: string, brandEn: string, multiWordLine: boolean): boolean {
  const w = latinKey(word);
  if (w.length < 3 || !brandEn) return false;
  if (w.slice(0, 2) === brandEn.slice(0, 2)) return true;
  if (!multiWordLine) return false;
  // For a multi-word unique line ("soft and safe"), allow a clipped/dropped-initial brand word whose letters mostly appear in brandEn.
  let shared = 0;
  for (const ch of new Set(w)) if (brandEn.includes(ch)) shared++;
  return shared / new Set(w).size >= 0.75;
}

function snapLatinBrands(text: string, vocab: HeardVocab): string {
  return text.replace(/[A-Za-z][A-Za-z0-9'&.-]*(?:\s+[A-Za-z][A-Za-z0-9'&.-]*)*/g, (run, offset: number) => {
    const before = text.slice(0, offset).trimEnd();
    const prevThai = before.match(/[ก-๙]+$/)?.[0] ?? "";
    let leadingBrand: string | null = null;
    if (prevThai) {
      // Match the longest catalogue brand at the end of `prevThai` ("ขอดูไฮยีน" -> "ไฮยีน").
      for (let i = 0; i <= prevThai.length - 2; i++) {
        const tail = prevThai.slice(i);
        if (vocab.brands.has(tail)) {
          leadingBrand = tail;
          break;
        }
      }
    }
    const words = run.split(/\s+/);
    const out: string[] = [];
    for (let i = 0; i < words.length; ) {
      let taken = 0;
      // 1. After a known Thai brand, snap its English product-line phrase ("ไฮยีน expert wash" -> "ไฮยีน เอ็กซ์เพิร์ทวอช").
      if (i === 0 && leadingBrand) {
        for (let j = Math.min(words.length, 3); j >= 1 && !taken; j--) {
          const sub = vocab.latinByBrand.get(`${leadingBrand}|${latinKey(words.slice(0, j).join(" "))}`);
          if (!sub) continue;
          out.push(sub);
          taken = j;
        }
      }
      // 2. Known English brand name (exact, plural -s, 1-edit, or phonetic-loose).
      for (let j = words.length; j > i && !taken; j--) {
        const brand = brandForLatin(words.slice(i, j).join(""), vocab, j - i === 1);
        if (!brand) continue;
        out.push(brand);
        taken = j - i;
      }
      // 3. Misheard English brand word followed by a unique product-line phrase of that brand ("brief Excel" -> "บรีส เอกเซล", "area soft and safe" -> "ลอรีเอะ ซอฟท์แอนด์เซฟ").
      if (!taken && i + 1 < words.length) {
        for (let j = Math.min(words.length, i + 4); j > i + 1 && !taken; j--) {
          const line = vocab.latinUniqueLine.get(latinKey(words.slice(i + 1, j).join(" ")));
          if (!line) continue;
          if (!looksLikeBrandEn(words[i], line.brandEn, line.words >= 2)) continue;
          out.push(line.full);
          taken = j - i;
        }
      }
      if (!taken) out.push(words[i]);
      i += taken || 1;
    }
    return out.join(" ");
  });
}

const THAI_HUN_DIGIT: Record<string, string> = {
  หนึ่ง: "1",
  สอง: "2",
  สาม: "3",
  สี่: "4",
  ห้า: "5",
  หก: "6",
  เจ็ด: "7",
  แปด: "8",
};

/** Normalize spoken Thai hardware sizes misheard by STT ("ข้องอสี่หุ่น" -> "ข้องอ 4 หุน", "เก้าสิบองศา" -> "90 องศา"). */
function normalizeHardwareSpeech(text: string): string {
  return text
    .replace(
      /(?<![0-9.])(?<!สิบ|ยี่)([1-8]|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด)\s*หุ่?น(?=(?:$|[^ก-๙]|หน่อย|ให้หน่อย|ที|ด้วย|ครับ|ค่ะ|คะ|คับ|นะ|จ้า|จ๊ะ|มั้ย|ไหม|หรือ|รึ|บาง|หนา|เกลียว|ตรง|งอ|ลด|ต่อ|ฟ้า|ขาว|ดำ|เทา|เหล็ก|ทองเหลือง|เก้าสิบ|สี่สิบ))/g,
      (_m, d: string) => ` ${THAI_HUN_DIGIT[d] ?? d} หุน `,
    )
    .replace(/เก้าสิบ\s*องศา/g, " 90 องศา ")
    .replace(/สี่สิบห้า\s*องศา/g, " 45 องศา ")
    .replace(/หนึ่งนิ้วครึ่ง/g, " 1-1/2 นิ้ว ")
    .replace(/สองนิ้วครึ่ง/g, " 2-1/2 นิ้ว ")
    .replace(/(?<![ก-๙0-9])นิ้วครึ่ง/g, " 1-1/2 นิ้ว ")
    .replace(/ครึ่งนิ้ว/g, " 1/2 นิ้ว ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Normalize common Thai ASR phonetic slips (zero false positives on real words). */
function normalizeThaiSttSlips(text: string): string {
  return text
    .replace(/ผงชูโรส/g, "ผงชูรส")
    .replace(/ศรีษะ/g, "ศีรษะ")
    .replace(/รังแคร์/g, "รังแค")
    .replace(/ข้องออ(?=\s|$|\d|[ก-๙])/g, "ข้องอ")
    .replace(/คล่องอ(?=\s*(?:\d|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|หุ|นิ้ว|องศา|PVC|พีวีซี))/gi, "ข้องอ");
}

/**
 * What the listener heard -> what the customer most likely said, in the system's own spelling.
 * A sentence the system already understands is returned as heard.
 */
export function fixHeard(heard: string, vocab?: HeardVocab | null): string {
  let t = collapseRepeat(normalizeThaiSttSlips(heard.trim().normalize("NFC")));
  if (!t) return t;
  t = normalizeHardwareSpeech(t);
  t = t.replace(UNIT_RE, (_m, num: string, gap: string, unit: string) => num + gap + UNIT_HEARD[unit]);
  if (isDecision(t)) return t;
  const command = fixCommandWords(t);
  if (command) return command;
  return vocab ? snapLatinBrands(snapToCatalog(t, vocab), vocab) : t;
}

export function isProtectedCommandSpeech(text: string): boolean {
  const clean = text.trim();
  return Boolean(clean && (isDecision(clean) || fixCommandWords(clean)));
}

export type EarId = "ear1" | "ear2" | "ear3";
export type DualEarScore = { strong: boolean; total: number };
export type DualEarScoreFn = (q: string) => DualEarScore;
export type DualEarChoice = {
  text: string;
  altText: string;
  picked: EarId;
};

const SPOKEN_MULTI_DIGIT_RE = /(?:หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า){2,}/;
const TRAILING_DUP_POLITE_RE = /(ครับ|ค่ะ|คะ|นะครับ|นะคะ)\s*\1+$/i;

function maxCatalogBrandLen(text: string, vocab: HeardVocab): number {
  const compact = text.replace(/\s+/g, "");
  let best = 0;
  for (let i = 0; i < compact.length; i++) {
    for (let j = Math.min(compact.length, i + 20); j >= i + 4; j--) {
      if (j - i <= best) break;
      if (vocab.brands.has(compact.slice(i, j))) {
        best = j - i;
        break;
      }
    }
  }
  return best;
}

function buildAltHeardText(chosenText: string, ...others: string[]): string {
  const chosenCompact = chosenText.replace(/\s+/g, "");
  const out: string[] = [];
  for (const o of others) {
    if (!o) continue;
    const oCompact = o.replace(/\s+/g, "");
    if (oCompact === chosenCompact) continue;
    if (out.some((prev) => prev.replace(/\s+/g, "") === oCompact)) continue;
    out.push(o);
  }
  return out.join(" / ");
}

/**
 * Triple-Ear Smart Arbiter: fix GPU Typhoon-Whisper (Ear 1), CPU OpenThai th-TH (Ear 2),
 * and CPU OpenThai th-mix (Ear 3); guard against fused spoken digits on OpenThai ears;
 * and pick the strongest catalog/brand/model match cleanly.
 */
export function chooseBestHeard(
  ear1Raw: string,
  ear2Raw: string,
  vocab?: HeardVocab | null,
  scoreFn?: DualEarScoreFn,
  ear3Raw = "",
): DualEarChoice {
  const cleanDup = (s: string) => s.replace(TRAILING_DUP_POLITE_RE, "$1").trim();
  const f1 = ear1Raw.trim() ? cleanDup(fixHeard(ear1Raw, vocab)) : "";
  const f2Raw = ear2Raw.trim() ? cleanDup(fixHeard(ear2Raw, vocab)) : "";
  const f3Raw = ear3Raw.trim() ? cleanDup(fixHeard(ear3Raw, vocab)) : "";

  const isFusedDigits = (cand: string) =>
    Boolean(cand) && /\d{2,}/.test(cand) && !/\d{2,}/.test(f1) && SPOKEN_MULTI_DIGIT_RE.test(f1);
  const f2 = isFusedDigits(f2Raw) ? "" : f2Raw;
  const f3 = isFusedDigits(f3Raw) ? "" : f3Raw;

  if (!f1 && !f2 && !f3) return { text: "", altText: "", picked: "ear1" };

  // Keep explicit screen/cart decision commands on Ear 1 unless Ear 1 is empty.
  if (f1 && (isDecision(f1) || fixCommandWords(f1))) {
    return { text: f1, altText: "", picked: "ear1" };
  }

  const hasAlt = Boolean((f2 && f2 !== f1) || (f3 && f3 !== f1));
  if (scoreFn && (hasAlt || !f1)) {
    const scoreCache = new Map<string, DualEarScore>();
    const evalScore = (t: string): DualEarScore => {
      if (!t) return { strong: false, total: 0 };
      let hit = scoreCache.get(t);
      if (!hit) {
        hit = scoreFn(t);
        scoreCache.set(t, hit);
      }
      return hit;
    };

    const s1 = evalScore(f1);
    const b1 = f1 && vocab ? maxCatalogBrandLen(f1, vocab) : 0;

    type CandEval = {
      id: EarId;
      text: string;
      sc: DualEarScore;
      brandLen: number;
      hasLatin: boolean;
    };
    const winners: CandEval[] = [];
    for (const [id, text] of [
      ["ear2", f2],
      ["ear3", f3],
    ] as const) {
      if (!text) continue;
      const sc = evalScore(text);
      const brandLen = vocab ? maxCatalogBrandLen(text, vocab) : 0;
      const hasLatin = /[a-z]{3,}/i.test(text) || /(?:[a-z]\d|\d[a-z])/i.test(text);
      const beatsEar1 =
        !f1 ||
        (sc.strong && !s1.strong) ||
        (sc.strong && vocab && brandLen >= 4 && brandLen > b1 && sc.total <= s1.total) ||
        (id === "ear3" && sc.strong && hasLatin && s1.strong && sc.total > 0 && sc.total < s1.total);
      if (beatsEar1) {
        winners.push({ id, text, sc, brandLen, hasLatin });
      }
    }

    if (winners.length > 0) {
      winners.sort((a, b) => {
        if (a.sc.strong !== b.sc.strong) return a.sc.strong ? -1 : 1;
        if (a.brandLen !== b.brandLen) return b.brandLen - a.brandLen;
        if (a.sc.strong && a.sc.total !== b.sc.total) {
          return (a.sc.total || 1e9) - (b.sc.total || 1e9);
        }
        if (a.hasLatin !== b.hasLatin) return a.hasLatin ? -1 : 1;
        return a.id === "ear3" && b.id === "ear2" ? -1 : 0;
      });
      const best = winners[0];
      return {
        text: best.text,
        altText: buildAltHeardText(best.text, f1, f2, f3),
        picked: best.id,
      };
    }
  }

  if (!f1) {
    const primary = f2 || f3;
    const picked: EarId = f2 ? "ear2" : "ear3";
    return { text: primary, altText: buildAltHeardText(primary, f2, f3), picked };
  }

  return { text: f1, altText: buildAltHeardText(f1, f2, f3), picked: "ear1" };
}
