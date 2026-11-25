export type SystemColumnId = "name" | "images" | "createdAt" | "updatedAt" | "parents" | "children" | "outer" | "inner";

export const OPTIONAL_SYSTEM_COLUMN_IDS: readonly Exclude<SystemColumnId, "name">[] = [
  "images",
  "createdAt",
  "updatedAt",
  "parents",
  "children",
  "outer",
  "inner",
];

export const ALL_SYSTEM_COLUMN_IDS: readonly SystemColumnId[] = ["name", ...OPTIONAL_SYSTEM_COLUMN_IDS];

export type CustomColumnType = "text" | "number" | "date" | "select" | "multi_select" | "formula";

export const CUSTOM_COLUMN_TYPES: readonly CustomColumnType[] = [
  "text",
  "number",
  "date",
  "select",
  "multi_select",
  "formula",
];

export const CREATABLE_CUSTOM_COLUMN_TYPES: readonly Exclude<CustomColumnType, "formula">[] = [
  "text",
  "number",
  "date",
  "select",
  "multi_select",
];

export const SELECT_OPTION_COLORS = ["gray", "purple", "blue", "green", "amber", "rose", "cyan", "orange"] as const;

export type SelectOptionColor = (typeof SELECT_OPTION_COLORS)[number];

export interface TableSelectOption {
  id: string;
  name: string;
  color: string;
}

export function createCustomColumnId(): string {
  return `col_${crypto.randomUUID()}`;
}

export function createSelectOptionId(): string {
  return `opt_${crypto.randomUUID()}`;
}

export function createColumnGroupId(): string {
  return `grp_${crypto.randomUUID()}`;
}

export function pickNextSelectOptionColor(existingOptions: readonly TableSelectOption[] = []): SelectOptionColor {
  const usedCounts = new Map<string, number>();
  for (const color of SELECT_OPTION_COLORS) {
    usedCounts.set(color, 0);
  }
  for (const opt of existingOptions) {
    usedCounts.set(opt.color, (usedCounts.get(opt.color) ?? 0) + 1);
  }
  let best: SelectOptionColor = SELECT_OPTION_COLORS[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of SELECT_OPTION_COLORS) {
    const count = usedCounts.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

export interface TableColumnSchema {
  id: string;
  name: string;
  type: CustomColumnType;
  width?: number;
  options?: TableSelectOption[];
  format?: string;
  formula?: string;
}

export type TableCellValue = string | number | string[] | null;

export type TableFields = Record<string, TableCellValue>;

export type TableViewType = "table";

export interface TableColumnGroup {
  id: string;
  name: string;
  columnIds: string[];
}

export interface TableViewSchema {
  id: string;
  name: string;
  type: TableViewType;
  deletable: boolean;
  visibleColumnIds: string[];
  columnWidths?: Record<string, number>;
  frozenColumnId?: string | null;
  columnGroups?: TableColumnGroup[];
}

export interface PrgTableData {
  columns: TableColumnSchema[];
  views: TableViewSchema[];
  activeViewId: string;
  systemColumnNames?: Partial<Record<SystemColumnId, string>>;
}

export const DEFAULT_TABLE_VIEW_ID = "default-table-view";
export const DEFAULT_TABLE_VIEW_NAME = "原始表";

export function createDefaultTableView(defaultName: string = DEFAULT_TABLE_VIEW_NAME): TableViewSchema {
  return {
    id: DEFAULT_TABLE_VIEW_ID,
    name: defaultName,
    type: "table",
    deletable: false,
    visibleColumnIds: ["name"],
    columnWidths: {},
  };
}

export function createDefaultTableData(defaultViewName: string = DEFAULT_TABLE_VIEW_NAME): PrgTableData {
  const defaultView = createDefaultTableView(defaultViewName);
  return {
    columns: [],
    views: [defaultView],
    activeViewId: defaultView.id,
  };
}

function isSafeColumnKey(key: string): boolean {
  return key.length > 0 && key !== "_" && key !== "$" && key !== "$u" && !key.startsWith("__");
}

export function cloneTableFields(raw?: Record<string, unknown> | null): TableFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result: TableFields = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isSafeColumnKey(key)) continue;
    if (value === null || typeof value === "string") {
      result[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.filter((item): item is string => typeof item === "string");
    }
  }
  return result;
}

