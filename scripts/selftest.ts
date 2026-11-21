// Automated verification suite for MarketBrain (Decimal accounting, Product Graph Brain, Faceted Search, Synapses, Secret Scan)
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = process.cwd();
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: { parentURL?: string }) => unknown) {
    if (specifier.startsWith("@/")) {
      const target = path.join(rootDir, specifier.slice(2));
      for (const ext of ["", ".ts", ".tsx"]) {
        if (fs.existsSync(target + ext) && fs.statSync(target + ext).isFile()) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
    }
    if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier) && context.parentURL?.startsWith("file:")) {
      for (const ext of [".ts", ".tsx"]) {
        const candidate = new URL(`${specifier}${ext}`, context.parentURL);
        if (fs.existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context) as { url: string; shortCircuit?: boolean };
  },
});

const { GROUPS, RELATION_TYPES } = await import("../lib/groups.ts");
const { calcDecimalLines, compareMoney, divideMoney, formatThaiBaht, moneyInRange, toMoneyString } = await import(
  "../lib/decimal-money.ts"
);
const { brainStats, getNote, graph, renderNote, search, searchProductsDetailed, traverseGraph } = await import(
  "../lib/vault.ts"
);
const { recalculateCart, resolveProductForCart, saveSalesOrder } = await import("../lib/cart-order.ts");

// 1. Decimal Money Guardrails (Iron Rule #20: 0.1 + 0.2 exact, ROUND_HALF_UP, no float drift)
assert.equal(calcDecimalLines("ทดสอบทศนิยม: 0.1 + 0.2").rows[0]?.result, "0.30", "0.1 + 0.2 must equal 0.30 (exact 2dp, never 0.30000000000000004)");
assert.equal(calcDecimalLines("ปัดครึ่งขึ้น: 10.005 * 1").rows[0]?.result, "10.01", "ROUND_HALF_UP boundary");
assert.equal(divideMoney("100.00", 3), "33.33", "divideMoney precision");
assert.equal(toMoneyString("31"), "31.00");
assert.equal(formatThaiBaht("1250.50"), "฿1,250.50");
assert.equal(compareMoney("29.00", "120.00"), -1);
assert.equal(moneyInRange("55.00", "20", "100"), true);
assert.equal(moneyInRange("155.00", "20", "100"), false);

// 2. Brain Groups & Relations
assert.equal(Object.keys(GROUPS).length, 9, "9 product brain lobes");
assert.ok(RELATION_TYPES.includes("has_trait") && RELATION_TYPES.includes("uses_unit") && RELATION_TYPES.includes("pack_variant"));

// 3. Vault & Snapshot Integrity from bcscanproduct
const stats = brainStats();
console.log("[selftest] Brain stats:", stats);
assert.ok(stats.totalProducts >= 4000, `Expected >= 4,000 real products from bcscanproduct, got ${stats.totalProducts}`);
assert.ok(stats.totalUnits >= 50, `Expected >= 50 units, got ${stats.totalUnits}`);
assert.ok(stats.totalCategories >= 20, `Expected >= 20 categories, got ${stats.totalCategories}`);
assert.ok(stats.totalTraits >= 20, `Expected >= 20 traits, got ${stats.totalTraits}`);
assert.ok(stats.totalSynapses >= 10000, `Expected >= 10,000 rich synapses, got ${stats.totalSynapses}`);

// 4. Faceted Product Search (Attributes, Units, Categories, Price Range, Thai GS1)
const noMsgSearch = searchProductsDetailed({ q: "ไม่ใส่ผงชูรส", pageSize: 10 });
assert.ok(noMsgSearch.total > 0 && noMsgSearch.total < 800, "Should find exact products with 'ไม่ใส่ผงชูรส' claim");
assert.ok(
  !noMsgSearch.items.some((x) => x.nameTh.includes("อายิโนะโมะโต๊ะ ผงชูรส")),
  "Negation 'ไม่ใส่ผงชูรส' must never match pure MSG ('อายิโนะโมะโต๊ะ ผงชูรส')",
);

const bottlePriceSearch = searchProductsDetailed({ unit: "ขวด", minPrice: "10", maxPrice: "200", sort: "price_asc", pageSize: 10 });
assert.ok(bottlePriceSearch.total > 0, "Should filter by unit=ขวด and price range 10..200");
if (bottlePriceSearch.items.length >= 2) {
  assert.ok(
    compareMoney(bottlePriceSearch.items[0].bestPrice, bottlePriceSearch.items[1].bestPrice) <= 0,
    "price_asc sorting must be monotonic",
  );
}

const multiUnitRes = searchProductsDetailed({ multiUnitOnly: true, pageSize: 10 });
assert.ok(multiUnitRes.total > 100, "Should find multi-unit products");

// 5. Hybrid Graph Search, Note Rendering XSS Guard & Synapse Traversal
const hits = search("น้ำจิ้มไก่", 5, "user");
assert.ok(hits.length > 0, "BM25 search finds Thai product notes");
const topNote = getNote(hits[0].slug);
assert.ok(topNote, "getNote resolves top hit");
const html = renderNote(topNote!);
assert.ok(!html.includes("<script"), "Rendered HTML is safe");

const trav = traverseGraph({ slug: topNote!.slug, depth: 2, audience: "user", limit: 15 });
assert.ok(trav.neighbors.length > 0, "Product note has connected synapses (category/brand/unit/trait)");

// 5b. Sales-chat search: the named product must lead, and follow-up sentences must not trigger a product search
const fishSauce = searchProductsDetailed({ q: "มีน้ำปลาอะไรบ้าง", pageSize: 6 });
assert.ok(
  fishSauce.items.length === 6 && fishSauce.items.every((p) => p.nameTh.includes("น้ำปลา")),
  "Top hits for a spoken 'น้ำปลา' question are all น้ำปลา (synonyms never outrank the named product)",
);
const cheapFishSauce = searchProductsDetailed({ q: "น้ำปลา", sort: "price_asc", pageSize: 6 });
assert.ok(
  cheapFishSauce.items.every((p) => p.nameTh.includes("น้ำปลา")) && cheapFishSauce.total < fishSauce.total,
  "Price sort keeps only real 'น้ำปลา' matches, not synonym-only ones",
);
const { productQueryOf } = await import("@/lib/nong-tee");
for (const followUp of ["อันไหนถูกที่สุด", "เอาอันนั้น 2 ขวดใส่ตะกร้า", "แล้วมีขนาดใหญ่กว่านี้ไหม", "รวมเป็นเงินเท่าไหร่", "ตัวแรกเลยครับ"]) {
  assert.equal(productQueryOf(followUp), "", `Follow-up "${followUp}" names no product`);
}
assert.equal(productQueryOf("เอาน้ำปลาทิพรส 2 ขวดใส่ตะกร้า"), "เอาน้ำปลาทิพรส 2 ขวด", "Product words survive cart phrasing");
assert.ok(productQueryOf("มีถุงขยะไหม"), "Unit-like word inside a product name still counts as a product query");

// 6. 3D Brain Graph Generation Performance & Structure
const g = graph("all");
assert.ok(g.nodes.length > 200 && g.nodes.length <= 2000, `Curated 3D graph node count (${g.nodes.length}) is mobile-friendly`);
assert.ok(g.links.length > 200, "3D graph has synapse links");

// 7. Cart & Sales Order Closing Integrity (Decimal + Verified Product Pricing)
const resolvedSample = resolveProductForCart("น้ำจิ้มไก่");
assert.ok(resolvedSample, "resolveProductForCart resolves real product");
const cartCalc = recalculateCart([{ slug: resolvedSample!.product.slug, qty: 3, unitCode: resolvedSample!.unitCode }]);
assert.equal(cartCalc.totalPieces, 3, "Cart total pieces = 3");
const testOrder = saveSalesOrder(cartCalc.items, {
  customerName: "ทดสอบ ปิดการขาย",
  phone: "080-000-0000",
  paymentMethod: "promptpay",
});
assert.ok(testOrder.orderNo.startsWith("MB-"), "Generated order number starts with MB-");
assert.equal(testOrder.cart.grandTotal, cartCalc.grandTotal, "Order grandTotal matches verified Decimal cart");

