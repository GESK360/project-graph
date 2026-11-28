import type { Project } from "@/core/Project";
import {
  DocClient,
  type TableDateRangeResult,
  type TableExtraGroupFilterInput,
  type TableFilterBucketsResult,
  type TableGroupCountsResult,
  type TableRelationCandidatesResult,
  type V3FormulaCellRecord,
  type V3TableRowRecord,
} from "@/core/sqlite/DocClient";
import { decodeV3CellValue } from "@/core/sqlite/V3CellCodec";
import type { WorkspaceColumnRecord, WorkspaceDocRecord } from "@/core/sqlite/WorkspaceClient";
import type { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import {
  ALL_SYSTEM_COLUMN_IDS,
  applyTableFiltersAndSort,
  collectColumnFilterBuckets,
  resolveRowDateRange,
  toLocalDateKey,
  type AnySystemColumnId,
  type ColumnFilterBucket,
  type CustomColumnType,
  type FormulaErrorCode,
  type FormulaEvaluatedCell,
  type SpacedRepetitionAnswerChoice,
  type SpacedRepetitionFieldDropPosition,
  type TableCalendarViewConfig,
  type TableCellValue,
  type TableColumnFilter,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableFields,
  type TableFilterCondition,
  type TableFilterConjunction,
  type TableFilterGroup,
  type TableGalleryViewConfig,
  type TableGanttViewConfig,
  type TableKanbanViewConfig,
  type TableRowHeight,
  type TableSelectOption,
  type TableSortConfig,
  type TableSortDirection,
  type TableSpacedRepetitionViewConfig,
  type TableViewSchema,
  type TableViewType,
  type WorkspaceTableScope,
} from "@/types/table";
import type {
  SpacedRepetitionAnswerSnapshot,
  StageTableRelationItem,
  StageTableRow,
  StageTableRowKind,
} from "./StageTableService";

export type RelationColumnKind = "parents" | "children" | "outer" | "inner";

export interface TablePageRequest {
  offset?: number;
  limit?: number;
  filters?: readonly TableColumnFilter[];
  filterGroup?: TableFilterGroup | null;
  sort?: TableSortConfig | null;
  todayKey?: string;
  extraGroupFilter?: TableExtraGroupFilterInput | null;
}

export interface TablePageResponse {
  totalCount: number;
  unfilteredTotalCount: number;
  offset: number;
  limit: number;
  rows: StageTableRow[];
}

export interface TableFilterBucketsRequest {
  columnId: string;
  search?: string;
  limit?: number;
}

export interface TableFilterBucketsResponse {
  buckets: ColumnFilterBucket[];
  emptyCount: number;
  totalBuckets: number;
}

export interface TableRelationCandidatesRequest {
  docId?: string | null;
  rowUuid: string;
  relationKind: RelationColumnKind;
  search?: string;
  limit?: number;
}

export interface TableRelationCandidatesResponse {
  candidates: StageTableRelationItem[];
  totalCount: number;
  hasMore: boolean;
}

export interface TableGroupCountsRequest {
  groupByColumnId: string;
  filters?: readonly TableColumnFilter[];
  filterGroup?: TableFilterGroup | null;
  todayKey?: string;
}

export interface TableGroupCountEntry {
  key: string;
  label: string;
  count: number;
  color?: string;
}

export interface TableGroupCountsResponse {
  totalCount: number;
  ungroupedCount: number;
  groups: TableGroupCountEntry[];
}

export interface TableDateRangeRequest {
  startColumnId: string;
  endColumnId?: string | null;
  minDate: string;
  maxDate: string;
  filters?: readonly TableColumnFilter[];
  filterGroup?: TableFilterGroup | null;
  sort?: TableSortConfig | null;
  todayKey?: string;
  includeUndated?: boolean;
  undatedLimit?: number;
}

export interface TableDateRangeResponse {
  rows: StageTableRow[];
  undatedCount: number;
  undatedRows: StageTableRow[];
  totalFilteredCount: number;
}

export type TableDataSourceMutation =
  | { type: "update_primary_text"; docId?: string | null; rowUuid: string; text: string }
  | { type: "update_custom_field"; docId?: string | null; rowUuid: string; columnId: string; value: TableCellValue }
  | { type: "update_custom_fields"; docId?: string | null; rowUuid: string; patch: Record<string, TableCellValue> }
  | { type: "set_parents"; docId?: string | null; rowUuid: string; parentUuids: string[] }
  | { type: "set_children"; docId?: string | null; rowUuid: string; childUuids: string[] }
  | { type: "set_outer"; docId?: string | null; rowUuid: string; outerUuid: string | null }
  | { type: "set_inner"; docId?: string | null; rowUuid: string; innerUuids: string[] }
  | { type: "add_images"; docId?: string | null; rowUuid: string; blobs: Blob[] }
  | { type: "remove_image"; docId?: string | null; rowUuid: string; imageNodeUuid: string }
  | {
      type: "create_row";
      docId?: string | null;
      text?: string;
      tableFields?: TableFields;
      outerSectionUuid?: string | null;
    }
  | {
      type: "answer_spaced_repetition";
      docId?: string | null;
      rowUuid: string;
      choice: SpacedRepetitionAnswerChoice;
      baseline?: SpacedRepetitionAnswerSnapshot;
      today?: Date;
    }
  | {
      type: "restore_spaced_repetition";
      docId?: string | null;
      rowUuid: string;
      snapshot: SpacedRepetitionAnswerSnapshot;
    };

export interface TableActiveViewConfigPatch {
  rowHeight?: TableRowHeight;
  kanban?: Partial<TableKanbanViewConfig>;
  gantt?: Partial<TableGanttViewConfig>;
  gallery?: Partial<TableGalleryViewConfig>;
  calendar?: Partial<TableCalendarViewConfig>;
  spacedRepetition?: Partial<TableSpacedRepetitionViewConfig>;
}

/**
 * 统一多维表格数据源契约：
 * - 单文件画布：`SingleFileTableSource`（SQLite v3 走 Rust 下沉查询，非 Tauri/旧工程自动内存回退）；
 * - 跨文件工作空间：`WorkspaceTableSource`（查 `.flux-graph/index.sqlite`，写回按 `docId` 经 `DocumentActorPool` 原子路由源 `.prg`）；
 * - 全套 6 视图仅依赖此契约，零重复视图代码。
 */
export interface TableDataSource {
  readonly scopeKind: "single_doc" | "workspace";
  getDocId(): string | null;
  isSqliteBacked(): boolean;
  getSystemColumnIds(): readonly AnySystemColumnId[];
  getViews(): TableViewSchema[];
  getActiveView(): TableViewSchema;
  getColumns(): TableColumnSchema[];
  getVisibleColumnIds(): string[];
  getColumnGroups(): TableColumnGroup[];
  getFrozenColumnId(): string | null;
  getSort(): TableSortConfig | null;
  getFilters(): TableColumnFilter[];
  getFilterGroup(): TableFilterGroup;
  getSystemColumnCustomName(colId: AnySystemColumnId): string | undefined;
  getMediaUrl(docId: string | null, attachmentId: string, options?: { thumb?: boolean }): string | null;
  getAllRowsSync(): StageTableRow[];

  // ── 视图与工作空间作用域（可选，仅 workspace 数据源实现）──
  getScope?(): WorkspaceTableScope;
  setScope?(scope: WorkspaceTableScope): void;
  getWorkspaceDocs?(): WorkspaceDocRecord[];
  getWorkspaceColumnsMeta?(): WorkspaceColumnRecord[];
  getDefaultCreateDocId?(): string | null;
  setDefaultCreateDocId?(docId: string | null): void;
  refreshWorkspaceMetadata?(): Promise<void>;
  getCachedRow?(rowUuid: string, docId?: string | null): StageTableRow | undefined;

  // ── 视图 CRUD & 配置 ──
  setActiveView(viewId: string): void;
  createView(input: { type: TableViewType; name?: string; scope?: WorkspaceTableScope }): TableViewSchema | null;
  renameView(viewId: string, name: string): void;
  duplicateView(viewId: string, copySuffix?: string): void;
  deleteView(viewId: string): void;
  reorderViews(dragViewId: string, targetViewId: string, position: "before" | "after"): void;
  updateActiveViewConfig(patch: TableActiveViewConfigPatch): void;

  // ── 列显隐 / 列宽 / 冻结 / 拖拽 / 编组 / 自定义列 CRUD ──
  isColumnVisible(colId: string): boolean;
  setColumnVisible(colId: string, visible: boolean): void;
  setColumnWidth(colId: string, width: number): void;
  autoFitColumnWidth?(colId: string, rows?: readonly StageTableRow[], headerLabel?: string): void;
  toggleFreezeColumn(colId: string): void;
  reorderColumn(dragColId: string, targetColId: string, position: "before" | "after"): void;
  addCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    formula?: string;
    format?: string;
  }): TableColumnSchema | null;
  insertCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    targetColumnId?: string;
    side?: "left" | "right";
  }): TableColumnSchema | null;
  updateColumn(
    colId: string,
    patch: { name?: string; type?: CustomColumnType; formula?: string; format?: string },
  ): void;
  duplicateCustomColumn?(colId: string, copySuffix?: string): void;
  deleteCustomColumn(colId: string): void;
  createOrGetSelectOption(colId: string, name: string): TableSelectOption | null;
  createColumnGroup(name: string, columnIds: string[]): TableColumnGroup | null;
  renameColumnGroup(groupId: string, name: string): void;
  setColumnInGroup(colId: string, groupId: string | null): void;
  dissolveColumnGroup(groupId: string): void;

  // ── 排序与筛选 ──
  setSort(sort: TableSortConfig | null): void;
  toggleColumnSort(colId: string, explicitDirection?: TableSortDirection): void;
  setColumnFilter(colId: string, filter: (Omit<TableColumnFilter, "columnId"> & { columnId?: string }) | null): void;
  setFilterConjunction(conj: TableFilterConjunction): void;
  addFilterCondition(colId?: string): TableFilterCondition | null;
  updateFilterCondition(id: string, patch: Partial<TableFilterCondition>): void;
  removeFilterCondition(id: string): void;
  toggleFilterConditionCollapsed(id: string): void;
  reorderFilterConditions(dragId: string, targetId: string, position: "before" | "after"): void;
  clearAllFilters(): void;

  // ── 间隔重复专用 ──
  ensureSpacedRepetitionColumns(silent?: boolean): void;
  addSpacedRepetitionCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    side: "front" | "back";
  }): TableColumnSchema | null;
  reorderSpacedRepetitionFields(
    side: "front" | "back",
    draggedColId: string,
    targetColId: string,
    position: SpacedRepetitionFieldDropPosition,
    currentRowsOrIds?: readonly string[][] | readonly string[],
  ): boolean;
  answerSpacedRepetitionRow(
    rowUuid: string,
    choice: SpacedRepetitionAnswerChoice,
    options?: { docId?: string | null; baseline?: SpacedRepetitionAnswerSnapshot; today?: Date },
  ): SpacedRepetitionAnswerSnapshot | null | Promise<SpacedRepetitionAnswerSnapshot | null>;
  restoreSpacedRepetitionRow(
    rowUuid: string,
    snapshot: SpacedRepetitionAnswerSnapshot,
    options?: { docId?: string | null },
  ): boolean | Promise<boolean>;

  // ── 行级读写便捷接口（透传 docId 支持跨文件路由）──
  updateRowPrimaryText(rowUuid: string, text: string, docId?: string | null): boolean | Promise<boolean>;
  updateRowCustomField(
    rowUuid: string,
    columnId: string,
    value: TableCellValue,
    docId?: string | null,
  ): boolean | Promise<boolean>;
  updateRowCustomFields(
    rowUuid: string,
    patch: Record<string, TableCellValue>,
    docId?: string | null,
  ): boolean | Promise<boolean>;
  setRowOuter(rowUuid: string, outerUuid: string | null, docId?: string | null): boolean | Promise<boolean>;
  addRowImages(rowUuid: string, blobs: Blob[], docId?: string | null): Promise<boolean>;
  removeRowImage(rowUuid: string, imageNodeUuid: string, docId?: string | null): boolean | Promise<boolean>;
  createRow(options?: {
    docId?: string | null;
    text?: string;
    tableFields?: TableFields;
    outerSectionUuid?: string | null;
  }): { uuid: string; docId?: string } | null | Promise<{ uuid: string; docId?: string } | null>;
  refreshVolatileFormulasIfDayChanged?(): boolean;

  // ── 下沉查询 ──
  queryPage(request: TablePageRequest): Promise<TablePageResponse>;
  queryPageSync(request: TablePageRequest): TablePageResponse;
  queryFilterBuckets(request: TableFilterBucketsRequest): Promise<TableFilterBucketsResponse>;
  queryRelationCandidates(request: TableRelationCandidatesRequest): Promise<TableRelationCandidatesResponse>;
  queryGroupCounts(request: TableGroupCountsRequest): Promise<TableGroupCountsResponse>;
  queryDateRange(request: TableDateRangeRequest): Promise<TableDateRangeResponse>;

  // ── 统一变更入口、跳转与订阅 ──
  executeMutation(mutation: TableDataSourceMutation): Promise<boolean>;
  jumpToNode(docId: string | null, uuid: string, panelWidthPx?: number): void;
  selectRows(uuids: string[], options?: { focusCamera?: boolean; panelWidthPx?: number }): void;
  getSelectedRowUUIDs(): string[];
  subscribeChanges(listener: () => void): () => void;
  subscribeSelection(listener: (uuids: string[]) => void): () => void;
  dispose?(): void;
}

