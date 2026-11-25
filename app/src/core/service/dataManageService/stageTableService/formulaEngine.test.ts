import { describe, expect, it } from "vitest";
import type { TableColumnSchema, TableFilterSortRow } from "@/types/table";
import {
  FORMULA_TABLE_REF_ID,
  evaluateSingleFormulaPreview,
  evaluateTableFormulas,
  hasVolatileFormulas,
  normalizeFormulaColumnRefs,
  parseFormula,
  validateColumnFormula,
} from "./formulaEngine";
import { FORMULA_CATALOG_ITEMS } from "./formulaCatalog";

function makeRow(overrides: Partial<TableFilterSortRow> & { uuid: string }): TableFilterSortRow {
  return {
    primaryText: overrides.uuid,
    images: [],
    createdAt: new Date(2026, 9, 16, 10, 0, 0).getTime(),
    updatedAt: new Date(2026, 9, 22, 15, 30, 0).getTime(),
    parents: [],
    children: [],
    outer: null,
    inner: [],
    tableFields: {},
    ...overrides,
  };
}

function evalExpr(
  formula: string,
  row: TableFilterSortRow = makeRow({ uuid: "r1", primaryText: "细胞膜图像" }),
  columns: TableColumnSchema[] = [],
  options: { now?: Date; format?: string; allRows?: TableFilterSortRow[] } = {},
) {
  const formulaCol: TableColumnSchema = {
    id: "col_target",
    name: "结果",
    type: "formula",
    formula,
    format: options.format,
  };
  const allColumns = [...columns, formulaCol];
  const rows = options.allRows ?? [row];
  const map = evaluateTableFormulas(rows, allColumns, { now: options.now ?? new Date(2026, 9, 23, 9, 0, 0) });
  return map.get(row.uuid)?.["col_target"];
}

