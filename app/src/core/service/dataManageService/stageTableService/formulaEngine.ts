import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  addSeconds,
  addWeeks,
  addYears,
  differenceInCalendarDays,
  differenceInMonths,
  differenceInYears,
  getISOWeek,
  getWeek,
} from "date-fns";
import type {
  CustomColumnType,
  FormulaErrorCode,
  FormulaEvaluatedCell,
  SystemColumnId,
  TableCellValue,
  TableColumnSchema,
  TableFilterSortRow,
} from "@/types/table";
import { ALL_SYSTEM_COLUMN_IDS } from "@/types/table";

export const FORMULA_TABLE_REF_ID = "__table__";
export const FORMULA_CURRENT_VAR = "current";

export interface FormulaDateValue {
  kind: "date";
  ms: number;
  hasTime: boolean;
}

export interface FormulaRowRefValue {
  kind: "row";
  uuid: string;
  label: string;
}

export interface FormulaTableRefValue {
  kind: "table";
}

export interface FormulaErrorValue {
  kind: "error";
  code: FormulaErrorCode;
  message: string;
}

export type FormulaValue =
  | null
  | number
  | string
  | boolean
  | FormulaDateValue
  | FormulaRowRefValue
  | FormulaTableRefValue
  | FormulaErrorValue
  | FormulaValue[];

export type FormulaBinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "&"
  | ">"
  | ">="
  | "<"
  | "<="
  | "="
  | "=="
  | "!="
  | "!=="
  | "<>";

export type FormulaUnaryOp = "+" | "-" | "!";

export type FormulaAstNode =
  | { type: "number"; value: number; start: number; end: number }
  | { type: "string"; value: string; start: number; end: number }
  | { type: "boolean"; value: boolean; start: number; end: number }
  | { type: "null"; start: number; end: number }
  | { type: "colRef"; refId: string; raw: string; start: number; end: number }
  | { type: "nameRef"; name: string; raw: string; start: number; end: number }
  | { type: "tableRef"; start: number; end: number }
  | { type: "ident"; name: string; start: number; end: number }
  | { type: "array"; elements: FormulaAstNode[]; start: number; end: number }
  | { type: "unary"; op: FormulaUnaryOp; arg: FormulaAstNode; start: number; end: number }
  | { type: "binary"; op: FormulaBinaryOp; left: FormulaAstNode; right: FormulaAstNode; start: number; end: number }
  | { type: "call"; callee: string; args: FormulaAstNode[]; start: number; end: number }
  | { type: "methodCall"; receiver: FormulaAstNode; method: string; args: FormulaAstNode[]; start: number; end: number }
  | {
      type: "member";
      receiver: FormulaAstNode;
      propRefId?: string;
      propName: string;
      propStart?: number;
      propEnd?: number;
      start: number;
      end: number;
    };

export interface FormulaParseResult {
  ast: FormulaAstNode | null;
  error?: {
    code: FormulaErrorCode;
    message: string;
    start: number;
    end: number;
  };
}

export interface FormulaColumnLookup {
  columns: readonly TableColumnSchema[];
  systemColumnNames?: Partial<Record<SystemColumnId, string>>;
  systemColumnLabels?: Partial<Record<SystemColumnId, string>>;
}

export interface FormulaEvalOptions {
  now?: Date;
  systemColumnNames?: Partial<Record<SystemColumnId, string>>;
  systemColumnLabels?: Partial<Record<SystemColumnId, string>>;
  /** 可选行索引表，调用方复用可避免单行增量重算时 O(N) 重建 Map */
  rowByUuid?: ReadonlyMap<string, TableFilterSortRow>;
}

export interface FormulaValidationResult {
  valid: boolean;
  errorCode?: FormulaErrorCode;
  errorMessage?: string;
  dependencies: string[];
  hasCycle: boolean;
  missingRefs: string[];
  volatile: boolean;
}

const MS_PER_DAY = 86_400_000;
const VOLATILE_FUNCTIONS = new Set(["NOW", "TODAY", "RAND"]);
const SYSTEM_COLUMN_SET = new Set<string>(ALL_SYSTEM_COLUMN_IDS);

const DEFAULT_SYSTEM_LABELS: Record<SystemColumnId, string[]> = {
  name: ["名称", "命名", "Name", "name"],
  images: ["图片", "圖片", "Images", "Gambar", "images"],
  createdAt: ["创建时间", "建立時間", "Created time", "Waktu dibuat", "createdAt"],
  updatedAt: ["最后编辑时间", "最後編輯時間", "Last edited time", "Terakhir diedit", "updatedAt"],
  parents: ["父节点", "父節點", "Parent nodes", "Simpul induk", "parents"],
  children: ["子节点", "子節點", "Child nodes", "Simpul anak", "children"],
  outer: ["外节点", "外節點", "Outer node", "Simpul luar", "outer"],
  inner: ["内节点", "內節點", "Inner nodes", "Simpul dalam", "inner"],
};

const TABLE_REF_ALIASES = new Set([FORMULA_TABLE_REF_ID, "当前表", "目前表格", "CURRENT_TABLE", "THIS_TABLE", "Table"]);
const CURRENT_ITEM_ALIASES = new Set(["current", "currentvalue", "item", "当前值", "当前行", "目前值", "目前列"]);

// ---------------------------------------------------------------------------
// Type Guards & Value Helpers
// ---------------------------------------------------------------------------

export function isFormulaError(val: FormulaValue): val is FormulaErrorValue {
  return typeof val === "object" && val !== null && !Array.isArray(val) && val.kind === "error";
}

export function isFormulaDate(val: FormulaValue): val is FormulaDateValue {
  return typeof val === "object" && val !== null && !Array.isArray(val) && val.kind === "date";
}

export function isFormulaRowRef(val: FormulaValue): val is FormulaRowRefValue {
  return typeof val === "object" && val !== null && !Array.isArray(val) && val.kind === "row";
}

export function isFormulaTableRef(val: FormulaValue): val is FormulaTableRefValue {
  return typeof val === "object" && val !== null && !Array.isArray(val) && val.kind === "table";
}

function makeError(code: FormulaErrorCode, message: string): FormulaErrorValue {
  return { kind: "error", code, message };
}

export function makeDateValue(ms: number, hasTime: boolean): FormulaDateValue {
  return { kind: "date", ms, hasTime };
}

function toLocalMidnightMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function parseDateString(raw: string): FormulaDateValue | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // YYYY-MM-DD or YYYY/MM/DD
  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]) - 1;
    const d = Number(ymd[3]);
    const dt = new Date(y, m, d);
    if (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d) {
      return makeDateValue(dt.getTime(), false);
    }
    return null;
  }

  // MM/DD/YYYY
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (mdy) {
    const m = Number(mdy[1]) - 1;
    const d = Number(mdy[2]);
    const y = Number(mdy[3]);
    const dt = new Date(y, m, d);
    if (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d) {
      return makeDateValue(dt.getTime(), false);
    }
    return null;
  }

  // YYYY-MM-DD HH:mm[:ss] or ISO
  const ymdTime = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (ymdTime) {
    const y = Number(ymdTime[1]);
    const m = Number(ymdTime[2]) - 1;
    const d = Number(ymdTime[3]);
    const hh = Number(ymdTime[4]);
    const mm = Number(ymdTime[5]);
    const ss = ymdTime[6] ? Number(ymdTime[6]) : 0;
    const dt = new Date(y, m, d, hh, mm, ss);
    if (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d) {
      return makeDateValue(dt.getTime(), true);
    }
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    const hasTime = /[T ]\d{1,2}:\d{2}/.test(trimmed);
    return makeDateValue(parsed, hasTime);
  }
  return null;
}

function toDateValue(val: FormulaValue): FormulaDateValue | FormulaErrorValue | null {
  if (isFormulaError(val)) return val;
  if (val === null || val === "") return null;
  if (isFormulaDate(val)) return val;
  if (typeof val === "number" && Number.isFinite(val)) {
    // Timestamps > 1e10 treated as epoch ms; otherwise Excel serial days (1899-12-30 base)
    if (Math.abs(val) >= 1e10) {
      return makeDateValue(val, true);
    }
    const base = new Date(1899, 11, 30);
    return makeDateValue(addDays(base, Math.trunc(val)).getTime() + (val % 1) * MS_PER_DAY, val % 1 !== 0);
  }
  if (typeof val === "string") {
    const parsed = parseDateString(val);
    if (parsed) return parsed;
    return makeError("#VALUE!", `无法解析日期：${val}`);
  }
  return makeError("#VALUE!", "参数不是有效的日期值");
}

function addDaysToDate(date: FormulaDateValue, days: number): FormulaDateValue {
  if (!date.hasTime && Number.isInteger(days)) {
    const next = addDays(new Date(date.ms), days);
    return makeDateValue(toLocalMidnightMs(next), false);
  }
  return makeDateValue(date.ms + days * MS_PER_DAY, date.hasTime || !Number.isInteger(days));
}

function diffDatesInDays(left: FormulaDateValue, right: FormulaDateValue): number {
  if (!left.hasTime && !right.hasTime) {
    return differenceInCalendarDays(new Date(left.ms), new Date(right.ms));
  }
  return (left.ms - right.ms) / MS_PER_DAY;
}

function isBlankValue(val: FormulaValue): boolean {
  if (val === null) return true;
  if (typeof val === "string") return val.length === 0;
  if (Array.isArray(val)) return val.length === 0;
  return false;
}

function toNumber(val: FormulaValue): number | FormulaErrorValue {
  if (isFormulaError(val)) return val;
  if (val === null || val === "") return 0;
  if (typeof val === "number") {
    return Number.isFinite(val) ? val : makeError("#NUM!", "数值超出范围");
  }
  if (typeof val === "boolean") return val ? 1 : 0;
  if (isFormulaDate(val)) return val.ms / MS_PER_DAY;
  if (typeof val === "string") {
    const cleaned = val.trim().replace(/,/g, "");
    if (!cleaned) return 0;
    if (cleaned.endsWith("%")) {
      const pct = Number(cleaned.slice(0, -1));
      if (Number.isFinite(pct)) return pct / 100;
    }
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
    return makeError("#VALUE!", `无法转换为数字：${val}`);
  }
  return makeError("#VALUE!", "无法将列表或对象转换为数字");
}

function toBoolean(val: FormulaValue): boolean | FormulaErrorValue {
  if (isFormulaError(val)) return val;
  if (val === null) return false;
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") {
    const lower = val.trim().toLowerCase();
    if (lower === "" || lower === "false" || lower === "0") return false;
    return true;
  }
  if (Array.isArray(val)) return val.length > 0;
  if (isFormulaDate(val)) return Number.isFinite(val.ms);
  if (isFormulaRowRef(val)) return true;
  return true;
}

function toText(val: FormulaValue): string | FormulaErrorValue {
  if (isFormulaError(val)) return val;
  if (val === null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return formatDefaultNumber(val);
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  if (isFormulaDate(val)) return formatDateByPattern(val.ms, val.hasTime ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD");
  if (isFormulaRowRef(val)) return val.label;
  if (Array.isArray(val)) {
    const parts: string[] = [];
    for (const item of val) {
      const t = toText(item);
      if (isFormulaError(t)) return t;
      if (t !== "") parts.push(t);
    }
    return parts.join(", ");
  }
  return "";
}

function flattenValues(args: readonly FormulaValue[]): FormulaValue[] {
  const out: FormulaValue[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const item of flattenValues(arg)) {
        out.push(item);
      }
    } else {
      out.push(arg);
    }
  }
  return out;
}

export function formatDefaultNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (Object.is(n, -0)) return "0";
  // Avoid floating point noise like 0.30000000000000004
  const rounded = Number(n.toPrecision(12));
  return String(rounded);
}

const WEEKDAY_ZH_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAY_ZH_FULL = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function formatDateByPattern(ms: number, pattern: string): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  const pad2 = (v: number) => String(v).padStart(2, "0");
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const dow = date.getDay();

  // Single-pass token replacement so replaced Chinese/text never gets re-matched
  return pattern.replace(/YYYY|yyyy|YY|yy|MM|M|DDDD|dddd|DDD|ddd|DD|dd|D|d|HH|H|mm|m|ss|s/g, (token) => {
    switch (token) {
      case "YYYY":
      case "yyyy":
        return String(year);
      case "YY":
      case "yy":
        return String(year).slice(-2);
      case "MM":
        return pad2(month);
      case "M":
        return String(month);
      case "DDDD":
      case "dddd":
        return WEEKDAY_ZH_FULL[dow];
      case "DDD":
      case "ddd":
        return WEEKDAY_ZH_SHORT[dow];
      case "DD":
      case "dd":
        return pad2(day);
      case "D":
      case "d":
        return String(day);
      case "HH":
        return pad2(hours);
      case "H":
        return String(hours);
      case "mm":
        return pad2(minutes);
      case "m":
        return String(minutes);
      case "ss":
        return pad2(seconds);
      case "s":
        return String(seconds);
      default:
        return token;
    }
  });
}

