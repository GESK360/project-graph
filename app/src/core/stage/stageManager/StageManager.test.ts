import { describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: "saved", Unsaved: "unsaved" },
  service: (id: string) => (target: { id?: string }) => {
    target.id = id;
    return target;
  },
}));
vi.mock("@/core/render/canvas2d/renderer", () => ({
  Renderer: { FONT_SIZE: 24, NODE_PADDING: 10 },
}));
vi.mock("@/core/service/Settings", () => ({ Settings: { watch: vi.fn(), lineStyle: "bezier" } }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: {} }));
vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => new Vector(20, 20),
  getTextSize: () => new Vector(20, 20),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { StageManager } from "./StageManager";
import { VerticalPolyEdgeRenderer } from "@/core/render/canvas2d/entityRenderer/edge/concrete/VerticalPolyEdgeRenderer";
import { Settings } from "@/core/service/Settings";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { Direction } from "@/types/directions";
import { findHiddenBranchNodes, getBranchSize } from "./basicMethods/BranchCollapse";

function createStageManager(stage: object[]) {
  return new StageManager({ stage } as never);
}

function textNode(uuid: string, x = 0, y = 0): TextNode {
  return Object.assign(Object.create(TextNode.prototype), {
    uuid,
    collisionBox: new CollisionBox([new Rectangle(new Vector(x, y), new Vector(100, 80))]),
    unknown: false,
  }) as TextNode;
}

/** 反序列化过程中尚未加载的占位节点：uuid 已知、unknown 为 true */
function unknownEntity(uuid: string): TextNode {
  return Object.assign(Object.create(TextNode.prototype), {
    uuid,
    collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(100, 80))]),
    unknown: true,
  }) as TextNode;
}

function section(uuid: string, children: Entity[]): Section {
  const collisionBox = new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(300, 200))]);
  return Object.assign(Object.create(Section.prototype), {
    uuid,
    text: "",
    children,
    isCollapsed: false,
    locked: false,
    unknown: false,
    // Section.collisionBox 是 getter，读取这两个内部字段
    _collisionBoxNormal: collisionBox,
    _collisionBoxWhenCollapsed: collisionBox,
    adjustLocationAndSize: () => {},
    adjustChildrenStateByCollapse: () => {},
  }) as Section;
}

function lineEdge(associationList: ConnectableEntity[], uuid = crypto.randomUUID()): LineEdge {
  return new LineEdge({} as never, { associationList, uuid });
}

describe("StageManager.updateReferences", () => {
  it("replaces unknown edge endpoints with the real entities on stage", () => {
    const source = textNode("source-uuid", 0, 0);
    const target = textNode("target-uuid", 300, 0);
    const edge = lineEdge([unknownEntity("source-uuid"), unknownEntity("target-uuid")]);
    const manager = createStageManager([source, target, edge]);

    manager.updateReferences();

    expect(edge.source).toBe(source);
    expect(edge.target).toBe(target);
    expect(edge.source.unknown).toBe(false);
  });

  it("only replaces the endpoint that is still unknown", () => {
    const source = textNode("source-uuid");
    const edge = lineEdge([source, unknownEntity("target-uuid")]);
    const target = textNode("target-uuid");
    const manager = createStageManager([source, target, edge]);

    manager.updateReferences();

    expect(edge.source).toBe(source);
    expect(edge.target).toBe(target);
  });

  it("keeps unknown endpoints whose uuid is not on stage", () => {
    const edge = lineEdge([unknownEntity("source-uuid"), unknownEntity("missing-uuid")]);
    const manager = createStageManager([textNode("source-uuid"), edge]);

    manager.updateReferences();

    expect(edge.source.unknown).toBe(false);
    expect(edge.target.unknown).toBe(true);
  });

  it("does not resolve endpoints against entities that cannot be connected", () => {
    // PenStroke 是 Entity 但不是 ConnectableEntity，不能作为 Edge 端点
    const penStroke = Object.assign(Object.create(PenStroke.prototype), {
      uuid: "pen-uuid",
      collisionBox: new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(100, 80))]),
    }) as PenStroke;
    const edge = lineEdge([unknownEntity("pen-uuid"), unknownEntity("other-uuid")]);
    const manager = createStageManager([penStroke, edge]);

    manager.updateReferences();

    expect(edge.source.unknown).toBe(true);
  });

  it("rebuilds the section runtime tree", () => {
    const node = textNode("node-uuid", 10, 10);
    const sectionObject = section("section-uuid", [node]);
    const manager = createStageManager([sectionObject, node]);

    manager.updateReferences();

    expect(sectionObject.children).toEqual([node]);
    expect(node.parentSection).toBe(sectionObject);
    expect(manager.getRootSections()).toEqual([sectionObject]);
    expect(manager.getTopLevelEntities()).toEqual([sectionObject]);
    expect(node.sectionDepth).toBe(1);
  });

  it("assigns symmetric shifting indexes to multi-edges of the same geometry group", () => {
    const source = textNode("a", 0, 0);
    const target = textNode("b", 300, 0);
    const first = lineEdge([source, target], "11111111-1111-1111-1111-111111111111");
    const second = lineEdge([target, source], "22222222-2222-2222-2222-222222222222");
    const selfLoop = lineEdge([source, source], "33333333-3333-3333-3333-333333333333");
    const manager = createStageManager([source, target, first, second, selfLoop]);

    manager.updateReferences();

    expect([first.shiftingIndex, second.shiftingIndex].sort()).toEqual([-1, 1]);
    expect(selfLoop.shiftingIndex).toBe(0);
  });

  it("scans the association list once regardless of entity count", () => {
    // 回归护栏：修复前每个实体都会触发一次全量关系扫描，调用次数随实体数线性增长（O(N*E)）
    const stage: object[] = [];
    for (let i = 0; i < 200; i++) {
      const node = textNode(`node-${i}`, i, 0);
      stage.push(node, lineEdge([node, node]));
    }
    const manager = createStageManager(stage);
    const associationsSpy = vi.spyOn(StageManager.prototype, "getAssociations");

    manager.updateReferences();

    expect(associationsSpy).toHaveBeenCalledOnce();
    associationsSpy.mockRestore();
  });
});

