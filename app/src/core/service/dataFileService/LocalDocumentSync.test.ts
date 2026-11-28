// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ label: "main", listen: vi.fn() })),
}));
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
vi.mock("@/utils/font", async () => {
  const { Vector } = await import("@graphif/data-structures");
  return {
    getTextSize: vi.fn((text: string) => new Vector(Math.max(40, text.length * 12), 24)),
    getMultiLineTextSize: vi.fn((text: string) => new Vector(Math.max(40, text.length * 12), 24)),
  };
});
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    textNodeContentLineBreak: "enter",
    theme: "dark",
    sectionInitBorderStyle: "solid",
    textNodeInitBorderStyle: "solid",
    defaultEdgeLineType: "solid",
    defaultEdgeArrowType: "default",
    enableAutoEdgeWidth: false,
    hideSectionContentsWhenBigTitleActive: false,
    sectionBitTitleRenderType: "none",
  },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));
vi.mock("@/core/service/feedbackService/SoundService", () => ({
  SoundService: { play: { entityJumpSoundFile: vi.fn() } },
}));

import { ProjectState, type Project } from "@/core/Project";
import type { DocChangeSet } from "@/core/sqlite/DocClient";
import { serializeEntityToV3Record } from "@/core/sqlite/V3Serializer";
import { StageManager } from "@/core/stage/stageManager/StageManager";
import { GraphMethods } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import { SectionMethods } from "@/core/stage/stageManager/basicMethods/SectionMethods";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { createDefaultMetadata } from "@/types/metadata";
import { createDefaultTableData } from "@/types/table";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { applyIncomingDocChangeSet, LocalDocumentSync } from "./LocalDocumentSync";

function createWindowProject(docId = "doc-sync-1"): Project {
  const services = new Map<string, unknown>();
  const project: any = {
    stage: [],
    attachments: new Map<string, Blob>(),
    table: createDefaultTableData(),
    tags: [],
    references: { sections: {}, files: [] },
    metadata: createDefaultMetadata("3.0.0"),
    readme: undefined,
    docIdNeedsSave: false,
    projectState: ProjectState.Saved,
    closing: false,
    isSqliteV3: true,
    v3DocId: docId,
    v3Revision: 1,
    stageRevision: 0,
    bumpStageRevision: () => {
      project.stageRevision++;
    },
    getService: (id: string) => services.get(id),
    renderer: { tick: vi.fn() },
    loop: vi.fn(),
    tagManager: { reset: vi.fn() },
    stageTable: {
      notifyChange: vi.fn(),
      scheduleCanvasSelectionSync: vi.fn(),
    },
    textNodeRenderer: { renderTextNode: vi.fn() },
    sectionCollisionSolver: { solveOverlaps: vi.fn() },
  };
  const register = <T>(id: string, inst: T): T => {
    services.set(id, inst);
    project[id] = inst;
    return inst;
  };
  register("sectionMethods", new SectionMethods(project));
  register("graphMethods", new GraphMethods(project));
  register("stageManager", new StageManager(project));
  services.set("stageTable", project.stageTable);
  services.set("renderer", project.renderer);
  return project as Project;
}

function emptyChangeSet(overrides: Partial<DocChangeSet>): DocChangeSet {
  return {
    docId: "doc-sync-1",
    canonicalPath: "D:/vault/demo.prg",
    revision: 2,
    originWindow: "window-a",
    source: "command",
    dirtyEntities: [],
    deletedEntityUuids: [],
    dirtyEdges: [],
    deletedEdgeUuids: [],
    dirtyAssociations: [],
    deletedAssociationUuids: [],
    dirtyCells: [],
    deletedCells: [],
    schemaChanged: false,
    tableColumns: null,
    tableViews: null,
    tableMetaJson: null,
    metadataChanged: false,
    tags: null,
    references: null,
    readme: undefined,
    canUndo: true,
    canRedo: false,
    undoCursor: 1,
    ...overrides,
  };
}

