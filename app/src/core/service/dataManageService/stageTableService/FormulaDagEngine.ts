import type { DocChangeSet, FormulaCacheEntry } from "@/core/sqlite/DocClient";
import { computeColumnCanonicalKey } from "@/core/sqlite/V3CellCodec";
import {
  toLocalDateKey,
  type FormulaEvaluatedCell,
  type SystemColumnId,
  type TableColumnSchema,
  type TableFilterSortRow,
} from "@/types/table";
import { analyzeFormulaAst, evaluateFormulaSubset, parseFormulaCached } from "./formulaEngine";

export interface FormulaColumnDagNode {
  colId: string;
  canonicalKey: string;
  formula: string;
  format?: string;
  directDeps: ReadonlySet<string>;
  dependsOnRelations: boolean;
  usesRelationTraversal: boolean;
  usesTableRef: boolean;
  isVolatile: boolean;
}

export interface FormulaIncrementalInput {
  rows: readonly TableFilterSortRow[];
  rowByUuid: ReadonlyMap<string, TableFilterSortRow>;
  columns: readonly TableColumnSchema[];
  systemColumnNames?: Partial<Record<SystemColumnId, string>>;
  dirtyRowUuids?: Iterable<string>;
  deletedRowUuids?: Iterable<string>;
  changedColumnIds?: Iterable<string>;
  topologyChanged?: boolean;
  schemaChanged?: boolean;
  now?: Date;
}

export interface FormulaIncrementalResult {
  evaluatedCellCount: number;
  changedEntries: FormulaCacheEntry[];
  fullRebuild: boolean;
}

const RELATION_COLS: readonly string[] = ["parents", "children", "outer", "inner"];

function encodeFormulaCellJson(cell: FormulaEvaluatedCell): string | null {
  const payload: Record<string, unknown> = {};
  if (cell.dateHasTime !== undefined) payload.dateHasTime = cell.dateHasTime;
  if (cell.booleanValue !== undefined) payload.booleanValue = cell.booleanValue;
  if (cell.listItems !== undefined) payload.listItems = cell.listItems;
  if (cell.errorCode !== undefined) payload.errorCode = cell.errorCode;
  if (cell.errorMessage !== undefined) payload.errorMessage = cell.errorMessage;
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;
}

function formulaCellsEqual(a: FormulaEvaluatedCell | undefined, b: FormulaEvaluatedCell): boolean {
  if (!a) return false;
  if (
    a.kind !== b.kind ||
    a.displayText !== b.displayText ||
    a.numericValue !== b.numericValue ||
    a.dateMs !== b.dateMs ||
    a.dateHasTime !== b.dateHasTime ||
    a.booleanValue !== b.booleanValue ||
    a.errorCode !== b.errorCode ||
    a.errorMessage !== b.errorMessage
  ) {
    return false;
  }
  const al = a.listItems;
  const bl = b.listItems;
  if (al === bl) return true;
  if (!al || !bl || al.length !== bl.length) return false;
  for (let i = 0; i < al.length; i++) {
    if (al[i] !== bl[i]) return false;
  }
  return true;
}

export function encodeFormulaCellToCacheEntry(
  entityUuid: string,
  col: TableColumnSchema,
  cell: FormulaEvaluatedCell,
  isVolatile: boolean,
  computedDay: string,
): FormulaCacheEntry {
  return {
    entityUuid,
    colId: col.id,
    canonicalKey: computeColumnCanonicalKey(col),
    kind: cell.kind,
    displayText: cell.displayText,
    valNum: cell.kind === "number" && cell.numericValue !== undefined ? cell.numericValue : null,
    valDateMs: cell.kind === "date" && cell.dateMs !== undefined ? Math.trunc(cell.dateMs) : null,
    valJson: encodeFormulaCellJson(cell),
    isVolatile,
    computedDay,
  };
}

function buildColumnsSignature(
  columns: readonly TableColumnSchema[],
  systemColumnNames?: Partial<Record<SystemColumnId, string>>,
): string {
  const colPart = columns
    .map((c) => {
      const optSig =
        c.type === "select" || c.type === "multi_select"
          ? (c.options ?? []).map((o) => `${o.id}:${o.name}`).join(",")
          : "";
      return `${c.id}|${c.name}|${c.type}|${c.formula ?? ""}|${c.format ?? ""}|${optSig}`;
    })
    .join(";");
  const sysPart = systemColumnNames
    ? Object.entries(systemColumnNames)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v ?? ""}`)
        .join(",")
    : "";
  return `${colPart}#${sysPart}`;
}