describe("branch folding", () => {
  const createFoldingManager = (stage: object[], recordStep = vi.fn()) => {
    const manager = new StageManager({
      stage,
      camera: { currentScale: 1 },
      renderer: { transformWorld2View: (point: Vector) => point, transformView2World: (point: Vector) => point },
      verticalPolyEdgeRenderer: new VerticalPolyEdgeRenderer({} as never),
      sectionMethods: {
        isEntityHiddenByBigTitleSection: () => false,
        isObjectBeLockedBySection: () => false,
        isAssociationHiddenByBigTitleSection: () => false,
      },
      historyManager: { recordStep },
    } as never);
    manager.updateReferences();
    return manager;
  };

  it("shows the minus only at a hovered junction and leaves the line body clickable", () => {
    const root = textNode("root");
    const child = textNode("child", 250);
    const sibling = textNode("sibling", 0, 250);
    const horizontal = lineEdge([root, child]);
    const vertical = lineEdge([root, sibling]);
    const manager = createFoldingManager([root, child, sibling, horizontal, vertical]);
    expect(manager.getBranchFoldBadges()).toEqual([]);
    expect(manager.getBranchFoldBadges(new Vector(175, 170))).toEqual([]);
    const rightJunction = horizontal.bodyLine.start.add(new Vector(9, 0));
    expect(manager.getBranchFoldBadges(rightJunction)).toEqual([
      {
        source: root,
        side: Direction.Right,
        center: rightJunction,
        radius: 8,
        count: undefined,
        origin: horizontal.bodyLine.start,
      },
    ]);
    expect(manager.findBranchFoldBadge(rightJunction, rightJunction)).toMatchObject({
      source: root,
      side: Direction.Right,
    });
    const lineBody = horizontal.bodyLine.midPoint();
    expect(manager.getBranchFoldBadges(lineBody)).toEqual([]);
    expect(manager.findBranchFoldBadge(lineBody, rightJunction)).toBeUndefined();
    const lowerJunction = vertical.bodyLine.start.add(new Vector(0, 9));
    expect(manager.findBranchFoldBadge(lowerJunction, lowerJunction)).toMatchObject({
      source: root,
      side: Direction.Down,
    });
  });

  it("uses the source junction of an orthogonal edge", () => {
    const root = textNode("root");
    const child = textNode("child", 400, 160);
    const edge = lineEdge([root, child]);
    const manager = createFoldingManager([root, child, edge]);
    const settings = Settings.lineStyle;
    Settings.lineStyle = "vertical";
    try {
      const [origin, turn] = new VerticalPolyEdgeRenderer({} as never).getPolyline(edge).points;
      const pointer = origin.add(new Vector(9, 0));
      expect(manager.getBranchFoldBadges(pointer)[0]).toMatchObject({ source: root, side: Direction.Right, origin });
      expect(manager.getBranchFoldBadges(turn)).toEqual([]);
      manager.toggleBranchCollapse({ source: root, side: Direction.Right });
      expect(manager.getBranchFoldBadges()[0].origin).toEqual(origin);
    } finally {
      Settings.lineStyle = settings;
    }
  });

  it("folds all children on one side, counts unique descendants, and keeps other sides open", () => {
    const root = textNode("root");
    const child = textNode("child", 250);
    const sibling = textNode("sibling", 250, 140);
    const otherSide = textNode("otherSide", -250);
    const grandchild = textNode("grandchild", 500);
    const reference = textNode("reference", 250, 200);
    const branch = lineEdge([root, child]);
    const siblingBranch = lineEdge([root, sibling]);
    branch.sourceRectangleRate = siblingBranch.sourceRectangleRate = new Vector(0.99, 0.5);
    const otherBranch = lineEdge([root, otherSide]);
    const nested = lineEdge([child, grandchild]);
    const shared = lineEdge([sibling, grandchild]);
    const dashed = lineEdge([root, reference]);
    dashed.lineType = "dashed";
    const stage = [
      root,
      child,
      sibling,
      otherSide,
      grandchild,
      reference,
      branch,
      siblingBranch,
      otherBranch,
      nested,
      shared,
      dashed,
    ];
    const recordStep = vi.fn();
    const manager = createFoldingManager(stage, recordStep);

    manager.toggleBranchCollapse({ source: child, side: Direction.Right });
    manager.toggleBranchCollapse({ source: sibling, side: Direction.Right });
    child.isSelected = branch.isSelected = true;
    manager.toggleBranchCollapse({ source: root, side: Direction.Right });
    const badges = manager.getBranchFoldBadges();
    expect(badges).toHaveLength(1);
    const [badge] = badges;
    expect(badge.count).toBe(3);
    expect(manager.findBranchFoldBadge(badge.center)).toMatchObject({ source: root, side: Direction.Right });
    expect(manager.findTextNodeByLocation(child.geometryCenter)).toBeNull();
    expect(manager.isHiddenByBranchCollapse(branch)).toBe(true);
    expect(manager.isHiddenByBranchCollapse(nested)).toBe(true);
    expect(manager.isHiddenByBranchCollapse(reference)).toBe(false);
    expect(manager.isHiddenByBranchCollapse(siblingBranch)).toBe(true);
    expect(manager.isHiddenByBranchCollapse(otherBranch)).toBe(false);
    expect(child.isSelected).toBe(false);
    expect(branch.isSelected).toBe(false);

    manager.toggleBranchCollapse({ source: root, side: Direction.Right });
    expect(manager.findTextNodeByLocation(child.geometryCenter)).toBe(child);
    expect(manager.isHiddenByBranchCollapse(branch)).toBe(false);
    expect(manager.isHiddenByBranchCollapse(grandchild)).toBe(true);
    expect(manager.getLineEdges()).toHaveLength(6);
    expect(recordStep).toHaveBeenCalledTimes(4);
  });

  it("merges old node folds into a single count for the side", () => {
    const root = textNode("root");
    root.legacyBranchCollapsed = true;
    const child = textNode("child", 250);
    const sibling = textNode("sibling", 250, 130);
    const first = lineEdge([root, child]);
    const second = lineEdge([root, sibling]);
    first.sourceRectangleRate = second.sourceRectangleRate = new Vector(0.99, 0.5);
    const manager = createFoldingManager([root, child, sibling, first, second]);

    const badges = manager.getBranchFoldBadges();
    expect(badges).toHaveLength(1);
    expect(badges[0].count).toBe(2);
    expect(manager.findBranchFoldBadge(badges[0].center)).toMatchObject({ source: root, side: Direction.Right });
    manager.toggleBranchCollapse({ source: root, side: Direction.Right });
    manager.updateReferences();
    expect(first.isBranchCollapsed).toBe(false);
    expect(second.isBranchCollapsed).toBe(false);
    expect(manager.isHiddenByBranchCollapse(child)).toBe(false);
    expect(manager.isHiddenByBranchCollapse(sibling)).toBe(false);
  });

  it("folds parallel links together and counts their destination once", () => {
    const root = textNode("root");
    const child = textNode("child", 250);
    const first = lineEdge([root, child]);
    const second = lineEdge([root, child]);
    const manager = createFoldingManager([root, child, first, second]);

    manager.toggleBranchCollapse({ source: root, side: Direction.Right });
    expect(manager.isHiddenByBranchCollapse(first)).toBe(true);
    expect(manager.isHiddenByBranchCollapse(second)).toBe(true);
    expect(manager.isHiddenByBranchCollapse(child)).toBe(true);
    expect(manager.getBranchFoldBadges().map((badge) => badge.count)).toEqual([1]);
  });

  it("counts shared descendants once, preserves open routes, and excludes the source in cycles", () => {
    const link = (source: string, target: string, isBranchCollapsed = false) => ({ source, target, isBranchCollapsed });
    const folded = link("a", "b", true);
    const cycle = link("cycle", "loop", true);
    const outgoing = new Map([
      ["a", [folded]],
      ["b", [link("b", "c"), link("b", "d")]],
      ["d", [link("d", "c")]],
      ["other", [link("other", "c")]],
      ["cycle", [cycle]],
      ["loop", [link("loop", "cycle")]],
    ]);
    expect(findHiddenBranchNodes(outgoing, [folded, cycle])).toEqual(new Set(["b", "d", "loop"]));
    expect(getBranchSize(outgoing, folded.source, [folded.target])).toBe(3);
    expect(getBranchSize(outgoing, cycle.source, [cycle.target])).toBe(1);
  });
});
