import { afterEach, describe, expect, it, vi } from "vitest";
import { DocClient } from "@/core/sqlite/DocClient";
import type { Project } from "@/core/Project";
import { createDefaultTableData, type TableColumnSchema } from "@/types/table";
import type { StageTableRow } from "./StageTableService";
import { SingleFileTableSource } from "./TableDataSource";

function makeRow(overrides: Partial<StageTableRow> & { uuid: string }): StageTableRow {
  return {
    entity: {} as StageTableRow["entity"],
    kind: "text",
    primaryText: overrides.uuid,
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
    ...overrides,
  };
}

function createFakeProject(rows: StageTableRow[], columns: TableColumnSchema[], sqliteOpts?: { v3DocId: string }) {
  const table = createDefaultTableData();
  table.columns = columns;
  const flush = vi.fn().mockResolvedValue(undefined);
  const syncFormulaCacheFull = vi.fn();
  let formulaInit = false;

  const project = {
    isSqliteV3: Boolean(sqliteOpts),
    v3DocId: sqliteOpts?.v3DocId ?? null,
    table,
    docCommandBus: { flush },
    stageManager: {
      get: vi.fn(() => undefined),
    },
    getAttachmentMediaUrl: vi.fn(
      (attId: string, opts?: { thumb?: boolean }) => `flux-media://doc/${attId}${opts?.thumb ? "?thumb=1" : ""}`,
    ),
    stageTable: {
      getRows: () => rows,
      getViews: () => table.views,
      getActiveView: () => table.views[0],
      getColumns: () => table.columns,
      getVisibleColumnIds: () => table.views[0].visibleColumnIds,
      getColumnGroups: () => table.views[0].columnGroups ?? [],
      getSort: () => table.views[0].sort ?? null,
      getFilters: () => table.views[0].filters ?? [],
      getFilterGroup: () => table.views[0].filterGroup ?? { conjunction: "and", conditions: [] },
      getSystemColumnCustomName: () => undefined,
      getSelectedRowUUIDs: () => [],
      selectRowsOnCanvas: vi.fn(),
      focusRowOnCanvas: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeSelection: vi.fn(() => () => {}),
      formulaDag: {
        isInitialized: () => formulaInit,
      },
      syncFormulaCacheFull: vi.fn((opts) => {
        formulaInit = true;
        syncFormulaCacheFull(opts);
      }),
      updateRowPrimaryText: vi.fn(),
      updateRowCustomField: vi.fn(),
      updateRowCustomFields: vi.fn(),
      setRowParents: vi.fn(),
      setRowChildren: vi.fn(),
      setRowOuter: vi.fn(),
      setRowInner: vi.fn(),
      addRowImages: vi.fn().mockResolvedValue(undefined),
      removeRowImage: vi.fn(),
      createRow: vi.fn(() => rows[0]),
      answerSpacedRepetitionRow: vi.fn(() => ({})),
      restoreSpacedRepetitionRow: vi.fn(() => true),
    },
  };

  return {
    project: project as unknown as Project,
    flush,
    syncFormulaCacheFull,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SingleFileTableSource", () => {
  it("supports memory fallback for paging, filter buckets, cycle-safe relation candidates, group counts, and date range", async () => {
    const columns: TableColumnSchema[] = [
      {
        id: "col_status",
        name: "状态",
        type: "select",
        options: [
          { id: "opt_todo", name: "待办", color: "blue" },
          { id: "opt_done", name: "完成", color: "green" },
        ],
      },
      { id: "col_due", name: "截止", type: "date" },
    ];

    const secA = makeRow({
      uuid: "sec-a",
      kind: "section",
      primaryText: "章节 A",
      inner: [{ uuid: "sec-b", label: "子章节 B", kind: "section" }],
      tableFields: { col_status: "opt_todo", col_due: "2026-10-10" },
    });
    const secB = makeRow({
      uuid: "sec-b",
      kind: "section",
      primaryText: "子章节 B",
      outer: { uuid: "sec-a", label: "章节 A", kind: "section" },
      inner: [{ uuid: "node-1", label: "节点 1", kind: "text" }],
      tableFields: { col_status: "opt_done", col_due: "2026-10-15" },
    });
    const node1 = makeRow({
      uuid: "node-1",
      kind: "text",
      primaryText: "节点 1",
      outer: { uuid: "sec-b", label: "子章节 B", kind: "section" },
      tableFields: { col_status: "opt_todo", col_due: "2026-10-20" },
    });
    const imgNode = makeRow({
      uuid: "img-1",
      kind: "image",
      primaryText: "图片 1",
      tableFields: {},
    });

    const { project } = createFakeProject([secA, secB, node1, imgNode], columns);
    const source = new SingleFileTableSource(project);
    expect(source.isSqliteBacked()).toBe(false);

    // 1. 分页 + 额外分组筛选（含 pinnedUuids）
    const page = await source.queryPage({
      offset: 0,
      limit: 10,
      extraGroupFilter: { columnId: "col_status", groupKey: "opt_done", pinnedUuids: ["node-1"] },
    });
    expect(page.totalCount).toBe(2);
    expect(page.rows.map((r) => r.uuid)).toEqual(["sec-b", "node-1"]);

    // 2. 筛选分桶
    const buckets = await source.queryFilterBuckets({ columnId: "col_status" });
    expect(buckets.emptyCount).toBe(1);
    expect(buckets.buckets.find((b) => b.key === "opt_todo")?.count).toBe(2);

    // 3. 关系候选防环：为 sec-a 选择 outer 时必须排除自身、后代 (sec-b, node-1) 以及非容器 (img-1)
    const outerCands = await source.queryRelationCandidates({
      rowUuid: "sec-a",
      relationKind: "outer",
    });
    expect(outerCands.candidates).toEqual([]);

    // 为 node-1 选择 inner 时必须排除自身和所有祖先 (sec-b, sec-a)，仅剩 img-1
    const innerCands = await source.queryRelationCandidates({
      rowUuid: "node-1",
      relationKind: "inner",
    });
    expect(innerCands.candidates.map((c) => c.uuid)).toEqual(["img-1"]);

    // 4. 分组统计
    const groupCounts = await source.queryGroupCounts({ groupByColumnId: "col_status" });
    expect(groupCounts.totalCount).toBe(4);
    expect(groupCounts.ungroupedCount).toBe(1);
    expect(groupCounts.groups.find((g) => g.key === "opt_todo")?.count).toBe(2);

    // 5. 日期区间 + 无日期列表
    const dateRange = await source.queryDateRange({
      startColumnId: "col_due",
      minDate: "2026-10-12",
      maxDate: "2026-10-25",
      includeUndated: true,
    });
    expect(dateRange.rows.map((r) => r.uuid)).toEqual(["sec-b", "node-1"]);
    expect(dateRange.undatedCount).toBe(1);
    expect(dateRange.undatedRows.map((r) => r.uuid)).toEqual(["img-1"]);
  });

  it("delegates queries to DocClient after flushing command bus and syncing formulas in SQLite v3 mode", async () => {
    const columns: TableColumnSchema[] = [
      { id: "col_num", name: "数值", type: "number" },
      { id: "col_f", name: "公式", type: "formula", formula: "[col_num] * 2" },
    ];
    const { project, flush, syncFormulaCacheFull } = createFakeProject([], columns, { v3DocId: "v3-doc-1" });

    vi.spyOn(DocClient, "isAvailable").mockReturnValue(true);
    const queryPageSpy = vi.spyOn(DocClient, "queryTablePage").mockResolvedValue({
      totalCount: 1,
      unfilteredTotalCount: 1,
      offset: 0,
      limit: 50,
      rows: [
        {
          docId: "v3-doc-1",
          uuid: "u-1",
          kind: "text",
          primaryText: "来自 SQLite",
          editableText: true,
          images: [],
          canEditImages: true,
          createdAt: 1000,
          updatedAt: 2000,
          sortOrder: 0,
          parents: [],
          children: [],
          outer: null,
          inner: [],
          canEditInner: true,
          cellValues: [
            {
              entityUuid: "u-1",
              colId: "col_num",
              canonicalKey: "auto:number:数值",
              valType: "number",
              valNum: 21,
              multiOptions: [],
            },
          ],
          formulaValues: {
            col_f: {
              kind: "number",
              displayText: "42",
              numericValue: 42,
            },
          },
        },
      ],
    });
    const groupSpy = vi.spyOn(DocClient, "queryTableGroupCounts").mockResolvedValue({
      totalCount: 10,
      ungroupedCount: 2,
      groups: [{ key: "待复习", label: "待复习", count: 8 }],
    });
    const dateSpy = vi.spyOn(DocClient, "queryTableDateRange").mockResolvedValue({
      rows: [],
      undatedCount: 3,
      undatedRows: [],
      totalFilteredCount: 10,
    });

    const source = new SingleFileTableSource(project);
    expect(source.isSqliteBacked()).toBe(true);

    const page = await source.queryPage({ offset: 0, limit: 50 });
    expect(syncFormulaCacheFull).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(queryPageSpy).toHaveBeenCalledTimes(1);
    expect(page.rows[0].primaryText).toBe("来自 SQLite");
    expect(page.rows[0].tableFields["col_num"]).toBe(21);
    expect(page.rows[0].formulaValues?.["col_f"]?.numericValue).toBe(42);

    const gc = await source.queryGroupCounts({ groupByColumnId: "col_f" });
    expect(groupSpy).toHaveBeenCalledTimes(1);
    expect(gc.totalCount).toBe(10);

    const dr = await source.queryDateRange({
      startColumnId: "createdAt",
      minDate: "2026-10-01",
      maxDate: "2026-10-31",
    });
    expect(dateSpy).toHaveBeenCalledTimes(1);
    expect(dr.undatedCount).toBe(3);
  });
});
