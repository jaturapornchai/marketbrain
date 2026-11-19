/**
 * Text -> what Nong Tee should SAY: Thai abbreviations read in full ("155 ก." -> "155 กรัม").
 * Display text keeps the short form; only the TTS request goes through this.
 *
 * Units expand only right after a number, so brand names that also end in a dot
 * (อสร., พี.เอฟ.พี, ก.ย. 15, ดอนเมือง กม.26) are left alone.
 */

// Longer forms first so "ก.ก." wins over "ก.", "มล." over "ม."
const UNIT_WORDS: Array<[string, string]> = [
  ["ก.ก.", "กิโลกรัม"],
  ["กก.", "กิโลกรัม"],
  ["มก.", "มิลลิกรัม"],
  ["มล.", "มิลลิลิตร"],
  ["ซล.", "เซนติลิตร"],
  ["ซม.", "เซนติเมตร"],
  ["มม.", "มิลลิเมตร"],
  ["กม.", "กิโลเมตร"],
  ["ชม.", "ชั่วโมง"],
  ["ล.", "ลิตร"],
  ["ม.", "เมตร"],
  ["ก.", "กรัม"],
];
const UNIT_MAP = new Map(UNIT_WORDS);
const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const UNIT_RE = new RegExp(
  String.raw`(${NUM})\s*(${UNIT_WORDS.map(([k]) => k.replace(/\./g, String.raw`\.`)).join("|")})(?![ก-๙])`,
  "g",
);
// "กรัม." / "ลิตร." written in full with a stray dot
const FULL_UNIT_DOT_RE = /(\d\s*(?:กรัม|กิโลกรัม|มิลลิลิตร|ลิตร|ชิ้น|ซอง|ขวด|กล่อง))\./g;
// "300 มิลลิลิตร x 24" -> pack of 24; sizes like "18x20 นิ้ว" (digit before x) stay as they are
const PACK_RE = new RegExp(
  String.raw`([ก-๙])\s*[xX×]\s*(${NUM})(?![\d,.]|\s*(?:นิ้ว|ซม|เซนติเมตร|มม|มิลลิเมตร|เมตร|cm|mm))`,
  "g",
);
// "x 3+1" -> "3 แถม 1"
const FREEBIE_RE = /(\d+)\s*\+\s*(\d+)(?!\s*%)/g;

export function toSpokenThai(text: string): string {
  return text
    .replace(/ฯลฯ/g, " และอื่นๆ ")
    .replace(/กรุงเทพฯ/g, "กรุงเทพมหานคร")
    .replace(UNIT_RE, (_, n: string, unit: string) => `${n} ${UNIT_MAP.get(unit)}`)
    .replace(FULL_UNIT_DOT_RE, "$1")
    .replace(PACK_RE, "$1 แพ็ค $2")
    .replace(FREEBIE_RE, "$1 แถม $2")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
