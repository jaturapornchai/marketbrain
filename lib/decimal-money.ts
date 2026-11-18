import Decimal from "decimal.js";

// Configure Decimal safely for accounting/pricing operations
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

const VALID_DECIMAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

export function parseDecimal(val: unknown): Decimal | null {
  if (val == null) return null;
  if (val instanceof Decimal) return val;
  if (typeof val === "object" && val !== null && "$numberDecimal" in val) {
    const raw = String((val as { $numberDecimal: unknown }).$numberDecimal).trim();
    return VALID_DECIMAL_RE.test(raw) ? new Decimal(raw) : null;
  }
  if (typeof val === "object" && val !== null && typeof (val as { toString?: () => string }).toString === "function") {
    const raw = (val as { toString: () => string }).toString().trim();
    if (VALID_DECIMAL_RE.test(raw)) return new Decimal(raw);
  }
  const str = String(val).replace(/,/g, "").replace(/[฿\s]/g, "").trim();
  if (!str || !VALID_DECIMAL_RE.test(str)) return null;
  try {
    return new Decimal(str);
  } catch {
    return null;
  }
}

export function toMoneyString(val: unknown, scale = 2): string | null {
  const d = parseDecimal(val);
  if (!d || !d.isFinite() || d.lte(0)) return null;
  return d.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed(scale);
}

export function formatThaiBaht(val: unknown): string {
  const s = toMoneyString(val, 2);
  if (!s) return "ไม่ระบุราคา";
  const [intPart, decPart] = s.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart === "00" ? `฿${withCommas}` : `฿${withCommas}.${decPart}`;
}

export function compareMoney(a: string | null | undefined, b: string | null | undefined): number {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return da.comparedTo(db);
}

export function moneyInRange(
  price: string | null | undefined,
  minPrice?: string | null,
  maxPrice?: string | null,
): boolean {
  const p = parseDecimal(price);
  const minD = parseDecimal(minPrice);
  const maxD = parseDecimal(maxPrice);
  if (!minD && !maxD) return true;
  if (!p) return false;
  if (minD && p.lt(minD)) return false;
  if (maxD && p.gt(maxD)) return false;
  return true;
}

export function divideMoney(amount: unknown, qty: number): string | null {
  const d = parseDecimal(amount);
  if (!d || !Number.isFinite(qty) || qty <= 0) return null;
  return d.div(new Decimal(String(qty))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

// Safe recursive-descent arithmetic evaluator using Decimal ONLY (+ - * / and parentheses), modeled after javis01's `calc`
type Token = { kind: "num"; val: Decimal } | { kind: "op"; val: string };

function tokenizeExpr(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = expr.replace(/,/g, "");
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if ("+-*/()".includes(ch)) {
      tokens.push({ kind: "op", val: ch });
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let numStr = "";
      while (i < s.length && /[0-9.]/.test(s[i])) {
        numStr += s[i++];
      }
      if (!VALID_DECIMAL_RE.test(numStr)) {
        throw new Error(`ตัวเลขไม่ถูกต้อง: ${numStr}`);
      }
      tokens.push({ kind: "num", val: new Decimal(numStr) });
      continue;
    }
    throw new Error(`อักขระไม่ได้รับอนุญาตในสูตร: ${ch}`);
  }
  return tokens;
}

function evalTokens(tokens: Token[]): Decimal {
  let pos = 0;

  function parseAddSub(): Decimal {
    let left = parseMulDiv();
    while (pos < tokens.length && tokens[pos].kind === "op" && (tokens[pos].val === "+" || tokens[pos].val === "-")) {
      const op = tokens[pos++].val;
      const right = parseMulDiv();
      left = op === "+" ? left.plus(right) : left.minus(right);
    }
    return left;
  }

  function parseMulDiv(): Decimal {
    let left = parseUnary();
    while (pos < tokens.length && tokens[pos].kind === "op" && (tokens[pos].val === "*" || tokens[pos].val === "/")) {
      const op = tokens[pos++].val;
      const right = parseUnary();
      if (op === "/" && right.isZero()) throw new Error("หารด้วยศูนย์ไม่ได้");
      left = op === "*" ? left.times(right) : left.div(right);
    }
    return left;
  }

  function parseUnary(): Decimal {
    if (pos < tokens.length && tokens[pos].kind === "op" && (tokens[pos].val === "+" || tokens[pos].val === "-")) {
      const op = tokens[pos++].val;
      const v = parseUnary();
      return op === "-" ? v.negated() : v;
    }
    return parsePrimary();
  }

  function parsePrimary(): Decimal {
    const tok = tokens[pos];
    if (!tok) throw new Error("สูตรคำนวณไม่สมบูรณ์");
    if (tok.kind === "num") {
      pos++;
      return tok.val;
    }
    if (tok.kind === "op" && tok.val === "(") {
      pos++;
      const inside = parseAddSub();
      const close = tokens[pos];
      if (!close || close.kind !== "op" || close.val !== ")") {
        throw new Error("วงเล็บปิดไม่ครบ");
      }
      pos++;
      return inside;
    }
    throw new Error(`รูปแบบสูตรไม่ถูกต้องใกล้: ${tok.val}`);
  }

  const res = parseAddSub();
  if (pos !== tokens.length) throw new Error("มีส่วนเกินในสูตรคำนวณ");
  return res;
}

export function calcDecimalLines(linesText: string): { summary: string; rows: { label: string; expr: string; result: string }[] } {
  const rows: { label: string; expr: string; result: string }[] = [];
  const outLines: string[] = [];

  for (const rawLine of linesText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colonIdx = line.lastIndexOf(":");
    const label = colonIdx > 0 ? line.slice(0, colonIdx).trim() : "ผลลัพธ์";
    const expr = (colonIdx > 0 ? line.slice(colonIdx + 1) : line).trim();
    try {
      const val = evalTokens(tokenizeExpr(expr));
      const rounded = val.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const formatted = rounded.toFixed(2).replace(/\.00$/, "");
      rows.push({ label, expr, result: formatted });
      outLines.push(`${label}: ${expr} = ${formatted}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "คำนวณไม่สำเร็จ";
      outLines.push(`${label}: คำนวณไม่ได้ (${msg})`);
    }
  }
  return { summary: outLines.join("\n") || "ไม่มีรายการคำนวณ", rows };
}
