import { describe, expect, it } from "vitest";
import type { DocChangeSet } from "@/core/sqlite/DocClient";
import type { TableColumnSchema, TableFilterSortRow } from "@/types/table";
import { FormulaDagEngine, extractFormulaDeltaFromChangeSet } from "./FormulaDagEngine";
import { FORMULA_TABLE_REF_ID, clearFormulaAstCache, evaluateTableFormulas, parseFormulaCached } from "./formulaEngine";

function makeRow(overrides: Partial<TableFilterSortRow> & { uuid: string }): TableFilterSortRow {
  return {
    primaryText: overrides.uuid,
    images: [],
    createdAt: new Date(2026, 9, 1, 10, 0, 0).getTime(),
    updatedAt: new Date(2026, 9, 2, 12, 0, 0).getTime(),
    parents: [],
    children: [],
    outer: null,
    inner: [],
    tableFields: {},
    ...overrides,
  };
}

describe("FormulaDagEngine", () => {
  it("caches parsed AST instances and resets when cache is cleared", () => {
    clearFormulaAstCache();
    const first = parseFormulaCached("1 + 2 * 3");
    const second = parseFormulaCached("1 + 2 * 3");
    expect(second).toBe(first);

    clearFormulaAstCache();
    const third = parseFormulaCached("1 + 2 * 3");
    expect(third).not.toBe(first);
    expect(third.error).toBeUndefined();
  });

  it("computes transitive downstream closure and only re-evaluates affected columns and rows", () => {
    const columns: TableColumnSchema[] = [
      { id: "col_a", name: "A", type: "number" },
      { id: "col_b", name: "B", type: "number" },
      { id: "col_f1", name: "F1", type: "formula", formula: "[col_a] * 2" },
      { id: "col_f2", name: "F2", type: "formula", formula: "[col_f1] + 10" },
      { id: "col_f3", name: "F3", type: "formula", formula: "[col_f2] * 3" },
      { id: "col_unrelated", name: "Unrelated", type: "formula", formula: "[col_b] + 1" },
    ];

    const rows: TableFilterSortRow[] = [
      makeRow({ uuid: "r1", tableFields: { col_a: 2, col_b: 5 } }),
      makeRow({ uuid: "r2", tableFields: { col_a: 4, col_b: 8 } }),
    ];
    const rowByUuid = new Map(rows.map((r) => [r.uuid, r]));
    const engine = new FormulaDagEngine();
    const now = new Date(2026, 9, 23, 9, 0, 0);

    const full = engine.evaluateFull(rows, rowByUuid, columns, undefined, now);
    expect(full.fullRebuild).toBe(true);
    expect(full.evaluatedCellCount).toBe(8);
    expect(engine.getRowFormulaValues("r1")["col_f3"]?.numericValue).toBe((2 * 2 + 10) * 3);
    expect(engine.getRowFormulaValues("r1")["col_unrelated"]?.numericValue).toBe(6);

    // 修改 r1 的 col_a：仅应重算 r1 的 col_f1/col_f2/col_f3（共 3 格），不应重算 r2 或 col_unrelated
    rows[0].tableFields = { col_a: 5, col_b: 5 };
    const inc = engine.evaluateIncremental({
      rows,
      rowByUuid,
      columns,
      dirtyRowUuids: ["r1"],
      changedColumnIds: ["col_a"],
      now,
    });
    expect(inc.fullRebuild).toBe(false);
    expect(inc.evaluatedCellCount).toBe(3);
    expect(inc.changedEntries.length).toBe(3);
    expect(engine.getRowFormulaValues("r1")["col_f1"]?.numericValue).toBe(10);
    expect(engine.getRowFormulaValues("r1")["col_f2"]?.numericValue).toBe(20);
    expect(engine.getRowFormulaValues("r1")["col_f3"]?.numericValue).toBe(60);
    expect(engine.getRowFormulaValues("r2")["col_f3"]?.numericValue).toBe((4 * 2 + 10) * 3);
  });

  it("propagates 1-hop relation traversal changes to neighbor rows", () => {
    const columns: TableColumnSchema[] = [
      {
        id: "col_parent_names",
        name: "父节点名",
        type: "formula",
        formula: '[parents].[name].LISTJOIN(", ")',
      },
    ];

    const parentRow = makeRow({
      uuid: "parent-1",
      primaryText: "旧父节点",
      children: [{ uuid: "child-1", label: "子节点" }],
    });
    const childRow = makeRow({
      uuid: "child-1",
      primaryText: "子节点",
      parents: [{ uuid: "parent-1", label: "旧父节点" }],
    });
    const rows = [parentRow, childRow];
    const rowByUuid = new Map(rows.map((r) => [r.uuid, r]));
    const engine = new FormulaDagEngine();
    const now = new Date(2026, 9, 23, 9, 0, 0);

    engine.evaluateFull(rows, rowByUuid, columns, undefined, now);
    expect(engine.getRowFormulaValues("child-1")["col_parent_names"]?.displayText).toBe("旧父节点");

    // 仅标记 parent-1 的 name 发生变动，DAG 应自动通过 1-hop 邻接扩散重算 child-1
    parentRow.primaryText = "新父节点";
    childRow.parents = [{ uuid: "parent-1", label: "新父节点" }];
    const inc = engine.evaluateIncremental({
      rows,
      rowByUuid,
      columns,
      dirtyRowUuids: ["parent-1"],
      changedColumnIds: ["name"],
      now,
    });
    expect(inc.fullRebuild).toBe(false);
    expect(engine.getRowFormulaValues("child-1")["col_parent_names"]?.displayText).toBe("新父节点");
  });

  it("propagates __table__ aggregate references across all rows", () => {
    const columns: TableColumnSchema[] = [
      { id: "col_score", name: "分值", type: "number" },
      {
        id: "col_total",
        name: "总分",
        type: "formula",
        formula: `SUM([${FORMULA_TABLE_REF_ID}].[col_score])`,
      },
    ];
    const rows = [
      makeRow({ uuid: "r1", tableFields: { col_score: 10 } }),
      makeRow({ uuid: "r2", tableFields: { col_score: 20 } }),
    ];
    const rowByUuid = new Map(rows.map((r) => [r.uuid, r]));
    const engine = new FormulaDagEngine();
    engine.evaluateFull(rows, rowByUuid, columns);
    expect(engine.getRowFormulaValues("r2")["col_total"]?.numericValue).toBe(30);

    rows[0].tableFields = { col_score: 50 };
    const inc = engine.evaluateIncremental({
      rows,
      rowByUuid,
      columns,
      dirtyRowUuids: ["r1"],
      changedColumnIds: ["col_score"],
    });
    expect(inc.fullRebuild).toBe(false);
    expect(engine.getRowFormulaValues("r1")["col_total"]?.numericValue).toBe(70);
    expect(engine.getRowFormulaValues("r2")["col_total"]?.numericValue).toBe(70);
  });

  it("refreshes volatile TODAY() columns only when calendar day rolls over", () => {
    const columns: TableColumnSchema[] = [
      { id: "col_due", name: "到期日", type: "date" },
      {
        id: "col_status",
        name: "状态",
        type: "formula",
        formula: 'IF([col_due] <= TODAY(), "待复习", "未到期")',
      },
    ];
    const rows = [makeRow({ uuid: "r1", tableFields: { col_due: "2026-10-24" } })];
    const rowByUuid = new Map(rows.map((r) => [r.uuid, r]));
    const engine = new FormulaDagEngine();

    const day1 = new Date(2026, 9, 23, 23, 59, 0);
    engine.evaluateFull(rows, rowByUuid, columns, undefined, day1);
    expect(engine.getRowFormulaValues("r1")["col_status"]?.displayText).toBe("未到期");

    // 同一天调用 refreshVolatileIfDayChanged 返回 null，不做冗余计算
    const sameDay = engine.refreshVolatileIfDayChanged(
      rows,
      rowByUuid,
      columns,
      undefined,
      new Date(2026, 9, 23, 23, 59, 59),
    );
    expect(sameDay).toBeNull();

    // 跨午夜后仅重算易变列并输出变更
    const day2 = new Date(2026, 9, 24, 0, 0, 5);
    const rolled = engine.refreshVolatileIfDayChanged(rows, rowByUuid, columns, undefined, day2);
    expect(rolled).not.toBeNull();
    expect(rolled?.evaluatedCellCount).toBe(1);
    expect(engine.getRowFormulaValues("r1")["col_status"]?.displayText).toBe("待复习");
  });

  it("matches full evaluation 100% and runs single-cell edit in O(1) on 5,000 rows", () => {
    const columns: TableColumnSchema[] = [
      { id: "col_sr_correctCount", name: "连续答对次数", type: "number" },
      { id: "col_sr_answerDate", name: "作答日期", type: "date" },
      { id: "col_sr_delay", name: "延迟天数", type: "number" },
      { id: "col_sr_archive", name: "归档状态", type: "text" },
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
        formula: 'DATEADD([col_sr_answerDate], [col_sr_nextInterval] + [col_sr_delay], "days")',
      },
      {
        id: "col_sr_dueStatus",
        name: "到期状态",
        type: "formula",
        formula: 'IF([col_sr_archive] = "已归档", "已归档", IF([col_sr_nextDueDate] <= TODAY(), "待复习", "未到期"))',
      },
    ];

    const ROW_COUNT = 5000;
    const rows: TableFilterSortRow[] = Array.from({ length: ROW_COUNT }, (_, i) =>
      makeRow({
        uuid: `row-${i}`,
        primaryText: `卡片 ${i}`,
        tableFields: {
          col_sr_correctCount: (i % 4) + 1,
          col_sr_answerDate: "2026-10-20",
          col_sr_delay: i % 3,
          col_sr_archive: i % 20 === 0 ? "已归档" : "",
        },
      }),
    );
    const rowByUuid = new Map(rows.map((r) => [r.uuid, r]));
    const now = new Date(2026, 9, 23, 10, 0, 0);
    const engine = new FormulaDagEngine();

    const full = engine.evaluateFull(rows, rowByUuid, columns, undefined, now);
    expect(full.evaluatedCellCount).toBe(ROW_COUNT * 3);

    // 仅修改第 42 行的连续答对次数
    const targetRow = rows[42];
    targetRow.tableFields = {
      ...targetRow.tableFields,
      col_sr_correctCount: 5,
    };

    const t0 = performance.now();
    const inc = engine.evaluateIncremental({
      rows,
      rowByUuid,
      columns,
      dirtyRowUuids: [targetRow.uuid],
      changedColumnIds: ["col_sr_correctCount"],
      now,
    });
    const elapsedMs = performance.now() - t0;

    expect(inc.fullRebuild).toBe(false);
    // 仅重算目标行的 3 个公式列（而不是 15,000 个单元格）
    expect(inc.evaluatedCellCount).toBe(3);
    expect(elapsedMs).toBeLessThan(100);

    // 与全量 evaluateTableFormulas 比对，结果 100% 一致
    const reference = evaluateTableFormulas(rows, columns, { now });
    for (const checkUuid of ["row-0", "row-42", "row-999", "row-4999"]) {
      const got = engine.getRowFormulaValues(checkUuid);
      const ref = reference.get(checkUuid);
      expect(got["col_sr_nextInterval"]?.displayText).toBe(ref?.["col_sr_nextInterval"]?.displayText);
      expect(got["col_sr_nextDueDate"]?.displayText).toBe(ref?.["col_sr_nextDueDate"]?.displayText);
      expect(got["col_sr_dueStatus"]?.displayText).toBe(ref?.["col_sr_dueStatus"]?.displayText);
    }
  });

  it("extracts dirty rows, columns, and topology flags from DocChangeSet", () => {
    const changeset: DocChangeSet = {
      docId: "doc-1",
      canonicalPath: "/tmp/doc-1.prg",
      revision: 3,
      originWindow: "main",
      source: "command",
      dirtyEntities: [],
      deletedEntityUuids: ["del-1"],
      dirtyEdges: [
        {
          uuid: "edge-1",
          kind: "line",
          sourceUuid: "a",
          targetUuid: "b",
          text: "",
          propsJson: "{}",
          sortOrder: 0,
        },
      ],
      deletedEdgeUuids: [],
      dirtyAssociations: [],
      deletedAssociationUuids: [],
      dirtyCells: [
        {
          entityUuid: "c",
          colId: "col_1",
          canonicalKey: "auto:text:col_1",
          valType: "text",
          valText: "hi",
          multiOptions: [],
        },
      ],
      deletedCells: [],
      schemaChanged: false,
      metadataChanged: false,
      canUndo: true,
      canRedo: false,
      undoCursor: 1,
    };

    const delta = extractFormulaDeltaFromChangeSet(changeset);
    expect(delta.deletedRowUuids.has("del-1")).toBe(true);
    expect(delta.dirtyRowUuids.has("a")).toBe(true);
    expect(delta.dirtyRowUuids.has("b")).toBe(true);
    expect(delta.dirtyRowUuids.has("c")).toBe(true);
    expect(delta.changedColumnIds.has("col_1")).toBe(true);
    expect(delta.changedColumnIds.has("parents")).toBe(true);
    expect(delta.changedColumnIds.has("children")).toBe(true);
    expect(delta.topologyChanged).toBe(true);
    expect(delta.schemaChanged).toBe(false);
  });
});
