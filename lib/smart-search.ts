export type SearchScope = "all" | "title" | "code" | "ingredients";

export type InferredSort = "price_asc" | "price_desc" | "unit_price_asc" | "pack_desc";

export type ParsedSmartQuery = {
  rawQuery: string;
  cleanQuery: string;
  barcodes: string[];
  fdaNumbers: string[];
  minPrice: string;
  maxPrice: string;
  excludeTerms: string[];
  inferredSort?: InferredSort;
  parsedHints: string[];
};

const FDA_EXACT_RE = /\b\d{2}-\d-(?:\d{5}-\d-\d{4}|\d{10})\b/g;

// Guard negative exclusion phrases so genuine product claims like "ไม่ใส่ผงชูรส" / "ไม่มีน้ำตาล" are untouched.
const EXCLUDE_CLAIM_PREFIX_RE = /^ไม่(?:ใส่|มี|เติม|เจือ)/;

/**
 * Normalize joined metric units (e.g. "500ml" -> "500 มล", "1.5kg" -> "1.5 กก")
 * without touching pipe fractions ("1/2\"", "1-1/2") or model numbers ("M9513B").
 */
export function normalizeSearchMeasurements(s: string): string {
  return s
    .replace(/(\d+(?:\.\d+)?)\s*(?:ม\.ล\.|มล\.?|ml)\b/gi, "$1 มล")
    .replace(/(\d+(?:\.\d+)?)\s*(?:ลิตร|ล\.?|l)(?![a-zก-๙\d])/gi, "$1 ล")
    .replace(/(\d+(?:\.\d+)?)\s*(?:ก\.ก\.|กก\.?|kg)\b/gi, "$1 กก")
    .replace(/(\d+(?:\.\d+)?)\s*(?:กรัม|g)(?![a-zก-๙\d])/gi, "$1 ก")
    .replace(/(\d+(?:\.\d+)?)\s*(?:วัตต์|watts?|w)(?![a-zก-๙\d/])/gi, "$1 วัตต์");
}

/**
 * Parse natural search operators from user query strings cleanly:
 * - Multiple barcodes ("8850006234280, 8851124891003" or "885-0006-234280")
 * - Thai FDA registration numbers ("20-1-6500032418") BEFORE minus/price rules
 * - Decimal price bounds ("ไม่เกิน 40", "งบ 2000", "ราคา 100-500", "ตั้งแต่ 200 บาท")
 * - Negative exclusions ("-ทิพรส", "ไม่เอา ทิพรส") with strict guard against hyphenated SKUs/sizes
 * - Natural sort keywords ("ราคาถูกสุด", "ราคาแพงสุด", "คุ้มสุด", "แพ็คใหญ่สุด")
 */
