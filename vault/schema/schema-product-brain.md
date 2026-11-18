---
title: โครงสร้างฐานข้อมูลสมองสินค้า & สเปก MCP API (Developer Schema)
audience: dev
tags:
  - schema
  - mongodb
  - postgresql
  - mcp
  - decimal
aliases:
  - schema-product-brain
  - playbook-dev
  - product_schema
---

# โครงสร้างฐานข้อมูลสมองสินค้า & สเปก MCP API

## 1. แหล่งข้อมูลต้นทาง (Read-Only Data Source)
ระบบ **MarketBrain** เชื่อมต่ออ่านข้อมูลแบบ **Read-Only** จากฐานข้อมูล `bcscanproduct`:
- **MongoDB (`bcscanproduct`)**:
  - `products`: เก็บเอกสารสินค้าหลัก (`canonicalKey`, `productCode`, `baseItemCode`, `primaryBarcode`, `barcodes`, `nameTh`, `nameEn`, `brandTh`, `brandEn`, `categoryLevels`, `unitCode`, `baseUnitCode`, `packQty`, `bestPrice`, `pricePerBaseUnit`, `unitConversions`, `barcodeUnits`, `relatedProducts`, `attributes`, `nutrition`, `ingredients`, `features`, `images`, `sources`)
  - `units`: ตารางมาตรฐานหน่วยนับไทย-สากล (`code`, `unitSysCode`, `nameTh`, `nameEn`, `unitType`, `defaultFactor`)
  - `category_groups` & `category_translations`: โครงสร้างต้นไม้หมวดหมู่สินค้าและคำแปลภาษาไทย
- **PostgreSQL (`bcscanproduct`)**:
  - `products_search_idx`, `product_barcodes`, `product_unit_conversions`, `product_price_history`, `product_sources`, `units_master_pg` (ชนิดข้อมูลราคาทุกคอลัมน์เป็น `NUMERIC` เสมอ)

## 2. มาตรฐานค่าเงินและบาร์โค้ด
- ค่าเงินทุกจุด (`bestPrice`, `minPrice`, `maxPrice`, `pricePerBaseUnit`) เก็บและส่งผ่าน JSON เป็น **Decimal String** (เช่น `"31.00"`) และคำนวณด้วย `decimal.js` (`ROUND_HALF_UP`) ห้ามใช้ `float` / `Number()`
- บาร์โค้ดตรวจสอบ Check Digit มาตรฐาน GTIN-8/12/13/14 โดยรหัสขึ้นต้น `885` คือมาตรฐาน **GS1 ประเทศไทย**

## 3. เครื่องมือ MCP (`/mcp` — Stateless Streamable HTTP)
- `ask_brain({ question, audience })`: ค้นสมองสินค้าพร้อมบริบทไซแนปส์ 1 ทอดและรูปภาพสินค้า
- `search_brain({ query, limit, audience })`: ค้นหาเซลล์ความรู้ทุกประเภทด้วย BM25 + คำพ้องสินค้าไทย + Graph Boost
- `search_products_advanced({ query, category, brand, unit, trait, source, minPrice, maxPrice, multiUnitOnly, thaiGs1Only, sort, limit })`: ค้นหาและกรองสินค้าแบบละเอียดทุกมิติ
- `traverse_brain({ slug, to_slug, depth, relation, audience })`: เดินไซแนปส์ 16 ชนิด (`in_category`, `sub_category`, `has_brand`, `uses_unit`, `converts_unit`, `has_trait`, `in_family`, `pack_variant`, `sold_at` ฯลฯ)
- `read_note({ slug })` & `list_notes({ folder, tag, audience })` & `find_media({ query, kind, limit })`

เชื่อมโยงแกนกลาง: [[hub_map::index]]
