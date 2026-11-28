// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Vector } from "@graphif/data-structures";
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
    isEnableEntityCollision: false,
    sectionInitBorderStyle: "solid",
    textNodeInitBorderStyle: "solid",
    defaultEdgeLineType: "solid",
    defaultEdgeArrowType: "default",
    enableAutoEdgeWidth: false,
    hideSectionContentsWhenBigTitleActive: false,
    sectionBitTitleRenderType: "none",
  },
}));
vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => new Vector(80, 32),
  getTextSize: () => new Vector(80, 32),
}));
vi.mock("@/core/service/feedbackService/SoundService", () => ({
  SoundService: { play: { entityJumpSoundFile: vi.fn() } },
}));

import { StageManager } from "./StageManager";
import { GraphMethods } from "./basicMethods/GraphMethods";
import { SectionMethods } from "./basicMethods/SectionMethods";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";

function createSpatialProject() {
  const services = new Map<string, unknown>();
  const project: any = {
    stage: [],
    sectionMoveDepth: 0,
    tags: [],
    references: { sections: {}, files: [] },
    effects: { addEffect: vi.fn(), addMoveShadow: vi.fn() },
    sectionCollisionSolver: { solveOverlaps: vi.fn() },
    getService: (id: string) => services.get(id),
  };
  const register = <T>(id: string, inst: T): T => {
    services.set(id, inst);
    project[id] = inst;
    return inst;
  };
  register("sectionMethods", new SectionMethods(project));
  register("graphMethods", new GraphMethods(project));
  register("stageManager", new StageManager(project));
  return project;
}

describe("StageManager O(1) Map & RBush 2D spatial index", () => {
  it("culls 5,000 entities via RBush viewport query and updates spatial bounds incrementally on move & replace", () => {
    const project = createSpatialProject();
    const nodes: TextNode[] = [];
    for (let i = 0; i < 5000; i++) {
      const col = i % 100;
      const row = Math.floor(i / 100);
      const node = new TextNode(project, {
        uuid: `node-${i}`,
        text: `N${i}`,
        collisionBox: new CollisionBox([new Rectangle(new Vector(col * 200, row * 120), new Vector(100, 40))]),
      });
      nodes.push(node);
      project.stage.push(node);
    }
    const edge = new LineEdge(project, {
      uuid: "edge-0-1",
      associationList: [nodes[0], nodes[1]],
    });
    project.stage.push(edge);
    project.stageManager.updateReferences();

    // O(1) lookup
    expect(project.stageManager.get("node-4999")).toBe(nodes[4999]);
    expect(project.stageManager.getTextNodeByUUID("node-4999")).toBe(nodes[4999]);
    expect(project.stageManager.isEntityExists("node-4999")).toBe(true);
    expect(project.stageManager.getIncidentAssociations("node-0")).toContain(edge);

    // Viewport culling returns only intersecting entities, in < 2ms
    const viewport = new Rectangle(new Vector(-10, -10), new Vector(450, 260));
    const t0 = performance.now();
    const visible = project.stageManager.queryEntitiesInRect(viewport);
    const queryMs = performance.now() - t0;
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(20);
    expect(queryMs).toBeLessThan(2);

    // Incremental move updates RBush + incident edge bounds
    nodes[0].move(new Vector(20000, 20000));
    expect(
      project.stageManager.queryEntitiesInRect(new Rectangle(new Vector(19950, 19950), new Vector(200, 200))),
    ).toContain(nodes[0]);
    expect(project.stageManager.isEntityOnLocation(new Vector(20020, 20020))).toBe(true);
    expect(project.stageManager.isEntityOnLocation(new Vector(20, 20))).toBe(false);

    // In-place replaceStageObject keeps typed caches & RBush consistent
    const promoted = new Section(project, {
      uuid: nodes[1].uuid,
      text: nodes[1].text,
      collisionBox: nodes[1].collisionBox,
    });
    project.stageManager.replaceStageObject(nodes[1], promoted);
    expect(project.stageManager.get(nodes[1].uuid)).toBe(promoted);
    expect(project.stageManager.getSectionByUUID(nodes[1].uuid)).toBe(promoted);
    expect(project.stageManager.getTextNodeByUUID(nodes[1].uuid)).toBeNull();
  });
});