export function normalizeTableData(raw: unknown): PrgTableData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createDefaultTableData();
  }
  const obj = raw as Record<string, unknown>;

  const columns: TableColumnSchema[] = [];
  const seenColumnIds = new Set<string>();
  if (Array.isArray(obj.columns)) {
    for (const item of obj.columns) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const col = item as Record<string, unknown>;
      if (typeof col.id !== "string" || !col.id.startsWith("col_") || seenColumnIds.has(col.id)) continue;
      if (typeof col.name !== "string") continue;
      if (typeof col.type !== "string" || !CUSTOM_COLUMN_TYPES.includes(col.type as CustomColumnType)) continue;
      seenColumnIds.add(col.id);

      const options: TableSelectOption[] | undefined = Array.isArray(col.options)
        ? col.options
            .filter((opt): opt is Record<string, unknown> => Boolean(opt && typeof opt === "object"))
            .filter(
              (opt) =>
                typeof opt.id === "string" &&
                isSafeColumnKey(opt.id) &&
                typeof opt.name === "string" &&
                typeof opt.color === "string",
            )
            .map((opt) => ({
              id: opt.id as string,
              name: opt.name as string,
              color: opt.color as string,
            }))
        : undefined;

      columns.push({
        id: col.id,
        name: col.name,
        type: col.type as CustomColumnType,
        width: typeof col.width === "number" && Number.isFinite(col.width) ? col.width : undefined,
        options,
        format: typeof col.format === "string" ? col.format : undefined,
        formula: typeof col.formula === "string" ? col.formula : undefined,
      });
    }
  }

  const validColumnIds = new Set<string>([...ALL_SYSTEM_COLUMN_IDS, ...columns.map((c) => c.id)]);
  const views: TableViewSchema[] = [];
  const seenViewIds = new Set<string>();

  if (Array.isArray(obj.views)) {
    for (const item of obj.views) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const view = item as Record<string, unknown>;
      if (typeof view.id !== "string" || !view.id || seenViewIds.has(view.id)) continue;
      if (typeof view.name !== "string" || !view.name) continue;
      seenViewIds.add(view.id);

      const rawVisible = Array.isArray(view.visibleColumnIds)
        ? view.visibleColumnIds.filter((id): id is string => typeof id === "string" && validColumnIds.has(id))
        : [];
      const visibleColumnIds = ["name", ...rawVisible.filter((id) => id !== "name")];

      const columnWidths: Record<string, number> = {};
      if (view.columnWidths && typeof view.columnWidths === "object" && !Array.isArray(view.columnWidths)) {
        for (const [colId, width] of Object.entries(view.columnWidths as Record<string, unknown>)) {
          if (validColumnIds.has(colId) && typeof width === "number" && Number.isFinite(width) && width > 40) {
            columnWidths[colId] = width;
          }
        }
      }

      const frozenColumnId =
        typeof view.frozenColumnId === "string" && validColumnIds.has(view.frozenColumnId)
          ? view.frozenColumnId
          : undefined;

      const columnGroups: TableColumnGroup[] = [];
      const seenGroupIds = new Set<string>();
      const claimedGroupCols = new Set<string>();
      if (Array.isArray(view.columnGroups)) {
        for (const rawGrp of view.columnGroups) {
          if (!rawGrp || typeof rawGrp !== "object" || Array.isArray(rawGrp)) continue;
          const grp = rawGrp as Record<string, unknown>;
          if (typeof grp.id !== "string" || !isSafeColumnKey(grp.id) || seenGroupIds.has(grp.id)) continue;
          if (typeof grp.name !== "string" || !grp.name.trim()) continue;
          const grpCols = Array.isArray(grp.columnIds)
            ? grp.columnIds.filter(
                (id): id is string => typeof id === "string" && validColumnIds.has(id) && !claimedGroupCols.has(id),
              )
            : [];
          if (grpCols.length === 0) continue;
          seenGroupIds.add(grp.id);
          for (const id of grpCols) claimedGroupCols.add(id);
          columnGroups.push({
            id: grp.id,
            name: grp.name.trim(),
            columnIds: grpCols,
          });
        }
      }

      views.push({
        id: view.id,
        name: view.name,
        type: "table",
        deletable: view.id === DEFAULT_TABLE_VIEW_ID ? false : Boolean(view.deletable),
        visibleColumnIds: Array.from(new Set(visibleColumnIds)),
        columnWidths,
        ...(frozenColumnId ? { frozenColumnId } : {}),
        ...(columnGroups.length > 0 ? { columnGroups } : {}),
      });
    }
  }

  if (!views.some((v) => !v.deletable)) {
    if (views.length === 0) {
      views.push(createDefaultTableView());
    } else {
      views[0] = { ...views[0], deletable: false };
    }
  }

  const activeViewId =
    typeof obj.activeViewId === "string" && views.some((v) => v.id === obj.activeViewId)
      ? obj.activeViewId
      : views[0].id;

  const systemColumnNames: Partial<Record<SystemColumnId, string>> = {};
  if (obj.systemColumnNames && typeof obj.systemColumnNames === "object" && !Array.isArray(obj.systemColumnNames)) {
    for (const sysColId of ALL_SYSTEM_COLUMN_IDS) {
      const customLabel = (obj.systemColumnNames as Record<string, unknown>)[sysColId];
      if (typeof customLabel === "string" && customLabel.trim().length > 0) {
        systemColumnNames[sysColId] = customLabel.trim();
      }
    }
  }

  return {
    columns,
    views,
    activeViewId,
    ...(Object.keys(systemColumnNames).length > 0 ? { systemColumnNames } : {}),
  };
}
