// Measures the listening corrector (lib/heard-fix.ts) on what the system would DECIDE, not on spelling.
//   node scripts/heard-bench.mjs record   speak every sentence with the system's own voice, store what the listener wrote
//   node scripts/heard-bench.mjs          score the stored recordings against the working tree's fixHeard
// Recording needs the voice sidecar (:3091); scoring search sentences needs the web server (:3090, read-only GET).
// Recordings and the report stay in .data/heard-bench (git-ignored), so a code change is re-scored in seconds.
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// lib/*.ts import each other without an extension, the way Next resolves them.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && !/\.[a-z0-9]+$/i.test(spec) && ctx.parentURL?.startsWith("file:")) {
      const candidate = new URL(`${spec}.ts`, ctx.parentURL);
      if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
const { parseScreenCommand, parseBudget } = await import("../lib/voice-commands.ts");
const { parseNumberedOrder, parseBareQuantity, parsePointedOrder, pointsAtOpenProduct, parseThaiNumber } = await import(
  "../lib/numbered-order.ts"
);
const { buildHeardVocab, fixHeard } = await import("../lib/heard-fix.ts");

const VOICE = process.env.BENCH_VOICE_URL || "http://127.0.0.1:3091";
const WEB = process.env.BENCH_WEB_URL || "http://127.0.0.1:3090";
const DIR = path.join(".data", "heard-bench");
const products = JSON.parse(fs.readFileSync(path.join(".data", "brain-snapshot.json"), "utf8")).products;
const vocab = buildHeardVocab(products);
const fix = (text) => fixHeard(text, vocab);

