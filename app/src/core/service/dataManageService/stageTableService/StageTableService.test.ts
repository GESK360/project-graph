// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Vector } from "@graphif/data-structures";
import { deserialize, serialize } from "@graphif/serializer";
import { Line, Rectangle } from "@graphif/shapes";
import { Decoder, Encoder } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: "saved", Stashed: "stashed", Unsaved: "unsaved" },
  service: (id: string) => (target: { id?: string }) => {
    target.id = id;
    return target;
  },
}));
vi.mock("@/core/render/canvas2d/renderer", () => ({
  Renderer: { FONT_SIZE: 24, NODE_PADDING: 10, NODE_ROUNDED_RADIUS: 8 },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    watch: vi.fn(() => vi.fn()),
    historyManagerMode: "timeEfficient",
    historySize: 50,
    showDebug: false,
    isEnableEntityCollision: false,
    sectionInitBorderStyle: "solid",
    textNodeInitBorderStyle: "solid",
    defaultEdgeLineType: "solid",
    defaultEdgeArrowType: "default",
    enableAutoEdgeWidth: false,
    hideSectionContentsWhenBigTitleActive: false,
    sectionBitTitleRenderType: "none",
    autoLayoutWhenSectionCollapseToggle: false,
    stageTableAutoFocusCanvasOnSelect: true,
  },
}));
vi.mock("@/core/service/feedbackService/SoundService", () => ({
  SoundService: { play: { entityJumpSoundFile: vi.fn() } },
}));
vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => new Vector(60, 30),
  getTextSize: () => new Vector(60, 30),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  }),
}));

// Ensure serializable classes are registered in @graphif/serializer
import "@/core/stage/stageObject/collisionBox/collisionBox";
import "@/core/stage/stageObject/entity/TextNode";
import "@/core/stage/stageObject/entity/Section";
import "@/core/stage/stageObject/entity/ConnectPoint";
import "@/core/stage/stageObject/entity/ImageNode";
import "@/core/stage/stageObject/entity/PenStroke";
import "@/core/stage/stageObject/association/LineEdge";
import "@/core/stage/stageObject/association/ArcEdge";
import "@/core/stage/stageObject/association/MutiTargetUndirectedEdge";
import "@/core/stage/stageObject/association/SyncAssociation";

import { LATEST_PROJECT_VERSION, parseProjectFile } from "@/core/ProjectFile";
import { DocCommandBus } from "@/core/sqlite/DocCommandBus";
import { ProjectUpgrader } from "@/core/stage/ProjectUpgrader";
import { Camera } from "@/core/stage/Camera";
import { HistoryManager } from "@/core/stage/stageManager/StageHistoryManager";
import { StageManager } from "@/core/stage/stageManager/StageManager";
import { GraphMethods } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import { SectionMethods } from "@/core/stage/stageManager/basicMethods/SectionMethods";
import { DeleteManager } from "@/core/stage/stageManager/concreteMethods/StageDeleteManager";
import { NodeConnector } from "@/core/stage/stageManager/concreteMethods/StageNodeConnector";
import { SectionInOutManager } from "@/core/stage/stageManager/concreteMethods/StageSectionInOutManager";
import { StageSyncAssociationManager } from "@/core/stage/stageManager/concreteMethods/StageSyncAssociationManager";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { ArcEdge } from "@/core/stage/stageObject/association/ArcEdge";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { ConnectPoint } from "@/core/stage/stageObject/entity/ConnectPoint";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { PenStroke, PenStrokeSegment } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import {
  applyTableFiltersAndSort,
  collectColumnFilterBuckets,
  countActiveFilterConditions,
  createDefaultTableData,
  getColumnFilterKind,
  getDefaultFilterOperator,
  getFilterOperatorsForKind,
  normalizeTableData,
  type PrgTableData,
} from "@/types/table";
import { StageTableService } from "./StageTableService";

// Make sure Vector, Color, Rectangle, Line are registered for @graphif/serializer roundtrips
void new Vector(0, 0);
void new Color(0, 0, 0, 0);
void new Rectangle(new Vector(0, 0), new Vector(10, 10));
void new Line(new Vector(0, 0), new Vector(10, 10));

function createTestHarness() {
  const services = new Map<string, unknown>();
  const project: any = {
    stage: [],
    sectionMoveDepth: 0,
    tags: [],
    references: { sections: {}, files: [] },
    attachments: new Map<string, Blob>(),
    addAttachment: (data: Blob, id: string = crypto.randomUUID()) => {
      project.attachments.set(id, data);
      return id;
    },
    table: createDefaultTableData(),
    projectState: "saved",
    isSqliteV3: false,
    v3DocId: null,
    v3Revision: 0,
    stageRevision: 0,
    bumpStageRevision: () => {
      project.stageRevision++;
    },
    renderer: { frameIndex: 0, w: 1200, h: 800 },
    effects: { addEffect: vi.fn(), addMoveShadow: vi.fn() },
    sectionCollisionSolver: { solveOverlaps: vi.fn() },
    stageStyleManager: { currentStyle: { CollideBoxSelected: Color.Green } },
    emit: vi.fn(),
    loop: vi.fn(),
    getService: (id: string) => services.get(id),
  };

  project.docCommandBus = new DocCommandBus(project);

  const register = <T>(id: string, instance: T): T => {
    services.set(id, instance);
    project[id] = instance;
    return instance;
  };

  register("sectionMethods", new SectionMethods(project));
  register("graphMethods", new GraphMethods(project));
  register("stageManager", new StageManager(project));
  register("camera", new Camera(project));
  register("syncAssociationManager", new StageSyncAssociationManager(project));
  register("sectionInOutManager", new SectionInOutManager(project));
  register("deleteManager", new DeleteManager(project));
  register("nodeConnector", new NodeConnector(project));
  register("stageTable", new StageTableService(project));
  register("historyManager", new HistoryManager(project));

  return project as {
    stage: any[];
    table: PrgTableData;
    stageManager: StageManager;
    stageTable: StageTableService;
    historyManager: HistoryManager;
    nodeConnector: NodeConnector;
    sectionInOutManager: SectionInOutManager;
    camera: Camera;
  };
}