export function formatNumberByPattern(num: number, pattern: string): string {
  if (!Number.isFinite(num)) return "";
  const trimmed = pattern.trim();
  if (!trimmed) return formatDefaultNumber(num);

  if (trimmed.endsWith("%")) {
    const body = trimmed.slice(0, -1);
    const dotIdx = body.indexOf(".");
    const decimals = dotIdx >= 0 ? body.slice(dotIdx + 1).replace(/[^0#]/g, "").length : 0;
    return `${(num * 100).toFixed(decimals)}%`;
  }

  const useThousands = trimmed.includes(",");
  const dotIdx = trimmed.indexOf(".");
  const decimals = dotIdx >= 0 ? trimmed.slice(dotIdx + 1).replace(/[^0#]/g, "").length : 0;
  const fixed = num.toFixed(decimals);
  if (!useThousands) return fixed;

  const [intPart, fracPart] = fixed.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart !== undefined ? `${withCommas}.${fracPart}` : withCommas;
}

function isDateFormatPattern(pattern: string): boolean {
  return /(YYYY|yyyy|YY|yy|MM|DD|dd|DDDD|dddd|DDD|ddd|HH|mm|ss)/.test(pattern);
}

function scalarEquals(a: FormulaValue, b: FormulaValue, strict: boolean): boolean {
  if (a === b) return true;
  if (a === null && b === null) return true;
  if (!strict) {
    if ((a === null && b === "") || (a === "" && b === null)) return true;
  }
  if (isFormulaRowRef(a) && isFormulaRowRef(b)) {
    return a.uuid === b.uuid;
  }
  if (isFormulaRowRef(a) && typeof b === "string") {
    return a.label === b || a.uuid === b;
  }
  if (typeof a === "string" && isFormulaRowRef(b)) {
    return b.label === a || b.uuid === a;
  }
  if (isFormulaDate(a) && isFormulaDate(b)) {
    return a.ms === b.ms;
  }
  if (isFormulaDate(a) && typeof b === "string") {
    const parsed = parseDateString(b);
    return parsed ? a.ms === parsed.ms : false;
  }
  if (typeof a === "string" && isFormulaDate(b)) {
    const parsed = parseDateString(a);
    return parsed ? parsed.ms === b.ms : false;
  }
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-12;
  }
  if (!strict) {
    if (typeof a === "string" && typeof b === "string") {
      return a === b;
    }
    if ((typeof a === "number" && typeof b === "string") || (typeof a === "string" && typeof b === "number")) {
      const sa = String(a).trim();
      const sb = String(b).trim();
      if (sa === "" || sb === "") return false;
      const na = Number(sa);
      const nb = Number(sb);
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        return Math.abs(na - nb) < 1e-12;
      }
    }
  }
  return false;
}

function valueKeyForSet(val: FormulaValue): string {
  if (val === null) return "null:";
  if (typeof val === "number") return `num:${Number(val.toPrecision(12))}`;
  if (typeof val === "string") return `str:${val}`;
  if (typeof val === "boolean") return `bool:${val}`;
  if (isFormulaDate(val)) return `date:${val.ms}`;
  if (isFormulaRowRef(val)) return `row:${val.uuid}:${val.label}`;
  if (Array.isArray(val)) return `arr:[${val.map(valueKeyForSet).join(",")}]`;
  return `other:${String(val)}`;
}

export function valuesEqual(a: FormulaValue, b: FormulaValue, strict: boolean): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    if (strict) {
      return a.every((item, idx) => valuesEqual(item, b[idx], true));
    }
    // Order-insensitive multiset comparison (matches smart-sheet `!=` spec for lists)
    const used = new Array<boolean>(b.length).fill(false);
    for (const itemA of a) {
      let matched = false;
      for (let j = 0; j < b.length; j++) {
        if (!used[j] && valuesEqual(itemA, b[j], false)) {
          used[j] = true;
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return false;
  }
  return scalarEquals(a, b, strict);
}

function compareValues(a: FormulaValue, b: FormulaValue): number | null | FormulaErrorValue {
  if (isFormulaError(a)) return a;
  if (isFormulaError(b)) return b;

  // Date comparison: blank date NEVER satisfies <, <=, >, >= against a real date
  if (isFormulaDate(a) || isFormulaDate(b)) {
    if (a === null || a === "" || b === null || b === "") return null;
    const da = toDateValue(a);
    const db = toDateValue(b);
    if (!da || !db) return null;
    if (isFormulaError(da)) return da;
    if (isFormulaError(db)) return db;
    return da.ms - db.ms;
  }

  if (a === null && b === null) return 0;

  if (typeof a === "number" || typeof b === "number") {
    if (a === null || b === null) return null;
    const na = toNumber(a);
    const nb = toNumber(b);
    if (isFormulaError(na)) return na;
    if (isFormulaError(nb)) return nb;
    return na - nb;
  }

  const sa = toText(a);
  const sb = toText(b);
  if (isFormulaError(sa)) return sa;
  if (isFormulaError(sb)) return sb;
  return sa.localeCompare(sb);
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind =
  | "number"
  | "string"
  | "colRef"
  | "braceRef"
  | "ident"
  | "op"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "dot"
  | "eof";

interface FormulaToken {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$\u00c0-\uffff]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$\u00c0-\uffff]/.test(ch);
}

function tokenize(source: string): { tokens: FormulaToken[]; error?: { message: string; start: number; end: number } } {
  const tokens: FormulaToken[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comment // ...
    if (ch === "/" && source[i + 1] === "/") {
      while (i < len && source[i] !== "\n") i++;
      continue;
    }

    // Canonical column / table ref: {{col_xxx}} or {{updatedAt}} or {{__table__}}
    if (ch === "{" && source[i + 1] === "{") {
      const start = i;
      const closeIdx = source.indexOf("}}", i + 2);
      if (closeIdx === -1) {
        return { tokens, error: { message: "列引用缺少结束符号 }}", start, end: len } };
      }
      const refId = source.slice(i + 2, closeIdx).trim();
      if (!refId) {
        return { tokens, error: { message: "列引用不能为空", start, end: closeIdx + 2 } };
      }
      tokens.push({ kind: "colRef", value: refId, start, end: closeIdx + 2 });
      i = closeIdx + 2;
      continue;
    }

    // Human-friendly {Column Name} ref
    if (ch === "{") {
      const start = i;
      const closeIdx = source.indexOf("}", i + 1);
      if (closeIdx === -1) {
        return { tokens, error: { message: "字段引用缺少结束符号 }", start, end: len } };
      }
      const name = source.slice(i + 1, closeIdx).trim();
      if (!name) {
        return { tokens, error: { message: "字段引用不能为空", start, end: closeIdx + 1 } };
      }
      tokens.push({ kind: "braceRef", value: name, start, end: closeIdx + 1 });
      i = closeIdx + 1;
      continue;
    }

    // String literal "..." or '...'
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      let str = "";
      let closed = false;
      while (i < len) {
        const c = source[i];
        if (c === "\\" && i + 1 < len) {
          const next = source[i + 1];
          if (next === "n") str += "\n";
          else if (next === "t") str += "\t";
          else if (next === "r") str += "\r";
          else str += next;
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          closed = true;
          break;
        }
        str += c;
        i++;
      }
      if (!closed) {
        return { tokens, error: { message: "字符串缺少结束引号", start, end: len } };
      }
      tokens.push({ kind: "string", value: str, start, end: i });
      continue;
    }

    // Number literal
    if (/[0-9]/.test(ch) || (ch === "." && i + 1 < len && /[0-9]/.test(source[i + 1]))) {
      const start = i;
      let hasDot = ch === ".";
      i++;
      while (i < len) {
        const c = source[i];
        if (/[0-9]/.test(c)) {
          i++;
        } else if (c === "." && !hasDot) {
          hasDot = true;
          i++;
        } else {
          break;
        }
      }
      // Optional scientific notation 1e5, 1.2e-3
      if (i < len && (source[i] === "e" || source[i] === "E")) {
        let j = i + 1;
        if (j < len && (source[j] === "+" || source[j] === "-")) j++;
        if (j < len && /[0-9]/.test(source[j])) {
          i = j + 1;
          while (i < len && /[0-9]/.test(source[i])) i++;
        }
      }
      tokens.push({ kind: "number", value: source.slice(start, i), start, end: i });
      continue;
    }

    // Multi-char operators: !==, ==, !=, <=, >=, <>
    const three = source.slice(i, i + 3);
    if (three === "!==") {
      tokens.push({ kind: "op", value: "!==", start: i, end: i + 3 });
      i += 3;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "<>") {
      tokens.push({ kind: "op", value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }

    // Single-char operators & punctuation
    if ("+-*/^&=<>!".includes(ch)) {
      tokens.push({ kind: "op", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "[") {
      tokens.push({ kind: "lbracket", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "]") {
      tokens.push({ kind: "rbracket", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "," || ch === "，") {
      tokens.push({ kind: "comma", value: ",", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ".") {
      tokens.push({ kind: "dot", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }

    // Identifiers (functions, TRUE/FALSE/NULL, current)
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentPart(source[i])) i++;
      tokens.push({ kind: "ident", value: source.slice(start, i), start, end: i });
      continue;
    }

    return { tokens, error: { message: `无法识别的字符：${ch}`, start: i, end: i + 1 } };
  }

  tokens.push({ kind: "eof", value: "", start: len, end: len });
  return { tokens };
}

// ---------------------------------------------------------------------------
// Recursive Descent Parser
// ---------------------------------------------------------------------------

class ParseFailure extends Error {
  public readonly start: number;
  public readonly end: number;
  constructor(message: string, start: number, end: number) {
    super(message);
    this.start = start;
    this.end = end;
  }
}

const MAX_FORMULA_AST_CACHE = 512;
const formulaAstCache = new Map<string, FormulaParseResult>();

/**
 * 按公式源码文本缓存 AST 解析结果（FIFO 限容），消除高频重复词法与语法分析开销。
 */
export function parseFormulaCached(rawSource: string): FormulaParseResult {
  const key = rawSource.trim();
  const cached = formulaAstCache.get(key);
  if (cached) {
    return cached;
  }
  const parsed = parseFormula(key);
  if (formulaAstCache.size >= MAX_FORMULA_AST_CACHE) {
    const oldestKey = formulaAstCache.keys().next().value;
    if (oldestKey !== undefined) {
      formulaAstCache.delete(oldestKey);
    }
  }
  formulaAstCache.set(key, parsed);
  return parsed;
}

export function clearFormulaAstCache(): void {
  formulaAstCache.clear();
}

export function parseFormula(rawSource: string): FormulaParseResult {
  const source = rawSource.trim();
  if (!source) {
    return { ast: null };
  }
  // Allow optional leading "=" just like Excel
  const normalizedSource = source.startsWith("=") ? source.slice(1) : source;
  if (!normalizedSource.trim()) {
    return { ast: null };
  }

  const lexed = tokenize(normalizedSource);
  if (lexed.error) {
    return {
      ast: null,
      error: {
        code: "#SYNTAX!",
        message: lexed.error.message,
        start: lexed.error.start,
        end: lexed.error.end,
      },
    };
  }

  const tokens = lexed.tokens;
  let pos = 0;

  const peek = (): FormulaToken => tokens[pos];
  const next = (): FormulaToken => tokens[pos++];

  const expect = (kind: TokenKind, message: string): FormulaToken => {
    const tok = peek();
    if (tok.kind !== kind) {
      throw new ParseFailure(message, tok.start, tok.end);
    }
    return next();
  };

  const parseExpression = (): FormulaAstNode => parseComparison();

  const parseComparison = (): FormulaAstNode => {
    let left = parseConcat();
    while (peek().kind === "op" && ["=", "==", "!=", "!==", "<>", "<", "<=", ">", ">="].includes(peek().value)) {
      const opTok = next();
      const right = parseConcat();
      left = {
        type: "binary",
        op: opTok.value as FormulaBinaryOp,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  };

  const parseConcat = (): FormulaAstNode => {
    let left = parseAdditive();
    while (peek().kind === "op" && peek().value === "&") {
      next();
      const right = parseAdditive();
      left = {
        type: "binary",
        op: "&",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  };

  const parseAdditive = (): FormulaAstNode => {
    let left = parseMultiplicative();
    while (peek().kind === "op" && (peek().value === "+" || peek().value === "-")) {
      const opTok = next();
      const right = parseMultiplicative();
      left = {
        type: "binary",
        op: opTok.value as "+" | "-",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  };

  const parseMultiplicative = (): FormulaAstNode => {
    let left = parsePower();
    while (peek().kind === "op" && (peek().value === "*" || peek().value === "/")) {
      const opTok = next();
      const right = parsePower();
      left = {
        type: "binary",
        op: opTok.value as "*" | "/",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  };

  const parsePower = (): FormulaAstNode => {
    const left = parseUnary();
    if (peek().kind === "op" && peek().value === "^") {
      next();
      const right = parsePower(); // right-associative
      return {
        type: "binary",
        op: "^",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  };

  const parseUnary = (): FormulaAstNode => {
    if (peek().kind === "op" && (peek().value === "+" || peek().value === "-" || peek().value === "!")) {
      const opTok = next();
      const arg = parseUnary();
      return {
        type: "unary",
        op: opTok.value as FormulaUnaryOp,
        arg,
        start: opTok.start,
        end: arg.end,
      };
    }
    return parsePostfix();
  };

  const parseArgList = (): { args: FormulaAstNode[]; end: number } => {
    const args: FormulaAstNode[] = [];
    if (peek().kind === "rparen") {
      const endTok = next();
      return { args, end: endTok.end };
    }
    while (true) {
      args.push(parseExpression());
      if (peek().kind === "comma") {
        next();
        continue;
      }
      const endTok = expect("rparen", "函数参数缺少右括号 )");
      return { args, end: endTok.end };
    }
  };

  const parsePostfix = (): FormulaAstNode => {
    let expr = parsePrimary();
    while (peek().kind === "dot") {
      next(); // consume '.'
      const memberTok = peek();
      if (memberTok.kind === "colRef") {
        next();
        expr = {
          type: "member",
          receiver: expr,
          propRefId: memberTok.value,
          propName: memberTok.value,
          start: expr.start,
          end: memberTok.end,
        };
      } else if (memberTok.kind === "braceRef") {
        next();
        expr = {
          type: "member",
          receiver: expr,
          propName: memberTok.value,
          propStart: memberTok.start,
          propEnd: memberTok.end,
          start: expr.start,
          end: memberTok.end,
        };
      } else if (memberTok.kind === "lbracket") {
        // e.g. [子节点].[掌握程度]
        const startBracket = next();
        const innerTokens: FormulaToken[] = [];
        while (peek().kind !== "rbracket" && peek().kind !== "eof") {
          innerTokens.push(next());
        }
        const closeBracket = expect("rbracket", "属性引用缺少右括号 ]");
        const propName = normalizedSource.slice(startBracket.end, closeBracket.start).trim();
        if (!propName) {
          throw new ParseFailure("属性引用不能为空", startBracket.start, closeBracket.end);
        }
        expr = {
          type: "member",
          receiver: expr,
          propName,
          propStart: startBracket.start,
          propEnd: closeBracket.end,
          start: expr.start,
          end: closeBracket.end,
        };
      } else if (memberTok.kind === "ident") {
        next();
        if (peek().kind === "lparen") {
          next();
          const { args, end } = parseArgList();
          expr = {
            type: "methodCall",
            receiver: expr,
            method: memberTok.value.toUpperCase(),
            args,
            start: expr.start,
            end,
          };
        } else {
          expr = {
            type: "member",
            receiver: expr,
            propName: memberTok.value,
            start: expr.start,
            end: memberTok.end,
          };
        }
      } else {
        throw new ParseFailure("点号 . 后需要字段引用或方法名", memberTok.start, memberTok.end);
      }
    }
    return expr;
  };

  const parsePrimary = (): FormulaAstNode => {
    const tok = peek();

    if (tok.kind === "number") {
      next();
      return { type: "number", value: Number(tok.value), start: tok.start, end: tok.end };
    }

    if (tok.kind === "string") {
      next();
      return { type: "string", value: tok.value, start: tok.start, end: tok.end };
    }

    if (tok.kind === "colRef") {
      next();
      if (tok.value === FORMULA_TABLE_REF_ID) {
        return { type: "tableRef", start: tok.start, end: tok.end };
      }
      return { type: "colRef", refId: tok.value, raw: `{{${tok.value}}}`, start: tok.start, end: tok.end };
    }

    if (tok.kind === "braceRef") {
      next();
      if (TABLE_REF_ALIASES.has(tok.value)) {
        return { type: "tableRef", start: tok.start, end: tok.end };
      }
      return { type: "nameRef", name: tok.value, raw: `{${tok.value}}`, start: tok.start, end: tok.end };
    }

    if (tok.kind === "lparen") {
      next();
      const inner = parseExpression();
      expect("rparen", "表达式缺少右括号 )");
      return inner;
    }

    if (tok.kind === "lbracket") {
      const startTok = next();
      if (peek().kind === "rbracket") {
        const endTok = next();
        return { type: "array", elements: [], start: startTok.start, end: endTok.end };
      }
      // Disambiguate `[字段名]` vs array literal `[1, 2, 3]` / `["a", "b"]`:
      // If between `[` and matching `]` there is a single identifier-like name (possibly with spaces/digits)
      // and NO commas/strings/operators/parens and it doesn't start with a number, parse as nameRef.
      const savedPos = pos;
      let looksLikeColumnName = true;
      let tokCount = 0;
      while (pos < tokens.length && tokens[pos].kind !== "rbracket" && tokens[pos].kind !== "eof") {
        const t = tokens[pos];
        if (
          t.kind === "comma" ||
          t.kind === "string" ||
          t.kind === "op" ||
          t.kind === "lparen" ||
          t.kind === "lbracket" ||
          t.kind === "dot"
        ) {
          looksLikeColumnName = false;
          break;
        }
        if (tokCount === 0 && t.kind === "number") {
          looksLikeColumnName = false;
          break;
        }
        tokCount++;
        pos++;
      }
      if (looksLikeColumnName && tokCount > 0 && tokens[pos]?.kind === "rbracket") {
        const closeTok = tokens[pos];
        const rawName = normalizedSource.slice(startTok.end, closeTok.start).trim();
        const upper = rawName.toUpperCase();
        // Keep `[TRUE]` / `[FALSE]` as array literals if someone writes them, otherwise column/table ref
        if (rawName && upper !== "TRUE" && upper !== "FALSE" && upper !== "NULL") {
          pos++; // consume rbracket
          if (TABLE_REF_ALIASES.has(rawName)) {
            return { type: "tableRef", start: startTok.start, end: closeTok.end };
          }
          return {
            type: "nameRef",
            name: rawName,
            raw: `[${rawName}]`,
            start: startTok.start,
            end: closeTok.end,
          };
        }
      }
      // Restore and parse as array literal
      pos = savedPos;
      const elements: FormulaAstNode[] = [];
      while (true) {
        elements.push(parseExpression());
        if (peek().kind === "comma") {
          next();
          continue;
        }
        const closeTok = expect("rbracket", "列表缺少右括号 ]");
        return { type: "array", elements, start: startTok.start, end: closeTok.end };
      }
    }

    if (tok.kind === "ident") {
      next();
      const upper = tok.value.toUpperCase();
      if (peek().kind === "lparen") {
        next();
        const { args, end } = parseArgList();
        return { type: "call", callee: upper, args, start: tok.start, end };
      }
      if (upper === "TRUE") {
        return { type: "boolean", value: true, start: tok.start, end: tok.end };
      }
      if (upper === "FALSE") {
        return { type: "boolean", value: false, start: tok.start, end: tok.end };
      }
      if (upper === "NULL") {
        return { type: "null", start: tok.start, end: tok.end };
      }
      if (TABLE_REF_ALIASES.has(tok.value) || TABLE_REF_ALIASES.has(upper)) {
        return { type: "tableRef", start: tok.start, end: tok.end };
      }
      return { type: "ident", name: tok.value, start: tok.start, end: tok.end };
    }

    throw new ParseFailure(tok.kind === "eof" ? "公式不完整" : `意外的符号：${tok.value}`, tok.start, tok.end);
  };

  try {
    const ast = parseExpression();
    if (peek().kind !== "eof") {
      const leftover = peek();
      return {
        ast: null,
        error: {
          code: "#SYNTAX!",
          message: `意外的多余符号：${leftover.value}`,
          start: leftover.start,
          end: leftover.end,
        },
      };
    }
    return { ast };
  } catch (err) {
    if (err instanceof ParseFailure) {
      return {
        ast: null,
        error: {
          code: "#SYNTAX!",
          message: err.message,
          start: err.start,
          end: err.end,
        },
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Column Name Resolution & AST Analysis
// ---------------------------------------------------------------------------

export function buildColumnNameToIdMap(lookup: FormulaColumnLookup): Map<string, string> {
  const map = new Map<string, string>();

  // System columns: exact ID, custom renamed label, localized label, default aliases
  for (const sysId of ALL_SYSTEM_COLUMN_IDS) {
    map.set(sysId, sysId);
    const customLabel = lookup.systemColumnNames?.[sysId]?.trim();
    if (customLabel) map.set(customLabel, sysId);
    const i18nLabel = lookup.systemColumnLabels?.[sysId]?.trim();
    if (i18nLabel && !map.has(i18nLabel)) map.set(i18nLabel, sysId);
    for (const alias of DEFAULT_SYSTEM_LABELS[sysId]) {
      if (!map.has(alias)) map.set(alias, sysId);
    }
  }

  // Custom columns (override default aliases if user explicitly named a custom column the same)
  for (const col of lookup.columns) {
    map.set(col.id, col.id);
    if (col.name.trim()) {
      map.set(col.name.trim(), col.id);
    }
  }

  return map;
}

export function resolveColumnRefId(
  rawRef: string,
  validIds: ReadonlySet<string>,
  nameToId: ReadonlyMap<string, string>,
): string | null {
  if (validIds.has(rawRef)) return rawRef;
  const byName = nameToId.get(rawRef.trim());
  return byName ?? null;
}

/**
 * Replaces human-typed `[列名]` / `{列名}` references with stable `{{col_id}}` tokens
 * while preserving strings and numeric array literals `[1, 2, 3]`.
 */
export function normalizeFormulaColumnRefs(source: string, lookup: FormulaColumnLookup): string {
  const validIds = new Set<string>([...ALL_SYSTEM_COLUMN_IDS, ...lookup.columns.map((c) => c.id)]);
  const nameToId = buildColumnNameToIdMap(lookup);
  const parsed = parseFormula(source);
  if (!parsed.ast) return source;

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const leadingEqOffset = source.trimStart().startsWith("=") ? source.indexOf("=") + 1 : 0;

  const visit = (node: FormulaAstNode) => {
    switch (node.type) {
      case "nameRef": {
        const resolved = resolveColumnRefId(node.name, validIds, nameToId);
        if (resolved) {
          replacements.push({
            start: node.start + leadingEqOffset,
            end: node.end + leadingEqOffset,
            text: `{{${resolved}}}`,
          });
        }
        break;
      }
      case "member":
        visit(node.receiver);
        if (!node.propRefId && node.propStart !== undefined && node.propEnd !== undefined) {
          const resolved = resolveColumnRefId(node.propName, validIds, nameToId);
          if (resolved) {
            replacements.push({
              start: node.propStart + leadingEqOffset,
              end: node.propEnd + leadingEqOffset,
              text: `{{${resolved}}}`,
            });
          }
        }
        break;
      case "array":
        for (const el of node.elements) visit(el);
        break;
      case "unary":
        visit(node.arg);
        break;
      case "binary":
        visit(node.left);
        visit(node.right);
        break;
      case "call":
        for (const arg of node.args) visit(arg);
        break;
      case "methodCall":
        visit(node.receiver);
        for (const arg of node.args) visit(arg);
        break;
      default:
        break;
    }
  };

  // Use source directly only if no leading whitespace skew
  if (source === source.trimStart()) {
    visit(parsed.ast);
  }
  if (replacements.length === 0) return source;
  replacements.sort((a, b) => b.start - a.start);
  let out = source;
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}

const RELATION_SYSTEM_COLUMNS = new Set<string>(["parents", "children", "outer", "inner"]);

export function analyzeFormulaAst(
  ast: FormulaAstNode | null,
  lookup: FormulaColumnLookup,
): {
  dependencies: string[];
  missingRefs: string[];
  volatile: boolean;
  usesTableRef: boolean;
  usesRelationTraversal: boolean;
  dependsOnRelations: boolean;
} {
  const dependencies = new Set<string>();
  const missingRefs = new Set<string>();
  let volatile = false;
  let usesTableRef = false;
  let usesRelationTraversal = false;
  if (!ast) {
    return {
      dependencies: [],
      missingRefs: [],
      volatile: false,
      usesTableRef: false,
      usesRelationTraversal: false,
      dependsOnRelations: false,
    };
  }

  const validIds = new Set<string>([...ALL_SYSTEM_COLUMN_IDS, ...lookup.columns.map((c) => c.id)]);
  const nameToId = buildColumnNameToIdMap(lookup);

  const walk = (node: FormulaAstNode, inFilterScope: boolean) => {
    switch (node.type) {
      case "tableRef": {
        usesTableRef = true;
        break;
      }
      case "colRef": {
        if (validIds.has(node.refId)) {
          dependencies.add(node.refId);
        } else {
          missingRefs.add(node.refId);
        }
        break;
      }
      case "nameRef": {
        const resolved = resolveColumnRefId(node.name, validIds, nameToId);
        if (resolved) {
          dependencies.add(resolved);
        } else {
          missingRefs.add(node.name);
        }
        break;
      }
      case "ident": {
        if (!inFilterScope || !CURRENT_ITEM_ALIASES.has(node.name.toLowerCase())) {
          const resolved = resolveColumnRefId(node.name, validIds, nameToId);
          if (resolved) dependencies.add(resolved);
        }
        break;
      }
      case "member": {
        usesRelationTraversal = true;
        walk(node.receiver, inFilterScope);
        const refCandidate = node.propRefId ?? node.propName;
        const resolved = resolveColumnRefId(refCandidate, validIds, nameToId);
        if (resolved) {
          dependencies.add(resolved);
        } else if (node.propRefId) {
          missingRefs.add(node.propRefId);
        }
        break;
      }
      case "array":
        for (const el of node.elements) walk(el, inFilterScope);
        break;
      case "unary":
        walk(node.arg, inFilterScope);
        break;
      case "binary":
        walk(node.left, inFilterScope);
        walk(node.right, inFilterScope);
        break;
      case "call": {
        if (VOLATILE_FUNCTIONS.has(node.callee)) volatile = true;
        const nextFilterScope = inFilterScope || node.callee === "FILTER" || node.callee === "COUNTIF";
        for (const arg of node.args) walk(arg, nextFilterScope);
        break;
      }
      case "methodCall": {
        if (VOLATILE_FUNCTIONS.has(node.method)) volatile = true;
        walk(node.receiver, inFilterScope);
        const nextFilterScope = inFilterScope || node.method === "FILTER" || node.method === "COUNTIF";
        for (const arg of node.args) walk(arg, nextFilterScope);
        break;
      }
      default:
        break;
    }
  };

  walk(ast, false);
  const depArr = Array.from(dependencies);
  const dependsOnRelations = depArr.some((id) => RELATION_SYSTEM_COLUMNS.has(id));
  return {
    dependencies: depArr,
    missingRefs: Array.from(missingRefs),
    volatile,
    usesTableRef,
    usesRelationTraversal,
    dependsOnRelations,
  };
}

export function hasVolatileFormulas(columns: readonly TableColumnSchema[]): boolean {
  for (const col of columns) {
    if (col.type !== "formula" || !col.formula?.trim()) continue;
    const parsed = parseFormulaCached(col.formula);
    if (!parsed.ast) continue;
    const analysis = analyzeFormulaAst(parsed.ast, { columns });
    if (analysis.volatile) return true;
  }
  return false;
}

export function validateColumnFormula(
  columnId: string,
  formulaSource: string,
  lookup: FormulaColumnLookup,
): FormulaValidationResult {
  const trimmed = formulaSource.trim();
  if (!trimmed) {
    return { valid: true, dependencies: [], hasCycle: false, missingRefs: [], volatile: false };
  }

  const parsed = parseFormula(trimmed);
  if (parsed.error || !parsed.ast) {
    return {
      valid: false,
      errorCode: parsed.error?.code ?? "#SYNTAX!",
      errorMessage: parsed.error?.message ?? "公式语法错误",
      dependencies: [],
      hasCycle: false,
      missingRefs: [],
      volatile: false,
    };
  }

  const analysis = analyzeFormulaAst(parsed.ast, lookup);
  if (analysis.missingRefs.length > 0) {
    return {
      valid: false,
      errorCode: "#REF!",
      errorMessage: `引用了不存在或已删除的列：${analysis.missingRefs.join(", ")}`,
      dependencies: analysis.dependencies,
      hasCycle: false,
      missingRefs: analysis.missingRefs,
      volatile: analysis.volatile,
    };
  }

  // Check cycle in formula dependency graph including this candidate formula
  const depGraph = new Map<string, string[]>();
  for (const col of lookup.columns) {
    if (col.id === columnId) continue;
    if (col.type === "formula" && col.formula?.trim()) {
      const p = parseFormula(col.formula);
      depGraph.set(col.id, p.ast ? analyzeFormulaAst(p.ast, lookup).dependencies : []);
    }
  }
  depGraph.set(columnId, analysis.dependencies);

  const visited = new Set<string>();
  const dfsHasCycle = (curr: string): boolean => {
    const deps = depGraph.get(curr) ?? [];
    for (const dep of deps) {
      if (dep === columnId) return true;
      if (!visited.has(dep) && depGraph.has(dep)) {
        visited.add(dep);
        if (dfsHasCycle(dep)) return true;
      }
    }
    return false;
  };

  if (dfsHasCycle(columnId)) {
    return {
      valid: false,
      errorCode: "#CYCLE!",
      errorMessage: "检测到循环引用：公式直接或间接引用了当前列",
      dependencies: analysis.dependencies,
      hasCycle: true,
      missingRefs: [],
      volatile: analysis.volatile,
    };
  }

  return {
    valid: true,
    dependencies: analysis.dependencies,
    hasCycle: false,
    missingRefs: [],
    volatile: analysis.volatile,
  };
}

// ---------------------------------------------------------------------------
// Built-in Function Implementations (~66 Functions across 5 Categories)
// ---------------------------------------------------------------------------

interface EvalContext {
  row: TableFilterSortRow;
  allRows: readonly TableFilterSortRow[];
  rowByUuid: ReadonlyMap<string, TableFilterSortRow>;
  columns: readonly TableColumnSchema[];
  colById: ReadonlyMap<string, TableColumnSchema>;
  validColumnIds: ReadonlySet<string>;
  nameToId: ReadonlyMap<string, string>;
  now: Date;
  readCellValue: (rowUuid: string, colId: string) => FormulaValue;
  currentItem?: FormulaValue;
}

function evalCriteriaMatch(item: FormulaValue, criteria: FormulaValue): boolean {
  if (typeof criteria === "string") {
    const m = /^(<=|>=|<>|!=|=|<|>)(.*)$/.exec(criteria.trim());
    if (m) {
      const op = m[1];
      const rhsRaw = m[2].trim();
      const rhsNum = Number(rhsRaw);
      const rhsVal: FormulaValue =
        rhsRaw !== "" && Number.isFinite(rhsNum) ? rhsNum : (parseDateString(rhsRaw) ?? rhsRaw);
      if (op === "=") return valuesEqual(item, rhsVal, false);
      if (op === "<>" || op === "!=") return !valuesEqual(item, rhsVal, false);
      const cmp = compareValues(item, rhsVal);
      if (cmp === null || typeof cmp !== "number") return false;
      if (op === "<") return cmp < 0;
      if (op === "<=") return cmp <= 0;
      if (op === ">") return cmp > 0;
      if (op === ">=") return cmp >= 0;
    }
    if (criteria.includes("*") || criteria.includes("?")) {
      const text = toText(item);
      if (isFormulaError(text)) return false;
      const escaped = criteria
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(`^${escaped}$`, "i").test(text);
    }
  }
  return valuesEqual(item, criteria, false);
}

function toWorkingDaySet(holidaysVal?: FormulaValue): Set<number> {
  const set = new Set<number>();
  if (!holidaysVal) return set;
  for (const item of flattenValues([holidaysVal])) {
    const d = toDateValue(item);
    if (d && !isFormulaError(d)) {
      set.add(toLocalMidnightMs(new Date(d.ms)));
    }
  }
  return set;
}

function isWeekend(date: Date): boolean {
  const dow = date.getDay();
  return dow === 0 || dow === 6;
}

function evalAstNode(node: FormulaAstNode, ctx: EvalContext): FormulaValue {
  switch (node.type) {
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "boolean":
      return node.value;
    case "null":
      return null;
    case "tableRef":
      return { kind: "table" };
    case "colRef": {
      if (!ctx.validColumnIds.has(node.refId)) {
        return makeError("#REF!", `引用的列不存在或已删除 (${node.refId})`);
      }
      return ctx.readCellValue(ctx.row.uuid, node.refId);
    }
    case "nameRef": {
      const resolved = resolveColumnRefId(node.name, ctx.validColumnIds, ctx.nameToId);
      if (!resolved) {
        return makeError("#REF!", `找不到列：${node.name}`);
      }
      return ctx.readCellValue(ctx.row.uuid, resolved);
    }
    case "ident": {
      if (ctx.currentItem !== undefined && CURRENT_ITEM_ALIASES.has(node.name.toLowerCase())) {
        return ctx.currentItem;
      }
      const resolved = resolveColumnRefId(node.name, ctx.validColumnIds, ctx.nameToId);
      if (resolved) {
        return ctx.readCellValue(ctx.row.uuid, resolved);
      }
      return makeError("#NAME!", `未知标识符：${node.name}`);
    }
    case "array": {
      const values: FormulaValue[] = [];
      for (const el of node.elements) {
        const v = evalAstNode(el, ctx);
        if (isFormulaError(v)) return v;
        values.push(v);
      }
      return values;
    }
    case "unary": {
      const arg = evalAstNode(node.arg, ctx);
      if (isFormulaError(arg)) return arg;
      if (node.op === "!") {
        const b = toBoolean(arg);
        return isFormulaError(b) ? b : !b;
      }
      const num = toNumber(arg);
      if (isFormulaError(num)) return num;
      return node.op === "-" ? -num : num;
    }
    case "binary":
      return evalBinary(node.op, node.left, node.right, ctx);
    case "member":
      return evalMember(node.receiver, node.propRefId, node.propName, ctx);
    case "call":
      return evalFunctionCall(node.callee, node.args, ctx);
    case "methodCall":
      return evalFunctionCall(node.method, [node.receiver, ...node.args], ctx);
  }
}

function evalMember(
  receiverNode: FormulaAstNode,
  propRefId: string | undefined,
  propName: string,
  ctx: EvalContext,
): FormulaValue {
  const receiver = evalAstNode(receiverNode, ctx);
  if (isFormulaError(receiver)) return receiver;

  const targetColId = propRefId
    ? ctx.validColumnIds.has(propRefId)
      ? propRefId
      : null
    : resolveColumnRefId(propName, ctx.validColumnIds, ctx.nameToId);

  if (!targetColId) {
    return makeError("#REF!", `找不到字段：${propName}`);
  }

  if (receiver === null) return null;

  if (isFormulaTableRef(receiver)) {
    const out: FormulaValue[] = [];
    for (const row of ctx.allRows) {
      out.push(ctx.readCellValue(row.uuid, targetColId));
    }
    return out;
  }

  if (isFormulaRowRef(receiver)) {
    return ctx.readCellValue(receiver.uuid, targetColId);
  }

  if (Array.isArray(receiver)) {
    const out: FormulaValue[] = [];
    for (const item of receiver) {
      if (isFormulaError(item)) return item;
      if (isFormulaRowRef(item)) {
        out.push(ctx.readCellValue(item.uuid, targetColId));
      } else if (item !== null) {
        return makeError("#VALUE!", `列表元素不是节点行，无法读取属性 ${propName}`);
      }
    }
    return out;
  }

  return makeError("#VALUE!", `无法从当前值读取字段 ${propName}`);
}

function evalBinary(
  op: FormulaBinaryOp,
  leftNode: FormulaAstNode,
  rightNode: FormulaAstNode,
  ctx: EvalContext,
): FormulaValue {
  const left = evalAstNode(leftNode, ctx);
  if (isFormulaError(left)) return left;
  const right = evalAstNode(rightNode, ctx);
  if (isFormulaError(right)) return right;

  switch (op) {
    case "&": {
      const ls = toText(left);
      if (isFormulaError(ls)) return ls;
      const rs = toText(right);
      if (isFormulaError(rs)) return rs;
      return ls + rs;
    }
    case "+": {
      if (isFormulaDate(left) && right !== null) {
        const n = toNumber(right);
        return isFormulaError(n) ? n : addDaysToDate(left, n);
      }
      if (isFormulaDate(right) && left !== null) {
        const n = toNumber(left);
        return isFormulaError(n) ? n : addDaysToDate(right, n);
      }
      if (isFormulaDate(left) && right === null) return left;
      if (isFormulaDate(right) && left === null) return right;
      if (typeof left === "string" || typeof right === "string") {
        // If both look numeric (or one is empty + number), still check if string concat is intended
        const bothNonNumeric =
          (typeof left === "string" && left.trim() !== "" && !Number.isFinite(Number(left.trim()))) ||
          (typeof right === "string" && right.trim() !== "" && !Number.isFinite(Number(right.trim())));
        if (bothNonNumeric) {
          const ls = toText(left);
          const rs = toText(right);
          if (isFormulaError(ls)) return ls;
          if (isFormulaError(rs)) return rs;
          return ls + rs;
        }
      }
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (isFormulaError(ln)) return ln;
      if (isFormulaError(rn)) return rn;
      return ln + rn;
    }
    case "-": {
      if (isFormulaDate(left) && isFormulaDate(right)) {
        return diffDatesInDays(left, right);
      }
      if (isFormulaDate(left)) {
        if (right === null) return left;
        if (typeof right === "string") {
          const parsed = parseDateString(right);
          if (parsed) return diffDatesInDays(left, parsed);
        }
        const n = toNumber(right);
        return isFormulaError(n) ? n : addDaysToDate(left, -n);
      }
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (isFormulaError(ln)) return ln;
      if (isFormulaError(rn)) return rn;
      return ln - rn;
    }
    case "*": {
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (isFormulaError(ln)) return ln;
      if (isFormulaError(rn)) return rn;
      return ln * rn;
    }
    case "/": {
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (isFormulaError(ln)) return ln;
      if (isFormulaError(rn)) return rn;
      if (rn === 0) return makeError("#DIV/0!", "除数不能为 0");
      return ln / rn;
    }
    case "^": {
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (isFormulaError(ln)) return ln;
      if (isFormulaError(rn)) return rn;
      const res = Math.pow(ln, rn);
      if (!Number.isFinite(res)) return makeError("#NUM!", "幂运算结果无效");
      return res;
    }
    case "=":
      return valuesEqual(left, right, false);
    case "==":
      return valuesEqual(left, right, false);
    case "!=":
    case "<>":
      return !valuesEqual(left, right, false);
    case "!==":
      return !valuesEqual(left, right, true);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const cmp = compareValues(left, right);
      if (cmp === null) return false;
      if (typeof cmp !== "number") return cmp;
      if (op === "<") return cmp < 0;
      if (op === "<=") return cmp <= 0;
      if (op === ">") return cmp > 0;
      return cmp >= 0;
    }
  }
}

function evalFunctionCall(name: string, argNodes: readonly FormulaAstNode[], ctx: EvalContext): FormulaValue {
  // 1. Lazy / Special Forms (must NOT eagerly evaluate all args!)
  switch (name) {
    case "IF": {
      if (argNodes.length < 2 || argNodes.length > 3) {
        return makeError("#VALUE!", "IF 需要 2 或 3 个参数");
      }
      const condVal = evalAstNode(argNodes[0], ctx);
      if (isFormulaError(condVal)) return condVal;
      const cond = toBoolean(condVal);
      if (isFormulaError(cond)) return cond;
      if (cond) return evalAstNode(argNodes[1], ctx);
      return argNodes[2] ? evalAstNode(argNodes[2], ctx) : null;
    }
    case "IFS": {
      if (argNodes.length < 2 || argNodes.length % 2 !== 0) {
        return makeError("#VALUE!", "IFS 需要成对的条件与结果参数");
      }
      for (let i = 0; i < argNodes.length; i += 2) {
        const condVal = evalAstNode(argNodes[i], ctx);
        if (isFormulaError(condVal)) return condVal;
        const cond = toBoolean(condVal);
        if (isFormulaError(cond)) return cond;
        if (cond) return evalAstNode(argNodes[i + 1], ctx);
      }
      return null;
    }
    case "SWITCH": {
      if (argNodes.length < 3) {
        return makeError("#VALUE!", "SWITCH 至少需要 3 个参数");
      }
      const target = evalAstNode(argNodes[0], ctx);
      if (isFormulaError(target)) return target;
      let i = 1;
      while (i + 1 < argNodes.length) {
        const caseVal = evalAstNode(argNodes[i], ctx);
        if (isFormulaError(caseVal)) return caseVal;
        if (valuesEqual(target, caseVal, false)) {
          return evalAstNode(argNodes[i + 1], ctx);
        }
        i += 2;
      }
      if (i < argNodes.length) {
        return evalAstNode(argNodes[i], ctx);
      }
      return null;
    }
    case "AND": {
      if (argNodes.length === 0) return makeError("#VALUE!", "AND 至少需要 1 个参数");
      for (const node of argNodes) {
        const val = evalAstNode(node, ctx);
        if (isFormulaError(val)) return val;
        const items = Array.isArray(val) ? flattenValues(val) : [val];
        for (const item of items) {
          const b = toBoolean(item);
          if (isFormulaError(b)) return b;
          if (!b) return false;
        }
      }
      return true;
    }
    case "OR": {
      if (argNodes.length === 0) return makeError("#VALUE!", "OR 至少需要 1 个参数");
      for (const node of argNodes) {
        const val = evalAstNode(node, ctx);
        if (isFormulaError(val)) return val;
        const items = Array.isArray(val) ? flattenValues(val) : [val];
        for (const item of items) {
          const b = toBoolean(item);
          if (isFormulaError(b)) return b;
          if (b) return true;
        }
      }
      return false;
    }
    case "IFERROR": {
      if (argNodes.length !== 2) return makeError("#VALUE!", "IFERROR 需要 2 个参数");
      const val = evalAstNode(argNodes[0], ctx);
      if (isFormulaError(val)) {
        return evalAstNode(argNodes[1], ctx);
      }
      return val;
    }
    case "ISERROR": {
      if (argNodes.length !== 1) return makeError("#VALUE!", "ISERROR 需要 1 个参数");
      const val = evalAstNode(argNodes[0], ctx);
      return isFormulaError(val);
    }
    case "IFBLANK": {
      if (argNodes.length !== 2) return makeError("#VALUE!", "IFBLANK 需要 2 个参数");
      const val = evalAstNode(argNodes[0], ctx);
      if (isFormulaError(val)) return val;
      if (isBlankValue(val)) {
        return evalAstNode(argNodes[1], ctx);
      }
      return val;
    }
    case "FILTER": {
      if (argNodes.length !== 2) return makeError("#VALUE!", "FILTER 需要 2 个参数：(列表, 条件)");
      const listVal = evalAstNode(argNodes[0], ctx);
      if (isFormulaError(listVal)) return listVal;
      let items: FormulaValue[];
      if (isFormulaTableRef(listVal)) {
        items = ctx.allRows.map((r) => ({ kind: "row", uuid: r.uuid, label: r.primaryText }));
      } else if (Array.isArray(listVal)) {
        items = listVal;
      } else if (listVal === null) {
        return [];
      } else {
        items = [listVal];
      }
      const out: FormulaValue[] = [];
      for (const item of items) {
        const innerCtx: EvalContext = { ...ctx, currentItem: item };
        const condRes = evalAstNode(argNodes[1], innerCtx);
        if (isFormulaError(condRes)) return condRes;
        const keep = toBoolean(condRes);
        if (isFormulaError(keep)) return keep;
        if (keep) out.push(item);
      }
      return out;
    }
    case "COUNTIF": {
      if (argNodes.length !== 2) return makeError("#VALUE!", "COUNTIF 需要 2 个参数：(列表, 条件)");
      const listVal = evalAstNode(argNodes[0], ctx);
      if (isFormulaError(listVal)) return listVal;
      const items: FormulaValue[] = isFormulaTableRef(listVal)
        ? ctx.allRows.map((r) => ({ kind: "row", uuid: r.uuid, label: r.primaryText }))
        : Array.isArray(listVal)
          ? flattenValues(listVal)
          : listVal === null
            ? []
            : [listVal];

      // Support both predicate expression using `current` and classic Excel criteria value
      const usesCurrent = astContainsCurrentIdent(argNodes[1]);
      let count = 0;
      if (usesCurrent) {
        for (const item of items) {
          const condRes = evalAstNode(argNodes[1], { ...ctx, currentItem: item });
          if (isFormulaError(condRes)) return condRes;
          const ok = toBoolean(condRes);
          if (isFormulaError(ok)) return ok;
          if (ok) count++;
        }
        return count;
      }
      const criteria = evalAstNode(argNodes[1], ctx);
      if (isFormulaError(criteria)) return criteria;
      for (const item of items) {
        if (evalCriteriaMatch(item, criteria)) count++;
      }
      return count;
    }
  }

  // 2. Eagerly evaluate all arguments for standard functions
  const args: FormulaValue[] = [];
  for (const node of argNodes) {
    const val = evalAstNode(node, ctx);
    if (isFormulaError(val)) return val;
    args.push(val);
  }

  return evalStandardFunction(name, args, ctx);
}

function astContainsCurrentIdent(node: FormulaAstNode): boolean {
  switch (node.type) {
    case "ident":
      return CURRENT_ITEM_ALIASES.has(node.name.toLowerCase());
    case "member":
      return astContainsCurrentIdent(node.receiver);
    case "unary":
      return astContainsCurrentIdent(node.arg);
    case "binary":
      return astContainsCurrentIdent(node.left) || astContainsCurrentIdent(node.right);
    case "array":
      return node.elements.some(astContainsCurrentIdent);
    case "call":
      return node.args.some(astContainsCurrentIdent);
    case "methodCall":
      return astContainsCurrentIdent(node.receiver) || node.args.some(astContainsCurrentIdent);
    default:
      return false;
  }
}

function extractNumericItems(args: readonly FormulaValue[]): number[] {
  const nums: number[] = [];
  for (const item of flattenValues(args)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      nums.push(item);
    }
  }
  return nums;
}

function evalStandardFunction(name: string, args: FormulaValue[], ctx: EvalContext): FormulaValue {
  switch (name) {
    // ----------------------- Number Functions -----------------------
    case "ABS": {
      if (args.length !== 1) return makeError("#VALUE!", "ABS 需要 1 个参数");
      const n = toNumber(args[0]);
      return isFormulaError(n) ? n : Math.abs(n);
    }
    case "AVERAGE": {
      const nums = extractNumericItems(args);
      if (nums.length === 0) return makeError("#DIV/0!", "AVERAGE 没有可用的数值");
      return nums.reduce((acc, v) => acc + v, 0) / nums.length;
    }
    case "CEILING": {
      if (args.length < 1 || args.length > 2) return makeError("#VALUE!", "CEILING 需要 1 或 2 个参数");
      const n = toNumber(args[0]);
      if (isFormulaError(n)) return n;
      const sig = args[1] !== undefined ? toNumber(args[1]) : 1;
      if (isFormulaError(sig)) return sig;
      if (sig === 0) return 0;
      return Math.ceil(n / sig) * sig;
    }
    case "FLOOR": {
      if (args.length < 1 || args.length > 2) return makeError("#VALUE!", "FLOOR 需要 1 或 2 个参数");
      const n = toNumber(args[0]);
      if (isFormulaError(n)) return n;
      const sig = args[1] !== undefined ? toNumber(args[1]) : 1;
      if (isFormulaError(sig)) return sig;
      if (sig === 0) return makeError("#DIV/0!", "FLOOR 基数不能为 0");
      return Math.floor(n / sig) * sig;
    }
    case "COUNT": {
      // Counts numbers, plus RowRef items when counting graph relations or table rows
      let count = 0;
      for (const arg of args) {
        if (isFormulaTableRef(arg)) {
          count += ctx.allRows.length;
          continue;
        }
        const flat = Array.isArray(arg) ? flattenValues(arg) : [arg];
        for (const item of flat) {
          if (typeof item === "number" && Number.isFinite(item)) {
            count++;
          } else if (isFormulaRowRef(item)) {
            count++;
          }
        }
      }
      return count;
    }
    case "COUNTA": {
      let count = 0;
      for (const arg of args) {
        if (isFormulaTableRef(arg)) {
          count += ctx.allRows.length;
          continue;
        }
        const flat = Array.isArray(arg) ? flattenValues(arg) : [arg];
        for (const item of flat) {
          if (!isBlankValue(item)) count++;
        }
      }
      return count;
    }
    case "EXP": {
      if (args.length !== 1) return makeError("#VALUE!", "EXP 需要 1 个参数");
      const n = toNumber(args[0]);
      return isFormulaError(n) ? n : Math.exp(n);
    }
    case "INT": {
      if (args.length !== 1) return makeError("#VALUE!", "INT 需要 1 个参数");
      const n = toNumber(args[0]);
      return isFormulaError(n) ? n : Math.floor(n);
    }
    case "LOG": {
      if (args.length < 1 || args.length > 2) return makeError("#VALUE!", "LOG 需要 1 或 2 个参数");
      const n = toNumber(args[0]);
      if (isFormulaError(n)) return n;
      const base = args[1] !== undefined ? toNumber(args[1]) : 10;
      if (isFormulaError(base)) return base;
      if (n <= 0 || base <= 0 || base === 1) return makeError("#NUM!", "LOG 参数必须为正数且底数不能为 1");
      return Math.log(n) / Math.log(base);
    }
    case "MAX": {
      const flat = flattenValues(args).filter((v) => !isBlankValue(v));
      if (flat.length === 0) return 0;
      if (flat.every((v) => isFormulaDate(v))) {
        let best = flat[0] as FormulaDateValue;
        for (let i = 1; i < flat.length; i++) {
          const cur = flat[i] as FormulaDateValue;
          if (cur.ms > best.ms) best = cur;
        }
        return best;
      }
      const nums = extractNumericItems(flat);
      if (nums.length === 0) return 0;
      return Math.max(...nums);
    }
    case "MIN": {
      const flat = flattenValues(args).filter((v) => !isBlankValue(v));
      if (flat.length === 0) return 0;
      if (flat.every((v) => isFormulaDate(v))) {
        let best = flat[0] as FormulaDateValue;
        for (let i = 1; i < flat.length; i++) {
          const cur = flat[i] as FormulaDateValue;
          if (cur.ms < best.ms) best = cur;
        }
        return best;
      }
      const nums = extractNumericItems(flat);
      if (nums.length === 0) return 0;
      return Math.min(...nums);
    }
    case "POWER": {
      if (args.length !== 2) return makeError("#VALUE!", "POWER 需要 2 个参数：(底数, 指数)");
      const base = toNumber(args[0]);
      const exp = toNumber(args[1]);
      if (isFormulaError(base)) return base;
      if (isFormulaError(exp)) return exp;
      const res = Math.pow(base, exp);
      if (!Number.isFinite(res)) return makeError("#NUM!", "POWER 结果无效");
      return res;
    }
    case "RAND": {
      return Math.random();
    }
    case "ROUND": {
      if (args.length < 1 || args.length > 2) return makeError("#VALUE!", "ROUND 需要 1 或 2 个参数");
      const n = toNumber(args[0]);
      if (isFormulaError(n)) return n;
      const digits = args[1] !== undefined ? toNumber(args[1]) : 0;
      if (isFormulaError(digits)) return digits;
      const factor = Math.pow(10, Math.trunc(digits));
      return Math.round((n + Number.EPSILON) * factor) / factor;
    }
    case "SQRT": {
      if (args.length !== 1) return makeError("#VALUE!", "SQRT 需要 1 个参数");
      const n = toNumber(args[0]);
      if (isFormulaError(n)) return n;
      if (n < 0) return makeError("#NUM!", "SQRT 参数不能为负数");
      return Math.sqrt(n);
    }
    case "SUM": {
      const nums = extractNumericItems(args);
      return nums.reduce((acc, v) => acc + v, 0);
    }
    case "SUMIF": {
      if (args.length < 2 || args.length > 3) return makeError("#VALUE!", "SUMIF 需要 2 或 3 个参数");
      const range = Array.isArray(args[0]) ? flattenValues(args[0]) : [args[0]];
      const criteria = args[1];
      const sumRange = args[2] !== undefined ? (Array.isArray(args[2]) ? flattenValues(args[2]) : [args[2]]) : range;
      let total = 0;
      for (let i = 0; i < range.length; i++) {
        if (evalCriteriaMatch(range[i], criteria)) {
          const val = sumRange[i];
          if (typeof val === "number" && Number.isFinite(val)) {
            total += val;
          }
        }
      }
      return total;
    }

    // ----------------------- Logic Functions -----------------------
    case "TRUE":
      return true;
    case "FALSE":
      return false;
    case "NOT": {
      if (args.length !== 1) return makeError("#VALUE!", "NOT 需要 1 个参数");
      const b = toBoolean(args[0]);
      return isFormulaError(b) ? b : !b;
    }
    case "ISBLANK": {
      if (args.length !== 1) return makeError("#VALUE!", "ISBLANK 需要 1 个参数");
      return isBlankValue(args[0]);
    }
    case "ISNULL": {
      if (args.length !== 1) return makeError("#VALUE!", "ISNULL 需要 1 个参数");
      return args[0] === null;
    }
    case "RECORD_ID": {
      return ctx.row.uuid;
    }

    // ----------------------- Text Functions -----------------------
    case "CHAR": {
      if (args.length !== 1) return makeError("#VALUE!", "CHAR 需要 1 个参数");
      const code = toNumber(args[0]);
      if (isFormulaError(code)) return code;
      if (code < 0 || code > 0x10ffff) return makeError("#VALUE!", "CHAR 编码超出范围");
      return String.fromCodePoint(Math.trunc(code));
    }
    case "CONCAT":
    case "CONCATENATE": {
      let out = "";
      for (const item of flattenValues(args)) {
        const s = toText(item);
        if (isFormulaError(s)) return s;
        out += s;
      }
      return out;
    }
    case "CONTAINTEXT": {
      if (args.length !== 2) return makeError("#VALUE!", "CONTAINTEXT 需要 2 个参数：(文本, 查找内容)");
      const text = toText(args[0]);
      const search = toText(args[1]);
      if (isFormulaError(text)) return text;
      if (isFormulaError(search)) return search;
      if (search === "") return true;
      return text.includes(search);
    }
    case "FIND": {
      if (args.length < 2 || args.length > 3) return makeError("#VALUE!", "FIND 需要 2 或 3 个参数");
      const findText = toText(args[0]);
      const withinText = toText(args[1]);
      if (isFormulaError(findText)) return findText;
      if (isFormulaError(withinText)) return withinText;
      const startNum = args[2] !== undefined ? toNumber(args[2]) : 1;
      if (isFormulaError(startNum)) return startNum;
      if (startNum < 1) return makeError("#VALUE!", "FIND 起始位置必须 >= 1");
      const idx = withinText.indexOf(findText, Math.trunc(startNum) - 1);
      if (idx === -1) return makeError("#VALUE!", `未找到子串：${findText}`);
      return idx + 1;
    }
    case "SEARCH": {
      if (args.length < 2 || args.length > 3) return makeError("#VALUE!", "SEARCH 需要 2 或 3 个参数");
      const findText = toText(args[0]);
      const withinText = toText(args[1]);
      if (isFormulaError(findText)) return findText;
      if (isFormulaError(withinText)) return withinText;
      const startNum = args[2] !== undefined ? toNumber(args[2]) : 1;
      if (isFormulaError(startNum)) return startNum;
      if (startNum < 1) return makeError("#VALUE!", "SEARCH 起始位置必须 >= 1");
      const sliced = withinText.slice(Math.trunc(startNum) - 1);
      const regexStr = findText
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*?")
        .replace(/\?/g, ".");
      const match = new RegExp(regexStr, "i").exec(sliced);
      if (!match) return makeError("#VALUE!", `未搜索到：${findText}`);
      return match.index + Math.trunc(startNum);
    }
    case "LEFT": {
      if (args.length < 1 || args.length > 2) return makeError("#VALUE!", "LEFT 需要 1 或 2 个参数");
      const text = toText(args[0]);
      if (isFormulaError(text)) return text;
      const count = args[1] !== undefined ? toNumber(args[1]) : 1;
      if (isFormulaError(count)) return count;
      if (count < 0) return makeError("#VALUE!", "LEFT 长度不能为负");
      return Array.from(text).slice(0, Math.trunc(count)).join("");
    }
    case "RIGHT": {
      if (args.length < 1 || args.length > 2) return makeError("#VALUE!", "RIGHT 需要 1 或 2 个参数");
      const text = toText(args[0]);
      if (isFormulaError(text)) return text;
      const count = args[1] !== undefined ? toNumber(args[1]) : 1;
      if (isFormulaError(count)) return count;
      if (count < 0) return makeError("#VALUE!", "RIGHT 长度不能为负");
      const chars = Array.from(text);
      const n = Math.trunc(count);
      return n === 0 ? "" : chars.slice(-n).join("");
    }
    case "MID": {
      if (args.length !== 3) return makeError("#VALUE!", "MID 需要 3 个参数：(文本, 起始位置, 长度)");
      const text = toText(args[0]);
      const start = toNumber(args[1]);
      const count = toNumber(args[2]);
      if (isFormulaError(text)) return text;
      if (isFormulaError(start)) return start;
      if (isFormulaError(count)) return count;
      if (start < 1 || count < 0) return makeError("#VALUE!", "MID 参数无效");
      const chars = Array.from(text);
      return chars.slice(Math.trunc(start) - 1, Math.trunc(start) - 1 + Math.trunc(count)).join("");
    }
    case "LEN": {
      if (args.length !== 1) return makeError("#VALUE!", "LEN 需要 1 个参数");
      if (Array.isArray(args[0])) return args[0].length;
      if (isFormulaTableRef(args[0])) return ctx.allRows.length;
      const text = toText(args[0]);
      return isFormulaError(text) ? text : Array.from(text).length;
    }
    case "LOWER": {
      if (args.length !== 1) return makeError("#VALUE!", "LOWER 需要 1 个参数");
      const text = toText(args[0]);
      return isFormulaError(text) ? text : text.toLowerCase();
    }
    case "UPPER": {
      if (args.length !== 1) return makeError("#VALUE!", "UPPER 需要 1 个参数");
      const text = toText(args[0]);
      return isFormulaError(text) ? text : text.toUpperCase();
    }
    case "TRIM": {
      if (args.length !== 1) return makeError("#VALUE!", "TRIM 需要 1 个参数");
      const text = toText(args[0]);
      return isFormulaError(text) ? text : text.trim().replace(/\s+/g, " ");
    }
    case "REPLACE": {
      if (args.length !== 4) return makeError("#VALUE!", "REPLACE 需要 4 个参数：(原文本, 起始位置, 长度, 新文本)");
      const oldText = toText(args[0]);
      const start = toNumber(args[1]);
      const numChars = toNumber(args[2]);
      const newText = toText(args[3]);
      if (isFormulaError(oldText)) return oldText;
      if (isFormulaError(start)) return start;
      if (isFormulaError(numChars)) return numChars;
      if (isFormulaError(newText)) return newText;
      if (start < 1 || numChars < 0) return makeError("#VALUE!", "REPLACE 参数无效");
      const chars = Array.from(oldText);
      const s = Math.trunc(start) - 1;
      const len = Math.trunc(numChars);
      return chars.slice(0, s).join("") + newText + chars.slice(s + len).join("");
    }
    case "SUBSTITUTE": {
      if (args.length < 3 || args.length > 4) return makeError("#VALUE!", "SUBSTITUTE 需要 3 或 4 个参数");
      const text = toText(args[0]);
      const oldText = toText(args[1]);
      const newText = toText(args[2]);
      if (isFormulaError(text)) return text;
      if (isFormulaError(oldText)) return oldText;
      if (isFormulaError(newText)) return newText;
      if (!oldText) return text;
      if (args[3] === undefined) {
        return text.split(oldText).join(newText);
      }
      const instance = toNumber(args[3]);
      if (isFormulaError(instance)) return instance;
      if (instance < 1) return makeError("#VALUE!", "SUBSTITUTE 替换序号必须 >= 1");
      const target = Math.trunc(instance);
      let count = 0;
      let idx = 0;
      while (true) {
        const found = text.indexOf(oldText, idx);
        if (found === -1) return text;
        count++;
        if (count === target) {
          return text.slice(0, found) + newText + text.slice(found + oldText.length);
        }
        idx = found + oldText.length;
      }
    }
    case "SPLIT": {
      if (args.length !== 2) return makeError("#VALUE!", "SPLIT 需要 2 个参数：(文本, 分隔符)");
      const text = toText(args[0]);
      const sep = toText(args[1]);
      if (isFormulaError(text)) return text;
      if (isFormulaError(sep)) return sep;
      if (text === "") return [];
      return text.split(sep);
    }
    case "TEXT": {
      if (args.length !== 2) return makeError("#VALUE!", "TEXT 需要 2 个参数：(值, 格式)");
      const val = args[0];
      const fmt = toText(args[1]);
      if (isFormulaError(fmt)) return fmt;
      if (val === null || val === "") return "";
      if (isFormulaDate(val)) {
        return formatDateByPattern(val.ms, fmt);
      }
      if (isDateFormatPattern(fmt)) {
        const dt = toDateValue(val);
        if (dt && !isFormulaError(dt)) {
          return formatDateByPattern(dt.ms, fmt);
        }
      }
      const num = toNumber(val);
      if (!isFormulaError(num)) {
        return formatNumberByPattern(num, fmt);
      }
      return toText(val);
    }
    case "TEXTJOIN": {
      if (args.length < 3) return makeError("#VALUE!", "TEXTJOIN 至少需要 3 个参数：(分隔符, 忽略空值, 内容...)");
      const delimiter = toText(args[0]);
      const ignoreEmpty = toBoolean(args[1]);
      if (isFormulaError(delimiter)) return delimiter;
      if (isFormulaError(ignoreEmpty)) return ignoreEmpty;
      const parts: string[] = [];
      for (const item of flattenValues(args.slice(2))) {
        if (ignoreEmpty && isBlankValue(item)) continue;
        const s = toText(item);
        if (isFormulaError(s)) return s;
        if (ignoreEmpty && s === "") continue;
        parts.push(s);
      }
      return parts.join(delimiter);
    }
    case "VALUE": {
      if (args.length !== 1) return makeError("#VALUE!", "VALUE 需要 1 个参数");
      if (args[0] === null || args[0] === "") return 0;
      return toNumber(args[0]);
    }

    // ----------------------- Date & Time Functions -----------------------
    case "DATE": {
      if (args.length !== 3) return makeError("#VALUE!", "DATE 需要 3 个参数：(年, 月, 日)");
      const y = toNumber(args[0]);
      const m = toNumber(args[1]);
      const d = toNumber(args[2]);
      if (isFormulaError(y)) return y;
      if (isFormulaError(m)) return m;
      if (isFormulaError(d)) return d;
      const dt = new Date(Math.trunc(y), Math.trunc(m) - 1, Math.trunc(d));
      return makeDateValue(toLocalMidnightMs(dt), false);
    }
    case "DATEADD": {
      if (args.length < 2 || args.length > 3)
        return makeError("#VALUE!", "DATEADD 需要 2 或 3 个参数：(日期, 增量, 单位)");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      const amount = toNumber(args[1]);
      if (isFormulaError(amount)) return amount;
      const unitRaw = args[2] !== undefined ? toText(args[2]) : "D";
      if (isFormulaError(unitRaw)) return unitRaw;
      const unit = unitRaw.trim().toLowerCase();
      const baseDate = new Date(dt.ms);
      switch (unit) {
        case "y":
        case "year":
        case "years":
          return makeDateValue(addYears(baseDate, Math.trunc(amount)).getTime(), dt.hasTime);
        case "m":
        case "month":
        case "months":
          return makeDateValue(addMonths(baseDate, Math.trunc(amount)).getTime(), dt.hasTime);
        case "w":
        case "week":
        case "weeks":
          return makeDateValue(addWeeks(baseDate, Math.trunc(amount)).getTime(), dt.hasTime);
        case "d":
        case "day":
        case "days":
          return addDaysToDate(dt, amount);
        case "h":
        case "hour":
        case "hours":
          return makeDateValue(addHours(baseDate, amount).getTime(), true);
        case "min":
        case "minute":
        case "minutes":
          return makeDateValue(addMinutes(baseDate, amount).getTime(), true);
        case "s":
        case "sec":
        case "second":
        case "seconds":
          return makeDateValue(addSeconds(baseDate, amount).getTime(), true);
        default:
          return makeError("#VALUE!", `不支持的时间单位：${unitRaw}`);
      }
    }
    case "DATEDIF": {
      if (args.length !== 3) return makeError("#VALUE!", "DATEDIF 需要 3 个参数：(开始日期, 结束日期, 单位)");
      const d1 = toDateValue(args[0]);
      const d2 = toDateValue(args[1]);
      if (!d1 || !d2) return null;
      if (isFormulaError(d1)) return d1;
      if (isFormulaError(d2)) return d2;
      const unitRaw = toText(args[2]);
      if (isFormulaError(unitRaw)) return unitRaw;
      const unit = unitRaw.trim().toUpperCase();
      const start = new Date(d1.ms);
      const end = new Date(d2.ms);
      switch (unit) {
        case "D":
        case "DAY":
        case "DAYS":
          return differenceInCalendarDays(end, start);
        case "M":
        case "MONTH":
        case "MONTHS":
          return differenceInMonths(end, start);
        case "Y":
        case "YEAR":
        case "YEARS":
          return differenceInYears(end, start);
        case "YM": {
          const totalMonths = differenceInMonths(end, start);
          return totalMonths - Math.trunc(totalMonths / 12) * 12;
        }
        case "MD": {
          const months = differenceInMonths(end, start);
          const shifted = addMonths(start, months);
          return differenceInCalendarDays(end, shifted);
        }
        case "YD": {
          const years = differenceInYears(end, start);
          const shifted = addYears(start, years);
          return differenceInCalendarDays(end, shifted);
        }
        case "H":
        case "HOUR":
        case "HOURS":
          return (d2.ms - d1.ms) / 3_600_000;
        case "MIN":
        case "MINUTE":
        case "MINUTES":
          return (d2.ms - d1.ms) / 60_000;
        case "S":
        case "SEC":
        case "SECOND":
        case "SECONDS":
          return (d2.ms - d1.ms) / 1000;
        default:
          return makeError("#VALUE!", `DATEDIF 不支持的单位：${unitRaw}`);
      }
    }
    case "DATEVALUE": {
      if (args.length !== 1) return makeError("#VALUE!", "DATEVALUE 需要 1 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      return makeDateValue(toLocalMidnightMs(new Date(dt.ms)), false);
    }
    case "TODATE": {
      if (args.length !== 1) return makeError("#VALUE!", "TODATE 需要 1 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      return makeDateValue(toLocalMidnightMs(new Date(dt.ms)), false);
    }
    case "TODAY": {
      return makeDateValue(toLocalMidnightMs(ctx.now), false);
    }
    case "NOW": {
      return makeDateValue(ctx.now.getTime(), true);
    }
    case "YEAR": {
      if (args.length !== 1) return makeError("#VALUE!", "YEAR 需要 1 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      return new Date(dt.ms).getFullYear();
    }
    case "MONTH": {
      if (args.length !== 1) return makeError("#VALUE!", "MONTH 需要 1 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      return new Date(dt.ms).getMonth() + 1;
    }
    case "DAY": {
      if (args.length !== 1) return makeError("#VALUE!", "DAY 需要 1 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      return new Date(dt.ms).getDate();
    }
    case "HOUR": {
      if (args.length !== 1) return makeError("#VALUE!", "HOUR 需要 1 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      return new Date(dt.ms).getHours();
    }
    case "MINUTE": {
      if (args.length !== 1) return makeError("#VALUE!", "MINUTE 需要 1 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      return new Date(dt.ms).getMinutes();
    }
    case "SECOND": {
      if (args.length !== 1) return makeError("#VALUE!", "SECOND 需要 1 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      return new Date(dt.ms).getSeconds();
    }
    case "WEEKDAY": {
      if (args.length < 1 || args.length > 2) return makeError("#VALUE!", "WEEKDAY 需要 1 或 2 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      const returnType = args[1] !== undefined ? toNumber(args[1]) : 1;
      if (isFormulaError(returnType)) return returnType;
      const dow = new Date(dt.ms).getDay(); // 0=Sun..6=Sat
      const rt = Math.trunc(returnType);
      if (rt === 1) return dow + 1; // Sun=1..Sat=7
      if (rt === 2) return dow === 0 ? 7 : dow; // Mon=1..Sun=7
      if (rt === 3) return dow === 0 ? 6 : dow - 1; // Mon=0..Sun=6
      return makeError("#VALUE!", `WEEKDAY 不支持返回类型：${rt}`);
    }
    case "WEEKNUM": {
      if (args.length < 1 || args.length > 2) return makeError("#VALUE!", "WEEKNUM 需要 1 或 2 个参数");
      const dt = toDateValue(args[0]);
      if (!dt) return null;
      if (isFormulaError(dt)) return dt;
      const returnType = args[1] !== undefined ? toNumber(args[1]) : 1;
      if (isFormulaError(returnType)) return returnType;
      const date = new Date(dt.ms);
      const rt = Math.trunc(returnType);
      if (rt === 21) return getISOWeek(date);
      if (rt === 2 || rt === 11) return getWeek(date, { weekStartsOn: 1 });
      return getWeek(date, { weekStartsOn: 0 });
    }
    case "NETWORKDAYS": {
      if (args.length < 2 || args.length > 3) return makeError("#VALUE!", "NETWORKDAYS 需要 2 或 3 个参数");
      const d1 = toDateValue(args[0]);
      const d2 = toDateValue(args[1]);
      if (!d1 || !d2) return null;
      if (isFormulaError(d1)) return d1;
      if (isFormulaError(d2)) return d2;
      const holidays = toWorkingDaySet(args[2]);
      const startMs = toLocalMidnightMs(new Date(d1.ms));
      const endMs = toLocalMidnightMs(new Date(d2.ms));
      const sign = endMs >= startMs ? 1 : -1;
      let cur = new Date(Math.min(startMs, endMs));
      const target = Math.max(startMs, endMs);
      let count = 0;
      let guard = 0;
      while (cur.getTime() <= target && guard < 100_000) {
        if (!isWeekend(cur) && !holidays.has(cur.getTime())) {
          count++;
        }
        cur = addDays(cur, 1);
        guard++;
      }
      return count * sign;
    }
    case "WORKDAY": {
      if (args.length < 2 || args.length > 3) return makeError("#VALUE!", "WORKDAY 需要 2 或 3 个参数");
      const d1 = toDateValue(args[0]);
      if (!d1) return null;
      if (isFormulaError(d1)) return d1;
      const days = toNumber(args[1]);
      if (isFormulaError(days)) return days;
      const holidays = toWorkingDaySet(args[2]);
      let remaining = Math.trunc(days);
      let cur = new Date(toLocalMidnightMs(new Date(d1.ms)));
      if (remaining === 0) return makeDateValue(cur.getTime(), false);
      const step = remaining > 0 ? 1 : -1;
      remaining = Math.abs(remaining);
      let guard = 0;
      while (remaining > 0 && guard < 100_000) {
        cur = addDays(cur, step);
        if (!isWeekend(cur) && !holidays.has(cur.getTime())) {
          remaining--;
        }
        guard++;
      }
      return makeDateValue(cur.getTime(), false);
    }

    // ----------------------- List Functions -----------------------
    case "LIST": {
      return [...args];
    }
    case "AT": {
      if (args.length !== 2) return makeError("#VALUE!", "AT 需要 2 个参数：(列表, 位置)");
      const list = Array.isArray(args[0]) ? args[0] : args[0] === null ? [] : [args[0]];
      const idx = toNumber(args[1]);
      if (isFormulaError(idx)) return idx;
      const n = Math.trunc(idx);
      if (n === 0) return null;
      const actual = n > 0 ? n - 1 : list.length + n;
      if (actual < 0 || actual >= list.length) return null;
      return list[actual];
    }
    case "FIRST": {
      if (args.length !== 1) return makeError("#VALUE!", "FIRST 需要 1 个参数");
      if (isFormulaTableRef(args[0])) {
        const firstRow = ctx.allRows[0];
        return firstRow ? { kind: "row", uuid: firstRow.uuid, label: firstRow.primaryText } : null;
      }
      const list = Array.isArray(args[0]) ? args[0] : args[0] === null ? [] : [args[0]];
      return list.length > 0 ? list[0] : null;
    }
    case "LAST": {
      if (args.length !== 1) return makeError("#VALUE!", "LAST 需要 1 个参数");
      if (isFormulaTableRef(args[0])) {
        const lastRow = ctx.allRows[ctx.allRows.length - 1];
        return lastRow ? { kind: "row", uuid: lastRow.uuid, label: lastRow.primaryText } : null;
      }
      const list = Array.isArray(args[0]) ? args[0] : args[0] === null ? [] : [args[0]];
      return list.length > 0 ? list[list.length - 1] : null;
    }
    case "CHOOSE": {
      if (args.length < 2) return makeError("#VALUE!", "CHOOSE 至少需要 2 个参数：(索引, 选项1, ...)");
      const idx = toNumber(args[0]);
      if (isFormulaError(idx)) return idx;
      const n = Math.trunc(idx);
      if (n < 1 || n >= args.length) return makeError("#VALUE!", `CHOOSE 索引超出范围：${n}`);
      return args[n];
    }
    case "CONTAINS": {
      if (args.length < 2) return makeError("#VALUE!", "CONTAINS 需要 2 个参数：(列表, 查找值)");
      const list = Array.isArray(args[0]) ? args[0] : args[0] === null ? [] : [args[0]];
      const targets = args.length === 2 && Array.isArray(args[1]) ? args[1] : args.slice(1);
      return targets.some((target) => list.some((item) => valuesEqual(item, target, false)));
    }
    case "CONTAINSALL": {
      if (args.length < 2) return makeError("#VALUE!", "CONTAINSALL 至少需要 2 个参数");
      const list = Array.isArray(args[0]) ? args[0] : args[0] === null ? [] : [args[0]];
      const targets = args.length === 2 && Array.isArray(args[1]) ? args[1] : args.slice(1);
      return targets.every((target) => list.some((item) => valuesEqual(item, target, false)));
    }
    case "CONTAINSONLY": {
      if (args.length < 2) return makeError("#VALUE!", "CONTAINSONLY 至少需要 2 个参数");
      const list = Array.isArray(args[0]) ? args[0] : args[0] === null ? [] : [args[0]];
      const targets = args.length === 2 && Array.isArray(args[1]) ? args[1] : args.slice(1);
      if (list.length === 0) return targets.length === 0;
      const allInTargets = list.every((item) => targets.some((t) => valuesEqual(item, t, false)));
      const allTargetsPresent = targets.every((t) => list.some((item) => valuesEqual(item, t, false)));
      return allInTargets && allTargetsPresent;
    }
    case "LISTCOMBINE": {
      const out: FormulaValue[] = [];
      for (const arg of args) {
        if (Array.isArray(arg)) {
          for (const item of flattenValues(arg)) {
            if (item !== null) out.push(item);
          }
        } else if (arg !== null) {
          out.push(arg);
        }
      }
      return out;
    }
    case "LISTJOIN": {
      if (args.length < 1 || args.length > 2)
        return makeError("#VALUE!", "LISTJOIN 需要 1 或 2 个参数：(列表, 分隔符)");
      const list = Array.isArray(args[0]) ? flattenValues(args[0]) : args[0] === null ? [] : [args[0]];
      const sep = args[1] !== undefined ? toText(args[1]) : ", ";
      if (isFormulaError(sep)) return sep;
      const parts: string[] = [];
      for (const item of list) {
        if (isBlankValue(item)) continue;
        const s = toText(item);
        if (isFormulaError(s)) return s;
        if (s !== "") parts.push(s);
      }
      return parts.join(sep);
    }
    case "LOOKUP": {
      if (args.length < 2 || args.length > 3)
        return makeError("#VALUE!", "LOOKUP 需要 2 或 3 个参数：(查找值, 查找列表, 返回列表?)");
      const needle = args[0];
      const searchList = Array.isArray(args[1]) ? args[1] : [args[1]];
      const resultList = args[2] !== undefined ? (Array.isArray(args[2]) ? args[2] : [args[2]]) : searchList;
      for (let i = 0; i < searchList.length; i++) {
        if (valuesEqual(searchList[i], needle, false)) {
          return i < resultList.length ? resultList[i] : null;
        }
      }
      return null;
    }
    case "UNIQUE": {
      if (args.length !== 1) return makeError("#VALUE!", "UNIQUE 需要 1 个参数");
      const list = Array.isArray(args[0]) ? flattenValues(args[0]) : args[0] === null ? [] : [args[0]];
      const seen = new Set<string>();
      const out: FormulaValue[] = [];
      for (const item of list) {
        if (isBlankValue(item)) continue;
        const key = valueKeyForSet(item);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(item);
        }
      }
      return out;
    }
    default:
      return makeError("#NAME!", `未知函数：${name}`);
  }
}

// ---------------------------------------------------------------------------
// Table-Level Evaluation with DAG Memoization & Cycle Protection
// ---------------------------------------------------------------------------

function readRawColumnValue(
  row: TableFilterSortRow,
  colId: string,
  colById: ReadonlyMap<string, TableColumnSchema>,
): FormulaValue {
  if (SYSTEM_COLUMN_SET.has(colId)) {
    switch (colId as SystemColumnId) {
      case "name":
        return row.primaryText ?? "";
      case "images":
        return row.images.map((img) => img.attachmentId);
      case "createdAt":
        return Number.isFinite(row.createdAt) && row.createdAt > 0 ? makeDateValue(row.createdAt, true) : null;
      case "updatedAt":
        return Number.isFinite(row.updatedAt) && row.updatedAt > 0 ? makeDateValue(row.updatedAt, true) : null;
      case "parents":
        return row.parents.map((item) => ({ kind: "row", uuid: item.uuid, label: item.label }));
      case "children":
        return row.children.map((item) => ({ kind: "row", uuid: item.uuid, label: item.label }));
      case "outer":
        return row.outer ? { kind: "row", uuid: row.outer.uuid, label: row.outer.label } : null;
      case "inner":
        return row.inner.map((item) => ({ kind: "row", uuid: item.uuid, label: item.label }));
    }
  }

  const col = colById.get(colId);
  if (!col) return makeError("#REF!", `引用的列不存在 (${colId})`);

  const raw = row.tableFields?.[col.id];
  if (raw === undefined || raw === null) {
    return col.type === "multi_select" ? [] : null;
  }

  switch (col.type) {
    case "text":
      return typeof raw === "string" ? raw : String(raw);
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    case "date": {
      if (typeof raw === "string" && raw.trim()) {
        return parseDateString(raw) ?? null;
      }
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return makeDateValue(raw, true);
      }
      return null;
    }
    case "select": {
      const optMap = new Map((col.options ?? []).map((o) => [o.id, o.name]));
      const id = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
      if (!id) return null;
      return optMap.get(id) ?? null;
    }
    case "multi_select": {
      const optMap = new Map((col.options ?? []).map((o) => [o.id, o.name]));
      const ids = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
      return ids.map((id) => optMap.get(id)).filter((v): v is string => Boolean(v));
    }
    case "formula":
      return null;
  }
}

export function formatFormulaValueToCell(val: FormulaValue, format?: string): FormulaEvaluatedCell {
  if (isFormulaError(val)) {
    return {
      kind: "error",
      displayText: val.code,
      errorCode: val.code,
      errorMessage: val.message,
    };
  }
  if (val === null) {
    return { kind: "empty", displayText: "" };
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      return { kind: "error", displayText: "#NUM!", errorCode: "#NUM!", errorMessage: "数值溢出或无效" };
    }
    const fmt = format?.trim();
    const displayText = fmt && !isDateFormatPattern(fmt) ? formatNumberByPattern(val, fmt) : formatDefaultNumber(val);
    return { kind: "number", displayText, numericValue: val };
  }
  if (typeof val === "boolean") {
    return { kind: "boolean", displayText: val ? "TRUE" : "FALSE", booleanValue: val };
  }
  if (typeof val === "string") {
    return val.length === 0 ? { kind: "empty", displayText: "" } : { kind: "string", displayText: val };
  }
  if (isFormulaDate(val)) {
    const fmt = format?.trim();
    const pattern = fmt && isDateFormatPattern(fmt) ? fmt : val.hasTime ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD";
    return {
      kind: "date",
      displayText: formatDateByPattern(val.ms, pattern),
      numericValue: val.ms,
      dateMs: val.ms,
      dateHasTime: val.hasTime,
    };
  }
  if (isFormulaRowRef(val)) {
    return { kind: "row", displayText: val.label };
  }
  if (isFormulaTableRef(val)) {
    return { kind: "string", displayText: "[Table]" };
  }
  if (Array.isArray(val)) {
    const flat = flattenValues(val);
    const items: string[] = [];
    for (const item of flat) {
      if (isFormulaError(item)) {
        return {
          kind: "error",
          displayText: item.code,
          errorCode: item.code,
          errorMessage: item.message,
        };
      }
      if (isBlankValue(item)) continue;
      const cell = formatFormulaValueToCell(item, format);
      if (cell.displayText) items.push(cell.displayText);
    }
    if (items.length === 0) return { kind: "empty", displayText: "" };
    return {
      kind: "list",
      displayText: items.join(", "),
      listItems: items,
    };
  }
  return { kind: "empty", displayText: "" };
}

/**
 * Evaluates all formula columns across all table rows with memoization and cycle detection.
 * Returns a Map<rowUuid, Record<formulaColId, FormulaEvaluatedCell>>.
 */
export function evaluateTableFormulas(
  rows: readonly TableFilterSortRow[],
  columns: readonly TableColumnSchema[],
  options: FormulaEvalOptions = {},
): Map<string, Record<string, FormulaEvaluatedCell>> {
  const formulaCols = columns.filter((col) => col.type === "formula");
  if (formulaCols.length === 0) return new Map();
  return evaluateFormulaSubset(
    rows.map((r) => r.uuid),
    formulaCols.map((c) => c.id),
    rows,
    columns,
    options,
  );
}

/**
 * 仅对指定的 `(targetRowUuids × targetColIds)` 子集执行公式求值（共享单次求值上下文、AST 缓存与循环保护），
 * 供增量公式 DAG 引擎以 O(dirty) 完成局部更新。
 */
export function evaluateFormulaSubset(
  targetRowUuids: Iterable<string>,
  targetColIds: Iterable<string>,
  rows: readonly TableFilterSortRow[],
  columns: readonly TableColumnSchema[],
  options: FormulaEvalOptions = {},
): Map<string, Record<string, FormulaEvaluatedCell>> {
  const result = new Map<string, Record<string, FormulaEvaluatedCell>>();
  const formulaCols = columns.filter((col) => col.type === "formula");
  if (formulaCols.length === 0) return result;

  const targetColIdSet = new Set(targetColIds);
  const targetCols = formulaCols.filter((c) => targetColIdSet.has(c.id));
  if (targetCols.length === 0) return result;

  const now = options.now ?? new Date();
  const rowByUuid: ReadonlyMap<string, TableFilterSortRow> =
    options.rowByUuid ?? new Map<string, TableFilterSortRow>(rows.map((r) => [r.uuid, r]));
  const colById = new Map<string, TableColumnSchema>(columns.map((c) => [c.id, c]));
  const validColumnIds = new Set<string>([...ALL_SYSTEM_COLUMN_IDS, ...columns.map((c) => c.id)]);
  const nameToId = buildColumnNameToIdMap({
    columns,
    systemColumnNames: options.systemColumnNames,
    systemColumnLabels: options.systemColumnLabels,
  });

  // 复用全局 AST 缓存，避免每次变更重复词法/语法分析
  const parsedByColId = new Map<string, FormulaParseResult>();
  for (const col of formulaCols) {
    parsedByColId.set(col.id, parseFormulaCached(col.formula ?? ""));
  }

  // Memoize raw FormulaValue by `${rowUuid}\0${colId}`
  const valueCache = new Map<string, FormulaValue>();
  const visiting = new Set<string>();

  const readCellValue = (rowUuid: string, colId: string): FormulaValue => {
    const targetRow = rowByUuid.get(rowUuid);
    if (!targetRow) return null;

    const col = colById.get(colId);
    if (!col || col.type !== "formula") {
      return readRawColumnValue(targetRow, colId, colById);
    }

    const cacheKey = `${rowUuid}\0${colId}`;
    if (valueCache.has(cacheKey)) {
      return valueCache.get(cacheKey)!;
    }
    if (visiting.has(cacheKey)) {
      return makeError("#CYCLE!", "检测到循环引用");
    }

    const parsed = parsedByColId.get(colId);
    if (!parsed) return null;
    if (parsed.error) {
      const err = makeError(parsed.error.code, parsed.error.message);
      valueCache.set(cacheKey, err);
      return err;
    }
    if (!parsed.ast) {
      valueCache.set(cacheKey, null);
      return null;
    }

    visiting.add(cacheKey);
    const ctx: EvalContext = {
      row: targetRow,
      allRows: rows,
      rowByUuid,
      columns,
      colById,
      validColumnIds,
      nameToId,
      now,
      readCellValue,
    };
    const evaluated = evalAstNode(parsed.ast, ctx);
    visiting.delete(cacheKey);
    valueCache.set(cacheKey, evaluated);
    return evaluated;
  };

  for (const rowUuid of targetRowUuids) {
    if (!rowByUuid.has(rowUuid)) continue;
    const rowRecord: Record<string, FormulaEvaluatedCell> = {};
    for (const col of targetCols) {
      const rawVal = readCellValue(rowUuid, col.id);
      rowRecord[col.id] = formatFormulaValueToCell(rawVal, col.format);
    }
    result.set(rowUuid, rowRecord);
  }

  return result;
}

/**
 * Evaluates a single candidate formula string against a specific row for live editor preview.
 */
export function evaluateSingleFormulaPreview(
  candidateColumnId: string,
  candidateFormula: string,
  candidateFormat: string | undefined,
  targetRowUuid: string,
  rows: readonly TableFilterSortRow[],
  columns: readonly TableColumnSchema[],
  options: FormulaEvalOptions = {},
): FormulaEvaluatedCell {
  const virtualColumns: TableColumnSchema[] = columns.some((c) => c.id === candidateColumnId)
    ? columns.map((c) =>
        c.id === candidateColumnId ? { ...c, type: "formula", formula: candidateFormula, format: candidateFormat } : c,
      )
    : [
        ...columns,
        {
          id: candidateColumnId,
          name: "__preview__",
          type: "formula",
          formula: candidateFormula,
          format: candidateFormat,
        },
      ];

  const evaluated = evaluateTableFormulas(rows, virtualColumns, options);
  return evaluated.get(targetRowUuid)?.[candidateColumnId] ?? { kind: "empty", displayText: "" };
}

/**
 * Converts an evaluated formula cell into a static TableCellValue when changing column type
 * from `formula` to a static custom column type (text, number, date, select, multi_select).
 */
export function materializeFormulaCellToStatic(
  cell: FormulaEvaluatedCell | undefined,
  targetType: Exclude<CustomColumnType, "formula">,
  ensureOptionByLabel: (label: string) => string | null,
): TableCellValue {
  if (!cell || cell.kind === "empty" || cell.kind === "error") {
    return null;
  }

  switch (targetType) {
    case "text":
      return cell.displayText || null;
    case "number": {
      if (cell.kind === "number" && cell.numericValue !== undefined && Number.isFinite(cell.numericValue)) {
        return cell.numericValue;
      }
      if (cell.kind === "boolean") {
        return cell.booleanValue ? 1 : 0;
      }
      const parsed = Number(cell.displayText.trim());
      return cell.displayText.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
    }
    case "date": {
      if (cell.kind === "date" && cell.dateMs !== undefined && Number.isFinite(cell.dateMs)) {
        return formatDateByPattern(cell.dateMs, "YYYY-MM-DD");
      }
      const parsed = parseDateString(cell.displayText);
      return parsed ? formatDateByPattern(parsed.ms, "YYYY-MM-DD") : null;
    }
    case "select": {
      const label = cell.kind === "list" ? (cell.listItems?.[0] ?? "") : cell.displayText;
      return label.trim() ? ensureOptionByLabel(label) : null;
    }
    case "multi_select": {
      const labels =
        cell.kind === "list" && cell.listItems
          ? cell.listItems
          : cell.displayText
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean);
      const ids = labels.map((l) => ensureOptionByLabel(l)).filter((id): id is string => Boolean(id));
      return ids.length > 0 ? Array.from(new Set(ids)) : null;
    }
  }
}
