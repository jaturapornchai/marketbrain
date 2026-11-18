<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# MarketBrain — กฎประจำโปรเจกต์ (สมองสินค้า & เลขาน้องตี๋ Javis)

## 0. กฎเหล็กการแยกพื้นที่ทำงาน (Strict Project Isolation — Read-Only Outside)
- **ห้ามสร้าง แก้ไข เขียนทับ หรือลบไฟล์ใดๆ นอกโฟลเดอร์โปรเจกต์ `d:\marketbrain` เด็ดขาด!**
- โฟลเดอร์และระบบภายนอกทั้งหมด (เช่น `d:\bcscanproduct`, `d:\bcbrain`, `d:\bctest01` รวมถึงฐานข้อมูลต้นทางของ `bcscanproduct`) **อนุญาตให้อ่านอย่างเดียว (Read-Only) เท่านั้น** ห้ามสั่ง `INSERT` / `UPDATE` / `DELETE` / `DROP` ลงฐานข้อมูลต้นทางของ `bcscanproduct` ทุกกรณี
- หากพบจุดที่ต้องปรับปรุงนอกโฟลเดอร์ `d:\marketbrain` ให้รายงานและสร้าง Prompt สำเร็จรูปให้ลุงจืดนำไปสั่งโปรเจกต์นั้นเอง

## 1. นโยบายโมเดลประจำโปรเจกต์ (Project Model & Orchestration Policy)
- **โมเดลหลัก (Lead / Coordinator)**: ใช้ **Orchestrator (Carbon)** (`gemini-pro-orchestrator`) ในการวางแผน ควบคุมการทำงาน ประสานงาน และตัดสินใจหลัก
- **โมเดลเสริม (เลือกใช้ตามความเหมาะสมของงาน)**:
  - **Gemini 4 Carbon (High)** (`gemini-4-carbon-high`) — วิเคราะห์สังเคราะห์, ตัดสินใจซับซ้อน, Verifier, ค่าเงิน/Decimal, Security, Backend/DB/Graph Engine หลัก
  - **Gemini 4 Hydrogen Extra** (`gemini-4-hydrogen-xhigh`) — สำรวจโค้ด, ค้นเว็บ, ตรวจ log, งานขนาน, UI/UX, UAT, ปรับปรุงความเร็ว
  - **Claude Opus 5.5 (High)** (`claude-opus-5-5-high`) — ตรวจทานเชิงลึก (Deep Review / Second-Eye Verifier), UX/UI Parity, สถาปัตยกรรมซับซ้อน, พิสูจน์ความถูกต้องตรรกะขั้นสูง

## 2. แหล่งข้อมูลสมองสินค้า (Read-Only Source of Truth)
- โคลนสถาปัตยกรรมสมอง 3D + GraphRAG + MCP จาก `d:\bcbrain` และสร้างเซลล์ความรู้-ไซแนปส์จากฐานข้อมูลจริงใน `d:\bcscanproduct` (`MongoDB` / `PostgreSQL` แบบ **Read-Only เท่านั้น**)
- **ห้ามเดา ห้ามแต่งเติมข้อมูลสินค้า (Zero-Guessing)**: ชื่อสินค้า, ราคา, หน่วยนับ, อัตราบรรจุ, บาร์โค้ด GS1 (`885`), กลุ่มสินค้า, คุณลักษณะ (`attributes`), ส่วนผสม (`ingredients`), โภชนาการ (`nutrition`), รูปภาพ และแหล่งร้านค้า ต้องมาจากฐานข้อมูลจริงเท่านั้น

## 3. เลขาน้องตี๋ (Javis Sales Concierge + Local OmniVoice + DeepSeek)
- ผู้ช่วยประจำระบบคือ **Javis ชื่อ "น้องตี๋"** ทำหน้าที่เป็นเลขาส่วนตัวค้นหาสินค้า จัดตะกร้า และปิดการขายครบวงจร (พูดจาสุภาพ คล่องแคล่ว ลงท้าย `ครับ/นะครับ` แทนตัวเองว่า `ตี๋` หรือ `ผม`)
- ใช้ Local Voice Engine เหมือน `d:\bctest01`: เสียงพูดโคลนไทย `hotdogs/omnivoice-thai` บน GPU ในเครื่อง + ฟังเสียงภาษาไทยสด `iapp/OpenThai2.0-ASR-Streaming-ONNX` บน CPU (`voice_sidecar/voice_service.py` พอร์ต `3091`)
- ภาพบนหน้าจอหลัก (`/`) เปลี่ยนตามบริบทการสนทนาอัตโนมัติ (แกลเลอรีสินค้า, เจาะลึกสินค้า, ตารางเปรียบเทียบ, ตะกร้าสด, หน้าชำระเงิน และใบยืนยันคำสั่งซื้อ)
- คำตอบของน้องตี๋และการ์ดสินค้าทุกใบมีปุ่มกดเข้าตะกร้าที่เด้งถามจำนวนและหน่วยนับได้ทันที คำนวณยอดเงินทุกบรรทัดด้วย `Decimal.js` (`ROUND_HALF_UP`) เท่านั้น

## 4. สถาปัตยกรรม Frontend: Next.js Mobile-First & Luxury Flagship Design
- **Frontend ใช้ Next.js (App Router) แบบ Mobile-First 100%** ดีไซน์สะอาด หรูหรา พรีเมียม (ห้ามเอ่ยชื่อแพลตฟอร์มอีคอมเมิร์ซภายนอกในหน้าจอหรือเนื้อหา)
- หน้าค้นหาสินค้า (`/search`) กางเต็มความกว้างหน้าจอ 100% แสดงรายการสินค้าได้หนาแน่นและชัดเจน
- **Baseline-First**: ตัวหนังสือ ปุ่ม ช่องกรอก ไอคอน และ Badge ในแถวเดียวกันต้องอยู่ระนาบเดียวกันเป๊ะ
- **No Secret in Git**: เก็บ URI ฐานข้อมูลและ API Key ใน `.env.local` เท่านั้น บังคับสแกนด้วย `scripts/scan-secrets.mjs` ก่อน build ทุกครั้ง
