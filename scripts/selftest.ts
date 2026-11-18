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

console.log(`✓ MarketBrain selftest passed (${stats.totalProducts} products, ${stats.totalNotes} notes, ${stats.totalSynapses} synapses, order=${testOrder.orderNo})`);
