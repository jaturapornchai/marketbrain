/**
 * Text -> what Nong Tee should SAY: Thai & English abbreviations, dimensions, slashes, and reduplication "ๆ"
 * read in full natural Thai ("155 ก." -> "155 กรัม", "40x60 ซม." -> "40 คูณ 60 เซนติเมตร", "ตรงๆ" -> "ตรง ตรง").
 * Display text keeps the short form; only the TTS request goes through this.
 *
 * Units expand only right after a number, so brand names that also end in a dot
 * (อสร., พี.เอฟ.พี, ก.ย. 15, ดอนเมือง กม.26) are left alone.
 */

// Longer forms first so "ก.ก." wins over "ก.", "มล." over "ม.", "ml" over "m"
const UNIT_WORDS: Array<[string, string]> = [
  ["ก.ก.", "กิโลกรัม"],
  ["กก.", "กิโลกรัม"],
  ["กก", "กิโลกรัม"],
  ["มก.", "มิลลิกรัม"],
  ["มก", "มิลลิกรัม"],
  ["มล.", "มิลลิลิตร"],
  ["มล", "มิลลิลิตร"],
  ["ซล.", "เซนติลิตร"],
  ["ซม.", "เซนติเมตร"],
  ["ซม", "เซนติเมตร"],
  ["มม.", "มิลลิเมตร"],
  ["มม", "มิลลิเมตร"],
  ["กม.", "กิโลเมตร"],
  ["กม", "กิโลเมตร"],
  ["ชม.", "ชั่วโมง"],
  ["ล.", "ลิตร"],
  ["ม.", "เมตร"],
  ["ก.", "กรัม"],
];
const UNIT_MAP = new Map(UNIT_WORDS);
const EN_UNIT_MAP: Record<string, string> = {
  kg: "กิโลกรัม",
  kgs: "กิโลกรัม",
  ml: "มิลลิลิตร",
  mg: "มิลลิกรัม",
  cm: "เซนติเมตร",
  mm: "มิลลิเมตร",
  km: "กิโลเมตร",
  g: "กรัม",
  l: "ลิตร",
};

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const UNIT_RE = new RegExp(
  String.raw`(${NUM})\s*(${UNIT_WORDS.map(([k]) => k.replace(/\./g, String.raw`\.`)).join("|")})(?![ก-๙])`,
  "g",
);
const EN_UNIT_RE = new RegExp(String.raw`(${NUM})\s*(kgs?|ml|mg|cm|mm|km|g|l)\.?(?![A-Za-z0-9])`, "gi");
// "กรัม." / "ลิตร." written in full with a stray dot
const FULL_UNIT_DOT_RE = /(\d\s*(?:กรัม|กิโลกรัม|มิลลิลิตร|ลิตร|ชิ้น|ซอง|ขวด|กล่อง))\./g;
// "300 มิลลิลิตร x 24" -> pack of 24; dimensions like "40x60 ซม." -> "40 คูณ 60 เซนติเมตร"
const PACK_RE = new RegExp(
  String.raw`([ก-๙])\s*[xX×]\s*(${NUM})(?![\d,.]|\s*(?:นิ้ว|ซม|เซนติเมตร|มม|มิลลิเมตร|เมตร|cm|mm))`,
  "g",
);
const DIM_X_RE = new RegExp(String.raw`(${NUM})\s*[xX×]\s*(${NUM})`, "g");
// "x 3+1" -> "3 แถม 1"
const FREEBIE_RE = /(\d+)\s*\+\s*(\d+)(?!\s*%)/g;

const THAI_SEG =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("th", { granularity: "word" })
    : null;

/** Expand Thai reduplication mark "ๆ" ("ตรงๆ" -> "ตรง ตรง") so OmniVoice never misreads "ๆ" as "กี่". */
function expandMaiYamok(text: string): string {
  if (!text.includes("ๆ")) return text;
  const parts = THAI_SEG ? Array.from(THAI_SEG.segment(text), (s) => s.segment) : text.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i];
    if (cur === "ๆ" || /^ๆ+$/.test(cur)) {
      let prev = "";
      for (let j = out.length - 1; j >= 0; j--) {
        if (/[ก-๙]/.test(out[j])) {
          prev = out[j].trim();
          break;
        }
      }
      if (prev) out.push(" " + prev + " ");
      continue;
    }
    if (cur.endsWith("ๆ") && cur.length >= 2) {
      const base = cur.slice(0, -1);
      out.push(`${base} ${base}`);
      continue;
    }
    out.push(cur);
  }
  return out.join("");
}

