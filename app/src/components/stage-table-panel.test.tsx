// @vitest-environment jsdom

import { createTabGroup } from "@/core/TabGroup";
import { evaluateTableFormulas } from "@/core/service/dataManageService/stageTableService/formulaEngine";
import { activeTabAtom, stageTableOpenAtom, store, tabGroupRootAtom, tabsAtom } from "@/state";
import { createDefaultTableData } from "@/types/table";
import { Provider } from "jotai";
import React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MockProjectClass = vi.hoisted(() => {
  return class MockProject {
    id: string;
    layout = "docked" as const;
    projectState = 0;
    table = createDefaultTableData();
    rows: any[];
    private listeners = new Set<() => void>();
    private selectionListeners = new Set<(uuids: string[]) => void>();
    selectedCanvasRowIds: string[] = [];
    stageManager = {
      getEntities: () => [],
      getAssociations: () => [],
      getSelectedStageObjects: () => [],
    };
    renderer = {
      getCoverWorldRectangle: () => ({ isCollideWith: () => true }),
    };
    camera = {
      currentScale: 1,
      reset: vi.fn(),
    };
    sectionMethods = {
      isEntityInSection: () => false,
    };
    stageTable: any;

    constructor(id: string, rowTexts: string[]) {
      this.id = id;
      this.rows = rowTexts.map((text, idx) => ({
        uuid: `${id}-row-${idx}`,
        entity: {},
        kind: "text",
        primaryText: text,
        editableText: true,
        images: [],
        canEditImages: true,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        parents: [],
        children: [],
        outer: null,
        inner: [],
        canEditInner: true,
        tableFields: {},
        formulaValues: {},
      }));
      this.stageTable = {
        subscribe: (fn: () => void) => {
          this.listeners.add(fn);
          return () => this.listeners.delete(fn);
        },
        subscribeSelection: (fn: (uuids: string[]) => void) => {
          this.selectionListeners.add(fn);
          return () => this.selectionListeners.delete(fn);
        },
        getSelectedRowUUIDs: () => [...this.selectedCanvasRowIds],
        selectRowsOnCanvas: vi.fn((uuids: string[]) => {
          this.selectedCanvasRowIds = [...uuids];
        }),
        getSort: () => this.table.views[0].sort ?? null,
        setSort: (sort: any) => {
          this.table.views[0].sort = sort ?? undefined;
          this.listeners.forEach((fn) => fn());
        },
        toggleColumnSort: (colId: string, preferred?: "asc" | "desc") => {
          const cur = this.table.views[0].sort;
          const next = preferred
            ? cur && cur.columnId === colId && cur.direction === preferred
              ? null
              : { columnId: colId, direction: preferred }
            : !cur || cur.columnId !== colId
              ? { columnId: colId, direction: "asc" as const }
              : cur.direction === "asc"
                ? { columnId: colId, direction: "desc" as const }
                : null;
          this.table.views[0].sort = next ?? undefined;
          this.listeners.forEach((fn) => fn());
          return next;
        },
        getFilters: () => this.table.views[0].filters ?? [],
        getColumnFilter: (colId: string) =>
          (this.table.views[0].filters ?? []).find((f: any) => f.columnId === colId) ?? null,
        setColumnFilter: (colId: string, flt: any) => {
          const rest = (this.table.views[0].filters ?? []).filter((f: any) => f.columnId !== colId);
          this.table.views[0].filters = flt
            ? [...rest, { columnId: colId, ...flt }]
            : rest.length > 0
              ? rest
              : undefined;
          this.listeners.forEach((fn) => fn());
        },
        clearAllFilters: () => {
          this.table.views[0].filters = undefined;
          this.listeners.forEach((fn) => fn());
        },
        getActiveView: () => this.table.views[0],
        getColumns: () => this.table.columns,
        getVisibleColumnIds: () => ["name", ...this.table.views[0].visibleColumnIds.filter((x) => x !== "name")],
        isColumnVisible: (colId: string) => colId === "name" || this.table.views[0].visibleColumnIds.includes(colId),
        setColumnVisible: (colId: string, visible: boolean) => {
          const cur = this.table.views[0].visibleColumnIds;
          this.table.views[0].visibleColumnIds = visible
            ? ["name", ...cur.filter((x) => x !== "name" && x !== colId), colId]
            : ["name", ...cur.filter((x) => x !== "name" && x !== colId)];
          this.listeners.forEach((fn) => fn());
        },
        setColumnWidth: (colId: string, width: number) => {
          this.table.views[0].columnWidths = { ...(this.table.views[0].columnWidths ?? {}), [colId]: width };
          this.listeners.forEach((fn) => fn());
        },
        reorderColumn: (draggedId: string, targetId: string, position: "before" | "after") => {
          if (draggedId === "name" || draggedId === targetId) return false;
          const rest = this.table.views[0].visibleColumnIds.filter((x) => x !== draggedId);
          const idx = rest.indexOf(targetId);
          const insertAt = targetId === "name" ? 1 : position === "before" ? Math.max(1, idx) : idx + 1;
          rest.splice(insertAt, 0, draggedId);
          this.table.views[0].visibleColumnIds = rest;
          this.listeners.forEach((fn) => fn());
          return true;
        },
        addCustomColumn: ({ name, type }: { name: string; type: any }) => {
          const col = { id: `col_${this.table.columns.length + 1}`, name, type, options: [] };
          this.table.columns = [...this.table.columns, col];
          this.table.views[0].visibleColumnIds = [...this.table.views[0].visibleColumnIds, col.id];
          this.listeners.forEach((fn) => fn());
          return col;
        },
        insertCustomColumn: ({
          name,
          type,
          targetColumnId,
          side,
        }: {
          name: string;
          type: any;
          targetColumnId?: string;
          side?: "left" | "right";
        }) => {
          const col = { id: `col_${this.table.columns.length + 1}`, name, type, options: [] };
          this.table.columns = [...this.table.columns, col];
          const cur = [...this.table.views[0].visibleColumnIds];
          if (targetColumnId && cur.includes(targetColumnId)) {
            const idx = cur.indexOf(targetColumnId);
            const at = targetColumnId === "name" ? 1 : side === "left" ? Math.max(1, idx) : idx + 1;
            cur.splice(at, 0, col.id);
          } else {
            cur.push(col.id);
          }
          this.table.views[0].visibleColumnIds = cur;
          this.listeners.forEach((fn) => fn());
          return col;
        },
        duplicateCustomColumn: vi.fn(),
        autoFitColumnWidth: vi.fn(),
        getFrozenColumnId: () => this.table.views[0].frozenColumnId ?? null,
        toggleFreezeUpToColumn: (colId: string) => {
          this.table.views[0].frozenColumnId = this.table.views[0].frozenColumnId === colId ? undefined : colId;
          this.listeners.forEach((fn) => fn());
          return this.table.views[0].frozenColumnId ?? null;
        },
        getColumnGroups: () => this.table.views[0].columnGroups ?? [],
        deleteCustomColumn: vi.fn(),
        updateColumn: (
          colId: string,
          patch: { name?: string; type?: any; formula?: string; format?: string | null },
        ) => {
          this.table.columns = this.table.columns.map((c) =>
            c.id === colId
              ? {
                  ...c,
                  ...(patch.name ? { name: patch.name } : {}),
                  ...(patch.type ? { type: patch.type } : {}),
                  ...(patch.formula !== undefined ? { formula: patch.formula } : {}),
                  ...(patch.format !== undefined ? { format: patch.format ?? undefined } : {}),
                }
              : c,
          );
          this.listeners.forEach((fn) => fn());
          return true;
        },
        createOrGetSelectOption: (colId: string, optName: string) => {
          const col = this.table.columns.find((c) => c.id === colId);
          if (!col) return null;
          const opt = { id: `opt_${(col.options?.length ?? 0) + 1}`, name: optName, color: "purple" };
          col.options = [...(col.options ?? []), opt];
          this.listeners.forEach((fn) => fn());
          return opt;
        },
        getRows: () => this.rows,
        updateRowPrimaryText: vi.fn(),
        updateRowCustomField: (uuid: string, colId: string, val: any) => {
          const r = this.rows.find((item) => item.uuid === uuid);
          if (r) {
            r.tableFields = { ...r.tableFields, [colId]: val };
            this.listeners.forEach((fn) => fn());
          }
          return true;
        },
        addRowImages: vi.fn(),
        removeRowImage: vi.fn(),
        setRowParents: vi.fn(),
        setRowChildren: vi.fn(),
        setRowOuter: vi.fn(),
        setRowInner: vi.fn(),
        focusRowOnCanvas: vi.fn(),
      };
    }

    emitCanvasSelection(uuids: string[]) {
      this.selectedCanvasRowIds = [...uuids];
      this.selectionListeners.forEach((fn) => fn(uuids));
    }

    getService(name: string) {
      return name === "stageTable" ? this.stageTable : undefined;
    }

    on() {}
    off() {}

    getComponent() {
      const id = this.id;
      return function MockCanvasView() {
        return <div data-mock-canvas={id}>Canvas {id}</div>;
      };
    }
  };
});

