import { emitMcpEvent } from "@/lib/mcp-events";
import { toProductCard, type JavisProductCard, type VisionDetectedProduct } from "@/lib/product-card";
import type { BrainProductItem } from "@/lib/product-source";
import { searchProductsDetailed } from "@/lib/vault";

export const dynamic = "force-dynamic";

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const VISION_MODEL = process.env.VISION_MODEL || "qwen3.5:9b";
const MAX_BODY_CHARS = 7_000_000;

const VISION_SYSTEM_PROMPT = `คุณคือ AI ส่องค้นหาสินค้าของระบบสมองสินค้า MarketBrain สำหรับร้านค้าส่ง-ปลีกไทย
อ่านฉลากสินค้าภาษาไทย ภาษาอังกฤษ ยี่ห้อ รสชาติ ขนาดบรรจุ และตัวเลขบาร์โค้ดจากภาพอย่างแม่นยำ ห้ามแต่งเติมข้อมูลที่ไม่มีในภาพ ตอบเป็น JSON เท่านั้น`;

const VISION_USER_PROMPT = `ตรวจสอบภาพนี้แล้วตอบเป็น JSON ตามโครงสร้างนี้เท่านั้น:
{
  "hasProduct": true หรือ false (true เฉพาะเมื่อเห็นตัวสินค้า บรรจุภัณฑ์ ขวด กล่อง ซอง กระป๋อง ถุง แพ็ค ลัง หรือบาร์โค้ดสินค้าชัดเจน; false ถ้าเป็นพื้นหลังว่าง กำแพง โต๊ะว่าง ภาพมืดเบลอ หรือเห็นแค่ใบหน้าคนโดยไม่มีสินค้าในมือ),
  "barcode": "ตัวเลขบาร์โค้ด 8-13 หลักถ้าอ่านได้บนฉลาก มิฉะนั้นใส่ค่าว่าง",
  "brand": "ชื่อแบรนด์/ยี่ห้อสินค้าภาษาไทยหรืออังกฤษที่เห็นบนฉลาก",
  "productName": "ชื่อสินค้า สูตร รสชาติ ที่อ่านได้บนฉลาก (ภาษาไทยเป็นหลัก ถ้าฉลากอังกฤษให้ใส่ทั้งคำอ่านไทยและอังกฤษ)",
  "categoryHint": "หมวดหมู่สินค้าสั้นๆ ภาษาไทย เช่น นมกล่อง, น้ำจิ้ม, ซอสปรุงรส, บะหมี่กึ่งสำเร็จรูป, น้ำดื่ม, น้ำอัดลม, กาแฟ, ขนมขบเคี้ยว, น้ำมันพืช, ผงซักฟอก, สบู่",
  "unitOrSize": "หน่วยหรือขนาดบรรจุที่เห็น เช่น ขวด, กล่อง, ซอง, แพ็ค, ลัง",
  "traitsHint": ["คุณลักษณะเด่นที่เห็นบนฉลาก เช่น ฮาลาล, ไม่ใส่ผงชูรส"],
  "searchQueries": ["คำค้นเจาะจงอันดับ 1 (ยี่ห้อ + ชื่อสินค้า)", "คำค้นอันดับ 2 (ชื่อสินค้าภาษาไทย)", "คำค้นอันดับ 3 (หมวดสินค้า)"],
  "summaryTh": "สรุปสั้นๆ ภาษาไทย 1 ประโยคว่าสินค้าในรูปคืออะไร"
}`;