/**
 * 增量公式 DAG 引擎：
 * - 复用 `formulaEngine.ts` 的 AST 缓存与求值器，零语法退化；
 * - 分析列级依赖闭包、1-hop 关系穿透、全表 `__table__` 引用与 `TODAY()/NOW()` 易变性；
 * - 变更时仅重算受影响的 `(rowUuid, formulaColId)` 子集并输出最小 `FormulaCacheEntry[]` 批量回写 SQLite；
 * - 跨午夜单次定时器 + 切回前台日期比对，彻底取代 60 秒全表轮询。
 */
export class FormulaDagEngine {
  private schemaSignature = "";
  private initialized = false;
  private computedDay = "";
  private nodes = new Map<string, FormulaColumnDagNode>();
  /** depColId -> 传递闭包下游所有公式列 ID */
  private downstreamByDep = new Map<string, Set<string>>();
  private volatileColIds = new Set<string>();
  private tableRefColIds = new Set<string>();
  private relationTraversalColIds = new Set<string>();
  private cacheByRow = new Map<string, Record<string, FormulaEvaluatedCell>>();

  public isInitialized(): boolean {
    return this.initialized;
  }

  public hasFormulaColumns(): boolean {
    return this.nodes.size > 0;
  }

  public hasVolatileColumns(): boolean {
    return this.volatileColIds.size > 0;
  }

  public getComputedDay(): string {
    return this.computedDay;
  }

  public getDagNode(colId: string): FormulaColumnDagNode | undefined {
    return this.nodes.get(colId);
  }

