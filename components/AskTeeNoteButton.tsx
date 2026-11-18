"use client";

import { useRouter } from "next/navigation";
import type { JavisProductCard } from "@/lib/product-card";
import { useJavis } from "./JavisContext";

export default function AskTeeNoteButton({
  slug,
  title,
  productCard,
}: {
  slug: string;
  title: string;
  productCard?: JavisProductCard | null;
}) {
  const { askNongTee, promptAddToCart } = useJavis();
  const router = useRouter();

  return (
    <div className="note-action-bar">
      {productCard && (
        <button
          type="button"
          className="btn primary"
          onClick={() => promptAddToCart(productCard)}
        >
          🛒 ใส่ตะกร้า (เลือกจำนวน/หน่วย)
        </button>
      )}
      <button
        type="button"
        className={productCard ? "btn" : "btn primary"}
        onClick={() =>
          askNongTee(
            `ตี๋ ช่วยดูรายละเอียด หน่วยนับ ความคุ้มค่า และแนะนำตัวเทียบของ "${title}" (${slug}) ให้หน่อยครับ`,
          )
        }
      >
        🧑‍💼 คุยกับน้องตี๋เรื่องนี้
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => router.push(`/brain?focus=${encodeURIComponent(slug)}`)}
      >
        🧠 ดูในสมอง 3D
      </button>
    </div>
  );
}
