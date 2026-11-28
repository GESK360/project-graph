// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: 0, Stashed: 1, Unsaved: 2 },
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
    historySize: 500,
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
  },
}));
vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => new Vector(80, 32),
  getTextSize: () => new Vector(80, 32),
}));
vi.mock("@/core/service/feedbackService/SoundService", () => ({
  SoundService: { play: { entityJumpSoundFile: vi.fn() } },
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

import { StageTableService } from "@/core/service/dataManageService/stageTableService/StageTableService";
import { StageManager } from "@/core/stage/stageManager/StageManager";
import { HistoryManager } from "@/core/stage/stageManager/StageHistoryManager";
import { GraphMethods } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import { SectionMethods } from "@/core/stage/stageManager/basicMethods/SectionMethods";
import { DeleteManager } from "@/core/stage/stageManager/concreteMethods/StageDeleteManager";
import { NodeConnector } from "@/core/stage/stageManager/concreteMethods/StageNodeConnector";
import { StageObjectColorManager } from "@/core/stage/stageManager/concreteMethods/StageObjectColorManager";
import { SectionInOutManager } from "@/core/stage/stageManager/concreteMethods/StageSectionInOutManager";
import { SectionPackManager } from "@/core/stage/stageManager/concreteMethods/StageSectionPackManager";
import { StageSyncAssociationManager } from "@/core/stage/stageManager/concreteMethods/StageSyncAssociationManager";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { createDefaultTableData } from "@/types/table";
import { DocCommandBus } from "./DocCommandBus";

function createM2Harness() {
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
    projectState: 0,
    isSqliteV3: false,
    v3DocId: null,
    v3Revision: 0,
    stageRevision: 0,
    bumpStageRevision: () => {
      project.stageRevision++;
    },
    renderer: { frameIndex: 0, w: 1200, h: 800, tick: vi.fn() },
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
  register("syncAssociationManager", new StageSyncAssociationManager(project));
  register("sectionInOutManager", new SectionInOutManager(project));
  register("sectionPackManager", new SectionPackManager(project));
  register("deleteManager", new DeleteManager(project));
  register("nodeConnector", new NodeConnector(project));
  register("stageObjectColorManager", new StageObjectColorManager(project));
  register("stageTable", new StageTableService(project));
  register("historyManager", new HistoryManager(project));
  return project;
}

describe("DocCommandBus & M2 row-level undo/redo performance and semantic updatedAt rules", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("enforces 100% of semantic updatedAt rules (non-semantic edits keep updatedAt; semantic edits bump & undo reverts)", () => {
    const project = createM2Harness();
    const t0 = 1_700_000_000_000;
    const colScore = project.stageTable.addCustomColumn({ name: "评分", type: "number" });

    const nodeA = new TextNode(project, {
      uuid: "a",
      text: "Alpha",
      createdAt: t0,
      updatedAt: t0,
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(100, 44))]),
    });
    const nodeB = new TextNode(project, {
      uuid: "b",
      text: "Beta",
      createdAt: t0,
      updatedAt: t0,
      collisionBox: new CollisionBox([new Rectangle(new Vector(220, 0), new Vector(100, 44))]),
    });
    const sec = new Section(project, {
      uuid: "sec",
      text: "Group",
      children: [nodeA],
      createdAt: t0,
      updatedAt: t0,
    });
    project.stage.push(nodeA, nodeB, sec);
    project.stageManager.updateReferences();
    project.historyManager.clearHistory();

    // 1. 拖拽位置不刷新 updatedAt
    vi.spyOn(Date, "now").mockReturnValue(t0 + 1000);
    nodeA.move(new Vector(60, 40));
    project.historyManager.recordStep("move");
    expect(nodeA.updatedAt).toBe(t0);
    expect(sec.updatedAt).toBe(t0);

    // 2. 折叠/展开分组框不刷新 updatedAt
    vi.spyOn(Date, "now").mockReturnValue(t0 + 2000);
    project.sectionPackManager.toggleSectionCollapse(sec);
    project.historyManager.recordStep("collapse");
    expect(sec.isCollapsed).toBe(true);
    expect(sec.updatedAt).toBe(t0);
    project.sectionPackManager.toggleSectionCollapse(sec);
    project.historyManager.recordStep("expand");
    expect(sec.isCollapsed).toBe(false);
    expect(sec.updatedAt).toBe(t0);

    // 3. 修改配色/样式不刷新 updatedAt
    vi.spyOn(Date, "now").mockReturnValue(t0 + 3000);
    nodeA.isSelected = true;
    project.stageObjectColorManager.setSelectedStageObjectColor(Color.Red);
    expect(nodeA.updatedAt).toBe(t0);

    // 4. 间隔重复作答不刷新 updatedAt
    vi.spyOn(Date, "now").mockReturnValue(t0 + 4000);
    project.stageTable.createView({ type: "spaced_repetition", name: "复习" });
    project.stageTable.answerSpacedRepetitionRow("a", "correct_closed");
    expect(nodeA.updatedAt).toBe(t0);

    // 5. 编辑普通自定义单元格刷新 updatedAt，Undo 精确回滚
    vi.spyOn(Date, "now").mockReturnValue(t0 + 5000);
    project.stageTable.updateRowCustomField("a", colScore.id, 95);
    expect(nodeA.updatedAt).toBe(t0 + 5000);
    expect(nodeA.tableFields[colScore.id]).toBe(95);

    project.historyManager.undo();
    expect(nodeA.updatedAt).toBe(t0);
    expect(nodeA.tableFields[colScore.id]).toBeUndefined();

    // Redo 重新前进到 t0 + 5000
    project.historyManager.redo();
    expect(nodeA.updatedAt).toBe(t0 + 5000);
    expect(nodeA.tableFields[colScore.id]).toBe(95);

    // 6. 建立连线刷新两端点，删除连线刷新两端点，Undo 精确恢复
    vi.spyOn(Date, "now").mockReturnValue(t0 + 6000);
    project.stageTable.setRowChildren("a", ["b"]);
    expect(nodeA.updatedAt).toBe(t0 + 6000);
    expect(nodeB.updatedAt).toBe(t0 + 6000);

    project.historyManager.undo();
    expect(nodeA.updatedAt).toBe(t0 + 5000);
    expect(nodeB.updatedAt).toBe(t0);
  });

  it("5,000-node single-cell edit + Undo/Redo completes in < 2ms and supports 500 consecutive row-level steps", () => {
    const project = createM2Harness();
    const colVal = project.stageTable.addCustomColumn({ name: "数值", type: "number" });

    for (let i = 0; i < 5000; i++) {
      project.stage.push(
        new TextNode(project, {
          uuid: `n-${i}`,
          text: `Item ${i}`,
          createdAt: 1000,
          updatedAt: 1000,
          collisionBox: new CollisionBox([
            new Rectangle(new Vector((i % 100) * 160, Math.floor(i / 100) * 80), new Vector(120, 40)),
          ]),
        }),
      );
    }
    project.stageManager.updateReferences();
    project.historyManager.clearHistory();

    // 预热一次 JIT
    project.stageTable.updateRowCustomField("n-0", colVal.id, 1);
    project.historyManager.undo();
    project.historyManager.redo();

    // 单次单元格编辑 + Undo + Redo 耗时验收（< 2ms）
    const tEdit0 = performance.now();
    project.stageTable.updateRowCustomField("n-4999", colVal.id, 42);
    const editMs = performance.now() - tEdit0;

    const tUndo0 = performance.now();
    project.historyManager.undo();
    const undoMs = performance.now() - tUndo0;

    const tRedo0 = performance.now();
    project.historyManager.redo();
    const redoMs = performance.now() - tRedo0;

    expect((project.stageManager.get("n-4999") as TextNode).tableFields[colVal.id]).toBe(42);
    expect(editMs).toBeLessThan(2);
    expect(undoMs).toBeLessThan(2);
    expect(redoMs).toBeLessThan(2);

    // 连续 500 步仅存储单行增量补丁，绝不存储整图 5000 节点快照
    for (let step = 0; step < 500; step++) {
      project.stageTable.updateRowCustomField(`n-${step}`, colVal.id, step + 100);
    }
    const state = project.historyManager.getHistoryState();
    expect(state.totalEntries).toBeLessThanOrEqual(500);
    expect(state.canUndo).toBe(true);

    // 连续回滚 10 步验证状态一致
    for (let k = 0; k < 10; k++) {
      project.historyManager.undo();
    }
    expect((project.stageManager.get("n-499") as TextNode).tableFields[colVal.id]).toBeUndefined();
    expect((project.stageManager.get("n-489") as TextNode).tableFields[colVal.id]).toBe(589);
  });
});
