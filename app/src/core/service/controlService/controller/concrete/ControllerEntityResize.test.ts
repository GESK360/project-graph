import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

const { mockSettings } = vi.hoisted(() => ({
  mockSettings: {
    viewerMode: false,
    mouseLeftMode: "selectAndMove" as "selectAndMove" | "draw" | "connectAndCut",
    persistentDragToConnectMindMap: false,
    persistentDragToConnectMindMapAligned: false,
  },
}));

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
vi.mock("@/core/service/Settings", () => ({ Settings: mockSettings }));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 24, NODE_PADDING: 10 } }));
vi.mock("@/utils/font", () => ({ getTextSize: () => new Vector(50, 24) }));
vi.mock("@/utils/platform", () => ({ isMac: false, isWeb: false, isMobile: false, isDesktop: true }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/ImageNode", () => ({ ImageNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/MediaNode", () => ({ MediaNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/SvgNode", () => ({ SvgNode: class {} }));
vi.mock("@/core/stage/stageObject/entity/ReferenceBlockNode", () => ({ ReferenceBlockNode: class {} }));
vi.mock("./MindMapDrag", () => ({
  isPersistentMindMapDragEnabled: () => false,
  reflowMindMapTreesForEntities: vi.fn(),
}));

import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { CursorNameEnum } from "@/types/cursors";
import { ControllerEntityResizeClass } from "./ControllerEntityResize";

function createSection(rect: Rectangle, overrides: Partial<Section> = {}) {
  const section = Object.assign(Object.create(Section.prototype), {
    uuid: "sec-1",
    text: "group",
    children: [],
    _isSelected: true,
    isCollapsed: false,
    _isEditingTitle: false,
    locked: false,
    parentSection: null,
    sectionDepth: 0,
    sizeAdjust: "auto" as "auto" | "manual",
    project: {
      stageManager: { getAssociations: () => [] },
      sectionCollisionSolver: { solveOverlaps: vi.fn() },
    },
    _collisionBoxNormal: new CollisionBox(rect.getBoundingLines()),
    _collisionBoxWhenCollapsed: new CollisionBox([]),
    collapsedCollisionBox: () => new CollisionBox([]),
    updateFatherSectionByMove: vi.fn(),
    ...overrides,
  });
  return section as Section;
}

function createControllerHarness(sections: Section[], locked = false) {
  const setCursorName = vi.fn();
  const recordStep = vi.fn();
  const updateReferences = vi.fn();
  const project = {
    renderer: {
      transformView2World: (v: Vector) => v.clone(),
    },
    stageManager: {
      getSelectedEntities: () => sections.filter((s) => s.isSelected),
      updateReferences,
    },
    sectionMethods: {
      isObjectBeLockedBySection: () => locked,
    },
    controller: {
      camera: { isPreGrabbingWhenSpace: false },
      pressingKeySet: new Set<string>(),
      setCursorName,
    },
    historyManager: {
      recordStep,
    },
  };
  const controller = new ControllerEntityResizeClass(project as never);
  return { controller, setCursorName, recordStep, updateReferences };
}

describe("ControllerEntityResize with Section", () => {
  beforeEach(() => {
    mockSettings.viewerMode = false;
    mockSettings.mouseLeftMode = "selectAndMove";
  });

  it("resizes a selected Section via its bottom-right handle and records history", () => {
    const section = createSection(new Rectangle(new Vector(0, 0), new Vector(200, 150)));
    const { controller, setCursorName, recordStep } = createControllerHarness([section]);

    // Hover bottom-right resize handle (175..200, 125..150)
    controller.mousemove({ clientX: 190, clientY: 140, buttons: 0 } as MouseEvent);
    expect(setCursorName).toHaveBeenCalledWith(CursorNameEnum.NwseResize);

    // Drag outward by (+80, +50)
    controller.mousedown({ button: 0, clientX: 190, clientY: 140 } as MouseEvent);
    controller.mousemove({ clientX: 270, clientY: 190, buttons: 1 } as MouseEvent);
    controller.mouseup({ button: 0, clientX: 270, clientY: 190 } as MouseEvent);

    expect(section.sizeAdjust).toBe("manual");
    expect(section.rectangle.size).toEqual(new Vector(280, 200));
    expect(recordStep).toHaveBeenCalledTimes(1);
    expect(setCursorName).toHaveBeenLastCalledWith(CursorNameEnum.Default);
  });

  it("resets custom Section size back to auto-fit on double-clicking the resize handle", () => {
    const section = createSection(new Rectangle(new Vector(0, 0), new Vector(300, 220)), { sizeAdjust: "manual" });
    const { controller, recordStep } = createControllerHarness([section]);

    controller.mouseDoubleClick({ button: 0, clientX: 290, clientY: 210 } as MouseEvent);
    expect(section.sizeAdjust).toBe("auto");
    expect(section.rectangle.size).toEqual(new Vector(100, 100));
    expect(recordStep).toHaveBeenCalledTimes(1);
  });

  it("ignores collapsed or locked sections", () => {
    const collapsed = createSection(new Rectangle(new Vector(0, 0), new Vector(200, 150)), { isCollapsed: true });
    const harness1 = createControllerHarness([collapsed]);
    harness1.controller.mousedown({ button: 0, clientX: 190, clientY: 140 } as MouseEvent);
    harness1.controller.mousemove({ clientX: 250, clientY: 200, buttons: 1 } as MouseEvent);
    harness1.controller.mouseup({ button: 0, clientX: 250, clientY: 200 } as MouseEvent);
    expect(harness1.recordStep).not.toHaveBeenCalled();

    const lockedSec = createSection(new Rectangle(new Vector(0, 0), new Vector(200, 150)), { locked: true });
    const harness2 = createControllerHarness([lockedSec], true);
    harness2.controller.mousedown({ button: 0, clientX: 190, clientY: 140 } as MouseEvent);
    harness2.controller.mousemove({ clientX: 250, clientY: 200, buttons: 1 } as MouseEvent);
    harness2.controller.mouseup({ button: 0, clientX: 250, clientY: 200 } as MouseEvent);
    expect(harness2.recordStep).not.toHaveBeenCalled();
  });
});
