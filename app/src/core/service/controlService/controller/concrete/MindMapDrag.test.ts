import type { Project } from "@/core/Project";
import { AutoLayoutFastTree } from "@/core/service/controlService/autoLayoutEngine/autoLayoutFastTreeMode";
import { KeyBindsUI } from "@/core/service/controlService/shortcutKeysEngine/KeyBindsUI";
import { Settings } from "@/core/service/Settings";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { GraphMethods } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import { SectionMethods } from "@/core/stage/stageManager/basicMethods/SectionMethods";
import { EntityMoveManager } from "@/core/stage/stageManager/concreteMethods/StageEntityMoveManager";
import { SectionInOutManager } from "@/core/stage/stageManager/concreteMethods/StageSectionInOutManager";
import { Direction } from "@/types/directions";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { describe, expect, it, vi } from "vitest";
import { ControllerEntityClickSelectAndMoveClass } from "./ControllerEntityClickSelectAndMove";
import { MindMapDrag } from "./MindMapDrag";

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => () => {} }));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    defaultEdgeArrowType: "default",
    mouseLeftMode: "selectAndMove",
    persistentDragToConnectMindMap: false,
    persistentDragToConnectMindMapAligned: false,
  },
}));
vi.mock("@/core/service/controlService/shortcutKeysEngine/KeyBindsUI", () => ({
  KeyBindsUI: { getUIKeyBind: vi.fn() },
}));
vi.mock("@/core/service/dataManageService/connectNodeSmartTools", () => ({ ConnectNodeSmartTools: {} }));
vi.mock("@/core/service/feedbackService/effectEngine/concrete/RectangleNoteEffect", () => ({
  RectangleNoteEffect: class {},
}));
vi.mock("@/core/service/feedbackService/effectEngine/concrete/RectangleRenderEffect", () => ({
  RectangleRenderEffect: class {},
}));
vi.mock("@/utils/platform", () => ({ isMac: false }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({ SoundService: {} }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/ConnectPoint", () => ({ ConnectPoint: class {} }));
vi.mock("@/core/stage/stageObject/association/MutiTargetUndirectedEdge", () => ({
  MultiTargetUndirectedEdge: class {},
}));
vi.mock("@/core/stage/stageObject/association/EdgeCollisionBoxGetter", () => ({ EdgeCollisionBoxGetter: {} }));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 32, NODE_PADDING: 14 } }));
vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => Vector.getZero(),
  getTextSize: () => new Vector(20, 20),
}));

function setup() {
  const nodes: ConnectableEntity[] = [];
  const sections: Section[] = [];
  const edges: LineEdge[] = [];
  const section = (...children: ConnectableEntity[]) => {
    const group = new Section(project, { text: "Group", children });
    sections.push(group);
    nodes.push(group);
    for (const child of children) child.parentSection = group;
    return group;
  };
  const node = (x: number, y: number, size = new Vector(40, 30)) => {
    const rect = new Rectangle(new Vector(x, y), size);
    const entity = Object.assign(Object.create(ConnectableEntity.prototype), {
      uuid: `node-${nodes.length}`,
      collisionBox: { getRectangle: () => rect.clone() },
      move: (offset: Vector) => (rect.location = rect.location.add(offset)),
      moveTo: (location: Vector) => (rect.location = location.clone()),
      parentSection: null,
    }) as ConnectableEntity;
    nodes.push(entity);
    return entity;
  };
  const parent = node(0, 0, new Vector(100, 80));
  const root = node(-300, -300);
  const recordStep = vi.fn();
  const updateReferences = vi.fn();
  const changeEdgesConnectLocation = vi.fn((edges: LineEdge[], direction: Direction, isSource = false) => {
    const rates = {
      [Direction.Up]: new Vector(0.5, 0.01),
      [Direction.Down]: new Vector(0.5, 0.99),
      [Direction.Left]: new Vector(0.01, 0.5),
      [Direction.Right]: new Vector(0.99, 0.5),
    };
    for (const edge of edges) {
      if (isSource) edge.sourceRectangleRate = rates[direction];
      else edge.targetRectangleRate = rates[direction];
    }
  });
  const pressingKeySet = new Set<string>();
  const project = {
    sectionMoveDepth: 0,
    camera: { currentScale: 1 },
    controller: { camera: {}, pressingKeySet, rectangleSelect: {}, cutting: {} },
    controllerUtils: { isClickedResizeRect: () => false, getClickedStageObject: () => root },
    renderer: { transformView2World: (view: Vector) => view },
    effects: { addMoveShadow: vi.fn() },
    historyManager: { recordStep },
    stageManager: {
      getStageObjects: () => [...nodes, ...edges],
      getEntities: () => nodes,
      getSections: () => sections,
      getRootSections: () => sections.filter((section) => section.parentSection === null),
      isHiddenByBranchCollapse: () => false,
      isHaveEntitySelected: () => nodes.some((node) => node.isSelected),
      getConnectableEntity: () => nodes,
      getEdges: () => edges,
      getLineEdges: () => edges,
      getAssociations: () => edges,
      changeEdgesConnectLocation,
      getConnectableEntityByUUID: (id: string) => nodes.find((node) => node.uuid === id),
      isEntityExists: (id: string) => nodes.some((node) => node.uuid === id),
      add: (edge: LineEdge) => {
        edges.push(edge);
        updateReferences();
      },
      delete: (edge: LineEdge) => edges.splice(edges.indexOf(edge), 1),
      updateReferences,
    },
  } as unknown as Project;
  Object.assign(project, {
    graphMethods: new GraphMethods(project),
    autoLayoutFastTree: new AutoLayoutFastTree(project),
    entityMoveManager: new EntityMoveManager(project),
    sectionMethods: new SectionMethods(project),
    sectionInOutManager: new SectionInOutManager(project),
  });
  return { project, parent, root, node, section, edges, recordStep, pressingKeySet, changeEdgesConnectLocation };
}