  public getDownstreamFormulaColumns(changedColIds: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const cid of changedColIds) {
      if (this.nodes.has(cid)) {
        out.add(cid);
      }
      const down = this.downstreamByDep.get(cid);
      if (down) {
        for (const fId of down) out.add(fId);
      }
    }
    return out;
  }

  public getRowFormulaValues(rowUuid: string): Record<string, FormulaEvaluatedCell> {
    return this.cacheByRow.get(rowUuid) ?? {};
  }

  public reset(): void {
    this.initialized = false;
    this.schemaSignature = "";
    this.computedDay = "";
    this.nodes.clear();
    this.downstreamByDep.clear();
    this.volatileColIds.clear();
    this.tableRefColIds.clear();
    this.relationTraversalColIds.clear();
    this.cacheByRow.clear();
  }

  /**
   * 依据当前列定义重建公式依赖 DAG（列配置与公式源码未变动时直接跳过）。
   */
  public syncSchema(
    columns: readonly TableColumnSchema[],
    systemColumnNames?: Partial<Record<SystemColumnId, string>>,
  ): boolean {
    const nextSig = buildColumnsSignature(columns, systemColumnNames);
    if (nextSig === this.schemaSignature && this.initialized) {
      return false;
    }

    this.schemaSignature = nextSig;
    this.nodes.clear();
    this.downstreamByDep.clear();
    this.volatileColIds.clear();
    this.tableRefColIds.clear();
    this.relationTraversalColIds.clear();

    const directReverse = new Map<string, Set<string>>();

    for (const col of columns) {
      if (col.type !== "formula") continue;
      const parsed = parseFormulaCached(col.formula ?? "");
      const analysis = analyzeFormulaAst(parsed.ast, { columns, systemColumnNames });
      const node: FormulaColumnDagNode = {
        colId: col.id,
        canonicalKey: computeColumnCanonicalKey(col),
        formula: col.formula ?? "",
        format: col.format,
        directDeps: new Set(analysis.dependencies),
        dependsOnRelations: analysis.dependsOnRelations,
        usesRelationTraversal: analysis.usesRelationTraversal,
        usesTableRef: analysis.usesTableRef,
        isVolatile: analysis.volatile,
      };
      this.nodes.set(col.id, node);
      if (node.isVolatile) this.volatileColIds.add(col.id);
      if (node.usesTableRef) this.tableRefColIds.add(col.id);
      if (node.usesRelationTraversal) this.relationTraversalColIds.add(col.id);

      for (const dep of analysis.dependencies) {
        let rev = directReverse.get(dep);
        if (!rev) {
          rev = new Set();
          directReverse.set(dep, rev);
        }
        rev.add(col.id);
      }
    }

    // 传递闭包：任意列变动时 O(1) 取得所有直接与间接下游公式列
    const computeClosure = (startColId: string): Set<string> => {
      const visited = new Set<string>();
      const stack = Array.from(directReverse.get(startColId) ?? []);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        const nexts = directReverse.get(cur);
        if (nexts) {
          for (const n of nexts) {
            if (!visited.has(n)) stack.push(n);
          }
        }
      }
      return visited;
    };

    for (const depColId of directReverse.keys()) {
      this.downstreamByDep.set(depColId, computeClosure(depColId));
    }
    // 易变公式的下游列也视为易变（如依赖 TODAY() 列的二次公式）
    for (const vCol of Array.from(this.volatileColIds)) {
      const down = this.downstreamByDep.get(vCol);
      if (down) {
        for (const fId of down) this.volatileColIds.add(fId);
      }
    }
    // 引用 __table__ 的下游列同样需要全表传播
    for (const tCol of Array.from(this.tableRefColIds)) {
      const down = this.downstreamByDep.get(tCol);
      if (down) {
        for (const fId of down) this.tableRefColIds.add(fId);
      }
    }
    // 依赖跨行关系遍历的下游列同样标记
    for (const rCol of Array.from(this.relationTraversalColIds)) {
      const down = this.downstreamByDep.get(rCol);
      if (down) {
        for (const fId of down) this.relationTraversalColIds.add(fId);
      }
    }

    return true;
  }

  /**
   * 首次全量求值或 Schema 变更后的全量重建。
   */
  public evaluateFull(
    rows: readonly TableFilterSortRow[],
    rowByUuid: ReadonlyMap<string, TableFilterSortRow>,
    columns: readonly TableColumnSchema[],
    systemColumnNames?: Partial<Record<SystemColumnId, string>>,
    now: Date = new Date(),
  ): FormulaIncrementalResult {
    this.syncSchema(columns, systemColumnNames);
    const todayKey = toLocalDateKey(now);
    this.computedDay = todayKey;
    this.cacheByRow.clear();

    if (this.nodes.size === 0) {
      this.initialized = true;
      return { evaluatedCellCount: 0, changedEntries: [], fullRebuild: true };
    }

    const colById = new Map<string, TableColumnSchema>(columns.map((c) => [c.id, c]));
    const allFormulaColIds = Array.from(this.nodes.keys());
    const allRowUuids = rows.map((r) => r.uuid);
    const evaluated = evaluateFormulaSubset(allRowUuids, allFormulaColIds, rows, columns, {
      now,
      systemColumnNames,
      rowByUuid,
    });

    const changedEntries: FormulaCacheEntry[] = [];
    for (const [rowUuid, rec] of evaluated) {
      this.cacheByRow.set(rowUuid, rec);
      for (const colId of allFormulaColIds) {
        const col = colById.get(colId);
        const cell = rec[colId];
        if (!col || !cell) continue;
        changedEntries.push(
          encodeFormulaCellToCacheEntry(rowUuid, col, cell, this.volatileColIds.has(colId), todayKey),
        );
      }
    }

    this.initialized = true;
    return {
      evaluatedCellCount: allRowUuids.length * allFormulaColIds.length,
      changedEntries,
      fullRebuild: true,
    };
  }

  /**
   * 增量公式重算：仅重算受影响的 `(rowUuid × affectedFormulaColIds)`，返回真正发生值变化的缓存条目。
   */
  public evaluateIncremental(input: FormulaIncrementalInput): FormulaIncrementalResult {
    const now = input.now ?? new Date();
    const todayKey = toLocalDateKey(now);
    const schemaMutated = this.syncSchema(input.columns, input.systemColumnNames);

    if (!this.initialized || input.schemaChanged || schemaMutated) {
      return this.evaluateFull(input.rows, input.rowByUuid, input.columns, input.systemColumnNames, now);
    }

    if (this.nodes.size === 0) {
      this.computedDay = todayKey;
      return { evaluatedCellCount: 0, changedEntries: [], fullRebuild: false };
    }

    // 清理已删除行
    if (input.deletedRowUuids) {
      for (const delId of input.deletedRowUuids) {
        this.cacheByRow.delete(delId);
      }
    }

    const colById = new Map<string, TableColumnSchema>(input.columns.map((c) => [c.id, c]));
    const allFormulaColIds = Array.from(this.nodes.keys());

    // 1. 先检查未入缓存的新增行（需要计算全部公式列）
    const newRowUuids = new Set<string>();
    for (const r of input.rows) {
      if (!this.cacheByRow.has(r.uuid)) {
        newRowUuids.add(r.uuid);
      }
    }

    // 2. 计算本次受影响的公式列集合
    const affectedColIds = new Set<string>();
    if (input.changedColumnIds) {
      for (const cid of this.getDownstreamFormulaColumns(input.changedColumnIds)) {
        affectedColIds.add(cid);
      }
    }
    if (input.topologyChanged) {
      for (const cid of this.getDownstreamFormulaColumns(RELATION_COLS)) {
        affectedColIds.add(cid);
      }
      for (const rCol of this.relationTraversalColIds) {
        affectedColIds.add(rCol);
      }
    }

    // 若跨午夜，易变公式列需要全表刷新
    const dayRolledOver = this.computedDay !== todayKey && this.volatileColIds.size > 0;
    this.computedDay = todayKey;

    const changedEntries: FormulaCacheEntry[] = [];
    let evaluatedCellCount = 0;

    const mergeEvaluated = (
      evalMap: Map<string, Record<string, FormulaEvaluatedCell>>,
      colsToMerge: Iterable<string>,
    ) => {
      const colList = Array.from(colsToMerge);
      for (const [rowUuid, nextRec] of evalMap) {
        const prevRec = this.cacheByRow.get(rowUuid);
        const merged: Record<string, FormulaEvaluatedCell> = prevRec ? { ...prevRec } : {};
        let rowChanged = !prevRec;
        for (const colId of colList) {
          const nextCell = nextRec[colId];
          if (!nextCell) continue;
          const prevCell = prevRec?.[colId];
          if (!formulaCellsEqual(prevCell, nextCell)) {
            merged[colId] = nextCell;
            rowChanged = true;
            const col = colById.get(colId);
            if (col) {
              changedEntries.push(
                encodeFormulaCellToCacheEntry(rowUuid, col, nextCell, this.volatileColIds.has(colId), todayKey),
              );
            }
          }
        }
        if (rowChanged) {
          this.cacheByRow.set(rowUuid, merged);
        }
      }
    };

    // A. 对新增行计算全部公式列
    if (newRowUuids.size > 0) {
      const evalNew = evaluateFormulaSubset(newRowUuids, allFormulaColIds, input.rows, input.columns, {
        now,
        systemColumnNames: input.systemColumnNames,
        rowByUuid: input.rowByUuid,
      });
      evaluatedCellCount += newRowUuids.size * allFormulaColIds.length;
      mergeEvaluated(evalNew, allFormulaColIds);
    }

    // B. 全表级需要重算的列（跨午夜易变列 + 引用 __table__ 且存在任何变动）
    const globalRecalcCols = new Set<string>();
    if (dayRolledOver) {
      for (const vCol of this.volatileColIds) globalRecalcCols.add(vCol);
    }
    const hasAnyDataMutation =
      newRowUuids.size > 0 ||
      Boolean(input.topologyChanged) ||
      Boolean(input.deletedRowUuids && Array.from(input.deletedRowUuids).length > 0) ||
      Boolean(input.dirtyRowUuids && Array.from(input.dirtyRowUuids).length > 0);
    if (hasAnyDataMutation && this.tableRefColIds.size > 0) {
      for (const tCol of this.tableRefColIds) globalRecalcCols.add(tCol);
    }
    if (globalRecalcCols.size > 0) {
      const allRowIds = input.rows.map((r) => r.uuid);
      const evalGlobal = evaluateFormulaSubset(allRowIds, globalRecalcCols, input.rows, input.columns, {
        now,
        systemColumnNames: input.systemColumnNames,
        rowByUuid: input.rowByUuid,
      });
      evaluatedCellCount += allRowIds.length * globalRecalcCols.size;
      mergeEvaluated(evalGlobal, globalRecalcCols);
    }

    // C. 行级精准增量重算（排除已全表重算的列和已全列计算的新增行）
    const localCols = new Set<string>();
    for (const cid of affectedColIds) {
      if (!globalRecalcCols.has(cid)) localCols.add(cid);
    }
    if (localCols.size > 0 && input.dirtyRowUuids) {
      const dirtyRows = new Set<string>();
      for (const id of input.dirtyRowUuids) {
        if (input.rowByUuid.has(id) && !newRowUuids.has(id)) {
          dirtyRows.add(id);
        }
      }
      // 若受影响的公式列包含跨行关系属性穿透，则波及直接 1-hop 邻接行
      let needNeighborExpand = false;
      for (const cid of localCols) {
        if (this.relationTraversalColIds.has(cid)) {
          needNeighborExpand = true;
          break;
        }
      }
      if (needNeighborExpand && dirtyRows.size > 0) {
        for (const id of Array.from(dirtyRows)) {
          const row = input.rowByUuid.get(id);
          if (!row) continue;
          for (const p of row.parents) dirtyRows.add(p.uuid);
          for (const c of row.children) dirtyRows.add(c.uuid);
          if (row.outer) dirtyRows.add(row.outer.uuid);
          for (const i of row.inner) dirtyRows.add(i.uuid);
        }
      }
      if (dirtyRows.size > 0) {
        const evalLocal = evaluateFormulaSubset(dirtyRows, localCols, input.rows, input.columns, {
          now,
          systemColumnNames: input.systemColumnNames,
          rowByUuid: input.rowByUuid,
        });
        evaluatedCellCount += dirtyRows.size * localCols.size;
        mergeEvaluated(evalLocal, localCols);
      }
    }

    return {
      evaluatedCellCount,
      changedEntries,
      fullRebuild: false,
    };
  }

  /**
   * 仅在跨越午夜（`computedDay !== todayKey`）且存在易变公式列时触发增量刷新。
   */
  public refreshVolatileIfDayChanged(
    rows: readonly TableFilterSortRow[],
    rowByUuid: ReadonlyMap<string, TableFilterSortRow>,
    columns: readonly TableColumnSchema[],
    systemColumnNames?: Partial<Record<SystemColumnId, string>>,
    now: Date = new Date(),
  ): FormulaIncrementalResult | null {
    const todayKey = toLocalDateKey(now);
    if (!this.initialized || !this.hasVolatileColumns() || this.computedDay === todayKey) {
      return null;
    }
    return this.evaluateIncremental({
      rows,
      rowByUuid,
      columns,
      systemColumnNames,
      now,
    });
  }
}

