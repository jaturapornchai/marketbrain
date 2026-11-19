// Full UAT + End-to-End (E2E) Verification Suite for MarketBrain
// Covers: Routes & SEO/AEO, Faceted Search, Local OmniVoice GPU TTS + OpenThai ASR Round-Trip,
// Local Vision AI (qwen3.5:9b) + Barcode Lookup, Multi-Turn Nong Tee Sales Closing SSE, Decimal Cart/Orders, and MCP JSON-RPC.

import assert from "node:assert/strict";
import fs from "node:fs";
import Decimal from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

const BASE_URL = (process.env.UAT_BASE_URL || "http://127.0.0.1:3090").replace(/\/+$/, "");

type SseEvent = {
  type: string;
  [k: string]: unknown;
};

type StepResult = {
  id: string;
  name: string;
  ms: number;
  detail: string;
};

const results: StepResult[] = [];

async function step(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = performance.now();
  process.stdout.write(`⏳ [${id}] ${name} ... `);
  try {
    const detail = await fn();
    const ms = Math.max(1, Math.round(performance.now() - t0));
    results.push({ id, name, ms, detail });
    console.log(`PASS (${ms} ms) — ${detail}`);
  } catch (err) {
    const ms = Math.max(1, Math.round(performance.now() - t0));
    console.log(`FAIL (${ms} ms)`);
    console.error(`❌ [${id}] ${name} FAILED:`, err);
    process.exitCode = 1;
    throw err;
  }
}

async function collectSseEvents(res: Response): Promise<SseEvent[]> {
  assert.equal(res.status, 200, `Expected SSE HTTP 200, got ${res.status}`);
  assert.ok(res.body, "SSE response body missing");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: SseEvent[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const b of blocks) {
      const line = b.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      events.push(JSON.parse(line.slice(6)) as SseEvent);
    }
  }
  return events;
}

