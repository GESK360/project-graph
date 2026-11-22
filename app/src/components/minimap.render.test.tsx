// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

const settingsState = { showMinimap: true };
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    use: () => [settingsState.showMinimap, () => {}],
  },
}));
vi.mock("@/state", () => ({ isClassroomModeAtom: {} }));
vi.mock("jotai", () => ({ useAtom: () => [false, () => {}] }));

declare global {
  // React 需要这个标记才允许在测试里使用 act()
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { Vector } from "@graphif/data-structures";
import { Line, Rectangle } from "@graphif/shapes";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Project } from "@/core/Project";
import Minimap, {
  clampPointToMinimap,
  collectGeometry,
  drawStaticLayer,
  drawViewLayer,
  MINIMAP_HEIGHT,
  MINIMAP_WIDTH,
  toMinimapPoint,
  toWorldPoint,
} from "./minimap";

type DrawOperation =
  | { type: "clearRect" }
  | { type: "moveTo"; x: number; y: number }
  | { type: "lineTo"; x: number; y: number }
  | { type: "rect"; width: number; height: number }
  | { type: "fill"; fillStyle: unknown }
  | { type: "stroke"; strokeStyle: unknown };

function createRecordingContext() {
  const operations: DrawOperation[] = [];
  const context = {
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown,
    lineWidth: 1,
    setTransform: () => {},
    save: () => {},
    restore: () => {},
    clip: () => {},
    roundRect: () => {},
    beginPath: () => {},
    clearRect: () => {
      operations.push({ type: "clearRect" });
    },
    moveTo: (x: number, y: number) => {
      operations.push({ type: "moveTo", x, y });
    },
    lineTo: (x: number, y: number) => {
      operations.push({ type: "lineTo", x, y });
    },
    rect: (_x: number, _y: number, width: number, height: number) => {
      operations.push({ type: "rect", width, height });
    },
    fill: () => {
      operations.push({ type: "fill", fillStyle: context.fillStyle });
    },
    stroke: () => {
      operations.push({ type: "stroke", strokeStyle: context.strokeStyle });
    },
  };
  return { context, operations };
}

function rectangleOf(left: number, top: number, width: number, height: number) {
  return new Rectangle(new Vector(left, top), new Vector(width, height));
}

function lineOf(x1: number, y1: number, x2: number, y2: number) {
  return new Line(new Vector(x1, y1), new Vector(x2, y2));
}

function createFakeProject(nodeRectangles: Rectangle[], edgeLines: Line[], viewRectangle: Rectangle) {
  const entities = nodeRectangles.map((rectangle) => ({
    isHiddenBySectionCollapse: false,
    collisionBox: { getRectangle: () => rectangle },
  }));
  const edges = edgeLines.map((line) => ({ isHiddenBySectionCollapse: false, bodyLine: line }));
  const viewSize = viewRectangle.size.clone();
  const camera = {
    location: viewRectangle.center.clone(),
    currentScale: 1,
    bombMove: vi.fn(),
    stopImmediately: vi.fn(),
  };
  return {
    stage: [...nodeRectangles, ...edgeLines],
    stageManager: {
      isHiddenByBranchCollapse: () => false,
      getEntities: () => entities,
      getEdges: () => edges,
    },
    renderer: {
      getCoverWorldRectangle: () => new Rectangle(camera.location.subtract(viewSize.divide(2)), viewSize.clone()),
      w: viewSize.x,
      h: viewSize.y,
    },
    camera,
    controller: {
      resetCountdownTimer: vi.fn(),
    },
  } as unknown as Project;
}

function attachMinimapBounds(overlay: HTMLCanvasElement) {
  overlay.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: MINIMAP_WIDTH,
      bottom: MINIMAP_HEIGHT,
      width: MINIMAP_WIDTH,
      height: MINIMAP_HEIGHT,
    }) as DOMRect;
}

