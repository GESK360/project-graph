import { useSyncExternalStore } from "react";

export type TableSelectionMode = "none" | "all" | "rows" | "columns" | "cells";

export interface TableSelectionState {
  mode: TableSelectionMode;
  rowIds: Set<string>;
  colIds: Set<string>;
  cells: Set<string>;
  anchorRowId: string | null;
  anchorColId: string | null;
  activeCell: { rowId: string; colId: string } | null;
}

export const EMPTY_TABLE_SELECTION: TableSelectionState = {
  mode: "none",
  rowIds: new Set<string>(),
  colIds: new Set<string>(),
  cells: new Set<string>(),
  anchorRowId: null,
  anchorColId: null,
  activeCell: null,
};

export function makeTableCellKey(rowId: string, colId: string): string {
  return `${rowId}\0${colId}`;
}

export function extractRowIdsFromCellKeys(cells: Iterable<string>): string[] {
  const ids = new Set<string>();
  for (const key of cells) {
    const sep = key.indexOf("\0");
    if (sep > 0) ids.add(key.slice(0, sep));
  }
  return Array.from(ids);
}

/**
 * 原子化多维表格选中态 Store：
 * 配合 `useSyncExternalStore`，让画布点选/框选与表格单格/多行选中仅重渲染状态实际发生翻转的行或列，
 * 避免顶层 `StageTablePanel` 整表重渲染与无谓查询。
 */
export class StageTableSelectionStore {
  private state: TableSelectionState = EMPTY_TABLE_SELECTION;
  private readonly listeners = new Set<() => void>();

  public getState(): TableSelectionState {
    return this.state;
  }

  public setState(next: TableSelectionState | ((prev: TableSelectionState) => TableSelectionState)): void {
    const resolved = typeof next === "function" ? next(this.state) : next;
    if (resolved === this.state) return;
    this.state = resolved;
    for (const listener of this.listeners) {
      listener();
    }
  }

  public clear(): void {
    if (this.state.mode === "none") return;
    this.setState(EMPTY_TABLE_SELECTION);
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export function useTableSelectionMode(store: StageTableSelectionStore): TableSelectionMode {
  return useSyncExternalStore(store.subscribe, () => store.getState().mode);
}

export function useIsRowSelected(store: StageTableSelectionStore, rowId: string): boolean {
  return useSyncExternalStore(store.subscribe, () => {
    const s = store.getState();
    return s.mode === "all" || (s.mode === "rows" && s.rowIds.has(rowId));
  });
}

export function useIsColumnSelected(store: StageTableSelectionStore, colId: string): boolean {
  return useSyncExternalStore(store.subscribe, () => {
    const s = store.getState();
    return s.mode === "all" || (s.mode === "columns" && s.colIds.has(colId));
  });
}

/**
 * 返回单个行内单元格相关的选中位掩码（`bit0`: 行/列/格被选中，`bit1`: 当前激活单元格），
 * 仅当该单元格自身状态变化时才触发单元格重新渲染。
 */
export function useCellSelectionMask(store: StageTableSelectionStore, rowId: string, colId: string): number {
  return useSyncExternalStore(store.subscribe, () => {
    const s = store.getState();
    let mask = 0;
    const isRowSel = s.mode === "all" || (s.mode === "rows" && s.rowIds.has(rowId));
    const isColSel = s.mode === "all" || (s.mode === "columns" && s.colIds.has(colId));
    const isCellSel = s.mode === "cells" && s.cells.has(makeTableCellKey(rowId, colId));
    if (isRowSel || isColSel || isCellSel) {
      mask |= 1;
    }
    if (s.mode === "cells" && s.activeCell?.rowId === rowId && s.activeCell?.colId === colId) {
      mask |= 2;
    }
    return mask;
  });
}

/**
 * 为工具栏选中计数徽章订阅简洁快照字符串（避免整面板订阅 `selection`）。
 */
export function useTableSelectionBadgeInfo(store: StageTableSelectionStore): {
  mode: TableSelectionMode;
  count: number;
} {
  const packed = useSyncExternalStore(store.subscribe, () => {
    const s = store.getState();
    if (s.mode === "none") return "none:0";
    if (s.mode === "all") return `all:${s.rowIds.size}`;
    if (s.mode === "rows") return `rows:${s.rowIds.size}`;
    if (s.mode === "columns") return `columns:${s.colIds.size}`;
    return `cells:${s.cells.size}`;
  });
  const sep = packed.indexOf(":");
  return {
    mode: packed.slice(0, sep) as TableSelectionMode,
    count: Number(packed.slice(sep + 1)),
  };
}

/**
 * 供看板 / 画册 / 甘特 / 日历 / 间隔重复视图读取当前已选行集合（稳定快照，单卡片仍可用 `useIsRowSelected` 精准订阅）。
 */
export function useSelectedRowIdsSnapshot(store: StageTableSelectionStore): ReadonlySet<string> {
  return useSyncExternalStore(store.subscribe, () => {
    const s = store.getState();
    if (s.mode === "rows" || s.mode === "all") return s.rowIds;
    return EMPTY_ROW_SET;
  });
}

const EMPTY_ROW_SET: ReadonlySet<string> = new Set<string>();
