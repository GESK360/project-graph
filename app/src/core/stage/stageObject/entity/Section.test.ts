import { describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
vi.mock("@/core/Project", () => ({ Project: class {} }));
vi.mock("@/core/render/canvas2d/renderer", () => ({ Renderer: { FONT_SIZE: 24, NODE_PADDING: 10 } }));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/stage/stageObject/abstract/ConnectableEntity", () => ({ ConnectableEntity: class {} }));
vi.mock("@/core/stage/stageObject/abstract/StageEntity", () => ({ Entity: class {} }));
vi.mock("@/core/stage/stageObject/association/MutiTargetUndirectedEdge", () => ({
  MultiTargetUndirectedEdge: class {},
}));
vi.mock("@/utils/font", () => ({ getTextSize: () => new Vector(50, 24) }));
import { Section } from "./Section";
import { MultiTargetUndirectedEdge } from "../association/MutiTargetUndirectedEdge";
import { CollisionBox } from "../collisionBox/collisionBox";

describe("section enclosure bounds", () => {
  it.each(["convex", "circle"])("includes internal %s outlines but excludes crossing edges", (renderType) => {
    const node = (x: number) => ({
      collisionBox: new CollisionBox([new Rectangle(new Vector(x, 100), new Vector(40, 40))]),
    });
    const a = node(100),
      b = node(200),
      outside = node(2000);
    const edge = Object.assign(Object.create(MultiTargetUndirectedEdge.prototype), {
      renderType,
      associationList: [a, b],
      collisionBox: new CollisionBox([new Rectangle(new Vector(50, 20), new Vector(300, 300))]),
    });
    const crossing = Object.assign(Object.create(MultiTargetUndirectedEdge.prototype), {
      renderType,
      associationList: [a, outside],
      collisionBox: new CollisionBox([new Rectangle(new Vector(-1000, -1000), new Vector(4000, 4000))]),
    });
    const section = Object.assign(Object.create(Section.prototype), {
      text: "group",
      children: [a, b],
      project: { stageManager: { getAssociations: () => [edge, crossing] } },
      _collisionBoxNormal: new CollisionBox([]),
      collapsedCollisionBox: () => new CollisionBox([]),
    });
    section.adjustLocationAndSize();
    let rect = section._collisionBoxNormal.getRectangle();
    expect(rect.left).toBe(20);
    expect(rect.right).toBe(380);
    expect(rect.bottom).toBe(350);
    edge.renderType = "line";
    section.adjustLocationAndSize();
    rect = section._collisionBoxNormal.getRectangle();
    expect(rect.left).toBe(70);
    expect(rect.right).toBe(270);
    expect(rect.bottom).toBe(170);
  });
});

describe("section custom resize", () => {
  const createMockNode = (x: number, y: number, w = 40, h = 40) => ({
    collisionBox: new CollisionBox([new Rectangle(new Vector(x, y), new Vector(w, h))]),
  });

  const createMockSection = (children: ReturnType<typeof createMockNode>[], text = "group") => {
    const solveOverlaps = vi.fn();
    const updateFatherSectionByMove = vi.fn();
    const section = Object.assign(Object.create(Section.prototype), {
      text,
      children,
      isCollapsed: false,
      locked: false,
      nearestLockedAncestorSection: null,
      sizeAdjust: "auto" as "auto" | "manual",
      project: {
        stageManager: { getAssociations: () => [] },
        sectionCollisionSolver: { solveOverlaps },
      },
      _collisionBoxNormal: new CollisionBox(new Rectangle(new Vector(0, 0), new Vector(100, 100)).getBoundingLines()),
      _collisionBoxWhenCollapsed: new CollisionBox([]),
      collapsedCollisionBox: () => new CollisionBox([]),
      updateFatherSectionByMove,
    });
    section.adjustLocationAndSize();
    return { section, solveOverlaps, updateFatherSectionByMove };
  };

  it("expands and shrinks section border without changing children geometry", () => {
    const child = createMockNode(100, 100, 80, 40);
    const { section, solveOverlaps, updateFatherSectionByMove } = createMockSection([child]);

    // Auto bounds: left=70, top=20 (100-30-50), right=210, bottom=170
    expect(section.rectangle.left).toBe(70);
    expect(section.rectangle.top).toBe(20);
    expect(section.rectangle.right).toBe(210);
    expect(section.rectangle.bottom).toBe(170);

    // Drag bottom-right handle outward
    section.resizeHandle(new Vector(150, 120));
    expect(section.sizeAdjust).toBe("manual");
    expect(section.rectangle.left).toBe(70);
    expect(section.rectangle.top).toBe(20);
    expect(section.rectangle.right).toBe(360);
    expect(section.rectangle.bottom).toBe(290);
    // Child geometry is completely untouched
    expect(child.collisionBox.getRectangle().location).toEqual(new Vector(100, 100));
    expect(child.collisionBox.getRectangle().size).toEqual(new Vector(80, 40));
    expect(updateFatherSectionByMove).toHaveBeenCalledTimes(1);
    expect(solveOverlaps).toHaveBeenCalledTimes(1);

    // Moving child inside the custom section does not snap the section back
    child.collisionBox = new CollisionBox([new Rectangle(new Vector(140, 130), new Vector(80, 40))]);
    section.adjustLocationAndSize();
    expect(section.rectangle.left).toBe(70);
    expect(section.rectangle.top).toBe(20);
    expect(section.rectangle.right).toBe(360);
    expect(section.rectangle.bottom).toBe(290);

    // Dragging handle inward clamps to MANUAL_MIN_PADDING around child (right=220+10=230, bottom=170+10=180)
    section.resizeHandle(new Vector(-500, -500));
    expect(section.rectangle.left).toBe(70);
    expect(section.rectangle.top).toBe(20);
    expect(section.rectangle.right).toBe(230);
    expect(section.rectangle.bottom).toBe(180);
    expect(solveOverlaps).toHaveBeenCalledTimes(1);
  });

  it("expands only exceeded walls when a child moves beyond manual bounds and supports resetAutoSize", () => {
    const child = createMockNode(100, 100, 80, 40);
    const { section } = createMockSection([child]);

    section.resizeHandle(new Vector(200, 200));
    expect(section.rectangle.right).toBe(410);
    expect(section.rectangle.bottom).toBe(370);

    // Move child past the left wall while staying inside right/bottom
    child.collisionBox = new CollisionBox([new Rectangle(new Vector(40, 100), new Vector(80, 40))]);
    section.adjustLocationAndSize();
    expect(section.rectangle.left).toBe(30); // 40 - MANUAL_MIN_PADDING(10)
    expect(section.rectangle.right).toBe(410);
    expect(section.rectangle.bottom).toBe(370);

    // Reset back to auto-fit size
    section.resetAutoSize();
    expect(section.sizeAdjust).toBe("auto");
    expect(section.rectangle.left).toBe(10); // 40 - AUTO_PADDING(30)
    expect(section.rectangle.right).toBe(150); // 120 + AUTO_PADDING(30)
    expect(section.rectangle.bottom).toBe(170); // 140 + AUTO_PADDING(30)
  });

  it("supports resizing empty sections and ignores locked or collapsed sections", () => {
    const { section } = createMockSection([], "");
    expect(section.rectangle.size).toEqual(new Vector(100, 100));

    section.resizeHandle(new Vector(120, 80));
    expect(section.rectangle.size).toEqual(new Vector(220, 180));
    section.adjustLocationAndSize();
    expect(section.rectangle.size).toEqual(new Vector(220, 180));

    // Bottom-right 25x25 resize handle rect
    const handle = section.getResizeHandleRect();
    expect(handle.location).toEqual(new Vector(195, 155));
    expect(handle.size).toEqual(new Vector(25, 25));

    // Locked or collapsed sections do not resize
    section.locked = true;
    section.resizeHandle(new Vector(50, 50));
    expect(section.rectangle.size).toEqual(new Vector(220, 180));

    section.locked = false;
    section.isCollapsed = true;
    section.resizeHandle(new Vector(50, 50));
    expect(section["_collisionBoxNormal"].getRectangle().size).toEqual(new Vector(220, 180));
  });
});
