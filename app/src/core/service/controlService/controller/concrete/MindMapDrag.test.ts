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
import { SectionPackManager } from "@/core/stage/stageManager/concreteMethods/StageSectionPackManager";
import { Direction } from "@/types/directions";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { describe, expect, it, vi } from "vitest";
import { ControllerEntityClickSelectAndMoveClass } from "./ControllerEntityClickSelectAndMove";
import { ControllerNodeConnectionClass } from "./ControllerNodeConnection";
import { MindMapDrag, mindMapPorts, reflowMindMapTree } from "./MindMapDrag";
import { ControllerUtils } from "./utilsControl";

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => () => {} }));
vi.mock("@/core/TabWorkspace", () => ({ TabWorkspace: {} }));
vi.mock("./utilsControlTools", () => ({ AutoCompleteManager: class {} }));
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
vi.mock("@/core/service/feedbackService/SoundService", () => ({
  SoundService: { play: { connectLineStart: vi.fn(), packEntityToSectionSoundFile: vi.fn() } },
}));
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
    stageUtils: { replaceAutoNameTemplate: () => "Section_0" },
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
      getSectionByUUID: (id: string) => sections.find((section) => section.uuid === id),
      isEntityExists: (id: string) => nodes.some((node) => node.uuid === id),
      add: (object: LineEdge | Section, skipUpdateReferences = false) => {
        if (object instanceof Section) {
          sections.push(object);
          nodes.push(object);
          for (const child of object.children) child.parentSection = object;
        } else {
          edges.push(object);
        }
        if (!skipUpdateReferences) updateReferences();
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

  it("avoids unanchored siblings without moving them and retains existing branch edges", () => {
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

  it("keeps the cursor ghost moving independently while the insertion preview stays in the same slot", () => {
    const { project, parent, root } = setup();
    const start = root.collisionBox.getRectangle().location;
    const drag = new MindMapDrag(project, root, start);
    const first = drag.update(new Vector(103, 20));
    const second = drag.update(new Vector(106, 25));

    expect(first.contact).toEqual({ node: parent, side: "right" });
    expect(second.contact).toEqual(first.contact);
    expect(first.ghosts[0].rectangle.location).toEqual(new Vector(103, 20));
    expect(second.ghosts[0].rectangle.location).toEqual(new Vector(106, 25));
    expect(second.landing).toEqual(first.landing);
    expect(second.landing?.placements[0].rectangle.location).not.toEqual(second.ghosts[0].rectangle.location);
    expect(drag.update(new Vector(150, 150)).landing).toBeUndefined();
  });

  it.each([
    ["preserve", false],
    ["preserve", true],
    ["align", false],
    ["align", true],
  ] as const)("creates a child by right-drag in %s mode (pinned: %s)", async (mode, pinned) => {
    const { project, parent, root, node, edges, recordStep } = setup();
    const { stageManager } = project;
    const connect = (
      source: ConnectableEntity,
      target: ConnectableEntity,
      _text: string,
      targetRate: [number, number],
      sourceRate: [number, number],
    ) => {
      edges.push(
        new LineEdge(project, {
          associationList: [source, target],
          sourceRectangleRate: new Vector(...sourceRate),
          targetRectangleRate: new Vector(...targetRate),
        }),
      );
    };
    Object.assign(project, { nodeConnector: { connectConnectableEntity: connect } });
    Object.assign(stageManager, {
      findConnectableEntityByLocation: (point: Vector) =>
        stageManager.getConnectableEntity().find((entity) => entity.collisionBox.getRectangle().isPointIn(point)) ??
        null,
      getTextNodeByUUID: stageManager.getConnectableEntityByUUID,
      connectMultipleEntities: (
        sources: ConnectableEntity[],
        child: ConnectableEntity,
        _isCrEdge: boolean,
        from: [number, number],
        to: [number, number],
      ) => {
        for (const source of sources) connect(source, child, "", to, from);
      },
    });
    const startEditing = vi.fn((uuid: string) => {
      const rectangle = stageManager.getConnectableEntityByUUID(uuid)?.collisionBox.getRectangle();
      expect(rectangle?.center.y).toBe(pinned ? parent.collisionBox.getRectangle().center.y : 90);
      if (pinned) expect(recordStep).toHaveBeenCalledOnce();
    });
    Object.assign(project.controllerUtils, {
      addTextNodeByLocation: async (position: Vector) => node(position.x, position.y).uuid,
      textNodeInEditModeByUUID: startEditing,
    });
    Object.assign(project.controller, { setCursorName: vi.fn() });
    Object.assign(project.effects, { addEffect: vi.fn() });
    const color = { clone: () => color };
    Object.assign(project, {
      stageStyleManager: { currentStyle: { effects: { successShadow: color }, StageObjectBorder: color } },
      edgeRenderer: { getConnectedEffects: () => [] },
    });
    const originalTrack = Settings.autoAdjustLineEndpointsByMouseTrack;
    const originalEndpoints = Settings.autoAdjustLineEndpointsWhenRightDragToBlank;
    Settings.autoAdjustLineEndpointsByMouseTrack = !pinned;
    Settings.autoAdjustLineEndpointsWhenRightDragToBlank = !pinned;
    Settings.persistentDragToConnectMindMap = pinned && mode === "preserve";
    Settings.persistentDragToConnectMindMapAligned = pinned && mode === "align";
    vi.stubGlobal("window", new EventTarget());
    const rightDrag = new ControllerNodeConnectionClass(project);
    try {
      const at = (x: number, y: number) => ({ button: 2, clientX: x, clientY: y }) as MouseEvent;
      rightDrag.mousedown(at(50, 25));
      rightDrag.mouseup(at(300, 75));
      await Promise.resolve();

      expect(startEditing).toHaveBeenCalledOnce();
      expect(edges).toHaveLength(1);
      const [original] = edges;
      expect(original.source).toBe(parent);
      expect(original.isLeftToRight()).toBe(true);
      const child = original.target;
      const drag = new MindMapDrag(project, root, root.collisionBox.getRectangle().location, mode);
      const childRect = child.collisionBox.getRectangle();
      const release = new Vector(childRect.left - 40, childRect.top);
      expect(drag.update(release).contact).toEqual({ node: child, side: "left" });
      drag.drop(release);
      expect(edges).toHaveLength(2);
      expect(edges[0]).toBe(original);
      expect(edges[1]).toMatchObject({ source: child, target: root });
    } finally {
      rightDrag.dispose();
      vi.unstubAllGlobals();
      Settings.autoAdjustLineEndpointsByMouseTrack = originalTrack;
      Settings.autoAdjustLineEndpointsWhenRightDragToBlank = originalEndpoints;
      Settings.persistentDragToConnectMindMap = false;
      Settings.persistentDragToConnectMindMapAligned = false;
    }
  });

  it("uses the old side and the edited size to lay out a tree connected with center ports", () => {
    const { project, parent, node, edges, root } = setup();
    const child = node(210, 55);
    const size = new Vector(100, 80);
    const edited = node(30, 240, size);
    const descendant = node(250, 260);
    const dashed = new LineEdge(project, { associationList: [edited, root], lineType: "dashed" });
    const right = new LineEdge(project, { associationList: [parent, child] });
    const bottom = new LineEdge(project, { associationList: [parent, edited] });
    const editedRight = new LineEdge(project, { associationList: [edited, descendant] });
    edges.push(right, bottom, editedRight, dashed);
    const parentBefore = parent.collisionBox.getRectangle().location;
    const detachedBefore = root.collisionBox.getRectangle().location;
    const centerBeforeEdit = edited.collisionBox.getRectangle().center;
    size.x = 600;

    reflowMindMapTree(project, edited, centerBeforeEdit);

    expect(right.isLeftToRight()).toBe(true);
    expect(bottom.isTopToBottom()).toBe(true);
    expect(editedRight.isLeftToRight()).toBe(true);
    const editedRect = edited.collisionBox.getRectangle();
    const descendantRect = descendant.collisionBox.getRectangle();
    expect(descendantRect.left - editedRect.right).toBeGreaterThanOrEqual(150);
    expect(descendantRect.center.y).toBe(editedRect.center.y);
    expect(parent.collisionBox.getRectangle().location).toEqual(parentBefore);
    expect(root.collisionBox.getRectangle().location).toEqual(detachedBefore);
    expect(dashed.isUnknownDirection()).toBe(true);
  });

  it.each(["persistentDragToConnectMindMap", "persistentDragToConnectMindMapAligned", null] as const)(
    "groups a node and nested Section with drag setting %s",
    async (setting) => {
      const { project, node, section, edges, parent } = setup();
      const firstParent = node(180, -45);
      const secondParent = node(180, 110);
      const sibling = node(360, -45);
      const nestedNode = node(425, 110);
      const leaf = node(540, 110);
      const nested = section(nestedNode, leaf);
      const firstChild = node(790, -180);
      const secondChild = node(1030, 260);
      const connect = (source: ConnectableEntity, target: ConnectableEntity, lineType = "solid") => {
        const edge = new LineEdge(project, { associationList: [source, target], lineType });
        edges.push(edge);
        return edge;
      };
      connect(parent, firstParent);
      connect(parent, secondParent);
      const firstIn = connect(firstParent, sibling);
      const duplicateIn = connect(firstParent, nested);
      const secondIn = connect(secondParent, nested);
      const internal = connect(nestedNode, leaf);
      const firstOut = connect(sibling, firstChild);
      const secondOut = connect(leaf, secondChild);
      secondOut.rename("child branch");
      const reference = connect(nestedNode, firstChild, "dashed");
      sibling.isSelected = nested.isSelected = leaf.isSelected = true;

      if (setting) Settings[setting] = true;
      try {
        const group = await new SectionPackManager(project).packSelectedEntitiesToSection();
        expect(group?.children).toEqual([sibling, nested]);
        expect(internal.associationList).toEqual([nestedNode, leaf]);
        expect(reference.associationList).toEqual([nestedNode, firstChild]);
        expect(secondOut.text).toBe("child branch");
        if (!setting) {
          expect(firstIn.target).toBe(sibling);
          expect(duplicateIn.target).toBe(nested);
          expect(edges).toContain(duplicateIn);
          expect(secondIn.target).toBe(nested);
          expect(firstOut.source).toBe(sibling);
          expect(secondOut.source).toBe(leaf);
          return;
        }
        expect(firstIn.associationList).toEqual([firstParent, group]);
        expect(edges.filter((edge) => edge.source === firstParent && edge.target === group)).toEqual([firstIn]);
        expect(secondIn.associationList).toEqual([secondParent, group]);
        expect(firstOut.associationList).toEqual([group, firstChild]);
        expect(secondOut.associationList).toEqual([group, secondChild]);
        expect([firstIn, secondIn, firstOut, secondOut].every((edge) => edge.isLeftToRight())).toBe(true);

        const parentRects = [firstParent, secondParent].map((item) => item.collisionBox.getRectangle());
        const childBeforeEdit = firstChild.collisionBox.getRectangle();
        let submit!: (text: string) => void;
        Object.assign(project, {
          camera: { currentScale: 1, stopImmediately: vi.fn() },
          canvas: { viewToClientScale: () => Vector.same(1), viewToClient: (point: Vector) => point },
          renderer: { transformWorld2View: (point: Vector) => point },
          sectionRenderer: { render: vi.fn() },
          stageStyleManager: {
            currentStyle: { StageObjectBorder: Color.Transparent, effects: { successShadow: Color.Transparent } },
          },
          inputElement: {
            input: (_location: Vector, _text: string, onChange: (text: string, element: HTMLInputElement) => void) =>
              new Promise<string>((resolve) => {
                submit = (text) => {
                  onChange(text, { style: {} } as HTMLInputElement);
                  expect(firstChild.collisionBox.getRectangle()).toEqual(childBeforeEdit);
                  resolve(text);
                };
              }),
          },
        });
        const editing = new ControllerUtils(project).editSectionTitle(group!);
        submit("Branch group");
        await editing;

        expect(group!.text).toBe("Branch group");
        const firstRect = firstChild.collisionBox.getRectangle();
        const secondRect = secondChild.collisionBox.getRectangle();
        expect(firstRect.left).toBe(secondRect.left);
        expect(secondRect.top - firstRect.bottom).toBe(20);
        expect(firstRect.left - group!.rectangle.right).toBeGreaterThanOrEqual(150);
        expect([firstParent, secondParent].map((item) => item.collisionBox.getRectangle())).toEqual(parentRects);
      } finally {
        if (setting) Settings[setting] = false;
      }
    },
  );

  it("merges incoming edges only when their source and Section sides match, keeping their labels", async () => {
    const { project, parent, node, edges } = setup();
    const first = node(250, 0);
    const second = node(300, 15);
    const left = mindMapPorts.left.source;
    const right = mindMapPorts.right.source;
    const top = mindMapPorts.top.source;
    const connect = (child: ConnectableEntity, sourceRate: Vector, targetRate: Vector, text: string) => {
      const edge = new LineEdge(project, {
        associationList: [parent, child],
        sourceRectangleRate: sourceRate,
        targetRectangleRate: targetRate,
        text,
      });
      edges.push(edge);
      return edge;
    };
    const incoming = connect(first, right, left, "first label");
    incoming.isBranchCollapsed = true;
    connect(second, new Vector(right.x, 0.25), left, "second label");
    connect(second, right, left, "first label");
    const otherSourceSide = connect(first, top, left, "");
    const otherSectionSide = connect(second, right, top, "");

    const group = await new SectionPackManager(project).packEntityToSection([first, second], true);

    expect(group).toBeDefined();
    expect(edges).toEqual([incoming, otherSourceSide, otherSectionSide]);
    expect(edges.every((edge) => edge.target === group)).toBe(true);
    expect(incoming.isBranchCollapsed).toBe(false);
    expect(incoming.text).toBe("first label\nsecond label");
  });

  it("leaves ordinary gaps free even when a parent has many children on its side", () => {
    const { project, parent, root, node, edges } = setup();
    const port = mindMapPorts.right;
    for (const y of [-80, -15, 50, 125, 200]) {
      edges.push(
        new LineEdge(project, {
          associationList: [parent, node(y === 200 ? 600 : 250, y)],
          sourceRectangleRate: port.source,
          targetRectangleRate: port.target,
        }),
      );
    }
    const drag = new MindMapDrag(project, root, root.collisionBox.getRectangle().location);
    expect(drag.update(new Vector(175, 25)).contact).toBeUndefined();
    expect(drag.update(new Vector(400, 25)).contact).toBeUndefined();
    expect(drag.update(new Vector(250, 25)).contact).toEqual({ node: parent, side: "right" });
  });

  it("does not use the far end of a tall ghost to snap to an adjacent row", () => {
    const { project, node } = setup();
    const tall = node(-300, -300, new Vector(40, 150));
    const drag = new MindMapDrag(project, tall, tall.collisionBox.getRectangle().center);
    expect(drag.update(new Vector(120, 150)).contact).toBeUndefined();
  });

  it.each(["preserve", "align"] as const)(
    "previews off-position nodes before reflowing the receiving tree in %s mode",
    (mode) => {
      const { project, parent, root, node, edges, recordStep } = setup();
      const ancestor = node(-500, -100);
      const sibling = node(390, -130);
      const rightEdge = (source: ConnectableEntity, target: ConnectableEntity) =>
        new LineEdge(project, {
          associationList: [source, target],
          sourceRectangleRate: new Vector(0.99, 0.5),
          targetRectangleRate: new Vector(0.01, 0.5),
        });
      const ancestorEdge = rightEdge(ancestor, parent);
      const siblingEdge = rightEdge(parent, sibling);
      edges.push(ancestorEdge, siblingEdge);
      const ancestorBefore = ancestor.collisionBox.getRectangle();
      const parentBefore = parent.collisionBox.getRectangle();
      const siblingBefore = sibling.collisionBox.getRectangle();
      const rootBefore = root.collisionBox.getRectangle();
      const nodesBefore = [...project.stageManager.getConnectableEntity()];
      const layout = vi.spyOn(project.autoLayoutFastTree, "autoLayoutFastTreeMode");
      const drag = new MindMapDrag(project, root, rootBefore.location, mode);
      const release = new Vector(100, 25);
      const preview = drag.update(release);

      expect(preview.contact).toEqual({ node: parent, side: "right" });
      expect(preview.landing?.parentRectangle).toEqual(parentBefore);
      expect(preview.landing?.placements[0].rectangle.location).toEqual(
        new Vector(siblingBefore.left, siblingBefore.bottom + 20),
      );
      expect(parent.collisionBox.getRectangle()).toEqual(parentBefore);
      expect(root.collisionBox.getRectangle()).toEqual(rootBefore);
      expect(edges).toEqual([ancestorEdge, siblingEdge]);
      expect(layout).not.toHaveBeenCalled();

      drag.drop(release);

      expect(project.stageManager.getConnectableEntity()).toEqual(nodesBefore);
      expect(edges.slice(0, -1)).toEqual([ancestorEdge, siblingEdge]);
      expect(edges.at(-1)).toMatchObject({ source: parent, target: root });
      const parentRect = parent.collisionBox.getRectangle();
      const siblingRect = sibling.collisionBox.getRectangle();
      const rootRect = root.collisionBox.getRectangle();
      expect(ancestor.collisionBox.getRectangle()).toEqual(ancestorBefore);
      expect(parentRect).not.toEqual(preview.landing?.parentRectangle);
      expect(parentRect.left - ancestorBefore.right).toBe(150);
      expect(siblingRect).not.toEqual(siblingBefore);
      expect(rootRect.left).toBe(siblingRect.left);
      expect(rootRect.top - siblingRect.bottom).toBe(20);
      expect((rootRect.bottom + siblingRect.top) / 2).toBe(parentRect.center.y);
      expect(project.stageManager.updateReferences).toHaveBeenCalledOnce();
      expect(recordStep).toHaveBeenCalledOnce();
    },
  );

  it.each(["left", "right", "top", "bottom"] as const)(
    "previews and inserts a batch on the %s side in original canvas-axis order",
    (side) => {
      const { project, parent, root, node, edges, recordStep } = setup();
      const horizontal = side === "left" || side === "right";
      // Oppose the X and Y orders so the test catches an axis swap.
      const peer = horizontal ? node(-450, -260) : node(-260, -450);
      const axis = horizontal ? "y" : "x";
      const [outbound, leading, middle, end] = horizontal
        ? [side === "left" ? -195 : 250, -60, 25, 120]
        : [side === "top" ? -180 : 230, -50, 30, 130];
      const first = horizontal ? node(outbound, leading) : node(leading, outbound);
      const last = horizontal ? node(outbound, end) : node(end, outbound);
      const port = mindMapPorts[side];
      for (const child of [first, last]) {
        edges.push(
          new LineEdge(project, {
            associationList: [parent, child],
            sourceRectangleRate: port.source,
            targetRectangleRate: port.target,
          }),
        );
      }
      const innerEdge = side === "left" ? outbound + 5 : side === "top" ? outbound + 5 : outbound - 5;
      const at = (position: number) => (horizontal ? new Vector(innerEdge, position) : new Vector(position, innerEdge));
      const drag = new MindMapDrag(project, peer, peer.collisionBox.getRectangle().location, "align", [peer, root]);
      const oldPositions = [root, peer, first, last].map((item) => item.collisionBox.getRectangle());

      const initial = drag.update(at(leading - 35));
      const preview = drag.update(at(middle));

      expect(preview.contact).toEqual({ node: parent, side });
      expect(preview.landing?.placements.map((placement) => placement.node)).toEqual([root, peer]);
      expect(preview.landing?.placements[0].rectangle).not.toEqual(initial.landing?.placements[0].rectangle);
      expect(preview.landing?.parentRectangle).toEqual(parent.collisionBox.getRectangle());
      const previewOrder = [
        oldPositions[2],
        ...preview.landing!.placements.map(({ rectangle }) => rectangle),
        oldPositions[3],
      ].map((rectangle) => rectangle.location[axis]);
      expect(previewOrder).toEqual([...previewOrder].sort((a, b) => a - b));
      expect([root, peer, first, last].map((item) => item.collisionBox.getRectangle())).toEqual(oldPositions);
      expect(edges).toHaveLength(2);
      expect(recordStep).not.toHaveBeenCalled();

      drag.drop(at(middle));

      expect(edges.slice(2).map((edge) => [edge.source, edge.target])).toEqual([
        [parent, root],
        [parent, peer],
      ]);
      const result = [first, root, peer, last].map((item) => item.collisionBox.getRectangle().location[axis]);
      expect(result).toEqual([...result].sort((a, b) => a - b));
      expect(new Set(result).size).toBe(4);
      expect(recordStep).toHaveBeenCalledOnce();
    },
  );

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

  it("keeps Ctrl-selected nodes together when starting a pinned branch drag", () => {
    const { project, parent, root, node, edges, pressingKeySet, recordStep } = setup();
    const peer = node(-450, -250);
    let clicked = peer;
    project.controllerUtils.getClickedStageObject = () => clicked;
    const controller = new ControllerEntityClickSelectAndMoveClass(project);
    Settings.persistentDragToConnectMindMap = true;
    root.isSelected = true;
    try {
      pressingKeySet.add("control");
      controller.mousedown({ ...press, ctrlKey: true, shiftKey: false, clientX: -450, clientY: -250 });
      expect(root.isSelected && peer.isSelected).toBe(true);
      pressingKeySet.clear();

      clicked = root;
      controller.mousedown({ ...press, shiftKey: false });
      const release = { ...press, shiftKey: false, clientX: 100, clientY: 25 };
      controller.mousemove(release);
      expect(controller.mindMapDragPreview?.landing?.placements.map((placement) => placement.node)).toEqual([
        root,
        peer,
      ]);
      controller.mouseup(release);
      expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
        [parent, root],
        [parent, peer],
      ]);
      expect(recordStep).toHaveBeenCalledOnce();
    } finally {
      Settings.persistentDragToConnectMindMap = false;
    }
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