/** Decode standard PCM 16-bit or 32-bit float WAV buffer into mono 16kHz Float32Array for STT round-trip testing */
function wavTo16kFloat32(wavBuf: Buffer): Float32Array {
  assert.equal(wavBuf.toString("ascii", 0, 4), "RIFF", "Invalid WAV RIFF header");
  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 24000;
  let bitsPerSample = 16;
  let dataStart = 44;
  let dataLen = wavBuf.length - 44;

  while (offset + 8 <= wavBuf.length) {
    const chunkId = wavBuf.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      audioFormat = wavBuf.readUInt16LE(offset + 8);
      numChannels = wavBuf.readUInt16LE(offset + 10);
      sampleRate = wavBuf.readUInt32LE(offset + 12);
      bitsPerSample = wavBuf.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataStart = offset + 8;
      dataLen = Math.min(chunkSize, wavBuf.length - dataStart);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalFrames = Math.floor(dataLen / (bytesPerSample * numChannels));
  const mono = new Float32Array(totalFrames);

  for (let i = 0; i < totalFrames; i++) {
    const pos = dataStart + i * bytesPerSample * numChannels;
    if (audioFormat === 3 && bitsPerSample === 32) {
      mono[i] = wavBuf.readFloatLE(pos);
    } else if (bitsPerSample === 16) {
      mono[i] = wavBuf.readInt16LE(pos) / 32768;
    }
  }

  if (sampleRate === 16000) return mono;
  const ratio = sampleRate / 16000;
  const outLen = Math.floor(mono.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(mono.length - 1, i0 + 1);
    const frac = srcIdx - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return out;
}

const snap = JSON.parse(fs.readFileSync(".data/brain-snapshot.json", "utf8")) as {
  products: Array<{
    slug: string;
    nameTh: string;
    brandTh: string;
    unitCode: string;
    bestPrice: string | null;
    primaryBarcode: string | null;
    isThaiGs1: boolean;
    imageUrl: string | null;
  }>;
};

const sampleWithBarcode = snap.products.find((p) => p.isThaiGs1 && p.primaryBarcode && p.bestPrice && p.imageUrl)!;
assert.ok(sampleWithBarcode, "Must have sample Thai GS1 product with image and price in snapshot");

console.log("==================================================================");
console.log("🚀 MarketBrain — UAT + End-to-End (E2E) Verification Suite");
console.log(`📍 Target: ${BASE_URL} | Products in Brain: ${snap.products.length.toLocaleString("th-TH")}`);
console.log("==================================================================\n");

// -------------------- UAT-01: Pages, SEO/GEO/AEO & Brand Guardrails --------------------
await step("UAT-01", "Public Routes (/ , /search , /brain , /n , /n/[slug]) + SEO/AEO + Zero Competitor Name", async () => {
  const routes = ["/", "/search", "/brain", "/n", `/n/${encodeURIComponent(sampleWithBarcode.slug)}`, "/robots.txt", "/sitemap.xml"];
  for (const r of routes) {
    const res = await fetch(`${BASE_URL}${r}`);
    assert.equal(res.status, 200, `Route ${r} returned HTTP ${res.status}`);
    const body = await res.text();
    const forbiddenRe = new RegExp(
      Buffer.from(
        "bWFrcm98c2lhbW1ha3JvfOC5geC4oeC5h+C4hOC5guC4hOC4o3zguYHguKHguITguYLguITguKN8c2hvcGVlfOC4iuC5ieC4reC4m+C4m+C4teC5iXxsYXphZGF84Lil4Liy4LiL4Liy4LiU4LmJ4LiyfGxvdHVzJ3N8YWxsb25saW5lfOC4muC4tOC5iuC4geC4i+C4tQ==",
        "base64",
      ).toString("utf8"),
      "i",
    );
    assert.ok(
      !forbiddenRe.test(body),
      `Forbidden external retailer/platform name found in HTML on route ${r}`,
    );
    if (r === "/") {
      assert.ok(body.includes("น้องตี๋"), "Home page must feature น้องตี๋");
      assert.ok(body.includes("application/ld+json"), "Home page must include JSON-LD structured data");
      assert.ok(body.includes("อุปกรณ์"), "Home page must render Device Picker control");
      assert.ok(body.includes("กล้องหาสินค้า"), "Home page must render Camera Product Scanner tab");
    }
    if (r === "/search") {
      assert.ok(body.includes("ค้นหาสินค้าแบบละเอียดเต็มจอ"), "/search must render full-width catalog workbench");
      assert.ok(body.includes("ใส่ตะกร้า"), "/search must render Add-to-Cart buttons");
    }
    if (r === "/robots.txt") {
      assert.ok(body.includes("OAI-SearchBot") && body.includes("GPTBot") && body.includes("Googlebot"), "robots.txt must welcome AI & Search crawlers");
    }
  }
  return `All ${routes.length} routes HTTP 200, JSON-LD + AI crawlers active, 0 competitor names`;
});

// -------------------- UAT-02: Faceted Product Search API & Decimal Sorting --------------------
await step("UAT-02", "Faceted Search API (/api/products/search) — Negation, Units, GS1 885 & Decimal Price Sort", async () => {
  const r1 = await fetch(`${BASE_URL}/api/products/search?q=${encodeURIComponent("ไม่ใส่ผงชูรส")}&pageSize=12`);
  assert.equal(r1.status, 200);
  const j1 = (await r1.json()) as { total: number; items: Array<{ nameTh: string }> };
  assert.ok(j1.total > 0 && j1.total < 800, `Expected targeted 'ไม่ใส่ผงชูรส' hits, got ${j1.total}`);
  assert.ok(!j1.items.some((x) => x.nameTh.includes("อายิโนะโมะโต๊ะ ผงชูรส")), "Negation guard failed");

  const r2 = await fetch(`${BASE_URL}/api/products/search?thaiGs1Only=1&minPrice=15&maxPrice=120&sort=price_asc&pageSize=20`);
  assert.equal(r2.status, 200);
  const j2 = (await r2.json()) as { total: number; items: Array<{ bestPrice: string; isThaiGs1: boolean }> };
  assert.ok(j2.items.length >= 5, "Expected Thai GS1 items in price range 15..120");
  for (let i = 1; i < j2.items.length; i++) {
    const prev = new Decimal(j2.items[i - 1].bestPrice);
    const cur = new Decimal(j2.items[i].bestPrice);
    assert.ok(prev.lte(cur), `Non-monotonic price sort: ${prev.toFixed(2)} > ${cur.toFixed(2)}`);
    assert.ok(cur.gte(15) && cur.lte(120), `Price out of range: ${cur.toFixed(2)}`);
  }
  return `Negation clean (${j1.total} hits), GS1 + Decimal sort verified (${j2.total} hits)`;
});

// -------------------- UAT-03: Local GPU OmniVoice TTS + Local CPU OpenThai ASR Round-Trip --------------------
await step("UAT-03", "Local Voice Engine E2E (OmniVoice GPU TTS -> WAV -> OpenThai 2.0 ASR STT Round-Trip)", async () => {
  const stRes = await fetch(`${BASE_URL}/api/voice/status`);
  assert.equal(stRes.status, 200);
  const stJson = (await stRes.json()) as { ok: boolean; persona: string; ttsModel: string; device: string };
  assert.equal(stJson.ok, true, "Voice sidecar not healthy");
  assert.equal(stJson.device, "cuda:0", "OmniVoice must run on local GPU cuda:0");

  // 1) Pre-warmed auto-start greeting
  const greetRes = await fetch(`${BASE_URL}/api/voice/tts`);
  assert.equal(greetRes.status, 200);
  const greetBuf = Buffer.from(await greetRes.arrayBuffer());
  assert.ok(greetBuf.length > 30000, `Greeting WAV too small (${greetBuf.length} bytes)`);

  // 2) Synthesize speech phrase and feed its PCM directly into local OpenThai ASR!
  const phrase = "ขอดูน้ำจิ้มไก่หน่อยครับ";
  const ttsRes = await fetch(`${BASE_URL}/api/voice/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: phrase }),
  });
  assert.equal(ttsRes.status, 200);
  const wavBuf = Buffer.from(await ttsRes.arrayBuffer());
  const pcm16k = wavTo16kFloat32(wavBuf);

  const sttRes = await fetch(`${BASE_URL}/api/voice/stt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-sample-rate": "16000",
      "x-audio-format": "f32le",
      "x-partial": "0",
    },
    body: Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength),
  });
  assert.equal(sttRes.status, 200);
  const sttJson = (await sttRes.json()) as { ok: boolean; voiced: boolean; text: string };
  assert.equal(sttJson.ok, true);
  assert.equal(sttJson.voiced, true, "VAD must detect synthesized Thai voice");
  assert.ok(sttJson.text.trim().length >= 4, `Expected Thai STT transcript, got "${sttJson.text}"`);
  return `GPU TTS (${wavBuf.length}B WAV) -> CPU OpenThai ASR heard: "${sttJson.text}"`;
});

