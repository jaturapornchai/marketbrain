import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = process.cwd();
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: { parentURL?: string }) => unknown) {
    if (specifier.startsWith("@/")) {
      const target = path.join(rootDir, specifier.slice(2));
      for (const ext of ["", ".ts", ".tsx"]) {
        if (fs.existsSync(target + ext) && fs.statSync(target + ext).isFile()) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
    }
    if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier) && context.parentURL?.startsWith("file:")) {
      for (const ext of [".ts", ".tsx"]) {
        const candidate = new URL(`${specifier}${ext}`, context.parentURL);
        if (fs.existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context) as { url: string; shortCircuit?: boolean };
  },
});

const envPath = path.join(rootDir, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

const { syncBrainSnapshotFromDb } = await import("../lib/product-source.ts");

const t0 = performance.now();
const snap = await syncBrainSnapshotFromDb();
const ms = (performance.now() - t0).toFixed(0);
console.log(
  `[sync-brain] ซิงก์ข้อมูลสมองสำเร็จจากฐานข้อมูล "${snap.dbName}" ใน ${ms} ms: สินค้า ${snap.productCount.toLocaleString()} รายการ, หน่วยนับ ${snap.unitCount.toLocaleString()} รายการ`,
);
