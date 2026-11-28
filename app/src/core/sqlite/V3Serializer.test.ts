// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  service: (id: string) => (target: { id?: string }) => {
    target.id = id;
    return target;
  },
}));
vi.mock("@/core/service/dataGenerateService/generateScreenshot", () => ({
  GenerateScreenshot: { generateSection: vi.fn(), generateFullView: vi.fn() },
}));
vi.mock("@/core/service/GlobalMenu", () => ({ onOpenFile: vi.fn() }));
vi.mock("@/core/render/canvas2d/renderer", () => ({
  Renderer: { FONT_SIZE: 24, NODE_PADDING: 10, NODE_ROUNDED_RADIUS: 8 },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    isEnableEntityCollision: false,
    sectionInitBorderStyle: "solid",
    textNodeInitBorderStyle: "solid",
    enableAutoEdgeWidth: false,
  },
}));
vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => new Vector(80, 32),
  getTextSize: () => new Vector(80, 32),
}));

import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { ArcEdge } from "@/core/stage/stageObject/association/ArcEdge";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { MultiTargetUndirectedEdge } from "@/core/stage/stageObject/association/MutiTargetUndirectedEdge";
import { SyncAssociation } from "@/core/stage/stageObject/association/SyncAssociation";
import { ConnectPoint } from "@/core/stage/stageObject/entity/ConnectPoint";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { PenStroke, PenStrokeSegment } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { UrlNode } from "@/core/stage/stageObject/entity/UrlNode";
import type { PrgTableData } from "@/types/table";
import {
  computeColumnCanonicalKey,
  extractPlainTextFromDetails,
  hydrateV3OpenResult,
  serializeProjectToV3Payload,
} from "./V3Serializer";
import type { V3DocumentOpenResult, V3PackedDocumentOpenResult } from "./DocClient";
import { StageManager } from "@/core/stage/stageManager/StageManager";

function makeStubProject() {
  const project: any = {
    docId: "doc-v3-roundtrip",
    stage: [] as any[],
    tags: ["tag-alpha"],
    references: { sections: { secA: ["a.prg"] }, files: ["b.prg"] },
    metadata: { version: "3.0.0", docId: "doc-v3-roundtrip" },
    table: {
      columns: [],
      views: [],
      activeViewId: "default-table-view",
    } as PrgTableData,
    readme: "# Test Board",
    attachments: new Map<string, Blob>(),
    v3AttachmentMetas: new Map(),
    getAttachmentMediaUrl: vi.fn(() => null),
    stageManager: {
      getAssociations: () => project.stage.filter((o: any) => "associationList" in o),
    },
    stageStyleManager: {
      currentStyle: { StageObjectBorder: Color.Black },
    },
    textRenderer: {
      measureMultiLineTextSize: () => new Vector(100, 30),
    },
    sectionMethods: {
      isEntityInSection: () => false,
    },
    sectionCollisionSolver: {
      solveOverlaps: vi.fn(),
    },
    effects: {
      addMoveShadow: vi.fn(),
      addEffect: vi.fn(),
    },
    syncAssociationManager: {
      syncFrom: vi.fn(),
    },
    sectionMoveDepth: 0,
  };
  return project;
}

