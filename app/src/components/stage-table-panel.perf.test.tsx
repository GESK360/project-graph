// @vitest-environment jsdom

import type { Project } from "@/core/Project";
import type { StageTableRow } from "@/core/service/dataManageService/stageTableService/StageTableService";
import { createDefaultTableData, type TableColumnSchema } from "@/types/table";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({
  Project: class {},
  ProjectState: { Saved: 0, Stashed: 1, Unsaved: 2 },
}));
vi.mock("@/components/image-lightbox", () => ({
  ImageLightbox: () => null,
}));
vi.mock("@/utils/platform", () => ({ isMac: false, isWindows: true, isDesktop: true, isWeb: false, isMobile: false }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import StageTablePanel from "./stage-table-panel";

function build5000RowPerfProject() {
  const ROW_COUNT = 5000;
  const table = createDefaultTableData();
  const columns: TableColumnSchema[] = [
    { id: "col_sr_correctCount", name: "连续答对次数", type: "number" },
    { id: "col_sr_answerDate", name: "作答日期", type: "date" },
    {
      id: "col_sr_nextInterval",
      name: "下次间隔天数",
      type: "formula",
      formula: "IF([col_sr_correctCount] <= 0, 0, POWER(2, [col_sr_correctCount] - 1))",
    },
    {
      id: "col_sr_nextDueDate",
      name: "下次复习日期",
      type: "formula",
      formula: 'DATEADD([col_sr_answerDate], [col_sr_nextInterval], "days")',
    },
    {
      id: "col_sr_dueStatus",
      name: "到期状态",
      type: "formula",
      formula: 'IF([col_sr_nextDueDate] <= TODAY(), "待复习", "未到期")',
    },
  ];
  table.columns = columns;
  table.views[0].visibleColumnIds = [
    "name",
    "parents",
    "children",
    "outer",
    "inner",
    "col_sr_nextInterval",
    "col_sr_nextDueDate",
    "col_sr_dueStatus",
  ];

  const rows: StageTableRow[] = Array.from({ length: ROW_COUNT }, (_, i) => {
    const parentIdx = i > 0 ? i - 1 : null;
    const childIdx = i < ROW_COUNT - 1 ? i + 1 : null;
    return {
      uuid: `perf-row-${i}`,
      entity: {} as StageTableRow["entity"],
      kind: i % 100 === 0 ? "section" : "text",
      primaryText: `知识点节点 ${i}`,
      editableText: true,
      images: [],
      canEditImages: true,
      createdAt: 1700000000000 + i * 1000,
      updatedAt: 1700000000000 + i * 1000,
      parents:
        parentIdx !== null ? [{ uuid: `perf-row-${parentIdx}`, label: `知识点节点 ${parentIdx}`, kind: "text" }] : [],
      children:
        childIdx !== null ? [{ uuid: `perf-row-${childIdx}`, label: `知识点节点 ${childIdx}`, kind: "text" }] : [],
      outer:
        i % 100 !== 0
          ? {
              uuid: `perf-row-${Math.floor(i / 100) * 100}`,
              label: `知识点节点 ${Math.floor(i / 100) * 100}`,
              kind: "section",
            }
          : null,
      inner: [],
      canEditInner: true,
      tableFields: {
        col_sr_correctCount: (i % 4) + 1,
        col_sr_answerDate: "2026-10-20",
      },
      formulaValues: {
        col_sr_nextInterval: { kind: "number", displayText: String(2 ** (i % 4)), numericValue: 2 ** (i % 4) },
        col_sr_nextDueDate: { kind: "date", displayText: "2026-10-24", dateMs: Date.UTC(2026, 9, 24) },
        col_sr_dueStatus: { kind: "string", displayText: i % 2 === 0 ? "待复习" : "未到期" },
      },
    };
  });

  const changeListeners = new Set<() => void>();
  const selectionListeners = new Set<(uuids: string[]) => void>();
  let selectedUUIDs: string[] = [];

  const getRows = vi.fn(() => rows);
  const setColumnWidth = vi.fn((colId: string, width: number) => {
    const view = table.views[0];
    view.columnWidths = { ...(view.columnWidths ?? {}), [colId]: width };
    changeListeners.forEach((fn) => fn());
  });

  const stageTable = {
    subscribe: (fn: () => void) => {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },
    subscribeSelection: (fn: (uuids: string[]) => void) => {
      selectionListeners.add(fn);
      return () => selectionListeners.delete(fn);
    },
    getSelectedRowUUIDs: () => [...selectedUUIDs],
    selectRowsOnCanvas: vi.fn((uuids: string[]) => {
      selectedUUIDs = [...uuids];
    }),
    focusRowOnCanvas: vi.fn(),
    getViews: () => table.views,
    getActiveView: () => table.views[0],
    getColumns: () => table.columns,
    getVisibleColumnIds: () => table.views[0].visibleColumnIds,
    isColumnVisible: (colId: string) => colId === "name" || table.views[0].visibleColumnIds.includes(colId),
    getColumnGroups: () => table.views[0].columnGroups ?? [],
    getFrozenColumnId: () => table.views[0].frozenColumnId ?? null,
    getSort: () => table.views[0].sort ?? null,
    getFilters: () => table.views[0].filters ?? [],
    getFilterGroup: () => table.views[0].filterGroup ?? { conjunction: "and", conditions: [] },
    getSystemColumnCustomName: () => undefined,
    getColumnWidth: (colId: string) => table.views[0].columnWidths?.[colId] ?? (colId === "name" ? 280 : 140),
    setColumnWidth,
    getRows,
    updateRowPrimaryText: vi.fn(),
    updateRowCustomField: vi.fn(),
    updateRowCustomFields: vi.fn(),
    setRowParents: vi.fn(),
    setRowChildren: vi.fn(),
    setRowOuter: vi.fn(),
    setRowInner: vi.fn(),
    addRowImages: vi.fn().mockResolvedValue(undefined),
    removeRowImage: vi.fn(),
    createRow: vi.fn(),
    refreshVolatileFormulasIfDayChanged: vi.fn(() => false),
  };

  const project = {
    isSqliteV3: false,
    v3DocId: null,
    table,
    attachments: new Map<string, Blob>(),
    stageTable,
    getService: (name: string) => (name === "stageTable" ? stageTable : undefined),
  };

  return {
    project: project as unknown as Project,
    getRows,
    setColumnWidth,
    emitCanvasSelection: (uuids: string[]) => {
      selectedUUIDs = [...uuids];
      selectionListeners.forEach((fn) => fn([...uuids]));
    },
  };
}

describe("StageTablePanel 5,000-row performance & virtualization", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("virtualizes 5,000 rows (< 1,500 DOM nodes), avoids 60s setInterval, syncs selection atomically, resizes columns with 0 move rerenders, and mounts singleton relation editor on demand", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const { project, getRows, setColumnWidth, emitCanvasSelection } = build5000RowPerfProject();

    await act(async () => {
      root.render(<StageTablePanel project={project} />);
    });

    // 1. 不再注册 60s setInterval 轮询
    expect(setIntervalSpy).not.toHaveBeenCalled();

    // 2. 5,000 行虚拟化：仅渲染可视窗口及 overscan 行，总 DOM 节点严格 < 1,500
    const renderedRows = container.querySelectorAll("tr[data-stage-table-row-id]");
    expect(renderedRows.length).toBeGreaterThan(5);
    expect(renderedRows.length).toBeLessThan(80);

    const totalDomNodes = container.querySelectorAll("*").length;
    expect(totalDomNodes).toBeLessThan(1500);

    const bottomSpacerTd = container.querySelector<HTMLElement>('tr[data-virtual-spacer="bottom"] td');
    expect(bottomSpacerTd).toBeTruthy();
    expect(Number.parseFloat(bottomSpacerTd!.style.height)).toBeGreaterThan(100_000);

    // 3. 画布选中变化 -> 走原子 SelectionStore，不触发顶层 StageTablePanel 重渲染（getRows 调用 0 次）
    getRows.mockClear();
    await act(async () => {
      emitCanvasSelection(["perf-row-2"]);
    });
    expect(getRows).toHaveBeenCalledTimes(0);

    const row2 = container.querySelector<HTMLElement>('tr[data-stage-table-row-id="perf-row-2"]');
    const row1 = container.querySelector<HTMLElement>('tr[data-stage-table-row-id="perf-row-1"]');
    expect(row2?.dataset.rowSelected).toBe("true");
    expect(row1?.dataset.rowSelected).toBeUndefined();

    // 4. 列宽拖拽：pointermove 期间 0 次 setColumnWidth 重渲染，仅 pointerup 提交 1 次
    setColumnWidth.mockClear();
    const resizer = container.querySelector<HTMLElement>('[data-col-resizer="name"]')!;
    expect(resizer).toBeTruthy();
    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200 }));
      for (let x = 210; x <= 350; x += 10) {
        window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x }));
      }
    });
    expect(setColumnWidth).toHaveBeenCalledTimes(0);

    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 350 }));
    });
    expect(setColumnWidth).toHaveBeenCalledTimes(1);
    expect(setColumnWidth).toHaveBeenCalledWith("name", 370);

    // 5. 关系编辑器单例：未点击前为 0，点击后按需加载候选且上限 <= 50（而非 5,000）
    expect(document.body.querySelector("[data-relation-editor-popover]")).toBeNull();
    const parentsTrigger = container.querySelector<HTMLElement>(
      'td[data-row-id="perf-row-0"][data-col-id="parents"] [role="button"]',
    )!;
    expect(parentsTrigger).toBeTruthy();
    await act(async () => {
      parentsTrigger.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const relPopover = document.body.querySelector<HTMLElement>("[data-relation-editor-popover]");
    expect(relPopover).toBeTruthy();
    const candidateRows = relPopover!.querySelectorAll("label");
    expect(candidateRows.length).toBeGreaterThan(0);
    expect(candidateRows.length).toBeLessThanOrEqual(55);
  });
});
