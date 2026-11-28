import { buildFluxMediaUrl, DocClient } from "@/core/sqlite/DocClient";
import {
  WorkspaceClient,
  type SpacedRepetitionSnapshotDto,
  type WorkspaceCellWriteInput,
  type WorkspaceColumnRecord,
  type WorkspaceDocRecord,
  type WorkspaceViewRecord,
} from "@/core/sqlite/WorkspaceClient";
import {
  ALL_WORKSPACE_SYSTEM_COLUMN_IDS,
  createColumnGroupId,
  createFilterConditionId,
  createSelectOptionId,
  createTableViewId,
  getColumnFilterKind,
  getDefaultFilterOperator,
  pickNextSelectOptionColor,
  toLocalDateKey,
  type AnySystemColumnId,
  type CustomColumnType,
  type SpacedRepetitionAnswerChoice,
  type SpacedRepetitionColumnRole,
  type SpacedRepetitionFieldDropPosition,
  type TableCellValue,
  type TableColumnFilter,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableFields,
  type TableFilterCondition,
  type TableFilterConjunction,
  type TableFilterGroup,
  type TableSelectOption,
  type TableSortConfig,
  type TableSortDirection,
  type TableViewSchema,
  type TableViewType,
  type WorkspaceTableScope,
} from "@/types/table";
import type { SpacedRepetitionAnswerSnapshot, StageTableRow, StageTableRowKind } from "./StageTableService";
import {
  hydrateV3TableRow,
  type TableActiveViewConfigPatch,
  type TableDataSource,
  type TableDataSourceMutation,
  type TableDateRangeRequest,
  type TableDateRangeResponse,
  type TableFilterBucketsRequest,
  type TableFilterBucketsResponse,
  type TableGroupCountsRequest,
  type TableGroupCountsResponse,
  type TablePageRequest,
  type TablePageResponse,
  type TableRelationCandidatesRequest,
  type TableRelationCandidatesResponse,
} from "./TableDataSource";

const DEFAULT_WS_VIEW_ID = "default-ws-table-view";

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface WorkspaceStoredView extends TableViewSchema {
  scope: WorkspaceTableScope;
}

function hydrateWorkspaceColumn(rec: WorkspaceColumnRecord): TableColumnSchema {
  const cfg = safeParseJson<Partial<TableColumnSchema>>(rec.configJson, {});
  const protectedRole =
    cfg.protectedRole ??
    (rec.canonicalKey.startsWith("role:sr:")
      ? (rec.canonicalKey.slice("role:sr:".length) as SpacedRepetitionColumnRole)
      : undefined);
  return {
    id: rec.canonicalKey,
    canonicalKey: rec.canonicalKey,
    isShared: rec.isShared,
    name: rec.name,
    type: rec.type as CustomColumnType,
    ...(cfg.width !== undefined ? { width: cfg.width } : {}),
    ...(Array.isArray(cfg.options) ? { options: cfg.options } : {}),
    ...(cfg.format !== undefined ? { format: cfg.format } : {}),
    ...(cfg.formula !== undefined ? { formula: cfg.formula } : {}),
    ...(protectedRole ? { protectedRole } : {}),
  };
}

function hydrateWorkspaceView(rec: WorkspaceViewRecord): WorkspaceStoredView {
  const cfg = safeParseJson<Partial<TableViewSchema>>(rec.configJson, {});
  const visible = Array.isArray(cfg.visibleColumnIds)
    ? ["name", ...cfg.visibleColumnIds.filter((id): id is string => typeof id === "string" && id !== "name")]
    : ["name", "sourceFile", "updatedAt"];
  return {
    ...cfg,
    id: rec.id,
    name: rec.name,
    type: (rec.type as TableViewType) || "table",
    deletable: rec.deletable,
    visibleColumnIds: Array.from(new Set(visible)),
    columnWidths: cfg.columnWidths ?? {},
    scope: rec.scope ?? { kind: "all", paths: [] },
  };
}

function serializeWorkspaceView(view: WorkspaceStoredView, position: number): WorkspaceViewRecord {
  const { id, name, type, deletable, scope, ...rest } = view;
  return {
    id,
    name,
    type,
    deletable,
    position,
    scope,
    configJson: JSON.stringify({ ...rest, deletable }),
  };
}

function createFallbackWorkspaceView(scope: WorkspaceTableScope): WorkspaceStoredView {
  return {
    id: DEFAULT_WS_VIEW_ID,
    name: "工作空间总表",
    type: "table",
    deletable: false,
    visibleColumnIds: ["name", "sourceFile", "updatedAt"],
    columnWidths: {},
    scope,
  };
}

export interface WorkspaceTableSourceOptions {
  /** 覆盖作用域（右侧分屏切到「当前文件夹 / 整个工作空间」时使用；为空则按当前视图持久化 scope） */
  overrideScope?: WorkspaceTableScope | null;
  /** 新建行时的默认目标文档 docId（如当前打开画布的 docId） */
  defaultCreateDocId?: string | null;
  /** 若传入初始视图类型（例如从侧栏点击「全局间隔重复」），初始化后自动切换或新建该视图 */
  initialViewType?: TableViewType | null;
}

/**
 * 跨文件工作空间多维表格数据源：
 * - 查询全部直连 `.flux-graph/index.sqlite`（支持 `all` / `folders` / `docs` 作用域、10,000 行 `< 5 ms`）；
 * - 写回按 `row.docId` 经 Rust `DocumentActorPool` 原子提交到源 `.prg`，并同步刷新 `index.sqlite` 与已打开画布；
 * - 零重复代码复用全部 6 大视图（表格、看板、甘特、画册、日历、间隔重复）。
 */
export class WorkspaceTableSource implements TableDataSource {
  public readonly scopeKind = "workspace" as const;

  private readonly listeners = new Set<() => void>();
  private readonly selectionListeners = new Set<(uuids: string[]) => void>();
  private selectedRowIds: string[] = [];

  private docs: WorkspaceDocRecord[] = [];
  private docsById = new Map<string, WorkspaceDocRecord>();
  private columnsMeta: WorkspaceColumnRecord[] = [];
  private columns: TableColumnSchema[] = [];
  private views: WorkspaceStoredView[] = [createFallbackWorkspaceView({ kind: "all", paths: [] })];
  private activeViewId = DEFAULT_WS_VIEW_ID;
  private systemColumnNames: Partial<Record<AnySystemColumnId, string>> = {};

