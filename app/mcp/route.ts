import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { formatThaiBaht } from "@/lib/decimal-money";
import { RELATION_LABEL, RELATION_TYPES } from "@/lib/groups";
import { emitMcpEvent, type McpEventHit, type McpToolName } from "@/lib/mcp-events";
import {
  brainStats,
  connectedNeighbors,
  excerpt,
  findMedia,
  formatUpdatedAt,
  getNote,
  listVaultRows,
  search,
  searchProductsDetailed,
  terms,
  traverseGraph,
  vaultFolders,
  type Note,
} from "@/lib/vault";

export const dynamic = "force-dynamic";

const INSTRUCTIONS = `MarketBrain = สมองค้นหาและเชื่อมโยงสินค้าอุปโภคบริโภค-โชห่วยไทยแบบละเอียดทุกมิติ (ดึงจากฐานข้อมูลจริง bcscanproduct แบบ Read-Only):
- ครอบคลุมสินค้า, ต้นไม้กลุ่มสินค้าหลายระดับ, แบรนด์, หน่วยนับและอัตราบรรจุ (ชิ้น/ขวด/ซอง/แพ็ค/โหล/ลัง), คุณลักษณะเด่น (ไม่ใส่ผงชูรส, ฮาลาล, แช่แข็ง, บรรจุภัณฑ์, สารก่อภูมิแพ้), ส่วนผสม, โภชนาการ, ตระกูลสินค้าหลายแพ็ก และแหล่งร้านค้า
- ห้ามเดาราคา บาร์โค้ด หรือหน่วยนับ ใช้ค่าจริงจากโน้ตและผลค้นเท่านั้น ค่าเงินทั้งหมดเป็น Decimal string`;

const audienceSchema = z
  .enum(["all", "user", "dev"])
  .optional()
  .describe('กรองโซนความรู้: "user" (ข้อมูลสินค้า/หมวดหมู่/หน่วยนับ), "dev" (สเปกฐานข้อมูล/MCP), หรือ "all"');

const ANNOTATIONS = { readOnlyHint: true, openWorldHint: false };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function noteText(n: Note, body = n.body): string {
  const out = n.outEdges.slice(0, 30).map((e) => `[[${e.slug}]] (${e.rel})`).join(" ") || "-";
  const inn = n.inEdges.slice(0, 30).map((e) => `[[${e.slug}]] (${e.rel})`).join(" ") || "-";
  const imgs = n.media?.images.length
    ? [`images: ${n.media.images.slice(0, 4).map((i) => `${i.alt} -> ${i.url}`).join(" | ")}`]
    : [];
  return [
    `# ${n.title}`,
    `slug: ${n.slug} | folder: ${n.folder} | audience: ${n.audience} | tags: ${n.tags.join(", ")}`,
    "",
    body.trim(),
    "",
    ...imgs,
    `links: ${out}`,
    `backlinks: ${inn}`,
  ].join("\n");
}