// ---------- Sentences ----------
/** "brand + product noun" for the brands ranked from..to by product count, as a customer asks for them. */
function brandPhrases(from, to, thaiOnly) {
  const namesOf = new Map();
  for (const p of products) {
    const brand = (p.brandTh || "").trim();
    if (!brand || !p.nameTh) continue;
    if (!namesOf.has(brand)) namesOf.set(brand, []);
    namesOf.get(brand).push(p.nameTh);
  }
  return [...namesOf.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(from, to)
    .filter(([brand]) => !thaiOnly || /^[ก-๙\s.-]+$/.test(brand))
    .map(([brand, names]) => {
      const noun = names.map((n) => n.replace(brand, "").trim().split(/\s+/)[0]).find((w) => w && /^[ก-๙]{3,}$/.test(w));
      return `ขอดู${noun ? `${brand} ${noun}` : brand}`;
    });
}
const ask = (words) => words.map((w) => `ขอดู${w}`);

/** The corrector's rules were tuned on this set. */
const TUNING = {
  command: [
    "ถอยกลับไป", "หน้าที่แล้ว", "ย้อนกลับสองหน้า", "เดินหน้า", "ตัวถัดไป", "อันต่อไป", "ตัวก่อนหน้า", "ถัดไป",
    "ดูเบอร์หนึ่ง", "เปิดเบอร์สอง", "ดูเบอร์สาม", "ดูเบอร์สี่", "ขยายเบอร์ห้า", "ดูเบอร์หก", "ดูเบอร์เจ็ด", "ดูเบอร์แปด", "ขอดูเบอร์เก้า", "ดูเบอร์สิบ",
    "ขอดูรายละเอียด", "ดูข้อมูลตัวนี้", "ดูสินค้า", "ภาพสินค้า", "ดูตารางเปรียบเทียบ", "ดูตะกร้า", "ในตะกร้ามีอะไรบ้าง",
    "คิดเงิน", "เช็คบิล", "ไปหน้าจ่ายเงิน", "ชำระเงิน", "เปิดกล้อง", "ปิดกล้อง", "สแกนบาร์โค้ด",
    "ขึ้นบนสุด", "ลงล่างสุด", "เลื่อนลง", "เลื่อนขึ้น", "ลงอีก", "ขึ้นอีก", "หยุด", "เงียบก่อน", "พูดอีกที", "ว่าไงนะ",
    "ปิดเสียง", "เปิดเสียง", "ปิดไมค์", "กลับหน้าแรก", "หน้าหลัก", "หมุนวงล้อ", "ลุ้นโชค",
    "เทียบเบอร์สองกับห้า", "ดวลเบอร์หนึ่งกับสาม", "ดูของที่เกี่ยวข้อง", "มีอะไรใกล้เคียงอีกไหม", "เอาด้วย", "ใส่ตัวที่แนะนำ",
    "สั่งอะไรได้บ้าง", "ช่วยเหลือ", "ดูบิลขาย", "ประวัติการสั่งซื้อ", "ดูประวัติหน้าจอ", "ไปหน้าค้นหา", "เปิดสมองสามมิติ", "เปิดสารบัญ",
    "น้องตี๋ถอยกลับไปหน่อยครับ", "ช่วยดูตะกร้าหน่อยครับ", "ขอดูเบอร์สามหน่อยครับ", "คิดเงินเลยครับ", "ลองเล่น", "ซ่อนภารกิจ",
  ],
  order: [
    "เอาเบอร์สามสองชิ้น", "เอาเบอร์หนึ่งหนึ่งชิ้น", "เบอร์สองสามขวด", "รับเบอร์ห้าหนึ่งลัง", "ขอเบอร์สี่สองแพ็ค",
    "เอาเบอร์หนึ่งสองชิ้น เบอร์สามหนึ่งขวด", "ใส่เบอร์หกสิบชิ้น", "เอาเบอร์สองสิบสองขวด", "เอาเบอร์เจ็ดห้ากล่อง",
    "สั่งเบอร์แปดยี่สิบซอง", "เอาเบอร์สอง", "เบอร์สามครับ", "เอาเบอร์สี่สามถุง", "เอาเบอร์ห้าหกกระป๋อง", "เอาเบอร์หนึ่งสองโหล",
  ],
  bare: ["สองชิ้น", "สามขวด", "หนึ่งลัง", "ห้าแพ็ค", "สิบชิ้นครับ", "สองโหล", "หกกระป๋อง", "สี่ถุง", "หนึ่งกล่อง", "ยี่สิบซอง", "สิบสองขวด", "สามชิ้น", "หนึ่งชิ้น", "สองขวด"],
  pointed: ["เอาอันนี้สองชิ้น", "รับตัวนี้สามแพ็คครับ", "ใส่ตะกร้าเลยครับ", "เอาอันนี้ใส่ตะกร้าสิบสองขวด", "เอาตัวนี้หนึ่งลัง", "ใส่ตะกร้าเลยสามแพ็ค", "เอาอันนี้หนึ่งชิ้น"],
  budget: ["งบห้าร้อยบาท", "มีงบหนึ่งพันบาท", "งบสองร้อยบาท"],
  point: ["ตัวนี้เก็บได้นานไหม", "อันนี้ราคาเท่าไหร่", "ตัวนี้มีผงชูรสไหม", "อันนี้กับเบอร์สองอันไหนคุ้มกว่า"],
  search: ask([
    "น้ำปลา", "น้ำจิ้มไก่", "สบู่", "น้ำตาลทราย", "น้ำมันพืช", "ข้าวสาร", "บะหมี่กึ่งสำเร็จรูป", "ผงซักฟอก", "น้ำยาล้างจาน", "กาแฟ",
    "นมข้นหวาน", "ซอสปรุงรส", "ซีอิ๊วขาว", "น้ำดื่ม", "กระดาษทิชชู่", "ยาสีฟัน", "แชมพู", "ปลากระป๋อง", "ผงชูรส", "น้ำส้มสายชู",
    "พริกแกง", "กะทิ", "ไข่ไก่", "เกลือ", "น้ำอัดลม", "ขนมปัง", "วุ้นเส้น", "แป้งสาลี", "ซอสหอยนางรม", "ซอสมะเขือเทศ",
    "ซอสพริก", "มายองเนส", "เนย", "ชีส", "ไส้กรอก", "ลูกชิ้น", "ถุงขยะ", "ถุงมือ", "น้ำยาปรับผ้านุ่ม", "ครีมเทียม",
  ]),
  brand: brandPhrases(0, 70, false),
};

/** Never used for tuning: a rule that only helps the tuning set shows up here as no gain. */
const HELDOUT = {
  command: [
    "ย้อนกลับ", "กลับไปหน้าที่แล้ว", "ไปหน้าหลัก", "ขอดูตะกร้าหน่อย", "เปิดตะกร้า", "จ่ายเงินเลย", "ขอเช็คบิลครับ", "เช็คบิลเลย",
    "เช็คบิลหน่อยครับ", "เช็คบิล", "คิดเงินด้วยครับ", "ปิดการขาย", "เปิดกล้องหน่อย", "ปิดกล้องเลย", "เลื่อนลงอีก", "เลื่อนขึ้นหน่อย",
    "หยุดพูด", "เงียบ", "พูดอีกทีครับ", "ปิดไมค์ก่อน", "ดูรายละเอียดเบอร์สอง", "ดูเบอร์สิบเอ็ด", "เปรียบเทียบเบอร์หนึ่งกับสอง",
    "เทียบเบอร์สามกับสี่", "ดวลเบอร์สองกับหก", "ดูของใกล้เคียง", "ของที่เกี่ยวข้อง", "ดูประวัติการสั่งซื้อ", "ไปหน้าค้นหาสินค้า",
    "เปิดสารบัญหน่อย", "หมุนวงล้อเลย", "ถัดไปครับ", "ต่อไป", "กลับหน้าหลัก", "ถอยกลับ", "ถอยหลัง", "ชำระเงินเลยครับ", "ดูบิลขายหน่อย",
  ],
  order: [
    "เอาเบอร์สองสามชิ้น", "เอาเบอร์สี่หนึ่งลัง", "เบอร์หกสองโหล", "รับเบอร์หนึ่งห้าขวด", "เอาเบอร์เก้าสองถุง", "ขอเบอร์เจ็ดสามกล่อง",
    "เอาเบอร์ห้าสี่แพ็คครับ", "เอาเบอร์สองหนึ่งลัง เบอร์สี่สองขวด", "สั่งเบอร์สามหกกระป๋อง", "เอาเบอร์หนึ่งสิบซอง",
  ],
  bare: ["สี่ชิ้น", "สองลัง", "สามโหล", "ห้าขวดครับ", "หกแพ็ค", "สิบถุง", "หนึ่งลังครับ", "สองกล่อง"],
  search: ask([
    "ซอสถั่วเหลือง", "น้ำตาลปี๊บ", "ข้าวเหนียว", "เส้นหมี่", "ปลาทูน่า", "นมถั่วเหลือง", "โยเกิร์ต", "ไอศกรีม", "น้ำผลไม้", "ชาเขียว",
    "เบียร์", "ขนมขบเคี้ยว", "ลูกอม", "ช็อกโกแลต", "คุกกี้", "โจ๊ก", "ซุปก้อน", "น้ำพริกเผา", "กะปิ", "ผ้าอนามัย",
    "ผ้าอ้อม", "ครีมอาบน้ำ", "โลชั่น", "น้ำยาบ้วนปาก", "มีดโกน", "ยากันยุง", "น้ำยาถูพื้น", "น้ำยาล้างห้องน้ำ", "ถ่านไฟฉาย", "หลอดไฟ",
    "ไม้กวาด", "ฟองน้ำล้างจาน", "ถุงร้อน", "กล่องโฟม", "หลอดดูด", "แก้วพลาสติก", "อาหารแมว", "อาหารสุนัข", "ทรายแมว", "แปรงสีฟัน",
  ]),
  brand: brandPhrases(70, 140, true),
};
// Cards on screen when a numbered order is judged: each set speaks card numbers up to this.
const SETS = [
  { name: "tuning", corpus: TUNING, cards: 10 },
  { name: "heldout", corpus: HELDOUT, cards: 12 },
];

// ---------- Record: the system's own voice -> the listener, before any correction ----------
async function hear(sentence) {
  const tts = await fetch(`${VOICE}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: sentence }),
  });
  if (!tts.ok) return null;
  const stt = await fetch(`${VOICE}/stt`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "x-audio-format": "wav", "x-partial": "0" },
    body: Buffer.from(await tts.arrayBuffer()),
  });
  return stt.ok ? ((await stt.json()).text ?? "") : null;
}

async function record({ name, corpus }) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.json`);
  const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const seen = new Set(rows.map((r) => `${r.kind}|${r.ref}`));
  let failed = 0;
  for (const [kind, list] of Object.entries(corpus)) {
    for (const ref of list) {
      if (seen.has(`${kind}|${ref}`)) continue;
      const heard = await hear(ref);
      if (heard === null) failed++;
      else rows.push({ kind, ref, heard });
      fs.writeFileSync(file, JSON.stringify(rows)); // a stopped run resumes where it left off
    }
  }
  console.log(`${name}: อัดไว้ ${rows.length} ประโยค${failed ? ` (อัดไม่สำเร็จ ${failed} — รัน record ซ้ำได้)` : ""}`);
}

// ---------- Score: the same decision as the sentence that was really said ----------
const squash = (t) => t.replace(/[\s.,!?"'“”]+/g, "");
const searchWords = (t) => squash(t).replace(/^(?:ขอดู|ขอ|ดู)/, "").replace(/(?:หน่อย|ครับ|ค่ะ)+$/, "");
const topSlugsCache = new Map();
async function topSlugs(q) {
  if (!topSlugsCache.has(q)) {
    const res = await fetch(`${WEB}/api/products/search?pageSize=6&q=${encodeURIComponent(q)}`);
    topSlugsCache.set(q, ((await res.json()).items ?? []).slice(0, 6).map((x) => x.slug));
  }
  return topSlugsCache.get(q);
}

async function decide(kind, text, cards) {
  if (kind === "command") return JSON.stringify(parseScreenCommand(text, { modalOpen: false }));
  if (kind === "order") return JSON.stringify(parseNumberedOrder(text, cards));
  if (kind === "bare") return JSON.stringify(parseBareQuantity(text));
  if (kind === "pointed") return JSON.stringify(parsePointedOrder(text));
  if (kind === "budget") return JSON.stringify(parseBudget(text, parseThaiNumber));
  if (kind === "point") return JSON.stringify([pointsAtOpenProduct(text), parseScreenCommand(text, {})]);
  return JSON.stringify(await topSlugs(searchWords(text)));
}

/** A search counts as the same when the first product matches and most of the first screen does. */
function sameDecision(kind, want, got) {
  if (want === got) return true;
  if (kind !== "search" && kind !== "brand") return false;
  const a = JSON.parse(want);
  const b = JSON.parse(got);
  return a.length > 0 && a[0] === b[0] && a.filter((x) => b.includes(x)).length >= Math.min(4, a.length);
}

const pct = (part, whole) => `${part} (${Math.round((part / whole) * 100)}%)`;

async function score({ name, cards }, report) {
  const file = path.join(DIR, `${name}.json`);
  if (!fs.existsSync(file)) return console.log(`${name}: ยังไม่มีเสียงที่อัดไว้ — รัน "node scripts/heard-bench.mjs record" ก่อน`);
  const byKind = new Map();
  let refChanged = 0;
  for (const r of JSON.parse(fs.readFileSync(file, "utf8"))) {
    const want = await decide(r.kind, r.ref, cards);
    if (want === "null") continue; // the sentence itself is not something the system acts on
    if (fix(r.ref) !== r.ref) {
      refChanged++;
      report.push(`ประโยคถูกแต่ถูกเปลี่ยน [${name}/${r.kind}] ${r.ref} => ${fix(r.ref)}`);
    }
    const fixed = fix(r.heard);
    const rawOk = sameDecision(r.kind, want, await decide(r.kind, r.heard, cards));
    const fixOk = sameDecision(r.kind, want, await decide(r.kind, fixed, cards));
    const s = byKind.get(r.kind) ?? { n: 0, raw: 0, fixed: 0 };
    byKind.set(r.kind, { n: s.n + 1, raw: s.raw + Number(rawOk), fixed: s.fixed + Number(fixOk) });
    const verdict = rawOk && !fixOk ? "แย่ลง" : !rawOk && fixOk ? "แก้ได้" : !fixOk ? "ยังผิด" : fixed !== r.heard ? "ถูกอยู่แล้ว" : "";
    if (verdict) report.push(`${verdict} [${name}/${r.kind}] ${r.ref} | ฟังได้: ${r.heard}${fixed !== r.heard ? ` | ปรับเป็น: ${fixed}` : ""}`);
  }
  const all = [...byKind.values()].reduce((t, s) => ({ n: t.n + s.n, raw: t.raw + s.raw, fixed: t.fixed + s.fixed }), { n: 0, raw: 0, fixed: 0 });
  console.log(`${name}: ${all.n} ประโยค  ก่อนปรับ ${pct(all.raw, all.n)}  หลังปรับ ${pct(all.fixed, all.n)}  ประโยคถูกที่ถูกเปลี่ยน ${refChanged}`);
  for (const [kind, s] of byKind) console.log(`  ${kind.padEnd(8)} ${String(s.n).padStart(3)}  ${s.raw} → ${s.fixed}`);
}

// ---------- Left alone: text that is already right must come back unchanged ----------
/** Thai phrases written in this project's own screens, replies and docs: everyday wording, not product names. */
function everydayPhrases() {
  const files = ["AGENTS.md", "CLAUDE.md"];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|md|py)$/.test(e.name) && !/heard-fix|heard-bench|selftest/.test(e.name)) files.push(p);
    }
  };
  for (const dir of ["app", "components", "lib", "scripts", "voice_sidecar"]) if (fs.existsSync(dir)) walk(dir);
  const phrases = new Set();
  for (const f of files) {
    for (const run of fs.readFileSync(f, "utf8").match(/[ก-๙][ก-๙ ]{5,70}[ก-๙]/g) ?? []) phrases.add(run.replace(/\s+/g, " ").trim());
  }
  return [...phrases];
}

