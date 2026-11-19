import type { Project } from "@/core/Project";
import { AutoLayoutFastTree } from "@/core/service/controlService/autoLayoutEngine/autoLayoutFastTreeMode";
import { KeyBindsUI } from "@/core/service/controlService/shortcutKeysEngine/KeyBindsUI";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { GraphMethods } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { describe, expect, it, vi } from "vitest";
import { ControllerEntityClickSelectAndMoveClass } from "./ControllerEntityClickSelectAndMove";
import { MindMapDrag } from "./MindMapDrag";

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => () => {} }));
vi.mock("@/core/service/Settings", () => ({
  Settings: { defaultEdgeArrowType: "default", mouseLeftMode: "selectAndMove" },
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
vi.mock("@/core/stage/stageObject/abstract/ConnectableEntity", () => ({ ConnectableEntity: class {} }));
vi.mock("@/core/stage/stageObject/abstract/StageObject", () => ({ StageObject: class {} }));
vi.mock("@/core/stage/stageObject/entity/Section", () => ({ Section: class {} }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/ConnectPoint", () => ({ ConnectPoint: class {} }));
vi.mock("@/core/stage/stageObject/association/MutiTargetUndirectedEdge", () => ({
  MultiTargetUndirectedEdge: class {},
}));
vi.mock("@/core/stage/stageObject/association/EdgeCollisionBoxGetter", () => ({ EdgeCollisionBoxGetter: {} }));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 32 } }));
vi.mock("@/utils/font", () => ({ getMultiLineTextSize: () => Vector.getZero() }));

function setup() {
  const nodes: ConnectableEntity[] = [];
  const edges: LineEdge[] = [];
  const node = (x: number, y: number, size = new Vector(40, 30)) => {
    const rect = new Rectangle(new Vector(x, y), size);
    const entity = Object.assign(Object.create(ConnectableEntity.prototype), {
      uuid: String(nodes.length),
      collisionBox: { getRectangle: () => rect.clone() },
      move: (offset: Vector) => (rect.location = rect.location.add(offset)),
      moveTo: (location: Vector) => (rect.location = location.clone()),
      nearestLockedAncestorSection: null,
      parentSection: null,
    }) as ConnectableEntity;
    nodes.push(entity);
    return entity;
  };
  const parent = node(0, 0, new Vector(100, 80));
  const root = node(-300, -300);
  const recordStep = vi.fn();
  const pressingKeySet = new Set<string>();
  const project = {
    sectionMoveDepth: 0,
    camera: { currentScale: 1 },
    controller: { camera: {}, pressingKeySet, rectangleSelect: {}, cutting: {} },
    controllerUtils: { isClickedResizeRect: () => false, getClickedStageObject: () => root },
    renderer: { transformView2World: (view: Vector) => view },
    sectionMethods: { isEntityHiddenByBigTitleSection: () => false, isObjectBeLockedBySection: () => false },
    historyManager: { recordStep },
    stageManager: {
      getStageObjects: () => [...nodes, ...edges],
      getEntities: () => nodes,
      isHaveEntitySelected: () => nodes.some((node) => node.isSelected),
      getConnectableEntity: () => nodes,
      getEdges: () => edges,
      getLineEdges: () => edges,
      getAssociations: () => edges,
      getConnectableEntityByUUID: (id: string) => nodes.find((node) => node.uuid === id),
      isEntityExists: (id: string) => nodes.some((node) => node.uuid === id),
      add: (edge: LineEdge) => edges.push(edge),
      delete: (edge: LineEdge) => edges.splice(edges.indexOf(edge), 1),
      updateReferences: () => {},
    },
    entityMoveManager: {
      moveSelectedEntities: (delta: Vector) =>
        nodes.filter((node) => node.isSelected).forEach((node) => node.move(delta)),
      moveEntityUtils: (entity: ConnectableEntity, delta: Vector) => entity.move(delta),
      moveWithChildren: (entity: ConnectableEntity, delta: Vector) => {
        for (const descendant of project.graphMethods.getSuccessorSet(entity, true, true)) descendant.move(delta);
      },
    },
  } as unknown as Project;
  Object.assign(project, {
    graphMethods: new GraphMethods(project),
    autoLayoutFastTree: new AutoLayoutFastTree(project),
  });
  return { project, parent, root, node, edges, recordStep, pressingKeySet };
}

describe("mind-map drag", () => {
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

  it.each(["child", "grandchild", "empty space"])("cancels a release onto %s", (target) => {
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
    expect(root.collisionBox.getRectangle()).toEqual(before);
    expect(recordStep).not.toHaveBeenCalled();
  });
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