vi.mock("@/core/Project", () => ({
  Project: MockProjectClass,
  ProjectState: { Saved: 0, Stashed: 1, Unsaved: 2 },
}));
vi.mock("@/core/Tab", () => ({
  Tab: class {},
  isResourceTab: (tab: unknown) => tab instanceof MockProjectClass,
}));
vi.mock("@/core/TabWorkspace", () => ({
  TabWorkspace: { focus: vi.fn(), resizeSplit: vi.fn() },
}));
vi.mock("@/utils/platform", () => ({ isMac: false }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/ProjectTabs", () => ({
  ProjectTabs: () => <div data-pg-tab-bar />,
}));

import DockedArea from "./docked-area";

describe("Docked StageTablePanel split & sliders", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
    store.set(stageTableOpenAtom, false);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders as a sibling split page without covering canvas children and stays open across file-tree page switches", async () => {
    const projectA = new MockProjectClass("proj-a", ["Alpha Node"]);
    const projectB = new MockProjectClass("proj-b", ["Beta Node"]);

    store.set(tabsAtom, [projectA as never, projectB as never]);
    store.set(tabGroupRootAtom, {
      id: "main",
      type: "group",
      tabIds: ["proj-a", "proj-b"],
      activeTabId: "proj-a",
    });
    store.set(activeTabAtom, projectA as never);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    expect(container.querySelector("[data-stage-table-docked-pane]")).toBeNull();
    const toggleBtn = container.querySelector<HTMLButtonElement>("[data-stage-table-toggle]")!;
    expect(toggleBtn).not.toBeNull();

    // Expand multidimensional table panel
    await React.act(async () => {
      toggleBtn.click();
    });

    const dockedPane = container.querySelector<HTMLElement>("[data-stage-table-docked-pane]");
    const canvasEl = container.querySelector<HTMLElement>('[data-mock-canvas="proj-a"]');
    expect(dockedPane).not.toBeNull();
    expect(canvasEl).not.toBeNull();
    // Docked pane is a separate sibling branch, NOT inside the Project canvas subtree
    expect(canvasEl!.contains(dockedPane)).toBe(false);
    expect(dockedPane!.textContent).toContain("Alpha Node");

    // Simulate switching .prg page in Workspace file tree (active tab -> projectB)
    await React.act(async () => {
      store.set(tabGroupRootAtom, {
        id: "main",
        type: "group",
        tabIds: ["proj-a", "proj-b"],
        activeTabId: "proj-b",
      });
      store.set(activeTabAtom, projectB as never);
    });

    // Panel stays open and switches rows to Project B
    const dockedPaneAfterSwitch = container.querySelector<HTMLElement>("[data-stage-table-docked-pane]");
    expect(dockedPaneAfterSwitch).not.toBeNull();
    expect(store.get(stageTableOpenAtom)).toBe(true);
    expect(dockedPaneAfterSwitch!.textContent).toContain("Beta Node");
  });

  it("supports dragging and wheel-scrolling both right vertical and bottom horizontal sliders", async () => {
    const projectA = new MockProjectClass("proj-scroll", ["Row 1", "Row 2", "Row 3"]);
    projectA.table.views[0].visibleColumnIds = [
      "name",
      "createdAt",
      "updatedAt",
      "parents",
      "children",
      "outer",
      "inner",
    ];

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-scroll"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    const viewport = container.querySelector<HTMLElement>("[data-stage-table-viewport]")!;
    const vBar = container.querySelector<HTMLElement>("[data-stage-table-v-scrollbar]")!;
    const hBar = container.querySelector<HTMLElement>("[data-stage-table-h-scrollbar]")!;
    const vThumb = container.querySelector<HTMLElement>("[data-stage-table-v-thumb]")!;
    const hThumb = container.querySelector<HTMLElement>("[data-stage-table-h-thumb]")!;

    expect(vBar).not.toBeNull();
    expect(hBar).not.toBeNull();

    // Mock overflow dimensions on viewport & tracks
    Object.defineProperty(viewport, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(viewport, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(viewport, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(viewport, "scrollWidth", { value: 1200, configurable: true });
    Object.defineProperty(vBar, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(hBar, "clientWidth", { value: 300, configurable: true });

    await React.act(async () => {
      viewport.dispatchEvent(new Event("scroll"));
    });

    // 1. Mouse wheel on bottom slider scrolls horizontally
    await React.act(async () => {
      hBar.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }));
    });
    expect(viewport.scrollLeft).toBe(120);

    // 2. Mouse wheel on right slider scrolls vertically
    await React.act(async () => {
      vBar.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 90 }));
    });
    expect(viewport.scrollTop).toBe(90);

    // 3. Pointer drag on right & bottom thumbs updates scrollTop / scrollLeft
    vThumb.setPointerCapture = vi.fn();
    hThumb.setPointerCapture = vi.fn();

    await React.act(async () => {
      vThumb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientY: 50 }));
      vThumb.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 1, clientY: 100 }));
      vThumb.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientY: 100 }));
    });
    expect(viewport.scrollTop).toBeGreaterThan(90);

    await React.act(async () => {
      hThumb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2, clientX: 40 }));
      hThumb.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 2, clientX: 120 }));
      hThumb.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 2, clientX: 120 }));
    });
    expect(viewport.scrollLeft).toBeGreaterThan(120);
  });

  it("renders 1-based row numbers, independent fixed column widths, + custom column creation, header drag reorder, and right-click edit field menu", async () => {
    const projectA = new MockProjectClass("proj-ops", ["第一行", "第二行", "第三行"]);
    projectA.table.views[0].visibleColumnIds = ["name", "images", "createdAt"];

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-ops"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    // 1. Row counter from 1..N
    const indexCells = Array.from(container.querySelectorAll<HTMLElement>("[data-stage-table-row-index]"));
    expect(indexCells.map((el) => el.textContent)).toEqual(["1", "2", "3"]);

    // 2. Independent fixed pixel column widths (resizing "name" only changes "name" col width, not "images" or "createdAt")
    const grid = container.querySelector<HTMLTableElement>("[data-stage-table-grid]")!;
    expect(grid.style.tableLayout).toBe("fixed");
    const colsBefore = Array.from(grid.querySelectorAll("colgroup col")).map((c) => (c as HTMLElement).style.width);
    expect(colsBefore).toEqual(["44px", "220px", "170px", "164px", "40px"]);

    const nameResizer = container.querySelector<HTMLElement>('[data-col-resizer="name"]')!;
    await React.act(async () => {
      nameResizer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 200 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 260 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 260 }));
    });
    const colsAfter = Array.from(grid.querySelectorAll("colgroup col")).map((c) => (c as HTMLElement).style.width);
    expect(colsAfter).toEqual(["44px", "280px", "170px", "164px", "40px"]);

    // 3. Rightmost + button inserts column & opens 图 4 inline title input + 2-col field type grid
    const addColBtn = container.querySelector<HTMLButtonElement>("[data-stage-table-add-col]")!;
    await React.act(async () => {
      addColBtn.click();
    });
    expect(projectA.table.columns).toHaveLength(1);
    const inlineTitleInput = container.querySelector<HTMLInputElement>("[data-creating-col-title-input]")!;
    expect(inlineTitleInput).not.toBeNull();

    const selectTypeOptionBtn = document.body.querySelector<HTMLButtonElement>('[data-field-type-option="select"]')!;
    expect(selectTypeOptionBtn).not.toBeNull();
    await React.act(async () => {
      selectTypeOptionBtn.click();
    });
    expect(projectA.table.columns[0].type).toBe("select");

    // 4. Right-clicking a custom column header shows 图 1/3/5 context menu (修改字段, 插入字段, 字段编组 + bottom 5-icon bar)
    const customColId = projectA.table.columns[0].id;
    const customHeaderTrigger = container.querySelector<HTMLElement>(
      `[data-table-col-id="${customColId}"] > div > div`,
    )!;
    await React.act(async () => {
      customHeaderTrigger.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 360, clientY: 80 }),
      );
    });
    expect(document.body.textContent).toContain("headerMenu.editField");
    expect(document.body.textContent).toContain("headerMenu.insertField");
    const bottomBar = document.body.querySelector<HTMLElement>("[data-header-menu-bottom-actions]");
    expect(bottomBar).not.toBeNull();
    expect(bottomBar!.querySelectorAll('[role="menuitem"]')).toHaveLength(5);

    // 5. Frozen columns + 图 6 multi-column super-header groups render merged colSpan & sticky left offsets
    await React.act(async () => {
      projectA.table.views[0].columnGroups = [
        { id: "grp_1", name: "基础信息", columnIds: ["name", "images"] },
        { id: "grp_2", name: "后台数据", columnIds: ["createdAt", customColId] },
      ];
      projectA.stageTable.toggleFreezeUpToColumn("images");
    });

    const groupRow = container.querySelector<HTMLTableRowElement>("[data-stage-table-group-row]")!;
    expect(groupRow).not.toBeNull();
    expect(groupRow.textContent).toContain("基础信息");
    expect(groupRow.textContent).toContain("后台数据");
    const groupThs = Array.from(groupRow.querySelectorAll("th"));
    // [#] + [基础信息 colSpan=2] + [后台数据 colSpan=2] + [+]
    expect(groupThs[1].colSpan).toBe(2);
    expect(groupThs[2].colSpan).toBe(2);

    const nameTh = container.querySelector<HTMLElement>('[data-table-col-id="name"]')!;
    const imagesTh = container.querySelector<HTMLElement>('[data-table-col-id="images"]')!;
    expect(nameTh.style.left).toBe("44px");
    expect(imagesTh.style.left).toBe("324px"); // 44 + 280 (resized name width)
  });

  it("supports cell/row/column/multi selection, bidirectional canvas sync, and Explorer-style column sort & filter UI", async () => {
    const projectA = new MockProjectClass("proj-sel", ["节点 10", "节点 2", "节点 1"]);
    projectA.table.views[0].visibleColumnIds = ["name", "createdAt", "updatedAt"];
    projectA.rows[0].createdAt = 1700000003000;
    projectA.rows[1].createdAt = 1700000001000;
    projectA.rows[2].createdAt = 1700000002000;

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-sel"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    // 1. Cell selection: single cell, Shift-range cells, Ctrl multi-cell
    const cell00 = container.querySelector<HTMLElement>('[data-row-id="proj-sel-row-0"][data-col-id="name"]')!;
    const cell11 = container.querySelector<HTMLElement>('[data-row-id="proj-sel-row-1"][data-col-id="createdAt"]')!;
    const cell22 = container.querySelector<HTMLElement>('[data-row-id="proj-sel-row-2"][data-col-id="updatedAt"]')!;

    await React.act(async () => {
      cell00.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    });
    expect(cell00.dataset.cellSelected).toBe("true");
    expect(cell00.dataset.cellActive).toBe("true");
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(1);
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith(["proj-sel-row-0"]);

    await React.act(async () => {
      cell11.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true }));
    });
    // 2x2 rectangle -> 4 cells selected across rows 0 and 1
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(4);
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith(["proj-sel-row-0", "proj-sel-row-1"]);

    await React.act(async () => {
      cell22.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: true }));
    });
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(5);
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith([
      "proj-sel-row-0",
      "proj-sel-row-1",
      "proj-sel-row-2",
    ]);

    // 2. Column selection: single column + Ctrl multi-column
    const nameTh = container.querySelector<HTMLElement>('[data-table-col-id="name"]')!;
    const updatedTh = container.querySelector<HTMLElement>('[data-table-col-id="updatedAt"]')!;
    await React.act(async () => {
      nameTh.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    });
    expect(nameTh.dataset.colSelected).toBe("true");
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(3);

    await React.act(async () => {
      updatedTh.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: true }));
    });
    expect(nameTh.dataset.colSelected).toBe("true");
    expect(updatedTh.dataset.colSelected).toBe("true");
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(6);

    // 3. Row selection & Table -> Canvas sync (single + Shift multi-row)
    const rowIdx0 = container.querySelector<HTMLElement>('[data-stage-table-row-index][data-row-id="proj-sel-row-0"]')!;
    const rowIdx2 = container.querySelector<HTMLElement>('[data-stage-table-row-index][data-row-id="proj-sel-row-2"]')!;
    await React.act(async () => {
      rowIdx0.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    });
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith(["proj-sel-row-0"]);

    await React.act(async () => {
      rowIdx2.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true }));
    });
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith([
      "proj-sel-row-0",
      "proj-sel-row-1",
      "proj-sel-row-2",
    ]);

    // 4. Canvas -> Table bidirectional sync (multi-select)
    await React.act(async () => {
      projectA.emitCanvasSelection(["proj-sel-row-1", "proj-sel-row-2"]);
    });
    const selectedTrs = Array.from(container.querySelectorAll<HTMLElement>('tr[data-row-selected="true"]'));
    expect(selectedTrs.map((tr) => tr.dataset.stageTableRowId)).toEqual(["proj-sel-row-1", "proj-sel-row-2"]);

    // 5. Explorer-style column sort & filter dropdown + top-center sort chevron arrow
    const nameFilterBtn = container.querySelector<HTMLButtonElement>('[data-col-filter-trigger="name"]')!;
    await React.act(async () => {
      nameFilterBtn.click();
    });
    const sortAscBtn = document.body.querySelector<HTMLButtonElement>("[data-col-sort-asc]")!;
    expect(sortAscBtn).not.toBeNull();
    await React.act(async () => {
      sortAscBtn.click();
    });
    // Top-center arrow appears with direction="asc", rows ordered naturally: 节点 1, 节点 2, 节点 10
    let sortIndicator = container.querySelector<HTMLButtonElement>('[data-col-sort-indicator="name"]')!;
    expect(sortIndicator).not.toBeNull();
    expect(sortIndicator.dataset.sortDirection).toBe("asc");
    const rowOrderAsc = Array.from(container.querySelectorAll<HTMLElement>("tr[data-stage-table-row-id]")).map(
      (tr) => tr.dataset.stageTableRowId,
    );
    expect(rowOrderAsc).toEqual(["proj-sel-row-2", "proj-sel-row-1", "proj-sel-row-0"]);

    // Clicking the top-center arrow toggles direction asc -> desc
    await React.act(async () => {
      sortIndicator.click();
    });
    sortIndicator = container.querySelector<HTMLButtonElement>('[data-col-sort-indicator="name"]')!;
    expect(sortIndicator.dataset.sortDirection).toBe("desc");
    const rowOrderDesc = Array.from(container.querySelectorAll<HTMLElement>("tr[data-stage-table-row-id]")).map(
      (tr) => tr.dataset.stageTableRowId,
    );
    expect(rowOrderDesc).toEqual(["proj-sel-row-0", "proj-sel-row-1", "proj-sel-row-2"]);

    // Unchecking "节点 2" in the filter popover hides that row
    const optionRow2 = document.body.querySelector<HTMLElement>(
      '[data-col-filter-option="节点 2"] button[role="checkbox"]',
    )!;
    await React.act(async () => {
      optionRow2.click();
    });
    expect(nameTh.dataset.colFiltered).toBe("true");
    const filteredRowIds = Array.from(container.querySelectorAll<HTMLElement>("tr[data-stage-table-row-id]")).map(
      (tr) => tr.dataset.stageTableRowId,
    );
    expect(filteredRowIds).toEqual(["proj-sel-row-0", "proj-sel-row-2"]);
  });

  it("allows picking a date from the Calendar popover in a custom date column without losing click events", async () => {
    const projectA = new MockProjectClass("proj-date", ["日程节点"]);
    const dateCol = projectA.stageTable.addCustomColumn({ name: "截止日期", type: "date" });
    projectA.rows[0].tableFields = { [dateCol.id]: "2026-11-25" };

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-date"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    const dateTd = container.querySelector<HTMLElement>(
      `td[data-row-id="proj-date-row-0"][data-col-id="${dateCol.id}"]`,
    )!;
    const dateTrigger = dateTd.querySelector<HTMLElement>('[role="button"]')!;

    await React.act(async () => {
      dateTrigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      dateTrigger.click();
    });

    const day15Button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button[data-day]")).find(
      (btn) => btn.textContent?.trim() === "15",
    )!;
    expect(day15Button).toBeDefined();

    // Simulate full real pointerdown -> pointerup -> click on Calendar day button; DOM node must stay mounted and commit
    await React.act(async () => {
      day15Button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      expect(day15Button.isConnected).toBe(true);
      day15Button.click();
    });

    expect(projectA.rows[0].tableFields[dateCol.id]).toBe("2026-11-15");
    expect(dateTd.textContent).toContain("2026-11-15");
  });

  it("opens the high-spec formula editor when creating a formula column, inserts column pills, previews, and saves computed cells", async () => {
    const projectA = new MockProjectClass("proj-formula", ["细胞膜图像", "线粒体"]);
    const correctCol = projectA.stageTable.addCustomColumn({ name: "答对次数", type: "number" });
    projectA.rows[0].tableFields = { [correctCol.id]: 3 };
    projectA.rows[1].tableFields = { [correctCol.id]: 1 };

    // Wire formula evaluation into mock getRows
    projectA.stageTable.getRows = () => {
      const evaluated = evaluateTableFormulas(projectA.rows, projectA.table.columns);
      return projectA.rows.map((r: any) => ({
        ...r,
        formulaValues: evaluated.get(r.uuid) ?? {},
      }));
    };

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-formula"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    // Click right-most "+" button to insert a new custom column
    const addColBtn = container.querySelector<HTMLButtonElement>('button[aria-label="addColumnPopover.triggerAria"]')!;
    await React.act(async () => {
      addColBtn.click();
    });

    // Pick "formula" in FieldTypeGridPicker -> auto-opens Formula Editor dialog
    const formulaTypeBtn = document.body.querySelector<HTMLButtonElement>('button[data-field-type-option="formula"]')!;
    expect(formulaTypeBtn).toBeTruthy();
    await React.act(async () => {
      formulaTypeBtn.click();
    });

    const editorDialog = document.body.querySelector<HTMLElement>("[data-stage-table-formula-editor]");
    expect(editorDialog).toBeTruthy();

    // Click POWER function & column item in sidebar to insert snippet and blue pill
    const pillInput = editorDialog!.querySelector<HTMLElement>("[data-formula-pill-input]")!;
    const colSidebarBtn = editorDialog!.querySelector<HTMLButtonElement>(
      `button[data-formula-catalog-item="col:${correctCol.id}"]`,
    )!;
    expect(colSidebarBtn).toBeTruthy();

    await React.act(async () => {
      colSidebarBtn.click();
    });

    // Verify atomic pill rendered inside editor and live preview shows "3"
    const insertedPill = pillInput.querySelector<HTMLElement>(`[data-formula-pill="${correctCol.id}"]`);
    expect(insertedPill).toBeTruthy();
    expect(insertedPill!.textContent).toContain("答对次数");

    // Append " * 2" and dispatch input event so preview updates to "6"
    await React.act(async () => {
      pillInput.appendChild(document.createTextNode(" * 2"));
      pillInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const previewVal = editorDialog!.querySelector<HTMLElement>("[data-formula-preview-value]")!;
    expect(previewVal.textContent?.trim()).toBe("6");

    // Click confirm save button
    const saveBtn = editorDialog!.querySelector<HTMLButtonElement>("[data-formula-editor-save]")!;
    await React.act(async () => {
      saveBtn.click();
    });

    // Formula dialog closes and table cells render 6 and 2
    const formulaCol = projectA.table.columns.find((c: any) => c.type === "formula")!;
    expect(formulaCol).toBeTruthy();
    expect(formulaCol.formula).toBe(`{{${correctCol.id}}} * 2`);

    const cell0 = container.querySelector<HTMLElement>(
      `td[data-row-id="proj-formula-row-0"][data-col-id="${formulaCol.id}"]`,
    )!;
    const cell1 = container.querySelector<HTMLElement>(
      `td[data-row-id="proj-formula-row-1"][data-col-id="${formulaCol.id}"]`,
    )!;
    expect(cell0.textContent?.trim()).toBe("6");
    expect(cell1.textContent?.trim()).toBe("2");
  });
});