export function hydrateFormulaRecord(rec: V3FormulaCellRecord): FormulaEvaluatedCell {
  return {
    kind: rec.kind,
    displayText: rec.displayText,
    ...(rec.numericValue !== null && rec.numericValue !== undefined ? { numericValue: rec.numericValue } : {}),
    ...(rec.dateMs !== null && rec.dateMs !== undefined ? { dateMs: rec.dateMs } : {}),
    ...(rec.dateHasTime !== null && rec.dateHasTime !== undefined ? { dateHasTime: rec.dateHasTime } : {}),
    ...(rec.booleanValue !== null && rec.booleanValue !== undefined ? { booleanValue: rec.booleanValue } : {}),
    ...(rec.listItems !== null && rec.listItems !== undefined ? { listItems: rec.listItems } : {}),
    ...(rec.errorCode ? { errorCode: rec.errorCode as FormulaErrorCode } : {}),
    ...(rec.errorMessage ? { errorMessage: rec.errorMessage } : {}),
  };
}

export function hydrateV3TableRow(project: Project | null, rec: V3TableRowRecord): StageTableRow {
  const live = project?.stageManager?.get?.(rec.uuid) as ConnectableEntity | undefined;
  const tableFields: Record<string, TableCellValue> = {};
  for (const cell of rec.cellValues) {
    const decoded = decodeV3CellValue(cell);
    if (decoded !== null && !(Array.isArray(decoded) && decoded.length === 0)) {
      tableFields[cell.colId] = decoded;
    }
  }
  const formulaValues: Record<string, FormulaEvaluatedCell> = {};
  for (const [colId, fRec] of Object.entries(rec.formulaValues)) {
    formulaValues[colId] = hydrateFormulaRecord(fRec);
  }
  return {
    uuid: rec.uuid,
    docId: rec.docId,
    ...(rec.sourceFile !== null && rec.sourceFile !== undefined ? { sourceFile: rec.sourceFile } : {}),
    ...(rec.sourceFolder !== null && rec.sourceFolder !== undefined ? { sourceFolder: rec.sourceFolder } : {}),
    ...(rec.sourceRelPath !== null && rec.sourceRelPath !== undefined ? { sourceRelPath: rec.sourceRelPath } : {}),
    entity: live,
    kind: rec.kind as StageTableRowKind,
    primaryText: rec.primaryText,
    editableText: rec.editableText,
    images: rec.images,
    canEditImages: rec.canEditImages,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    parents: rec.parents.map((p) => ({ uuid: p.uuid, label: p.label, kind: p.kind as StageTableRowKind })),
    children: rec.children.map((c) => ({ uuid: c.uuid, label: c.label, kind: c.kind as StageTableRowKind })),
    outer: rec.outer
      ? { uuid: rec.outer.uuid, label: rec.outer.label, kind: rec.outer.kind as StageTableRowKind }
      : null,
    inner: rec.inner.map((i) => ({ uuid: i.uuid, label: i.label, kind: i.kind as StageTableRowKind })),
    canEditInner: rec.canEditInner,
    tableFields,
    formulaValues,
  };
}

