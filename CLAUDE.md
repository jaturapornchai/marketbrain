@~/.agents/AGENTS.md
@AGENTS.md

# MarketBrain — Claude Code Handoff & Operations Guide

## 1. สถานะระบบปัจจุบัน (Live Production Stack)
- **Public URL**: `https://marketbrain.bcsmethai.com` (Caddy HTTPS บน `bcsmethai.com` -> Reverse SSH Tunnel `127.0.0.1:13090` -> เครื่องนี้ `127.0.0.1:3090`)
- **Local Web URL**: `http://localhost:3090` (`next start -p 3090`)
- **Local Voice Sidecar**: `http://127.0.0.1:3091` (`voice_sidecar/voice_service.py` — GPU `hotdogs/omnivoice-thai` บน `cuda:0` + CPU `iapp/OpenThai2.0-ASR-Streaming-ONNX`)
- **Local Vision AI**: `http://127.0.0.1:11434` (Ollama `qwen3-vl:8b-instruct` โหลดค้างใน VRAM แล้ว ใช้ส่องรูปสินค้าผ่าน `/api/vision/identify`)
- **MCP Endpoint**: `https://marketbrain.bcsmethai.com/mcp` (JSON-RPC 2.0 Streamable HTTP)
- **GitHub Repo**: `https://github.com/jaturapornchai/marketbrain` (`branch: main`)
- **Background Supervisor**: รันถาวรผ่าน `wscript.exe "D:\marketbrain\deploy\start_hidden.vbs"` -> `node deploy\run-all.mjs` (log อยู่ที่ `.data\marketbrain.log` หมุนไฟล์อัตโนมัติที่ 5 MB)

## 2. กฎเหล็กห้ามพลาดสำหรับ Claude Code
1. **ห้าม Kill โปรเซสแบบเหมาชื่อ (`taskkill /IM python.exe` / `ssh.exe` / `node.exe` ห้ามเด็ดขาด!)**:
   - บนเครื่องนี้มีบริการอื่นของลุงจืดรันอยู่ด้วย (เช่น `javis voice agent` ใน `D:\bctest01` พอร์ต `7860/7861` และ SSH `17861`)
   - หากต้องการ Build + Restart เฉพาะ MarketBrain ให้รันคำสั่ง **`npm run redeploy`** (`deploy/restart-production.ps1`) ซึ่งคัดกรองเฉพาะโปรเซสของ `D:\marketbrain` เท่านั้น
2. **ห้ามแตะไฟล์หรือฐานข้อมูลนอก `D:\marketbrain` เด็ดขาด**:
   - `D:\bcscanproduct`, `D:\bcbrain`, `D:\bctest01` และ MongoDB `bcscanproduct` เป็น **Read-Only 100%**
3. **ล็อกโมเดล `deepseek-flash` เท่านั้น + ประหยัด Token สูงสุด**:
   - ห้ามเพิ่มปุ่มเปลี่ยนโมเดลบน UI และห้ามเปลี่ยน `LOCKED_FLASH_MODEL` ใน `lib/nong-tee.ts` เป็นรุ่นอื่นเด็ดขาด
   - คงโหมดประหยัด Token: ค้นสินค้าใน RAM ก่อนเรียก Planner, ปิด `thinking`, ส่งประวัติย้อนหลังเฉพาะคำพูดสั้น (ตัดตาราง `[จอ]` ออก), จำกัด `max_tokens: 420`
4. **ห้ามหลุดชื่อห้างหรือแพลตฟอร์มภายนอกทุกกรณี (ป้องกันปัญหาเครื่องหมายการค้า)**:
   - ห้ามมีชื่อห้างค้าส่ง/ค้าปลีก หรือแพลตฟอร์มอีคอมเมิร์ซภายนอกในโค้ด, หน้าจอ, คำอธิบาย หรือ URL รูปภาพ
   - รูปภาพสินค้าทุกใบต้องแปลงผ่าน `/api/img/[token]` (`lib/product-source.ts` -> `app/api/img/[token]/route.ts`) และกรองข้อความด้วย `sanitizeRetailerText()` เสมอ
5. **การเงินใช้ `Decimal.js` (`ROUND_HALF_UP`) เท่านั้น** และสแกนความลับด้วย `npm run scan` ก่อน commit/push ทุกครั้ง