// ---------- Echo guard, adaptive noise gate & text echo filter (Tier B: 32 ms AudioWorklet + Silero VAD v5) ----------
{
  const { AdaptiveNoiseGate, DUCK_FRAMES, EchoGuard, isEchoTranscript, playedLevel, wavEnvelope } = await import("../lib/echo-guard.ts");
  // Speech-like played level: loud syllables, soft syllables and pauses (one value per 32 ms AudioWorklet frame).
  const played = Array.from({ length: 480 }, (_, i) => (i % 17 >= 13 ? 0 : 0.1 + 0.2 * Math.abs(Math.sin(i * 0.65))));
  for (const coupling of [0.02, 0.1, 0.5]) {
    for (const aecActive of [false, true]) {
      const guard = new EchoGuard();
      const jitter = (i: number) => 0.75 + 0.5 * Math.abs(Math.sin(i * 12.9898)); // echo strength varies ±25%
      let falseBarge = 0;
      played.forEach((lvl, i) => {
        // Even if residual echo occasionally fools Silero VAD slightly (prob 0.75), energy ratio stops false barge-in.
        const prob = aecActive ? 0.35 : null;
        if (guard.hear(lvl * coupling * jitter(i), lvl, prob, aecActive) === "barge_in") falseBarge++;
      });
      assert.equal(falseBarge, 0, `echo only (coupling ${coupling}, aec=${aecActive}) must never barge in`);

      // Customer starts speaking over the bot -> must duck first (~96 ms) then barge in (~192–320 ms).
      let duckedAt = -1;
      let bargedAt = -1;
      for (let i = 0; i < 18 && bargedAt < 0; i++) {
        const lvl = played[i];
        const voice = Math.min(0.18, 0.025 * (i + 1));
        const dec = guard.hear(Math.hypot(lvl * coupling * jitter(i), voice), lvl, 0.9, aecActive);
        if (dec === "duck" && duckedAt < 0) duckedAt = i;
        if (dec === "barge_in") bargedAt = i;
      }
      if (coupling <= 0.1) {
        assert.ok(duckedAt >= 0 && duckedAt < bargedAt, `customer ducks first (coupling ${coupling}, aec=${aecActive}, duck=${duckedAt}, barge=${bargedAt})`);
        assert.ok(bargedAt >= 0 && bargedAt <= 12, `customer barges in cleanly (coupling ${coupling}, aec=${aecActive}, frame ${bargedAt})`);
      }
    }
  }

  // Brief cough/knock while bot speaks: may duck at frame 3, then restores to "echo" without hard-stopping.
  {
    const g = new EchoGuard();
    for (let i = 0; i < 10; i++) g.hear(0.01, 0.2, 0.1, true); // calibrate low echo
    let sawDuck = false;
    let sawBarge = false;
    for (let i = 0; i < DUCK_FRAMES; i++) {
      const d = g.hear(0.06, 0.2, 0.8, true);
      if (d === "duck") sawDuck = true;
      if (d === "barge_in") sawBarge = true;
    }
    assert.ok(sawDuck && !sawBarge, "brief onset ducks without hard-stopping");
    let restored = false;
    for (let i = 0; i < 5; i++) {
      if (g.hear(0.01, 0.2, 0.05, true) === "echo") restored = true;
    }
    assert.ok(restored && !g.isDucked, "duck releases cleanly when short noise stops");
  }

  // AdaptiveNoiseGate: absorbs steady room fan/AC noise and blocks minor noises, admits real human speech.
  {
    const gateVad = new AdaptiveNoiseGate();
    for (let i = 0; i < 120; i++) {
      assert.equal(gateVad.isVoiceFrame(0.018, 0.08, false), false, "steady fan noise rejected by Silero VAD + floor");
    }
    assert.ok(gateVad.noiseFloor > 0.012, "adaptive noise floor tracked steady room hum");
    assert.equal(gateVad.isVoiceFrame(0.022, 0.72, false), false, "faint distant voice barely above room hum rejected");
    assert.equal(gateVad.isVoiceFrame(0.055, 0.88, false), true, "clear human speech above floor admitted");
    assert.equal(gateVad.isVoiceFrame(0.032, 0.45, true), true, "hysteresis holds mid-word dip while already speaking");

    // Fallback mode (no Silero WASM): adapts to steady hum and stops false triggers.
    const gateFallback = new AdaptiveNoiseGate();
    for (let i = 0; i < 150; i++) gateFallback.isVoiceFrame(0.014, null, false);
    assert.equal(gateFallback.isVoiceFrame(0.018, null, false), false, "fallback gate rejects small noise near learned floor");
    assert.equal(gateFallback.isVoiceFrame(0.06, null, false), true, "fallback gate admits clear speech");
  }

  // Text-level echo guard: blocks bot sentences echoed back, keeps short cut-ins and customer product questions.
  {
    const botSaid = "สวัสดีครับ ผมน้องตี๋ เลขาช่วยหาสินค้าและรับออเดอร์ครับ มีน้ำปลาทิพรส ราคา 29 บาทต่อขวดนะครับ";
    assert.equal(isEchoTranscript("สวัสดีครับ ผมน้องตี๋ เลขาช่วยหาสินค้า", botSaid), true, "rejects bot greeting echo");
    assert.equal(isEchoTranscript("ผมน้องตี๋ เลขาช่วยหาสินค้ารับออเดอร์ครับ", botSaid), true, "rejects slightly-garbled bot echo");
    assert.equal(isEchoTranscript("ราคา 29 บาทต่อขวดนะครับ", botSaid), true, "rejects bot price echo");
    assert.equal(isEchoTranscript("หยุด", botSaid), false, "short cut-in 'หยุด' never blocked");
    assert.equal(isEchoTranscript("เดี๋ยวก่อน", botSaid), false, "short cut-in 'เดี๋ยวก่อน' never blocked");
    assert.equal(isEchoTranscript("เอาอันนี้", botSaid), false, "short cut-in 'เอาอันนี้' never blocked");
    assert.equal(isEchoTranscript("ขอดูมาม่ารสต้มยำกุ้งหน่อย", botSaid), false, "genuine customer question never blocked");
    assert.equal(isEchoTranscript("เอาน้ำปลาทิพรส 2 ขวดครับ", botSaid), false, "customer order referencing product never blocked");
  }

  // Self-hosted VAD assets exist in public/vad
  for (const f of ["mic-capture.worklet.js", "silero_vad_v5.onnx", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) {
    const p = path.join(rootDir, "public", "vad", f);
    assert.ok(fs.existsSync(p) && fs.statSync(p).size > 500, `self-hosted VAD asset present: public/vad/${f}`);
  }

  const wav = new ArrayBuffer(44 + 2 * 24000);
  const dv = new DataView(wav);
  dv.setUint32(0, 0x52494646, false); dv.setUint32(8, 0x57415645, false); dv.setUint32(12, 0x666d7420, false);
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 24000, true);
  dv.setUint16(34, 16, true); dv.setUint32(36, 0x64617461, false); dv.setUint32(40, 2 * 24000, true);
  for (let i = 12000; i < 24000; i++) dv.setInt16(44 + i * 2, i % 2 ? 16384 : -16384, true); // 0.5 s silence + 0.5 s at 0.5
  const env = wavEnvelope(wav)!;
  assert.ok(playedLevel(env, 0.3) < 0.01 && Math.abs(playedLevel(env, 0.9) - 0.5) < 0.01, "WAV envelope follows the played level");
  assert.equal(playedLevel(null, 1), 0.25, "unknown envelope assumes full voice");
}

