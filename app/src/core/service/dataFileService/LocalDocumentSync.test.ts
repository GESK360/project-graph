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
  ProjectState: { Saved: "saved", Stashed: "stashed", Unsaved: "unsaved" },
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
    getTextSize: vi.fn((text: string) => new Vector(text.length * 12, 24)),
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
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

import { ProjectState, type Project } from "@/core/Project";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { PenStroke, PenStrokeSegment } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { createDefaultMetadata } from "@/types/metadata";
import { createDefaultTableData } from "@/types/table";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { serialize } from "@graphif/serializer";
import {
  applyUuidStagePatch,
  canonicalJsonStringify,
  computeUuidStageDiff,
  exportLiveDocumentSnapshot,
  hydrateProjectFromSnapshot,
  reconcileProjectStage,
  serializedStageArrayToUuidDoc,
  serializeStageToUuidDoc,
  uuidDocToSerializerArray,
} from "./LocalDocumentSync";

function sortJsonKeysRecursively<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonKeysRecursively(item)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJsonKeysRecursively((value as Record<string, unknown>)[key]);
    }
    return sorted as T;
  }
  return value;
}

function createMockProject(): Project {
  const project = {
    stage: [] as any[],
    attachments: new Map<string, Blob>(),
    table: createDefaultTableData(),
    tags: [] as string[],
    references: { sections: {}, files: [] },
    metadata: createDefaultMetadata("2.8.0"),
    readme: undefined as string | undefined,
    docIdNeedsSave: false,
    projectState: ProjectState.Saved,
    getService: vi.fn(() => undefined),
    stageManager: {
      updateReferences: vi.fn(),
      getAssociations: vi.fn(() => []),
    },
    tagManager: {
      reset: vi.fn(),
    },
    stageTable: {
      flushPendingTimestamps: vi.fn(),
      resetAfterStageRestore: vi.fn(),
      scheduleCanvasSelectionSync: vi.fn(),
    },
    textNodeRenderer: {
      renderTextNode: vi.fn(),
    },
  };
  return project as unknown as Project;
}