/**
 * 从 Rust `DocChangeSet` 提取增量公式 DAG 所需的受影响行与列集合。
 */
export function extractFormulaDeltaFromChangeSet(changeset: DocChangeSet): {
  dirtyRowUuids: Set<string>;
  deletedRowUuids: Set<string>;
  changedColumnIds: Set<string>;
  topologyChanged: boolean;
  schemaChanged: boolean;
} {
  const dirtyRowUuids = new Set<string>();
  const deletedRowUuids = new Set<string>(changeset.deletedEntityUuids);
  const changedColumnIds = new Set<string>();
  let topologyChanged =
    changeset.dirtyEdges.length > 0 || changeset.deletedEdgeUuids.length > 0 || changeset.deletedEntityUuids.length > 0;

  for (const ent of changeset.dirtyEntities) {
    if (ent.isRow) {
      dirtyRowUuids.add(ent.uuid);
      changedColumnIds.add("name");
      changedColumnIds.add("createdAt");
      changedColumnIds.add("updatedAt");
      changedColumnIds.add("outer");
      changedColumnIds.add("inner");
      changedColumnIds.add("images");
      if (ent.parentSectionUuid) {
        dirtyRowUuids.add(ent.parentSectionUuid);
      }
    } else if (ent.kind === "image" && ent.parentSectionUuid) {
      dirtyRowUuids.add(ent.parentSectionUuid);
      changedColumnIds.add("images");
    }
  }

  for (const edge of changeset.dirtyEdges) {
    dirtyRowUuids.add(edge.sourceUuid);
    dirtyRowUuids.add(edge.targetUuid);
    changedColumnIds.add("parents");
    changedColumnIds.add("children");
  }

  for (const cell of changeset.dirtyCells) {
    dirtyRowUuids.add(cell.entityUuid);
    changedColumnIds.add(cell.colId);
  }

  for (const delCell of changeset.deletedCells) {
    dirtyRowUuids.add(delCell.entityUuid);
    changedColumnIds.add(delCell.colId);
  }

  if (changeset.deletedEdgeUuids.length > 0) {
    topologyChanged = true;
    changedColumnIds.add("parents");
    changedColumnIds.add("children");
  }

  return {
    dirtyRowUuids,
    deletedRowUuids,
    changedColumnIds,
    topologyChanged,
    schemaChanged: changeset.schemaChanged,
  };
}

/**
 * 注册跨午夜单次定时器 + 切回前台日期检查，彻底消除 60 秒全表轮询 `setInterval`。
 */
export function registerMidnightVolatileWatcher(onDayRolloverCheck: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  let timerId: number | null = null;
  const scheduleNextMidnight = () => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
    }
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0);
    const delayMs = Math.max(1000, nextMidnight.getTime() - now.getTime());
    timerId = window.setTimeout(() => {
      onDayRolloverCheck();
      scheduleNextMidnight();
    }, delayMs);
  };

  const handleForeground = () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      onDayRolloverCheck();
    }
  };

  scheduleNextMidnight();
  window.addEventListener("focus", handleForeground);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleForeground);
  }

  return () => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
    window.removeEventListener("focus", handleForeground);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleForeground);
    }
  };
}