describe("V3Serializer", () => {
  it("extracts plain text from PlateJS rich details without instantiating editor", () => {
    const details = [
      { type: "h1", children: [{ text: "标题" }] },
      { type: "p", children: [{ text: "第一段 " }, { text: "加粗", bold: true }] },
    ];
    expect(extractPlainTextFromDetails(details)).toBe("标题\n第一段 加粗");
    expect(extractPlainTextFromDetails([])).toBe("");
  });

  it("computes canonical_key for protected SR roles and custom columns", () => {
    expect(
      computeColumnCanonicalKey({
        id: "col_1",
        name: "下次复习时间",
        type: "formula",
        protectedRole: "nextDueDate",
      }),
    ).toBe("role:sr:nextDueDate");

    expect(
      computeColumnCanonicalKey({
        id: "col_2",
        name: "  Priority ",
        type: "select",
      }),
    ).toBe("auto:select:priority");
  });

  it("losslessly roundtrips entities, sections, edges, associations, and typed table cells", () => {
    const srcProject = makeStubProject();
    const table: PrgTableData = {
      columns: [
        { id: "col_note", name: "备注", type: "text", width: 200 },
        { id: "col_score", name: "权重", type: "number" },
        { id: "col_due", name: "截止", type: "date" },
        {
          id: "col_status",
          name: "状态",
          type: "select",
          options: [{ id: "opt_done", name: "完成", color: "green" }],
        },
        {
          id: "col_tags",
          name: "标签",
          type: "multi_select",
          options: [
            { id: "opt_a", name: "重点", color: "rose" },
            { id: "opt_b", name: "复习", color: "blue" },
          ],
        },
      ],
      views: [
        {
          id: "default-table-view",
          name: "原始表",
          type: "table",
          deletable: false,
          visibleColumnIds: ["name", "col_note", "col_score", "col_tags"],
          columnWidths: { name: 240 },
        },
      ],
      activeViewId: "default-table-view",
      systemColumnNames: { name: "标题" },
    };
    srcProject.table = table;

    const childText = new TextNode(srcProject, {
      uuid: "node-child",
      text: "子节点",
      details: [{ type: "p", children: [{ text: "富文本详情" }] }],
      collisionBox: new CollisionBox([new Rectangle(new Vector(40, 80), new Vector(100, 50))]),
      color: new Color(10, 20, 30, 1),
      fontScaleLevel: 2,
      borderStyle: "dashed",
      createdAt: 1700000100000,
      updatedAt: 1700000200000,
      tableFields: {
        col_note: "重要笔记",
        col_score: 42.5,
        col_due: "2026-11-27",
        col_status: "opt_done",
        col_tags: ["opt_a", "opt_b"],
      },
    });
    const childImage = new ImageNode(srcProject, {
      uuid: "img-inside",
      attachmentId: "att-1",
      scale: 0.75,
      isBackground: false,
      collisionBox: new CollisionBox([new Rectangle(new Vector(160, 80), new Vector(120, 90))]),
    });
    const section = new Section(srcProject, {
      uuid: "sec-1",
      text: "主分组",
      children: [childText, childImage],
      locked: true,
      borderStyle: "none",
      sizeAdjust: "manual",
      _collisionBoxNormal: new CollisionBox(new Rectangle(new Vector(0, 0), new Vector(360, 240)).getBoundingLines()),
      createdAt: 1700000000000,
      updatedAt: 1700000050000,
    });
    const urlNode = new UrlNode(srcProject, {
      uuid: "url-1",
      title: "Flux Docs",
      url: "https://example.com",
      collisionBox: new CollisionBox([new Rectangle(new Vector(500, 100), new Vector(300, 150))]),
    });
    const cp = new ConnectPoint(srcProject, {
      uuid: "cp-1",
      collisionBox: new CollisionBox([new Rectangle(new Vector(420, 100), new Vector(30, 30))]),
    });
    const stroke = new PenStroke(srcProject, {
      uuid: "pen-1",
      segments: [new PenStrokeSegment(new Vector(1, 2), 0.5), new PenStrokeSegment(new Vector(11, 22), 0.9)],
      width: 6,
      color: new Color(255, 0, 0, 1),
    });
    const lineEdge = new LineEdge(srcProject, {
      uuid: "edge-1",
      associationList: [childText, urlNode],
      text: "关联",
      lineType: "dashed",
      arrowType: "double",
      isBranchCollapsed: true,
    });
    const arcEdge = new ArcEdge(srcProject, {
      uuid: "edge-2",
      associationList: [urlNode, childText],
      text: "回边",
      offset: 45,
      textPosition: 0.3,
    });
    const hyper = new MultiTargetUndirectedEdge(srcProject, {
      uuid: "assoc-1",
      associationList: [childText, urlNode],
      text: "超边",
      renderType: "convex",
      padding: 16,
    });
    const sync = new SyncAssociation(srcProject, {
      uuid: "sync-1",
      keys: ["text", "details"],
      associationList: [childText, urlNode],
    });

    srcProject.stage = [section, childText, childImage, urlNode, cp, stroke, lineEdge, arcEdge, hyper, sync];

    const payload = serializeProjectToV3Payload(srcProject);
    expect(payload.entities).toHaveLength(6);
    expect(payload.edges).toHaveLength(2);
    expect(payload.associations).toHaveLength(2);
    expect(payload.tableColumns).toHaveLength(5);
    expect(payload.cellValues).toHaveLength(5);

    const imgRec = payload.entities.find((e) => e.uuid === "img-inside")!;
    const cpRec = payload.entities.find((e) => e.uuid === "cp-1")!;
    const penRec = payload.entities.find((e) => e.uuid === "pen-1")!;
    const textRec = payload.entities.find((e) => e.uuid === "node-child")!;
    expect(imgRec.isRow).toBe(false);
    expect(cpRec.isRow).toBe(false);
    expect(penRec.isRow).toBe(false);
    expect(textRec.isRow).toBe(true);
    expect(textRec.parentSectionUuid).toBe("sec-1");
    expect(textRec.detailsPlain).toBe("富文本详情");

    const multiCell = payload.cellValues.find((c) => c.colId === "col_tags")!;
    expect(multiCell.multiOptions).toEqual([
      { optionId: "opt_a", optionName: "重点" },
      { optionId: "opt_b", optionName: "复习" },
    ]);

    // 反向水合验证
    const dstProject = makeStubProject();
    const openResult: V3DocumentOpenResult = {
      ...payload,
      canonicalPath: "/tmp/board.prg",
      revision: 3,
      attachments: [{ id: "att-1", mime: "image/png", width: 120, height: 90, sizeBytes: 1234, hasThumb: true }],
    };
    const hydrated = hydrateV3OpenResult(dstProject, openResult);
    expect(hydrated.stage).toHaveLength(10);
    expect(hydrated.metadata.version).toBe("3.0.0");
    expect(hydrated.metadata.docId).toBe("doc-v3-roundtrip");
    expect(hydrated.table.systemColumnNames?.name).toBe("标题");

    const restoredSection = hydrated.stage[0] as Section;
    const restoredText = hydrated.stage[1] as TextNode;
    const restoredEdge = hydrated.stage[6] as LineEdge;
    const restoredArc = hydrated.stage[7] as ArcEdge;
    expect(restoredSection).toBeInstanceOf(Section);
    expect(restoredSection.locked).toBe(true);
    expect(restoredSection.children.map((c) => c.uuid)).toEqual(["node-child", "img-inside"]);
    expect(restoredText.text).toBe("子节点");
    expect(restoredText.tableFields).toEqual({
      col_note: "重要笔记",
      col_score: 42.5,
      col_due: "2026-11-27",
      col_status: "opt_done",
      col_tags: ["opt_a", "opt_b"],
    });
    expect(restoredEdge.lineType).toBe("dashed");
    expect(restoredEdge.isBranchCollapsed).toBe(true);
    expect(restoredArc.offset).toBe(45);
  });

  it("hydrates packed 2000-node + 1999-edge + 100-section + 6000-cell wire payload fast and accurately", () => {
    const packed: V3PackedDocumentOpenResult = {
      packed: true,
      canonicalPath: "/tmp/large-2000.prg",
      docId: "doc-packed-2000",
      formatVersion: "3.0.0",
      revision: 1,
      tags: ["t1"],
      references: { sections: {}, files: [] },
      tableMeta: { activeViewId: "default-table-view" },
      tableColumns: [
        ["col_note", "auto:text:note", "备注", "text", 0, { width: 200 }],
        ["col_score", "auto:number:score", "权重", "number", 1, 0],
        ["col_tags", "auto:multi_select:tags", "标签", "multi_select", 2, 0],
      ],
      tableViews: [["default-table-view", "原始表", "table", 0, 0, { visibleColumnIds: ["name", "col_note"] }]],
      entities: Array.from({ length: 2000 }, (_, i) => [
        `n-${i}`,
        i < 100 ? 1 : 0,
        i >= 100 ? `n-${i % 100}` : 0,
        `节点标题 #${i}`,
        (i % 40) * 180,
        Math.floor(i / 40) * 100,
        160,
        64,
        1700000000000 + i,
        1700000001000 + i,
        i,
        i % 4 === 0 ? { color: [10, 20, 30, 1], borderStyle: "solid" } : 0,
        i % 5 === 0 ? [{ type: "p", children: [{ text: "详情" }] }] : 0,
      ]),
      edges: Array.from({ length: 1999 }, (_, i) => [
        `e-${i}`,
        0,
        `n-${i}`,
        `n-${i + 1}`,
        i % 10 === 0 ? `连线 ${i}` : "",
        2000 + i,
        0,
      ]),
      associations: [],
      cellValues: Array.from({ length: 2000 }, (_, i) => [
        [`n-${i}`, "col_note", 0, `备注 ${i}`],
        [`n-${i}`, "col_score", 1, i * 0.5],
        [`n-${i}`, "col_tags", 4, ["o1"]],
      ]).flat() as V3PackedDocumentOpenResult["cellValues"],
      attachments: [],
      needsFormulaRecompute: false,
    };

    // 预热 V8 JIT 后统计稳态耗时
    const warmupProject = makeStubProject();
    warmupProject.stageManager = new StageManager(warmupProject);
    hydrateV3OpenResult(warmupProject, packed);
    warmupProject.stageManager.updateReferences({ skipIndexRebuild: true, skipSectionAdjust: true });

    const project = makeStubProject();
    project.stageManager = new StageManager(project);
    const t0 = performance.now();
    const hydrated = hydrateV3OpenResult(project, packed);
    const tHydrate = performance.now() - t0;
    project.stage = hydrated.stage;
    const t1 = performance.now();
    project.stageManager.updateReferences({ skipIndexRebuild: true, skipSectionAdjust: true });
    const tIndex = performance.now() - t1;
    const t2 = performance.now();
    const bounds = project.stageManager.getBoundingRectangle();
    const tBounds = performance.now() - t2;

    console.log(
      `[perf JS 2000-node+1999-edge+100-sec+6000-cell] hydrate=${tHydrate.toFixed(2)}ms, updateRefs+RTree=${tIndex.toFixed(2)}ms, bounds=${tBounds.toFixed(3)}ms, total=${(tHydrate + tIndex + tBounds).toFixed(2)}ms`,
    );

    expect(hydrated.stage).toHaveLength(3999);
    expect(project.stageManager.getSections()).toHaveLength(100);
    expect((hydrated.stage[0] as Section).children).toHaveLength(19);
    expect((hydrated.stage[100] as TextNode).tableFields).toEqual({
      col_note: "备注 100",
      col_score: 50,
      col_tags: ["o1"],
    });
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    // 独立单跑实测 ~21ms；留足并行测试 CPU 竞争余量防止偶发抖动
    expect(tHydrate + tIndex).toBeLessThan(350);
  });
});