describe("mind-map drag", () => {
  it.each(["preserve", "align"] as const)("spaces and aligns the %s branch inside nested sections", (mode) => {
    const { project, parent, root, section, node, edges, recordStep } = setup();
    const child = node(-500, -300);
    const grandchild = node(-550, -400);
    const referenceOnly = node(-700, -600);
    const source = section(root, referenceOnly);
    const previousChildSection = section(child, grandchild);
    parent.move(new Vector(300, 100));
    const destination = section(parent);
    const neighboringSection = section(node(455, 205));
    const outerSection = section(destination, neighboringSection);
    const rootSection = section(outerSection, source, previousChildSection);
    const childEdge = new LineEdge(project, { associationList: [root, child] });
    const grandchildEdge = new LineEdge(project, { associationList: [child, grandchild] });
    const reference = new LineEdge(project, { associationList: [root, referenceOnly], lineType: "dashed" });
    edges.push(childEdge, grandchildEdge, reference);

    const drag = new MindMapDrag(project, root, new Vector(-300, -300), mode);
    const release = new Vector(411, 133);
    const ghostCenter = release.add(root.collisionBox.getRectangle().size.multiply(0.5));
    expect(project.sectionMethods.getInnermostSectionByLocation(ghostCenter)).toBe(neighboringSection);
    drag.update(release);
    expect(drag.preview?.contact).toEqual({ node: parent, side: "right" });
    drag.drop(release);

    expect(edges.at(-1)).toMatchObject({ associationList: [parent, root] });
    expect(edges.slice(0, -1)).toEqual([childEdge, grandchildEdge, reference]);
    expect(destination.children).toEqual([parent, root, child, grandchild]);
    for (const member of [root, child, grandchild]) expect(member.parentSection).toBe(destination);
    expect(outerSection.children).toEqual([destination, neighboringSection]);
    expect(rootSection.children).toEqual([outerSection, source, previousChildSection]);
    expect(source.children).toEqual([referenceOnly]);
    expect(previousChildSection.children).toEqual([]);
    const rootRect = root.collisionBox.getRectangle();
    const parentRect = parent.collisionBox.getRectangle();
    expect(rootRect.left - parentRect.right).toBeGreaterThanOrEqual(150);
    expect(rootRect.center.y).toBe(parentRect.center.y);
    expect(recordStep).toHaveBeenCalledOnce();
  });

  it.each([false, true])("updates the original section when the ghost leaves it: %s", (leavesSection) => {
    const { project, root, section, node, edges, recordStep } = setup();
    const child = node(-500, -300);
    const stationary = node(-500, -450);
    const group = section(root, child, stationary);
    const edge = new LineEdge(project, { associationList: [root, child] });
    edges.push(edge);
    const start = new Vector(-300, -300);
    const release = leavesSection ? new Vector(120, -150) : new Vector(-410, -355);

    new MindMapDrag(project, root, start).drop(release);

    expect(root.collisionBox.getRectangle().location).toEqual(release);
    expect(child.collisionBox.getRectangle().location).toEqual(new Vector(-500, -300).add(release.subtract(start)));
    expect(root.parentSection).toBe(leavesSection ? null : group);
    expect(child.parentSection).toBe(leavesSection ? null : group);
    expect(group.children).toEqual(leavesSection ? [stationary] : [root, child, stationary]);
    expect(edges).toEqual([edge]);
    expect(project.stageManager.updateReferences).toHaveBeenCalledOnce();
    expect(recordStep).toHaveBeenCalledOnce();
  });

  it.each([
    ["preserve", false],
    ["align", false],
    ["preserve", true],
    ["align", true],
  ] as const)("connects two sections on the outside in %s mode (nested parent: %s)", (mode, nested) => {
    const { project, parent, root, section, node, edges, recordStep } = setup();
    const source = section(root);
    const target = section(parent);
    const containingSection = nested ? section(target) : null;
    const child = node(-120, -260);
    const internal = new LineEdge(project, { associationList: [source, root] });
    const outgoing = new LineEdge(project, { associationList: [source, child] });
    edges.push(internal, outgoing);
    const start = source.rectangle.leftTop;
    const release = new Vector(target.rectangle.right + 2, target.rectangle.center.y - source.rectangle.height / 2);
    vi.mocked(project.stageManager.updateReferences).mockImplementation(() => {
      source.adjustLocationAndSize();
      target.adjustLocationAndSize();
      containingSection?.adjustLocationAndSize();
    });
    const targetBefore = target.rectangle;

    const drag = new MindMapDrag(project, source, start, mode);
    drag.update(release);
    expect(drag.preview?.contact).toEqual({ node: target, side: "right" });
    drag.drop(release);

    expect(edges).toHaveLength(3);
    const edge = edges.at(-1)!;
    expect(edge).toMatchObject({ source: target, target: source });
    expect(edge.bodyLine.start).toEqual(target.rectangle.rightCenter);
    expect(edge.bodyLine.end).toEqual(source.rectangle.leftCenter);
    expect(edge.bodyLine.end.x).toBeGreaterThan(edge.bodyLine.start.x);
    expect(target.rectangle).toEqual(targetBefore);
    expect(target.children).toEqual([parent]);
    expect(source.children).toEqual([root]);
    expect(source.parentSection).toBe(containingSection);
    expect(root.parentSection).toBe(source);
    expect(child.parentSection).toBe(containingSection);
    if (containingSection) expect(containingSection.children).toEqual([target, source, child]);
    expect(recordStep).toHaveBeenCalledOnce();
  });

  it.each([false, true])("drops into the innermost section without adding an edge (locked: %s)", (locked) => {
    const { project, root, section, node, edges, recordStep } = setup();
    const child = node(-450, -300);
    const source = section(root, child);
    const destination = section(node(100, 100), node(600, 400));
    const outer = section(destination);
    destination.locked = locked;
    const edge = new LineEdge(project, { associationList: [root, child] });
    edges.push(edge);
    const start = root.collisionBox.getRectangle().leftTop;
    const release = new Vector(250, 175);
    const drag = new MindMapDrag(project, root, start);
    drag.update(release);
    expect(drag.preview?.contact).toBeUndefined();
    drag.drop(release);

    expect(root.collisionBox.getRectangle().location).toEqual(release);
    expect(child.collisionBox.getRectangle().location).toEqual(new Vector(-450, -300).add(release.subtract(start)));
    expect(root.parentSection).toBe(locked ? null : destination);
    expect(child.parentSection).toBe(locked ? null : destination);
    expect(source.children).toEqual([]);
    expect(outer.children).toEqual([destination]);
    expect(edges).toEqual([edge]);
    expect(recordStep).toHaveBeenCalledOnce();
  });

  it("moves a section and its connected members once without dropping it into its own nested section", () => {
    const { project, root, section, edges } = setup();
    const nested = section(root);
    const group = section(nested);
    edges.push(new LineEdge(project, { associationList: [group, root] }));
    const before = root.collisionBox.getRectangle().location;
    const start = group.rectangle.leftTop;
    const offset = nested.rectangle.center.subtract(group.rectangle.center);
    const drag = new MindMapDrag(project, group, start);
    drag.update(start.add(offset));
    expect(drag.preview?.contact).toBeUndefined();
    drag.drop(start.add(offset));

    expect(group.rectangle.leftTop).toEqual(start.add(offset));
    expect(root.collisionBox.getRectangle().location).toEqual(before.add(offset));
    expect(group.parentSection).toBeNull();
    expect(nested.parentSection).toBe(group);
    expect(edges).toHaveLength(1);
  });

  it("keeps a moved section in its enclosing section when the ghost overlaps its original location", () => {
    const { project, root, section, node } = setup();
    const group = section(root);
    const outer = section(group, node(-800, -100));
    const start = group.rectangle.leftTop;
    const release = start.add(new Vector(-8, -6));

    new MindMapDrag(project, group, start).drop(release);

    expect(group.rectangle.location).toEqual(release);
    expect(group.parentSection).toBe(outer);
    expect(root.parentSection).toBe(group);
  });

  it("moves the branch to the preview position when dropped without a connection", () => {
    const { project, parent, root, node, edges, recordStep } = setup();
    const child = node(-185, -80);
    const grandchild = node(-130, -355);
    edges.push(
      new LineEdge(project, { associationList: [root, child] }),
      new LineEdge(project, { associationList: [child, grandchild] }),
    );
    const before = [root, child, grandchild].map((item) => item.collisionBox.getRectangle());
    const target = new Vector(120, -150);
    const offset = target.subtract(new Vector(-300, -300));

    new MindMapDrag(project, root, new Vector(-300, -300)).drop(target);

    expect([root, child, grandchild].map((item) => item.collisionBox.getRectangle())).toEqual(
      before.map((rect) => new Rectangle(rect.location.add(offset), rect.size)),
    );
    expect(parent.collisionBox.getRectangle()).toEqual(new Rectangle(new Vector(0, 0), new Vector(100, 80)));
    expect(edges).toHaveLength(2);
    expect(recordStep).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["left", -40, 25, "isRightToLeft", "leftCenter", "rightCenter"],
    ["right", 100, 25, "isLeftToRight", "rightCenter", "leftCenter"],
    ["top", 30, -30, "isBottomToTop", "topCenter", "bottomCenter"],
    ["bottom", 30, 80, "isTopToBottom", "bottomCenter", "topCenter"],
  ] as const)("previews and attaches the %s edge using the standard ports", (side, x, y, direction, from, to) => {
    const { project, parent, root, edges, recordStep } = setup();
    const originalRect = root.collisionBox.getRectangle();
    const drag = new MindMapDrag(project, root, originalRect.location);
    drag.update(new Vector(x, y));
    expect(drag.preview?.contact).toEqual({ node: parent, side });
    expect(root.collisionBox.getRectangle()).toEqual(originalRect);
    expect(edges).toHaveLength(0);

    drag.drop(new Vector(x, y));
    expect(edges).toHaveLength(1);
    const [edge] = edges;
    expect(edge.source).toBe(parent);
    expect(edge.target).toBe(root);
    expect(edge[direction]()).toBe(true);
    expect(edge.bodyLine.start).toEqual(parent.collisionBox.getRectangle()[from]);
    expect(edge.bodyLine.end).toEqual(root.collisionBox.getRectangle()[to]);
    expect(recordStep).toHaveBeenCalledTimes(1);
  });

  it("lays out only the dragged branch and retains its existing edges", () => {
    const { project, parent, root, node, edges } = setup();
    const child = node(-185, -80);
    const grandchild = node(-130, -355);
    const sibling = node(250, 25);
    edges.push(new LineEdge(project, { associationList: [parent, sibling] }));
    const childEdge = new LineEdge(project, { associationList: [root, child] });
    const grandchildEdge = new LineEdge(project, { associationList: [child, grandchild] });
    edges.push(childEdge, grandchildEdge);
    const before = [parent, sibling].map((node) => node.collisionBox.getRectangle());

    new MindMapDrag(project, root, new Vector(-300, -300)).drop(new Vector(100, 25));

    expect(edges).toHaveLength(4);
    expect(edges[1]).toBe(childEdge);
    expect(edges[2]).toBe(grandchildEdge);
    expect([parent, sibling].map((node) => node.collisionBox.getRectangle())).toEqual(before);
    expect(root.collisionBox.getRectangle().isCollideWith(before[1])).toBe(false);
    expect(root.collisionBox.getRectangle().right).toBeLessThan(child.collisionBox.getRectangle().left);
    expect(child.collisionBox.getRectangle().right).toBeLessThan(grandchild.collisionBox.getRectangle().left);
  });

  it.each([
    ["left", -40, 25, Direction.Left, Direction.Right, "isRightToLeft", "leftCenter", "rightCenter"],
    ["right", 100, 25, Direction.Right, Direction.Left, "isLeftToRight", "rightCenter", "leftCenter"],
    ["top", 30, -30, Direction.Up, Direction.Down, "isBottomToTop", "topCenter", "bottomCenter"],
    ["bottom", 30, 80, Direction.Down, Direction.Up, "isTopToBottom", "bottomCenter", "topCenter"],
  ] as const)(
    "aligns the whole branch to the %s using the existing edge controls",
    (side, x, y, sourceDirection, targetDirection, direction, from, to) => {
      const { project, parent, root, node, edges, recordStep, changeEdgesConnectLocation } = setup();
      const child = node(-450, -195);
      const grandchild = node(-600, -190);
      const peer = node(700, -210);
      const childEdge = new LineEdge(project, {
        associationList: [root, child],
        sourceRectangleRate: new Vector(0.5, 0.01),
        targetRectangleRate: new Vector(0.5, 0.99),
      });
      const grandchildEdge = new LineEdge(project, {
        associationList: [child, grandchild],
        sourceRectangleRate: new Vector(0.99, 0.5),
        targetRectangleRate: new Vector(0.01, 0.5),
      });
      const reference = new LineEdge(project, { associationList: [root, grandchild], lineType: "dashed" });
      const otherEdge = new LineEdge(project, { associationList: [parent, peer] });
      edges.push(childEdge, grandchildEdge, reference, otherEdge);
      const drag = new MindMapDrag(project, root, new Vector(-300, -300), "align");
      const target = new Vector(x, y);
      drag.update(target);
      expect(drag.preview?.contact).toEqual({ node: parent, side });
      expect(changeEdgesConnectLocation).not.toHaveBeenCalled();

      drag.drop(target);

      expect(changeEdgesConnectLocation.mock.calls).toEqual([
        [[childEdge, grandchildEdge], sourceDirection, true],
        [[childEdge, grandchildEdge], targetDirection],
      ]);
      expect(edges.slice(0, -1)).toEqual([childEdge, grandchildEdge, reference, otherEdge]);
      for (const edge of [edges.at(-1)!, childEdge, grandchildEdge]) {
        expect(edge[direction]()).toBe(true);
        const source = edge.source.collisionBox.getRectangle()[from];
        const target = edge.target.collisionBox.getRectangle()[to];
        if (side === "left") expect(target.x).toBeLessThan(source.x);
        if (side === "right") expect(target.x).toBeGreaterThan(source.x);
        if (side === "top") expect(target.y).toBeLessThan(source.y);
        if (side === "bottom") expect(target.y).toBeGreaterThan(source.y);
      }
      expect(reference.isUnknownDirection()).toBe(true);
      expect(otherEdge.isUnknownDirection()).toBe(true);
      expect(recordStep).toHaveBeenCalledTimes(1);
    },
  );

  it("reconnects to the original parent and replaces all direct incoming edges in one step", () => {
    const { project, parent, root, node, edges, recordStep } = setup();
    const secondParent = node(-450, -50);
    const grandparent = node(-600, 50);
    const child = node(-185, -80);
    const grandchild = node(-130, -355);
    const oldIncoming = new LineEdge(project, { associationList: [parent, root] });
    const oldDashedIncoming = new LineEdge(project, { associationList: [secondParent, root], lineType: "dashed" });
    const unrelated = new LineEdge(project, { associationList: [grandparent, parent] });
    const childEdge = new LineEdge(project, { associationList: [root, child] });
    const grandchildEdge = new LineEdge(project, { associationList: [child, grandchild] });
    edges.push(oldIncoming, oldDashedIncoming, unrelated, childEdge, grandchildEdge);
    const drag = new MindMapDrag(project, root, new Vector(-300, -300));
    const release = new Vector(100, 25);
    drag.update(release);
    expect(drag.preview?.contact).toEqual({ node: parent, side: "right" });
    expect(edges).toContain(oldIncoming);
    expect(edges).toContain(oldDashedIncoming);
    drag.drop(release);
    expect(edges.slice(0, -1)).toEqual([unrelated, childEdge, grandchildEdge]);
    expect(edges.at(-1)?.source).toBe(parent);
    expect(edges.at(-1)?.target).toBe(root);
    expect(edges.at(-1)?.isLeftToRight()).toBe(true);
    expect(recordStep).toHaveBeenCalledTimes(1);
  });

  it.each(["child", "grandchild", "empty space"])(
    "moves the branch when released away from a connect target (%s)",
    (target) => {
      const { project, parent, root, node, edges, recordStep } = setup();
      const child = node(300, 0);
      const grandchild = node(600, 0);
      edges.push(new LineEdge(project, { associationList: [parent, root] }));
      edges.push(new LineEdge(project, { associationList: [root, child] }));
      edges.push(new LineEdge(project, { associationList: [child, grandchild] }));
      const initial = [...edges];
      const before = root.collisionBox.getRectangle();
      const release = target === "empty space" ? new Vector(600, 500) : new Vector(target === "child" ? 340 : 640, 0);
      const drag = new MindMapDrag(project, root, before.location);
      drag.update(release);
      expect(drag.preview?.contact).toBeUndefined();
      drag.drop(release);
      expect(edges).toEqual(initial);
      const offset = release.subtract(before.location);
      expect(root.collisionBox.getRectangle()).toEqual(new Rectangle(before.location.add(offset), before.size));
      expect(child.collisionBox.getRectangle().location).toEqual(new Vector(300, 0).add(offset));
      expect(grandchild.collisionBox.getRectangle().location).toEqual(new Vector(600, 0).add(offset));
      expect(recordStep).toHaveBeenCalledTimes(1);
    },
  );
});