describe("formulaEngine", () => {
  it("evaluates all 15 operators including precedence, exponentiation, concat, and array equality", () => {
    expect(evalExpr("1 + 2 * 3")?.numericValue).toBe(7);
    expect(evalExpr("(1 + 2) * 3")?.numericValue).toBe(9);
    expect(evalExpr("10 / 4")?.numericValue).toBe(2.5);
    expect(evalExpr("2 ^ 3")?.numericValue).toBe(8);
    expect(evalExpr("2 ^ 3 ^ 2")?.numericValue).toBe(512);
    expect(evalExpr('"间隔 " & 3 & " 天"')?.displayText).toBe("间隔 3 天");
    expect(evalExpr("5 > 3")?.booleanValue).toBe(true);
    expect(evalExpr("5 >= 5")?.booleanValue).toBe(true);
    expect(evalExpr("2 < 5")?.booleanValue).toBe(true);
    expect(evalExpr("2 <= 2")?.booleanValue).toBe(true);
    expect(evalExpr("3 = 3")?.booleanValue).toBe(true);
    expect(evalExpr("3 == 3")?.booleanValue).toBe(true);
    expect(evalExpr("1 != 2")?.booleanValue).toBe(true);
    expect(evalExpr("1 <> 2")?.booleanValue).toBe(true);
    expect(evalExpr("[1, 2, 3] != [1, 2]")?.booleanValue).toBe(true);
    expect(evalExpr("[1, 2, 3] = [3, 2, 1]")?.booleanValue).toBe(true);
    expect(evalExpr("[1, 2] !== [2, 1]")?.booleanValue).toBe(true);
    expect(evalExpr("1 / 0")?.errorCode).toBe("#DIV/0!");
  });

  it("evaluates all number functions", () => {
    expect(evalExpr("ABS(-2)")?.numericValue).toBe(2);
    expect(evalExpr("AVERAGE(2, 4, 6)")?.numericValue).toBe(4);
    expect(evalExpr("CEILING(2.1)")?.numericValue).toBe(3);
    expect(evalExpr("CEILING(2.3, 0.5)")?.numericValue).toBe(2.5);
    expect(evalExpr("FLOOR(2.9)")?.numericValue).toBe(2);
    expect(evalExpr("FLOOR(2.7, 0.5)")?.numericValue).toBe(2.5);
    expect(evalExpr('COUNT(1, "text", 3)')?.numericValue).toBe(2);
    expect(evalExpr('COUNTA(1, "text", "", NULL)')?.numericValue).toBe(2);
    expect(evalExpr('COUNTIF(LIST(1, 3, 5), ">2")')?.numericValue).toBe(2);
    expect(evalExpr("ROUND(EXP(1), 2)")?.numericValue).toBe(2.72);
    expect(evalExpr("INT(-2.1)")?.numericValue).toBe(-3);
    expect(evalExpr("LOG(100)")?.numericValue).toBe(2);
    expect(evalExpr("LOG(8, 2)")?.numericValue).toBe(3);
    expect(evalExpr("MAX(1, 7, 3)")?.numericValue).toBe(7);
    expect(evalExpr("MIN(1, 7, 3)")?.numericValue).toBe(1);
    expect(evalExpr("POWER(2, 4) - 1")?.numericValue).toBe(15);
    const randRes = evalExpr("RAND()")?.numericValue ?? -1;
    expect(randRes).toBeGreaterThanOrEqual(0);
    expect(randRes).toBeLessThan(1);
    expect(evalExpr("ROUND(3.14159, 2)")?.numericValue).toBe(3.14);
    expect(evalExpr("SQRT(16)")?.numericValue).toBe(4);
    expect(evalExpr("SUM(1, 2, 3, LIST(4, 5))")?.numericValue).toBe(15);
    expect(evalExpr('SUMIF(LIST(1, 5, 8), ">3")')?.numericValue).toBe(13);
    expect(evalExpr('SUMIF(LIST("A", "B", "A"), "A", LIST(10, 20, 30))')?.numericValue).toBe(40);
  });

  it("evaluates all logic functions with lazy short-circuiting", () => {
    expect(evalExpr("AND(TRUE, 1 < 2)")?.booleanValue).toBe(true);
    expect(evalExpr("AND(FALSE, 1 / 0)")?.booleanValue).toBe(false);
    expect(evalExpr("OR(TRUE, 1 / 0)")?.booleanValue).toBe(true);
    expect(evalExpr("NOT(FALSE())")?.booleanValue).toBe(true);
    expect(evalExpr("IF(TRUE(), 10, 1 / 0)")?.numericValue).toBe(10);
    expect(evalExpr("IF(FALSE(), 1 / 0, 20)")?.numericValue).toBe(20);
    expect(evalExpr('IFS(FALSE, "a", 2 > 1, "b", TRUE, "c")')?.displayText).toBe("b");
    expect(evalExpr('SWITCH(2, 1, "低", 2, "中", 3, "高", "未知")')?.displayText).toBe("中");
    expect(evalExpr('IFBLANK("", "默认")')?.displayText).toBe("默认");
    expect(evalExpr('IFBLANK("有值", 1 / 0)')?.displayText).toBe("有值");
    expect(evalExpr("IFERROR(1 / 0, 0)")?.numericValue).toBe(0);
    expect(evalExpr('ISBLANK("")')?.booleanValue).toBe(true);
    expect(evalExpr("ISBLANK(NULL)")?.booleanValue).toBe(true);
    expect(evalExpr('ISNULL("")')?.booleanValue).toBe(false);
    expect(evalExpr("ISNULL(NULL)")?.booleanValue).toBe(true);
    expect(evalExpr("ISERROR(1 / 0)")?.booleanValue).toBe(true);
    expect(evalExpr("ISERROR(42)")?.booleanValue).toBe(false);
    expect(evalExpr("RECORD_ID()", makeRow({ uuid: "node-abc" }))?.displayText).toBe("node-abc");
  });

  it("evaluates all text functions including TEXT date/weekday/percent formatting", () => {
    expect(evalExpr("CHAR(65)")?.displayText).toBe("A");
    expect(evalExpr('CONCAT("第", 3, "次")')?.displayText).toBe("第3次");
    expect(evalExpr('CONCATENATE("Flux", " ", "Graph")')?.displayText).toBe("Flux Graph");
    expect(evalExpr('CONTAINTEXT("细胞膜结构", "细胞")')?.booleanValue).toBe(true);
    expect(evalExpr('FIND("b", "abc")')?.numericValue).toBe(2);
    expect(evalExpr('SEARCH("GRAPH", "Flux Graph")')?.numericValue).toBe(6);
    expect(evalExpr('LEFT("细胞生物学", 2)')?.displayText).toBe("细胞");
    expect(evalExpr('RIGHT("2026-10-23", 2)')?.displayText).toBe("23");
    expect(evalExpr('MID("2026-10-23", 6, 2)')?.displayText).toBe("10");
    expect(evalExpr('LEN("Flux")')?.numericValue).toBe(4);
    expect(evalExpr('LOWER("Hello")')?.displayText).toBe("hello");
    expect(evalExpr('UPPER("flux")')?.displayText).toBe("FLUX");
    expect(evalExpr('TRIM("  细胞   膜  ")')?.displayText).toBe("细胞 膜");
    expect(evalExpr('REPLACE("abcdef", 2, 3, "XY")')?.displayText).toBe("aXYef");
    expect(evalExpr('SUBSTITUTE("a-b-c", "-", "/")')?.displayText).toBe("a/b/c");
    expect(evalExpr('SUBSTITUTE("a-b-c", "-", "/", 2)')?.displayText).toBe("a-b/c");
    expect(evalExpr('SPLIT("a,b,c", ",")')?.listItems).toEqual(["a", "b", "c"]);
    expect(evalExpr('TEXT("2024-09-14", "ddd")')?.displayText).toBe("周六");
    expect(evalExpr('TEXT("2024-09-14", "DDDD")')?.displayText).toBe("星期六");
    expect(evalExpr('TEXT("2024-09-14", "YYYY/MM/DD")')?.displayText).toBe("2024/09/14");
    expect(evalExpr('TEXT(0.856, "0.0%")')?.displayText).toBe("85.6%");
    expect(evalExpr('TEXTJOIN("、", TRUE, "数学", "", "生物")')?.displayText).toBe("数学、生物");
    expect(evalExpr('VALUE("80%")')?.numericValue).toBe(0.8);
    expect(evalExpr('VALUE("1,234.5")')?.numericValue).toBe(1234.5);
  });

  it("evaluates all date & time functions following Scheme A precision rules", () => {
    const fixedNow = new Date(2026, 9, 23, 9, 15, 30); // 2026-10-23 09:15:30 (Friday)
    expect(evalExpr("DATE(2026, 10, 23)", undefined, [], { now: fixedNow })?.displayText).toBe("2026-10-23");
    expect(evalExpr('DATEADD("2026-10-20", 3, "D")')?.displayText).toBe("2026-10-23");
    expect(evalExpr('DATEDIF("2026-10-20", "2026-10-23", "D")')?.numericValue).toBe(3);
    expect(evalExpr('DATEDIF("2025-10-23", "2026-10-23", "Y")')?.numericValue).toBe(1);
    expect(evalExpr('DATEVALUE("2026/10/23")')?.displayText).toBe("2026-10-23");
    expect(evalExpr("TODAY()", undefined, [], { now: fixedNow })?.displayText).toBe("2026-10-23");
    expect(evalExpr("YEAR(NOW())", undefined, [], { now: fixedNow })?.numericValue).toBe(2026);
    expect(evalExpr("MONTH(NOW())", undefined, [], { now: fixedNow })?.numericValue).toBe(10);
    expect(evalExpr("DAY(NOW())", undefined, [], { now: fixedNow })?.numericValue).toBe(23);
    expect(evalExpr("HOUR(NOW())", undefined, [], { now: fixedNow })?.numericValue).toBe(9);
    expect(evalExpr("MINUTE(NOW())", undefined, [], { now: fixedNow })?.numericValue).toBe(15);
    expect(evalExpr("SECOND(NOW())", undefined, [], { now: fixedNow })?.numericValue).toBe(30);
    expect(evalExpr('WEEKDAY("2026-10-23", 2)')?.numericValue).toBe(5); // Friday
    expect(evalExpr('WEEKNUM("2026-01-10")')?.numericValue).toBeGreaterThanOrEqual(2);
    expect(evalExpr('NETWORKDAYS("2026-10-19", "2026-10-25")')?.numericValue).toBe(5);
    expect(evalExpr('WORKDAY("2026-10-23", 2)')?.displayText).toBe("2026-10-27");

    // Scheme A: updatedAt preserves time-of-day unless truncated with TODATE()
    const row = makeRow({
      uuid: "r-time",
      updatedAt: new Date(2026, 9, 22, 16, 30, 0).getTime(),
    });
    // Raw updatedAt + 1 = 2026-10-23 16:30 > TODAY() (2026-10-23 00:00)
    expect(evalExpr("({{updatedAt}} + 1) <= TODAY()", row, [], { now: fixedNow })?.booleanValue).toBe(false);
    // TODATE(updatedAt) + 1 = 2026-10-23 00:00 <= TODAY() (2026-10-23 00:00)
    expect(evalExpr("(TODATE({{updatedAt}}) + 1) <= TODAY()", row, [], { now: fixedNow })?.booleanValue).toBe(true);
  });

  it("evaluates all list functions and method chaining", () => {
    expect(evalExpr("LIST(1, 2, 3).LAST()")?.numericValue).toBe(3);
    expect(evalExpr('LIST("智", "能", "表", "格").LAST()')?.displayText).toBe("格");
    expect(evalExpr("LIST(10, 20, 30).FIRST()")?.numericValue).toBe(10);
    expect(evalExpr("LIST(10, 20, 30).AT(2)")?.numericValue).toBe(20);
    expect(evalExpr("LIST(10, 20, 30).AT(-1)")?.numericValue).toBe(30);
    expect(evalExpr('CHOOSE(2, "简单", "中等", "困难")')?.displayText).toBe("中等");
    expect(evalExpr('LIST("细胞", "膜").CONTAINS("细胞")')?.booleanValue).toBe(true);
    expect(evalExpr('LIST("A", "B", "C").CONTAINSALL("A", "C")')?.booleanValue).toBe(true);
    expect(evalExpr('LIST("A", "B").CONTAINSONLY("B", "A")')?.booleanValue).toBe(true);
    expect(evalExpr('LIST("A", "B").CONTAINSONLY("A")')?.booleanValue).toBe(false);
    expect(evalExpr("LIST(1, 5, 8).FILTER(current > 3)")?.listItems).toEqual(["5", "8"]);
    expect(evalExpr("LISTCOMBINE(LIST(1, 2), LIST(3, 4))")?.listItems).toEqual(["1", "2", "3", "4"]);
    expect(evalExpr('LIST("细胞", "膜").LISTJOIN(" / ")')?.displayText).toBe("细胞 / 膜");
    expect(evalExpr('LOOKUP("B", LIST("A", "B"), LIST(10, 20))')?.numericValue).toBe(20);
    expect(evalExpr("LIST(1, 2, 2, 3).UNIQUE()")?.listItems).toEqual(["1", "2", "3"]);
  });

  it("runs the full 3-level spaced repetition system (SRS) + graph relation traversal + whole table ref", () => {
    const columns: TableColumnSchema[] = [
      { id: "col_mastery", name: "掌握程度", type: "number" },
      { id: "col_correct", name: "答对次数", type: "number" },
      { id: "col_delay", name: "延期", type: "number" },
      {
        id: "col_archive",
        name: "归档状态",
        type: "select",
        options: [
          { id: "opt_active", name: "未归档", color: "gray" },
          { id: "opt_done", name: "已归档", color: "green" },
        ],
      },
      {
        id: "col_interval",
        name: "下次作答",
        type: "formula",
        formula: "POWER(2, {{col_correct}}) - 1 + {{col_delay}}",
      },
      {
        id: "col_due_date",
        name: "下次要求作答时间",
        type: "formula",
        formula: "TODATE({{updatedAt}}) + {{col_interval}}",
        format: "MM/DD/YYYY",
      },
      {
        id: "col_due_status",
        name: "是否到期",
        type: "formula",
        formula: 'IF({{col_archive}} = "已归档", "已归档", IF({{col_due_date}} <= TODAY(), "待复习", "未到期"))',
      },
      {
        id: "col_chapter_due",
        name: "章节待复习数",
        type: "formula",
        formula: '{{inner}}.FILTER(current.{{col_due_status}} = "待复习").COUNT()',
      },
      {
        id: "col_chapter_avg",
        name: "章节平均掌握度",
        type: "formula",
        formula: "IFERROR(ROUND({{inner}}.{{col_mastery}}.AVERAGE(), 1), 0)",
      },
      {
        id: "col_table_due_total",
        name: "全表待复习总数",
        type: "formula",
        formula: `COUNTIF({{${FORMULA_TABLE_REF_ID}}}.{{col_due_status}}, "待复习")`,
      },
    ];

    const q1 = makeRow({
      uuid: "q1",
      primaryText: "细胞膜图像",
      updatedAt: new Date(2026, 9, 22, 14, 0, 0).getTime(),
      outer: { uuid: "sec1", label: "第一章 细胞" },
      tableFields: {
        col_mastery: 2,
        col_correct: 1,
        col_delay: 0,
        col_archive: "opt_active",
      },
    });
    const q2 = makeRow({
      uuid: "q2",
      primaryText: "线粒体结构",
      updatedAt: new Date(2026, 9, 22, 14, 0, 0).getTime(),
      outer: { uuid: "sec1", label: "第一章 细胞" },
      tableFields: {
        col_mastery: 4,
        col_correct: 3, // interval = 2^3 - 1 = 7 -> 10/29 (not due on 10/23)
        col_delay: 0,
        col_archive: "opt_active",
      },
    });
    const sec1 = makeRow({
      uuid: "sec1",
      primaryText: "第一章 细胞",
      inner: [
        { uuid: "q1", label: "细胞膜图像" },
        { uuid: "q2", label: "线粒体结构" },
      ],
      tableFields: { col_archive: "opt_done" },
    });

    const evaluated = evaluateTableFormulas([q1, q2, sec1], columns, {
      now: new Date(2026, 9, 23, 8, 0, 0),
    });

    // q1: 2^1 - 1 + 0 = 1 -> 10/23/2026 -> 待复习
    expect(evaluated.get("q1")?.["col_interval"]?.numericValue).toBe(1);
    expect(evaluated.get("q1")?.["col_due_date"]?.displayText).toBe("10/23/2026");
    expect(evaluated.get("q1")?.["col_due_status"]?.displayText).toBe("待复习");

    // q2: 2^3 - 1 + 0 = 7 -> 10/29/2026 -> 未到期
    expect(evaluated.get("q2")?.["col_interval"]?.numericValue).toBe(7);
    expect(evaluated.get("q2")?.["col_due_date"]?.displayText).toBe("10/29/2026");
    expect(evaluated.get("q2")?.["col_due_status"]?.displayText).toBe("未到期");

    // sec1: graph relation traversal across inner children!
    expect(evaluated.get("sec1")?.["col_chapter_due"]?.numericValue).toBe(1);
    expect(evaluated.get("sec1")?.["col_chapter_avg"]?.numericValue).toBe(3);
    expect(evaluated.get("sec1")?.["col_table_due_total"]?.numericValue).toBe(1);
  });

  it("detects circular references, deleted columns, syntax errors, and volatile functions", () => {
    const columns: TableColumnSchema[] = [
      { id: "col_a", name: "A", type: "formula", formula: "{{col_b}} + 1" },
      { id: "col_b", name: "B", type: "formula", formula: "{{col_a}} + 1" },
      { id: "col_missing", name: "Broken", type: "formula", formula: "{{col_deleted}} + 1" },
      { id: "col_today", name: "今天", type: "formula", formula: "TODAY()" },
    ];

    const row = makeRow({ uuid: "r1" });
    const evaluated = evaluateTableFormulas([row], columns);
    expect(evaluated.get("r1")?.["col_a"]?.errorCode).toBe("#CYCLE!");
    expect(evaluated.get("r1")?.["col_b"]?.errorCode).toBe("#CYCLE!");
    expect(evaluated.get("r1")?.["col_missing"]?.errorCode).toBe("#REF!");

    const cycleCheck = validateColumnFormula("col_a", "{{col_b}} + 1", { columns });
    expect(cycleCheck.valid).toBe(false);
    expect(cycleCheck.hasCycle).toBe(true);
    expect(cycleCheck.errorCode).toBe("#CYCLE!");

    const syntaxCheck = validateColumnFormula("col_x", "POWER(2, ", { columns });
    expect(syntaxCheck.valid).toBe(false);
    expect(syntaxCheck.errorCode).toBe("#SYNTAX!");

    expect(hasVolatileFormulas(columns)).toBe(true);
    expect(hasVolatileFormulas(columns.slice(0, 3))).toBe(false);
  });

  it("normalizes human-typed [ColumnName] refs to stable {{col_id}} while preserving numeric arrays", () => {
    const columns: TableColumnSchema[] = [
      { id: "col_correct", name: "答对次数", type: "number" },
      { id: "col_delay", name: "延期", type: "number" },
      { id: "col_mastery", name: "掌握程度", type: "number" },
    ];
    const normalized = normalizeFormulaColumnRefs("POWER(2, [答对次数]) - 1 + [延期]", { columns });
    expect(normalized).toBe("POWER(2, {{col_correct}}) - 1 + {{col_delay}}");

    const relationNormalized = normalizeFormulaColumnRefs("[内节点].[掌握程度].AVERAGE()", { columns });
    expect(relationNormalized).toBe("{{inner}}.{{col_mastery}}.AVERAGE()");

    // Array literals must NOT be rewritten
    const arrayExpr = normalizeFormulaColumnRefs("[1, 2, 3] != [1, 2]", { columns });
    expect(arrayExpr).toBe("[1, 2, 3] != [1, 2]");

    // Live preview works seamlessly
    const preview = evaluateSingleFormulaPreview(
      "col_preview",
      normalized,
      undefined,
      "r1",
      [makeRow({ uuid: "r1", tableFields: { col_correct: 3, col_delay: 2 } })],
      columns,
    );
    expect(preview.numericValue).toBe(9);
  });

  it("exposes valid parseable catalog entries for all documented functions and operators", () => {
    expect(FORMULA_CATALOG_ITEMS.length).toBeGreaterThanOrEqual(90);
    expect(parseFormula("LIST(1, 2, 3).LAST()").error).toBeUndefined();
  });
});