/** How a customer asks for each product by the name the catalogue itself writes. */
function catalogueQuestions() {
  const out = [];
  for (const p of products) {
    const words = (p.nameTh || "").split(/\s+/).filter((w) => /[ก-๙]/.test(w) && !/\d/.test(w)).slice(0, 3);
    if (words.length) out.push(`ขอดู${words.join(" ")}`, `มี${words.join("")}ไหมครับ`);
  }
  return out;
}

function scoreLeftAlone(label, sentences, report) {
  const t0 = Date.now();
  let changed = 0;
  for (const s of sentences) {
    const f = fix(s);
    if (squash(f) === squash(s)) continue;
    changed++;
    report.push(`ไม่ควรเปลี่ยน [${label}] ${s} => ${f}`);
  }
  const ms = ((Date.now() - t0) / sentences.length).toFixed(2);
  console.log(`${label}: ${sentences.length} ประโยค  ถูกเปลี่ยน ${changed} (${((changed / sentences.length) * 100).toFixed(2)}%)  เฉลี่ย ${ms} ms`);
}

// ---------- Run ----------
if (process.argv[2] === "record") {
  for (const set of SETS) await record(set);
} else {
  const report = [];
  for (const set of SETS) await score(set, report);
  scoreLeftAlone("วลีไทยทั่วไป", everydayPhrases(), report);
  scoreLeftAlone("ชื่อในแคตตาล็อก", catalogueQuestions(), report);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "report.txt"), report.join("\n"));
  console.log(`รายละเอียดทุกประโยค: ${path.join(DIR, "report.txt")}`);
}
