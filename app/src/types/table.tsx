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

export const CREATABLE_CUSTOM_COLUMN_TYPES: readonly CustomColumnType[] = [
  "text",
  "number",
  "date",
  "select",
  "multi_select",
  "formula",
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

export function createTableViewId(): string {
  return `view_${crypto.randomUUID()}`;
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

export type TableViewType = "table" | "kanban" | "gantt" | "gallery" | "calendar";

export const TABLE_VIEW_TYPES: readonly TableViewType[] = ["table", "kanban", "gantt", "gallery", "calendar"];

export type TableRowHeight = "compact" | "medium" | "tall";

export interface TableKanbanViewConfig {
  groupByColumnId?: string | null;
  showCover?: boolean;
  coverFit?: "cover" | "contain";
  showFieldNames?: boolean;
  hideEmptyGroups?: boolean;
}

export type GanttTimeScale = "week" | "month" | "quarter" | "year";

export interface TableGanttViewConfig {
  startDateColumnId?: string | null;
  endDateColumnId?: string | null;
  colorColumnId?: string | null;
  timeScale?: GanttTimeScale;
  groupByColumnId?: string | null;
  showLeftTable?: boolean;
  leftPaneWidth?: number;
  showBarLabel?: boolean;
  showDuration?: boolean;
  highlightWeekends?: boolean;
}

export type GalleryCardSize = "small" | "medium" | "large";

export interface TableGalleryViewConfig {
  coverMode?: "images" | "none";
  coverFit?: "cover" | "contain";
  cardSize?: GalleryCardSize;
  showFieldNames?: boolean;
}

export type CalendarDisplayMode = "day" | "week" | "month";
export type CalendarCellHeight = "compact" | "medium" | "tall";

export interface TableCalendarViewConfig {
  dateColumnId?: string | null;
  endDateColumnId?: string | null;
  colorColumnId?: string | null;
  displayMode?: CalendarDisplayMode;
  cellHeight?: CalendarCellHeight;
  weekStartsOn?: 0 | 1;
  showFieldNames?: boolean;
}

export interface TableColumnGroup {
  id: string;
  name: string;
  columnIds: string[];
}

export type TableSortDirection = "asc" | "desc";

export interface TableSortConfig {
  columnId: string;
  direction: TableSortDirection;
}

export interface TableColumnFilter {
  columnId: string;
  values: string[];
  includeEmpty: boolean;
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
  sort?: TableSortConfig | null;
  filters?: TableColumnFilter[];
  rowHeight?: TableRowHeight;
  kanban?: TableKanbanViewConfig;
  gantt?: TableGanttViewConfig;
  gallery?: TableGalleryViewConfig;
  calendar?: TableCalendarViewConfig;
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
      if (typeof view.id !== "string" || !isSafeColumnKey(view.id) || seenViewIds.has(view.id)) continue;
      if (typeof view.name !== "string" || !view.name) continue;
      seenViewIds.add(view.id);

      const viewType: TableViewType =
        typeof view.type === "string" && TABLE_VIEW_TYPES.includes(view.type as TableViewType)
          ? (view.type as TableViewType)
          : "table";

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

      let sort: TableSortConfig | undefined;
      if (view.sort && typeof view.sort === "object" && !Array.isArray(view.sort)) {
        const rawSort = view.sort as Record<string, unknown>;
        if (
          typeof rawSort.columnId === "string" &&
          validColumnIds.has(rawSort.columnId) &&
          (rawSort.direction === "asc" || rawSort.direction === "desc")
        ) {
          sort = { columnId: rawSort.columnId, direction: rawSort.direction };
        }
      }

      const filters: TableColumnFilter[] = [];
      const seenFilterCols = new Set<string>();
      if (Array.isArray(view.filters)) {
        for (const rawFilter of view.filters) {
          if (!rawFilter || typeof rawFilter !== "object" || Array.isArray(rawFilter)) continue;
          const flt = rawFilter as Record<string, unknown>;
          if (
            typeof flt.columnId !== "string" ||
            !validColumnIds.has(flt.columnId) ||
            seenFilterCols.has(flt.columnId)
          ) {
            continue;
          }
          const values = Array.isArray(flt.values)
            ? Array.from(new Set(flt.values.filter((v): v is string => typeof v === "string")))
            : [];
          seenFilterCols.add(flt.columnId);
          filters.push({
            columnId: flt.columnId,
            values,
            includeEmpty: Boolean(flt.includeEmpty),
          });
        }
      }

      const rowHeight: TableRowHeight | undefined =
        view.rowHeight === "compact" || view.rowHeight === "medium" || view.rowHeight === "tall"
          ? view.rowHeight
          : undefined;

      const normalizeValidColRef = (val: unknown): string | null | undefined => {
        if (val === null) return null;
        if (typeof val === "string" && validColumnIds.has(val)) return val;
        return undefined;
      };

      let kanban: TableKanbanViewConfig | undefined;
      if (view.kanban && typeof view.kanban === "object" && !Array.isArray(view.kanban)) {
        const k = view.kanban as Record<string, unknown>;
        const groupByColumnId = normalizeValidColRef(k.groupByColumnId);
        kanban = {
          ...(groupByColumnId !== undefined ? { groupByColumnId } : {}),
          ...(typeof k.showCover === "boolean" ? { showCover: k.showCover } : {}),
          ...(k.coverFit === "cover" || k.coverFit === "contain" ? { coverFit: k.coverFit } : {}),
          ...(typeof k.showFieldNames === "boolean" ? { showFieldNames: k.showFieldNames } : {}),
          ...(typeof k.hideEmptyGroups === "boolean" ? { hideEmptyGroups: k.hideEmptyGroups } : {}),
        };
      }

      let gantt: TableGanttViewConfig | undefined;
      if (view.gantt && typeof view.gantt === "object" && !Array.isArray(view.gantt)) {
        const g = view.gantt as Record<string, unknown>;
        const startDateColumnId = normalizeValidColRef(g.startDateColumnId);
        const endDateColumnId = normalizeValidColRef(g.endDateColumnId);
        const colorColumnId = normalizeValidColRef(g.colorColumnId);
        const groupByColumnId = normalizeValidColRef(g.groupByColumnId);
        gantt = {
          ...(startDateColumnId !== undefined ? { startDateColumnId } : {}),
          ...(endDateColumnId !== undefined ? { endDateColumnId } : {}),
          ...(colorColumnId !== undefined ? { colorColumnId } : {}),
          ...(g.timeScale === "week" || g.timeScale === "month" || g.timeScale === "quarter" || g.timeScale === "year"
            ? { timeScale: g.timeScale }
            : {}),
          ...(groupByColumnId !== undefined ? { groupByColumnId } : {}),
          ...(typeof g.showLeftTable === "boolean" ? { showLeftTable: g.showLeftTable } : {}),
          ...(typeof g.leftPaneWidth === "number" && Number.isFinite(g.leftPaneWidth)
            ? { leftPaneWidth: Math.max(160, Math.min(640, g.leftPaneWidth)) }
            : {}),
          ...(typeof g.showBarLabel === "boolean" ? { showBarLabel: g.showBarLabel } : {}),
          ...(typeof g.showDuration === "boolean" ? { showDuration: g.showDuration } : {}),
          ...(typeof g.highlightWeekends === "boolean" ? { highlightWeekends: g.highlightWeekends } : {}),
        };
      }

      let gallery: TableGalleryViewConfig | undefined;
      if (view.gallery && typeof view.gallery === "object" && !Array.isArray(view.gallery)) {
        const gl = view.gallery as Record<string, unknown>;
        gallery = {
          ...(gl.coverMode === "images" || gl.coverMode === "none" ? { coverMode: gl.coverMode } : {}),
          ...(gl.coverFit === "cover" || gl.coverFit === "contain" ? { coverFit: gl.coverFit } : {}),
          ...(gl.cardSize === "small" || gl.cardSize === "medium" || gl.cardSize === "large"
            ? { cardSize: gl.cardSize }
            : {}),
          ...(typeof gl.showFieldNames === "boolean" ? { showFieldNames: gl.showFieldNames } : {}),
        };
      }

      let calendar: TableCalendarViewConfig | undefined;
      if (view.calendar && typeof view.calendar === "object" && !Array.isArray(view.calendar)) {
        const cal = view.calendar as Record<string, unknown>;
        const dateColumnId = normalizeValidColRef(cal.dateColumnId);
        const endDateColumnId = normalizeValidColRef(cal.endDateColumnId);
        const colorColumnId = normalizeValidColRef(cal.colorColumnId);
        calendar = {
          ...(dateColumnId !== undefined ? { dateColumnId } : {}),
          ...(endDateColumnId !== undefined ? { endDateColumnId } : {}),
          ...(colorColumnId !== undefined ? { colorColumnId } : {}),
          ...(cal.displayMode === "day" || cal.displayMode === "week" || cal.displayMode === "month"
            ? { displayMode: cal.displayMode }
            : {}),
          ...(cal.cellHeight === "compact" || cal.cellHeight === "medium" || cal.cellHeight === "tall"
            ? { cellHeight: cal.cellHeight }
            : {}),
          ...(cal.weekStartsOn === 0 || cal.weekStartsOn === 1 ? { weekStartsOn: cal.weekStartsOn } : {}),
          ...(typeof cal.showFieldNames === "boolean" ? { showFieldNames: cal.showFieldNames } : {}),
        };
      }

      views.push({
        id: view.id,
        name: view.name,
        type: viewType,
        deletable: view.id === DEFAULT_TABLE_VIEW_ID ? false : Boolean(view.deletable),
        visibleColumnIds: Array.from(new Set(visibleColumnIds)),
        columnWidths,
        ...(frozenColumnId ? { frozenColumnId } : {}),
        ...(columnGroups.length > 0 ? { columnGroups } : {}),
        ...(sort ? { sort } : {}),
        ...(filters.length > 0 ? { filters } : {}),
        ...(rowHeight ? { rowHeight } : {}),
        ...(kanban && Object.keys(kanban).length > 0 ? { kanban } : {}),
        ...(gantt && Object.keys(gantt).length > 0 ? { gantt } : {}),
        ...(gallery && Object.keys(gallery).length > 0 ? { gallery } : {}),
        ...(calendar && Object.keys(calendar).length > 0 ? { calendar } : {}),
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

export type FormulaErrorCode =
  | "#ERROR!"
  | "#SYNTAX!"
  | "#NAME!"
  | "#REF!"
  | "#CYCLE!"
  | "#DIV/0!"
  | "#VALUE!"
  | "#NUM!";

export interface FormulaEvaluatedCell {
  kind: "empty" | "number" | "string" | "boolean" | "date" | "list" | "row" | "error";
  displayText: string;
  numericValue?: number;
  dateMs?: number;
  dateHasTime?: boolean;
  booleanValue?: boolean;
  listItems?: string[];
  errorCode?: FormulaErrorCode;
  errorMessage?: string;
}

export interface TableFilterSortRow {
  uuid: string;
  primaryText: string;
  images: ReadonlyArray<{ uuid: string; attachmentId: string }>;
  createdAt: number;
  updatedAt: number;
  parents: ReadonlyArray<{ uuid: string; label: string }>;
  children: ReadonlyArray<{ uuid: string; label: string }>;
  outer: { uuid: string; label: string } | null;
  inner: ReadonlyArray<{ uuid: string; label: string }>;
  tableFields: Record<string, TableCellValue>;
  formulaValues?: Record<string, FormulaEvaluatedCell>;
}

export interface ColumnFilterBucket {
  key: string;
  label: string;
  count: number;
  color?: string;
}

export function formatDateBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function getRowFilterTokens(
  row: TableFilterSortRow,
  columnId: string,
  customCol?: TableColumnSchema,
): { tokens: Array<{ key: string; label: string; color?: string }>; isEmpty: boolean } {
  switch (columnId) {
    case "name": {
      const text = row.primaryText.trim();
      return text.length > 0 ? { tokens: [{ key: text, label: text }], isEmpty: false } : { tokens: [], isEmpty: true };
    }
    case "images": {
      const count = row.images.length;
      return count > 0
        ? { tokens: [{ key: String(count), label: String(count) }], isEmpty: false }
        : { tokens: [], isEmpty: true };
    }
    case "createdAt": {
      const bucket = formatDateBucket(row.createdAt);
      return bucket ? { tokens: [{ key: bucket, label: bucket }], isEmpty: false } : { tokens: [], isEmpty: true };
    }
    case "updatedAt": {
      const bucket = formatDateBucket(row.updatedAt);
      return bucket ? { tokens: [{ key: bucket, label: bucket }], isEmpty: false } : { tokens: [], isEmpty: true };
    }
    case "parents":
    case "children":
    case "inner": {
      const list = row[columnId];
      if (list.length === 0) return { tokens: [], isEmpty: true };
      return {
        tokens: list.map((item) => ({ key: item.uuid, label: item.label.trim() || item.uuid })),
        isEmpty: false,
      };
    }
    case "outer": {
      if (!row.outer) return { tokens: [], isEmpty: true };
      return {
        tokens: [{ key: row.outer.uuid, label: row.outer.label.trim() || row.outer.uuid }],
        isEmpty: false,
      };
    }
    default: {
      if (!customCol) return { tokens: [], isEmpty: true };
      if (customCol.type === "formula") {
        const cell = row.formulaValues?.[customCol.id];
        if (!cell || cell.kind === "empty") {
          return { tokens: [], isEmpty: true };
        }
        if (cell.kind === "date" && cell.dateMs !== undefined) {
          const bucket = formatDateBucket(cell.dateMs);
          return bucket ? { tokens: [{ key: bucket, label: bucket }], isEmpty: false } : { tokens: [], isEmpty: true };
        }
        if (cell.kind === "list" && cell.listItems && cell.listItems.length > 0) {
          const tokens = cell.listItems
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => ({ key: item, label: item }));
          return tokens.length > 0 ? { tokens, isEmpty: false } : { tokens: [], isEmpty: true };
        }
        const text = cell.displayText.trim();
        return text.length > 0
          ? { tokens: [{ key: text, label: text }], isEmpty: false }
          : { tokens: [], isEmpty: true };
      }
      const raw = row.tableFields?.[customCol.id];
      if (customCol.type === "number") {
        if (typeof raw === "number" && Number.isFinite(raw)) {
          const str = String(raw);
          return { tokens: [{ key: str, label: str }], isEmpty: false };
        }
        return { tokens: [], isEmpty: true };
      }
      if (customCol.type === "select" || customCol.type === "multi_select") {
        const optionById = new Map((customCol.options ?? []).map((opt) => [opt.id, opt]));
        const ids =
          customCol.type === "multi_select"
            ? Array.isArray(raw)
              ? raw
              : typeof raw === "string"
                ? [raw]
                : []
            : typeof raw === "string"
              ? [raw]
              : Array.isArray(raw) && raw.length > 0
                ? [raw[0]]
                : [];
        const tokens: Array<{ key: string; label: string; color?: string }> = [];
        for (const id of ids) {
          const opt = optionById.get(id);
          if (opt) tokens.push({ key: opt.id, label: opt.name, color: opt.color });
        }
        return tokens.length > 0 ? { tokens, isEmpty: false } : { tokens: [], isEmpty: true };
      }
      const str = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
      return str.length > 0 ? { tokens: [{ key: str, label: str }], isEmpty: false } : { tokens: [], isEmpty: true };
    }
  }
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function collectColumnFilterBuckets<T extends TableFilterSortRow>(
  rows: readonly T[],
  columnId: string,
  customCol?: TableColumnSchema,
): { buckets: ColumnFilterBucket[]; emptyCount: number } {
  const map = new Map<string, ColumnFilterBucket>();
  let emptyCount = 0;

  for (const row of rows) {
    const { tokens, isEmpty } = getRowFilterTokens(row, columnId, customCol);
    if (isEmpty) {
      emptyCount++;
      continue;
    }
    const seenInRow = new Set<string>();
    for (const token of tokens) {
      if (seenInRow.has(token.key)) continue;
      seenInRow.add(token.key);
      const existing = map.get(token.key);
      if (existing) {
        existing.count++;
      } else {
        map.set(token.key, {
          key: token.key,
          label: token.label,
          count: 1,
          color: token.color,
        });
      }
    }
  }

  const buckets = Array.from(map.values());
  if (customCol?.type === "number" || columnId === "images") {
    buckets.sort((a, b) => Number(a.key) - Number(b.key));
  } else if (columnId === "createdAt" || columnId === "updatedAt" || customCol?.type === "date") {
    buckets.sort((a, b) => b.key.localeCompare(a.key));
  } else if (customCol?.type === "select" || customCol?.type === "multi_select") {
    const order = new Map((customCol.options ?? []).map((opt, idx) => [opt.id, idx]));
    buckets.sort((a, b) => (order.get(a.key) ?? 9999) - (order.get(b.key) ?? 9999));
  } else if (customCol?.type === "formula" && buckets.length > 0) {
    if (buckets.every((b) => b.key !== "" && Number.isFinite(Number(b.key)))) {
      buckets.sort((a, b) => Number(a.key) - Number(b.key));
    } else if (buckets.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.key))) {
      buckets.sort((a, b) => b.key.localeCompare(a.key));
    } else {
      buckets.sort((a, b) => naturalCollator.compare(a.label, b.label));
    }
  } else {
    buckets.sort((a, b) => naturalCollator.compare(a.label, b.label));
  }

  return { buckets, emptyCount };
}

function getRowSortKey(
  row: TableFilterSortRow,
  columnId: string,
  customCol?: TableColumnSchema,
): { empty: boolean; num?: number; text?: string } {
  switch (columnId) {
    case "name": {
      const text = row.primaryText.trim();
      return text.length > 0 ? { empty: false, text } : { empty: true };
    }
    case "images":
      return { empty: false, num: row.images.length };
    case "createdAt":
      return Number.isFinite(row.createdAt) && row.createdAt > 0
        ? { empty: false, num: row.createdAt }
        : { empty: true };
    case "updatedAt":
      return Number.isFinite(row.updatedAt) && row.updatedAt > 0
        ? { empty: false, num: row.updatedAt }
        : { empty: true };
    case "parents":
    case "children":
    case "inner": {
      const labels = row[columnId]
        .map((item) => item.label.trim())
        .filter(Boolean)
        .sort((a, b) => naturalCollator.compare(a, b));
      return labels.length > 0 ? { empty: false, text: labels.join(", ") } : { empty: true };
    }
    case "outer": {
      const label = row.outer?.label.trim() ?? "";
      return label.length > 0 ? { empty: false, text: label } : { empty: true };
    }
    default: {
      if (!customCol) return { empty: true };
      if (customCol.type === "formula") {
        const cell = row.formulaValues?.[customCol.id];
        if (!cell || cell.kind === "empty") return { empty: true };
        if (cell.kind === "number" && cell.numericValue !== undefined) {
          return { empty: false, num: cell.numericValue };
        }
        if (cell.kind === "date" && cell.dateMs !== undefined) {
          return { empty: false, num: cell.dateMs };
        }
        if (cell.kind === "boolean") {
          return { empty: false, num: cell.booleanValue ? 1 : 0 };
        }
        const text = cell.displayText.trim();
        return text.length > 0 ? { empty: false, text } : { empty: true };
      }
      const raw = row.tableFields?.[customCol.id];
      if (customCol.type === "number") {
        return typeof raw === "number" && Number.isFinite(raw) ? { empty: false, num: raw } : { empty: true };
      }
      if (customCol.type === "select" || customCol.type === "multi_select") {
        const optionById = new Map((customCol.options ?? []).map((opt) => [opt.id, opt.name]));
        const ids =
          customCol.type === "multi_select"
            ? Array.isArray(raw)
              ? raw
              : typeof raw === "string"
                ? [raw]
                : []
            : typeof raw === "string"
              ? [raw]
              : Array.isArray(raw) && raw.length > 0
                ? [raw[0]]
                : [];
        const names = ids.map((id) => optionById.get(id)).filter((v): v is string => Boolean(v));
        return names.length > 0 ? { empty: false, text: names.join(", ") } : { empty: true };
      }
      const str = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
      return str.length > 0 ? { empty: false, text: str } : { empty: true };
    }
  }
}

export function applyTableFiltersAndSort<T extends TableFilterSortRow>(
  rows: readonly T[],
  columns: readonly TableColumnSchema[],
  filters: readonly TableColumnFilter[],
  sort: TableSortConfig | null,
): T[] {
  const customColMap = new Map(columns.map((col) => [col.id, col]));
  let result: T[] = [...rows];

  if (filters.length > 0) {
    result = result.filter((row) =>
      filters.every((filter) => {
        const { tokens, isEmpty } = getRowFilterTokens(row, filter.columnId, customColMap.get(filter.columnId));
        if (isEmpty) {
          return filter.includeEmpty;
        }
        const allowed = new Set(filter.values);
        return tokens.some((token) => allowed.has(token.key));
      }),
    );
  }

  if (sort) {
    const customCol = customColMap.get(sort.columnId);
    const dir = sort.direction === "asc" ? 1 : -1;
    const decorated = result.map((row, index) => ({
      row,
      index,
      key: getRowSortKey(row, sort.columnId, customCol),
    }));
    decorated.sort((a, b) => {
      if (a.key.empty && b.key.empty) return a.index - b.index;
      if (a.key.empty) return 1;
      if (b.key.empty) return -1;
      const cmp =
        a.key.num !== undefined && b.key.num !== undefined
          ? a.key.num - b.key.num
          : naturalCollator.compare(a.key.text ?? "", b.key.text ?? "");
      return cmp !== 0 ? cmp * dir : a.index - b.index;
    });
    result = decorated.map((item) => item.row);
  }

  return result;
}

export function toLocalDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseLocalDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const dt = new Date(year, month, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month || dt.getDate() !== day) {
    return null;
  }
  return dt;
}

export function addDaysToDateKey(key: string, deltaDays: number): string {
  const dt = parseLocalDateKey(key);
  if (!dt) return key;
  dt.setDate(dt.getDate() + deltaDays);
  return toLocalDateKey(dt);
}

export function diffCalendarDays(startKey: string, endKey: string): number {
  const start = parseLocalDateKey(startKey);
  const end = parseLocalDateKey(endKey);
  if (!start || !end) return 0;
  const utcStart = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const utcEnd = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((utcEnd - utcStart) / 86_400_000);
}

export function resolveRowDateKey(
  row: TableFilterSortRow,
  columnId: string | null | undefined,
  customCol?: TableColumnSchema,
): string | null {
  if (!columnId) return null;
  if (columnId === "createdAt") {
    return Number.isFinite(row.createdAt) && row.createdAt > 0 ? formatDateBucket(row.createdAt) : null;
  }
  if (columnId === "updatedAt") {
    return Number.isFinite(row.updatedAt) && row.updatedAt > 0 ? formatDateBucket(row.updatedAt) : null;
  }
  if (!customCol) return null;
  if (customCol.type === "formula") {
    const cell = row.formulaValues?.[customCol.id];
    if (!cell || cell.kind === "empty" || cell.kind === "error") return null;
    if (cell.kind === "date" && cell.dateMs !== undefined) {
      return formatDateBucket(cell.dateMs) || null;
    }
    if (typeof cell.displayText === "string") {
      const parsed = parseLocalDateKey(cell.displayText.slice(0, 10));
      if (parsed) return toLocalDateKey(parsed);
    }
    return null;
  }
  const raw = row.tableFields?.[customCol.id];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const parsed = parseLocalDateKey(trimmed.slice(0, 10));
    if (parsed) return toLocalDateKey(parsed);
  }
  return null;
}

export function resolveRowDateRange(
  row: TableFilterSortRow,
  startColId: string | null | undefined,
  endColId: string | null | undefined,
  colMap: ReadonlyMap<string, TableColumnSchema>,
): { startKey: string; endKey: string; durationDays: number } | null {
  const startKey = resolveRowDateKey(row, startColId, startColId ? colMap.get(startColId) : undefined);
  const endKey = resolveRowDateKey(row, endColId, endColId ? colMap.get(endColId) : undefined);
  if (!startKey && !endKey) return null;
  const effectiveStart = startKey ?? endKey!;
  const effectiveEnd = endKey ?? startKey!;
  if (diffCalendarDays(effectiveStart, effectiveEnd) < 0) {
    return {
      startKey: effectiveEnd,
      endKey: effectiveStart,
      durationDays: diffCalendarDays(effectiveEnd, effectiveStart) + 1,
    };
  }
  return {
    startKey: effectiveStart,
    endKey: effectiveEnd,
    durationDays: diffCalendarDays(effectiveStart, effectiveEnd) + 1,
  };
}

export function getRowSelectOptionColor(
  row: TableFilterSortRow,
  colorColumnId: string | null | undefined,
  colMap: ReadonlyMap<string, TableColumnSchema>,
): string | undefined {
  if (!colorColumnId) return undefined;
  const col = colMap.get(colorColumnId);
  if (!col || (col.type !== "select" && col.type !== "multi_select")) return undefined;
  const raw = row.tableFields?.[col.id];
  const optId = typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : undefined;
  if (!optId) return undefined;
  return (col.options ?? []).find((o) => o.id === optId)?.color;
}
