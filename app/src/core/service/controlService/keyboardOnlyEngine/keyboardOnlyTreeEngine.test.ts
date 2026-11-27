import { beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

const { mockSettings } = vi.hoisted(() => ({
  mockSettings: {
    enableTreeGenerateConnectByProbe: false,
    treeGenerateCameraBehavior: "none" as "none" | "moveToNewNode" | "resetToTree",
    autoLayoutWhenTreeGenerate: false,
    treeGenerateInheritParentColor: false,
    autoNamerTreeNodeTemplate: "新节点",
  },
}));

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
vi.mock("@/utils/font", () => ({
  getTextSize: () => new Vector(50, 24),
  getMultiLineTextSize: () => new Vector(50, 24),
}));
vi.mock("@/utils/platform", () => ({ isMac: false, isWeb: false, isMobile: false, isDesktop: true }));
vi.mock("../../Settings", () => ({ Settings: mockSettings }));
vi.mock("../../feedbackService/SoundService", () => ({
  SoundService: {
    play: {
      treeGenerateDeepSoundFile: vi.fn(),
      treeGenerateBroadSoundFile: vi.fn(),
      treeAdjustSoundFile: vi.fn(),
    },
  },
}));
vi.mock("@/utils/treeValidation", () => ({ showTreeValidationErrors: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { KeyboardOnlyTreeEngine } from "./keyboardOnlyTreeEngine";

function createEntity(uuid: string, x: number, y: number, w = 80, h = 40, selected = false) {
  const entity = Object.assign(Object.create(ConnectableEntity.prototype), {
    uuid,
    _isSelected: selected,
    isHiddenBySectionCollapse: false,
    parentSection: null,
    color: Color.Transparent,
    collisionBox: new CollisionBox([new Rectangle(new Vector(x, y), new Vector(w, h))]),
  });
  return entity as ConnectableEntity;
}

function createTextNodeMock(uuid: string, x: number, y: number, w = 80, h = 40, selected = false) {
  const node = Object.assign(Object.create(TextNode.prototype), {
    uuid,
    text: uuid,
    fontScaleLevel: 0,
    sizeAdjust: "auto",
    _isSelected: selected,
    isHiddenBySectionCollapse: false,
    parentSection: null,
    color: Color.Transparent,
    collisionBox: new CollisionBox([new Rectangle(new Vector(x, y), new Vector(w, h))]),
  });
  return node as TextNode;
}

function createHarness(
  entities: ConnectableEntity[],
  edges: Array<{ source: ConnectableEntity; target: ConnectableEntity }> = [],
) {
  const addedNodes: unknown[] = [];
  const connectedPairs: Array<[ConnectableEntity, ConnectableEntity]> = [];
  const bombMove = vi.fn();
  const resetByRectangle = vi.fn();

  const project = {
    keyboardOnlyEngine: { isOpenning: () => true },
    camera: {
      clearMoveCommander: vi.fn(),
      speed: Vector.getZero(),
      bombMove,
      resetByRectangle,
    },
    stageManager: {
      getConnectableEntity: () => entities,
      getTextNodes: () => entities.filter((e) => e instanceof TextNode),
      isHiddenByBranchCollapse: vi.fn(() => false),
      add: vi.fn((node: ConnectableEntity) => {
        addedNodes.push(node);
        entities.push(node);
      }),
      connectEntity: vi.fn((from: ConnectableEntity, to: ConnectableEntity) => {
        connectedPairs.push([from, to]);
        edges.push({ source: from, target: to });
      }),
      changeEdgesConnectLocation: vi.fn(),
    },
    sectionMethods: {
      getFatherSectionsList: vi.fn(() => []),
      isEntityHiddenByBigTitleSection: vi.fn(() => false),
      isEntityCoveredByBigTitleSection: vi.fn(() => false),
      isEntityInSection: vi.fn<(entity?: unknown, section?: unknown) => boolean>(() => false),
    },
    sectionInOutManager: {
      goInSection: vi.fn(),
    },
    graphMethods: {
      getIncomingEdges: vi.fn(() => []),
      getOutgoingEdges: vi.fn(() => []),
      getEdgesBetween: vi.fn((a: ConnectableEntity, b: ConnectableEntity) =>
        edges.filter((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a)),
      ),
      getOneStepSuccessorSet: vi.fn((node: ConnectableEntity) =>
        edges.filter((e) => e.source === node).map((e) => e.target),
      ),
      nodeParentArray: vi.fn((node: ConnectableEntity) => edges.filter((e) => e.target === node).map((e) => e.source)),
      getRoots: vi.fn((node: ConnectableEntity) => [node]),
      validateTreeStructure: vi.fn(() => ({ isValid: true })),
      getSuccessorSet: vi.fn((node: ConnectableEntity) => [node]),
    },
    stageUtils: {
      replaceAutoNameTemplate: vi.fn((tpl: string) => tpl),
    },
    textRenderer: {
      measureMultiLineTextSize: vi.fn(() => new Vector(60, 24)),
    },
    autoAlign: {
      autoLayoutSelectedFastTreeMode: vi.fn(),
    },
    effects: {
      addEffect: vi.fn(),
      addEffects: vi.fn(),
    },
    edgeRenderer: {
      getConnectedEffects: vi.fn(() => []),
    },
    controllerUtils: {
      editTextNode: vi.fn(),
      editEdgeText: vi.fn(() => Promise.resolve()),
    },
    stageStyleManager: {
      currentStyle: { effects: { successShadow: Color.Green } },
    },
  };

  const engine = new KeyboardOnlyTreeEngine(project as never);
  return { engine, project, addedNodes, connectedPairs, bombMove, resetByRectangle };
}

describe("KeyboardOnlyTreeEngine probe connect & camera behavior", () => {
  beforeEach(() => {
    mockSettings.enableTreeGenerateConnectByProbe = false;
    mockSettings.treeGenerateCameraBehavior = "none";
    mockSettings.autoLayoutWhenTreeGenerate = false;
    vi.useFakeTimers();
  });

  it("creates a new child node instead of connecting to a blocking node when probe connect is disabled", () => {
    const root = createTextNodeMock("root", 0, 0, 80, 40, true);
    const blocking = createEntity("blocking", 130, 0, 80, 40, false);
    const { engine, addedNodes, connectedPairs, bombMove, resetByRectangle } = createHarness([root, blocking]);

    engine.onDeepGenerateNode();

    expect(addedNodes).toHaveLength(1);
    expect(connectedPairs).toHaveLength(1);
    expect(connectedPairs[0][0]).toBe(root);
    expect(connectedPairs[0][1]).not.toBe(blocking);
    expect(bombMove).not.toHaveBeenCalled();
    expect(resetByRectangle).not.toHaveBeenCalled();
  });

  it("keeps camera stationary by default on Tab and \\ and moves camera when configured", () => {
    const parent = createTextNodeMock("parent", 0, 0, 80, 40, false);
    const child = createTextNodeMock("child", 200, 0, 80, 40, true);
    const { engine, bombMove, resetByRectangle } = createHarness([parent, child], [{ source: parent, target: child }]);

    engine.onBroadGenerateNode();
    expect(bombMove).not.toHaveBeenCalled();
    expect(resetByRectangle).not.toHaveBeenCalled();

    mockSettings.treeGenerateCameraBehavior = "moveToNewNode";
    child.isSelected = true;
    engine.onDeepGenerateNode();
    expect(bombMove).toHaveBeenCalledTimes(1);
  });

  it("ignores background images, hidden nodes, descendants, and does not pierce already-connected children when probe is enabled", () => {
    mockSettings.enableTreeGenerateConnectByProbe = true;
    const root = createTextNodeMock("root", 0, 0, 80, 40, true);
    const bgImage = Object.assign(Object.create(ImageNode.prototype), {
      uuid: "bg",
      isBackground: true,
      isHiddenBySectionCollapse: false,
      parentSection: null,
      collisionBox: new CollisionBox([new Rectangle(new Vector(-50, -50), new Vector(500, 300))]),
    }) as ImageNode;
    const existingChild = createEntity("child", 110, 0, 30, 40, false);
    const behindChild = createEntity("behind", 160, 0, 50, 40, false);

    const { engine } = createHarness(
      [root, bgImage, existingChild, behindChild],
      [{ source: root, target: existingChild }],
    );

    // Nearest visible hit is existingChild (already connected), so probe must not pierce to behindChild
    expect(engine.findConnectTargetByGrowthLine(root, "right")).toBeNull();

    // Also when splitting text (defaultText !== ""), onDeepGenerateNode always creates a new child node
    const blockingFree = createEntity("free", 130, 0, 50, 40, false);
    const harness2 = createHarness([root, blockingFree]);
    harness2.engine.onDeepGenerateNode("split-text", false);
    expect(harness2.addedNodes).toHaveLength(1);
    expect(harness2.connectedPairs[0][1]).not.toBe(blockingFree);

    // Descendants inside a selected Section are excluded
    const sec = Object.assign(Object.create(Section.prototype), {
      uuid: "sec",
      isCollapsed: false,
      locked: false,
      isHiddenBySectionCollapse: false,
      parentSection: null,
      _collisionBoxNormal: new CollisionBox(new Rectangle(new Vector(0, 0), new Vector(100, 100)).getBoundingLines()),
    }) as Section;
    const inner = createEntity("inner", 110, 30, 40, 40, false);
    const harness3 = createHarness([sec, inner]);
    harness3.project.sectionMethods.isEntityInSection.mockImplementation(
      (e: unknown, s: unknown) => e === inner && s === sec,
    );
    expect(harness3.engine.findConnectTargetByGrowthLine(sec, "right")).toBeNull();
  });
});