function applyExtraGroupFilterInMemory(
  rows: readonly StageTableRow[],
  extra: TableExtraGroupFilterInput | null | undefined,
  colMap: ReadonlyMap<string, TableColumnSchema>,
): StageTableRow[] {
  if (!extra) return [...rows];
  const pinned = new Set(extra.pinnedUuids ?? []);
  const col = colMap.get(extra.columnId);

  return rows.filter((row) => {
    if (pinned.has(row.uuid)) return true;
    if (extra.columnId === "outer") {
      return extra.groupKey === null ? row.outer === null : row.outer?.uuid === extra.groupKey;
    }
    if (!col) return extra.groupKey === null;
    if (col.type === "formula") {
      const text = row.formulaValues?.[col.id]?.displayText?.trim() ?? "";
      return extra.groupKey === null ? text.length === 0 : text === extra.groupKey;
    }
    if (col.type === "select") {
      const raw = row.tableFields?.[col.id];
      const optId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
      const validIds = new Set((col.options ?? []).map((o) => o.id));
      const matched = optId && validIds.has(optId) ? optId : null;
      return matched === extra.groupKey;
    }
    const raw = row.tableFields?.[col.id];
    const str = typeof raw === "string" ? raw.trim() : "";
    return extra.groupKey === null ? str.length === 0 : str === extra.groupKey;
  });
}