## 3. แผนผังไฟล์หลัก (Codebase Map)
- **สมองสินค้า & ซิงก์ข้อมูล (Read-Only)**:
  - `lib/product-source.ts` — ดึงสินค้า (`~7,880` รายการ) และหน่วยนับจาก MongoDB `bcscanproduct` แบบ Read-Only, ล้างชื่อห้าง, แปลงรูปเป็น `/api/img/[token]` เซฟลง `.data/brain-snapshot.json`
  - `lib/trait-dictionary.ts` — พจนานุกรมแปลหมวดหมู่ คุณลักษณะ โภชนาการ ภาษาไทย
  - `lib/vault.ts` — Hybrid BM25 + Synonym + Faceted Search + 3D Graph (`9` กลุ่มสมอง, `16` ชนิดไซแนปส์)
  - `lib/product-card.ts` — Pure client-safe types & `toProductCard()` (ห้าม import `mongodb`/`fs` ในไฟล์นี้)
- **เลขาน้องตี๋ (Javis Sales Concierge) + เสียง + กล้องส่องสินค้า + ตะกร้า**:
  - `lib/nong-tee.ts` & `app/api/javis/chat/route.ts` — ระบบสนทนา SSE ของน้องตี๋ (`deepseek-flash` เท่านั้น + Token-Saver Fast-Path + Cart/Order/Calc Tools)
  - `lib/cart-order.ts` & `lib/decimal-money.ts` & `app/api/orders/route.ts` — คำนวณตะกร้าและออกบิล `#MB-YYYYMMDD-XXXX` ด้วย `Decimal.js` (ซ่อน PII บน public `GET /api/orders`)
  - `app/api/vision/identify/route.ts` — ส่องรูปสินค้า/บาร์โค้ดด้วย Local Ollama `qwen3-vl:8b-instruct` จับคู่สินค้าจริงในสมอง
  - `voice_sidecar/voice_service.py` & `app/api/voice/*` — เสียงพูดโคลนไทย `OmniVoice` GPU (`:3091`) + ฟังเสียงไทยสด `OpenThai 2.0 ASR`
- **Frontend UI (Next.js App Router, Mobile-First)**:
  - `components/JavisSalesCockpit.tsx` (`app/page.tsx`) — หน้าหลัก `/` เปิดมาให้น้องตี๋ทำงานทันที, เปลี่ยนเวทีภาพตามบริบท, ตะกร้าสด, ปิดการขายพร้อม PromptPay QR
  - `components/DevicePickerPopover.tsx` — ปุ่ม `⚙️ อุปกรณ์` เลือก ไมค์ (พร้อมแถบวัดเสียงสด) · ลำโพง (`setSinkId` + ทดสอบเสียง) · กล้อง
  - `components/ProductVisionScanner.tsx` — กล้องส่องสินค้าอัตโนมัติ (`BarcodeDetector` + `qwen3-vl`), อัปโหลดรูป และวางรูป `Ctrl+V`
  - `components/AddToCartModal.tsx` & `components/JavisContext.tsx` — ปุ่ม `🛒 ใส่ตะกร้า` เลือกจำนวน/หน่วยบรรจุ และ Global State
  - `components/ProductCatalogWorkbench.tsx` (`app/search/page.tsx`) — หน้าค้นหาสินค้าเต็มความกว้างหน้าจอ 100% (`/search`)
  - `components/Brain3D.tsx` (`app/brain/page.tsx`) & `app/mcp/route.ts` — สมอง 3D และ MCP Server

## 4. คำสั่งตรวจสอบและ Deploy มาตรฐาน
```powershell
npm run scan        # สแกน secret / key / credential ก่อน build & commit
npm run typecheck   # ตรวจ TypeScript ทั้งโปรเจกต์ (ต้อง 0 error)
npm test            # รัน Unit Selftest (Decimal, Negation, Graph, Cart/Order)
npm run uat         # รัน UAT + E2E ครบ 6 หมวด (ตั้ง $env:UAT_BASE_URL="https://marketbrain.bcsmethai.com" เพื่อยิงตรวจเว็บจริง)
npm run redeploy    # Build ใหม่ + รีสตาร์ทเฉพาะ Background Service ของ MarketBrain ขึ้นเว็บจริง (เมื่อได้รับคำสั่ง R0 จากลุงจืด)
```