describe("小地图绘制", () => {
  it("静态层依次画坐标轴、连线和节点", () => {
    const nodes = [rectangleOf(0, 0, 100, 100), rectangleOf(300, 300, 100, 100)];
    const edges = [lineOf(100, 100, 300, 300)];
    const project = createFakeProject(nodes, edges, rectangleOf(0, 0, 100, 100));
    const geometry = collectGeometry(project);
    const { context, operations } = createRecordingContext();

    drawStaticLayer(context as unknown as CanvasRenderingContext2D, geometry);

    expect(operations[0]).toEqual({ type: "clearRect" });

    const strokes = operations.filter((operation) => operation.type === "stroke");
    // 第一条 path 是 x/y 坐标轴，第二条是连线
    expect(strokes).toHaveLength(2);
    expect(strokes[0].type === "stroke" ? strokes[0].strokeStyle : "").toBe("rgba(148, 163, 184, 0.6)");
    expect(strokes[1].type === "stroke" ? strokes[1].strokeStyle : "").toBe("rgba(148, 163, 184, 0.38)");

    const fills = operations.filter((operation) => operation.type === "fill");
    expect(fills).toHaveLength(1);
    expect(fills[0].type === "fill" ? fills[0].fillStyle : "").toBe("rgba(148, 163, 184, 0.75)");

    // 节点攒成一条 path，一次 fill 画完
    const rects = operations.filter((operation) => operation.type === "rect");
    expect(rects).toHaveLength(nodes.length);
  });

  it("坐标轴画在 x = 0 与 y = 0 上", () => {
    const nodes = [rectangleOf(-200, -100, 400, 200)];
    const project = createFakeProject(nodes, [], rectangleOf(0, 0, 100, 100));
    const geometry = collectGeometry(project);
    const { context, operations } = createRecordingContext();

    drawStaticLayer(context as unknown as CanvasRenderingContext2D, geometry);

    const layout = geometry.layout;
    const expectedXAxisY = layout.offset.y;
    const expectedYAxisX = layout.offset.x;
    const moveTos = operations.filter((operation) => operation.type === "moveTo");
    expect(moveTos).toHaveLength(2);
    // x 轴：从世界左边到右边，y 恒为 0
    expect(moveTos[0].type === "moveTo" ? moveTos[0].y : Number.NaN).toBeCloseTo(expectedXAxisY);
    // y 轴：从世界上边到下边，x 恒为 0
    expect(moveTos[1].type === "moveTo" ? moveTos[1].x : Number.NaN).toBeCloseTo(expectedYAxisX);
  });

  it("动态层画一个绿色视野框", () => {
    const nodes = [rectangleOf(0, 0, 1000, 1000)];
    const view = rectangleOf(100, 100, 200, 200);
    const project = createFakeProject(nodes, [], view);
    const geometry = collectGeometry(project);
    const { context, operations } = createRecordingContext();

    drawViewLayer(context as unknown as CanvasRenderingContext2D, view, geometry.layout);

    expect(operations[0]).toEqual({ type: "clearRect" });
    const strokes = operations.filter((operation) => operation.type === "stroke");
    expect(strokes).toHaveLength(1);
    expect(strokes[0].type === "stroke" ? strokes[0].strokeStyle : "").toBe("rgba(34, 197, 94, 0.95)");
    const fills = operations.filter((operation) => operation.type === "fill");
    expect(fills).toHaveLength(1);
    expect(fills[0].type === "fill" ? fills[0].fillStyle : "").toBe("rgba(34, 197, 94, 0.12)");
  });
});

