import type { Metadata } from "next";
import ProductCatalogWorkbench from "@/components/ProductCatalogWorkbench";
import Shell from "@/components/Shell";
import { formatUpdatedAt, searchProductsDetailed, type ProductSearchQuery } from "@/lib/vault";

export const metadata: Metadata = {
  title: "ค้นหาสินค้าแบบละเอียด · MarketBrain สมองสินค้า",
  description:
    "ค้นหาและกรองสินค้าอุปโภคบริโภคไทยแบบละเอียดตามกลุ่มหมวดหมู่ แบรนด์ หน่วยนับ คุณลักษณะ ส่วนผสม ช่วงราคา และบาร์โค้ด GS1 ไทย พร้อมถามเลขาน้องตี๋",
  alternates: { canonical: "/search" },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");

  const q = str("q").trim();
  const category = str("category").trim();
  const brand = str("brand").trim();
  const unit = str("unit").trim();
  const traits = str("traits")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const source = str("source").trim();
  const minPrice = str("minPrice").trim();
  const maxPrice = str("maxPrice").trim();
  const multiUnitOnly = str("multiUnitOnly") === "1" || str("multiUnitOnly") === "true";
  const thaiGs1Only = str("thaiGs1Only") === "1" || str("thaiGs1Only") === "true";
  const rawSort = str("sort");
  const sort: NonNullable<ProductSearchQuery["sort"]> =
    rawSort === "price_asc" ||
    rawSort === "price_desc" ||
    rawSort === "unit_price_asc" ||
    rawSort === "pack_desc"
      ? rawSort
      : "relevance";
  const page = Math.max(1, Number(str("page") || "1") || 1);

  const initialData = searchProductsDetailed({
    q,
    category,
    brand,
    unit,
    traits,
    source,
    minPrice,
    maxPrice,
    multiUnitOnly,
    thaiGs1Only,
    sort,
    page,
    pageSize: 36,
  });

  return (
    <Shell q={q} updatedAtText={`อัปเดต ${formatUpdatedAt()}`}>
      <ProductCatalogWorkbench
        initialData={initialData}
        initialParams={{
          q,
          category,
          brand,
          unit,
          traits,
          source,
          minPrice,
          maxPrice,
          multiUnitOnly,
          thaiGs1Only,
          sort,
          page,
        }}
      />
    </Shell>
  );
}