// ---------- Order by card number: "เอาเบอร์ 5 10 ชิ้น" is done exactly, anything unclear is asked ----------
{
  const { parseNumberedOrder, parseBareQuantity, parseThaiNumber } = await import("../lib/numbered-order.ts");
  assert.equal(parseThaiNumber("ยี่สิบเอ็ด"), 21);
  assert.equal(parseThaiNumber("สิบสอง"), 12);
  assert.equal(parseThaiNumber("ร้อยห้าสิบ"), 150);
  assert.deepEqual(parseNumberedOrder("เอาเบอร์ 5 10 ชิ้น", 6), [{ no: 5, qty: 10, afterQty: "ชิ้น" }]);
  assert.deepEqual(parseNumberedOrder("เบอร์ห้าสิบชิ้น", 6), [{ no: 5, qty: 10, afterQty: "ชิ้น" }], "spoken words: card 5 x 10, not card 50");
  assert.deepEqual(parseNumberedOrder("เอาเบอร์สามสองแพ็คครับ", 6)?.[0], { no: 3, qty: 2, afterQty: "แพ็คครับ" });
  assert.deepEqual(
    parseNumberedOrder("เบอร์ 1 สองลัง เบอร์ 4 หนึ่งแพ็ค", 6)?.map((x) => [x.no, x.qty]),
    [[1, 2], [4, 1]],
    "several cards in one sentence",
  );
  assert.deepEqual(parseNumberedOrder("ขอ 2 แพ็ค เบอร์ 3", 6)?.[0], { no: 3, qty: 2, afterQty: "แพ็ค" });
  assert.deepEqual(parseNumberedOrder("เอาเบอร์ 2", 6), [{ no: 2, qty: null, afterQty: "" }], "no quantity -> must ask");
  assert.equal(parseNumberedOrder("เบอร์ 5 ราคาเท่าไหร่", 6), null, "a question is not an order");
  assert.equal(parseNumberedOrder("เอาเบอร์ 5 ออก", 6), null, "removal is not an add");
  assert.equal(parseNumberedOrder("เบอร์ 3", 6), null, "a bare number without order words is left to the conversation");
  assert.equal(parseNumberedOrder("เอาฟูซิลี่เบอร์ 309 2 ถุง", 6), null, "product-name numbers are not card numbers");
  assert.equal(parseNumberedOrder("เบอร์โทร 0812345678", 6), null, "phone numbers are not card numbers");
  assert.deepEqual(parseBareQuantity("สิบแพ็คครับ"), { qty: 10, afterQty: "แพ็คครับ" });
  assert.deepEqual(parseBareQuantity("เอา 3"), { qty: 3, afterQty: "" });
  assert.equal(parseBareQuantity("มีน้ำปลาไหม"), null);
  assert.equal(parseBareQuantity("สองร้อยบาท"), null, "money is not a quantity");

  // Product page open on screen: "อันนี้" = that product (the customer may have opened it by hand)
  const { parsePointedOrder, pointsAtOpenProduct } = await import("../lib/numbered-order.ts");
  assert.deepEqual(parsePointedOrder("เอาอันนี้สองชิ้น"), { qty: 2, afterQty: "ชิ้น" });
  assert.deepEqual(parsePointedOrder("รับตัวนี้ 3 แพ็คครับ"), { qty: 3, afterQty: "แพ็คครับ" });
  assert.deepEqual(parsePointedOrder("ใส่ตะกร้าเลยครับ"), { qty: null, afterQty: "" }, "no quantity -> must ask");
  assert.deepEqual(parsePointedOrder("เอาอันนี้ใส่ตะกร้า 12 ขวด"), { qty: 12, afterQty: "ขวด" });
  for (const t of ["เอาอันนี้ออก", "อันนี้ราคาเท่าไหร่", "ตัวนี้มีผงชูรสไหม", "เอาน้ำปลา 2 ขวด", "เอาอันนี้ 200 บาท", "ดูตะกร้า"]) {
    assert.equal(parsePointedOrder(t), null, t);
  }
  assert.equal(pointsAtOpenProduct("ตัวนี้มีผงชูรสไหม"), true);
  assert.equal(pointsAtOpenProduct("มีน้ำปลาอะไรบ้าง"), false);
  const { mentionsCardNumber, cardNumbersIn } = await import("../lib/numbered-order.ts");
  assert.deepEqual(cardNumbersIn("ขอดูรายละเอียดเบอร์ 9 กับเบอร์ 2", 12), [9, 2], "numbered cards beyond 6 are found");
  assert.equal(mentionsCardNumber("เบอร์ 2 กับเบอร์ 3 ต่างกันยังไง", 6), true, "talking about on-screen numbers keeps the screen");
  assert.equal(mentionsCardNumber("เบอร์ 9 ราคาเท่าไหร่", 6), false);
  assert.equal(mentionsCardNumber("มีฟูซิลี่เบอร์ 309 ไหม", 6), false);

  // Shared numbered grid on spotlight/cart: "เอาเบอร์ 2" orders related card #2 while "เอาอันนี้" orders the open product.
  const { runNongTeeTurn } = await import("../lib/nong-tee.ts");
  const pool = searchProductsDetailed({ q: "น้ำปลา", pageSize: 4 }).items;
  if (pool.length >= 4) {
    const [openProd, rel1, rel2, rel3] = pool;
    const collect = async (msg: string) => {
      const evs = [];
      for await (const ev of runNongTeeTurn({
        message: msg,
        history: [],
        cartItems: [],
        customer: {},
        viewingSlug: openProd.slug,
        focusSlugs: [rel1.slug, rel2.slug, rel3.slug],
      })) evs.push(ev);
      return evs;
    };
    const evRel = await collect("เอาเบอร์ 2 สองชิ้น");
    const cartRel = evRel.find((e) => e.type === "cart") as { type: "cart"; cart: { items: Array<{ slug: string; qty: number }> } } | undefined;
    const doneRel = evRel.find((e) => e.type === "done") as { spokenText?: string } | undefined;
    assert.equal(cartRel?.cart.items[0]?.slug, rel2.slug, "numbered order on related grid picks related card #2");
    assert.equal(cartRel?.cart.items[0]?.qty, 2, "numbered order on related grid uses spoken quantity");
    assert.equal(
      evRel.some((e) => e.type === "stage" && (e as { mode?: string }).mode === "cart"),
      false,
      "adding to cart stays on product screen instead of switching to cart",
    );
    assert.ok(
      doneRel?.spokenText && doneRel.spokenText.length <= 120 && doneRel.spokenText.includes("เบอร์ 2") && doneRel.spokenText.includes("รวม"),
      `numbered order confirmation must be crisp (<=120 chars), got (${doneRel?.spokenText?.length}): ${doneRel?.spokenText}`,
    );

    const evOpen = await collect("เอาอันนี้ 3 ชิ้น");
    const cartOpen = evOpen.find((e) => e.type === "cart") as { type: "cart"; cart: { items: Array<{ slug: string; qty: number }> } } | undefined;
    assert.equal(cartOpen?.cart.items[0]?.slug, openProd.slug, "pointed order still picks the open spotlight product");
    assert.equal(cartOpen?.cart.items[0]?.qty, 3, "pointed order uses spoken quantity");
  }

  // 0-LLM instant browse fast-path: simple product searches answer in <50ms without calling DeepSeek,
  // while comparisons/advice/cart/nutrition questions still route to DeepSeek.
  const { isSimpleBrowseQuery } = await import("../lib/nong-tee.ts");
  assert.equal(isSimpleBrowseQuery("มีน้ำปลาอะไรบ้าง", "น้ำปลา"), true);
  assert.equal(isSimpleBrowseQuery("ขอดูบรีสผงซักฟอกราคาถูกสุด", "บรีสผงซักฟอก"), true);
  assert.equal(isSimpleBrowseQuery("หามาม่าหน่อย", "มาม่า"), true);
  for (const complex of [
    "เทียบน้ำปลาทิพรสกับเมกาเชฟ",
    "น้ำปลาอันไหนโซเดียมต่ำกว่า",
    "เอาน้ำปลา 2 ขวดใส่ตะกร้า",
    "แนะนำน้ำปลาสำหรับทำส้มตำ",
    "น้ำปลาขวดละเท่าไหร่",
  ]) {
    assert.equal(isSimpleBrowseQuery(complex, "น้ำปลา"), false, `complex query must stay on LLM: ${complex}`);
  }
  const tBrowse = performance.now();
  const browseEvs = [];
  for await (const ev of runNongTeeTurn({
    message: "มีน้ำปลาอะไรบ้าง",
    history: [],
    cartItems: [],
    customer: {},
  })) browseEvs.push(ev);
  const browseMs = performance.now() - tBrowse;
  const browseCards = browseEvs.find((e) => e.type === "cards") as { cards?: Array<{ title: string; bestPrice: string | null }> } | undefined;
  const browseDone = browseEvs.find((e) => e.type === "done") as { spokenText?: string; model?: string } | undefined;
  assert.ok(browseCards?.cards?.length, "fast browse emits product cards");
  assert.ok(browseEvs.some((e) => e.type === "sentence"), "fast browse emits spoken sentences");
  assert.ok(browseDone?.spokenText?.includes("เบอร์ 1"), "fast browse references numbered card #1");
  assert.ok(
    (browseDone?.spokenText?.length ?? 999) <= 110,
    `fast browse speech must be concise (<=110 chars), got (${browseDone?.spokenText?.length}): ${browseDone?.spokenText}`,
  );
  assert.ok(!browseDone?.spokenText?.includes("เบอร์ 2"), "fast browse must stay crisp and not recite card #2");
  if (browseCards?.cards?.[0]?.bestPrice) {
    const exactPrice = formatThaiBaht(browseCards.cards[0].bestPrice).replace("฿", "");
    assert.ok(
      browseDone?.spokenText?.includes(exactPrice),
      `fast browse must state exact card #1 price (${exactPrice}), got: ${browseDone?.spokenText}`,
    );
  }
  assert.ok(browseMs < 120, `fast browse must finish in RAM <120ms, got ${browseMs.toFixed(1)}ms`);

  const cheapEvs = [];
  for await (const ev of runNongTeeTurn({
    message: "ขอดูบรีสผงซักฟอกราคาถูกสุด",
    history: [],
    cartItems: [],
    customer: {},
  })) cheapEvs.push(ev);
  const cheapCards = cheapEvs.find((e) => e.type === "cards") as { cards?: Array<{ title: string; bestPrice: string | null }> } | undefined;
  const cheapDone = cheapEvs.find((e) => e.type === "done") as { spokenText?: string } | undefined;
  assert.ok(cheapCards?.cards?.[0]?.title.includes("บรีส"), "sorted fast browse keeps real 'บรีส' products");
  assert.ok(
    cheapDone?.spokenText && cheapDone.spokenText.length <= 110 && cheapDone.spokenText.includes("ถูกสุด") && cheapDone.spokenText.includes("เบอร์ 1"),
    `sorted fast browse speech must be concise (<=110 chars) with ถูกสุด + เบอร์ 1, got (${cheapDone?.spokenText?.length}): ${cheapDone?.spokenText}`,
  );
  if (cheapCards?.cards?.[0]?.bestPrice) {
    const exactCheapPrice = formatThaiBaht(cheapCards.cards[0].bestPrice).replace("฿", "");
    assert.ok(
      cheapDone?.spokenText?.includes(exactCheapPrice),
      `sorted fast browse must state exact card #1 price (${exactCheapPrice}), got: ${cheapDone?.spokenText}`,
    );
  }

  const { cleanBrowseQuery } = await import("../lib/nong-tee.ts");
  assert.equal(cleanBrowseQuery("มีน้ำปลาไม่ใส่ผงชูรสไหมครับ"), "น้ำปลาไม่ใส่ผงชูรส", "cleanBrowseQuery keeps 'ไม่ใส่ผงชูรส' intact");
  assert.equal(cleanBrowseQuery("ขอดูบรีสผงซักฟอกราคาถูกสุด"), "บรีสผงซักฟอก", "cleanBrowseQuery strips sort/prefix cleanly");
  assert.equal(cleanBrowseQuery("อยากได้น้ำมันพืชสักหนึ่งขวด"), "น้ำมันพืช", "cleanBrowseQuery strips 'อยากได้' + vague 'สักหนึ่งขวด'");
  assert.equal(isSimpleBrowseQuery("อยากได้น้ำมันพืชสักหนึ่งขวด", "น้ำมันพืช"), true, "vague 'อยากได้...สักหนึ่งขวด' routes to instant browse");

  // Cooking oil & oyster sauce searches must return real bottles, not canned tuna packed in oil or cat food
  const oilRes = searchProductsDetailed({ q: "น้ำมันพืช", pageSize: 6 });
  assert.ok(oilRes.items.length >= 3, "น้ำมันพืช finds real cooking oil products");
  assert.ok(
    oilRes.items.slice(0, 3).every((it) => !it.nameTh.includes("ในน้ำมันพืช")),
    `น้ำมันพืช top 3 must be real cooking oils, not canned fish in oil: ${oilRes.items.slice(0, 3).map((x) => x.nameTh).join(" | ")}`,
  );
  const oysterRes = searchProductsDetailed({ q: "น้ำมันหอย", pageSize: 4 });
  assert.ok(
    oysterRes.items[0]?.nameTh.includes("หอยนางรม"),
    `น้ำมันหอย top 1 must be oyster sauce, got: ${oysterRes.items[0]?.nameTh}`,
  );

  // Natural orders & cart commands must NEVER be hijacked by fast browse
  for (const orderOrCmd of [
    "เอาโอเล่ 2 ถุง",
    "รับน้ำปลาทิพรส 1 ขวด",
    "ล้างตะกร้า",
    "เก็บเงินปลายทาง",
    "เลือกเบอร์ 2 สองชิ้น",
    // Ambient room chatter observed in live voice-turns.jsonl must NEVER trigger fast browse
    "ให้มันปั้นวายเฟรมขึ้นมาเลย",
    "แล้วมันเสร็จนะ",
    "ถูกต้อง",
    "ใช้",
    "ไปเยี่ยมกัน",
    "อีกทีเลย",
    "มันก็มีของเดิมที่มันมีแฮปวิเวอร์เดิมมันก็มีของมันอยู่ถูกป่ะ",
    "ไม่รู้ค่ะ",
    "มาก",
    "เยอะ",
  ]) {
    assert.equal(isSimpleBrowseQuery(orderOrCmd, "โอเล่"), false, `must not hijack order/chatter as browse: ${orderOrCmd}`);
  }
  // Weak body-only hits must have topStrongMatch === false so chatter never flashes random products
  for (const weak of ["ถูกต้อง", "แล้วมันเสร็จนะ", "ให้มันปั้นวายเฟรมขึ้นมาเลย", "ไปเยี่ยมกัน", "น้ำมันเครื่อง"]) {
    assert.equal(searchProductsDetailed({ q: weak, pageSize: 4 }).topStrongMatch, false, `chatter/missing compound must not be topStrongMatch: ${weak}`);
  }
  for (const strong of ["น้ำปลา", "น้ำมันพืช", "น้ำมันหอย", "บรีสผงซักฟอก", "มาม่า", "เครื่องปั่นไฟ", "คันเท้า", "คันขา", "คันหัว", "ปวดหัว", "ปวดขา", "แสบท้อง"]) {
    assert.equal(searchProductsDetailed({ q: strong, pageSize: 4 }).topStrongMatch, true, `real product/symptom must be topStrongMatch: ${strong}`);
  }
  const genRes = searchProductsDetailed({ q: "เครื่องปั่นไฟ", pageSize: 4 });
  assert.ok(genRes.items[0]?.nameTh.includes("เครื่องกำเนิดไฟฟ้า"), `เครื่องปั่นไฟ must rank เครื่องกำเนิดไฟฟ้า #1, got: ${genRes.items[0]?.nameTh}`);
  const scalpRes = searchProductsDetailed({ q: "คันหัว", pageSize: 4 });
  assert.ok(!scalpRes.items[0]?.nameTh.includes("ช้อน"), `คันหัว must not return spoon, got: ${scalpRes.items[0]?.nameTh}`);
  const footRes = searchProductsDetailed({ q: "คันเท้า", pageSize: 4 });
  assert.ok(/ผื่นคัน|คาลาไมน์|เท้า|โยคี/.test(footRes.items[0]?.nameTh ?? ""), `คันเท้า must return relevant care item #1, got: ${footRes.items[0]?.nameTh}`);

  // Canonical Thai hardware sizes ("4 หุน" / "สี่หุ่น" == "1/2 นิ้ว" != "1-1/2 นิ้ว") + event order ("cards -> stage -> sentence")
  for (const hq of ["ข้องอ 4 หุน", "ข้องอสี่หุ่น"]) {
    const hRes = searchProductsDetailed({ q: hq, pageSize: 6 });
    assert.equal(hRes.topStrongMatch, true, `${hq} must be topStrongMatch`);
    assert.ok(hRes.items.length >= 6, `${hq} must return >= 6 matching 1/2" elbows, got ${hRes.items.length}`);
    for (const it of hRes.items) {
      assert.ok(
        it.nameTh.includes("ข้องอ") && /(?:^|[^\d-])1\/2(?:[^\d]|$)|4\s*หุน/.test(it.nameTh) && !/1-1\/2|1\s+1\/2|1\.1\/2/.test(it.nameTh),
        `${hq} top-6 must be 1/2" (4 หุน) elbow only, got: ${it.nameTh}`,
      );
    }
  }
  const h6Res = searchProductsDetailed({ q: "ข้องอ 6 หุน", pageSize: 4 });
  assert.ok(h6Res.items[0]?.nameTh.includes("ข้องอ") && /3\/4|6\s*หุน/.test(h6Res.items[0]?.nameTh ?? ""), `ข้องอ 6 หุน #1 must be 3/4", got: ${h6Res.items[0]?.nameTh}`);
  const h15Res = searchProductsDetailed({ q: "ข้องอ 1-1/2 นิ้ว", pageSize: 4 });
  assert.ok(/1-1\/2|1\s+1\/2|1\.1\/2/.test(h15Res.items[0]?.nameTh ?? ""), `ข้องอ 1-1/2 นิ้ว #1 must be 1-1/2", got: ${h15Res.items[0]?.nameTh}`);

  const seqEvs: string[] = [];
  for await (const ev of runNongTeeTurn({
    message: "ข้องอสี่หุ่น",
    history: [],
    cartItems: [],
    customer: {},
    focusSlugs: [],
  })) {
    seqEvs.push(ev.type);
  }
  const idxCards = seqEvs.indexOf("cards");
  const idxStage = seqEvs.indexOf("stage");
  const idxSentence = seqEvs.indexOf("sentence");
  assert.ok(idxCards >= 0 && idxStage > idxCards && idxSentence > idxStage, `cards -> stage -> sentence order required, got: ${seqEvs.join(",")}`);
  // Natural polite numbered orders + ordinal aliases ("ตัวแรก", "ตัวสุดท้าย", "ได้ไหมครับ")
  assert.deepEqual(parseNumberedOrder("เอาเบอร์ 1 สองขวดได้ไหมครับ", 6), [{ no: 1, qty: 2, afterQty: "ขวด" }]);
  assert.deepEqual(parseNumberedOrder("เลือกเบอร์ 2 สามชิ้น", 6), [{ no: 2, qty: 3, afterQty: "ชิ้น" }]);
  assert.deepEqual(parseNumberedOrder("เอาตัวแรก 2 ชิ้น", 6), [{ no: 1, qty: 2, afterQty: "ชิ้น" }]);
  assert.deepEqual(parseNumberedOrder("เอาตัวสุดท้าย 1 แพ็ค", 6), [{ no: 6, qty: 1, afterQty: "แพ็ค" }]);

  // Direct 0-LLM deterministic cart edits (update / remove / clear)
  if (pool.length >= 2) {
    const sampleCart = recalculateCart([{ slug: pool[0].slug, qty: 2, unitCode: pool[0].unitCode }]).items;
    const runCartCmd = async (msg: string) => {
      const evs = [];
      for await (const ev of runNongTeeTurn({
        message: msg,
        history: [],
        cartItems: sampleCart,
        customer: {},
        focusSlugs: [pool[0].slug, pool[1].slug],
      })) evs.push(ev);
      return evs;
    };
    const updEv = await runCartCmd("เปลี่ยนเป็น 5");
    const updCart = updEv.find((e) => e.type === "cart") as { cart: { items: Array<{ qty: number }> } } | undefined;
    assert.equal(updCart?.cart.items[0]?.qty, 5, "direct 0-LLM cart update changes single-item qty to 5");

    const rmEv = await runCartCmd("ลบเบอร์ 1 ออก");
    const rmCart = rmEv.find((e) => e.type === "cart") as { cart: { items: unknown[] } } | undefined;
    assert.equal(rmCart?.cart.items.length, 0, "direct 0-LLM cart remove deletes item #1");

    const clrEv = await runCartCmd("น้องตี๋ ช่วยล้างตะกร้าหน่อยครับ");
    const clrCart = clrEv.find((e) => e.type === "cart") as { cart: { items: unknown[] } } | undefined;
    assert.equal(clrCart?.cart.items.length, 0, "direct 0-LLM cart clear empties cart even with polite prefix");

    const clrAllEv = await runCartCmd("ลบออกให้หมดเลย");
    const clrAllCart = clrAllEv.find((e) => e.type === "cart") as { cart: { items: unknown[] } } | undefined;
    const clrAllDone = clrAllEv.find((e) => e.type === "done") as { model?: string } | undefined;
    assert.equal(clrAllCart?.cart.items.length, 0, "direct 0-LLM clear handles 'ลบออกให้หมดเลย'");
    assert.equal(clrAllDone?.model, "คำสั่งตรง (ไม่ใช้ AI)", "'ลบออกให้หมดเลย' executes without LLM");
  }

  // Voice log PII masking + Local LLM defaults + Ollama wire converter + Dev log persistence
  const { appendLlmDevLog, maskPii, readRecentLlmDevLogs } = await import("../lib/voice-log.ts");
  assert.ok(!maskPii("เบอร์ 089-123-4567 ครับ").includes("123-45"), "maskPii redacts Thai phone numbers");
  const { LOCKED_FLASH_MODEL, PRIMARY_LOCAL_MODEL, toOllamaMessages } = await import("../lib/nong-tee.ts");
  assert.equal(cleanBrowseQuery("มีไม้จิ้มฟันหรือเปล่า"), "ไม้จิ้มฟัน", "cleanBrowseQuery strips trailing หรือเปล่า");
  assert.equal(PRIMARY_LOCAL_MODEL, process.env.LOCAL_LLM_MODEL?.trim() || "gemma4:12b", "primary local model defaults to gemma4:12b");
  assert.equal(LOCKED_FLASH_MODEL, "deepseek-flash", "fallback model remains deepseek-flash");
  const converted = toOllamaMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "cart_add", arguments: '{"identifier":"P001","qty":3}' } }],
    },
    { role: "tool", tool_call_id: "tc-1", content: "ok" },
  ]);
  assert.deepEqual(converted[2]?.tool_calls, [{ function: { name: "cart_add", arguments: { identifier: "P001", qty: 3 } } }]);
  assert.deepEqual(converted[3], { role: "tool", tool_name: "cart_add", content: "ok" });
  appendLlmDevLog({
    phase: "chat_round",
    provider: "local",
    model: PRIMARY_LOCAL_MODEL,
    ms: 12,
    query: "ทดสอบโทร 081-234-5678",
    ok: true,
  });
  const devRows = readRecentLlmDevLogs(5);
  assert.ok(devRows.some((r) => r.query?.includes("081XXXX78") && !r.query?.includes("234-56")), "llm-dev log persists & masks Thai phone PII");

  // Spoken-Thai TTS expansion (units, dimensions, slashes, reduplication ๆ)
  const { toSpokenThai } = await import("../lib/spoken-thai.ts");
  assert.equal(toSpokenThai("500 ก. 159 บาท/กล่อง"), "500 กรัม 159 บาทต่อกล่อง");
  assert.equal(toSpokenThai("625 มล. 40x60 ซม. สีขาว/สัก/โอ๊ค"), "625 มิลลิลิตร 40 คูณ 60 เซนติเมตร สีขาว หรือ สัก หรือ โอ๊ค");
  assert.equal(toSpokenThai("180 ml 1 kg 2 L"), "180 มิลลิลิตร 1 กิโลกรัม 2 ลิตร");
  assert.equal(toSpokenThai("ยังไม่เจอตรงๆ ครับ"), "ยังไม่พบตรง ตรง ครับ");
  assert.equal(toSpokenThai("เจอ น้ำมันพืช แล้วครับ"), "พบ น้ำมันพืช แล้วครับ");
  assert.equal(toSpokenThai("หาเจอแล้วครับ"), "พบแล้วครับ");
  assert.equal(toSpokenThai("โอเลย์ เนเจอรัล ไวท์ นมสดพาสเจอไรซ์ เจอรี่ มอยส์เจอไรเซอร์"), "โอเลย์ เนเจอรัล ไวท์ นมสดพาสเจอไรซ์ เจอรี่ มอยส์เจอไรเซอร์");

  // Server-side & cross-tab echo guard (normalizes numbers + strips bot prefix before customer cut-in)
  const { stripBotEcho } = await import("../lib/echo-guard.ts");
  const recentSample = [
    "สวัสดีครับ ผมน้องตี๋ เลขาช่วยหาสินค้าและรับออเดอร์ครับ อยากดูสินค้าตัวไหน พูดหรือพิมพ์บอกตี๋ได้เลยนะครับ",
    "มีครับ เบอร์ 8 แม่เหรียญ น้ำปลาร้า 6 ขวด 141 บาท เฉลี่ยขวดละ 23.50 รับกี่แพ็คครับ",
    "ได้ครับ เบอร์ 1 สบู่รำข้าว อภัยภูเบศร์ ก้อนละ 35 บาท รับกี่ก้อนดีครับ",
    "เบอร์ 1 มาโซล่า น้ำมันข้าวโพด 149 บาทต่อขวด รับเบอร์ไหนดีครับ",
  ];
  assert.equal(
    stripBotEcho("ผมน้องตีเลข่าวช่วยหาสินค้าและรับออเดอร์ครับอยากสินค้าตัวไหนพูดหรือพิมพ์บอกตีได้เลยนะครับ", recentSample).wasEcho,
    true,
    "whole greeting echo is dropped",
  );
  assert.equal(
    stripBotEcho("มีครับเบอร์ แปดแม่เหรียญน้ำปลาร้าหกขวดหนึ่งร้อยสี่สิบเอ็ดบาท เฉลี่ยขวดละยี่สิบสามจุดห้าศูนย์ รับกี่แพ็คครับ", recentSample).wasEcho,
    true,
    "whole numeric echo (141 -> หนึ่งร้อยสี่สิบเอ็ด) is dropped",
  );
  assert.deepEqual(
    stripBotEcho("ได้ครับเบอร์หนึ่งสบู่รำข้าวอภัยภูเบศก้อนละสามสิบห้าบาทรับกี่ก้อนดีครับผักกาดขาว", recentSample),
    { text: "ผักกาดขาว", wasEcho: false, stripped: true },
    "strips bot echo prefix and preserves customer cut-in word ผักกาดขาว",
  );
  assert.deepEqual(
    stripBotEcho("เบอร์หนึ่งมาโซล่าน้ำมันข้าวโพดหนึ่งร้อยสี่สิบเก้าบาทต่อขวดรับเบอร์ไหนดีครับโค้ก", recentSample),
    { text: "โค้ก", wasEcho: false, stripped: true },
    "strips bot echo prefix and preserves customer cut-in word โค้ก",
  );
  assert.deepEqual(
    stripBotEcho("เอาเบอร์ 1 สองขวดครับ", recentSample),
    { text: "เอาเบอร์ 1 สองขวดครับ", wasEcho: false, stripped: false },
    "never drops real customer order",
  );

  // Zero-latency micro-noise filter (BGE-M3 gate removed: all real speech passes straight to gemma4:12b)
  const { parseScreenCommand: parseCmdGate } = await import("../lib/voice-commands.ts");
  assert.equal(parseCmdGate("ปิดไมค์ก่อน")?.id, "mic_off", "mic_off accepts trailing ก่อน");
  const { classifyVoiceIntent } = await import("../lib/voice-gate.ts");
  for (const [text, ctx] of [
    ["เอาเบอร์ 4 สามชิ้น", { hasFocus: true }],
    ["ลบออกให้หมดเลย", { hasFocus: true }],
    ["ปิดไมค์ก่อน", {}],
    ["อยากได้น้ำมันพืชสักหนึ่งขวด", {}],
    ["ตอนนี้คันหัวมาก", {}],
    ["ปวดหัวมากเลย", {}],
    ["แสบท้อง", {}],
    ["หาสว่านไฟฟ้าให้หน่อย", {}],
    ["ออกเลยครับ", {}],
    ["วันนี้อากาศร้อนมากเลยนะ", {}],
    ["3", { pendingQty: true }],
    ["หยุด", {}],
  ] as const) {
    const g = await classifyVoiceIntent(text, ctx);
    assert.equal(g.allow, true, `voice-gate must direct_pass "${text}", got ${JSON.stringify(g)}`);
    assert.equal(g.reason, "direct_pass");
  }
  for (const [noise, expectedReason] of [
    ["", "empty"],
    ["   ", "empty"],
    ["...", "empty"],
    ["เอ่อ", "noise"],
    ["อืม...", "noise"],
  ] as const) {
    const g = await classifyVoiceIntent(noise, { hasFocus: true });
    assert.equal(g.allow, false, `voice-gate must drop "${noise}"`);
    assert.equal(g.reason, expectedReason);
  }
}

