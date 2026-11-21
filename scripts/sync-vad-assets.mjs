// Copies Silero VAD v5 ONNX weights and ONNX Runtime WASM files from node_modules into public/vad/
// so client-side VAD runs 100% self-hosted (no external CDN dependency, no binary bloat in git).
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "public", "vad");
fs.mkdirSync(outDir, { recursive: true });

const FILES = [
  {
    src: path.join(root, "node_modules", "@ricky0123", "vad-web", "dist", "silero_vad_v5.onnx"),
    dst: path.join(outDir, "silero_vad_v5.onnx"),
  },
  {
    src: path.join(root, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm"),
    dst: path.join(outDir, "ort-wasm-simd-threaded.wasm"),
  },
  {
    src: path.join(root, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.mjs"),
    dst: path.join(outDir, "ort-wasm-simd-threaded.mjs"),
  },
];

let copied = 0;
for (const { src, dst } of FILES) {
  if (!fs.existsSync(src)) {
    console.warn(`[sync-vad-assets] missing source: ${path.relative(root, src)}`);
    continue;
  }
  const srcStat = fs.statSync(src);
  const dstStat = fs.existsSync(dst) ? fs.statSync(dst) : null;
  if (!dstStat || dstStat.size !== srcStat.size || dstStat.mtimeMs < srcStat.mtimeMs) {
    fs.copyFileSync(src, dst);
    copied += 1;
  }
}

console.log(`[sync-vad-assets] public/vad ready (${copied} updated, ${FILES.length} total)`);