describe("mind-map drag shortcut", () => {
  const press = {
    button: 0,
    clientX: -300,
    clientY: -300,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    metaKey: false,
  } as MouseEvent;
  const release = { ...press, clientX: 100, clientY: 25 } as MouseEvent;

  describe.each(["preserve", "align"] as const)("pinned %s mode", (mode) => {
    it.each(["empty canvas", "inside a new section", "outside a section border", "beside an ordinary node"] as const)(
      "uses the expected branch placement and membership when dropped %s",
      (drop) => {
        const { project, parent, root, section, node, edges, recordStep } = setup();
        const child = node(-500, -300);
        const origin = section(root, child);
        const destination = section(node(500, 0), node(900, 300));
        const existingEdge = new LineEdge(project, { associationList: [root, child] });
        edges.push(existingEdge);
        vi.mocked(KeyBindsUI.getUIKeyBind).mockImplementation(
          (id) =>
            ({ key: id === "dragToConnectMindMapAligned" ? "x" : "z", isEnabled: true }) as ReturnType<
              typeof KeyBindsUI.getUIKeyBind
            >,
        );
        const controller = new ControllerEntityClickSelectAndMoveClass(project);
        const before = root.collisionBox.getRectangle().location;
        const grabOffset = new Vector(5, 8);
        const start = before.add(grabOffset);
        const targetLocation = {
          "empty canvas": new Vector(200, -150),
          "inside a new section": new Vector(660, 175),
          "outside a section border": new Vector(destination.rectangle.right + 6, destination.rectangle.center.y - 15),
          "beside an ordinary node": new Vector(104, 25),
        }[drop];
        const dropPointer = targetLocation.add(grabOffset);
        const down = { ...press, clientX: start.x, clientY: start.y, shiftKey: false };
        const up = { ...down, clientX: dropPointer.x, clientY: dropPointer.y };
        const contact =
          drop === "outside a section border" ? destination : drop === "beside an ordinary node" ? parent : null;

        Settings.persistentDragToConnectMindMap = mode === "preserve";
        Settings.persistentDragToConnectMindMapAligned = mode === "align";
        try {
          controller.mousedown(down);
          controller.mousemove(up);
          expect(controller.mindMapDragPreview).toMatchObject({ node: root, offset: targetLocation.subtract(before) });
          expect(controller.mindMapDragPreview?.contact).toEqual(
            contact ? { node: contact, side: "right" } : undefined,
          );
          expect(root.collisionBox.getRectangle().location).toEqual(before);
          controller.mouseup(up);
        } finally {
          Settings.persistentDragToConnectMindMap = false;
          Settings.persistentDragToConnectMindMapAligned = false;
        }

        const membership = drop === "inside a new section" ? destination : null;
        const rootRect = root.collisionBox.getRectangle();
        expect(origin.children).toEqual([]);
        expect(root.parentSection).toBe(membership);
        expect(child.parentSection).toBe(membership);
        expect(edges[0]).toBe(existingEdge);
        if (contact) {
          expect(edges).toHaveLength(2);
          expect(edges[1]).toMatchObject({ source: contact, target: root });
          const contactRect = contact.collisionBox.getRectangle();
          expect(rootRect.left - contactRect.right).toBeGreaterThanOrEqual(150);
          expect(rootRect.center.y).toBe(contactRect.center.y);
        } else {
          expect(rootRect.location).toEqual(targetLocation);
          expect(edges).toHaveLength(1);
        }
        expect(recordStep).toHaveBeenCalledOnce();
      },
    );
  });

  it("starts branch dragging from a section title and connects to a plain node", () => {
    const { project, parent, root, section, edges, pressingKeySet } = setup();
    const group = section(root);
    project.controllerUtils.getClickedStageObject = () => group;
    project.stageManager.findBranchDragNodeByLocation = () => group;
    vi.mocked(KeyBindsUI.getUIKeyBind).mockReturnValue({ key: "z", isEnabled: true } as ReturnType<
      typeof KeyBindsUI.getUIKeyBind
    >);
    pressingKeySet.add("z");
    const controller = new ControllerEntityClickSelectAndMoveClass(project);
    const down = { ...press, clientX: group.rectangle.left, clientY: group.rectangle.top, shiftKey: false };
    const up = { ...release, clientY: 0, shiftKey: false };
    controller.mousedown(down);
    controller.mousemove(up);
    expect(controller.mindMapDragPreview).toMatchObject({ node: group, contact: { node: parent, side: "right" } });
    controller.mouseup(up);

    expect(edges.at(-1)).toMatchObject({ source: parent, target: group });
    expect(root.parentSection).toBe(group);
  });

  it("can start on a visible node when the ordinary hit is a section", () => {
    const { project, parent, root, section, edges, pressingKeySet } = setup();
    const group = section(parent, root);
    project.controllerUtils.getClickedStageObject = () => group;
    project.stageManager.findBranchDragNodeByLocation = () => root;
    vi.mocked(KeyBindsUI.getUIKeyBind).mockImplementation(
      (id) =>
        ({
          isEnabled: true,
          key: id === "dragToConnectMindMapAligned" ? "x" : "z",
        }) as ReturnType<typeof KeyBindsUI.getUIKeyBind>,
    );
    pressingKeySet.add("z");
    const controller = new ControllerEntityClickSelectAndMoveClass(project);
    controller.mousedown({ ...press, shiftKey: false });
    controller.mousemove({ ...release, shiftKey: false });
    expect(controller.mindMapDragPreview).toMatchObject({ node: root, contact: { node: parent, side: "right" } });
    controller.mouseup({ ...release, shiftKey: false });
    expect(edges.at(-1)).toMatchObject({ associationList: [parent, root] });
    expect(group.children).toEqual([parent, root]);
  });

  it.each([
    ["x", "x", true],
    ["S-k", "k", true],
    ["S-k", "x", false],
  ] as const)("uses the configured alignment binding %s when holding %s", (binding, heldKey, enabled) => {
    const { project, root, edges, node, pressingKeySet, changeEdgesConnectLocation } = setup();
    const child = node(-450, -450);
    const edge = new LineEdge(project, { associationList: [root, child] });
    edges.push(edge);
    const controller = new ControllerEntityClickSelectAndMoveClass(project);
    vi.mocked(KeyBindsUI.getUIKeyBind).mockImplementation((id) => {
      const key = id === "dragToConnectMindMapAligned" ? binding : "z";
      return { key, isEnabled: true } as ReturnType<typeof KeyBindsUI.getUIKeyBind>;
    });
    const shiftKey = binding === "S-k" && heldKey === "k";
    pressingKeySet.add(heldKey);
    controller.mousedown({ ...press, shiftKey } as MouseEvent);
    controller.mouseup({ ...release, shiftKey } as MouseEvent);
    expect(changeEdgesConnectLocation).toHaveBeenCalledTimes(enabled ? 2 : 0);
    expect(edge.isLeftToRight()).toBe(enabled);
  });

  it.each(["key first", "mouse first", "during movement"])("uses the same branch drag with %s", (order) => {
    const { project, parent, root, edges, pressingKeySet, recordStep } = setup();
    const controller = new ControllerEntityClickSelectAndMoveClass(project);
    vi.mocked(KeyBindsUI.getUIKeyBind).mockReturnValue({ key: "z", isEnabled: true } as ReturnType<
      typeof KeyBindsUI.getUIKeyBind
    >);
    const down = { ...press, shiftKey: false } as MouseEvent;
    const up = { ...release, shiftKey: false } as MouseEvent;
    const before = root.collisionBox.getRectangle();
    if (order === "key first") pressingKeySet.add("z");
    controller.mousedown(down);
    if (order === "during movement") {
      controller.mousemove({ ...down, clientX: -200 } as MouseEvent);
      expect(root.collisionBox.getRectangle().left).toBe(-200);
    }
    if (order !== "key first") {
      pressingKeySet.add("z");
      controller.keydown({ ...down, key: "z" } as unknown as KeyboardEvent);
    }
    controller.mousemove(up);
    expect(root.collisionBox.getRectangle()).toEqual(before);
    expect(controller.mindMapDragPreview).toMatchObject({ node: root, contact: { node: parent, side: "right" } });
    controller.mouseup(up);
    expect(edges).toHaveLength(1);
    expect(root.collisionBox.getRectangle().left).toBe(250);
    expect(recordStep).toHaveBeenCalledTimes(1);
  });

  it("temporarily suspends a pinned mode while its configured shortcut is held", () => {
    const { project, parent, root, edges, pressingKeySet } = setup();
    const controller = new ControllerEntityClickSelectAndMoveClass(project);
    Settings.persistentDragToConnectMindMap = true;
    Settings.persistentDragToConnectMindMapAligned = false;
    vi.mocked(KeyBindsUI.getUIKeyBind).mockImplementation(
      (id) =>
        ({
          key: id === "dragToConnectMindMapAligned" ? "x" : "z",
          isEnabled: true,
        }) as ReturnType<typeof KeyBindsUI.getUIKeyBind>,
    );
    const down = { ...press, shiftKey: false } as MouseEvent;
    const release = { ...down, clientX: 100, clientY: 25 } as MouseEvent;

    controller.mousedown(down);
    controller.mousemove(release);
    expect(controller.mindMapDragPreview).toMatchObject({ node: root, contact: { node: parent, side: "right" } });

    pressingKeySet.add("z");
    controller.keydown({ key: "z", ...release } as unknown as KeyboardEvent);
    expect(controller.mindMapDragPreview).toBeNull();
    controller.mousemove({ ...release, clientX: 95 });

    pressingKeySet.delete("z");
    controller.keyup({ key: "z", ...release } as unknown as KeyboardEvent);
    expect(controller.mindMapDragPreview).toMatchObject({ node: root, contact: { node: parent, side: "right" } });
    controller.mouseup(release);

    expect(edges).toHaveLength(1);
    Settings.persistentDragToConnectMindMap = false;
  });

  it.each([true, false])("uses the remapped chord and requires it at release (%s)", (holdUntilDrop) => {
    const { project, parent, root, edges, pressingKeySet } = setup();
    const controller = new ControllerEntityClickSelectAndMoveClass(project);
    vi.mocked(KeyBindsUI.getUIKeyBind).mockReturnValue({ key: "S-k", isEnabled: true } as ReturnType<
      typeof KeyBindsUI.getUIKeyBind
    >);
    pressingKeySet.add("shift");
    pressingKeySet.add("k");
    controller.mousedown(press);
    controller.mousemove(release);
    expect(controller.mindMapDragPreview).toMatchObject({ node: root, contact: { node: parent, side: "right" } });

    if (!holdUntilDrop) {
      pressingKeySet.delete("k");
      controller.keyup({ key: "K", ...release } as unknown as KeyboardEvent);
      expect(controller.mindMapDragPreview).toBeNull();
    }

    controller.mouseup(release);
    expect(controller.mindMapDragPreview).toBeNull();
    expect(edges).toHaveLength(holdUntilDrop ? 1 : 0);
  });
});
