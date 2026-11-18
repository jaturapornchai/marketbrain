import type { Metadata } from "next";
import Link from "next/link";
import Brain3D, { CountUp } from "@/components/Brain3D";
import Shell from "@/components/Shell";
import { formatUpdatedAt, graph } from "@/lib/vault";

export const dynamic = "force-dynamic";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://marketbrain.bcsmethai.com";
const MCP_URL = `${SITE_URL}/mcp`;

export const metadata: Metadata = {
  title: "แผนภาพสมองสินค้า 3 มิติ · MarketBrain",
  description: "สำรวจโครงข่ายเซลล์สมองสินค้า 3 มิติ เชื่อมโยงสินค้า หมวดหมู่ แบรนด์ หน่วยนับ คุณลักษณะ และตระกูลแพ็ก",
  alternates: { canonical: "/brain" },
};

const MCP_TOOLS = [
  ["ask_brain", "ถามเรื่องสินค้า คุณลักษณะ หมวดหมู่ หน่วยนับ หรือเปรียบเทียบแพ็ก ได้โน้ตพร้อมไซแนปส์ 1 ทอด"],
  ["search_products_advanced", "ค้นหาและกรองสินค้าแบบละเอียดตามหมวดหมู่ แบรนด์ หน่วยนับ คุณลักษณะ ช่วงราคา และบาร์โค้ดไทย 885"],
  ["search_brain", "ค้นหาเซลล์ความรู้ทุกชนิดด้วย BM25 + ตัดคำไทย + คำพ้องสินค้าไทย + 1-hop Graph Boost"],
  ["traverse_brain", "เดินไซแนปส์เชื่อมโยง 16 ชนิด 1–3 ทอด (กลุ่มสินค้า, แบรนด์, หน่วยนับ, คุณลักษณะ, ตระกูลแพ็ก, ร้านค้า)"],
  ["read_note", "อ่านรายละเอียดเต็มของสินค้า (ตารางหน่วยนับ, บาร์โค้ด, ส่วนผสม, โภชนาการ) ตาม slug หรือบาร์โค้ด"],
  ["list_notes", "ดูสารบัญเซลล์สมองแยกตามกลุ่ม (product, category, brand, unit, trait, family, source, schema)"],
];

export default function BrainPage() {
  const g = graph("all");
  const st = g.stats;

  return (
    <>
      <Shell updatedAtText={`อัปเดต ${formatUpdatedAt()}`} />

      <main className="home">
        <Brain3D nodes={g.nodes} links={g.links} rels={g.rels}>
          <p className="eyebrow">MarketBrain · 3D Product Graph</p>
          <h1>สมองสินค้า 3 มิติ</h1>
          <p className="lead">
            เชื่อมโยง <CountUp to={st.totalProducts} /> สินค้า · <CountUp to={st.totalBrands} delay={250} /> แบรนด์ ·{" "}
            <CountUp to={st.totalUnits} delay={400} /> หน่วยนับ · <CountUp to={st.totalTraits} delay={550} /> คุณลักษณะ ·{" "}
            <CountUp to={st.totalSynapses} delay={700} /> ไซแนปส์
          </p>
        </Brain3D>
      </main>

      <section className="mcp" id="mcp">
        <h2>เชื่อมต่อสมองสินค้าผ่าน MCP (`{MCP_URL}`)</h2>
        <div className="home-cta-row">
          <Link href="/" className="btn primary">
            🧑‍💼 กลับหน้าคุยสดกับน้องตี๋ (Javis)
          </Link>
          <Link href="/search" className="btn">
            🔎 เปิดหน้าค้นหาสินค้าเต็มจอ
          </Link>
        </div>
        <div className="cards">
          {MCP_TOOLS.map(([name, desc]) => (
            <div className="card" key={name}>
              <h3>
                <code>{name}</code>
              </h3>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