function getDescendantsInMemory(rowByUuid: ReadonlyMap<string, StageTableRow>, startUuid: string): Set<string> {
  const visited = new Set<string>([startUuid]);
  const stack = [startUuid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const row = rowByUuid.get(cur);
    if (!row) continue;
    for (const child of row.inner) {
      if (!visited.has(child.uuid)) {
        visited.add(child.uuid);
        stack.push(child.uuid);
      }
    }
  }
  return visited;
}

function getAncestorsInMemory(rowByUuid: ReadonlyMap<string, StageTableRow>, startUuid: string): Set<string> {
  const visited = new Set<string>([startUuid]);
  let cur = rowByUuid.get(startUuid)?.outer?.uuid ?? null;
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    cur = rowByUuid.get(cur)?.outer?.uuid ?? null;
  }
  return visited;
}

export class SingleFileTableSource implements TableDataSource {
  public readonly scopeKind = "single_doc" as const;

  constructor(private readonly project: Project) {}

  public getDocId(): string | null {
    return this.project.v3DocId ?? null;
  }

  public isSqliteBacked(): boolean {
    return Boolean(this.project.isSqliteV3 && this.project.v3DocId && DocClient.isAvailable());
  }

  public getSystemColumnIds(): readonly AnySystemColumnId[] {
    return ALL_SYSTEM_COLUMN_IDS;
  }

  public getViews(): TableViewSchema[] {
    return this.project.stageTable.getViews?.() ?? this.project.table?.views ?? [this.getActiveView()];
  }

  public getActiveView(): TableViewSchema {
    return this.project.stageTable.getActiveView();
  }

  public getColumns(): TableColumnSchema[] {
    return this.project.stageTable.getColumns?.() ?? this.project.table?.columns ?? [];
  }

  public getVisibleColumnIds(): string[] {
    const active = this.getActiveView();
    return (
      this.project.stageTable.getVisibleColumnIds?.() ?? [
        "name",
        ...active.visibleColumnIds.filter((c) => c !== "name"),
      ]
    );
  }

  public getColumnGroups(): TableColumnGroup[] {
    return this.project.stageTable.getColumnGroups?.() ?? this.getActiveView().columnGroups ?? [];
  }

  public getFrozenColumnId(): string | null {
    const active = this.getActiveView();
    const visible = new Set(this.getVisibleColumnIds());
    return (
      this.project.stageTable.getFrozenColumnId?.() ??
      (active.frozenColumnId && visible.has(active.frozenColumnId) ? active.frozenColumnId : null)
    );
  }

  public getSort(): TableSortConfig | null {
    return this.project.stageTable.getSort?.() ?? this.getActiveView().sort ?? null;
  }

  public getFilters(): TableColumnFilter[] {
    return this.project.stageTable.getFilters?.() ?? this.getActiveView().filters ?? [];
  }

  public getFilterGroup(): TableFilterGroup {
    return (
      this.project.stageTable.getFilterGroup?.() ??
      this.getActiveView().filterGroup ?? { conjunction: "and", conditions: [] }
    );
  }

  public getSystemColumnCustomName(colId: AnySystemColumnId): string | undefined {
    if (colId === "sourceFile" || colId === "sourceFolder") return undefined;
    return this.project.stageTable.getSystemColumnCustomName?.(colId);
  }

  public getMediaUrl(_docId: string | null, attachmentId: string, options?: { thumb?: boolean }): string | null {
    return this.project.getAttachmentMediaUrl?.(attachmentId, options) ?? null;
  }

  public getAllRowsSync(): StageTableRow[] {
    return this.project.stageTable.getRows();
  }

  // ── 视图 CRUD ──
  public setActiveView(viewId: string): void {
    this.project.stageTable.setActiveView?.(viewId);
  }

  public createView(input: { type: TableViewType; name?: string }): TableViewSchema | null {
    return this.project.stageTable.createView?.(input) ?? null;
  }

  public renameView(viewId: string, name: string): void {
    this.project.stageTable.renameView?.(viewId, name);
  }

  public duplicateView(viewId: string, copySuffix?: string): void {
    this.project.stageTable.duplicateView?.(viewId, copySuffix);
  }

  public deleteView(viewId: string): void {
    this.project.stageTable.deleteView?.(viewId);
  }

  public reorderViews(dragViewId: string, targetViewId: string, position: "before" | "after"): void {
    this.project.stageTable.reorderViews?.(dragViewId, targetViewId, position);
  }