function parseVisionJson(rawContent: string): VisionDetectedProduct {
  const cleaned = rawContent
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  let parsed: Record<string, unknown> = {};
  if (match) {
    try {
      parsed = JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const str = (v: unknown, max = 160) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const arr = (v: unknown) =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().slice(0, 100))
          .filter(Boolean)
          .slice(0, 5)
      : [];

  return {
    hasProduct: Boolean(parsed.hasProduct),
    barcode: str(parsed.barcode, 32).replace(/[^0-9]/g, ""),
    brand: str(parsed.brand, 80),
    productName: str(parsed.productName, 140),
    categoryHint: str(parsed.categoryHint, 80),
    unitOrSize: str(parsed.unitOrSize, 60),
    traitsHint: arr(parsed.traitsHint),
    searchQueries: arr(parsed.searchQueries),
    summaryTh: str(parsed.summaryTh, 200),
  };
}

function matchBrainProducts(
  detected: VisionDetectedProduct,
  barcodeHint: string,
): { items: BrainProductItem[]; exactMatch: boolean; matchedQuery: string } {
  const collected = new Map<string, BrainProductItem>();
  let matchedQuery = "";
  let exactMatch = false;

  const tryBarcode = barcodeHint || detected.barcode;
  if (tryBarcode && tryBarcode.length >= 8) {
    const bcRes = searchProductsDetailed({ q: tryBarcode, pageSize: 8 });
    if (bcRes.items.length > 0) {
      for (const it of bcRes.items) collected.set(it.slug, it);
      matchedQuery = tryBarcode;
      exactMatch = true;
      return { items: [...collected.values()], exactMatch, matchedQuery };
    }
  }

  const primaryCandidates = [
    [detected.brand, detected.productName].filter(Boolean).join(" ").trim(),
    ...detected.searchQueries,
    detected.productName,
    detected.brand.length >= 2 ? `${detected.brand} ${detected.categoryHint}`.trim() : "",
    detected.brand.length >= 2 ? detected.brand : "",
  ].filter((q) => q.length >= 2);

  const seenQ = new Set<string>();
  for (const q of primaryCandidates) {
    const key = q.toLowerCase();
    if (seenQ.has(key)) continue;
    seenQ.add(key);
    const res = searchProductsDetailed({ q, pageSize: 10 });
    if (res.items.length > 0) {
      if (!matchedQuery) matchedQuery = q;
      exactMatch = true;
      for (const it of res.items) {
        if (collected.size < 12) collected.set(it.slug, it);
      }
      if (collected.size >= 8) break;
    }
  }

  if (collected.size === 0 && detected.categoryHint.length >= 2) {
    const catRes = searchProductsDetailed({ q: detected.categoryHint, pageSize: 10 });
    if (catRes.items.length > 0) {
      matchedQuery = detected.categoryHint;
      exactMatch = false;
      for (const it of catRes.items) {
        if (collected.size < 12) collected.set(it.slug, it);
      }
    }
  }

  return { items: [...collected.values()], exactMatch, matchedQuery };
}

export async function POST(req: Request): Promise<Response> {
  const t0 = performance.now();
  const rawLen = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(rawLen) && rawLen > MAX_BODY_CHARS) {
    return Response.json({ ok: false, error: "ไฟล์รูปภาพมีขนาดใหญ่เกินกำหนด (สูงสุด ~4.5 MB)" }, { status: 413 });
  }

  let body: { imageBase64?: unknown; barcodeHint?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "ข้อมูล JSON ไม่ถูกต้อง" }, { status: 400 });
  }

  const barcodeHint =
    typeof body.barcodeHint === "string" ? body.barcodeHint.replace(/[^0-9A-Za-z-]/g, "").slice(0, 32) : "";

  // Fast-path: browser BarcodeDetector already read a barcode
  if (barcodeHint.length >= 8) {
    const bcRes = searchProductsDetailed({ q: barcodeHint, pageSize: 10 });
    if (bcRes.items.length > 0) {
      const cards: JavisProductCard[] = bcRes.items.map(toProductCard);
      const top = bcRes.items[0];
      const detected: VisionDetectedProduct = {
        hasProduct: true,
        barcode: barcodeHint,
        brand: top.brandTh || top.brandEn || "",
        productName: top.nameTh,
        categoryHint: top.categoryPathTh,
        unitOrSize: top.unitCode,
        traitsHint: top.traits.map((t) => t.valueTh).slice(0, 3),
        searchQueries: [barcodeHint, top.nameTh],
        summaryTh: `${top.nameTh} (บาร์โค้ด ${barcodeHint})`,
      };
      const ms = Math.max(1, Math.round(performance.now() - t0));
      emitMcpEvent({
        tool: "vision_barcode_lookup",
        audience: "user",
        rawArg: barcodeHint,
        hits: bcRes.items.slice(0, 4).map((p) => ({ slug: p.slug, title: p.nameTh, folder: "product" })),
        totalHits: bcRes.total,
        ms,
      });
      return Response.json({
        ok: true,
        hasProduct: true,
        exactMatch: true,
        matchedQuery: barcodeHint,
        detected,
        cards,
        totalMatches: bcRes.total,
        ms,
      });
    }
  }

  const rawImg = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
  if (!rawImg || rawImg.length > MAX_BODY_CHARS) {
    return Response.json({ ok: false, error: "ไม่พบข้อมูลรูปภาพสำหรับค้นหาสินค้า" }, { status: 400 });
  }
  const base64Clean = rawImg.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
  if (base64Clean.length < 64) {
    return Response.json({ ok: false, error: "ข้อมูลรูปภาพสั้นเกินไป" }, { status: 400 });
  }

  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        stream: false,
        think: false,
        format: "json",
        options: {
          temperature: 0.1,
          num_predict: 320,
        },
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          { role: "user", content: VISION_USER_PROMPT, images: [base64Clean] },
        ],
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!ollamaRes.ok) {
      return Response.json(
        { ok: false, error: `Local Vision (${VISION_MODEL}) ตอบกลับ HTTP ${ollamaRes.status}` },
        { status: 502 },
      );
    }

    const ollamaJson = (await ollamaRes.json()) as { message?: { content?: string } };
    const content = ollamaJson.message?.content ?? "";
    const detected = parseVisionJson(content);
    const ms = Math.max(1, Math.round(performance.now() - t0));

    if (!detected.hasProduct && !barcodeHint) {
      return Response.json({
        ok: true,
        hasProduct: false,
        exactMatch: false,
        matchedQuery: "",
        detected,
        cards: [],
        totalMatches: 0,
        ms,
      });
    }

    const { items, exactMatch, matchedQuery } = matchBrainProducts(detected, barcodeHint);
    const cards = items.map(toProductCard);

    emitMcpEvent({
      tool: "vision_identify",
      audience: "user",
      rawArg: matchedQuery || detected.summaryTh || "image",
      hits: items.slice(0, 4).map((p) => ({ slug: p.slug, title: p.nameTh, folder: "product" })),
      totalHits: items.length,
      ms,
    });

    return Response.json({
      ok: true,
      hasProduct: true,
      exactMatch,
      matchedQuery: matchedQuery || detected.productName || detected.brand || detected.categoryHint,
      detected,
      cards,
      totalMatches: cards.length,
      ms,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Visionเชื่อมต่อไม่สำเร็จ";
    return Response.json(
      { ok: false, error: `ระบบวิเคราะห์ภาพสินค้าในเครื่องยังไม่พร้อม (${msg})` },
      { status: 502 },
    );
  }
}
