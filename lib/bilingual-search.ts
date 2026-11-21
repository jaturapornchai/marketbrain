import type { BrainProductItem } from "./product-source";

/**
 * Curated bidirectional Thai <-> English equivalence groups covering top tools/hardware,
 * electronics, FMCG/grocery, personal care, pet care, medicine, and common product nouns.
 * Every term within a group maps to all other terms in that group.
 */
export const BILINGUAL_EQUIV_GROUPS: readonly (readonly string[])[] = [
  // Tools, Hardware & Electrical Brands
  ["มากิต้า", "มากีต้า", "มาคิต้า", "makita"],
  ["บ๊อช", "บอช", "bosch"],
  ["ดีวอลท์", "เดวอลท์", "ดิวอลท์", "dewalt"],
  ["สแตนเลย์", "สแตนลีย์", "stanley"],
  ["พัมคิน", "ปั๊มกิ้น", "พัมกิ้น", "pumpkin"],
  ["เฮเฟเล่", "ฮาเฟเล่", "hafele"],
  ["ฮัมเมอร์", "hummer"],
  ["เอสซีจี", "scg"],
  ["คอตโต้", "cotto"],
  ["โตโต้", "toto"],
  ["ทีโอเอ", "toa"],
  ["เบเยอร์", "beger"],
  ["โจตัน", "jotun"],
  ["นิปปอน", "nippon"],
  ["ฮาโก้", "haco"],
  ["เยล", "yale"],
  ["ดอนมาร์ค", "donmark"],
  ["ยูโรเอ็กซ์", "eurox"],
  ["เรียวบิ", "ryobi"],
  ["คาร์เชอร์", "karcher"],
  ["มิตซูบิชิ", "mitsubishi"],
  ["ฮิตาชิ", "hitachi"],
  ["ฮุนได", "hyundai"],
  ["ฮอนด้า", "honda"],
  ["สตีเบล", "stiebel"],
  ["3เอ็ม", "สามเอ็ม", "3m"],
  ["สก๊อตช์", "สกอตช์", "scotch"],
  ["ฟิลิปส์", "philips"],
  ["แลมป์ตัน", "lamptan"],
  ["เรเซอร์", "racer"],
  ["ออสแรม", "osram"],
  ["พานาโซนิค", "panasonic"],
  ["โตชิบา", "toshiba"],
  ["ชาร์ป", "sharp"],
  ["ซัมซุง", "samsung"],
  ["แอลจี", "lg"],
  ["โซนี่", "sony"],
  ["ฮาตาริ", "hatari"],

  // Grocery, Beverage, Personal Care, Pet & Medicine Brands
  ["ซันไลต์", "ซันไลท์", "sunlight"],
  ["บรีส", "breeze"],
  ["โอโม", "omo"],
  ["ดาวน์นี่", "downy"],
  ["ไฮยีน", "hygiene"],
  ["คอมฟอร์ท", "comfort"],
  ["คอลเกต", "colgate"],
  ["ดาร์ลี่", "darlie"],
  ["ซิสเท็มมา", "systema"],
  ["ลิสเตอรีน", "listerine"],
  ["นีเวีย", "nivea"],
  ["วาสลีน", "vaseline"],
  ["การ์นิเย่", "garnier"],
  ["ลอรีอัล", "loreal", "l'oreal"],
  ["ลอรีเอะ", "laurier"],
  ["เดทตอล", "dettol"],
  ["วัตสัน", "watsons"],
  ["โดฟ", "dove"],
  ["ลักส์", "lux"],
  ["ซันซิล", "sunsilk"],
  ["แพนทีน", "pantene"],
  ["เคลียร์", "clear"],
  ["โพรเทคส์", "protex"],
  ["จอห์นสัน", "johnson"],
  ["พอนด์ส", "ponds"],
  ["เบบี้มายด์", "babi mild"],
  ["บิโอเร", "biore"],
  ["เซราวี", "cerave"],
  ["ยูเซอริน", "eucerin"],
  ["เนสกาแฟ", "nescafe"],
  ["เนสท์เล่", "nestle"],
  ["ไมโล", "milo"],
  ["โอวัลติน", "ovaltine"],
  ["โค้ก", "โคคาโคล่า", "coke", "coca cola", "cocacola"],
  ["เป๊ปซี่", "pepsi"],
  ["สไปรท์", "sprite"],
  ["แฟนต้า", "fanta"],
  ["ช้าง", "chang"],
  ["สิงห์", "singha"],
  ["ลีโอ", "leo"],
  ["ไฮเนเก้น", "heineken"],
  ["เลย์", "lays"],
  ["โอรีโอ", "oreo"],
  ["คนอร์", "knorr"],
  ["แม็กกี้", "maggi"],
  ["เมจิ", "meiji"],
  ["โฟร์โมสต์", "foremost"],
  ["ดัชมิลล์", "dutch mill"],
  ["แลคตาซอย", "lactasoy"],
  ["ไวตามิ้ลค์", "vitamilk"],
  ["อิชิตัน", "ichitan"],
  ["โออิชิ", "oishi"],
  ["มาม่า", "mama"],
  ["ไวไว", "waiwai"],
  ["ยำยำ", "yumyum"],
  ["ทิพรส", "tiparos"],
  ["ไฮคิว", "hi-q", "hiq"],
  ["รอยัลคานิน", "royal canin"],
  ["สมาร์ทฮาร์ท", "smartheart"],
  ["วิสกัส", "whiskas"],
  ["มีโอ", "me-o", "meo"],
  ["เพดดิกรี", "pedigree"],
  ["ชีบา", "sheba"],
  ["บราเวคโต้", "bravecto"],
  ["พานาดอล", "panadol"],
  ["ไทลีนอล", "tylenol"],
  ["คาลาไมน์", "calamine"],
  ["เบตาดีน", "betadine"],
  ["วิคส์", "vicks"],

  // Common Thai <-> English Product Nouns
  ["มิลวอกี้", "milwaukee"],
  ["ชไนเดอร์", "schneider"],
  ["บีทีชิโน", "bticino"],
  ["ฟูจิก้า", "fujika"],
  ["คลินตัน", "clinton"],
  ["โปโล", "polo"],
  ["สว่าน", "drill"],
  ["ไร้สาย", "cordless"],
  ["หลอดไฟ", "bulb", "lamp"],
  ["เครื่องเจียร", "ลูกหมู", "grinder"],
  ["เลื่อย", "saw"],
  ["คีม", "pliers"],
  ["ไขควง", "screwdriver"],
  ["ตลับเมตร", "tape measure"],
  ["ประแจ", "wrench"],
  ["ค้อน", "hammer"],
  ["ใบตัด", "cutting disc"],
  ["ซิลิโคน", "silicone"],
  ["กาว", "glue", "adhesive"],
  ["สกรู", "screw"],
  ["สายไฟ", "cable", "wire"],
  ["ปลั๊กพ่วง", "extension cord", "power strip"],
  ["เครื่องฉีดน้ำ", "pressure washer"],
  ["ปั๊มน้ำ", "ปั้มน้ำ", "water pump"],
  ["แชมพู", "shampoo"],
  ["ยาสีฟัน", "toothpaste"],
  ["แปรงสีฟัน", "toothbrush"],
  ["น้ำยาบ้วนปาก", "mouthwash"],
  ["โฟมล้างหน้า", "facial foam", "cleanser"],
  ["ครีมกันแดด", "sunscreen"],
  ["โลชั่น", "lotion"],
  ["มาสก์หน้า", "mask"],
  ["วิตามิน", "vitamin"],
  ["คอลลาเจน", "collagen"],
  ["โปรตีน", "protein"],
  ["สบู่", "soap"],
  ["ผงซักฟอก", "detergent"],
  ["น้ำยาซักผ้า", "liquid detergent"],
  ["น้ำยาล้างจาน", "dishwashing"],
  ["น้ำยาปรับผ้านุ่ม", "fabric softener"],
  ["น้ำยาถูพื้น", "floor cleaner"],
  ["สเปรย์กันยุง", "mosquito repellent"],
  ["ถุงขยะ", "garbage bag"],
  ["น้ำปลา", "fish sauce"],
  ["ซีอิ๊ว", "soy sauce"],
  ["น้ำมันหอย", "ซอสหอยนางรม", "oyster sauce"],
  ["ซอสมะเขือเทศ", "ketchup", "tomato sauce"],
  ["ซอสพริก", "chili sauce"],
  ["มายองเนส", "mayonnaise"],
  ["น้ำจิ้มไก่", "sweet chili sauce"],
  ["ปลากระป๋อง", "canned fish"],
  ["ทูน่า", "tuna"],
  ["น้ำมันพืช", "vegetable oil", "cooking oil"],
  ["น้ำตาล", "sugar"],
  ["กาแฟ", "coffee"],
  ["ชาเขียว", "green tea"],
  ["น้ำผลไม้", "juice"],
  ["โซดา", "soda"],
  ["นม", "milk"],
  ["โยเกิร์ต", "yogurt"],
  ["ชีส", "cheese"],
  ["เนย", "butter"],
  ["ช็อกโกแลต", "chocolate"],
  ["คุกกี้", "cookie"],
  ["น้ำดื่ม", "drinking water"],
  ["เบียร์", "beer"],
  ["ไวน์", "wine"],
  ["ขนม", "ขนมขบเคี้ยว", "snack"],
  ["กระดาษชำระ", "ทิชชู่", "toilet paper", "tissue"],
  ["ทิชชู่เปียก", "wet wipes"],
  ["ผ้าอ้อม", "diaper"],
  ["อาหารแมว", "cat food"],
  ["อาหารสุนัข", "อาหารหมา", "dog food"],
  ["ถ่านไฟฉาย", "แบตเตอรี่", "battery"],
];