  public updateActiveViewConfig(patch: TableActiveViewConfigPatch): void {
    this.project.stageTable.updateActiveViewConfig?.(patch);
  }

  // ── 列 CRUD 与操作 ──
  public isColumnVisible(colId: string): boolean {
    return this.project.stageTable.isColumnVisible(colId);
  }

  public setColumnVisible(colId: string, visible: boolean): void {
    this.project.stageTable.setColumnVisible(colId, visible);
  }

  public setColumnWidth(colId: string, width: number): void {
    this.project.stageTable.setColumnWidth(colId, width);
  }

  public autoFitColumnWidth(colId: string, _rows?: readonly StageTableRow[], headerLabel?: string): void {
    this.project.stageTable.autoFitColumnWidth?.(colId, headerLabel ?? colId);
  }

  public toggleFreezeColumn(colId: string): void {
    this.project.stageTable.toggleFreezeUpToColumn?.(colId);
  }

  public reorderColumn(dragColId: string, targetColId: string, position: "before" | "after"): void {
    this.project.stageTable.reorderColumn?.(dragColId, targetColId, position);
  }

  public addCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    formula?: string;
    format?: string;
  }): TableColumnSchema | null {
    return this.project.stageTable.addCustomColumn?.(input) ?? null;
  }

  public insertCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    targetColumnId?: string;
    side?: "left" | "right";
  }): TableColumnSchema | null {
    return (
      this.project.stageTable.insertCustomColumn?.(input) ?? this.project.stageTable.addCustomColumn?.(input) ?? null
    );
  }

  public updateColumn(
    colId: string,
    patch: { name?: string; type?: CustomColumnType; formula?: string; format?: string },
  ): void {
    this.project.stageTable.updateColumn?.(colId, patch);
  }

  public duplicateCustomColumn(colId: string, copySuffix?: string): void {
    this.project.stageTable.duplicateCustomColumn?.(colId, copySuffix);
  }

  public deleteCustomColumn(colId: string): void {
    this.project.stageTable.deleteCustomColumn?.(colId);
  }

  public createOrGetSelectOption(colId: string, name: string): TableSelectOption | null {
    return this.project.stageTable.createOrGetSelectOption?.(colId, name) ?? null;
  }

  public createColumnGroup(name: string, columnIds: string[]): TableColumnGroup | null {
    return this.project.stageTable.createColumnGroup?.(name, columnIds) ?? null;
  }

  public renameColumnGroup(groupId: string, name: string): void {
    this.project.stageTable.renameColumnGroup?.(groupId, name);
  }

  public setColumnInGroup(colId: string, groupId: string | null): void {
    this.project.stageTable.setColumnInGroup?.(colId, groupId);
  }

  public dissolveColumnGroup(groupId: string): void {
    this.project.stageTable.dissolveColumnGroup?.(groupId);
  }

  // ── 排序与筛选 ──
  public setSort(sort: TableSortConfig | null): void {
    this.project.stageTable.setSort?.(sort);
  }

  public toggleColumnSort(colId: string, explicitDirection?: TableSortDirection): void {
    this.project.stageTable.toggleColumnSort?.(colId, explicitDirection);
  }

  public setColumnFilter(
    colId: string,
    filter: (Omit<TableColumnFilter, "columnId"> & { columnId?: string }) | null,
  ): void {
    this.project.stageTable.setColumnFilter?.(colId, filter);
  }

  public setFilterConjunction(conj: TableFilterConjunction): void {
    this.project.stageTable.setFilterConjunction?.(conj);
  }

  public addFilterCondition(colId?: string): TableFilterCondition | null {
    return this.project.stageTable.addFilterCondition?.(colId) ?? null;
  }

  public updateFilterCondition(id: string, patch: Partial<TableFilterCondition>): void {
    this.project.stageTable.updateFilterCondition?.(id, patch);
  }

  public removeFilterCondition(id: string): void {
    this.project.stageTable.removeFilterCondition?.(id);
  }

  public toggleFilterConditionCollapsed(id: string): void {
    this.project.stageTable.toggleFilterConditionCollapsed?.(id);
  }

  public reorderFilterConditions(dragId: string, targetId: string, position: "before" | "after"): void {
    this.project.stageTable.reorderFilterConditions?.(dragId, targetId, position);
  }

  public clearAllFilters(): void {
    this.project.stageTable.clearAllFilters?.();
  }

  // ── 间隔重复 ──
  public ensureSpacedRepetitionColumns(silent = true): void {
    this.project.stageTable.ensureSpacedRepetitionColumns?.(silent);
  }

  public addSpacedRepetitionCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    side: "front" | "back";
  }): TableColumnSchema | null {
    return this.project.stageTable.addSpacedRepetitionCustomColumn?.(input) ?? null;
  }

  public reorderSpacedRepetitionFields(
    side: "front" | "back",
    draggedColId: string,
    targetColId: string,
    position: SpacedRepetitionFieldDropPosition,
    currentRowsOrIds?: readonly string[][] | readonly string[],
  ): boolean {
    return (
      this.project.stageTable.reorderSpacedRepetitionFields?.(
        side,
        draggedColId,
        targetColId,
        position,
        currentRowsOrIds,
      ) ?? false
    );
  }

  public answerSpacedRepetitionRow(
    rowUuid: string,
    choice: SpacedRepetitionAnswerChoice,
    options?: { docId?: string | null; baseline?: SpacedRepetitionAnswerSnapshot; today?: Date },
  ): SpacedRepetitionAnswerSnapshot | null {
    return (
      this.project.stageTable.answerSpacedRepetitionRow?.(rowUuid, choice, {
        baseline: options?.baseline,
        today: options?.today,
      }) ?? null
    );
  }

  public restoreSpacedRepetitionRow(rowUuid: string, snapshot: SpacedRepetitionAnswerSnapshot): boolean {
    return this.project.stageTable.restoreSpacedRepetitionRow?.(rowUuid, snapshot) ?? false;
  }

  public updateRowPrimaryText(rowUuid: string, text: string): boolean {
    return this.project.stageTable.updateRowPrimaryText(rowUuid, text);
  }

  public updateRowCustomField(rowUuid: string, columnId: string, value: TableCellValue): boolean {
    return this.project.stageTable.updateRowCustomField(rowUuid, columnId, value);
  }

  public updateRowCustomFields(rowUuid: string, patch: Record<string, TableCellValue>): boolean {
    return this.project.stageTable.updateRowCustomFields(rowUuid, patch);
  }

  public setRowOuter(rowUuid: string, outerUuid: string | null): boolean {
    return this.project.stageTable.setRowOuter(rowUuid, outerUuid);
  }

  public async addRowImages(rowUuid: string, blobs: Blob[]): Promise<boolean> {
    return Boolean(await this.project.stageTable.addRowImages?.(rowUuid, blobs));
  }

  public removeRowImage(rowUuid: string, imageNodeUuid: string): boolean {
    return Boolean(this.project.stageTable.removeRowImage?.(rowUuid, imageNodeUuid));
  }

  public createRow(options?: {
    text?: string;
    tableFields?: TableFields;
    outerSectionUuid?: string | null;
  }): { uuid: string; docId?: string } | null {
    const created = this.project.stageTable.createRow?.(options);
    return created ? { uuid: created.uuid, docId: this.project.v3DocId ?? undefined } : null;
  }

  public refreshVolatileFormulasIfDayChanged(): boolean {
    return this.project.stageTable.refreshVolatileFormulasIfDayChanged?.() ?? false;
  }

  private async ensureBackendSynced(): Promise<void> {
    if (!this.isSqliteBacked()) return;
    const cols = this.getColumns();
    if (cols.some((c) => c.type === "formula") && !this.project.stageTable.formulaDag?.isInitialized?.()) {
      this.project.stageTable.syncFormulaCacheFull?.({ persistToSqlite: true });
    }
    await this.project.docCommandBus?.flush?.();
  }

  public queryPageSync(request: TablePageRequest): TablePageResponse {
    const allRows = this.project.stageTable.getRows();
    const columns = this.getColumns();
    const colMap = new Map(columns.map((c) => [c.id, c]));
    const filtered = applyTableFiltersAndSort(
      allRows,
      columns,
      request.filters ?? [],
      request.sort ?? null,
      request.filterGroup ?? null,
    );
    const grouped = applyExtraGroupFilterInMemory(filtered, request.extraGroupFilter, colMap);
    const offset = Math.max(0, request.offset ?? 0);
    const limit = Math.max(1, request.limit ?? Math.max(grouped.length, 1));
    return {
      totalCount: grouped.length,
      unfilteredTotalCount: allRows.length,
      offset,
      limit,
      rows: grouped.slice(offset, offset + limit),
    };
  }

  public async queryPage(request: TablePageRequest): Promise<TablePageResponse> {
    if (!this.isSqliteBacked()) {
      return this.queryPageSync(request);
    }
    await this.ensureBackendSynced();
    const docId = this.project.v3DocId!;
    const res = await DocClient.queryTablePage({
      docId,
      offset: request.offset ?? 0,
      limit: request.limit ?? 200,
      filters: (request.filters ?? []).map((f) => ({
        columnId: f.columnId,
        values: [...f.values],
        includeEmpty: f.includeEmpty,
      })),
      filterGroup: request.filterGroup
        ? {
            conjunction: request.filterGroup.conjunction,
            conditions: request.filterGroup.conditions.map((c) => ({
              id: c.id,
              columnId: c.columnId,
              operator: c.operator,
              value: c.value,
              values: c.values ? [...c.values] : undefined,
              datePreset: c.datePreset,
            })),
          }
        : null,
      sort: request.sort ? { columnId: request.sort.columnId, direction: request.sort.direction } : null,
      todayKey: request.todayKey ?? toLocalDateKey(new Date()),
      extraGroupFilter: request.extraGroupFilter ?? null,
    });
    return {
      totalCount: res.totalCount,
      unfilteredTotalCount: res.unfilteredTotalCount,
      offset: res.offset,
      limit: res.limit,
      rows: res.rows.map((r) => hydrateV3TableRow(this.project, r)),
    };
  }

  public async queryFilterBuckets(request: TableFilterBucketsRequest): Promise<TableFilterBucketsResponse> {
    if (this.isSqliteBacked()) {
      await this.ensureBackendSynced();
      const res: TableFilterBucketsResult = await DocClient.queryTableFilterBuckets({
        docId: this.project.v3DocId!,
        columnId: request.columnId,
        search: request.search,
        limit: request.limit ?? 300,
      });
      return {
        buckets: res.buckets.map((b) => ({
          key: b.key,
          label: b.label,
          count: b.count,
          ...(b.color ? { color: b.color } : {}),
        })),
        emptyCount: res.emptyCount,
        totalBuckets: res.totalBuckets,
      };
    }

    const allRows = this.project.stageTable.getRows();
    const customCol = this.getColumns().find((c) => c.id === request.columnId);
    const { buckets, emptyCount } = collectColumnFilterBuckets(allRows, request.columnId, customCol);
    const search = (request.search ?? "").trim().toLowerCase();
    const filtered = search ? buckets.filter((b) => b.label.toLowerCase().includes(search)) : buckets;
    const limit = request.limit ?? 300;
    return {
      buckets: filtered.slice(0, limit),
      emptyCount,
      totalBuckets: filtered.length,
    };
  }

  public async queryRelationCandidates(
    request: TableRelationCandidatesRequest,
  ): Promise<TableRelationCandidatesResponse> {
    const limit = request.limit ?? 50;
    if (this.isSqliteBacked()) {
      await this.ensureBackendSynced();
      const res: TableRelationCandidatesResult = await DocClient.queryTableRelationCandidates({
        docId: this.project.v3DocId!,
        rowUuid: request.rowUuid,
        relationKind: request.relationKind,
        search: request.search,
        limit,
      });
      return {
        candidates: res.candidates.map((c) => ({
          uuid: c.uuid,
          label: c.label,
          kind: c.kind as StageTableRowKind,
        })),
        totalCount: res.totalCount,
        hasMore: res.hasMore,
      };
    }

    const allRows = this.project.stageTable.getRows();
    const rowByUuid = new Map(allRows.map((r) => [r.uuid, r]));
    const search = (request.search ?? "").trim().toLowerCase();
    const excluded =
      request.relationKind === "outer"
        ? getDescendantsInMemory(rowByUuid, request.rowUuid)
        : request.relationKind === "inner"
          ? getAncestorsInMemory(rowByUuid, request.rowUuid)
          : new Set<string>([request.rowUuid]);

    const matched: StageTableRelationItem[] = [];
    for (const candidate of allRows) {
      if (excluded.has(candidate.uuid)) continue;
      if (request.relationKind === "outer") {
        const isContainer = candidate.kind === "section" || candidate.kind === "text";
        if (!isContainer) continue;
      }
      if (search && !candidate.primaryText.toLowerCase().includes(search)) continue;
      matched.push({
        uuid: candidate.uuid,
        label: candidate.primaryText,
        kind: candidate.kind,
      });
    }

    return {
      candidates: matched.slice(0, limit),
      totalCount: matched.length,
      hasMore: matched.length > limit,
    };
  }

  public async queryGroupCounts(request: TableGroupCountsRequest): Promise<TableGroupCountsResponse> {
    if (this.isSqliteBacked()) {
      await this.ensureBackendSynced();
      const res: TableGroupCountsResult = await DocClient.queryTableGroupCounts({
        docId: this.project.v3DocId!,
        groupByColumnId: request.groupByColumnId,
        filters: (request.filters ?? []).map((f) => ({
          columnId: f.columnId,
          values: [...f.values],
          includeEmpty: f.includeEmpty,
        })),
        filterGroup: request.filterGroup
          ? {
              conjunction: request.filterGroup.conjunction,
              conditions: request.filterGroup.conditions.map((c) => ({
                id: c.id,
                columnId: c.columnId,
                operator: c.operator,
                value: c.value,
                values: c.values ? [...c.values] : undefined,
                datePreset: c.datePreset,
              })),
            }
          : null,
        todayKey: request.todayKey ?? toLocalDateKey(new Date()),
      });
      return {
        totalCount: res.totalCount,
        ungroupedCount: res.ungroupedCount,
        groups: res.groups.map((g) => ({
          key: g.key,
          label: g.label,
          count: g.count,
          ...(g.color ? { color: g.color } : {}),
        })),
      };
    }

    const allRows = this.project.stageTable.getRows();
    const columns = this.getColumns();
    const rows = applyTableFiltersAndSort(allRows, columns, request.filters ?? [], null, request.filterGroup ?? null);
    const col = columns.find((c) => c.id === request.groupByColumnId);

    if (request.groupByColumnId === "outer") {
      const bucketMap = new Map<string, TableGroupCountEntry>();
      for (const r of allRows) {
        if (r.kind === "section") {
          bucketMap.set(r.uuid, { key: r.uuid, label: r.primaryText, count: 0 });
        }
      }
      let ungroupedCount = 0;
      for (const row of rows) {
        if (row.outer) {
          const existing = bucketMap.get(row.outer.uuid);
          if (existing) existing.count++;
          else bucketMap.set(row.outer.uuid, { key: row.outer.uuid, label: row.outer.label, count: 1 });
        } else {
          ungroupedCount++;
        }
      }
      return { totalCount: rows.length, ungroupedCount, groups: Array.from(bucketMap.values()) };
    }

    if (!col) {
      return { totalCount: rows.length, ungroupedCount: rows.length, groups: [] };
    }

    if (col.type === "select") {
      const bucketMap = new Map<string, TableGroupCountEntry>(
        (col.options ?? []).map((o) => [o.id, { key: o.id, label: o.name, count: 0, color: o.color }]),
      );
      let ungroupedCount = 0;
      for (const row of rows) {
        const raw = row.tableFields?.[col.id];
        const optId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
        const bucket = optId ? bucketMap.get(optId) : undefined;
        if (bucket) bucket.count++;
        else ungroupedCount++;
      }
      return { totalCount: rows.length, ungroupedCount, groups: Array.from(bucketMap.values()) };
    }

    const textBuckets = new Map<string, TableGroupCountEntry>();
    let ungroupedCount = 0;
    for (const row of rows) {
      const val =
        col.type === "formula"
          ? (row.formulaValues?.[col.id]?.displayText?.trim() ?? "")
          : typeof row.tableFields?.[col.id] === "string"
            ? (row.tableFields[col.id] as string).trim()
            : "";
      if (!val) {
        ungroupedCount++;
        continue;
      }
      const existing = textBuckets.get(val);
      if (existing) existing.count++;
      else textBuckets.set(val, { key: val, label: val, count: 1 });
    }
    return { totalCount: rows.length, ungroupedCount, groups: Array.from(textBuckets.values()) };
  }

  public async queryDateRange(request: TableDateRangeRequest): Promise<TableDateRangeResponse> {
    if (this.isSqliteBacked()) {
      await this.ensureBackendSynced();
      const res: TableDateRangeResult = await DocClient.queryTableDateRange({
        docId: this.project.v3DocId!,
        startColumnId: request.startColumnId,
        endColumnId: request.endColumnId ?? null,
        minDate: request.minDate,
        maxDate: request.maxDate,
        filters: (request.filters ?? []).map((f) => ({
          columnId: f.columnId,
          values: [...f.values],
          includeEmpty: f.includeEmpty,
        })),
        filterGroup: request.filterGroup
          ? {
              conjunction: request.filterGroup.conjunction,
              conditions: request.filterGroup.conditions.map((c) => ({
                id: c.id,
                columnId: c.columnId,
                operator: c.operator,
                value: c.value,
                values: c.values ? [...c.values] : undefined,
                datePreset: c.datePreset,
              })),
            }
          : null,
        sort: request.sort ? { columnId: request.sort.columnId, direction: request.sort.direction } : null,
        todayKey: request.todayKey ?? toLocalDateKey(new Date()),
        includeUndated: request.includeUndated ?? false,
        undatedLimit: request.undatedLimit ?? 200,
      });
      return {
        rows: res.rows.map((r) => hydrateV3TableRow(this.project, r)),
        undatedCount: res.undatedCount,
        undatedRows: res.undatedRows.map((r) => hydrateV3TableRow(this.project, r)),
        totalFilteredCount: res.totalFilteredCount,
      };
    }

    const allRows = this.project.stageTable.getRows();
    const columns = this.getColumns();
    const colMap = new Map(columns.map((c) => [c.id, c]));
    const filtered = applyTableFiltersAndSort(
      allRows,
      columns,
      request.filters ?? [],
      request.sort ?? null,
      request.filterGroup ?? null,
    );
    const inRange: StageTableRow[] = [];
    const undated: StageTableRow[] = [];
    let undatedCount = 0;
    const undatedCap = request.undatedLimit ?? 200;

    for (const row of filtered) {
      const range = resolveRowDateRange(row, request.startColumnId, request.endColumnId ?? null, colMap);
      if (!range) {
        undatedCount++;
        if (request.includeUndated && undated.length < undatedCap) {
          undated.push(row);
        }
        continue;
      }
      if (range.startKey <= request.maxDate && range.endKey >= request.minDate) {
        inRange.push(row);
      }
    }

    return {
      rows: inRange,
      undatedCount,
      undatedRows: undated,
      totalFilteredCount: filtered.length,
    };
  }

  public async executeMutation(mutation: TableDataSourceMutation): Promise<boolean> {
    const st = this.project.stageTable;
    switch (mutation.type) {
      case "update_primary_text":
        return st.updateRowPrimaryText(mutation.rowUuid, mutation.text);
      case "update_custom_field":
        return st.updateRowCustomField(mutation.rowUuid, mutation.columnId, mutation.value);
      case "update_custom_fields":
        return st.updateRowCustomFields(mutation.rowUuid, mutation.patch);
      case "set_parents":
        return st.setRowParents(mutation.rowUuid, mutation.parentUuids);
      case "set_children":
        return st.setRowChildren(mutation.rowUuid, mutation.childUuids);
      case "set_outer":
        return st.setRowOuter(mutation.rowUuid, mutation.outerUuid);
      case "set_inner":
        return st.setRowInner(mutation.rowUuid, mutation.innerUuids);
      case "add_images":
        return Boolean(await st.addRowImages?.(mutation.rowUuid, mutation.blobs));
      case "remove_image":
        return Boolean(st.removeRowImage?.(mutation.rowUuid, mutation.imageNodeUuid));
      case "create_row":
        return Boolean(
          st.createRow?.({
            text: mutation.text,
            tableFields: mutation.tableFields,
            outerSectionUuid: mutation.outerSectionUuid,
          }),
        );
      case "answer_spaced_repetition":
        return Boolean(
          st.answerSpacedRepetitionRow?.(mutation.rowUuid, mutation.choice, {
            baseline: mutation.baseline,
            today: mutation.today,
          }),
        );
      case "restore_spaced_repetition":
        return Boolean(st.restoreSpacedRepetitionRow?.(mutation.rowUuid, mutation.snapshot));
    }
  }

  public jumpToNode(_docId: string | null, uuid: string, panelWidthPx?: number): void {
    this.project.stageTable.focusRowOnCanvas(uuid, panelWidthPx);
  }

  public selectRows(uuids: string[], options?: { focusCamera?: boolean; panelWidthPx?: number }): void {
    if (options === undefined) {
      this.project.stageTable.selectRowsOnCanvas?.(uuids);
    } else {
      this.project.stageTable.selectRowsOnCanvas?.(uuids, options);
    }
  }

  public getSelectedRowUUIDs(): string[] {
    return this.project.stageTable.getSelectedRowUUIDs?.() ?? [];
  }

  public subscribeChanges(listener: () => void): () => void {
    const unsubTable = this.project.stageTable.subscribe(listener);
    const onCommit = () => listener();
    const onStateChange = () => listener();
    this.project.on?.("stage-commit", onCommit);
    this.project.on?.("state-change", onStateChange);
    return () => {
      unsubTable();
      this.project.off?.("stage-commit", onCommit);
      this.project.off?.("state-change", onStateChange);
    };
  }

  public subscribeSelection(listener: (uuids: string[]) => void): () => void {
    return this.project.stageTable.subscribeSelection?.(listener) ?? (() => {});
  }
}

export function createSingleFileTableSource(project: Project): SingleFileTableSource {
  return new SingleFileTableSource(project);
}