export function toSpokenThai(text: string): string {
  let out = text
    .replace(/ฯลฯ/g, " และอื่น อื่น ")
    .replace(/กรุงเทพฯ/g, "กรุงเทพมหานคร")
    // OmniVoice pronounces standalone "เจอ" as "เจ", and "พบ" is more polite; keep loanwords (เจอรี่, เนเจอรัล, พาสเจอไรซ์, มอยส์เจอไรเซอร์) untouched.
    .replace(/ไม่เจอ(?=[\s,.;!?]|แล้ว|ของ|สินค้า|รายการ|ตรง|ตัว|อัน|ครับ|ค่ะ|คะ|$)/g, "ไม่พบ")
    .replace(/(?<![ก-๙])(?:หา)?เจอ(?=[\s,.;!?]|แล้ว|ของ|สินค้า|รายการ|ตรง|ตัว|อัน|ครับ|ค่ะ|คะ|$)/g, "พบ")
    .replace(/บาท\s*\/\s*([ก-๙]+)/g, "บาทต่อ$1")
    .replace(UNIT_RE, (_, n: string, unit: string) => `${n} ${UNIT_MAP.get(unit)}`)
    .replace(EN_UNIT_RE, (_, n: string, unit: string) => `${n} ${EN_UNIT_MAP[unit.toLowerCase()] ?? unit}`)
    .replace(FULL_UNIT_DOT_RE, "$1")
    .replace(PACK_RE, "$1 แพ็ค $2")
    .replace(DIM_X_RE, "$1 คูณ $2")
    .replace(FREEBIE_RE, "$1 แถม $2");
  // "ขาว/สัก/โอ๊ค" -> "ขาว หรือ สัก หรือ โอ๊ค"
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/([ก-๙]+)\s*\/\s*([ก-๙]+)/g, "$1 หรือ $2");
    if (next === out) break;
    out = next;
  }
  return expandMaiYamok(out)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export type KaraokeWordSpan = {
  w: string;
  start: number;
  end: number;
  isSpace: boolean;
};

const COMBINING_THAI_RE = /[่-๋็์ัิ-ฺู]/g;
const PURE_PUNCT_RE = /^[.,!?;:()\[\]"\u201C\u201D\-–—/]+$/;

/**
 * Estimates relative spoken duration weight for a segmented token so Thai karaoke highlighting
 * paces realistically across digits ("220"), tone marks/vowels, spaces, and punctuation.
 */
function spokenTokenWeight(token: string): number {
  if (!/\S/.test(token)) return 0.25;
  if (PURE_PUNCT_RE.test(token)) return 0.4;
  if (/\d/.test(token)) {
    const digits = (token.match(/\d/g) || []).length;
    const seps = (token.match(/[.,]/g) || []).length;
    const others = token.replace(/[\d.,\s]/g, "").length;
    return Math.max(2.5, digits * 3.2 + seps * 1.5 + others);
  }
  const expanded =
    token.includes("ๆ") || token.includes("/") || token.includes("ฯ") ? toSpokenThai(token) : token;
  const compact = expanded.replace(/\s+/g, "");
  const combiningCount = (compact.match(COMBINING_THAI_RE) || []).length;
  const baseCount = compact.replace(COMBINING_THAI_RE, "").length;
  return Math.max(1.0, baseCount * 1.0 + combiningCount * 0.25);
}

/** Splits Thai/English text into word spans weighted by spoken duration for smooth 0-100% karaoke sync. */
export function segmentKaraokeWords(text: string): KaraokeWordSpan[] {
  if (!text) return [];
  const tokens = THAI_SEG ? Array.from(THAI_SEG.segment(text), (s) => s.segment) : text.split(/(\s+)/);
  if (tokens.length === 0) return [];
  const weights = tokens.map((w) => spokenTokenWeight(w));
  const totalWeight = Math.max(
    1,
    weights.reduce((sum, x) => sum + x, 0),
  );
  let acc = 0;
  return tokens.map((w, idx) => {
    const start = (acc / totalWeight) * 100;
    acc += weights[idx];
    const end = idx === tokens.length - 1 ? 100 : (acc / totalWeight) * 100;
    return {
      w,
      start,
      end,
      isSpace: !/\S/.test(w),
    };
  });
}