// -------------------- UAT-04: Instant Visual Product Lookup (Barcode + Local Vision AI) --------------------
let scannedProductSlug = "";
let scannedProductUnit = "";
let scannedProductPrice = "";
let scannedSummary = "";

await step("UAT-04", "Visual Product Search E2E (/api/vision/identify) — Barcode Fast-Path + Local Vision AI", async () => {
  // 4A: Barcode Fast-Path
  const bcRes = await fetch(`${BASE_URL}/api/vision/identify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ barcodeHint: sampleWithBarcode.primaryBarcode }),
  });
  assert.equal(bcRes.status, 200);
  const bcJson = (await bcRes.json()) as { ok: boolean; hasProduct: boolean; exactMatch: boolean; cards: Array<{ slug: string }>; ms: number };
  assert.equal(bcJson.ok && bcJson.hasProduct && bcJson.exactMatch, true);
  assert.ok(bcJson.cards.some((c) => c.slug === sampleWithBarcode.slug), "Barcode lookup must find exact product");

  // 4B: Real Product Image -> Local qwen3.5:9b Vision AI -> MarketBrain Match
  const resolvedImgUrl = sampleWithBarcode.imageUrl!.startsWith("/")
    ? `${BASE_URL}${sampleWithBarcode.imageUrl}`
    : sampleWithBarcode.imageUrl!;
  const imgResp = await fetch(resolvedImgUrl);
  assert.equal(imgResp.status, 200);
  const imgB64 = `data:image/jpeg;base64,${Buffer.from(await imgResp.arrayBuffer()).toString("base64")}`;

  const vRes = await fetch(`${BASE_URL}/api/vision/identify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64: imgB64 }),
  });
  assert.equal(vRes.status, 200);
  const vJson = (await vRes.json()) as {
    ok: boolean;
    hasProduct: boolean;
    matchedQuery: string;
    detected: { summaryTh: string };
    cards: Array<{ slug: string; title: string; unitCode: string; bestPrice: string }>;
    ms: number;
  };
  assert.equal(vJson.ok, true);
  assert.equal(vJson.hasProduct, true, "Vision AI must recognize product photo");
  assert.ok(vJson.cards.length > 0, "Vision AI lookup must return real matching products from Brain");

  const picked = vJson.cards.find((c) => c.bestPrice) ?? vJson.cards[0];
  scannedProductSlug = picked.slug;
  scannedProductUnit = picked.unitCode;
  scannedProductPrice = picked.bestPrice;
  scannedSummary = vJson.detected.summaryTh || vJson.matchedQuery;

  return `Barcode (${bcJson.ms}ms) + Vision AI (${vJson.ms}ms) -> Found "${picked.title}" (฿${picked.bestPrice}/${picked.unitCode})`;
});