export function parseSmartSearchQuery(raw: string): ParsedSmartQuery {
  const rawQuery = raw.trim();
  if (!rawQuery) {
    return {
      rawQuery: "",
      cleanQuery: "",
      barcodes: [],
      fdaNumbers: [],
      minPrice: "",
      maxPrice: "",
      excludeTerms: [],
      parsedHints: [],
    };
  }

  let work = ` ${rawQuery} `;
  const fdaSet = new Set<string>();
  const barcodeSet = new Set<string>();
  const excludeSet = new Set<string>();
  const hints: string[] = [];
  let minPrice = "";
  let maxPrice = "";
  let inferredSort: InferredSort | undefined;

  // 1. Thai FDA numbers first so their hyphens are never parsed as negative exclusions or price ranges.
  work = work.replace(FDA_EXACT_RE, (m) => {
    fdaSet.add(m);
    hints.push(`อ.ย. ${m}`);
    return " ";
  });

  // 2. Barcodes (8-14 digits, optionally hyphen-grouped like 885-0006-234280)
  work = work.replace(/(?<![\d.])\d{3,4}(?:[- ]\d{3,5}){1,3}(?![\d.])/g, (m) => {
    const compact = m.replace(/[\s-]+/g, "");
    if (compact.length >= 8 && compact.length <= 14) {
      barcodeSet.add(compact);
      hints.push(`บาร์โค้ด ${compact}`);
      return " ";
    }
    return m;
  });
  work = work.replace(/(?<![\d-])\d{8,14}(?![\d-])/g, (m) => {
    barcodeSet.add(m);
    hints.push(`บาร์โค้ด ${m}`);
    return " ";
  });

  // 3. Explicit negative exclusions: whitespace-preceded -term / -"phrase" or Thai "ไม่เอา / ยกเว้น / ห้ามมี"
  work = work.replace(/(?<=\s)-(?:"([^"]+)"|'([^']+)'|([^\s,;|]+))/g, (m, q1: string, q2: string, w: string) => {
    const val = (q1 || q2 || w || "").trim();
    if (!val || /^\d+(?:[.,/-]\d+)*$/.test(val)) return m;
    excludeSet.add(val);
    hints.push(`ตัดคำ: -${val}`);
    return " ";
  });
  work = work.replace(/(?:ไม่ต้องเอา|ไม่เอา|ยกเว้น|ห้ามมี)\s*([^\s,;|]+)/g, (m, w: string) => {
    const val = w.replace(/^(?:คำว่า|สินค้า|ตรา|ยี่ห้อ)/, "").trim();
    if (!val || EXCLUDE_CLAIM_PREFIX_RE.test(m)) return m;
    excludeSet.add(val);
    hints.push(`ตัดคำ: -${val}`);
    return " ";
  });

  // 4. Natural sort phrases (strip cleanly only when recognized as trailing/standalone sort intent)
  const sortRules: Array<[RegExp, InferredSort, string]> = [
    [/(?:ราคาถูกสุด|ราคาต่ำสุด|ถูกที่สุด|ถูกสุด)(?=\s|$)/g, "price_asc", "เรียง: ราคาต่ำ → สูง"],
    [/(?:ราคาแพงสุด|ราคาสูงสุด|แพงที่สุด|แพงสุด)(?=\s|$)/g, "price_desc", "เรียง: ราคาสูง → ต่ำ"],
    [/(?:เฉลี่ยถูกสุด|คุ้มที่สุด|คุ้มสุด)(?=\s|$)/g, "unit_price_asc", "เรียง: ราคาต่อหน่วยย่อย"],
    [/(?:แพ็คใหญ่สุด|แพ็กใหญ่สุด|บรรจุเยอะสุด|ลังใหญ่สุด)(?=\s|$)/g, "pack_desc", "เรียง: แพ็ค/ลังใหญ่"],
  ];
  for (const [re, sortVal, label] of sortRules) {
    if (re.test(work)) {
      work = work.replace(re, " ");
      if (!inferredSort) {
        inferredSort = sortVal;
        hints.push(label);
      }
    }
  }

  // 5. Price range bounds (kept strictly as normalized decimal strings, never floats)
  const toMoneyParam = (s: string) => s.replace(/,/g, "");
  work = work.replace(
    /(?:(?:ราคา|งบ|ตั้งแต่)\s*)?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:-|ถึง|–|~)\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:บาท|บ\.?)/g,
    (_m, lo: string, hi: string) => {
      minPrice = toMoneyParam(lo);
      maxPrice = toMoneyParam(hi);
      hints.push(`ราคา ฿${minPrice}–฿${maxPrice}`);
      return " ";
    },
  );
  work = work.replace(
    /(?:ราคา|งบ|ตั้งแต่)\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:-|ถึง|–|~)\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)(?=\s|$)/g,
    (_m, lo: string, hi: string) => {
      if (!minPrice && !maxPrice) {
        minPrice = toMoneyParam(lo);
        maxPrice = toMoneyParam(hi);
        hints.push(`ราคา ฿${minPrice}–฿${maxPrice}`);
      }
      return " ";
    },
  );

  // Max price ("ไม่เกิน 40", "งบ 2000", "ต่ำกว่า 100 บาท", "<= 50")
  work = work.replace(
    /(?:(?:ราคา|งบ(?:ประมาณ)?)\s*)?(?:ไม่เกิน|ต่ำกว่า|น้อยกว่า|<=|<)\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:บาท|บ\.?)?/g,
    (_m, hi: string) => {
      maxPrice = toMoneyParam(hi);
      hints.push(`ไม่เกิน ฿${maxPrice}`);
      return " ";
    },
  );
  work = work.replace(/(?:งบ(?:ประมาณ)?)\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:บาท|บ\.?)?/g, (_m, hi: string) => {
    if (!maxPrice) {
      maxPrice = toMoneyParam(hi);
      hints.push(`งบไม่เกิน ฿${maxPrice}`);
    }
    return " ";
  });

  // Min price ("ตั้งแต่ 200", "มากกว่า 100 บาท", ">= 50")
  work = work.replace(
    /(?:ราคา\s*)?(?:ตั้งแต่|เกิน|มากกว่า|อย่างน้อย|>=|>)\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:บาท|บ\.?)?/g,
    (_m, lo: string) => {
      if (!minPrice) {
        minPrice = toMoneyParam(lo);
        hints.push(`ตั้งแต่ ฿${minPrice}`);
      }
      return " ";
    },
  );

  const cleanQuery = normalizeSearchMeasurements(
    work
      .replace(/[,;|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

  return {
    rawQuery,
    cleanQuery,
    barcodes: [...barcodeSet],
    fdaNumbers: [...fdaSet],
    minPrice,
    maxPrice,
    excludeTerms: [...excludeSet],
    inferredSort,
    parsedHints: [...new Set(hints)],
  };
}

// ---------- Standard Thai Kedmanee <-> US QWERTY bidirectional keyboard map ----------
const EN_TO_TH: Record<string, string> = {
  "1": "ๅ",
  "2": "/",
  "3": "-",
  "4": "ภ",
  "5": "ถ",
  "6": "ุ",
  "7": "ึ",
  "8": "ค",
  "9": "ต",
  "0": "จ",
  "-": "ข",
  "=": "ช",
  q: "ๆ",
  w: "ไ",
  e: "ำ",
  r: "พ",
  t: "ะ",
  y: "ั",
  u: "ี",
  i: "ร",
  o: "น",
  p: "ย",
  "[": "บ",
  "]": "ล",
  "\\": "ฃ",
  a: "ฟ",
  s: "ห",
  d: "ก",
  f: "ด",
  g: "เ",
  h: "้",
  j: "่",
  k: "า",
  l: "ส",
  ";": "ว",
  "'": "ง",
  z: "ผ",
  x: "ป",
  c: "แ",
  v: "อ",
  b: "ิ",
  n: "ื",
  m: "ท",
  ",": "ม",
  ".": "ใ",
  "/": "ฝ",
  "!": "+",
  "@": "๑",
  "#": "๒",
  $: "๓",
  "%": "๔",
  "^": "ู",
  "&": "฿",
  "*": "๕",
  "(": "๖",
  ")": "๗",
  _: "๘",
  "+": "๙",
  Q: "๐",
  W: '"',
  E: "ฎ",
  R: "ฑ",
  T: "ธ",
  Y: "ํ",
  U: "๊",
  I: "ณ",
  O: "ฯ",
  P: "ญ",
  "{": "ฐ",
  "}": ",",
  "|": "ฅ",
  A: "ฤ",
  S: "ฆ",
  D: "ฏ",
  F: "โ",
  G: "ฌ",
  H: "็",
  J: "๋",
  K: "ษ",
  L: "ศ",
  ":": "ซ",
  '"': ".",
  Z: "(",
  X: ")",
  C: "ฉ",
  V: "ฮ",
  B: "ฺ",
  N: "์",
  M: "?",
  "<": "ฒ",
  ">": "ฬ",
  "?": "ฦ",
};

const TH_TO_EN: Record<string, string> = {};
for (const [en, th] of Object.entries(EN_TO_TH)) {
  if (!(th in TH_TO_EN)) TH_TO_EN[th] = en;
}

const THAI_TONE_OR_ABOVE_BELOW = /^[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/;

/**
 * Convert mistyped Thai-with-English-keyboard ("oyh,x]k" -> "น้ำปลา")
 * or English-with-Thai-keyboard ("ทฟาระฟ" -> "makita").
 */
export function flipThaiEnKeyboard(raw: string): string | null {
  const s = raw.trim();
  if (s.length < 3 || /^\d+$/.test(s)) return null;

  let asciiCount = 0;
  let thaiCount = 0;
  for (const ch of s) {
    if (ch >= "\u0e00" && ch <= "\u0e7f") thaiCount++;
    else if (ch >= "!" && ch <= "~") asciiCount++;
  }

  if (asciiCount > thaiCount && asciiCount >= 3) {
    let out = "";
    let converted = 0;
    for (const ch of s) {
      if (ch === " ") {
        out += " ";
      } else if (EN_TO_TH[ch]) {
        out += EN_TO_TH[ch];
        converted++;
      } else {
        out += ch;
      }
    }
    if (converted >= 3 && /[ก-ฮ]/.test(out) && !THAI_TONE_OR_ABOVE_BELOW.test(out)) {
      return out.replace(/ำ([่-๋])/g, "$1ำ").trim();
    }
  } else if (thaiCount > asciiCount && thaiCount >= 3) {
    let out = "";
    let converted = 0;
    for (const ch of s) {
      if (ch === " ") {
        out += " ";
      } else if (TH_TO_EN[ch]) {
        out += TH_TO_EN[ch];
        converted++;
      } else {
        out += ch;
      }
    }
    const lower = out.trim().toLowerCase();
    if (converted >= 3 && /^[a-z0-9\s-]{3,}$/.test(lower) && /[a-z]{2,}/.test(lower)) {
      return lower;
    }
  }

  return null;
}

/**
 * Bounded Optimal String Alignment (Damerau-Levenshtein) distance with early exit
 * when distance exceeds `maxDist` so scanning vocabulary stays sub-millisecond.
 */
export function damerauLevenshtein(a: string, b: string, maxDist: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  if (a === b) return 0;

  const dp: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;

  for (let i = 1; i <= la; i++) {
    let rowMin = maxDist + 1;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + 1);
      }
      dp[i][j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
  }

  return dp[la][lb];
}

export type FuzzyVocabEntry = {
  term: string;
  df: number;
  sk: string;
};

/**
 * Find best spelling corrections from catalog vocabulary using both
 * Thai phonetic soundKey matches and bounded Damerau-Levenshtein edit distance.
 */
export function findFuzzyCorrection(
  tokenRaw: string,
  vocab: readonly FuzzyVocabEntry[],
  soundKeyFn: (s: string) => string,
): string[] {
  const token = tokenRaw.toLowerCase().trim();
  if (token.length < 4 || /^\d+$/.test(token)) return [];

  const maxDist = token.length >= 6 ? 2 : 1;
  const tokSk = /[ก-๙]/.test(token) ? soundKeyFn(token) : "";
  const isTokAscii = /^[a-z0-9-]+$/.test(token);
  const scored: Array<{ term: string; dist: number; df: number }> = [];

  for (const v of vocab) {
    if (v.term === token) continue;
    const isVocabAscii = /^[a-z0-9-]+$/.test(v.term);
    if (isTokAscii !== isVocabAscii) continue;

    if (tokSk && v.sk && v.sk === tokSk && Math.abs(v.term.length - token.length) <= 3) {
      scored.push({ term: v.term, dist: 0.5, df: v.df });
      continue;
    }

    const d = damerauLevenshtein(token, v.term, maxDist);
    if (d <= maxDist) {
      scored.push({ term: v.term, dist: d, df: v.df });
    }
  }

  scored.sort((x, y) => x.dist - y.dist || y.df - x.df);
  return [...new Set(scored.slice(0, 6).map((s) => s.term))].slice(0, 4);
}
