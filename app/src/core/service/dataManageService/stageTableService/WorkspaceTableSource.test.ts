// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceClient,
  type WorkspaceColumnRecord,
  type WorkspaceDocRecord,
  type WorkspaceViewRecord,
} from "@/core/sqlite/WorkspaceClient";
import type { TablePageResult, V3TableRowRecord } from "@/core/sqlite/DocClient";
import { WorkspaceTableSource } from "./WorkspaceTableSource";

function makeV3Row(overrides: Partial<V3TableRowRecord> & { uuid: string; docId: string }): V3TableRowRecord {
  return {
    uuid: overrides.uuid,
    docId: overrides.docId,
    sourceFile: overrides.sourceFile ?? "canvas_a",
    sourceFolder: overrides.sourceFolder ?? "alpha",
    sourceRelPath: overrides.sourceRelPath ?? "alpha/canvas_a.prg",
    kind: overrides.kind ?? "text",
    primaryText: overrides.primaryText ?? overrides.uuid,
    editableText: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    images: [],
    canEditImages: true,
    parents: [],
    children: [],
    outer: null,
    inner: [],
    canEditInner: true,
    cellValues: overrides.cellValues ?? [],
    formulaValues: overrides.formulaValues ?? {},
    sortOrder: overrides.sortOrder ?? 0,
  };
}