  private overrideScope: WorkspaceTableScope | null;
  private defaultCreateDocId: string | null;
  private initialViewType: TableViewType | null;
  private disposed = false;
  private unlistenIndex: (() => void) | null = null;
  private readonly rowDocIdMap = new Map<string, string>();
  private readonly rowCacheByKey = new Map<string, StageTableRow>();
  private lastLoadedRows: StageTableRow[] = [];

  constructor(options: WorkspaceTableSourceOptions = {}) {
    this.overrideScope = options.overrideScope ?? null;
    this.defaultCreateDocId = options.defaultCreateDocId ?? null;
    this.initialViewType = options.initialViewType ?? null;
    if (WorkspaceClient.isAvailable()) {
      void this.initialize();
    }
  }

  public async initialize(): Promise<void> {
    if (this.disposed || !WorkspaceClient.isAvailable()) return;
    try {
      let root: string | null = null;
      try {
        const { WorkspaceManager } = await import("@/core/service/workspace/WorkspaceManager");
        root = WorkspaceManager.root ?? null;
      } catch {
        root = null;
      }
      if (root) {
        // 确保后端 index.sqlite 已挂载（若已打开则增量 stat 校验 < 1ms）
        try {
          await WorkspaceClient.syncIncremental();
        } catch {
          await WorkspaceClient.openWorkspace(root);
        }
      }
      await this.refreshWorkspaceMetadata();
      if (this.initialViewType) {
        const targetType = this.initialViewType;
        this.initialViewType = null;
        const existing = this.views.find((v) => v.type === targetType);
        if (existing) {
          this.setActiveView(existing.id);
        } else {
          this.createView({
            type: targetType,
            name: targetType === "spaced_repetition" ? "全局间隔重复" : undefined,
          });
        }
      }
      if (!this.unlistenIndex && !this.disposed) {
        this.unlistenIndex = await WorkspaceClient.onIndexUpdated(() => {
          if (!this.disposed) {
            void this.refreshWorkspaceMetadata();
          }
        });
      }
      this.notifyChange();
    } catch {
      // 非 Tauri 或工作空间尚未打开时静默降级
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.unlistenIndex?.();
    this.unlistenIndex = null;
    this.listeners.clear();
    this.selectionListeners.clear();
  }

  public async refreshWorkspaceMetadata(): Promise<void> {
    if (!WorkspaceClient.isAvailable()) return;
    const [docs, cols, views, metaJson] = await Promise.all([
      WorkspaceClient.listDocs(),
      WorkspaceClient.listColumns(),
      WorkspaceClient.listViews(),
      WorkspaceClient.getTableMeta(),
    ]);
    if (this.disposed) return;

    this.docs = docs;
    this.docsById = new Map(docs.map((d) => [d.docId, d]));
    this.columnsMeta = cols;
    this.columns = cols.map(hydrateWorkspaceColumn);

    const parsedViews =
      views.length > 0 ? views.map(hydrateWorkspaceView) : [createFallbackWorkspaceView({ kind: "all", paths: [] })];
    this.views = parsedViews;

    const meta = safeParseJson<{
      activeViewId?: string;
      systemColumnNames?: Partial<Record<AnySystemColumnId, string>>;
    }>(metaJson, {});
    if (meta.activeViewId && this.views.some((v) => v.id === meta.activeViewId)) {
      this.activeViewId = meta.activeViewId;
    } else if (!this.views.some((v) => v.id === this.activeViewId)) {
      this.activeViewId = this.views[0].id;
    }
    this.systemColumnNames = meta.systemColumnNames ?? {};
    this.notifyChange();
  }

  private notifyChange(): void {
    for (const fn of [...this.listeners]) {
      fn();
    }
  }

  private persistView(viewId: string): void {
    if (this.overrideScope || !WorkspaceClient.isAvailable()) return;
    const idx = this.views.findIndex((v) => v.id === viewId);
    if (idx === -1) return;
    void WorkspaceClient.upsertView(serializeWorkspaceView(this.views[idx], idx));
  }

  private persistMeta(): void {
    if (this.overrideScope || !WorkspaceClient.isAvailable()) return;
    void WorkspaceClient.updateTableMeta(
      JSON.stringify({
        activeViewId: this.activeViewId,
        systemColumnNames: this.systemColumnNames,
      }),
    );
  }

  public getDocId(): string | null {
    return null;
  }

  public isSqliteBacked(): boolean {
    return WorkspaceClient.isAvailable();
  }

  public getSystemColumnIds(): readonly AnySystemColumnId[] {
    return ALL_WORKSPACE_SYSTEM_COLUMN_IDS;
  }

  public getScope(): WorkspaceTableScope {
    if (this.overrideScope) return this.overrideScope;
    return this.getActiveStoredView().scope ?? { kind: "all", paths: [] };
  }

  public setScope(scope: WorkspaceTableScope): void {
    if (this.overrideScope) {
      this.overrideScope = scope;
      this.notifyChange();
      return;
    }
    const active = this.getActiveStoredView();
    active.scope = { kind: scope.kind, paths: [...scope.paths] };
    this.persistView(active.id);
    this.notifyChange();
  }

  public setOverrideScope(scope: WorkspaceTableScope | null): void {
    this.overrideScope = scope;
    this.notifyChange();
  }

  public getWorkspaceDocs(): WorkspaceDocRecord[] {
    return this.docs;
  }

  public getWorkspaceColumnsMeta(): WorkspaceColumnRecord[] {
    return this.columnsMeta;
  }

  public getDefaultCreateDocId(): string | null {
    if (this.defaultCreateDocId && this.docsById.has(this.defaultCreateDocId)) {
      return this.defaultCreateDocId;
    }
    const scope = this.getScope();
    if (scope.kind === "docs" && scope.paths.length > 0) {
      const target = scope.paths[0].replace(/\\/g, "/").toLowerCase();
      const matched = this.docs.find((d) => d.relPath.toLowerCase() === target || d.docId === scope.paths[0]);
      if (matched) return matched.docId;
    }
    if (scope.kind === "folders" && scope.paths.length > 0) {
      const folder = scope.paths[0]
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase();
      const matched = this.docs.find(
        (d) => d.folderPath.toLowerCase() === folder || d.folderPath.toLowerCase().startsWith(`${folder}/`),
      );
      if (matched) return matched.docId;
    }
    return this.docs[0]?.docId ?? null;
  }

  public setDefaultCreateDocId(docId: string | null): void {
    this.defaultCreateDocId = docId;
  }

  private getActiveStoredView(): WorkspaceStoredView {
    return this.views.find((v) => v.id === this.activeViewId) ?? this.views[0];
  }

  public getViews(): TableViewSchema[] {
    return this.views;
  }

  public getActiveView(): TableViewSchema {
    return this.getActiveStoredView();
  }

  public getColumns(): TableColumnSchema[] {
    return this.columns;
  }

  public getVisibleColumnIds(): string[] {
    const active = this.getActiveStoredView();
    const validIds = new Set<string>([...ALL_WORKSPACE_SYSTEM_COLUMN_IDS, ...this.columns.map((c) => c.id)]);
    const filtered = (active.visibleColumnIds ?? []).filter((id) => id !== "name" && validIds.has(id));
    return ["name", ...Array.from(new Set(filtered))];
  }

  public getColumnGroups(): TableColumnGroup[] {
    return this.getActiveStoredView().columnGroups ?? [];
  }

  public getFrozenColumnId(): string | null {
    const active = this.getActiveStoredView();
    const visible = new Set(this.getVisibleColumnIds());
    return active.frozenColumnId && visible.has(active.frozenColumnId) ? active.frozenColumnId : null;
  }

  public getSort(): TableSortConfig | null {
    return this.getActiveStoredView().sort ?? null;
  }

  public getFilters(): TableColumnFilter[] {
    return this.getActiveStoredView().filters ?? [];
  }

  public getFilterGroup(): TableFilterGroup {
    return this.getActiveStoredView().filterGroup ?? { conjunction: "and", conditions: [] };
  }

  public getSystemColumnCustomName(colId: AnySystemColumnId): string | undefined {
    return this.systemColumnNames[colId];
  }

  public getMediaUrl(docId: string | null, attachmentId: string, options?: { thumb?: boolean }): string | null {
    if (!docId || !attachmentId || !DocClient.isAvailable()) return null;
    return buildFluxMediaUrl(docId, attachmentId, options);
  }

  public getAllRowsSync(): StageTableRow[] {
    return this.lastLoadedRows;
  }

  public getCachedRow(rowUuid: string, docId?: string | null): StageTableRow | undefined {
    const resolvedDoc = docId ?? this.rowDocIdMap.get(rowUuid);
    if (resolvedDoc) {
      const exact = this.rowCacheByKey.get(`${resolvedDoc}:${rowUuid}`);
      if (exact) return exact;
    }
    return this.rowCacheByKey.get(rowUuid);
  }

  // ── 视图 CRUD ──
  public setActiveView(viewId: string): void {
    if (!this.views.some((v) => v.id === viewId)) return;
    this.activeViewId = viewId;
    if (this.getActiveStoredView().type === "spaced_repetition") {
      this.ensureSpacedRepetitionColumns();
    }
    this.persistMeta();
    this.notifyChange();
  }

  public createView(input: {
    type: TableViewType;
    name?: string;
    scope?: WorkspaceTableScope;
  }): TableViewSchema | null {
    const baseName = input.name?.trim() || "新视图";
    const existingNames = new Set(this.views.map((v) => v.name));
    let finalName = baseName;
    let suffix = 2;
    while (existingNames.has(finalName)) {
      finalName = `${baseName} ${suffix++}`;
    }
    const view: WorkspaceStoredView = {
      id: createTableViewId(),
      name: finalName,
      type: input.type,
      deletable: true,
      visibleColumnIds: ["name", "sourceFile", "updatedAt"],
      columnWidths: {},
      scope: input.scope ?? this.getScope(),
      ...(input.type === "spaced_repetition"
        ? { spacedRepetition: { columns: 2, queueTab: "due", imageFit: "contain" } }
        : {}),
    };
    this.views = [...this.views, view];
    this.activeViewId = view.id;
    this.persistView(view.id);
    this.persistMeta();
    if (input.type === "spaced_repetition") {
      this.ensureSpacedRepetitionColumns();
    }
    this.notifyChange();
    return view;
  }

  public renameView(viewId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.views = this.views.map((v) => (v.id === viewId ? { ...v, name: trimmed } : v));
    this.persistView(viewId);
    this.notifyChange();
  }

  public duplicateView(viewId: string, copySuffix = "副本"): void {
    const source = this.views.find((v) => v.id === viewId);
    if (!source) return;
    const clone: WorkspaceStoredView = {
      ...structuredClone(source),
      id: createTableViewId(),
      name: `${source.name} ${copySuffix}`.trim(),
      deletable: true,
    };
    this.views = [...this.views, clone];
    this.activeViewId = clone.id;
    this.persistView(clone.id);
    this.persistMeta();
    this.notifyChange();
  }

  public deleteView(viewId: string): void {
    const target = this.views.find((v) => v.id === viewId);
    if (!target || !target.deletable || this.views.length <= 1) return;
    this.views = this.views.filter((v) => v.id !== viewId);
    if (this.activeViewId === viewId) {
      this.activeViewId = this.views[0].id;
      this.persistMeta();
    }
    if (!this.overrideScope && WorkspaceClient.isAvailable()) {
      void WorkspaceClient.deleteView(viewId);
    }
    this.notifyChange();
  }

  public reorderViews(dragViewId: string, targetViewId: string, position: "before" | "after"): void {
    if (dragViewId === targetViewId) return;
    const list = [...this.views];
    const fromIdx = list.findIndex((v) => v.id === dragViewId);
    if (fromIdx === -1) return;
    const [moved] = list.splice(fromIdx, 1);
    const toIdx = list.findIndex((v) => v.id === targetViewId);
    if (toIdx === -1) return;
    list.splice(position === "before" ? toIdx : toIdx + 1, 0, moved);
    this.views = list;
    if (!this.overrideScope && WorkspaceClient.isAvailable()) {
      void WorkspaceClient.reorderViews(list.map((v) => v.id));
    }
    this.notifyChange();
  }

  public updateActiveViewConfig(patch: TableActiveViewConfigPatch): void {
    const active = this.getActiveStoredView();
    const updated: WorkspaceStoredView = {
      ...active,
      ...(patch.rowHeight !== undefined ? { rowHeight: patch.rowHeight } : {}),
      ...(patch.kanban ? { kanban: { ...(active.kanban ?? {}), ...patch.kanban } } : {}),
      ...(patch.gantt ? { gantt: { ...(active.gantt ?? {}), ...patch.gantt } } : {}),
      ...(patch.gallery ? { gallery: { ...(active.gallery ?? {}), ...patch.gallery } } : {}),
      ...(patch.calendar ? { calendar: { ...(active.calendar ?? {}), ...patch.calendar } } : {}),
      ...(patch.spacedRepetition
        ? { spacedRepetition: { ...(active.spacedRepetition ?? {}), ...patch.spacedRepetition } }
        : {}),
    };
    this.views = this.views.map((v) => (v.id === active.id ? updated : v));
    this.persistView(active.id);
    this.notifyChange();
  }

  // ── 列显隐 / 宽 / 冻结 / 排序 / 编组 / 共享字段 ──
  public isColumnVisible(colId: string): boolean {
    return this.getVisibleColumnIds().includes(colId);
  }

  public setColumnVisible(colId: string, visible: boolean): void {
    if (colId === "name") return;
    const active = this.getActiveStoredView();
    const current = this.getVisibleColumnIds();
    const next = visible
      ? current.includes(colId)
        ? current
        : [...current, colId]
      : current.filter((id) => id !== colId);
    active.visibleColumnIds = next;
    this.persistView(active.id);
    this.notifyChange();
  }

  public setColumnWidth(colId: string, width: number): void {
    const active = this.getActiveStoredView();
    active.columnWidths = { ...(active.columnWidths ?? {}), [colId]: Math.max(80, Math.min(600, Math.round(width))) };
    this.persistView(active.id);
    this.notifyChange();
  }

  public autoFitColumnWidth(colId: string): void {
    const col = this.columns.find((c) => c.id === colId);
    const width = colId === "name" ? 240 : colId === "sourceFile" ? 170 : col?.type === "text" ? 200 : 150;
    this.setColumnWidth(colId, width);
  }

  public toggleFreezeColumn(colId: string): void {
    const active = this.getActiveStoredView();
    active.frozenColumnId = active.frozenColumnId === colId ? null : colId;
    this.persistView(active.id);
    this.notifyChange();
  }

  public reorderColumn(dragColId: string, targetColId: string, position: "before" | "after"): void {
    if (dragColId === "name" || dragColId === targetColId) return;
    const active = this.getActiveStoredView();
    const list = this.getVisibleColumnIds().filter((id) => id !== dragColId);
    const idx = list.indexOf(targetColId);
    if (idx === -1) return;
    const insertIdx = targetColId === "name" ? 1 : position === "before" ? Math.max(1, idx) : idx + 1;
    list.splice(insertIdx, 0, dragColId);
    active.visibleColumnIds = list;
    this.persistView(active.id);
    this.notifyChange();
  }

  public addCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    formula?: string;
    format?: string;
  }): TableColumnSchema | null {
    const tempKey = `ws:${crypto.randomUUID()}`;
    const cfg: Record<string, unknown> = {};
    if (input.formula) cfg.formula = input.formula;
    if (input.format) cfg.format = input.format;
    if (input.type === "select" || input.type === "multi_select") cfg.options = [];
    const created: TableColumnSchema = {
      id: tempKey,
      canonicalKey: tempKey,
      isShared: true,
      name: input.name.trim() || input.type,
      type: input.type,
      ...(input.formula ? { formula: input.formula } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.type === "select" || input.type === "multi_select" ? { options: [] } : {}),
    };
    this.columns = [...this.columns, created];
    const active = this.getActiveStoredView();
    active.visibleColumnIds = [...this.getVisibleColumnIds(), created.id];
    this.notifyChange();

    if (WorkspaceClient.isAvailable()) {
      void WorkspaceClient.createSharedColumn(created.name, created.type, JSON.stringify(cfg)).then((saved) => {
        if (this.disposed) return;
        // 将临时 key 替换为后端返回的正式 canonicalKey
        this.columns = this.columns.map((c) => (c.id === tempKey ? hydrateWorkspaceColumn(saved) : c));
        active.visibleColumnIds = active.visibleColumnIds.map((id) => (id === tempKey ? saved.canonicalKey : id));
        this.persistView(active.id);
        this.notifyChange();
      });
    }
    return created;
  }

  public insertCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    targetColumnId?: string;
    side?: "left" | "right";
  }): TableColumnSchema | null {
    const created = this.addCustomColumn({ name: input.name, type: input.type });
    if (created && input.targetColumnId) {
      this.reorderColumn(created.id, input.targetColumnId, input.side === "left" ? "before" : "after");
    }
    return created;
  }

  public updateColumn(
    colId: string,
    patch: { name?: string; type?: CustomColumnType; formula?: string; format?: string },
  ): void {
    if (ALL_WORKSPACE_SYSTEM_COLUMN_IDS.includes(colId as AnySystemColumnId)) {
      if (patch.name !== undefined) {
        const trimmed = patch.name.trim();
        if (trimmed) this.systemColumnNames[colId as AnySystemColumnId] = trimmed;
        else delete this.systemColumnNames[colId as AnySystemColumnId];
        this.persistMeta();
        this.notifyChange();
      }
      return;
    }
    const existing = this.columns.find((c) => c.id === colId);
    if (!existing) return;
    if (patch.name && patch.name.trim() && patch.name.trim() !== existing.name && WorkspaceClient.isAvailable()) {
      void WorkspaceClient.promoteColumnToShared(colId, patch.name.trim()).then(() => this.refreshWorkspaceMetadata());
    }
  }

  public deleteCustomColumn(colId: string): void {
    // 跨文件模式下“删除列”在当前视图中隐藏该列，避免误删工作空间中多个 .prg 源文件的数据
    this.setColumnVisible(colId, false);
  }

  public createOrGetSelectOption(colId: string, name: string): TableSelectOption | null {
    const clean = name.trim();
    if (!clean) return null;
    const col = this.columns.find((c) => c.id === colId);
    if (!col || (col.type !== "select" && col.type !== "multi_select")) return null;
    const existing = (col.options ?? []).find((o) => o.name.trim().toLowerCase() === clean.toLowerCase());
    if (existing) return existing;

    const optimistic: TableSelectOption = {
      id: createSelectOptionId(),
      name: clean,
      color: pickNextSelectOptionColor(col.options ?? []),
    };
    col.options = [...(col.options ?? []), optimistic];
    this.notifyChange();

    if (WorkspaceClient.isAvailable()) {
      void WorkspaceClient.createOrGetOption(colId, clean).then((saved) => {
        if (this.disposed) return;
        const targetCol = this.columns.find((c) => c.id === colId);
        if (targetCol) {
          targetCol.options = (targetCol.options ?? []).map((o) => (o.id === optimistic.id ? saved : o));
          this.notifyChange();
        }
      });
    }
    return optimistic;
  }

  public createColumnGroup(name: string, columnIds: string[]): TableColumnGroup | null {
    const trimmed = name.trim();
    if (!trimmed || columnIds.length === 0) return null;
    const active = this.getActiveStoredView();
    const grp: TableColumnGroup = { id: createColumnGroupId(), name: trimmed, columnIds: [...columnIds] };
    const claimed = new Set(columnIds);
    const cleaned = (active.columnGroups ?? [])
      .map((g) => ({ ...g, columnIds: g.columnIds.filter((id) => !claimed.has(id)) }))
      .filter((g) => g.columnIds.length > 0);
    active.columnGroups = [...cleaned, grp];
    this.persistView(active.id);
    this.notifyChange();
    return grp;
  }

  public renameColumnGroup(groupId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const active = this.getActiveStoredView();
    active.columnGroups = (active.columnGroups ?? []).map((g) => (g.id === groupId ? { ...g, name: trimmed } : g));
    this.persistView(active.id);
    this.notifyChange();
  }

  public setColumnInGroup(colId: string, groupId: string | null): void {
    const active = this.getActiveStoredView();
    const groups = (active.columnGroups ?? [])
      .map((g) => ({
        ...g,
        columnIds: g.columnIds.filter((id) => id !== colId),
      }))
      .map((g) => (g.id === groupId ? { ...g, columnIds: [...g.columnIds, colId] } : g))
      .filter((g) => g.columnIds.length > 0);
    active.columnGroups = groups;
    this.persistView(active.id);
    this.notifyChange();
  }

  public dissolveColumnGroup(groupId: string): void {
    const active = this.getActiveStoredView();
    active.columnGroups = (active.columnGroups ?? []).filter((g) => g.id !== groupId);
    this.persistView(active.id);
    this.notifyChange();
  }

  // ── 排序与筛选 ──
  public setSort(sort: TableSortConfig | null): void {
    const active = this.getActiveStoredView();
    active.sort = sort;
    this.persistView(active.id);
    this.notifyChange();
  }

  public toggleColumnSort(colId: string, explicitDirection?: TableSortDirection): void {
    const cur = this.getSort();
    if (explicitDirection) {
      this.setSort({ columnId: colId, direction: explicitDirection });
      return;
    }
    if (!cur || cur.columnId !== colId) {
      this.setSort({ columnId: colId, direction: "asc" });
    } else if (cur.direction === "asc") {
      this.setSort({ columnId: colId, direction: "desc" });
    } else {
      this.setSort(null);
    }
  }

  public setColumnFilter(
    colId: string,
    filter: (Omit<TableColumnFilter, "columnId"> & { columnId?: string }) | null,
  ): void {
    const active = this.getActiveStoredView();
    const next = (active.filters ?? []).filter((f) => f.columnId !== colId);
    if (filter && (filter.values.length > 0 || filter.includeEmpty)) {
      next.push({
        columnId: colId,
        values: [...filter.values],
        includeEmpty: filter.includeEmpty,
      });
    }
    active.filters = next;
    this.persistView(active.id);
    this.notifyChange();
  }

  public setFilterConjunction(conj: TableFilterConjunction): void {
    const active = this.getActiveStoredView();
    const cur = this.getFilterGroup();
    active.filterGroup = { ...cur, conjunction: conj };
    this.persistView(active.id);
    this.notifyChange();
  }

  public addFilterCondition(colId?: string): TableFilterCondition | null {
    const active = this.getActiveStoredView();
    const targetCol = colId ?? "name";
    const colMeta = this.columns.find((c) => c.id === targetCol);
    const kind = getColumnFilterKind(targetCol, colMeta);
    const cond: TableFilterCondition = {
      id: createFilterConditionId(),
      columnId: targetCol,
      operator: getDefaultFilterOperator(kind),
    };
    const cur = this.getFilterGroup();
    active.filterGroup = { ...cur, conditions: [...cur.conditions, cond] };
    this.persistView(active.id);
    this.notifyChange();
    return cond;
  }

  public updateFilterCondition(id: string, patch: Partial<TableFilterCondition>): void {
    const active = this.getActiveStoredView();
    const cur = this.getFilterGroup();
    active.filterGroup = {
      ...cur,
      conditions: cur.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    };
    this.persistView(active.id);
    this.notifyChange();
  }

  public removeFilterCondition(id: string): void {
    const active = this.getActiveStoredView();
    const cur = this.getFilterGroup();
    active.filterGroup = {
      ...cur,
      conditions: cur.conditions.filter((c) => c.id !== id),
    };
    this.persistView(active.id);
    this.notifyChange();
  }

  public toggleFilterConditionCollapsed(id: string): void {
    const active = this.getActiveStoredView();
    const cur = this.getFilterGroup();
    active.filterGroup = {
      ...cur,
      conditions: cur.conditions.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c)),
    };
    this.persistView(active.id);
    this.notifyChange();
  }

  public reorderFilterConditions(dragId: string, targetId: string, position: "before" | "after"): void {
    const active = this.getActiveStoredView();
    const cur = this.getFilterGroup();
    const list = [...cur.conditions];
    const fromIdx = list.findIndex((c) => c.id === dragId);
    if (fromIdx === -1) return;
    const [moved] = list.splice(fromIdx, 1);
    const toIdx = list.findIndex((c) => c.id === targetId);
    if (toIdx === -1) return;
    list.splice(position === "before" ? toIdx : toIdx + 1, 0, moved);
    active.filterGroup = { ...cur, conditions: list };
    this.persistView(active.id);
    this.notifyChange();
  }

  public clearAllFilters(): void {
    const active = this.getActiveStoredView();
    active.filters = [];
    active.filterGroup = { conjunction: "and", conditions: [] };
    this.persistView(active.id);
    this.notifyChange();
  }

  // ── 间隔重复 ──
  public ensureSpacedRepetitionColumns(): void {
    if (!WorkspaceClient.isAvailable()) return;
    const hasAll = this.columns.some((c) => c.protectedRole === "dueStatus");
    if (hasAll) return;
    void WorkspaceClient.ensureSrColumns().then((cols) => {
      if (this.disposed) return;
      this.columnsMeta = cols;
      this.columns = cols.map(hydrateWorkspaceColumn);
      this.notifyChange();
    });
  }

  public addSpacedRepetitionCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    side: "front" | "back";
  }): TableColumnSchema | null {
    const created = this.addCustomColumn({ name: input.name, type: input.type });
    if (!created) return null;
    const active = this.getActiveStoredView();
    const sr = active.spacedRepetition ?? {};
    if (input.side === "front") {
      this.updateActiveViewConfig({
        spacedRepetition: {
          frontFieldIds: [...(sr.frontFieldIds ?? []), created.id],
          frontFieldRows: [...(sr.frontFieldRows ?? []), [created.id]],
        },
      });
    } else {
      this.updateActiveViewConfig({
        spacedRepetition: {
          backFieldIds: [...(sr.backFieldIds ?? []), created.id],
          backFieldRows: [...(sr.backFieldRows ?? []), [created.id]],
        },
      });
    }
    return created;
  }

  public reorderSpacedRepetitionFields(
    side: "front" | "back",
    draggedColId: string,
    targetColId: string,
    position: SpacedRepetitionFieldDropPosition,
    currentRowsOrIds?: readonly string[][] | readonly string[],
  ): boolean {
    if (draggedColId === targetColId) return false;
    const active = this.getActiveStoredView();
    const sr = active.spacedRepetition ?? {};
    const base: string[][] = (
      (side === "front" ? sr.frontFieldRows : sr.backFieldRows) ??
      (currentRowsOrIds ? currentRowsOrIds.map((item) => (Array.isArray(item) ? [...item] : [item])) : [])
    )
      .map((r) => r.filter((id) => id !== draggedColId))
      .filter((r) => r.length > 0);

    let tRow = -1;
    let tCol = -1;
    for (let r = 0; r < base.length; r++) {
      const c = base[r].indexOf(targetColId);
      if (c !== -1) {
        tRow = r;
        tCol = c;
        break;
      }
    }
    if (tRow === -1) return false;
    if (position === "left") base[tRow].splice(tCol, 0, draggedColId);
    else if (position === "right") base[tRow].splice(tCol + 1, 0, draggedColId);
    else if (position === "top" || position === "before") base.splice(tRow, 0, [draggedColId]);
    else base.splice(tRow + 1, 0, [draggedColId]);

    const flat = base.flat();
    this.updateActiveViewConfig({
      spacedRepetition:
        side === "front" ? { frontFieldRows: base, frontFieldIds: flat } : { backFieldRows: base, backFieldIds: flat },
    });
    return true;
  }

  private resolveTargetDocId(rowUuid: string, explicitDocId?: string | null): string | null {
    return explicitDocId || this.rowDocIdMap.get(rowUuid) || null;
  }

  private mapCellValueForWrite(colId: string, value: TableCellValue): unknown | null {
    if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      return null;
    }
    const col = this.columns.find((c) => c.id === colId);
    if (col?.type === "select" && typeof value === "string") {
      // 优先传 optionName 以确保乐观新建选项零竞态同步到目标 .prg
      const opt = (col.options ?? []).find((o) => o.id === value);
      return opt ? opt.name : value;
    }
    if (col?.type === "multi_select" && Array.isArray(value)) {
      const byId = new Map((col.options ?? []).map((o) => [o.id, o.name]));
      return value.map((v) => byId.get(v) ?? v);
    }
    return value;
  }

  public async answerSpacedRepetitionRow(
    rowUuid: string,
    choice: SpacedRepetitionAnswerChoice,
    options?: { docId?: string | null; baseline?: SpacedRepetitionAnswerSnapshot; today?: Date },
  ): Promise<SpacedRepetitionAnswerSnapshot | null> {
    const docId = this.resolveTargetDocId(rowUuid, options?.docId);
    if (!docId || !WorkspaceClient.isAvailable()) return null;
    const baselineDto: SpacedRepetitionSnapshotDto | null = options?.baseline
      ? {
          mastery: typeof options.baseline.mastery === "number" ? options.baseline.mastery : null,
          correctCount: typeof options.baseline.correctCount === "number" ? options.baseline.correctCount : null,
          delay: typeof options.baseline.delay === "number" ? options.baseline.delay : null,
          answerDate: typeof options.baseline.answerDate === "string" ? options.baseline.answerDate : null,
        }
      : null;
    const res = await WorkspaceClient.answerSpacedRepetition(
      docId,
      rowUuid,
      choice,
      toLocalDateKey(options?.today ?? new Date()),
      baselineDto,
    );
    this.notifyChange();
    return {
      mastery: res.snapshot.mastery ?? undefined,
      correctCount: res.snapshot.correctCount ?? undefined,
      delay: res.snapshot.delay ?? undefined,
      answerDate: res.snapshot.answerDate ?? undefined,
    };
  }

  public async restoreSpacedRepetitionRow(
    rowUuid: string,
    snapshot: SpacedRepetitionAnswerSnapshot,
    options?: { docId?: string | null },
  ): Promise<boolean> {
    const docId = this.resolveTargetDocId(rowUuid, options?.docId);
    if (!docId || !WorkspaceClient.isAvailable()) return false;
    await WorkspaceClient.restoreSpacedRepetition(
      docId,
      rowUuid,
      {
        mastery: typeof snapshot.mastery === "number" ? snapshot.mastery : null,
        correctCount: typeof snapshot.correctCount === "number" ? snapshot.correctCount : null,
        delay: typeof snapshot.delay === "number" ? snapshot.delay : null,
        answerDate: typeof snapshot.answerDate === "string" ? snapshot.answerDate : null,
      },
      toLocalDateKey(new Date()),
    );
    this.notifyChange();
    return true;
  }

  // ── 行级读写路由 ──
  public async updateRowPrimaryText(rowUuid: string, text: string, docId?: string | null): Promise<boolean> {
    const targetDoc = this.resolveTargetDocId(rowUuid, docId);
    if (!targetDoc || !WorkspaceClient.isAvailable()) return false;
    await WorkspaceClient.updateRowText(targetDoc, rowUuid, text);
    const cached = this.getCachedRow(rowUuid, targetDoc);
    if (cached) {
      const updated: StageTableRow = { ...cached, primaryText: text, updatedAt: Date.now() };
      this.rememberRowDocs([updated]);
    }
    this.notifyChange();
    return true;
  }

  public async updateRowCustomField(
    rowUuid: string,
    columnId: string,
    value: TableCellValue,
    docId?: string | null,
  ): Promise<boolean> {
    return await this.updateRowCustomFields(rowUuid, { [columnId]: value }, docId);
  }

  public async updateRowCustomFields(
    rowUuid: string,
    patch: Record<string, TableCellValue>,
    docId?: string | null,
  ): Promise<boolean> {
    const targetDoc = this.resolveTargetDocId(rowUuid, docId);
    if (!targetDoc || !WorkspaceClient.isAvailable()) return false;
    const updates: WorkspaceCellWriteInput[] = Object.entries(patch).map(([colId, val]) => ({
      canonicalKey: colId,
      value: this.mapCellValueForWrite(colId, val),
    }));
    if (updates.length === 0) return false;
    await WorkspaceClient.updateRowCells(targetDoc, rowUuid, updates, true, toLocalDateKey(new Date()));
    const cached = this.getCachedRow(rowUuid, targetDoc);
    if (cached) {
      const nextFields: Record<string, TableCellValue> = { ...(cached.tableFields ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
          delete nextFields[k];
        } else {
          nextFields[k] = v;
        }
      }
      this.rememberRowDocs([{ ...cached, tableFields: nextFields, updatedAt: Date.now() }]);
    }
    this.notifyChange();
    return true;
  }

  public async setRowOuter(rowUuid: string, outerUuid: string | null, docId?: string | null): Promise<boolean> {
    const targetDoc = this.resolveTargetDocId(rowUuid, docId);
    if (!targetDoc || !WorkspaceClient.isAvailable()) return false;
    await WorkspaceClient.setRowRelations(targetDoc, rowUuid, "outer", outerUuid ? [outerUuid] : []);
    this.notifyChange();
    return true;
  }

  public async addRowImages(rowUuid: string, blobs: Blob[], docId?: string | null): Promise<boolean> {
    const targetDoc = this.resolveTargetDocId(rowUuid, docId);
    if (!targetDoc || blobs.length === 0 || !WorkspaceClient.isAvailable()) return false;
    for (const blob of blobs) {
      const attId = crypto.randomUUID();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await WorkspaceClient.addRowImage(targetDoc, rowUuid, attId, blob.type || "image/png", bytes);
    }
    this.notifyChange();
    return true;
  }

  public async removeRowImage(rowUuid: string, imageNodeUuid: string, docId?: string | null): Promise<boolean> {
    const targetDoc = this.resolveTargetDocId(rowUuid, docId);
    if (!targetDoc || !WorkspaceClient.isAvailable()) return false;
    await WorkspaceClient.removeRowImage(targetDoc, rowUuid, imageNodeUuid);
    this.notifyChange();
    return true;
  }

  public async createRow(options?: {
    docId?: string | null;
    text?: string;
    tableFields?: TableFields;
    outerSectionUuid?: string | null;
  }): Promise<{ uuid: string; docId?: string } | null> {
    const targetDoc = options?.docId ?? this.getDefaultCreateDocId();
    if (!targetDoc || !WorkspaceClient.isAvailable()) return null;
    const initialCells: WorkspaceCellWriteInput[] = [];
    if (options?.tableFields) {
      for (const [colId, val] of Object.entries(options.tableFields)) {
        const mapped = this.mapCellValueForWrite(colId, val);
        if (mapped !== null) {
          initialCells.push({ canonicalKey: colId, value: mapped });
        }
      }
    }
    const created = await WorkspaceClient.createRow(targetDoc, options?.text ?? "", initialCells);
    this.rowDocIdMap.set(created.uuid, created.docId);
    this.notifyChange();
    return { uuid: created.uuid, docId: created.docId };
  }

  // ── 下沉 SQLite 查询（直连 index.sqlite）──
  private rememberRowDocs(rows: readonly StageTableRow[]): void {
    for (const r of rows) {
      this.rowCacheByKey.set(r.uuid, r);
      if (r.docId) {
        this.rowDocIdMap.set(r.uuid, r.docId);
        this.rowCacheByKey.set(`${r.docId}:${r.uuid}`, r);
      }
    }
  }

  public queryPageSync(): TablePageResponse {
    return {
      totalCount: this.lastLoadedRows.length,
      unfilteredTotalCount: this.lastLoadedRows.length,
      offset: 0,
      limit: Math.max(this.lastLoadedRows.length, 1),
      rows: this.lastLoadedRows,
    };
  }

  public async queryPage(request: TablePageRequest): Promise<TablePageResponse> {
    if (!WorkspaceClient.isAvailable()) {
      return this.queryPageSync();
    }
    const res = await WorkspaceClient.queryTablePage({
      scope: this.getScope(),
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
    const hydrated = res.rows.map((r) => hydrateV3TableRow(null, r));
    this.rememberRowDocs(hydrated);
    if ((request.offset ?? 0) === 0) {
      this.lastLoadedRows = hydrated;
    }
    return {
      totalCount: res.totalCount,
      unfilteredTotalCount: res.unfilteredTotalCount,
      offset: res.offset,
      limit: res.limit,
      rows: hydrated,
    };
  }

  public async queryFilterBuckets(request: TableFilterBucketsRequest): Promise<TableFilterBucketsResponse> {
    if (!WorkspaceClient.isAvailable()) {
      return { buckets: [], emptyCount: 0, totalBuckets: 0 };
    }
    const res = await WorkspaceClient.queryTableFilterBuckets({
      scope: this.getScope(),
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

  public async queryRelationCandidates(
    request: TableRelationCandidatesRequest,
  ): Promise<TableRelationCandidatesResponse> {
    const docId = this.resolveTargetDocId(request.rowUuid, request.docId);
    if (!docId || !WorkspaceClient.isAvailable()) {
      return { candidates: [], totalCount: 0, hasMore: false };
    }
    const res = await WorkspaceClient.queryRelationCandidates({
      docId,
      rowUuid: request.rowUuid,
      relationKind: request.relationKind,
      search: request.search,
      limit: request.limit ?? 50,
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

  public async queryGroupCounts(request: TableGroupCountsRequest): Promise<TableGroupCountsResponse> {
    if (!WorkspaceClient.isAvailable()) {
      return { totalCount: 0, ungroupedCount: 0, groups: [] };
    }
    const res = await WorkspaceClient.queryTableGroupCounts({
      scope: this.getScope(),
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

  public async queryDateRange(request: TableDateRangeRequest): Promise<TableDateRangeResponse> {
    if (!WorkspaceClient.isAvailable()) {
      return { rows: [], undatedCount: 0, undatedRows: [], totalFilteredCount: 0 };
    }
    const res = await WorkspaceClient.queryTableDateRange({
      scope: this.getScope(),
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
    const rows = res.rows.map((r) => hydrateV3TableRow(null, r));
    const undatedRows = res.undatedRows.map((r) => hydrateV3TableRow(null, r));
    this.rememberRowDocs(rows);
    this.rememberRowDocs(undatedRows);
    return {
      rows,
      undatedCount: res.undatedCount,
      undatedRows,
      totalFilteredCount: res.totalFilteredCount,
    };
  }

  public async executeMutation(mutation: TableDataSourceMutation): Promise<boolean> {
    const docId = this.resolveTargetDocId("rowUuid" in mutation ? mutation.rowUuid : "", mutation.docId);
    switch (mutation.type) {
      case "update_primary_text":
        return await this.updateRowPrimaryText(mutation.rowUuid, mutation.text, docId);
      case "update_custom_field":
        return await this.updateRowCustomField(mutation.rowUuid, mutation.columnId, mutation.value, docId);
      case "update_custom_fields":
        return await this.updateRowCustomFields(mutation.rowUuid, mutation.patch, docId);
      case "set_parents": {
        if (!docId || !WorkspaceClient.isAvailable()) return false;
        await WorkspaceClient.setRowRelations(docId, mutation.rowUuid, "parents", mutation.parentUuids);
        this.notifyChange();
        return true;
      }
      case "set_children": {
        if (!docId || !WorkspaceClient.isAvailable()) return false;
        await WorkspaceClient.setRowRelations(docId, mutation.rowUuid, "children", mutation.childUuids);
        this.notifyChange();
        return true;
      }
      case "set_outer":
        return await this.setRowOuter(mutation.rowUuid, mutation.outerUuid, docId);
      case "set_inner": {
        if (!docId || !WorkspaceClient.isAvailable()) return false;
        await WorkspaceClient.setRowRelations(docId, mutation.rowUuid, "inner", mutation.innerUuids);
        this.notifyChange();
        return true;
      }
      case "add_images":
        return await this.addRowImages(mutation.rowUuid, mutation.blobs, docId);
      case "remove_image":
        return await this.removeRowImage(mutation.rowUuid, mutation.imageNodeUuid, docId);
      case "create_row":
        return Boolean(
          await this.createRow({
            docId: mutation.docId,
            text: mutation.text,
            tableFields: mutation.tableFields,
            outerSectionUuid: mutation.outerSectionUuid,
          }),
        );
      case "answer_spaced_repetition":
        return Boolean(
          await this.answerSpacedRepetitionRow(mutation.rowUuid, mutation.choice, {
            docId,
            baseline: mutation.baseline,
            today: mutation.today,
          }),
        );
      case "restore_spaced_repetition":
        return await this.restoreSpacedRepetitionRow(mutation.rowUuid, mutation.snapshot, { docId });
    }
  }

  /**
   * 跨文件行跳转：自动打开/聚焦目标 `.prg` Tab 并平滑移动摄像机选中该节点。
   */
  public jumpToNode(docId: string | null, uuid: string, panelWidthPx?: number): void {
    const resolvedDocId = this.resolveTargetDocId(uuid, docId);
    if (!resolvedDocId) return;
    const doc = this.docsById.get(resolvedDocId);
    if (!doc) return;
    void jumpToWorkspaceNodeByPath(doc.absPath, uuid, panelWidthPx);
  }

  public selectRows(uuids: string[]): void {
    this.selectedRowIds = [...uuids];
    for (const fn of [...this.selectionListeners]) {
      fn(this.selectedRowIds);
    }
  }

  public getSelectedRowUUIDs(): string[] {
    return this.selectedRowIds;
  }

  public subscribeChanges(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeSelection(listener: (uuids: string[]) => void): () => void {
    this.selectionListeners.add(listener);
    return () => {
      this.selectionListeners.delete(listener);
    };
  }
}

/**
 * 通用跨文件节点跳转辅助函数（供跨文件表格与全局 FTS5 搜索复用）：
 * 自动打开或聚焦目标 `.prg` 标签页，待舞台就绪后平滑移动摄像机并选中节点。
 */
export async function jumpToWorkspaceNodeByPath(
  absPath: string,
  nodeUuid: string,
  panelWidthPx?: number,
): Promise<boolean> {
  const [{ Project }, { WorkspacePaths }, { openWorkspacePage }, { store, tabsAtom }] = await Promise.all([
    import("@/core/Project"),
    import("@/core/service/workspace/WorkspaceManager"),
    import("@/core/service/workspace/WorkspacePageOps"),
    import("@/state"),
  ]);
  const normalized = WorkspacePaths.normalize(absPath);
  await openWorkspacePage(normalized);
  const project = store
    .get(tabsAtom)
    .find(
      (tab): tab is InstanceType<typeof Project> =>
        tab instanceof Project &&
        !tab.closing &&
        tab.uri.scheme === "file" &&
        WorkspacePaths.normalize(tab.uri.fsPath) === normalized,
    );
  if (!project) return false;
  requestAnimationFrame(() => {
    project.stageTable?.focusRowOnCanvas?.(nodeUuid, panelWidthPx);
  });
  return true;
}

export function createWorkspaceTableSource(options?: WorkspaceTableSourceOptions): WorkspaceTableSource {
  return new WorkspaceTableSource(options);
}
