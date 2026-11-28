import type { V3CellValueRecord } from "@/core/sqlite/DocClient";
import type { TableCellValue, TableColumnSchema } from "@/types/table";

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function computeColumnCanonicalKey(col: TableColumnSchema): string {
  if (col.protectedRole) {
    return `role:sr:${col.protectedRole}`;
  }
  if (col.canonicalKey && col.canonicalKey.startsWith("ws:")) {
    return col.canonicalKey;
  }
  const normalizedName = col.name.trim().toLowerCase();
  return `auto:${col.type}:${normalizedName}`;
}

export function decodeV3CellValue(cell: V3CellValueRecord): TableCellValue {
  if (cell.valType === "number") {
    return typeof cell.valNum === "number" && Number.isFinite(cell.valNum) ? cell.valNum : null;
  }
  if (cell.valType === "date") {
    return cell.valDate ?? cell.valText ?? null;
  }
  if (cell.valType === "multi_select") {
    const parsed = safeJsonParse<unknown>(cell.valJson, []);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  }
  return cell.valText ?? null;
}