describe("LocalDocumentSync (M2 pg-doc-changeset hot patch)", () => {
  it("preserves local selection, active editing TextNode, and untouched ImageNode instances/bitmaps", () => {
    const windowB = createWindowProject();
    const editingNode = new TextNode(windowB, {
      uuid: "node-editing",
      text: "Typing locally in Window B...",
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(120, 40))]),
    });
    editingNode.isEditing = true;
    editingNode.isSelected = true;

    const peerNode = new TextNode(windowB, {
      uuid: "node-peer",
      text: "Before",
      collisionBox: new CollisionBox([new Rectangle(new Vector(200, 0), new Vector(120, 40))]),
    });

    const imageNode = new ImageNode(windowB, {
      uuid: "img-untouched",
      attachmentId: "att-1",
      collisionBox: new CollisionBox([new Rectangle(new Vector(50, 80), new Vector(100, 100))]),
      deferBitmapLoad: true,
    });
    const fakeBitmap = { width: 100, height: 100, close: vi.fn() } as unknown as ImageBitmap;
    imageNode.bitmap = fakeBitmap;
    imageNode.state = "success";

    const section = new Section(windowB, {
      uuid: "sec-1",
      text: "Group",
      children: [editingNode, imageNode],
      collisionBox: new CollisionBox([new Rectangle(new Vector(-10, -10), new Vector(300, 220))]),
    });
    const edge = new LineEdge(windowB, {
      uuid: "edge-1",
      associationList: [editingNode, peerNode],
    });
    windowB.stage.push(editingNode, peerNode, imageNode, section, edge);
    windowB.stageManager.updateReferences();

    // 模拟 Window A 修改了 peerNode 和 editingNode（但 Window B 正在编辑 editingNode）
    const updatedPeer = serializeEntityToV3Record(peerNode, 1)!;
    updatedPeer.text = "After From Window A";
    updatedPeer.updatedAt = 2000;

    const updatedEditing = serializeEntityToV3Record(editingNode, 0)!;
    updatedEditing.text = "Remote Overwrite Attempt";

    const applied = applyIncomingDocChangeSet(
      windowB,
      emptyChangeSet({
        revision: 2,
        originWindow: "window-a",
        dirtyEntities: [updatedPeer, updatedEditing],
        dirtyCells: [
          {
            entityUuid: peerNode.uuid,
            colId: "col_score",
            valType: "number",
            valText: null,
            valNum: 99,
            valDate: null,
            valJson: null,
            canonicalKey: "num:99",
            multiOptions: [],
          },
        ],
      }),
      "window-b",
    );

    expect(applied).toBe(true);
    expect(windowB.v3Revision).toBe(2);
    expect(windowB.stageManager.get(editingNode.uuid)).toBe(editingNode);
    expect(editingNode.isEditing).toBe(true);
    expect(editingNode.isSelected).toBe(true);
    expect(editingNode.text).toBe("Typing locally in Window B...");

    expect(windowB.stageManager.get(peerNode.uuid)).toBe(peerNode);
    expect(peerNode.text).toBe("After From Window A");
    expect(peerNode.tableFields.col_score).toBe(99);
    expect(peerNode.isSelected).toBe(false);

    // 未变动的 ImageNode 保持原对象且 ImageBitmap 未被关闭/销毁
    expect(windowB.stageManager.get(imageNode.uuid)).toBe(imageNode);
    expect(imageNode.bitmap).toBe(fakeBitmap);
    expect(fakeBitmap.close as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    // 立即重绘非聚焦窗口一帧
    expect(windowB.renderer.tick).toHaveBeenCalledWith(true);
  });

  it("ignores changesets originating from the same window or stale revisions", () => {
    const windowA = createWindowProject();
    windowA.v3Revision = 5;
    LocalDocumentSync.attach(windowA, "D:/vault/demo.prg");

    expect(
      LocalDocumentSync.handleIncomingChangeSet(emptyChangeSet({ revision: 6, originWindow: "window-a" }), "window-a"),
    ).toBe(false);
    expect(windowA.v3Revision).toBe(6);

    expect(
      LocalDocumentSync.handleIncomingChangeSet(emptyChangeSet({ revision: 6, originWindow: "window-b" }), "window-a"),
    ).toBe(false);

    LocalDocumentSync.detach(windowA);
  });

  it("applies a 5,000-node dual-window single-cell changeset in < 5ms without touching other nodes", () => {
    const windowB = createWindowProject("doc-perf-5k");
    for (let i = 0; i < 5000; i++) {
      windowB.stage.push(
        new TextNode(windowB, {
          uuid: `node-${i}`,
          text: `Node ${i}`,
          createdAt: 1000,
          updatedAt: 1000,
          collisionBox: new CollisionBox([
            new Rectangle(new Vector((i % 100) * 180, Math.floor(i / 100) * 90), new Vector(120, 44)),
          ]),
        }),
      );
    }
    windowB.stageManager.updateReferences();

    const target = windowB.stageManager.get("node-4999") as TextNode;
    const dirtyRec = serializeEntityToV3Record(target, 4999)!;
    dirtyRec.text = "Synced From Window A";
    dirtyRec.updatedAt = 999999;

    const cs = emptyChangeSet({
      docId: "doc-perf-5k",
      revision: 2,
      originWindow: "window-a",
      dirtyEntities: [dirtyRec],
      dirtyCells: [
        {
          entityUuid: "node-4999",
          colId: "col_status",
          valType: "text",
          valText: "done",
          valNum: null,
          valDate: null,
          valJson: null,
          canonicalKey: "text:done",
          multiOptions: [],
        },
      ],
    });

    const t0 = performance.now();
    const applied = applyIncomingDocChangeSet(windowB, cs, "window-b");
    const elapsedMs = performance.now() - t0;

    expect(applied).toBe(true);
    expect(target.text).toBe("Synced From Window A");
    expect(target.tableFields.col_status).toBe("done");
    expect(elapsedMs).toBeLessThan(5);
  });
});