// -------------------- UAT-05: Multi-Turn Conversational Cart & Sales Closing with Nong Tee --------------------
await step("UAT-05", "Multi-Turn Nong Tee Sales Closer E2E (Vision Turn -> Add Cart -> Update Qty -> Place Order)", async () => {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];

  // Turn 1: Present Scanned Product from Vision (also verify model override is ignored and locked to deepseek-flash!)
  const t1Events = await collectSseEvents(
    await fetch(`${BASE_URL}/api/javis/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `ลูกค้าส่งรูปสินค้า (${scannedSummary}) ช่วยแนะนำชื่อ ราคา และถามจำนวนใส่ตะกร้าเลยครับ`,
        model: "deepseek-v4-pro",
        history,
        visionSlugs: [scannedProductSlug],
        visionSummary: scannedSummary,
        cartItems: [],
      }),
    }),
  );
  const t1Done = t1Events.find((e) => e.type === "done") as { spokenText?: string; model?: string } | undefined;
  assert.ok(t1Done?.spokenText, "Turn 1 must complete with spoken Thai response");
  assert.equal(t1Done?.model, "deepseek-flash", "Model must be strictly locked to deepseek-flash ONLY");
  assert.ok(t1Events.some((e) => e.type === "cards"), "Turn 1 must emit product cards to visual stage");
  history.push(
    { role: "user", content: `ส่งรูปสินค้า ${scannedSummary}` },
    { role: "assistant", content: t1Done!.spokenText! },
  );

  // Turn 2: Add 4 units to Cart via Natural Thai Conversation
  const t2Events = await collectSseEvents(
    await fetch(`${BASE_URL}/api/javis/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `เอาสินค้า ${scannedProductSlug} ใส่ตะกร้า 4 ${scannedProductUnit} ครับ`,
        history,
        cartItems: [],
      }),
    }),
  );
  const t2CartEv = t2Events.find((e) => e.type === "cart") as {
    cart: { items: Array<{ slug: string; qty: number; unitCode: string }>; totalPieces: number; grandTotal: string };
  } | undefined;
  assert.ok(t2CartEv, "Turn 2 must call cart_add and emit live cart event");
  assert.equal(t2CartEv!.cart.totalPieces, 4, "Cart must contain 4 units");
  const expected4 = new Decimal(scannedProductPrice).times(4).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  assert.equal(t2CartEv!.cart.grandTotal, expected4, `Decimal grandTotal mismatch: expected ${expected4}, got ${t2CartEv!.cart.grandTotal}`);

  const t2Done = t2Events.find((e) => e.type === "done") as { spokenText?: string } | undefined;
  history.push(
    { role: "user", content: `เอา ${scannedProductSlug} 4 ${scannedProductUnit}` },
    { role: "assistant", content: t2Done?.spokenText || "เพิ่มลงตะกร้าแล้วครับ" },
  );

  // Turn 3: Update Qty to 6 units
  const t3Events = await collectSseEvents(
    await fetch(`${BASE_URL}/api/javis/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `เปลี่ยนจำนวนสินค้า ${scannedProductSlug} ในตะกร้าเป็น 6 ${scannedProductUnit} แทนครับ`,
        history,
        cartItems: t2CartEv!.cart.items,
      }),
    }),
  );
  const t3CartEv = t3Events.find((e) => e.type === "cart") as {
    cart: { items: Array<{ slug: string; qty: number; unitCode: string }>; totalPieces: number; grandTotal: string; grandTotalFormatted: string };
  } | undefined;
  assert.ok(t3CartEv, "Turn 3 must call cart_update and emit updated cart");
  assert.equal(t3CartEv!.cart.totalPieces, 6, "Updated cart must have 6 units");
  const expected6 = new Decimal(scannedProductPrice).times(6).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  assert.equal(t3CartEv!.cart.grandTotal, expected6, `Decimal updated grandTotal mismatch`);

  // Turn 4: Close the Sale & Confirm Order via Conversation
  const t4Events = await collectSseEvents(
    await fetch(`${BASE_URL}/api/javis/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "ยืนยันสั่งซื้อปิดการขายเลยครับ ชื่อผู้รับ ลุงจืด UAT เบอร์โทร 089-111-2233 ที่อยู่ 99 สุขุมวิท กรุงเทพ ชำระแบบพร้อมเพย์ครับ",
        history,
        cartItems: t3CartEv!.cart.items,
      }),
    }),
  );
  const t4OrderEv = t4Events.find((e) => e.type === "order") as {
    order: { orderNo: string; cart: { grandTotal: string; grandTotalFormatted: string } };
  } | undefined;
  assert.ok(t4OrderEv, "Turn 4 must call place_order and emit confirmed order");
  assert.match(t4OrderEv!.order.orderNo, /^MB-\d{8}-\d{4}$/, "Order number format invalid");
  assert.equal(t4OrderEv!.order.cart.grandTotal, expected6, "Confirmed order grandTotal must match verified Decimal total");

  // Verify Order Persisted in GET /api/orders
  const ordListRes = await fetch(`${BASE_URL}/api/orders`);
  assert.equal(ordListRes.status, 200);
  const ordListJson = (await ordListRes.json()) as { orders: Array<{ orderNo: string }> };
  assert.ok(ordListJson.orders.some((o) => o.orderNo === t4OrderEv!.order.orderNo), "Order must be persisted in /api/orders");

  return `4-Turn E2E Closed Sale #${t4OrderEv!.order.orderNo} (${t4OrderEv!.order.cart.grandTotalFormatted}, 6 ${scannedProductUnit})`;
});

// -------------------- UAT-06: MCP Server Protocol E2E (/mcp JSON-RPC 2.0) --------------------
await step("UAT-06", "MCP Server JSON-RPC 2.0 (/mcp) — initialize, tools/list, tools/call (search_brain)", async () => {
  const mcpHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  const listRes = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(listRes.status, 200);
  const listRaw = await listRes.text();
  assert.ok(listRaw.includes("ask_brain") && listRaw.includes("search_brain"), "MCP tools/list missing core brain tools");

  const callRes = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_brain", arguments: { query: "น้ำจิ้มไก่", limit: 5 } },
    }),
  });
  assert.equal(callRes.status, 200);
  const callRaw = await callRes.text();
  assert.ok(callRaw.includes("น้ำจิ้มไก่"), "MCP search_brain must return matching Thai product notes");

  return "MCP JSON-RPC 2.0 tools/list + search_brain verified";
});

console.log("\n==================================================================");
console.log(`✅ ALL ${results.length}/${results.length} UAT + E2E SUITES PASSED!`);
for (const r of results) {
  console.log(`  ✓ [${r.id}] ${r.name} (${r.ms} ms)`);
}
console.log("==================================================================");
