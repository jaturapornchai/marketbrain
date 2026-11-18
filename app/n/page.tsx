import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import Shell from "@/components/Shell";
import {
  MODE_OPTIONS,
  ZONE_LABEL,
  groupOf,
  normalizeAudienceFilter,
  type AudienceFilter,
} from "@/lib/groups";
import { formatUpdatedAt, groupedVaultNotes, search } from "@/lib/vault";

export const metadata: Metadata = {
  title: "สารบัญเซลล์สมองสินค้า · MarketBrain",
  description:
    "สารบัญเซลล์ความรู้ทั้งหมดในสมองสินค้า แยกตามกลุ่มสินค้า หมวดหมู่ แบรนด์ หน่วยนับ คุณลักษณะ ตระกูลแพ็ก แหล่งร้านค้า และสเปกนักพัฒนา",
  alternates: { canonical: "/n" },
};

function notesHref({ q, mode }: { q?: string; mode?: AudienceFilter }) {
  const p = new URLSearchParams();
  if (mode && mode !== "all") p.set("mode", mode);
  if (q?.trim()) p.set("q", q.trim());
  const qs = p.toString();
  return qs ? `/n?${qs}` : "/n";
}

function noteHref(slug: string, mode: AudienceFilter) {
  const base = `/n/${encodeURIComponent(slug)}`;
  return mode !== "all" ? `${base}?mode=${mode}` : base;
}

export default async function NotesIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; mode?: string }>;
}) {
  const { q = "", mode: rawMode } = await searchParams;
  const mode = normalizeAudienceFilter(rawMode);

  const toolbar = (
    <div className="n-toolbar">
      <div className="mode-switch" role="group" aria-label="เลือกโซนสมอง">
        {MODE_OPTIONS.map(([m, label]) => (
          <Link
            key={m}
            href={notesHref({ q, mode: m })}
            className="mode-pill"
            aria-current={mode === m ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </div>
      <div className="n-toolbar-right">
        <Link href="/search" className="btn-clear">
          🔎 ไปหน้าตัวกรองสินค้าละเอียด
        </Link>
        {q.trim() && (
          <Link className="btn-clear" href={notesHref({ mode })}>
            ล้างคำค้น
          </Link>
        )}
      </div>
    </div>
  );

  if (q.trim()) {
    const hits = search(q, 40, mode);
    return (
      <Shell q={q} updatedAtText={`อัปเดต ${formatUpdatedAt()}`}>
        <div className="page">
          {toolbar}
          <h1>ผลการค้นหาในสมอง “{q}”</h1>
          {!hits.length && (
            <p className="muted">ไม่พบเซลล์ที่ตรงในโหมดนี้ ลองเปลี่ยนคำค้นหรือไปที่หน้าตัวกรองสินค้าละเอียด</p>
          )}
          <ul className="results">
            {hits.map((h, i) => (
              <li key={h.slug} style={{ "--i": i } as CSSProperties}>
                <div className="result-head">
                  <Link href={noteHref(h.slug, mode)}>{h.title}</Link>
                  <span className="chip" style={{ color: groupOf(h.folder).color }}>
                    {groupOf(h.folder).shortLabel}
                  </span>
                  {h.priceLabel && <strong className="res-price">{h.priceLabel}</strong>}
                  <span className={`chip zone zone-${h.audience}`}>{ZONE_LABEL[h.audience]}</span>
                </div>
                <p>{h.snippet}</p>
              </li>
            ))}
          </ul>
        </div>
      </Shell>
    );
  }

  const orderedFolders = groupedVaultNotes(mode, 60);

  return (
    <Shell updatedAtText={`อัปเดต ${formatUpdatedAt()}`}>
      <div className="page">
        {toolbar}
        <h1>สารบัญเซลล์ความรู้สมองสินค้า</h1>
        <p className="muted" style={{ marginBottom: 18 }}>
          แสดงเซลล์เด่นของแต่ละกลุ่มความรู้ (ต้องการกรองสินค้าทั้งคลังตามคุณลักษณะ/หน่วยนับ/ช่วงราคา กดที่ปุ่ม &ldquo;ค้นหาละเอียด&rdquo;)
        </p>
        <div className="groups">
          {orderedFolders.map(([folder, bucket], i) => (
            <section key={folder} className="group-box" style={{ "--i": i } as CSSProperties}>
              <h2 style={{ color: groupOf(folder).color }}>
                <span>{groupOf(folder).label}</span>
                <span className="chip">{bucket.total.toLocaleString("th-TH")}</span>
              </h2>
              <ul>
                {bucket.notes.map((n) => (
                  <li key={n.slug}>
                    <Link href={noteHref(n.slug, mode)}>{n.title}</Link>
                    {n.priceLabel && <small className="grp-price"> · {n.priceLabel}</small>}
                  </li>
                ))}
              </ul>
              {bucket.total > bucket.notes.length && folder === "product" && (
                <Link href="/search" className="more-link">
                  ดูและกรองสินค้าทั้งหมด {bucket.total.toLocaleString("th-TH")} รายการ →
                </Link>
              )}
            </section>
          ))}
        </div>
      </div>
    </Shell>
  );
}