describe("LocalDocumentSync", () => {
  it("converts serialized stage arrays to uuid docs and back while preserving references", () => {
    const rawStage = [
      { _: "TextNode", uuid: "node-a", text: "A" },
      { _: "TextNode", uuid: "node-b", text: "B" },
      { _: "LineEdge", uuid: "edge-1", associationList: [{ $: "/0" }, { $: "/1" }] },
    ];

    const doc = serializedStageArrayToUuidDoc(rawStage);
    expect(doc.order).toEqual(["node-a", "node-b", "edge-1"]);
    expect(doc.objects["edge-1"].associationList).toEqual([{ $u: "node-a" }, { $u: "node-b" }]);

    const restored = uuidDocToSerializerArray(doc);
    expect(restored[2].associationList).toEqual([{ $: "/0" }, { $: "/1" }]);
  });

  it("keeps stage objects whose first serialized occurrence is nested in a section", async () => {
    const project = createMockProject();
    const child = new TextNode(project, {
      uuid: "11111111-1111-4111-8111-111111111111",
      text: "Nested child",
      collisionBox: new CollisionBox([new Rectangle(new Vector(20, 30), new Vector(120, 40))]),
    });
    const peer = new TextNode(project, {
      uuid: "22222222-2222-4222-8222-222222222222",
      text: "Peer",
      collisionBox: new CollisionBox([new Rectangle(new Vector(220, 30), new Vector(120, 40))]),
    });
    const section = new Section(project, {
      uuid: "33333333-3333-4333-8333-333333333333",
      text: "Group",
      children: [child],
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(400, 200))]),
    });
    const edge = new LineEdge(project, {
      uuid: "44444444-4444-4444-8444-444444444444",
      associationList: [child, peer],
    });
    const stage = [section, child, peer, edge];

    const serializedStage = serialize(stage) as unknown[];
    expect(serializedStage[1]).toEqual({ $: "/0/children/0" });

    const doc = serializeStageToUuidDoc(stage);
    expect(doc.order).toEqual([section.uuid, child.uuid, peer.uuid, edge.uuid]);
    expect(doc.objects[section.uuid].children).toEqual([{ $u: child.uuid }]);

    reconcileProjectStage(project, doc, new Set(doc.order));
    const restored = project.stage as Array<Section | TextNode | LineEdge>;
    const restoredSection = restored.find((item) => item.uuid === section.uuid) as Section;
    const restoredChild = restored.find((item) => item.uuid === child.uuid) as TextNode;
    const restoredEdge = restored.find((item) => item.uuid === edge.uuid) as LineEdge;

    expect(restoredSection.children).toContain(restoredChild);
    expect(restoredChild.collisionBox.getRectangle()).toBeInstanceOf(Rectangle);
    expect(restoredEdge.associationList).toContain(restoredChild);

    const snapshot = await exportLiveDocumentSnapshot(project);
    const target = createMockProject();
    hydrateProjectFromSnapshot(target, snapshot);
    const hydrated = target.stage as Array<Section | TextNode | LineEdge>;
    const hydratedSection = hydrated.find((item) => item.uuid === section.uuid) as Section;
    const hydratedChild = hydrated.find((item) => item.uuid === child.uuid) as TextNode;
    const hydratedEdge = hydrated.find((item) => item.uuid === edge.uuid) as LineEdge;

    expect(hydratedSection.children).toContain(hydratedChild);
    expect(hydratedChild.collisionBox.getRectangle()).toBeInstanceOf(Rectangle);
    expect(hydratedEdge.associationList).toContain(hydratedChild);
  });

  it("computes minimal per-uuid diffs without marking untouched nodes or pen strokes dirty", () => {
    const project = createMockProject();
    const nodeA = new TextNode(project, {
      uuid: "11111111-1111-4111-8111-111111111111",
      text: "Alpha",
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(100, 40))]),
    });
    const nodeB = new TextNode(project, {
      uuid: "22222222-2222-4222-8222-222222222222",
      text: "Beta",
      collisionBox: new CollisionBox([new Rectangle(new Vector(200, 0), new Vector(100, 40))]),
    });
    const stroke = new PenStroke(project, {
      uuid: "33333333-3333-4333-8333-333333333333",
      segments: [new PenStrokeSegment(new Vector(0, 0), 0.5), new PenStrokeSegment(new Vector(10, 20), 0.7)],
      color: Color.Red,
      width: 4,
    });
    project.stage = [nodeA, nodeB, stroke];

    const doc1 = serializeStageToUuidDoc(project.stage);
    const strings1 = new Map<string, string>();
    for (const uuid of doc1.order) {
      strings1.set(uuid, canonicalJsonStringify(doc1.objects[uuid]));
    }

    // 只修改 nodeA 文本，新增一条涂鸦
    nodeA.text = "Alpha Updated";
    const stroke2 = new PenStroke(project, {
      uuid: "44444444-4444-4444-8444-444444444444",
      segments: [new PenStrokeSegment(new Vector(5, 5), 1), new PenStrokeSegment(new Vector(15, 25), 1)],
      color: Color.Blue,
      width: 3,
    });
    project.stage.push(stroke2);

    const doc2 = serializeStageToUuidDoc(project.stage);
    const diff = computeUuidStageDiff(strings1, doc1.order, doc2);

    expect(Object.keys(diff.upserted).sort()).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(diff.removed).toEqual([]);
    expect(diff.orderChanged).toBe(true);

    const { nextDoc, dirtyUuids } = applyUuidStagePatch(doc1, {
      upserted: diff.upserted,
      removed: diff.removed,
      order: doc2.order,
    });
    expect(nextDoc.order).toEqual(doc2.order);
    expect(dirtyUuids.has("22222222-2222-4222-8222-222222222222")).toBe(false);
    expect(dirtyUuids.has("33333333-3333-4333-8333-333333333333")).toBe(false);
  });

  it("preserves per-window selection, untouched ImageNode instances, and actively editing TextNode during reconcile", () => {
    const project = createMockProject();
    const editingNode = new TextNode(project, {
      uuid: "aaaa1111-1111-4111-8111-111111111111",
      text: "Typing in Window B...",
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(120, 40))]),
    });
    editingNode.isEditing = true;
    editingNode.isSelected = true;

    const peerNode = new TextNode(project, {
      uuid: "bbbb2222-2222-4222-8222-222222222222",
      text: "Before",
      collisionBox: new CollisionBox([new Rectangle(new Vector(200, 0), new Vector(120, 40))]),
    });

    const imageNode = new ImageNode(project, {
      uuid: "cccc3333-3333-4333-8333-333333333333",
      attachmentId: "att-img-1",
      collisionBox: new CollisionBox([new Rectangle(new Vector(50, 50), new Vector(100, 100))]),
    });

    const section = new Section(project, {
      uuid: "dddd4444-4444-4444-8444-444444444444",
      text: "Group",
      children: [editingNode, imageNode],
      collisionBox: new CollisionBox([new Rectangle(new Vector(-10, -10), new Vector(300, 200))]),
    });
    const edge = new LineEdge(project, {
      uuid: "eeee5555-5555-4555-8555-555555555555",
      associationList: [editingNode, peerNode],
    });

    project.stage = [editingNode, peerNode, imageNode, section, edge];
    const baseDoc = serializeStageToUuidDoc(project.stage);

    // 模拟另一窗口修改了 peerNode 的文字
    const updatedPeer = structuredClone(baseDoc.objects[peerNode.uuid]);
    updatedPeer.text = "After From Window A";
    const { nextDoc, dirtyUuids } = applyUuidStagePatch(baseDoc, {
      upserted: { [peerNode.uuid]: updatedPeer },
    });

    reconcileProjectStage(project, nextDoc, dirtyUuids);

    const syncedEditing = project.stage.find((o) => o.uuid === editingNode.uuid) as TextNode;
    const syncedPeer = project.stage.find((o) => o.uuid === peerNode.uuid) as TextNode;
    const syncedImage = project.stage.find((o) => o.uuid === imageNode.uuid) as ImageNode;
    const syncedSection = project.stage.find((o) => o.uuid === section.uuid) as Section;
    const syncedEdge = project.stage.find((o) => o.uuid === edge.uuid) as LineEdge;

    expect(syncedEditing).toBe(editingNode);
    expect(syncedEditing.isEditing).toBe(true);
    expect(syncedEditing.isSelected).toBe(true);
    expect(syncedImage).toBe(imageNode);
    expect(syncedPeer.text).toBe("After From Window A");
    expect(syncedPeer.isSelected).toBe(false);
    expect(syncedSection.children).toContain(editingNode);
    expect(syncedSection.children).toContain(imageNode);
    expect(syncedEdge.source).toBe(editingNode);
    expect(syncedEdge.target).toBe(syncedPeer);
  });

  it("exports and hydrates full live unsaved snapshot including attachments, table, tags, and state", async () => {
    const source = createMockProject();
    const node = new TextNode(source, {
      uuid: "99999999-9999-4999-8999-999999999999",
      text: "Unsaved Live Note",
      collisionBox: new CollisionBox([new Rectangle(new Vector(10, 20), new Vector(140, 50))]),
    });
    source.stage = [node];
    source.tags = [node.uuid];
    source.readme = "Hello multi-window";
    source.projectState = ProjectState.Unsaved;
    source.docIdNeedsSave = true;
    source.attachments.set("att-1", new Blob(["hello-image-bytes"], { type: "image/png" }));

    const snapshot = await exportLiveDocumentSnapshot(source);

    const target = createMockProject();
    hydrateProjectFromSnapshot(target, snapshot);

    expect(target.stage).toHaveLength(1);
    expect((target.stage[0] as TextNode).text).toBe("Unsaved Live Note");
    expect(target.tags).toEqual([node.uuid]);
    expect(target.readme).toBe("Hello multi-window");
    expect(target.projectState).toBe(ProjectState.Unsaved);
    expect(target.docIdNeedsSave).toBe(true);
    expect(target.attachments.has("att-1")).toBe(true);
    expect(target.attachments.get("att-1")?.type).toBe("image/png");
    expect(await target.attachments.get("att-1")?.text()).toBe("hello-image-bytes");
  });

  it("preserves exact PenStroke and TextNode colors across Rust serde_json alphabetical key sorting in patches and snapshots", async () => {
    const window1 = createMockProject();
    const blueStroke = new PenStroke(window1, {
      uuid: "10101010-1010-4010-8010-101010101010",
      segments: [new PenStrokeSegment(new Vector(10, 20), 1), new PenStrokeSegment(new Vector(80, 90), 0.8)],
      color: Color.fromCss("#2563EB"),
      width: 5,
    });
    const redStroke = new PenStroke(window1, {
      uuid: "20202020-2020-4020-8020-202020202020",
      segments: [new PenStrokeSegment(new Vector(30, 40), 1), new PenStrokeSegment(new Vector(120, 140), 1)],
      color: Color.fromCss("#EF4444"),
      width: 8,
    });
    const blackStroke = new PenStroke(window1, {
      uuid: "30303030-3030-4030-8030-303030303030",
      segments: [new PenStrokeSegment(new Vector(0, 0), 1), new PenStrokeSegment(new Vector(50, 50), 1)],
      color: Color.fromCss("#000000"),
      width: 3,
    });
    const coloredNode = new TextNode(window1, {
      uuid: "40404040-4040-4040-8040-404040404040",
      text: "Colored",
      color: Color.fromCss("#F97316"),
      collisionBox: new CollisionBox([new Rectangle(new Vector(100, 100), new Vector(120, 40))]),
    });
    window1.stage = [blueStroke, redStroke, blackStroke, coloredNode];

    // 1. 模拟“在新窗口中打开”时经 Rust serde_json::Value(BTreeMap) 字典序重排的快照同步
    const snapshot = await exportLiveDocumentSnapshot(window1);
    const rustSortedSnapshot = sortJsonKeysRecursively(snapshot);

    const window2 = createMockProject();
    hydrateProjectFromSnapshot(window2, rustSortedSnapshot);

    const w2Blue = window2.stage.find((o) => o.uuid === blueStroke.uuid) as PenStroke;
    const w2Red = window2.stage.find((o) => o.uuid === redStroke.uuid) as PenStroke;
    const w2Black = window2.stage.find((o) => o.uuid === blackStroke.uuid) as PenStroke;
    const w2Node = window2.stage.find((o) => o.uuid === coloredNode.uuid) as TextNode;

    expect(w2Blue.color.toArray()).toEqual([37, 99, 235, 1]);
    expect(w2Red.color.toArray()).toEqual([239, 68, 68, 1]);
    expect(w2Black.color.toArray()).toEqual([0, 0, 0, 1]);
    expect(w2Node.color.toArray()).toEqual([249, 115, 22, 1]);

    // 2. 模拟实时绘制新笔迹后经 Rust serde_json::Value 广播的增量 patch 同步
    const baseDoc = serializeStageToUuidDoc(window1.stage);
    const baseStrings = new Map<string, string>();
    for (const uuid of baseDoc.order) {
      baseStrings.set(uuid, canonicalJsonStringify(baseDoc.objects[uuid]));
    }

    const greenStroke = new PenStroke(window1, {
      uuid: "50505050-5050-4050-8050-505050505050",
      segments: [new PenStrokeSegment(new Vector(15, 25), 1), new PenStrokeSegment(new Vector(75, 95), 0.6)],
      color: Color.fromCss("#22C55E"),
      width: 6,
    });
    window1.stage.push(greenStroke);

    const nextDocFromW1 = serializeStageToUuidDoc(window1.stage);
    const diffFromW1 = computeUuidStageDiff(baseStrings, baseDoc.order, nextDocFromW1);
    const rustSortedPatch = sortJsonKeysRecursively({
      upserted: diffFromW1.upserted,
      removed: diffFromW1.removed,
      order: nextDocFromW1.order,
    });

    const { nextDoc: w2NextDoc, dirtyUuids } = applyUuidStagePatch(baseDoc, rustSortedPatch);
    reconcileProjectStage(window2, w2NextDoc, dirtyUuids);

    const w2Green = window2.stage.find((o) => o.uuid === greenStroke.uuid) as PenStroke;
    expect(w2Green.color.toArray()).toEqual([34, 197, 94, 1]);

    // 3. 验证窗口 2 接收字典序重排的 patch 后，再次 diff 不会把未改动笔迹误判为脏对象
    const w2ShadowStrings = new Map<string, string>(baseStrings);
    for (const [uuid, obj] of Object.entries(rustSortedPatch.upserted)) {
      w2ShadowStrings.set(uuid, canonicalJsonStringify(obj));
    }
    const w2Reserialized = serializeStageToUuidDoc(window2.stage);
    const w2Diff = computeUuidStageDiff(w2ShadowStrings, w2NextDoc.order, w2Reserialized);
    expect(Object.keys(w2Diff.upserted)).toEqual([]);
    expect(w2Diff.removed).toEqual([]);
    expect(w2Diff.orderChanged).toBe(false);
  });
});
