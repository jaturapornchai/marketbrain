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

// ---------- Echo guard: speaker echo is never the customer, but the customer can still barge in ----------
{
  const { EchoGuard, BARGE_FRAMES, playedLevel, wavEnvelope } = await import("../lib/echo-guard.ts");
  // Speech-like played level: loud syllables, soft syllables and pauses (one value per 256 ms mic frame).
  const played = Array.from({ length: 240 }, (_, i) => (i % 9 >= 7 ? 0 : 0.1 + 0.2 * Math.abs(Math.sin(i * 1.7))));
  for (const coupling of [0.02, 0.1, 0.5]) {
    const guard = new EchoGuard();
    const jitter = (i: number) => 0.75 + 0.5 * Math.abs(Math.sin(i * 12.9898)); // echo strength varies ±25%
    let falseBarge = 0;
    played.forEach((lvl, i) => {
      if (guard.hear(lvl * coupling * jitter(i), lvl) >= BARGE_FRAMES) falseBarge++;
    });
    assert.equal(falseBarge, 0, `echo only (coupling ${coupling}) must never barge in`);
    // Customer starts softly then speaks up: must barge in within ~1.5 s.
    let bargedAt = -1;
    for (let i = 0; i < 12 && bargedAt < 0; i++) {
      const lvl = played[i];
      const voice = Math.min(0.2, 0.04 * (i + 1));
      if (guard.hear(Math.hypot(lvl * coupling * jitter(i), voice), lvl) >= BARGE_FRAMES) bargedAt = i;
    }
    if (coupling <= 0.1) assert.ok(bargedAt >= 0 && bargedAt <= 6, `customer barges in over echo (coupling ${coupling}, frame ${bargedAt})`);
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
  const { mentionsCardNumber, cardNumbersIn } = await import("../lib/numbered-order.ts");
  assert.deepEqual(cardNumbersIn("ขอดูรายละเอียดเบอร์ 9 กับเบอร์ 2", 12), [9, 2], "numbered cards beyond 6 are found");
  assert.equal(mentionsCardNumber("เบอร์ 2 กับเบอร์ 3 ต่างกันยังไง", 6), true, "talking about on-screen numbers keeps the screen");
  assert.equal(mentionsCardNumber("เบอร์ 9 ราคาเท่าไหร่", 6), false);
  assert.equal(mentionsCardNumber("มีฟูซิลี่เบอร์ 309 ไหม", 6), false);
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

console.log(`✓ MarketBrain selftest passed (${stats.totalProducts} products, ${stats.totalNotes} notes, ${stats.totalSynapses} synapses, order=${testOrder.orderNo})`);