function setupMockWorkspaceClient(options?: {
  docs?: WorkspaceDocRecord[];
  columns?: WorkspaceColumnRecord[];
  views?: WorkspaceViewRecord[];
}) {
  const docs: WorkspaceDocRecord[] = options?.docs ?? [
    {
      docId: "doc-1",
      relPath: "alpha/canvas_a.prg",
      folderPath: "alpha",
      title: "canvas_a",
      mtimeMs: 1000,
      fileSize: 4096,
      revision: 1,
      formatVersion: "3.0.0",
      absPath: "D:/ws/alpha/canvas_a.prg",
    },
    {
      docId: "doc-2",
      relPath: "beta/canvas_b.prg",
      folderPath: "beta",
      title: "canvas_b",
      mtimeMs: 2000,
      fileSize: 4096,
      revision: 1,
      formatVersion: "3.0.0",
      absPath: "D:/ws/beta/canvas_b.prg",
    },
  ];
  const columns: WorkspaceColumnRecord[] = options?.columns ?? [
    {
      canonicalKey: "ws:status",
      name: "状态",
      type: "select",
      isShared: true,
      configJson: JSON.stringify({
        options: [{ id: "opt-1", name: "进行中", color: "blue" }],
      }),
      docCount: 2,
    },
    {
      canonicalKey: "auto:截止日期",
      name: "截止日期",
      type: "date",
      isShared: false,
      configJson: "{}",
      docCount: 1,
    },
  ];
  const views: WorkspaceViewRecord[] = options?.views ?? [
    {
      id: "ws_default_table",
      name: "原始表",
      type: "table",
      deletable: false,
      position: 0,
      scope: { kind: "all", paths: [] },
      configJson: JSON.stringify({
        visibleColumnIds: ["name", "sourceFile", "ws:status"],
        columnOrder: ["name", "sourceFile", "ws:status", "auto:截止日期"],
      }),
    },
  ];

  vi.spyOn(WorkspaceClient, "isAvailable").mockReturnValue(true);
  vi.spyOn(WorkspaceClient, "listDocs").mockResolvedValue(docs);
  vi.spyOn(WorkspaceClient, "listColumns").mockResolvedValue(columns);
  vi.spyOn(WorkspaceClient, "listViews").mockResolvedValue(views);
  vi.spyOn(WorkspaceClient, "getTableMeta").mockResolvedValue("{}");
  vi.spyOn(WorkspaceClient, "onIndexUpdated").mockResolvedValue(() => {});
  const upsertView = vi.spyOn(WorkspaceClient, "upsertView").mockResolvedValue(undefined);
  const deleteView = vi.spyOn(WorkspaceClient, "deleteView").mockResolvedValue(undefined);
  const reorderViews = vi.spyOn(WorkspaceClient, "reorderViews").mockResolvedValue(undefined);
  const updateTableMeta = vi.spyOn(WorkspaceClient, "updateTableMeta").mockResolvedValue(undefined);
  const createOrGetOption = vi.spyOn(WorkspaceClient, "createOrGetOption").mockResolvedValue({
    id: "ws-opt-urgent",
    name: "紧急",
    color: "red",
  });
  const makeChangeSet = (docId: string, revision: number) => ({
    docId,
    canonicalPath: `D:/ws/${docId}.prg`,
    revision,
    originWindow: "main",
    source: "command" as const,
    dirtyEntities: [],
    deletedEntityUuids: [],
    dirtyEdges: [],
    deletedEdgeUuids: [],
    dirtyAssociations: [],
    deletedAssociationUuids: [],
    dirtyCells: [],
    deletedCells: [],
    schemaChanged: false,
    metadataChanged: false,
    canUndo: true,
    canRedo: false,
    undoCursor: revision,
  });

  const updateRowCells = vi.spyOn(WorkspaceClient, "updateRowCells").mockResolvedValue(makeChangeSet("doc-1", 2));
  const answerSpacedRepetition = vi.spyOn(WorkspaceClient, "answerSpacedRepetition").mockResolvedValue({
    changeset: makeChangeSet("doc-2", 3),
    snapshot: {
      mastery: 1,
      correctCount: 2,
      delay: 0,
      answerDate: "2026-06-15",
    },
  });
  const restoreSpacedRepetition = vi
    .spyOn(WorkspaceClient, "restoreSpacedRepetition")
    .mockResolvedValue(makeChangeSet("doc-2", 4));

  return {
    upsertView,
    deleteView,
    reorderViews,
    updateTableMeta,
    createOrGetOption,
    updateRowCells,
    answerSpacedRepetition,
    restoreSpacedRepetition,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkspaceTableSource", () => {
  it("loads workspace metadata, forwards scope on queries, and populates row cache by docId+uuid", async () => {
    const mocks = setupMockWorkspaceClient();
    const pageResult: TablePageResult = {
      totalCount: 1,
      unfilteredTotalCount: 2,
      offset: 0,
      limit: 50,
      rows: [
        makeV3Row({
          uuid: "row-1",
          docId: "doc-1",
          primaryText: "跨文件节点 1",
          sourceFile: "canvas_a",
          sourceFolder: "alpha",
        }),
      ],
    };
    const queryPageSpy = vi.spyOn(WorkspaceClient, "queryTablePage").mockResolvedValue(pageResult);
    const queryGroupsSpy = vi.spyOn(WorkspaceClient, "queryTableGroupCounts").mockResolvedValue({
      totalCount: 2,
      ungroupedCount: 0,
      groups: [{ key: "opt-1", label: "进行中", count: 2, color: "blue" }],
    });
    const queryDateSpy = vi.spyOn(WorkspaceClient, "queryTableDateRange").mockResolvedValue({
      rows: pageResult.rows,
      undatedCount: 0,
      undatedRows: [],
      totalFilteredCount: 1,
    });

    const source = new WorkspaceTableSource();
    await source.initialize();

    expect(source.scopeKind).toBe("workspace");
    expect(source.isSqliteBacked()).toBe(true);
    expect(source.getWorkspaceDocs()).toHaveLength(2);
    expect(source.getColumns().map((c) => c.id)).toEqual(["ws:status", "auto:截止日期"]);

    // 切换作用域为指定文件夹并验证查询透传
    source.setScope({ kind: "folders", paths: ["alpha"] });
    expect(mocks.upsertView).toHaveBeenCalled();

    const page = await source.queryPage({ offset: 0, limit: 50 });
    expect(page.totalCount).toBe(1);
    expect(page.rows[0].docId).toBe("doc-1");
    expect(page.rows[0].sourceFile).toBe("canvas_a");
    expect(queryPageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "folders", paths: ["alpha"] },
      }),
    );

    // 验证 rowCacheByKey 命中
    expect(source.getCachedRow("row-1", "doc-1")?.primaryText).toBe("跨文件节点 1");

    const groups = await source.queryGroupCounts({ groupByColumnId: "ws:status" });
    expect(groups.groups[0].count).toBe(2);
    expect(queryGroupsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "folders", paths: ["alpha"] },
        groupByColumnId: "ws:status",
      }),
    );

    const dateRes = await source.queryDateRange({
      startColumnId: "auto:截止日期",
      minDate: "2026-06-01",
      maxDate: "2026-06-30",
    });
    expect(dateRes.rows).toHaveLength(1);
    expect(queryDateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "folders", paths: ["alpha"] },
        startColumnId: "auto:截止日期",
      }),
    );

    source.dispose();
  });

  it("persists view CRUD and maps optimistic select option ids to option names when writing cells", async () => {
    const mocks = setupMockWorkspaceClient();
    const source = new WorkspaceTableSource();
    await source.initialize();

    // 新建 / 重命名 / 复制 / 排序 / 删除视图
    const kanban = source.createView({ type: "kanban", name: "全局看板" });
    expect(kanban).not.toBeNull();
    expect(kanban!.type).toBe("kanban");
    expect(mocks.upsertView).toHaveBeenCalled();

    source.renameView(kanban!.id, "任务看板");
    expect(source.getViews().find((v) => v.id === kanban!.id)?.name).toBe("任务看板");

    source.duplicateView(kanban!.id, "副本");
    const dup = source.getViews().find((v) => v.name === "任务看板 副本");
    expect(dup).toBeDefined();

    source.reorderViews(dup!.id, kanban!.id, "before");
    expect(mocks.reorderViews).toHaveBeenCalled();
    source.deleteView(dup!.id);
    expect(mocks.deleteView).toHaveBeenCalledWith(dup!.id);

    // 乐观创建选项并写回：应将 optionName ("紧急") 传给 Rust，避免临时 optionId 竞态
    const createdOpt = source.createOrGetSelectOption("ws:status", "紧急");
    expect(createdOpt).not.toBeNull();
    expect(mocks.createOrGetOption).toHaveBeenCalledWith("ws:status", "紧急");

    await source.updateRowCustomField("row-1", "ws:status", createdOpt!.id, "doc-1");
    expect(mocks.updateRowCells).toHaveBeenCalledWith(
      "doc-1",
      "row-1",
      [{ canonicalKey: "ws:status", value: "紧急" }],
      true,
      expect.any(String),
    );

    // 全局间隔重复刷卡与撤回路由
    const snap = await source.answerSpacedRepetitionRow("row-2", "correct_closed", { docId: "doc-2" });
    expect(snap).toEqual({
      mastery: 1,
      correctCount: 2,
      delay: 0,
      answerDate: "2026-06-15",
    });
    expect(mocks.answerSpacedRepetition).toHaveBeenCalledWith(
      "doc-2",
      "row-2",
      "correct_closed",
      expect.any(String),
      null,
    );

    const restored = await source.restoreSpacedRepetitionRow(
      "row-2",
      { mastery: 2, correctCount: 1, delay: 1, answerDate: "2026-06-10" },
      { docId: "doc-2" },
    );
    expect(restored).toBe(true);
    expect(mocks.restoreSpacedRepetition).toHaveBeenCalledWith(
      "doc-2",
      "row-2",
      { mastery: 2, correctCount: 1, delay: 1, answerDate: "2026-06-10" },
      expect.any(String),
    );

    source.dispose();
  });
});
