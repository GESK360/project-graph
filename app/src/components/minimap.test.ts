// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/service/Settings", () => ({
  Settings: {
    use: () => [false, () => {}],
  },
}));
vi.mock("@/state", () => ({ isClassroomModeAtom: {} }));

import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import {
  clampPointToMinimap,
  createLayout,
  MINIMAP_HEIGHT,
  MINIMAP_PADDING,
  MINIMAP_WIDTH,
  toMinimapPoint,
  toMinimapRectangle,
  toWorldPoint,
} from "./minimap";

function rectangleOf(left: number, top: number, width: number, height: number) {
  return new Rectangle(new Vector(left, top), new Vector(width, height));
}

describe("小地图布局", () => {
  it("把最外侧节点完整放进固定尺寸的小地图", () => {
    const nodes = [rectangleOf(0, 0, 100, 100), rectangleOf(400, 300, 100, 100)];
    const layout = createLayout(nodes, rectangleOf(0, 0, 1, 1));

    for (const node of nodes) {
      const mapped = toMinimapRectangle(node, layout);
      expect(mapped.left).toBeGreaterThanOrEqual(MINIMAP_PADDING - 1e-6);
      expect(mapped.top).toBeGreaterThanOrEqual(MINIMAP_PADDING - 1e-6);
      expect(mapped.right).toBeLessThanOrEqual(MINIMAP_WIDTH - MINIMAP_PADDING + 1e-6);
      expect(mapped.bottom).toBeLessThanOrEqual(MINIMAP_HEIGHT - MINIMAP_PADDING + 1e-6);
    }
  });

  it("节点范围变大时自动缩小比例，尺寸本身不变", () => {
    const nearNodes = [rectangleOf(0, 0, 100, 100), rectangleOf(200, 200, 100, 100)];
    const farNodes = [...nearNodes, rectangleOf(5000, 5000, 100, 100)];
    const nearLayout = createLayout(nearNodes, rectangleOf(0, 0, 1, 1));
    const farLayout = createLayout(farNodes, rectangleOf(0, 0, 1, 1));

    expect(farLayout.scale).toBeLessThan(nearLayout.scale);
    expect(MINIMAP_WIDTH).toBe(180);
    expect(MINIMAP_HEIGHT).toBe(120);
  });

  it("横竖方向使用同一个缩放比例，不会把图形拉变形", () => {
    const nodes = [rectangleOf(0, 0, 400, 100)];
    const layout = createLayout(nodes, rectangleOf(0, 0, 1, 1));

    const wide = toMinimapRectangle(nodes[0], layout);
    const square = toMinimapRectangle(rectangleOf(0, 0, 100, 100), layout);

    expect(wide.width / wide.height).toBeCloseTo(4);
    expect(square.width / square.height).toBeCloseTo(1);
  });

  it("没有节点时改用当前视野作为范围", () => {
    const view = rectangleOf(-100, -50, 200, 100);
    const layout = createLayout([], view);

    const mapped = toMinimapRectangle(view, layout);
    expect(mapped.width).toBeCloseTo(200 * layout.scale);
    expect(mapped.height).toBeCloseTo(100 * layout.scale);
    expect(mapped.center.x).toBeCloseTo(MINIMAP_WIDTH / 2);
    expect(mapped.center.y).toBeCloseTo(MINIMAP_HEIGHT / 2);
  });

  it("视野框按同一套比例映射，中心位置对应世界坐标位置", () => {
    const nodes = [rectangleOf(0, 0, 1000, 1000)];
    const layout = createLayout(nodes, rectangleOf(0, 0, 1, 1));

    const worldCenter = new Vector(500, 500);
    const viewRectangle = new Rectangle(worldCenter.subtract(new Vector(50, 50)), new Vector(100, 100));
    const mapped = toMinimapRectangle(viewRectangle, layout);

    expect(mapped.center.x).toBeCloseTo(500 * layout.scale + layout.offset.x);
    expect(mapped.center.y).toBeCloseTo(500 * layout.scale + layout.offset.y);
    expect(mapped.width).toBeCloseTo(100 * layout.scale);
  });

  it("原点在附近时把坐标轴范围包含进来", () => {
    const nodes = [rectangleOf(100, 100, 400, 300)];
    const layout = createLayout(nodes, rectangleOf(0, 0, 1, 1));

    expect(layout.bounds.left).toBeLessThanOrEqual(0);
    expect(layout.bounds.top).toBeLessThanOrEqual(0);
    expect(layout.bounds.right).toBeGreaterThanOrEqual(500);
    expect(layout.bounds.bottom).toBeGreaterThanOrEqual(400);
  });

  it("原点离得太远时不强行并入，避免节点被压成一团", () => {
    const nodes = [rectangleOf(100000, 100000, 400, 300)];
    const layout = createLayout(nodes, rectangleOf(0, 0, 1, 1));

    expect(layout.bounds.left).toBeGreaterThan(0);
    expect(layout.bounds.top).toBeGreaterThan(0);
    // 节点仍占满小地图
    const mapped = toMinimapRectangle(nodes[0], layout);
    expect(mapped.width).toBeGreaterThan(MINIMAP_WIDTH / 2);
  });

  it("世界坐标与小地图坐标可以无损互转", () => {
    const nodes = [rectangleOf(-250, -120, 900, 600)];
    const layout = createLayout(nodes, rectangleOf(0, 0, 1, 1));
    const world = new Vector(315, 240);

    const minimapPoint = toMinimapPoint(world, layout);
    const roundTripped = toWorldPoint(minimapPoint, layout);

    expect(roundTripped.x).toBeCloseTo(world.x);
    expect(roundTripped.y).toBeCloseTo(world.y);
  });

  it("指针位置限制在小地图边框内部，不会越出小地图范围", () => {
    const topLeft = clampPointToMinimap(new Vector(-40, -25));
    expect(topLeft.x).toBe(0);
    expect(topLeft.y).toBe(0);

    const bottomRight = clampPointToMinimap(new Vector(MINIMAP_WIDTH + 60, MINIMAP_HEIGHT + 30));
    expect(bottomRight.x).toBe(MINIMAP_WIDTH);
    expect(bottomRight.y).toBe(MINIMAP_HEIGHT);

    const inside = clampPointToMinimap(new Vector(75, 42));
    expect(inside.x).toBe(75);
    expect(inside.y).toBe(42);
  });
});