const normTerm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
const isThai = (s: string) => /[ก-๙]/.test(s);
const isAsciiLetters = (s: string) => /^[a-z0-9][a-z0-9 .-]{1,}$/i.test(s) && /[a-z]/i.test(s);

/** Multi-syllable transliterated Thai tokens preserved whole during body/query tokenization. */
export const TRANSLITERATED_COMPOUND_BRANDS: readonly string[] = [
  ...new Set(
    BILINGUAL_EQUIV_GROUPS.flat().filter(
      (w) =>
        /[ก-๙]/.test(w) &&
        !/\s/.test(w) &&
        w.length >= 4 &&
        /^[ก-๙0-9a-z]+$/i.test(w) &&
        w !== "ขนม" &&
        w !== "สิงห์" &&
        w !== "ช้าง" &&
        w !== "สว่าน" &&
        w !== "น้ำปลา" &&
        w !== "น้ำมัน" &&
        w !== "กาแฟ" &&
        w !== "แชมพู" &&
        w !== "น้ำตาล" &&
        w !== "น้ำดื่ม" &&
        w !== "น้ำมันหอย" &&
        w !== "ซอสหอยนางรม" &&
        w !== "กระดาษชำระ" &&
        w !== "ทิชชู่เปียก" &&
        w !== "เครื่องฉีดน้ำ" &&
        w !== "ไร้สาย" &&
        w !== "ชาเขียว",
    ),
  ),
];