describe("小地图组件", () => {
  async function renderMinimap(
    project: Project,
    beforeUnmount?: (container: HTMLElement, frames: FrameRequestCallback[]) => void,
  ) {
    const contexts = [createRecordingContext(), createRecordingContext()];
    let contextIndex = 0;
    const getContext = vi
      .spyOn(window.HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => contexts[Math.min(contextIndex++, 1)].context as never);
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Minimap project={project} />);
    });
    await act(async () => {
      frames.shift()?.(0);
    });

    beforeUnmount?.(container, frames);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    getContext.mockRestore();
    requestAnimationFrame.mockRestore();
    cancelAnimationFrame.mockRestore();
    return contexts;
  }

  it("渲染出静态层与动态层两块画布，并画出内容", async () => {
    const nodes = [rectangleOf(0, 0, 100, 100), rectangleOf(300, 300, 100, 100)];
    const project = createFakeProject(nodes, [lineOf(100, 100, 300, 300)], rectangleOf(0, 0, 100, 100));

    let canvasCount = 0;
    const contexts = await renderMinimap(project, (container) => {
      canvasCount = container.querySelectorAll("canvas").length;
    });

    expect(canvasCount).toBe(2);
    expect(contexts[0].operations.some((operation) => operation.type === "fill")).toBe(true);
    expect(contexts[1].operations.some((operation) => operation.type === "stroke")).toBe(true);
  });

  it("点击小地图把视野中心移动到对应世界坐标", async () => {
    const nodes = [rectangleOf(0, 0, 200, 200), rectangleOf(600, 400, 200, 200)];
    const view = rectangleOf(0, 0, 100, 100);
    const project = createFakeProject(nodes, [], view);
    const layout = collectGeometry(project).layout;
    const clickX = 90;
    const clickY = 60;
    const expectedWorld = new Vector(
      (clickX - layout.offset.x) / layout.scale,
      (clickY - layout.offset.y) / layout.scale,
    );

    await renderMinimap(project, (container) => {
      const overlay = container.querySelectorAll("canvas")[1] as HTMLCanvasElement;
      attachMinimapBounds(overlay);
      overlay.dispatchEvent(new MouseEvent("pointerdown", { clientX: clickX, clientY: clickY, bubbles: true }));
    });

    const bombMove = (project.camera as unknown as { bombMove: { mock: { calls: [Vector][] } } }).bombMove;
    expect(bombMove.mock.calls).toHaveLength(1);
    const movedTo = bombMove.mock.calls[0][0];
    expect(movedTo.x).toBeCloseTo(expectedWorld.x);
    expect(movedTo.y).toBeCloseTo(expectedWorld.y);
  });

  it("在小地图任意位置按下并拖动时，视野中心始终直接跟随鼠标位置（不拖拽绿框）", async () => {
    const nodes = [rectangleOf(0, 0, 200, 200), rectangleOf(600, 400, 200, 200)];
    const view = rectangleOf(100, 100, 300, 240);
    const project = createFakeProject(nodes, [], view);
    const layout = collectGeometry(project).layout;
    const viewCenterOnMinimap = toMinimapPoint(view.center, layout);
    // 故意从绿框内偏离中心的位置开始拖动，验证直接对准鼠标位置而非保留绿框抓取偏移
    const startX = viewCenterOnMinimap.x + 14;
    const startY = viewCenterOnMinimap.y - 8;
    const midX = startX + 20;
    const midY = startY + 12;
    const endX = 140;
    const endY = 90;
    const expectedStartWorld = toWorldPoint(new Vector(startX, startY), layout);
    const expectedMidWorld = toWorldPoint(new Vector(midX, midY), layout);
    const expectedEndWorld = toWorldPoint(new Vector(endX, endY), layout);

    await renderMinimap(project, (container) => {
      const overlay = container.querySelectorAll("canvas")[1] as HTMLCanvasElement;
      attachMinimapBounds(overlay);

      overlay.dispatchEvent(new MouseEvent("pointerdown", { clientX: startX, clientY: startY, bubbles: true }));
      const bombMove = (project.camera as unknown as { bombMove: { mock: { calls: [Vector][] } } }).bombMove;
      expect(bombMove.mock.calls).toHaveLength(1);
      expect(bombMove.mock.calls[0][0].x).toBeCloseTo(expectedStartWorld.x);
      expect(bombMove.mock.calls[0][0].y).toBeCloseTo(expectedStartWorld.y);

      // 2px 轻微抖动不取消点击的平滑移动
      overlay.dispatchEvent(new MouseEvent("pointermove", { clientX: startX + 2, clientY: startY, bubbles: true }));
      expect(project.camera.stopImmediately).not.toHaveBeenCalled();

      // 超过阈值后直接跟随鼠标在小地图上的位置
      overlay.dispatchEvent(new MouseEvent("pointermove", { clientX: midX, clientY: midY, bubbles: true }));
      expect(project.camera.stopImmediately).toHaveBeenCalled();
      expect(project.camera.location.x).toBeCloseTo(expectedMidWorld.x);
      expect(project.camera.location.y).toBeCloseTo(expectedMidWorld.y);

      overlay.dispatchEvent(new MouseEvent("pointermove", { clientX: endX, clientY: endY, bubbles: true }));
      expect(project.camera.location.x).toBeCloseTo(expectedEndWorld.x);
      expect(project.camera.location.y).toBeCloseTo(expectedEndWorld.y);

      overlay.dispatchEvent(new MouseEvent("pointerup", { clientX: endX, clientY: endY, bubbles: true }));

      // 松手后继续移动鼠标，视野不应再跟着动
      overlay.dispatchEvent(new MouseEvent("pointermove", { clientX: 20, clientY: 20, bubbles: true }));
    });

    expect(project.controller.resetCountdownTimer).toHaveBeenCalled();
    expect(project.camera.location.x).toBeCloseTo(expectedEndWorld.x);
    expect(project.camera.location.y).toBeCloseTo(expectedEndWorld.y);
  });

  it("鼠标拖出小地图边框外时，视野中心限制在小地图边框内部", async () => {
    const nodes = [rectangleOf(0, 0, 200, 200), rectangleOf(600, 400, 200, 200)];
    const view = rectangleOf(100, 100, 200, 160);
    const project = createFakeProject(nodes, [], view);
    const layout = collectGeometry(project).layout;
    const expectedBottomRight = toWorldPoint(clampPointToMinimap(new Vector(300, 220)), layout);
    const expectedTopLeft = toWorldPoint(clampPointToMinimap(new Vector(-120, -80)), layout);

    await renderMinimap(project, (container) => {
      const overlay = container.querySelectorAll("canvas")[1] as HTMLCanvasElement;
      attachMinimapBounds(overlay);

      overlay.dispatchEvent(new MouseEvent("pointerdown", { clientX: 90, clientY: 60, bubbles: true }));

      overlay.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 220, bubbles: true }));
      expect(project.camera.location.x).toBeCloseTo(expectedBottomRight.x);
      expect(project.camera.location.y).toBeCloseTo(expectedBottomRight.y);

      overlay.dispatchEvent(new MouseEvent("pointermove", { clientX: -120, clientY: -80, bubbles: true }));
      expect(project.camera.location.x).toBeCloseTo(expectedTopLeft.x);
      expect(project.camera.location.y).toBeCloseTo(expectedTopLeft.y);

      overlay.dispatchEvent(new MouseEvent("pointerup", { clientX: -120, clientY: -80, bubbles: true }));
    });
  });

  it("空画布拖动期间冻结小地图布局，不会因静态层刷新发生漂移", async () => {
    const view = rectangleOf(-400, -300, 800, 600);
    const project = createFakeProject([], [], view);
    const initialLayout = collectGeometry(project).layout;
    const centerOnMinimap = toMinimapPoint(view.center, initialLayout);

    let now = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);

    await renderMinimap(project, (container, frames) => {
      const overlay = container.querySelectorAll("canvas")[1] as HTMLCanvasElement;
      attachMinimapBounds(overlay);

      overlay.dispatchEvent(
        new MouseEvent("pointerdown", { clientX: centerOnMinimap.x, clientY: centerOnMinimap.y, bubbles: true }),
      );
      overlay.dispatchEvent(
        new MouseEvent("pointermove", { clientX: centerOnMinimap.x + 20, clientY: centerOnMinimap.y, bubbles: true }),
      );

      // 推进时间超过 200ms 静态层刷新周期并跑一帧 rAF
      now += 500;
      frames.shift()?.(now);

      overlay.dispatchEvent(
        new MouseEvent("pointermove", { clientX: centerOnMinimap.x + 40, clientY: centerOnMinimap.y, bubbles: true }),
      );
      expect(project.camera.location.x).toBeCloseTo(40 / initialLayout.scale);

      overlay.dispatchEvent(
        new MouseEvent("pointerup", { clientX: centerOnMinimap.x + 40, clientY: centerOnMinimap.y, bubbles: true }),
      );
    });

    nowSpy.mockRestore();
  });

  it("右键不触发移动，窗口失焦会自动结束拖动", async () => {
    const nodes = [rectangleOf(0, 0, 200, 200), rectangleOf(600, 400, 200, 200)];
    const view = rectangleOf(100, 100, 200, 160);
    const project = createFakeProject(nodes, [], view);

    await renderMinimap(project, (container) => {
      const overlay = container.querySelectorAll("canvas")[1] as HTMLCanvasElement;
      attachMinimapBounds(overlay);

      // 右键不触发移动
      overlay.dispatchEvent(new MouseEvent("pointerdown", { clientX: 120, clientY: 80, button: 2, bubbles: true }));
      expect(project.camera.bombMove).not.toHaveBeenCalled();

      // 拖动途中窗口失焦自动结束拖动
      overlay.dispatchEvent(new MouseEvent("pointerdown", { clientX: 60, clientY: 60, bubbles: true }));
      overlay.dispatchEvent(new MouseEvent("pointermove", { clientX: 90, clientY: 60, bubbles: true }));
      const locationBeforeBlur = project.camera.location.clone();
      window.dispatchEvent(new Event("blur"));

      overlay.dispatchEvent(new MouseEvent("pointermove", { clientX: 150, clientY: 90, bubbles: true }));
      expect(project.camera.location.x).toBeCloseTo(locationBeforeBlur.x);
      expect(project.camera.location.y).toBeCloseTo(locationBeforeBlur.y);
    });
  });

  it("关闭设置后不渲染画布", async () => {
    settingsState.showMinimap = false;
    const project = createFakeProject([rectangleOf(0, 0, 10, 10)], [], rectangleOf(0, 0, 10, 10));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Minimap project={project} />);
    });
    expect(container.querySelector("canvas")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    settingsState.showMinimap = true;
  });
});