describe("StageTableService & .prg v2.8.0", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("upgrades 2.7.0 stage data (including nested Section children) using file timestamps and roundtrips table.msgpack", async () => {
    const legacyStage = [
      {
        _: "Section",
        uuid: "sec-1",
        text: "Outer",
        children: [
          {
            _: "TextNode",
            uuid: "node-nested",
            text: "Nested",
            collisionBox: {
              _: "CollisionBox",
              shapes: [
                {
                  _: "Rectangle",
                  location: { _: "Vector", x: 20, y: 80 },
                  size: { _: "Vector", x: 80, y: 50 },
                },
              ],
            },
          },
        ],
        collisionBox: {
          _: "CollisionBox",
          shapes: [
            {
              _: "Rectangle",
              location: { _: "Vector", x: 0, y: 0 },
              size: { _: "Vector", x: 200, y: 200 },
            },
          ],
        },
      },
      { $: "/0/children/0" },
    ];

    const [upgradedStage, upgradedMetadata] = ProjectUpgrader.upgradeNAnyToNLatest(
      legacyStage,
      { version: "2.7.0", docId: "doc-abc" },
      { defaultCreatedAt: 1700000100000, defaultUpdatedAt: 1700000200000 },
    );

    expect(upgradedMetadata.version).toBe(LATEST_PROJECT_VERSION);
    expect(upgradedMetadata.version).toBe("3.0.0");
    expect(upgradedStage[0].createdAt).toBe(1700000100000);
    expect(upgradedStage[0].updatedAt).toBe(1700000200000);
    expect(upgradedStage[0].children[0].createdAt).toBe(1700000100000);
    expect(upgradedStage[0].children[0].updatedAt).toBe(1700000200000);

    const tableSchema: PrgTableData = {
      columns: [
        { id: "col_text1", name: "备注", type: "text" },
        { id: "col_num1", name: "权重", type: "number" },
        { id: "col_date1", name: "截止日期", type: "date" },
        {
          id: "col_sel1",
          name: "状态",
          type: "select",
          options: [{ id: "opt_todo", name: "待办", color: "#3b82f6" }],
        },
        {
          id: "col_msel1",
          name: "标签",
          type: "multi_select",
          options: [{ id: "opt_p0", name: "P0", color: "#ef4444" }],
        },
        { id: "col_fmt1", name: "子节点数", type: "formula", formula: "count(children)" },
      ],
      views: [
        {
          id: "default-table-view",
          name: "原始表",
          type: "table",
          deletable: false,
          visibleColumnIds: ["name", "createdAt", "parents", "col_num1"],
          columnWidths: { name: 260 },
        },
      ],
      activeViewId: "default-table-view",
    };

    const encoder = new Encoder();
    const uwriter = new Uint8ArrayWriter();
    const writer = new ZipWriter(uwriter, { level: 0 });
    await writer.add("stage.msgpack", new Uint8ArrayReader(encoder.encode(upgradedStage)), { level: 0 });
    await writer.add("tags.msgpack", new Uint8ArrayReader(encoder.encode([])), { level: 0 });
    await writer.add("reference.msgpack", new Uint8ArrayReader(encoder.encode({ sections: {}, files: [] })), {
      level: 0,
    });
    await writer.add("metadata.msgpack", new Uint8ArrayReader(encoder.encode(upgradedMetadata)), { level: 0 });
    await writer.add("table.msgpack", new Uint8ArrayReader(encoder.encode(tableSchema)), { level: 0 });
    await writer.close();

    const parsed = await parseProjectFile(await uwriter.getData(), new Decoder(), new Map());
    expect(parsed.table.columns).toHaveLength(6);
    expect(parsed.table.views[0].deletable).toBe(false);
    expect(parsed.table.views[0].visibleColumnIds).toEqual(["name", "createdAt", "parents", "col_num1"]);
  });

  it("filters only Node and Section rows, and computes 1-hop parent/child (solid, dashed, arc) & outer/inner relations", () => {
    const project = createTestHarness();

    const nodeA = new TextNode(project as never, {
      uuid: "a",
      text: "A",
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(80, 40))]),
    });
    const nodeB = new TextNode(project as never, {
      uuid: "b",
      text: "B",
      collisionBox: new CollisionBox([new Rectangle(new Vector(200, 0), new Vector(80, 40))]),
    });
    const nodeC = new TextNode(project as never, {
      uuid: "c",
      text: "C",
      collisionBox: new CollisionBox([new Rectangle(new Vector(400, 0), new Vector(80, 40))]),
    });

    const secMid = new Section(project as never, { uuid: "sec-mid", text: "Mid", children: [nodeC] });
    const secOuter = new Section(project as never, { uuid: "sec-outer", text: "Outer", children: [secMid] });

    // Non-row objects that must be excluded
    const cp = new ConnectPoint(project as never, { uuid: "cp-1" });
    const stroke = new PenStroke(project as never, {
      uuid: "stroke-1",
      segments: [new PenStrokeSegment(new Vector(0, 0), 1), new PenStrokeSegment(new Vector(10, 10), 1)],
    });
    const bgImg = new ImageNode(project as never, { uuid: "bg-img", isBackground: true });
    const normalImg = new ImageNode(project as never, { uuid: "fg-img", isBackground: false });

    const dashedEdgeAB = new LineEdge(project as never, {
      uuid: "e-ab",
      associationList: [nodeA, nodeB],
      lineType: "dashed",
    });
    const arcEdgeBC = new ArcEdge(project as never, {
      uuid: "e-bc",
      associationList: [nodeB, nodeC],
      offset: 20,
    });
    const selfLoopB = new LineEdge(project as never, {
      uuid: "e-bb",
      associationList: [nodeB, nodeB],
    });

    project.stage.push(
      nodeA,
      nodeB,
      nodeC,
      secMid,
      secOuter,
      cp,
      stroke,
      bgImg,
      normalImg,
      dashedEdgeAB,
      arcEdgeBC,
      selfLoopB,
    );
    project.stageManager.updateReferences();
    project.stageTable.resetAfterStageRestore();

    const rows = project.stageTable.getRows();
    // Standalone ImageNode (normalImg) and background ImageNode (bgImg) must NOT be counted as standalone rows
    expect(rows.map((r) => r.uuid)).toEqual(["a", "b", "c", "sec-mid", "sec-outer"]);

    const rowB = rows.find((r) => r.uuid === "b")!;
    expect(rowB.parents.map((p) => p.uuid)).toEqual(["a"]);
    expect(rowB.children.map((c) => c.uuid)).toEqual(["c"]);

    // 1-hop Section containment: secOuter wraps secMid wraps nodeC
    const rowMid = rows.find((r) => r.uuid === "sec-mid")!;
    expect(rowMid.outer?.uuid).toBe("sec-outer");
    expect(rowMid.inner.map((i) => i.uuid)).toEqual(["c"]);

    const rowOuter = rows.find((r) => r.uuid === "sec-outer")!;
    expect(rowOuter.outer).toBeNull();
    expect(rowOuter.inner.map((i) => i.uuid)).toEqual(["sec-mid"]);
  });

  it("updates updatedAt ONLY on row data/relation changes (not position moves) and restores timestamps on undo", () => {
    const project = createTestHarness();

    const t0 = 1700000000000;
    const nodeA = new TextNode(project as never, {
      uuid: "a",
      text: "Alpha",
      createdAt: t0,
      updatedAt: t0,
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(80, 40))]),
    });
    const nodeB = new TextNode(project as never, {
      uuid: "b",
      text: "Beta",
      createdAt: t0,
      updatedAt: t0,
      collisionBox: new CollisionBox([new Rectangle(new Vector(200, 0), new Vector(80, 40))]),
    });
    const sec = new Section(project as never, {
      uuid: "sec",
      text: "Group",
      children: [nodeA],
      createdAt: t0,
      updatedAt: t0,
    });

    project.stage.push(nodeA, nodeB, sec);
    project.stageManager.updateReferences();
    project.historyManager.clearHistory();

    // 1. Pure position move on canvas must NOT bump updatedAt on nodeA or outer Section
    vi.spyOn(Date, "now").mockReturnValue(t0 + 5000);
    nodeA.move(new Vector(120, 80));
    project.historyManager.recordStep();
    expect(nodeA.updatedAt).toBe(t0);
    expect(sec.updatedAt).toBe(t0);

    // 2. Editing primary text bumps only nodeA.updatedAt
    vi.spyOn(Date, "now").mockReturnValue(t0 + 10000);
    project.stageTable.updateRowPrimaryText("a", "Alpha Renamed");
    expect(nodeA.updatedAt).toBe(t0 + 10000);
    expect(nodeB.updatedAt).toBe(t0);
    expect(sec.updatedAt).toBe(t0);

    // 3. Connecting A -> B bumps BOTH A (children changed) and B (parents changed)
    vi.spyOn(Date, "now").mockReturnValue(t0 + 20000);
    project.stageTable.setRowChildren("a", ["b"]);
    expect(nodeA.updatedAt).toBe(t0 + 20000);
    expect(nodeB.updatedAt).toBe(t0 + 20000);

    // 4. Preserves full float64 precision in tableFields and supports undo
    vi.spyOn(Date, "now").mockReturnValue(t0 + 30000);
    project.stageTable.updateRowCustomField("b", "col_pi", 3.1415926535);
    const serialized = serialize(project.stage);
    const restored = deserialize(serialized, project) as any[];
    const restoredB = restored.find((item) => item.uuid === "b");
    expect(restoredB.tableFields.col_pi).toBe(3.1415926535);

    // Undo reverts B's updatedAt back to t0 + 20000
    project.historyManager.undo();
    const afterUndoB = project.stageManager.get("b") as TextNode;
    expect(afterUndoB.updatedAt).toBe(t0 + 20000);
    expect(afterUndoB.tableFields.col_pi).toBeUndefined();
  });

  it("auto-promotes TextNode <-> Section losslessly (preserving uuid, createdAt, fields, edges) and blocks cycles", () => {
    const project = createTestHarness();
    const t0 = 1700000000000;

    const nodeRoot = new TextNode(project as never, {
      uuid: "root",
      text: "Root",
      createdAt: t0,
      updatedAt: t0,
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(80, 40))]),
    });
    const nodeBoxCandidate = new TextNode(project as never, {
      uuid: "candidate",
      text: "Will Become Section",
      createdAt: t0,
      updatedAt: t0,
      tableFields: { col_note: "keep-me" },
      collisionBox: new CollisionBox([new Rectangle(new Vector(200, 0), new Vector(100, 50))]),
    });
    const nodeLeaf = new TextNode(project as never, {
      uuid: "leaf",
      text: "Far Away Leaf",
      createdAt: t0,
      updatedAt: t0,
      collisionBox: new CollisionBox([new Rectangle(new Vector(3000, 3000), new Vector(80, 40))]),
    });

    project.stage.push(nodeRoot, nodeBoxCandidate, nodeLeaf);
    project.nodeConnector.connectConnectableEntity(nodeRoot, nodeBoxCandidate);
    project.stageManager.updateReferences();
    project.historyManager.clearHistory();

    // Setting leaf's outer to TextNode "candidate" promotes "candidate" to Section with same uuid
    vi.spyOn(Date, "now").mockReturnValue(t0 + 15000);
    const ok = project.stageTable.setRowOuter("leaf", "candidate");
    expect(ok).toBe(true);

    const promoted = project.stageManager.get("candidate")!;
    expect(promoted).toBeInstanceOf(Section);
    expect(promoted.uuid).toBe("candidate");
    expect((promoted as Section).createdAt).toBe(t0);
    expect((promoted as Section).tableFields).toEqual({ col_note: "keep-me" });
    expect(project.stageManager.getEdges()[0].target).toBe(promoted);

    // Leaf was relocated inside promoted Section instead of stretching Section across 3000px
    const promotedRect = promoted.collisionBox.getRectangle();
    expect(promotedRect.size.x).toBeLessThan(600);

    // Prevent cyclic containment: setting promoted's outer to its own inner child "leaf" (if leaf becomes Section) or self
    expect(project.stageTable.setRowOuter("candidate", "candidate")).toBe(false);

    // Clearing leaf's outer demotes empty Section "candidate" back to TextNode with same uuid & fields
    const cleared = project.stageTable.setRowOuter("leaf", null);
    expect(cleared).toBe(true);
    const demoted = project.stageManager.get("candidate")!;
    expect(demoted).toBeInstanceOf(TextNode);
    expect(demoted.uuid).toBe("candidate");
    expect((demoted as TextNode).createdAt).toBe(t0);
    expect((demoted as TextNode).tableFields).toEqual({ col_note: "keep-me" });
    expect(project.stageManager.getEdges()[0].target).toBe(demoted);
  });

  it("centers jumped node in the left unoccluded canvas viewport when table panel is open", () => {
    const project = createTestHarness();
    const node = new TextNode(project as never, {
      uuid: "target",
      text: "Target",
      collisionBox: new CollisionBox([new Rectangle(new Vector(100, 200), new Vector(80, 40))]),
    });
    project.stage.push(node);
    project.stageManager.updateReferences();
    project.camera.currentScale = 2;

    const bombSpy = vi.spyOn(project.camera, "bombMove");
    // node location = (100, 200), auto-adjusted size = (80, 50) => center = (140, 225)
    // panelWidth = 480, scale = 2 => camera X = 140 + 480 / (2 * 2) = 260
    project.stageTable.focusRowOnCanvas("target", 480);

    expect(bombSpy).toHaveBeenCalledOnce();
    const targetCamPos = bombSpy.mock.calls[0][0];
    expect(targetCamPos.x).toBeCloseTo(260);
    expect(targetCamPos.y).toBeCloseTo(225);
    expect(node.isSelected).toBe(true);
  });

  it("syncs system Images property bidirectionally between canvas Section/TextNode and table (even when Images column is hidden)", async () => {
    const project = createTestHarness();
    const t0 = 1700000000000;

    const nodeCell = new TextNode(project as never, {
      uuid: "cell-node",
      text: "细胞",
      createdAt: t0,
      updatedAt: t0,
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(80, 40))]),
    });
    const standaloneImg = new ImageNode(project as never, {
      uuid: "canvas-img-1",
      attachmentId: "att-1",
      isBackground: false,
      collisionBox: new CollisionBox([new Rectangle(new Vector(300, 0), new Vector(100, 80))]),
    });

    project.stage.push(nodeCell, standaloneImg);
    project.stageManager.updateReferences();
    project.historyManager.clearHistory();

    // 1. Standalone image on canvas is NOT a row; "images" column is hidden by default but data still exists
    expect(project.stageTable.isColumnVisible("images")).toBe(false);
    expect(project.stageTable.getRows()).toHaveLength(1);
    expect(project.stageTable.getRows()[0].images).toEqual([]);

    // 2. Adding two images from table to TextNode upgrades it to same-uuid Section and creates canvas ImageNodes
    vi.spyOn(Date, "now").mockReturnValue(t0 + 5000);
    const blob1 = new Blob(["img-bytes-1"], { type: "image/png" });
    const blob2 = new Blob(["img-bytes-2"], { type: "image/png" });
    const added = await project.stageTable.addRowImages("cell-node", [blob1, blob2]);
    expect(added).toBe(true);

    const promoted = project.stageManager.get("cell-node");
    expect(promoted).toBeInstanceOf(Section);
    expect((promoted as Section).updatedAt).toBe(t0 + 5000);

    let row = project.stageTable.getRows().find((r) => r.uuid === "cell-node")!;
    expect(row.images).toHaveLength(2);
    // Child ImageNodes must NOT leak into inner node relation list
    expect(row.inner).toEqual([]);

    // 3. Moving standaloneImg on canvas into the Section also adds it to the row's images list
    vi.spyOn(Date, "now").mockReturnValue(t0 + 10000);
    project.sectionInOutManager.goInSection([standaloneImg], promoted as Section);
    project.historyManager.recordStep();

    row = project.stageTable.getRows().find((r) => r.uuid === "cell-node")!;
    expect(row.images).toHaveLength(3);
    expect(row.images.some((i) => i.uuid === "canvas-img-1" && i.attachmentId === "att-1")).toBe(true);
    expect((promoted as Section).updatedAt).toBe(t0 + 10000);

    // 4. Removing all 3 images from the table deletes the ImageNodes from canvas and demotes empty Section back to TextNode
    for (const imgItem of [...row.images]) {
      expect(project.stageTable.removeRowImage("cell-node", imgItem.uuid)).toBe(true);
    }
    expect(project.stageManager.getImageNodes()).toHaveLength(0);
    const demoted = project.stageManager.get("cell-node");
    expect(demoted).toBeInstanceOf(TextNode);
    expect((demoted as TextNode).text).toBe("细胞");
    expect(project.stageTable.getRows()[0].images).toEqual([]);
  });

  it("supports custom columns (text, number, date, select, multi_select), option creation, field editing, and reordering with name locked", () => {
    const project = createTestHarness();
    const nodeA = new TextNode(project as never, { uuid: "row-1", text: "Node 1" });
    const nodeB = new TextNode(project as never, { uuid: "row-2", text: "Node 2" });
    project.stage.push(nodeA, nodeB);
    project.stageManager.updateReferences();
    project.historyManager.clearHistory();

    project.stageTable.setColumnVisible("images", true);
    project.stageTable.setColumnVisible("createdAt", true);

    const colText = project.stageTable.addCustomColumn({ name: "备注", type: "text" });
    const colNum = project.stageTable.addCustomColumn({ name: "权重", type: "number" });
    const colDate = project.stageTable.addCustomColumn({ name: "截止日", type: "date" });
    const colMulti = project.stageTable.addCustomColumn({ name: "标签", type: "multi_select" });

    expect(project.stageTable.getVisibleColumnIds()).toEqual([
      "name",
      "images",
      "createdAt",
      colText.id,
      colNum.id,
      colDate.id,
      colMulti.id,
    ]);

    // "name" cannot be moved, nor can any column move before "name"
    expect(project.stageTable.reorderColumn("name", "createdAt", "after")).toBe(false);
    expect(project.stageTable.reorderColumn(colMulti.id, "name", "before")).toBe(true);
    expect(project.stageTable.getVisibleColumnIds()[0]).toBe("name");
    expect(project.stageTable.getVisibleColumnIds()[1]).toBe(colMulti.id);

    // Create options on multi_select and reuse existing option on second row
    const optCell = project.stageTable.createOrGetSelectOption(colMulti.id, "细胞")!;
    const optSeq = project.stageTable.createOrGetSelectOption(colMulti.id, "数列")!;
    const optDup = project.stageTable.createOrGetSelectOption(colMulti.id, "细胞")!;
    expect(optDup.id).toBe(optCell.id);
    expect(optCell.id.startsWith("opt_")).toBe(true);

    project.stageTable.updateRowCustomField("row-1", colMulti.id, [optCell.id, optSeq.id]);
    project.stageTable.updateRowCustomField("row-2", colMulti.id, [optCell.id]);
    project.stageTable.updateRowCustomField("row-1", colText.id, "重点");
    project.stageTable.updateRowCustomField("row-1", colNum.id, 42.5);
    project.stageTable.updateRowCustomField("row-1", colDate.id, "2026-11-25");

    // Modify field name & convert multi_select -> select without mutating history snapshot in place
    const snapBeforeConvert = nodeA.tableFields;
    project.stageTable.updateColumn(colMulti.id, { name: "主分类", type: "select" });
    expect(project.stageTable.getColumnSchema(colMulti.id)?.name).toBe("主分类");
    expect(project.stageTable.getColumnSchema(colMulti.id)?.type).toBe("select");
    expect(nodeA.tableFields).not.toBe(snapBeforeConvert);
    expect(snapBeforeConvert[colMulti.id]).toEqual([optCell.id, optSeq.id]);
    expect(nodeA.tableFields[colMulti.id]).toBe(optCell.id);
  });

  it("supports left/right column insertion, duplicating custom columns with row data, freezing columns, auto-fit width, and column groups", () => {
    const project = createTestHarness();
    const nodeA = new TextNode(project as never, {
      uuid: "r1",
      text: "这是一个用于测试自适应列宽的超长节点名称示例",
    });
    const nodeB = new TextNode(project as never, { uuid: "r2", text: "短名" });
    project.stage.push(nodeA, nodeB);
    project.stageManager.updateReferences();
    project.historyManager.clearHistory();

    project.stageTable.setColumnVisible("images", true);
    project.stageTable.setColumnVisible("createdAt", true);

    // 1. Create column group ("基础信息") spanning ["name", "images"]
    const basicGroup = project.stageTable.createColumnGroup("基础信息", ["name", "images"])!;
    expect(basicGroup.name).toBe("基础信息");
    expect(basicGroup.columnIds).toEqual(["name", "images"]);

    // 2. Insert a custom column to the LEFT of "images" -> placed between "name" and "images" AND inherits "基础信息" group
    const colSource = project.stageTable.insertCustomColumn({
      name: "出处",
      type: "select",
      targetColumnId: "images",
      side: "left",
    });
    expect(project.stageTable.getVisibleColumnIds()).toEqual(["name", colSource.id, "images", "createdAt"]);
    expect(project.stageTable.getColumnGroups()[0].columnIds).toEqual(["name", colSource.id, "images"]);

    // Populate option & row values on colSource
    const optBook = project.stageTable.createOrGetSelectOption(colSource.id, "教材")!;
    project.stageTable.updateRowCustomField("r1", colSource.id, optBook.id);
    const beforeDupFieldsRef = nodeA.tableFields;

    // 3. Duplicate custom column -> copies schema, options, row cell values immutably, and joins same group right next to it
    expect(project.stageTable.duplicateCustomColumn("images")).toBeNull(); // system column cannot be duplicated
    const duplicated = project.stageTable.duplicateCustomColumn(colSource.id, "副本")!;
    expect(duplicated.name).toBe("出处 副本");
    expect(duplicated.type).toBe("select");
    expect(duplicated.options).toEqual([{ id: optBook.id, name: "教材", color: optBook.color }]);
    expect(nodeA.tableFields).not.toBe(beforeDupFieldsRef);
    expect(nodeA.tableFields[duplicated.id]).toBe(optBook.id);
    expect(project.stageTable.getVisibleColumnIds()).toEqual([
      "name",
      colSource.id,
      duplicated.id,
      "images",
      "createdAt",
    ]);
    expect(project.stageTable.getColumnGroups()[0].columnIds).toContain(duplicated.id);

    // 4. Freeze up to "images" -> toggle on, then hiding/deleting frozen column shifts or toggles cleanly
    expect(project.stageTable.toggleFreezeUpToColumn("images")).toBe("images");
    expect(project.stageTable.getFrozenColumnId()).toBe("images");
    expect(project.stageTable.toggleFreezeUpToColumn("images")).toBeNull();
    expect(project.stageTable.toggleFreezeUpToColumn(duplicated.id)).toBe(duplicated.id);
    project.stageTable.deleteCustomColumn(duplicated.id);
    // Deleting the frozen boundary column preserves freeze up to its left neighbor (colSource)
    expect(project.stageTable.getFrozenColumnId()).toBe(colSource.id);

    // 5. Auto-fit column width expands "name" width beyond default 220px for long text
    const fittedWidth = project.stageTable.autoFitColumnWidth("name", "名称");
    expect(fittedWidth).toBeGreaterThan(260);
    expect(project.stageTable.getActiveView().columnWidths?.name).toBe(fittedWidth);

    // 6. Rename & dissolve column group
    expect(project.stageTable.renameColumnGroup(basicGroup.id, "核心资料")).toBe(true);
    expect(project.stageTable.getColumnGroups()[0].name).toBe("核心资料");
    expect(project.stageTable.dissolveColumnGroup(basicGroup.id)).toBe(true);
    expect(project.stageTable.getColumnGroups()).toEqual([]);
  });

  it("syncs single and multi-row selection bidirectionally between table and canvas", async () => {
    const project = createTestHarness();
    const nodeA = new TextNode(project as never, {
      uuid: "sync-a",
      text: "节点 A",
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(100, 50))]),
    });
    const nodeB = new TextNode(project as never, {
      uuid: "sync-b",
      text: "节点 B",
      collisionBox: new CollisionBox([new Rectangle(new Vector(1500, 900), new Vector(100, 50))]),
    });
    const nodeC = new TextNode(project as never, {
      uuid: "sync-c",
      text: "节点 C",
      collisionBox: new CollisionBox([new Rectangle(new Vector(300, 100), new Vector(100, 50))]),
    });
    project.stage.push(nodeA, nodeB, nodeC);

    const resetByRectangle = vi.fn();
    Object.assign(project.camera, { resetByRectangle });
    Object.assign((project as unknown as { renderer: Record<string, unknown> }).renderer, {
      getCoverWorldRectangle: () => new Rectangle(new Vector(-200, -200), new Vector(800, 600)),
    });

    const receivedCanvasSelections: string[][] = [];
    const unsub = project.stageTable.subscribeSelection((uuids) => receivedCanvasSelections.push(uuids));

    // 1. Table -> Canvas multi-row selection selects corresponding nodes and fits camera when spanning beyond viewport
    project.stageTable.selectRowsOnCanvas(["sync-a", "sync-b"]);
    await Promise.resolve();
    expect(nodeA.isSelected).toBe(true);
    expect(nodeB.isSelected).toBe(true);
    expect(nodeC.isSelected).toBe(false);
    expect(resetByRectangle).toHaveBeenCalledTimes(1);
    // Table-initiated selection must not echo back into canvas->table listeners
    expect(receivedCanvasSelections).toEqual([]);

    // 2. Canvas -> Table multi-node selection coalesces into a single microtask notification
    nodeA.isSelected = false;
    nodeB.isSelected = true;
    nodeC.isSelected = true;
    await Promise.resolve();
    expect(receivedCanvasSelections).toEqual([["sync-b", "sync-c"]]);

    // 3. Clearing selection on canvas notifies empty selection
    project.stageManager.clearSelectAll();
    await Promise.resolve();
    expect(receivedCanvasSelections).toEqual([["sync-b", "sync-c"], []]);

    // 4. Respects Settings.stageTableAutoFocusCanvasOnSelect toggle (still syncs selection when disabled, without moving camera)
    const bombMove = vi.fn();
    Object.assign(project.camera, { bombMove });
    const { Settings } = await import("@/core/service/Settings");
    Settings.stageTableAutoFocusCanvasOnSelect = false;
    try {
      project.stageTable.selectRowsOnCanvas(["sync-a"]);
      expect(nodeA.isSelected).toBe(true);
      expect(bombMove).not.toHaveBeenCalled();

      // Explicit jump button (focusRowOnCanvas) always focuses camera even when auto-focus on select is off
      project.stageTable.focusRowOnCanvas("sync-a");
      expect(bombMove).toHaveBeenCalledTimes(1);

      // Re-enabling auto-focus resumes camera pan on selectRowsOnCanvas
      Settings.stageTableAutoFocusCanvasOnSelect = true;
      project.stageTable.selectRowsOnCanvas(["sync-c"]);
      expect(nodeC.isSelected).toBe(true);
      expect(bombMove).toHaveBeenCalledTimes(2);
    } finally {
      Settings.stageTableAutoFocusCanvasOnSelect = true;
    }

    unsub();
  });

  it("supports column sorting, value filtering, persistence normalization, and cleanup on column removal", () => {
    const project = createTestHarness();
    const node1 = new TextNode(project as never, { uuid: "f1", text: "章节 10", createdAt: 3000, updatedAt: 3000 });
    const node2 = new TextNode(project as never, { uuid: "f2", text: "章节 2", createdAt: 1000, updatedAt: 1000 });
    const node3 = new TextNode(project as never, { uuid: "f3", text: "章节 1", createdAt: 2000, updatedAt: 2000 });
    project.stage.push(node1, node2, node3);

    const colScore = project.stageTable.addCustomColumn({ name: "分值", type: "number" });
    project.stageTable.updateRowCustomField("f1", colScore.id, 30);
    project.stageTable.updateRowCustomField("f2", colScore.id, 100);
    // f3 intentionally empty

    // Natural sort on "name": 章节 1 < 章节 2 < 章节 10
    project.stageTable.toggleColumnSort("name");
    expect(project.stageTable.getSort()).toEqual({ columnId: "name", direction: "asc" });
    let rows = applyTableFiltersAndSort(
      project.stageTable.getRows(),
      project.stageTable.getColumns(),
      project.stageTable.getFilters(),
      project.stageTable.getSort(),
    );
    expect(rows.map((r) => r.uuid)).toEqual(["f3", "f2", "f1"]);

    // Toggle again -> desc
    project.stageTable.toggleColumnSort("name");
    expect(project.stageTable.getSort()).toEqual({ columnId: "name", direction: "desc" });
    rows = applyTableFiltersAndSort(
      project.stageTable.getRows(),
      project.stageTable.getColumns(),
      project.stageTable.getFilters(),
      project.stageTable.getSort(),
    );
    expect(rows.map((r) => r.uuid)).toEqual(["f1", "f2", "f3"]);

    // Numeric sort on custom number column keeps empty values last in both directions
    project.stageTable.setSort({ columnId: colScore.id, direction: "asc" });
    rows = applyTableFiltersAndSort(
      project.stageTable.getRows(),
      project.stageTable.getColumns(),
      project.stageTable.getFilters(),
      project.stageTable.getSort(),
    );
    expect(rows.map((r) => r.uuid)).toEqual(["f1", "f2", "f3"]);

    // Value filter: keep only value "30" and empty rows
    const { buckets, emptyCount } = collectColumnFilterBuckets(project.stageTable.getRows(), colScore.id, colScore);
    expect(buckets.map((b) => b.key)).toEqual(["30", "100"]);
    expect(emptyCount).toBe(1);

    project.stageTable.setColumnFilter(colScore.id, { values: ["30"], includeEmpty: true });
    rows = applyTableFiltersAndSort(
      project.stageTable.getRows(),
      project.stageTable.getColumns(),
      project.stageTable.getFilters(),
      project.stageTable.getSort(),
    );
    expect(rows.map((r) => r.uuid)).toEqual(["f1", "f3"]);

    // Persistence round-trip via normalizeTableData preserves sort & filters
    const normalized = normalizeTableData(project.table);
    expect(normalized.views[0].sort).toEqual({ columnId: colScore.id, direction: "asc" });
    expect(normalized.views[0].filters).toEqual([{ columnId: colScore.id, values: ["30"], includeEmpty: true }]);

    // Deleting the column cleans up both sort and filter referencing it
    project.stageTable.deleteCustomColumn(colScore.id);
    expect(project.stageTable.getSort()).toBeNull();
    expect(project.stageTable.getFilters()).toEqual([]);
  });

  it("evaluates formula columns dynamically without mutating updatedAt, supports sort/filter/rename resilience, and solidifies values on type conversion", () => {
    const project = createTestHarness();
    const fixedTime = new Date(2026, 9, 22, 12, 0, 0).getTime();
    const q1 = new TextNode(project as never, {
      uuid: "q1",
      text: "细胞膜图像",
      createdAt: fixedTime,
      updatedAt: fixedTime,
    });
    const q2 = new TextNode(project as never, {
      uuid: "q2",
      text: "线粒体结构",
      createdAt: fixedTime,
      updatedAt: fixedTime,
    });
    project.stage.push(q1, q2);

    const colCorrect = project.stageTable.addCustomColumn({ name: "答对次数", type: "number" });
    const colDelay = project.stageTable.addCustomColumn({ name: "延期", type: "number" });
    project.stageTable.updateRowCustomField("q1", colCorrect.id, 1);
    project.stageTable.updateRowCustomField("q1", colDelay.id, 0);
    project.stageTable.updateRowCustomField("q2", colCorrect.id, 3);
    project.stageTable.updateRowCustomField("q2", colDelay.id, 2);

    const updatedBeforeFormula = q1.updatedAt;

    // Add 2 chained formula columns (ID-based refs)
    const colInterval = project.stageTable.addCustomColumn({
      name: "下次作答",
      type: "formula",
      formula: `POWER(2, {{${colCorrect.id}}}) - 1 + {{${colDelay.id}}}`,
    });
    const colLabel = project.stageTable.addCustomColumn({
      name: "复习提示",
      type: "formula",
      formula: `IF({{${colInterval.id}}} <= 1, "明天复习", "延后复习")`,
    });

    // Formula evaluation must NOT write into entity.tableFields or touch updatedAt
    let rows = project.stageTable.getRows();
    expect(q1.tableFields[colInterval.id]).toBeUndefined();
    expect(q1.updatedAt).toBe(updatedBeforeFormula);
    expect(rows.find((r) => r.uuid === "q1")?.formulaValues[colInterval.id]?.numericValue).toBe(1);
    expect(rows.find((r) => r.uuid === "q2")?.formulaValues[colInterval.id]?.numericValue).toBe(9);
    expect(rows.find((r) => r.uuid === "q1")?.formulaValues[colLabel.id]?.displayText).toBe("明天复习");
    expect(rows.find((r) => r.uuid === "q2")?.formulaValues[colLabel.id]?.displayText).toBe("延后复习");

    // Read-only guard: direct cell write to formula column is rejected
    expect(project.stageTable.updateRowCustomField("q1", colInterval.id, 999)).toBe(false);

    // Renaming referenced column must NOT break the formula
    project.stageTable.updateColumn(colCorrect.id, { name: "连续答对次数" });
    rows = project.stageTable.getRows();
    expect(rows.find((r) => r.uuid === "q2")?.formulaValues[colInterval.id]?.numericValue).toBe(9);

    // Sorting & filtering directly on formula columns
    project.stageTable.setSort({ columnId: colInterval.id, direction: "desc" });
    const sorted = applyTableFiltersAndSort(
      project.stageTable.getRows(),
      project.stageTable.getColumns(),
      [],
      project.stageTable.getSort(),
    );
    expect(sorted.map((r) => r.uuid)).toEqual(["q2", "q1"]);

    const { buckets } = collectColumnFilterBuckets(project.stageTable.getRows(), colLabel.id, colLabel);
    expect(buckets.map((b) => b.key).sort()).toEqual(["延后复习", "明天复习"]);
    const filtered = applyTableFiltersAndSort(
      project.stageTable.getRows(),
      project.stageTable.getColumns(),
      [{ columnId: colLabel.id, values: ["明天复习"], includeEmpty: false }],
      null,
    );
    expect(filtered.map((r) => r.uuid)).toEqual(["q1"]);

    // Solidification: converting formula -> number snapshots computed values into static tableFields
    project.stageTable.updateColumn(colInterval.id, { type: "number" });
    expect(q1.tableFields[colInterval.id]).toBe(1);
    expect(q2.tableFields[colInterval.id]).toBe(9);
    expect(project.stageTable.getColumnSchema(colInterval.id)?.formula).toBeUndefined();

    // Solidification: converting formula -> select auto-creates options from evaluated text
    project.stageTable.updateColumn(colLabel.id, { type: "select" });
    const labelSchema = project.stageTable.getColumnSchema(colLabel.id)!;
    const optionNames = (labelSchema.options ?? []).map((o) => o.name).sort();
    expect(optionNames).toEqual(["延后复习", "明天复习"]);
    expect(q1.tableFields[colLabel.id]).toBeTruthy();

    // Switching static column -> formula clears stale static entries
    project.stageTable.updateColumn(colInterval.id, { type: "formula", formula: "42" });
    expect(q1.tableFields[colInterval.id]).toBeUndefined();
    expect(project.stageTable.getRows().find((r) => r.uuid === "q1")?.formulaValues[colInterval.id]?.numericValue).toBe(
      42,
    );
  });

  it("supports creating, switching, renaming, duplicating, reordering, and deleting multiple views with isolated state", () => {
    const project = createTestHarness();
    const statusCol = project.stageTable.addCustomColumn({ name: "出处", type: "select" })!;
    const optBook = project.stageTable.createOrGetSelectOption(statusCol.id, "课本")!;
    const startCol = project.stageTable.addCustomColumn({ name: "开始日期", type: "date" })!;
    const endCol = project.stageTable.addCustomColumn({ name: "结束日期", type: "date" })!;

    const defaultView = project.stageTable.getActiveView();
    expect(defaultView.deletable).toBe(false);
    expect(project.stageTable.deleteView(defaultView.id)).toBe(false);

    // Create Kanban, Gantt, Gallery, Calendar, and a second Kanban view
    const kanban1 = project.stageTable.createView({ type: "kanban", name: "看板" });
    expect(kanban1.type).toBe("kanban");
    expect(kanban1.name).toBe("看板");
    expect(kanban1.kanban?.groupByColumnId).toBe(statusCol.id);
    expect(project.stageTable.getActiveView().id).toBe(kanban1.id);

    const kanban2 = project.stageTable.createView({ type: "kanban", name: "看板" });
    expect(kanban2.name).toBe("看板 2");

    const gantt = project.stageTable.createView({ type: "gantt", name: "甘特" });
    expect(gantt.gantt?.startDateColumnId).toBe(startCol.id);
    expect(gantt.gantt?.endDateColumnId).toBe(endCol.id);
    expect(gantt.gantt?.timeScale).toBe("month");

    const gallery = project.stageTable.createView({ type: "gallery", name: "画册" });
    expect(gallery.gallery?.coverMode).toBe("images");

    const calendar = project.stageTable.createView({ type: "calendar", name: "日历" });
    expect(calendar.calendar?.dateColumnId).toBe(startCol.id);
    expect(calendar.calendar?.endDateColumnId).toBe(endCol.id);
    expect(calendar.calendar?.displayMode).toBe("month");

    expect(project.stageTable.getViews().length).toBe(6);

    // Per-view filter/sort isolation
    project.stageTable.setColumnFilter(statusCol.id, { values: [optBook.id], includeEmpty: false });
    project.stageTable.setSort({ columnId: "name", direction: "desc" });
    expect(project.stageTable.getFilters().length).toBe(1);
    expect(project.stageTable.getSort()?.direction).toBe("desc");

    project.stageTable.setActiveView(defaultView.id);
    expect(project.stageTable.getFilters().length).toBe(0);
    expect(project.stageTable.getSort()).toBeNull();

    // Rename & Duplicate & Reorder & Delete
    expect(project.stageTable.renameView(kanban2.id, "复习看板")).toBe(true);
    expect(project.stageTable.getViews().find((v) => v.id === kanban2.id)?.name).toBe("复习看板");

    const dup = project.stageTable.duplicateView(calendar.id, "副本")!;
    expect(dup.type).toBe("calendar");
    expect(dup.filters?.length).toBe(1);
    expect(dup.sort?.direction).toBe("desc");
    expect(project.stageTable.getActiveView().id).toBe(dup.id);

    expect(project.stageTable.reorderViews(dup.id, defaultView.id, "after")).toBe(true);
    expect(project.stageTable.getViews()[1].id).toBe(dup.id);

    expect(project.stageTable.deleteView(dup.id)).toBe(true);
    expect(project.stageTable.getViews().some((v) => v.id === dup.id)).toBe(false);

    // Deleting a referenced column cleans up view configs across all views
    project.stageTable.deleteCustomColumn(startCol.id);
    const updatedGantt = project.stageTable.getViews().find((v) => v.id === gantt.id)!;
    const updatedCal = project.stageTable.getViews().find((v) => v.id === calendar.id)!;
    expect(updatedGantt.gantt?.startDateColumnId).toBe("createdAt");
    expect(updatedCal.calendar?.dateColumnId).toBe("createdAt");

    // Round-trip normalizeTableData preserves multi-view schemas cleanly
    const normalized = normalizeTableData(JSON.parse(JSON.stringify(project.table)));
    expect(normalized.views.length).toBe(project.table.views.length);
    expect(normalized.views.map((v) => v.type)).toEqual(["table", "kanban", "kanban", "gantt", "gallery", "calendar"]);
  });

  it("creates rows on canvas with prefilled fields and atomically updates multiple fields", () => {
    const project = createTestHarness();
    const startCol = project.stageTable.addCustomColumn({ name: "开始", type: "date" })!;
    const endCol = project.stageTable.addCustomColumn({ name: "结束", type: "date" })!;

    const created = project.stageTable.createRow({
      text: "细胞器图像",
      tableFields: { [startCol.id]: "2026-11-25" },
    });
    expect(created).toBeTruthy();
    expect(created!.primaryText).toBe("细胞器图像");
    expect(created!.tableFields[startCol.id]).toBe("2026-11-25");

    const prevRef = created!.entity!.tableFields;
    const ok = project.stageTable.updateRowCustomFields(created!.uuid, {
      [startCol.id]: "2026-11-26",
      [endCol.id]: "2026-11-28",
    });
    expect(ok).toBe(true);
    expect(created!.entity!.tableFields).not.toBe(prevRef);
    expect(created!.entity!.tableFields[startCol.id]).toBe("2026-11-26");
    expect(created!.entity!.tableFields[endCol.id]).toBe("2026-11-28");
  });

  it("supports multi-condition filterGroup with category operators, AND/OR, date presets, collapse persistence, and cleanup", () => {
    const project = createTestHarness();
    const fixedNow = new Date(2026, 10, 26, 12, 0, 0); // 2026-11-26 local
    const tToday = new Date(2026, 10, 26, 9, 0, 0).getTime();
    const tYesterday = new Date(2026, 10, 25, 9, 0, 0).getTime();
    const tOld = new Date(2026, 9, 1, 9, 0, 0).getTime();

    const n1 = new TextNode(project as never, {
      uuid: "r1",
      text: "生物 细胞膜",
      createdAt: tToday,
      updatedAt: tToday,
    });
    const n2 = new TextNode(project as never, {
      uuid: "r2",
      text: "化学 氧化还原",
      createdAt: tYesterday,
      updatedAt: tYesterday,
    });
    const sec3 = new Section(project as never, {
      uuid: "r3",
      text: "物理 电磁学",
      createdAt: tOld,
      updatedAt: tOld,
      children: [],
    });
    const imgInSec3 = new ImageNode(project as never, { uuid: "img-r3", attachmentId: "att-r3" });
    sec3.children.push(imgInSec3);
    project.stage.push(n1, n2, sec3, imgInSec3);

    const colNum = project.stageTable.addCustomColumn({ name: "分值", type: "number" });
    const colStatus = project.stageTable.addCustomColumn({ name: "归档状态", type: "select" });
    const colTags = project.stageTable.addCustomColumn({ name: "标签", type: "multi_select" });
    const colDate = project.stageTable.addCustomColumn({ name: "复习日期", type: "date" });
    const colFormula = project.stageTable.addCustomColumn({
      name: "是否到期",
      type: "formula",
      formula: `IF({{${colNum.id}}} >= 60, "是", "否")`,
    });

    const optArchived = project.stageTable.createOrGetSelectOption(colStatus.id, "归档")!;
    const optActive = project.stageTable.createOrGetSelectOption(colStatus.id, "进行中")!;
    const tagA = project.stageTable.createOrGetSelectOption(colTags.id, "重点")!;
    const tagB = project.stageTable.createOrGetSelectOption(colTags.id, "易错")!;

    project.stageTable.updateRowCustomField("r1", colNum.id, 80);
    project.stageTable.updateRowCustomField("r2", colNum.id, 40);
    // r3 number intentionally empty

    project.stageTable.updateRowCustomField("r1", colStatus.id, optArchived.id);
    project.stageTable.updateRowCustomField("r2", colStatus.id, optActive.id);

    project.stageTable.updateRowCustomField("r1", colTags.id, [tagA.id, tagB.id]);
    project.stageTable.updateRowCustomField("r2", colTags.id, [tagA.id]);

    project.stageTable.updateRowCustomField("r1", colDate.id, "2026-11-26");
    project.stageTable.updateRowCustomField("r2", colDate.id, "2026-11-25");

    // Verify exact operators per category
    expect(getFilterOperatorsForKind(getColumnFilterKind(colNum.id, colNum))).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "is_empty",
      "is_not_empty",
    ]);
    expect(getFilterOperatorsForKind(getColumnFilterKind("images"))).toEqual(["is_empty", "is_not_empty"]);
    expect(getDefaultFilterOperator("images")).toBe("is_not_empty");
    expect(getFilterOperatorsForKind(getColumnFilterKind("name"))).toEqual([
      "contains",
      "not_contains",
      "eq",
      "neq",
      "is_empty",
      "is_not_empty",
    ]);
    expect(getFilterOperatorsForKind(getColumnFilterKind(colStatus.id, colStatus))).toEqual([
      "contains",
      "not_contains",
      "eq",
      "neq",
      "is_empty",
      "is_not_empty",
    ]);
    expect(getFilterOperatorsForKind(getColumnFilterKind(colFormula.id, colFormula))).toEqual([
      "contains",
      "not_contains",
      "eq",
      "neq",
      "is_empty",
      "is_not_empty",
    ]);

    const evalFiltered = () =>
      applyTableFiltersAndSort(
        project.stageTable.getRows(),
        project.stageTable.getColumns(),
        project.stageTable.getFilters(),
        null,
        project.stageTable.getFilterGroup(),
        fixedNow,
      ).map((r) => r.uuid);

    // 1. Newly added incomplete text condition is pass-through & not counted as active
    const cName = project.stageTable.addFilterCondition("name")!;
    expect(countActiveFilterConditions(project.stageTable.getFilterGroup(), project.stageTable.getColumns())).toBe(0);
    expect(evalFiltered()).toEqual(["r1", "r2", "r3"]);

    // 2. Numeric operators (=, ≠, >, ≥, <, ≤, is_empty, is_not_empty)
    project.stageTable.removeFilterCondition(cName.id);
    const cNum = project.stageTable.addFilterCondition(colNum.id)!;
    project.stageTable.updateFilterCondition(cNum.id, { operator: "gt", value: "50" });
    expect(evalFiltered()).toEqual(["r1"]);
    project.stageTable.updateFilterCondition(cNum.id, { operator: "lte", value: "40" });
    expect(evalFiltered()).toEqual(["r2"]);
    project.stageTable.updateFilterCondition(cNum.id, { operator: "neq", value: "80" });
    expect(evalFiltered()).toEqual(["r2", "r3"]);
    project.stageTable.updateFilterCondition(cNum.id, { operator: "is_empty" });
    expect(evalFiltered()).toEqual(["r3"]);
    project.stageTable.updateFilterCondition(cNum.id, { operator: "is_not_empty" });
    expect(evalFiltered()).toEqual(["r1", "r2"]);

    // 3. Images column (is_not_empty / is_empty)
    project.stageTable.removeFilterCondition(cNum.id);
    const cImg = project.stageTable.addFilterCondition("images")!;
    expect(cImg.operator).toBe("is_not_empty");
    expect(countActiveFilterConditions(project.stageTable.getFilterGroup(), project.stageTable.getColumns())).toBe(1);
    expect(evalFiltered()).toEqual(["r3"]);
    project.stageTable.updateFilterCondition(cImg.id, { operator: "is_empty" });
    expect(evalFiltered()).toEqual(["r1", "r2"]);

    // 4. Formula & Select & Multi-select (contains vs exact eq)
    project.stageTable.clearAllFilters();
    const cFormula = project.stageTable.addFilterCondition(colFormula.id)!;
    project.stageTable.updateFilterCondition(cFormula.id, { operator: "contains", value: "是" });
    expect(evalFiltered()).toEqual(["r1"]);

    project.stageTable.clearAllFilters();
    const cTags = project.stageTable.addFilterCondition(colTags.id)!;
    project.stageTable.updateFilterCondition(cTags.id, { operator: "contains", values: [tagA.id] });
    expect(evalFiltered()).toEqual(["r1", "r2"]);
    project.stageTable.updateFilterCondition(cTags.id, { operator: "eq", values: [tagA.id] });
    expect(evalFiltered()).toEqual(["r2"]);
    project.stageTable.updateFilterCondition(cTags.id, { operator: "not_contains", values: [tagB.id] });
    expect(evalFiltered()).toEqual(["r2", "r3"]);

    // 5. Date presets & exact date
    project.stageTable.clearAllFilters();
    const cCreated = project.stageTable.addFilterCondition("createdAt")!;
    project.stageTable.updateFilterCondition(cCreated.id, { operator: "eq", datePreset: "today" });
    expect(evalFiltered()).toEqual(["r1"]);
    project.stageTable.updateFilterCondition(cCreated.id, { operator: "eq", datePreset: "past_7_days" });
    expect(evalFiltered()).toEqual(["r1", "r2"]);
    project.stageTable.updateFilterCondition(cCreated.id, {
      operator: "lt",
      datePreset: undefined,
      value: "2026-11-26",
    });
    expect(evalFiltered()).toEqual(["r2", "r3"]);

    // 6. AND vs OR conjunction + collapse state + persistence round-trip
    const cImg2 = project.stageTable.addFilterCondition("images")!;
    project.stageTable.updateFilterCondition(cCreated.id, { operator: "eq", datePreset: "today", value: undefined });
    // AND: createdAt == today (r1) AND images is_not_empty (r3) => []
    expect(evalFiltered()).toEqual([]);
    // OR: r1 or r3
    project.stageTable.setFilterConjunction("or");
    expect(evalFiltered()).toEqual(["r1", "r3"]);

    project.stageTable.toggleFilterConditionCollapsed(cImg2.id);
    expect(project.stageTable.getFilterGroup().conditions.find((c) => c.id === cImg2.id)?.collapsed).toBe(true);

    // Drag-reorder filter conditions
    expect(project.stageTable.reorderFilterConditions(cImg2.id, cCreated.id, "before")).toBe(true);
    expect(project.stageTable.getFilterGroup().conditions.map((c) => c.id)).toEqual([cImg2.id, cCreated.id]);
    expect(project.stageTable.reorderFilterConditions(cImg2.id, cCreated.id, "after")).toBe(true);
    expect(project.stageTable.getFilterGroup().conditions.map((c) => c.id)).toEqual([cCreated.id, cImg2.id]);
    expect(project.stageTable.reorderFilterConditions(cCreated.id, cCreated.id, "before")).toBe(false);

    const normalized = normalizeTableData(JSON.parse(JSON.stringify(project.table)));
    expect(normalized.views[0].filterGroup?.conjunction).toBe("or");
    expect(normalized.views[0].filterGroup?.conditions.length).toBe(2);
    expect(normalized.views[0].filterGroup?.conditions[1].collapsed).toBe(true);

    // 7. Duplicating view deep-clones filterGroup with distinct condition IDs
    const dupView = project.stageTable.duplicateView(project.stageTable.getActiveView().id, "副本")!;
    expect(dupView.filterGroup?.conditions.length).toBe(2);
    expect(dupView.filterGroup?.conditions[0].id).not.toBe(cCreated.id);

    // 8. Column deletion cleans up filterGroup conditions referencing that column
    const cNumDel = project.stageTable.addFilterCondition(colNum.id)!;
    project.stageTable.updateFilterCondition(cNumDel.id, { operator: "eq", value: "80" });
    project.stageTable.deleteCustomColumn(colNum.id);
    expect(project.stageTable.getFilterGroup().conditions.some((c) => c.columnId === colNum.id)).toBe(false);

    // 9. clearAllFilters clears both legacy column filters and filterGroup
    project.stageTable.setColumnFilter("name", { values: ["生物 细胞膜"], includeEmpty: false });
    project.stageTable.clearAllFilters();
    expect(project.stageTable.getFilters()).toEqual([]);
    expect(project.stageTable.getFilterGroup().conditions).toEqual([]);
  });

  it("间隔重复视图自动补齐 11 个默认隐藏且不可删除的列，并按作答日期与开卷/闭卷/错规则准确调度且不刷新最后编辑时间", () => {
    const project = createTestHarness();
    const initialUpdatedAt = new Date(2026, 9, 10, 10, 0, 0).getTime();
    const nodeA = new TextNode(project as any, {
      text: "线粒体结构与功能",
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(120, 60))]),
      createdAt: initialUpdatedAt,
      updatedAt: initialUpdatedAt,
    });
    project.stageManager.add(nodeA);
    project.historyManager.clearHistory();

    // 预先手工建一个同名同类型列（备注），验证创建间隔重复视图时会复用而不是重复创建
    const existingNotes = project.stageTable.addCustomColumn({ name: "备注", type: "text" });
    project.stageTable.setColumnVisible(existingNotes.id, false);

    // 1. 创建间隔重复视图
    const srView = project.stageTable.createView({ type: "spaced_repetition", name: "间隔重复" });
    expect(srView.type).toBe("spaced_repetition");
    expect(srView.spacedRepetition?.columns).toBe(2);
    expect(srView.spacedRepetition?.queueTab).toBe("due");

    const cols = project.stageTable.getColumns();
    expect(cols.length).toBe(11);
    const roleIds = project.stageTable.getSpacedRepetitionColumnIds();
    expect(roleIds.notes).toBe(existingNotes.id);
    expect(Object.keys(roleIds).length).toBe(11);

    // 2. 所有自动补齐的列在表格视图中默认隐藏，但可展示、移动、重命名，且不可删除或改类型
    const defaultView = project.table.views[0];
    expect(defaultView.visibleColumnIds).toEqual(["name"]);
    project.stageTable.setActiveView(defaultView.id);
    project.stageTable.setColumnVisible(roleIds.correctCount!, true);
    project.stageTable.setColumnVisible(roleIds.answerDate!, true);
    expect(project.stageTable.isColumnVisible(roleIds.correctCount!)).toBe(true);
    expect(project.stageTable.reorderColumn(roleIds.answerDate!, roleIds.correctCount!, "before")).toBe(true);
    expect(project.stageTable.getVisibleColumnIds()).toEqual(["name", roleIds.answerDate!, roleIds.correctCount!]);
    project.stageTable.setColumnVisible(roleIds.answerDate!, false);
    expect(project.stageTable.isColumnVisible(roleIds.answerDate!)).toBe(false);

    // 不可删除，也不可变更类型；但允许重命名
    expect(project.stageTable.isColumnProtected(roleIds.correctCount!)).toBe(true);
    expect(project.stageTable.deleteCustomColumn(roleIds.correctCount!)).toBe(false);
    expect(project.stageTable.getColumns().some((c) => c.id === roleIds.correctCount)).toBe(true);
    project.stageTable.updateColumn(roleIds.correctCount!, { name: "累计答对次数", type: "text" });
    expect(project.stageTable.getColumnSchema(roleIds.correctCount!)?.name).toBe("累计答对次数");
    expect(project.stageTable.getColumnSchema(roleIds.correctCount!)?.type).toBe("number");

    // 3. 新节点尚未作答时：下次作答=0，下次要求作答时间为空，是否到期="待复习"
    const getRowA = () => project.stageTable.getRows().find((r) => r.uuid === nodeA.uuid)!;
    expect(getRowA().formulaValues[roleIds.nextInterval!]?.displayText).toBe("0");
    expect(getRowA().formulaValues[roleIds.nextDueDate!]?.displayText).toBe("");
    expect(getRowA().formulaValues[roleIds.dueStatus!]?.displayText).toBe("待复习");

    // 4. 点击「对-闭卷」：掌握程度=1，答对次数+1 (=1)，延期=0，作答日期=today，且不刷新 updatedAt
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const snap1 = project.stageTable.answerSpacedRepetitionRow(nodeA.uuid, "correct_closed", { today })!;
    expect(snap1).toBeTruthy();
    expect(nodeA.tableFields[roleIds.mastery!]).toBe(1);
    expect(nodeA.tableFields[roleIds.correctCount!]).toBe(1);
    expect(nodeA.tableFields[roleIds.delay!]).toBe(0);
    expect(nodeA.tableFields[roleIds.answerDate!]).toBe(todayStr);
    expect(nodeA.updatedAt).toBe(initialUpdatedAt);
    expect(getRowA().formulaValues[roleIds.nextInterval!]?.displayText).toBe("1");
    expect(getRowA().formulaValues[roleIds.dueStatus!]?.displayText).toBe("未到期");

    // 5. 基于同一次作答前快照改选「对-开卷」：不重复累加答对次数，掌握程度=2，答对次数仍为 1，延期=0
    project.stageTable.answerSpacedRepetitionRow(nodeA.uuid, "correct_open", { baseline: snap1, today });
    expect(nodeA.tableFields[roleIds.mastery!]).toBe(2);
    expect(nodeA.tableFields[roleIds.correctCount!]).toBe(1);
    expect(nodeA.tableFields[roleIds.delay!]).toBe(0);
    expect(nodeA.updatedAt).toBe(initialUpdatedAt);

    // 6. 第二次独立作答选「对-闭卷」：答对次数 1 -> 2，掌握程度=1，下次作答 = 2^2 - 1 + 0 = 3
    project.stageTable.answerSpacedRepetitionRow(nodeA.uuid, "correct_closed", { today });
    expect(nodeA.tableFields[roleIds.mastery!]).toBe(1);
    expect(nodeA.tableFields[roleIds.correctCount!]).toBe(2);
    expect(nodeA.tableFields[roleIds.delay!]).toBe(0);
    expect(getRowA().formulaValues[roleIds.nextInterval!]?.displayText).toBe("3");

    // 7. 点击「错」：掌握程度=3，答对次数 2 -> 1，延期 0 -> 1，下次作答 = 2^1 - 1 + 1 = 2
    const snapWrong = project.stageTable.answerSpacedRepetitionRow(nodeA.uuid, "wrong", { today })!;
    expect(nodeA.tableFields[roleIds.mastery!]).toBe(3);
    expect(nodeA.tableFields[roleIds.correctCount!]).toBe(1);
    expect(nodeA.tableFields[roleIds.delay!]).toBe(1);
    expect(getRowA().formulaValues[roleIds.nextInterval!]?.displayText).toBe("2");
    expect(nodeA.updatedAt).toBe(initialUpdatedAt);

    // 8. 撤销本次「错」作答，完整恢复且仍不污染 updatedAt
    expect(project.stageTable.restoreSpacedRepetitionRow(nodeA.uuid, snapWrong)).toBe(true);
    expect(nodeA.tableFields[roleIds.mastery!]).toBe(1);
    expect(nodeA.tableFields[roleIds.correctCount!]).toBe(2);
    expect(nodeA.tableFields[roleIds.delay!]).toBe(0);
    expect(nodeA.updatedAt).toBe(initialUpdatedAt);

    // 9. 答对次数为 0 时再点「错」：答对次数下限钳制在 0，延期 +1，下次作答 = 1
    project.stageTable.updateRowCustomFields(nodeA.uuid, {
      [roleIds.correctCount!]: 0,
      [roleIds.delay!]: 0,
    });
    project.stageTable.answerSpacedRepetitionRow(nodeA.uuid, "wrong", { today });
    expect(nodeA.tableFields[roleIds.correctCount!]).toBe(0);
    expect(nodeA.tableFields[roleIds.delay!]).toBe(1);
    expect(getRowA().formulaValues[roleIds.nextInterval!]?.displayText).toBe("1");

    // 10. 设为「已归档」后，是否到期立即变为「已归档」
    const archiveCol = project.stageTable.getColumnSchema(roleIds.archiveStatus!)!;
    const archivedOpt = archiveCol.options!.find((o) => o.name === "已归档")!;
    project.stageTable.updateRowCustomField(nodeA.uuid, archiveCol.id, archivedOpt.id);
    expect(getRowA().formulaValues[roleIds.dueStatus!]?.displayText).toBe("已归档");

    // 11. 正面/背面新增自定义属性：同步到表格视图、默认隐藏，且可正常删除（同时清理视图引用）
    project.stageTable.setActiveView(srView.id);
    const frontCustom = project.stageTable.addSpacedRepetitionCustomColumn({
      name: "题干提示",
      type: "text",
      side: "front",
    });
    const backCustom = project.stageTable.addSpacedRepetitionCustomColumn({
      name: "错因分析",
      type: "select",
      side: "back",
    });
    expect(project.stageTable.isColumnProtected(frontCustom.id)).toBe(false);
    expect(project.stageTable.isColumnProtected(backCustom.id)).toBe(false);
    expect(project.table.views[0].visibleColumnIds).not.toContain(frontCustom.id);
    expect(project.table.views[0].visibleColumnIds).not.toContain(backCustom.id);
    expect(project.stageTable.getActiveView().spacedRepetition?.frontFieldIds).toContain(frontCustom.id);

    // 12. normalizeTableData 完整保留 protectedRole 与 spacedRepetition 配置
    project.stageTable.updateActiveViewConfig({ spacedRepetition: { columns: 1, queueTab: "all" } });
    const roundTripped = normalizeTableData(JSON.parse(JSON.stringify(project.table)));
    expect(roundTripped.columns.filter((c) => Boolean(c.protectedRole)).length).toBe(11);
    const rtView = roundTripped.views.find((v) => v.id === srView.id);
    expect(rtView?.type).toBe("spaced_repetition");
    expect(rtView?.spacedRepetition?.columns).toBe(1);
    expect(rtView?.spacedRepetition?.queueTab).toBe("all");
    expect(rtView?.spacedRepetition?.frontFieldIds).toContain(frontCustom.id);

    // 13. 正面与背面属性二维拖动排序（支持左右并排同行与上下独立成行）及持久化
    const frontCustom2 = project.stageTable.addSpacedRepetitionCustomColumn({
      name: "参考公式",
      type: "text",
      side: "front",
    });
    expect(project.stageTable.reorderSpacedRepetitionFields("front", frontCustom2.id, frontCustom.id, "right")).toBe(
      true,
    );
    expect(project.stageTable.getActiveView().spacedRepetition?.frontFieldRows).toEqual([
      [frontCustom.id, frontCustom2.id],
    ]);
    expect(project.stageTable.reorderSpacedRepetitionFields("front", frontCustom2.id, frontCustom.id, "top")).toBe(
      true,
    );
    expect(project.stageTable.getActiveView().spacedRepetition?.frontFieldRows).toEqual([
      [frontCustom2.id],
      [frontCustom.id],
    ]);
    expect(
      project.stageTable.reorderSpacedRepetitionFields("back", roleIds.delay!, roleIds.notes!, "left", [
        [roleIds.notes!],
        [roleIds.source!, roleIds.delay!],
      ]),
    ).toBe(true);
    expect(project.stageTable.getActiveView().spacedRepetition?.backFieldRows).toEqual([
      [roleIds.delay!, roleIds.notes!],
      [roleIds.source!],
    ]);
    const rtRows = normalizeTableData(JSON.parse(JSON.stringify(project.table))).views.find((v) => v.id === srView.id);
    expect(rtRows?.spacedRepetition?.backFieldRows).toEqual([[roleIds.delay!, roleIds.notes!], [roleIds.source!]]);

    // 删除正/背面自定义属性列成功并同步清理 frontFieldIds 与 frontFieldRows；核心 11 列仍不可删除
    expect(project.stageTable.deleteCustomColumn(frontCustom2.id)).toBe(true);
    expect(project.stageTable.deleteCustomColumn(frontCustom.id)).toBe(true);
    expect(project.stageTable.getActiveView().spacedRepetition?.frontFieldRows).toEqual([]);
    expect(project.stageTable.deleteCustomColumn(backCustom.id)).toBe(true);
    expect(project.stageTable.getColumnSchema(frontCustom.id)).toBeUndefined();
    expect(project.stageTable.getColumnSchema(backCustom.id)).toBeUndefined();
    expect(project.stageTable.getActiveView().spacedRepetition?.frontFieldIds).not.toContain(frontCustom.id);
    expect(project.stageTable.deleteCustomColumn(roleIds.dueStatus!)).toBe(false);
  });
});