const BUILT_IN_TRANSLIT_SET = new Set(TRANSLITERATED_COMPOUND_BRANDS.map(normTerm));

export type BilingualIndex = {
  directMap: Map<string, Set<string>>;
  phoneticEn: Map<string, Set<string>>;
  phoneticTh: Map<string, Set<string>>;
  knownThaiPhrases: string[];
  knownEnPhrases: string[];
};

/**
 * Coarse cross-script consonant skeleton mapping Thai transliterations & English brand words
 * to the same key (e.g. "มากิต้า" -> "mkt", "makita" -> "mkt"; "บราเวคโต้" / "bravecto" -> "plwkt").
 */
export function crossScriptPhoneticKey(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (!s) return "";

  let sk = "";
  if (isThai(s)) {
    // Drop Thai silent consonant+thanthakhat pairs (e.g. "ส์", "ต์") and vowels/tone marks.
    const clean = s
      .replace(/[ก-ฮ]์/g, "")
      .replace(/[\u0e30-\u0e4e\s.,'"\-!?()]/g, "")
      .replace(/ทร/g, "s");
    for (const ch of clean) {
      if ("กขคง".includes(ch)) sk += ch === "ง" ? "n" : "k";
      else if ("ฆคฅ".includes(ch)) sk += "k";
      else if ("บปพภผ".includes(ch)) sk += "p";
      else if ("ดตทธถฎฏฑฒฐ".includes(ch)) sk += "t";
      else if ("จชซศษสฉฌ".includes(ch)) sk += "s";
      else if ("รลฬ".includes(ch)) sk += "l";
      else if ("ฟฝ".includes(ch)) sk += "f";
      else if (ch === "ว") sk += "w";
      else if (ch === "ม") sk += "m";
      else if ("นณญ".includes(ch)) sk += "n";
      else if ("หฮ".includes(ch)) sk += "h";
      else if (ch === "ย") sk += "y";
      else if (ch >= "0" && ch <= "9") sk += ch;
    }
  } else {
    let clean = s
      .replace(/[^a-z0-9]/g, "")
      .replace(/ph/g, "f")
      .replace(/sh|ch|zh/g, "s")
      .replace(/th/g, "t")
      .replace(/ck|qu?/g, "k")
      .replace(/kn/g, "n")
      .replace(/wr/g, "l")
      // Drop silent post-vowel r before another consonant ("karcher" -> "kcher", "smart" -> "smat")
      .replace(/([aeiou])r(?=[bcdfgjklmnpqrstvwxz])/g, "$1")
      // Drop trailing plural/silent s only when word is long enough ("ponds" vs short words)
      .replace(/([bcdfgjklmnpqrtvwxz])s$/g, "$1");
    clean = clean.replace(/c(?=[eiy])/g, "s").replace(/c/g, "k");
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (i === 0 && "aeiou".includes(ch)) continue;
      if ("aeiou".includes(ch)) continue;
      if ("kgx".includes(ch)) sk += ch === "x" ? "ks" : "k";
      else if ("bp".includes(ch)) sk += "p";
      else if ("dt".includes(ch)) sk += "t";
      else if ("szj".includes(ch)) sk += "s";
      else if ("rl".includes(ch)) sk += "l";
      else if ("vw".includes(ch)) sk += "w";
      else if ("f".includes(ch)) sk += "f";
      else if ("m".includes(ch)) sk += "m";
      else if ("n".includes(ch)) sk += "n";
      else if ("h".includes(ch)) sk += "h";
      else if ("y".includes(ch)) sk += "y";
      else if (ch >= "0" && ch <= "9") sk += ch;
    }
  }

  // Collapse adjacent duplicate consonants ("pp" -> "p", "ll" -> "l")
  let collapsed = "";
  for (const c of sk) {
    if (c !== collapsed[collapsed.length - 1]) collapsed += c;
  }
  return collapsed;
}

function addDirectPair(map: Map<string, Set<string>>, aRaw: string, bRaw: string) {
  const a = normTerm(aRaw);
  const b = normTerm(bRaw);
  if (!a || !b || a === b) return;
  if (!map.has(a)) map.set(a, new Set());
  map.get(a)!.add(b);
}

/**
 * Build fast in-memory Thai <-> English bidirectional & phonetic brand/category index from real catalog data.
 */
export function buildBilingualIndex(products: readonly BrainProductItem[]): BilingualIndex {
  const directMap = new Map<string, Set<string>>();
  const phoneticEn = new Map<string, Set<string>>();
  const phoneticTh = new Map<string, Set<string>>();
  const thPhrases = new Set<string>();
  const enPhrases = new Set<string>();

  for (const grp of BILINGUAL_EQUIV_GROUPS) {
    const cleaned = grp.map(normTerm).filter((x) => x.length >= 2);
    for (const a of cleaned) {
      if (isThai(a) && (a.length >= 5 || BUILT_IN_TRANSLIT_SET.has(a))) thPhrases.add(a);
      else if (isAsciiLetters(a) && a.includes(" ")) enPhrases.add(a);
      for (const b of cleaned) addDirectPair(directMap, a, b);
    }
  }

  const indexPhoneticToken = (tokRaw: string) => {
    const tok = normTerm(tokRaw);
    if (tok.length < 4 || tok.includes(" ")) return;
    const sk = crossScriptPhoneticKey(tok);
    if (sk.length < 4) return;
    if (isThai(tok)) {
      if (!phoneticTh.has(sk)) phoneticTh.set(sk, new Set());
      phoneticTh.get(sk)!.add(tok);
    } else if (/^[a-z]{4,}$/.test(tok)) {
      if (!phoneticEn.has(sk)) phoneticEn.set(sk, new Set());
      phoneticEn.get(sk)!.add(tok);
    }
  };

  for (const p of products) {
    const bt = normTerm(p.brandTh);
    const be = normTerm(p.brandEn);
    if (bt && be && bt !== be && bt !== "-" && be !== "-") {
      if ((isThai(bt) && isAsciiLetters(be)) || (isThai(be) && isAsciiLetters(bt))) {
        addDirectPair(directMap, bt, be);
        addDirectPair(directMap, be, bt);
        if (isThai(bt) && bt.length >= 5 && !/\s/.test(bt)) thPhrases.add(bt);
        if (isThai(be) && be.length >= 5 && !/\s/.test(be)) thPhrases.add(be);
        if (isAsciiLetters(be) && be.includes(" ")) enPhrases.add(be);
        if (isAsciiLetters(bt) && bt.includes(" ")) enPhrases.add(bt);
      }
    }
    for (const part of bt.split(/[\s/&]+/)) indexPhoneticToken(part);
    for (const part of be.split(/[\s/&]+/)) indexPhoneticToken(part);
  }

  return {
    directMap,
    phoneticEn,
    phoneticTh,
    knownThaiPhrases: [...thPhrases].sort((a, b) => b.length - a.length),
    knownEnPhrases: [...enPhrases].sort((a, b) => b.length - a.length),
  };
}

/**
 * Extract whole known Thai/English bilingual phrases intact from a normalized query string
 * before word segmentation splits foreign brand spellings (e.g. "สว่านมากิต้า" -> ["มากิต้า"], remainder "สว่าน").
 */
export function extractKnownBilingualPhrases(
  normQuery: string,
  index: BilingualIndex,
): { phrases: string[]; remainder: string } {
  if (!normQuery) return { phrases: [], remainder: "" };
  const phrases: string[] = [];
  let rest = normQuery;

  for (const ep of index.knownEnPhrases) {
    if (rest.includes(ep)) {
      phrases.push(ep);
      rest = rest.split(ep).join(" ");
    }
  }
  for (const tp of index.knownThaiPhrases) {
    if (rest.includes(tp)) {
      phrases.push(tp);
      rest = rest.split(tp).join(" ");
    }
  }

  return { phrases, remainder: rest.replace(/\s+/g, " ").trim() };
}

/**
 * Return bilingual Thai <-> English equivalents for a query token using:
 * 1) Curated + catalog-learned bidirectional pairs (always active)
 * 2) Cross-script consonant skeleton matching when direct postings are absent or sparse
 */
export function getBilingualEquivalents(
  rawToken: string,
  index: BilingualIndex,
  directPostingCount = 0,
  allowPhonetic = true,
): string[] {
  const tok = normTerm(rawToken);
  if (!tok || tok.length < 2) return [];

  const out = new Set<string>();
  for (const eq of index.directMap.get(tok) ?? []) {
    if (eq !== tok) out.add(eq);
  }

  if (allowPhonetic && tok.length >= 4 && directPostingCount < 5) {
    const sk = crossScriptPhoneticKey(tok);
    if (sk.length >= 4) {
      if (isThai(tok) && directPostingCount === 0) {
        const hits = index.phoneticEn.get(sk);
        if (hits && hits.size <= 4) {
          for (const en of hits) out.add(en);
        }
      } else if (/^[a-z]{4,}$/.test(tok)) {
        const hits = index.phoneticTh.get(sk);
        if (hits && hits.size <= 4) {
          for (const th of hits) out.add(th);
        }
      }
    }
  }

  return [...out].slice(0, 8);
}