// ---------- Hands-free screen control: whole-sentence commands only, everything else goes to the AI ----------
{
  const { parseScreenCommand: cmd } = await import("../lib/voice-commands.ts");
  const id = (t: string, modalOpen = false) => cmd(t, { modalOpen })?.id ?? null;
  for (const [t, want] of [
    ["ถอยกลับไป", "back"], ["หน้าที่แล้ว", "back"], ["น้องตี๋ช่วยย้อนกลับหน่อยครับ", "back"],
    ["เดินหน้า", "forward"], ["หน้าถัดไป", "forward"], ["กลับหน้าแรก", "home"],
    ["ดูเบอร์ 3", "open_no"], ["ตัวถัดไป", "next_item"], ["ดูตระกร้า", "cart"], ["เช็คบิล", "checkout"],
    ["เปิดกล้อง", "camera"], ["เลื่อนลง", "scroll_down"], ["หยุด", "stop_talk"], ["พูดอีกที", "repeat"],
    ["ปิดไมค์", "mic_off"], ["สั่งอะไรได้บ้าง", "help"],
  ] as const) assert.equal(id(t), want, t);
  assert.deepEqual(cmd("ย้อนกลับสองหน้าครับ"), { id: "back", no: 2 });
  assert.deepEqual(cmd("ขยายเบอร์ 12 ให้ดูหน่อย"), { id: "open_no", no: 12 });
  // "ขอดูรายละเอียด" must open the card the customer said, never an AI guess
  assert.deepEqual(cmd("ขอดูรายละเอียดเบอร์ 8"), { id: "open_no", no: 8 });
  assert.deepEqual(cmd("ดูรายละเอียดเบอร์สามครับ"), { id: "open_no", no: 3 });
  assert.deepEqual(cmd("ขอดูข้อมูลอันที่สอง"), { id: "open_no", no: 2 });
  assert.deepEqual(cmd("อยากดูตะกร้า"), { id: "cart" });
  assert.deepEqual(cmd("งั้นคิดเงินเลยครับ"), { id: "checkout" });
  assert.deepEqual(cmd("อยากกลับหน้าแรก"), { id: "home" });
  assert.deepEqual(cmd("เลือกดูเบอร์ 3"), { id: "open_no", no: 3 });
  assert.deepEqual(cmd("ดูตัวแรกหน่อย"), { id: "open_no", no: 1 });
  assert.deepEqual(cmd("น้องตี๋ครับช่วยเปิดดูรายละเอียดเบอร์สามให้หน่อยนะครับ"), { id: "open_no", no: 3 });
  assert.deepEqual(cmd("ขอดูรายละเอียดหน่อย"), { id: "details" });
  assert.equal(cmd("รายละเอียดน้ำปลา"), null);
  // Demo fun zone: every game is reachable by voice
  for (const [t, want] of [
    ["หมุนวงล้อ", "spin"], ["หมุนอีกรอบ", "spin"], ["ลุ้นโชคครับ", "spin"],
    ["ลองเล่น", "play"], ["มีภารกิจอะไรบ้าง", "play"], ["ซ่อนภารกิจ", "play_off"],
    ["ดูของที่เกี่ยวข้อง", "related"], ["มีอะไรใกล้เคียงอีกไหม", "related"],
    ["เอาด้วย", "take_suggest"], ["ใส่ตัวที่แนะนำครับ", "take_suggest"], ["เอาตัวนั้นด้วยเลย", "take_suggest"],
  ] as const) assert.equal(id(t), want, t);
  assert.deepEqual(cmd("เทียบเบอร์ 2 กับ 5"), { id: "duel", no: 2, no2: 5 });
  assert.deepEqual(cmd("ดวลเบอร์หนึ่งกับเบอร์สามอันไหนคุ้มกว่า"), { id: "duel", no: 1, no2: 3 });
  assert.equal(cmd("เทียบเบอร์ 2 กับ 2"), null);
  assert.equal(cmd("น้ำปลาใกล้เคียง"), null);
  const { parseBudget } = await import("../lib/voice-commands.ts");
  const { parseThaiNumber: thaiNum } = await import("../lib/numbered-order.ts");
  for (const [t, want] of [
    ["งบ 500 บาท", "500"], ["ตั้งงบห้าร้อยบาทครับ", "500"], ["มีงบ 1,500", "1500"],
    ["งบไม่เกินสองพันบาท", "2000"], ["ยกเลิกงบ", "0"], ["น้ำปลาขวดละเท่าไหร่", null],
  ] as const) assert.equal(parseBudget(t, thaiNum), want, t);

  // TTS says units in full, only after a number; brand dots / sizes stay as they are
  const { toSpokenThai } = await import("../lib/spoken-thai.ts");
  for (const [t, want] of [
    ["ปลากระป๋อง 155 ก. x 10 ราคา 275 บาท", "ปลากระป๋อง 155 กรัม แพ็ค 10 ราคา 275 บาท"],
    ["น้ำจิ้มไก่ 1 กก.", "น้ำจิ้มไก่ 1 กิโลกรัม"],
    ["นมถั่วเหลือง 300 มล. x 24", "นมถั่วเหลือง 300 มิลลิลิตร แพ็ค 24"],
    ["อสร. น้ำส้มสายชู 5% 5 ล.", "อสร. น้ำส้มสายชู 5% 5 ลิตร"],
    ["ดอนเมือง กม.26 แหนม 60 ก.", "ดอนเมือง กม.26 แหนม 60 กรัม"],
    ["ก.ย. 15 โลชั่น 50 มล.", "ก.ย. 15 โลชั่น 50 มิลลิลิตร"],
    ["น้ำยาถูพื้น 600 มล. x 3+1", "น้ำยาถูพื้น 600 มิลลิลิตร แพ็ค 3 แถม 1"],
    ["ขนาด 1.5 ก.ก. ยาว 20 ซม.", "ขนาด 1.5 กิโลกรัม ยาว 20 เซนติเมตร"],
    ["ถุงขยะ 18x20 นิ้ว", "ถุงขยะ 18 คูณ 20 นิ้ว"],
    ["ของแห้ง ฯลฯ", "ของแห้ง และอื่น อื่น"],
  ] as const) assert.equal(toSpokenThai(t), want, t);

  // Coupons: Decimal discount, minSpend, cap, idempotent, never below ฿0, spoken commands
  const promo = await import("../lib/promotions.ts");
  const base = { subtotal: "1234.55", grandTotal: "1234.55", grandTotalFormatted: "฿1,234.55" };
  const d10 = promo.applyCoupon(base, "demo10");
  assert.equal(d10.discount, "123.46", "10% HALF_UP once");
  assert.equal(d10.grandTotal, "1111.09");
  assert.equal(promo.applyCoupon(d10, "DEMO10").grandTotal, "1111.09", "re-applying does not stack");
  assert.equal(promo.applyCoupon({ ...base, subtotal: "5000.00" }, "DEMO10").discount, "200.00", "cap 200");
  const s50 = promo.applyCoupon({ ...base, subtotal: "499.99" }, "SAVE50");
  assert.equal(s50.coupon?.applied, false);
  assert.equal(s50.grandTotal, "499.99");
  assert.match(s50.coupon?.note ?? "", /0\.01/);
  assert.equal(promo.applyCoupon({ ...base, subtotal: "500.00" }, "SAVE50").grandTotal, "450.00");
  assert.equal(promo.applyCoupon(base, "NOPE").discount, "0.00");
  assert.equal(promo.bestPromotion("3500.00").code, "BIG300");
  assert.equal(promo.bestPromotion("100.00").code, "DEMO10");
  assert.deepEqual(promo.parseCouponCommand("ใช้คูปองหน่อยครับ"), { action: "apply", code: null });
  assert.deepEqual(promo.parseCouponCommand("ขอใช้คูปอง SAVE50"), { action: "apply", code: "SAVE50" });
  assert.deepEqual(promo.parseCouponCommand("ใช้โค้ดสิบเปอร์เซ็นต์"), { action: "apply", code: "DEMO10" });
  assert.deepEqual(promo.parseCouponCommand("ยกเลิกคูปอง"), { action: "remove" });
  assert.deepEqual(promo.parseCouponCommand("วันนี้มีโปรอะไรบ้าง"), { action: "list" });
  assert.equal(promo.parseCouponCommand("ขอดูโปรตีนบาร์"), null, "โปรตีน is a product");
  assert.equal(id("ปิด"), null, "bare close only when a popup is open");
  assert.equal(id("ปิด", true), "close");
  for (const t of ["เอาเบอร์ 3", "เอาเบอร์ 5 10 ชิ้น", "เบอร์ 3 ราคาเท่าไหร่", "กลับไปดูน้ำปลา", "ลบเบอร์ 2 ออกจากตะกร้า", "ขอดูบะหมี่"])
    assert.equal(id(t), null, `not a screen command: ${t}`);
}