function buildServer() {
  const st = brainStats();
  const server = new McpServer(
    { name: "marketbrain", version: "1.0.0" },
    {
      instructions: `${INSTRUCTIONS}\nสถิติสมองปัจจุบัน: ${st.totalProducts} สินค้า, ${st.totalUnits} หน่วยนับ, ${st.totalCategories} หมวดหมู่, ${st.totalSynapses} ไซแนปส์ (อัปเดต ${formatUpdatedAt()}).`,
    },
  );

  const emit = (
    tool: McpToolName,
    audience: "all" | "user" | "dev",
    rawArg: string,
    hits: McpEventHit[],
    totalHits: number,
    t0: number,
  ) => {
    const ms = performance.now() - t0;
    emitMcpEvent({ tool, audience, rawArg, hits, totalHits, ms });
  };

  server.registerTool(
    "ask_brain",
    {
      title: "ถามสมองสินค้า MarketBrain",
      description: "ถามคำถามเกี่ยวกับสินค้า คุณลักษณะ กลุ่มสินค้า หน่วยนับ หรือเปรียบเทียบแพ็ก/ลัง คืนโน้ตที่ตรงที่สุดพร้อมไซแนปส์ 1 ทอด",
      inputSchema: {
        question: z.string().min(1).max(500),
        audience: audienceSchema,
      },
      annotations: ANNOTATIONS,
    },
    async ({ question, audience }) => {
      const t0 = performance.now();
      const filter = audience ?? "all";
      const hits = search(question, 5, filter);
      if (!hits.length) {
        emit("ask_brain", filter, question, [], 0, t0);
        return text(`ไม่พบโน้ตที่ตรงกับ "${question}" ลองใช้ search_products_advanced หรือคำค้นอื่น`);
      }
      const ts = terms(question);
      const parts = hits.map((h, i) => {
        const n = getNote(h.slug)!;
        return noteText(n, excerpt(n.body, ts, i === 0 ? 6000 : 3500));
      });
      const graphCtx = connectedNeighbors(
        hits.map((h) => h.slug),
        filter,
        10,
      );
      const ctxBlock = graphCtx.length
        ? `\n\n---\n\n## ไซแนปส์เชื่อมโยง (1-hop)\n${graphCtx
            .map((g) => `- [${g.rel} · ${RELATION_LABEL[g.rel]}] ${g.slug} (${g.folder}) — ${g.title}`)
            .join("\n")}`
        : "";
      emit(
        "ask_brain",
        filter,
        question,
        hits.map((h) => ({ slug: h.slug, title: h.title, folder: h.folder })),
        hits.length,
        t0,
      );
      return text(`พบ ${hits.length} เซลล์ความรู้สำหรับ: ${question}\n\n${parts.join("\n\n---\n\n")}${ctxBlock}`);
    },
  );

  server.registerTool(
    "search_brain",
    {
      title: "ค้นหาเซลล์ความรู้ในสมอง",
      description: "ค้นหาทั้งสินค้า กลุ่ม แบรนด์ หน่วยนับ คุณลักษณะ และตระกูลสินค้าด้วย BM25 + คำพ้องไทย + Graph Boost",
      inputSchema: {
        query: z.string().min(1).max(300),
        limit: z.number().int().min(1).max(30).optional(),
        audience: audienceSchema,
      },
      annotations: ANNOTATIONS,
    },
    async ({ query, limit, audience }) => {
      const t0 = performance.now();
      const filter = audience ?? "all";
      const hits = search(query, limit ?? 10, filter);
      emit(
        "search_brain",
        filter,
        query,
        hits.slice(0, 6).map((h) => ({ slug: h.slug, title: h.title, folder: h.folder })),
        hits.length,
        t0,
      );
      return text(JSON.stringify(hits, null, 1));
    },
  );

  server.registerTool(
    "search_products_advanced",
    {
      title: "ค้นหาและกรองสินค้าแบบละเอียด",
      description: "ค้นหาสินค้าพร้อมตัวกรองหมวดหมู่ แบรนด์ หน่วยนับ คุณลักษณะ ช่วงราคา บาร์โค้ดไทย 885 และสินค้าหลายหน่วยนับ",
      inputSchema: {
        query: z.string().max(200).optional(),
        category: z.string().max(100).optional(),
        brand: z.string().max(100).optional(),
        unit: z.string().max(40).optional(),
        trait: z.string().max(100).optional(),
        minPrice: z.string().max(20).optional(),
        maxPrice: z.string().max(20).optional(),
        multiUnitOnly: z.boolean().optional(),
        thaiGs1Only: z.boolean().optional(),
        sort: z.enum(["relevance", "price_asc", "price_desc", "unit_price_asc", "pack_desc"]).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      },
      annotations: ANNOTATIONS,
    },
    async (args) => {
      const t0 = performance.now();
      const res = searchProductsDetailed({
        q: args.query,
        category: args.category,
        brand: args.brand,
        unit: args.unit,
        traits: args.trait ? [args.trait] : undefined,
        minPrice: args.minPrice,
        maxPrice: args.maxPrice,
        multiUnitOnly: args.multiUnitOnly,
        thaiGs1Only: args.thaiGs1Only,
        sort: args.sort,
        pageSize: args.limit ?? 12,
      });
      emit(
        "search_brain",
        "user",
        args.query || args.unit || "กรองสินค้าละเอียด",
        res.items.slice(0, 5).map((p) => ({ slug: p.slug, title: p.nameTh, folder: "product" })),
        res.total,
        t0,
      );
      const summary = res.items.map((p) => ({
        slug: p.slug,
        productCode: p.productCode,
        nameTh: p.nameTh,
        brand: p.brandTh || p.brandEn,
        category: p.categoryPathTh,
        bestPrice: p.bestPrice,
        priceFormatted: formatThaiBaht(p.bestPrice),
        unitCode: p.unitCode,
        packQty: p.packQty,
        pricePerBaseUnit: p.pricePerBaseUnit,
        primaryBarcode: p.primaryBarcode,
        traits: p.traits.map((t) => t.fullLabelTh),
        unitConversions: p.unitConversions,
        imageUrl: p.imageUrl,
      }));
      return text(JSON.stringify({ total: res.total, items: summary }, null, 1));
    },
  );

  server.registerTool(
    "traverse_brain",
    {
      title: "เดินไซแนปส์เชื่อมโยงในสมองสินค้า",
      description: "เดินตามเส้นเชื่อมโยง 1–3 ทอดจากสินค้า กลุ่ม แบรนด์ หน่วยนับ คุณลักษณะ หรือตระกูลแพ็ก",
      inputSchema: {
        slug: z.string().min(1).max(120),
        to_slug: z.string().min(1).max(120).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        direction: z.enum(["both", "out", "in"]).optional(),
        relation: z.enum(RELATION_TYPES).optional(),
        folder: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        audience: audienceSchema,
      },
      annotations: ANNOTATIONS,
    },
    async ({ slug, to_slug, depth, direction, relation, folder, limit, audience }) => {
      const t0 = performance.now();
      const filter = audience ?? "all";
      const res = traverseGraph({ slug, toSlug: to_slug, depth, direction, relation, folder, limit, audience: filter });
      if (!res.start) {
        emit("traverse_brain", filter, slug, [], 0, t0);
        return text(`ไม่พบโหนดเริ่มต้น "${slug}"`);
      }
      const steps = res.mode === "path" ? (res.path ?? []) : res.neighbors;
      emit(
        "traverse_brain",
        filter,
        slug,
        [
          { slug: res.start.slug, title: res.start.title, folder: res.start.folder },
          ...steps.slice(0, 5).map((s) => ({ slug: s.slug, title: s.title, folder: s.folder })),
        ],
        steps.length,
        t0,
      );
      const lines = steps.map(
        (s) => `- [Hop ${s.hop} · ${s.rel} (${RELATION_LABEL[s.rel]})] ${s.slug} (${s.folder}) — ${s.title}${s.priceLabel ? ` · ${s.priceLabel}` : ""}`,
      );
      return text(`# Traverse จาก ${res.start.title} (${res.start.slug})\n\n${lines.join("\n") || "ไม่พบโหนดเชื่อมเพิ่มเติม"}`);
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "อ่านเซลล์ความรู้ฉบับเต็ม",
      description: "อ่านโน้ตเต็มตาม slug, รหัสสินค้า (BCS...) หรือบาร์โค้ด",
      inputSchema: {
        slug: z.string().min(1).max(120),
      },
      annotations: ANNOTATIONS,
    },
    async ({ slug }) => {
      const t0 = performance.now();
      const n = getNote(slug);
      if (n) {
        emit(
          "read_note",
          n.audience === "both" ? "all" : n.audience,
          slug,
          [{ slug: n.slug, title: n.title, folder: n.folder }],
          1,
          t0,
        );
        return text(noteText(n));
      }
      emit("read_note", "all", slug, [], 0, t0);
      return text(`ไม่พบโน้ตหรือสินค้า "${slug}"`);
    },
  );

  server.registerTool(
    "list_notes",
    {
      title: "ดูสารบัญเซลล์ความรู้",
      description: `แสดงรายการเซลล์ในสมอง กรองตามกลุ่ม (${vaultFolders().join(", ")}) หรือป้ายกำกับ`,
      inputSchema: {
        folder: z.string().max(40).optional(),
        tag: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        audience: audienceSchema,
      },
      annotations: ANNOTATIONS,
    },
    async ({ folder, tag, limit, audience }) => {
      const t0 = performance.now();
      const filter = audience ?? "all";
      const f = folder?.toLowerCase();
      const t = tag?.toLowerCase();
      const matched = listVaultRows(filter).filter(
        (n) => (!f || n.folder === f) && (!t || n.tags.some((x) => x.toLowerCase() === t)),
      );
      const sliced = matched.slice(0, limit ?? 80);
      emit(
        "list_notes",
        filter,
        folder || tag || "*",
        sliced.slice(0, 5).map((n) => ({ slug: n.slug, title: n.title, folder: n.folder })),
        matched.length,
        t0,
      );
      const rows = sliced.map((n) => `${n.slug} | ${n.folder} | ${n.title}${n.priceLabel ? ` | ${n.priceLabel}` : ""}`);
      return text(`พบทั้งหมด ${matched.length} รายการ (แสดง ${sliced.length}):\n${rows.join("\n")}`);
    },
  );

  server.registerTool(
    "find_media",
    {
      title: "ค้นหารูปภาพสินค้าและลิงก์อ้างอิง",
      description: "ดึงลิงก์รูปภาพสินค้าจริงและหน้าเว็บอ้างอิงจากคำค้น",
      inputSchema: {
        query: z.string().max(200).optional(),
        kind: z.enum(["all", "image", "webpage"]).optional(),
        limit: z.number().int().min(1).max(30).optional(),
        audience: audienceSchema,
      },
      annotations: ANNOTATIONS,
    },
    async ({ query, kind, limit, audience }) => {
      const t0 = performance.now();
      const filter = audience ?? "user";
      const res = findMedia({ query, kind: kind ?? "all", limit: limit ?? 12, audience: filter });
      emit("find_media", filter, query || "*", res.matchedNotes.slice(0, 5), res.items.length, t0);
      return text(JSON.stringify({ count: res.items.length, items: res.items }, null, 1));
    },
  );

  return server;
}

const MAX_BODY_BYTES = 32 * 1024;
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Cache-Control": "no-store",
};

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function handle(req: Request): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request body too large (max 32 KB)." } },
      { status: 413, headers: CORS_HEADERS },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  await buildServer().connect(transport);
  const res = await transport.handleRequest(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export { handle as GET, handle as POST, handle as DELETE };
