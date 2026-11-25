// @vitest-environment jsdom

import { createTabGroup } from "@/core/TabGroup";
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
      }));
      this.stageTable = {
        subscribe: (fn: () => void) => {
          this.listeners.add(fn);
          return () => this.listeners.delete(fn);
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
        updateColumn: (colId: string, patch: { name?: string; type?: any }) => {
          this.table.columns = this.table.columns.map((c) =>
            c.id === colId
              ? { ...c, ...(patch.name ? { name: patch.name } : {}), ...(patch.type ? { type: patch.type } : {}) }
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
});