// ---------- Misheard words are snapped to the system's spelling before anything decides ----------
{
  const { soundKey, fixHeard, buildHeardVocab, startsWithUnitSound } = await import("../lib/heard-fix.ts");
  const { heardVocab } = await import("../lib/vault.ts");
  for (const [a, b] of [
    ["ซันไลต์", "สันไลด์"],
    ["แปรง", "แปลง"],
    ["ปิดไมค์", "ปิดใหม่"],
    ["คลาสสิค", "คลาสสิก"],
    ["โหล", "โล"],
    ["ลักษณ์", "ลักส์"],
    ["มิตรผล", "มิดผล"],
    ["จอห์นสัน", "จรสรร"],
    ["พอนด์ส", "พรส"],
  ])
    assert.equal(soundKey(a), soundKey(b), `${a} and ${b} are said the same way`);
  assert.notEqual(soundKey("ขวด"), soundKey("ขาด"));

  // Commands: fixed only when the result is something the system acts on.
  assert.equal(fixHeard("ปิดใหม่"), "ปิดไมค์");
  assert.equal(fixHeard("หอยกลับไป"), "ถอยกลับไป");
  assert.equal(fixHeard("หอยหลัง"), "ถอยหลัง");
  assert.equal(fixHeard("ดูดตะกร้า"), "ดูตะกร้า");
  assert.equal(fixHeard("check build"), "เช็คบิล");
  assert.equal(fixHeard("เช็คดิวเลย"), "เช็คบิลเลย");
  assert.equal(fixHeard("ไปนะละหลัก"), "ไปหน้าหลัก", "leading ห in หน้าหลัก must not be duplicated");
  assert.equal(fixHeard("ด่วนเบอร์หนึ่งกับสาม"), "ดวลเบอร์หนึ่งกับสาม", "the silent letter of เบอร์ is not cut off");
  assert.equal(fixHeard("ปิดกล้องปิดกล้อง"), "ปิดกล้อง", "a sentence written twice is said once");
  assert.equal(fixHeard("เอาเบอร์ห้าหนึ่งรัง"), "เอาเบอร์ห้าหนึ่งลัง");
  assert.equal(fixHeard("เอาเวิร์สสี่สามชิ้น"), "เอาเบอร์สี่สามชิ้น", "fixes misheard เวิร์ส -> เบอร์ before number");
  assert.equal(fixHeard("ดูเวอร์สอง"), "ดูเบอร์สอง", "fixes misheard เวอร์ -> เบอร์ in screen command");
  const { parseNumberedOrder: parseNumAfterFix } = await import("../lib/numbered-order.ts");
  assert.deepEqual(parseNumAfterFix(fixHeard("เอาเวิร์สสี่สามชิ้น"), 6), [{ no: 4, qty: 3, afterQty: "ชิ้น" }]);
  for (const t of ["ดูตะกร้า", "เอาเบอร์สามสองชิ้น", "งบห้าร้อยบาท", "ขอบคุณครับ", "ราคาเท่าไหร่ครับ", "เอาไว้ก่อนครับ"])
    assert.equal(fixHeard(t), t, `heard right, left alone: ${t}`);

  // Brand and product words, on a tiny catalogue so the rules are tested, not today's data.
  const v = buildHeardVocab([
    { nameTh: "บรีส เอกเซล ผงซักฟอก", nameEn: "BREEZE Excel Detergent", brandTh: "บรีส", brandEn: "Breeze" },
    { nameTh: "บรีส เอกเซล น้ำยาซักผ้า", nameEn: "BREEZE Excel Liquid", brandTh: "บรีส", brandEn: "Breeze" },
    { nameTh: "บรีส เอกเซล ซิกเนเจอร์", nameEn: "BREEZE Excel Signature", brandTh: "บรีส", brandEn: "Breeze" },
    { nameTh: "เลย์ คลาสสิค มันฝรั่งทอด", brandTh: "เลย์", brandEn: "Lay's" },
    { nameTh: "โอเค คลาสสิก ขนมปัง", brandTh: "โอเค", brandEn: "" },
    { nameTh: "เบบี้ มายด์ สบู่เหลว เบบี้", brandTh: "เบบี้ มายด์", brandEn: "Babi Mild" },
    { nameTh: "ดาร์ลี่ ยาสีฟัน สูตรใหม่", brandTh: "ดาร์ลี่", brandEn: "Darlie" },
    { nameTh: "ซิสเท็มมา แปรงสีฟัน+ยาสีฟัน สูตร", brandTh: "ซิสเท็มมา", brandEn: "Systema" },
    { nameTh: "ซิสเท็มมา แปรงสีฟัน ขนนุ่ม", brandTh: "ซิสเท็มมา", brandEn: "Systema" },
    { nameTh: "ดาร์ลี่ แปรงสีฟัน เด็ก", brandTh: "ดาร์ลี่", brandEn: "Darlie" },
    { nameTh: "ดาร์ลี่ แปรงสีฟัน ผู้ใหญ่", brandTh: "ดาร์ลี่", brandEn: "Darlie" },
    { nameTh: "ฮีโร่ แปรงสีฟัน กล่อง", brandTh: "ฮีโร่", brandEn: "Hero" },
    { nameTh: "ดีโด้ น้ำสตรอเบอร์รี่", brandTh: "ดีโด้", brandEn: "Deedo" },
    { nameTh: "ลักส์ สบู่ก้อน", brandTh: "ลักส์", brandEn: "Lux" },
    { nameTh: "พอนด์ส บีบี", brandTh: "พอนด์ส", brandEn: "Pond's" },
    { nameTh: "พีเอสฟู้ดส์ หมูบด", brandTh: "พีเอสฟู้ดส์", brandEn: "PS FOOD" },
    { nameTh: "โฟร์โมสต์ นมยูเอชที", brandTh: "โฟร์โมสต์", brandEn: "FOREMOST" },
    { nameTh: "เดอะ สกิน คอลเล็คชัน เซรั่ม", brandTh: "เดอะ สกิน คอลเล็คชัน", brandEn: "The Skin Collection" },
    { nameTh: "คอเรค กระดาษเช็ดหน้า", brandTh: "คอเรค", brandEn: "Correct" },
    { nameTh: "บิวตี้ บุฟเฟต์ กาแฟลดสัดส่วน", brandTh: "บิวตี้ บุฟเฟต์", brandEn: "Beauty Buffet" },
    { nameTh: "เนสกาแฟ กาแฟ พร้อมดื่ม", brandTh: "เนสกาแฟ", brandEn: "Nescafe" },
  ]);
  assert.equal(fixHeard("ขอดูบริสผงซักฟอก", v), "ขอดูบรีสผงซักฟอก");
  assert.equal(fixHeard("ขอดูแปลงสีฟัน", v), "ขอดูแปรงสีฟัน", "three real words that are one common catalogue word");
  assert.equal(fixHeard("ขอดูมันฝลั่งทอด", v), "ขอดูมันฝรั่งทอด", "not a Thai word: snapped to the catalogue word it sounds like");
  assert.equal(fixHeard("ขอดูเลยคลาสสิก", v), "ขอดูเลย์ คลาสสิค", "short real words that add up to a brand");
  assert.equal(fixHeard("ขอดู Breeze", v), "ขอดู บรีส", "brand heard in English");
  assert.equal(fixHeard("ขอดู PS Foods หมูบด", v), "ขอดู พีเอสฟู้ดส์ หมูบด", "plural -s on English brand");
  assert.equal(fixHeard("ขอดู Formos นม UHT", v), "ขอดู โฟร์โมสต์ นม UHT", "phonetic-loose English brand");
  assert.equal(fixHeard("ขอดู brief Excel", v), "ขอดู บรีส เอกเซล", "misheard English brand before unique product line");
  assert.equal(fixHeard("ขอดูดิโดน้ำสตรอเบอรี่", v), "ขอดูดีโด้ น้ำสตรอเบอร์รี่", "everyday prefix fused by segmenter (ดูดิ) still allows brand");
  assert.equal(fixHeard("ขอดูลักษณ์สบู่ก้อน", v), "ขอดูลักส์ สบู่ก้อน", "two-consonant silent cluster ษณ์");
  assert.equal(fixHeard("ขอดูพรสบีบี", v), "ขอดูพอนด์ส บีบี", "unwritten ออ before final ร + glued consonant prefix");
  assert.equal(fixHeard("ขอดูเดอะสกินคอเล็กชัน", v), "ขอดูเดอะ สกิน คอลเล็คชัน", "geminate N before ล wins over short คอเรค");
  assert.equal(fixHeard("ขอดูบิวตี้บุฟเฟตกาแฟรถสัดส่วน", v), "ขอดูบิวตี้ บุฟเฟต์กาแฟลดสัดส่วน", "dropped silent mark on brand + glued ตกาแฟ");
  for (const t of [
    "มีสบู่เหลวเบบี้ไหมครับ", // "เบบี้ไหม" must not become "เบบี้ มายด์"
    "มียาสีฟันสูตรไหมครับ", // nor "สูตรไหม" -> "สูตรใหม่"
    "ขอดูแปรงสีฟัน+ยาสีฟัน", // punctuation stays
    "ขอดูโอเค คลาสสิก ขนมปัง", // another product really spells it "คลาสสิก"
    "ขอดูดาร์ลี่ ยาสีฟัน",
    "กล้องไม่ติดครับ", // a real Thai word is not bent into "กล่อง"
    "กรองน้ำให้หน่อย",
  ])
    assert.equal(fixHeard(t, v), t, `heard right, left alone: ${t}`);

  // Units are matched by sound only against the units one product is sold in.
  assert.ok(startsWithUnitSound("โลครับ", "โหล") && startsWithUnitSound("รัง เบอร์สามสองชิ้น", "ลัง"));
  assert.ok(!startsWithUnitSound("โลชั่น", "โหล") && !startsWithUnitSound("ขวด", "โหล") && !startsWithUnitSound("ชิ้น", ""));

  // Real brain: names spelled the catalogue's way must come back unchanged.
  const vocab = heardVocab();
  const thaiWords = (name: string) => name.split(/\s+/).filter((w) => /^[ก-๙]+$/.test(w)).slice(0, 3);
  const sample = searchProductsDetailed({ q: "", pageSize: 60 })
    .items.filter((p) => thaiWords(p.nameTh).length)
    .map((p) => "ขอดู" + thaiWords(p.nameTh).join(" "));
  const changed = sample.filter((s) => fixHeard(s, vocab).replace(/\s+/g, "") !== s.replace(/\s+/g, ""));
  assert.ok(sample.length >= 30 && changed.length <= 1, `catalogue names left alone (${changed.length}/${sample.length} changed: ${changed.join(" | ")})`);
  assert.equal(fixHeard("ขอดู Roll On", vocab), "ขอดู Roll On", "an English phrase is not a brand one letter away");
  // Real brain: new rules verified end-to-end without breaking similar everyday phrases.
  for (const [heard, mustContain] of [
    ["ขอดูไฮยีน expert wash", "เอ็กซ์เพิร์ทวอช"],
    ["ขอดู area soft and safe", "ลอรีเอะ ซอฟท์แอนด์เซฟ"],
    ["ขอดูโพรเทคสบู่ก้อน", "โพรเทคส์ สบู่ก้อน"],
    ["ขอดูคอมฟอร์ตน้ำยาปรับผ้านุ่ม", "คอมฟอร์ท น้ำยาปรับผ้านุ่ม"],
    ["ขอดูจรสรรเบบี้", "จอห์นสัน เบบี้"],
    ["ขอดูมิดผลน้ำตาลทรายขาวบริสุทธิ์", "มิตรผล น้ำตาลทรายขาวบริสุทธิ์"],
    ["ขอดูคนนอผงปรุงเดมิเกลส์", "คนอร์"],
    ["ขอดูกันนิเยครีมเปลี่ยนสีผม", "การ์นิเย่"],
    ["ขอดูสไลด์น้ำยาล้างจาน", "ซันไลต์"],
    ["ขอดูทองกระเด้นถั่วลิสงบเกลือ", "ทองการ์เด้น"],
    ["ขอดูครูมะ", "คุมะ"],
    ["ขอดูอาเลารี่เนยแท้", "อลาวรี่"],
    ["ขอดูอาเจ็ด", "อาท เจ็ท"],
    ["ขอดูเพศสัตว์แป้งเย็นมาดาม", "เภสัช"],
    ["ขอดูปลาชูหน้า", "ปลาทูน่า"],
    ["ขอดูโก้แก่ถั่วลิสงบเกลือ", "ถั่วลิสงอบเกลือ"],
    ["ขอดูเอโรโกขนมปังแซนวิชโฮวีดเนื้อละเอียด", "แซนด์วิชโฮลวีท"],
    ["ขอดูเบสฟู้ดสเปรย์สตรอเบอรี่", "สเปรด"],
    ["ขอดูดัชมิลนมพาสเตอร์ไรส์", "พาสเจอร์ไรซ์"],
    ["ขอดู BMP ไบคอนแผ่นสั้น", "เบคอน"],
  ] as const) {
    assert.ok(fixHeard(heard, vocab).includes(mustContain), `${heard} -> expected "${mustContain}", got "${fixHeard(heard, vocab)}"`);
  }
  assert.equal(fixHeard("ข้องอสี่หุ่น", vocab), "ข้องอ 4 หุน", "normalize spoken Thai 4 หุน");
  assert.equal(fixHeard("ท่อหกหุ่น", vocab), "ท่อ 6 หุน", "normalize spoken Thai 6 หุน");
  assert.equal(fixHeard("ข้องอเก้าสิบองศา", vocab), "ข้องอ 90 องศา", "normalize spoken Thai 90 degree");
  assert.equal(fixHeard("หุ่นยนต์", vocab), "หุ่นยนต์", "do not touch real word หุ่นยนต์");
  assert.equal(fixHeard("หาสว่างไฟฟ้าให้หน่อย", vocab), "หาสว่านไฟฟ้าให้หน่อย", "fix misheard สว่างไฟฟ้า -> สว่านไฟฟ้า");
  assert.equal(fixHeard("สว่างไฟฟ้า", vocab), "สว่านไฟฟ้า", "fix bare สว่างไฟฟ้า -> สว่านไฟฟ้า");
  assert.equal(fixHeard("ไฟสว่างมาก", vocab), "ไฟสว่างมาก", "leave ไฟสว่างมาก untouched");
  assert.equal(fixHeard("ก็ได้อาจชำระ", vocab), "กระดาษชำระ", "fix misheard ก็ได้อาจชำระ -> กระดาษชำระ");
  assert.equal(fixHeard("ขอดูน้ำจิ้มไก่ไม่ใส่ผงชูโรส", vocab), "ขอดูน้ำจิ้มไก่ไม่ใส่ผงชูรส", "fix ผงชูโรส -> ผงชูรส");
  assert.equal(fixHeard("แชมพูขจัดรังแคร์แก้คันศรีษะ", vocab), "แชมพูขจัดรังแคแก้คันศีรษะ", "fix รังแคร์/ศรีษะ");
  assert.equal(fixHeard("ขอดูข้องออสี่หุ่นหน่อยครับ", vocab), "ขอดูข้องอ 4 หุน หน่อยครับ", "fix ข้องออสี่หุ่น -> ข้องอ 4 หุน");

  const { chooseBestHeard } = await import("../lib/heard-fix.ts");
  const { cleanBrowseQuery } = await import("../lib/nong-tee.ts");
  const dualScore = (q: string) => {
    const s = cleanBrowseQuery(q);
    const r = searchProductsDetailed({ q: s.length >= 2 ? s : q, pageSize: 3 });
    return { strong: Boolean(r.topStrongMatch && r.items.length > 0), total: r.total };
  };
  const digitGuard = chooseBestHeard("รับเบอร์หกสองชิ้น", "รับเบอร์ 62 ชิ้น", vocab, dualScore);
  assert.equal(digitGuard.picked, "ear1", "keep Ear 1 when Ear 2 fuses spoken digits");
  assert.equal(digitGuard.text, "รับเบอร์หกสองชิ้น");
  assert.equal(digitGuard.altText, "", "drop misleading fused digits from altText");

  const ear2Win = chooseBestHeard("มีเอสเซลล์พงสักฟอก", "บรีสเอกเซลผงซักฟอก", vocab, dualScore);
  assert.equal(ear2Win.picked, "ear2", "pick Ear 2 when Ear 2 matches catalog brand strongly");
  assert.equal(ear2Win.text, "บรีสเอกเซลผงซักฟอก");
  assert.equal(ear2Win.altText, "มีเอสเซลล์ผงซักฟอก");

  const ear2StrongOnly = chooseBestHeard("ปันไฟถูกสุดหน่อย", "เครื่องปั่นไฟ", vocab, dualScore);
  assert.equal(ear2StrongOnly.picked, "ear2", "pick Ear 2 when Ear 1 has no strong match and Ear 2 is strong");
  assert.equal(ear2StrongOnly.text, "เครื่องปั่นไฟ");

  // Everyday Thai and non-target products must stay untouched.
  for (const t of [
    "ขอดูขนมขบเคี้ยว",
    "กรุณาเลือกสินค้าก่อนครับ",
    "ลำโพงเสียงเบาไปหน่อย",
    "คราวหน้าจะมาสั่งใหม่นะครับ",
    "ซื้อเพิ่มอีกนิดได้ลดเยอะๆ",
    "กลุ่มผู้ใช้",
    "ขอดูชีสสไลด์",
    "ขอดูสเปรย์กันยุง",
    "มาหลายวันแล้ว",
    "อ๋อคิดว่า",
    "สมมุติถ้าเหลือเดียว",
    "คืนก็นั่งคิดกูจะทำใหม่ดี",
    "ไม่น่ามีอะไร",
  ])
    assert.equal(fixHeard(t, vocab), t, `everyday Thai left alone: ${t}`);
}

console.log(`✓ MarketBrain selftest passed (${stats.totalProducts} products, ${stats.totalNotes} notes, ${stats.totalSynapses} synapses, order=${testOrder.orderNo})`);
