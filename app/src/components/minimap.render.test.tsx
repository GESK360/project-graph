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
import { Rectangle } from "@graphif/shapes";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Project } from "@/core/Project";
import Minimap, { createLayout, MINIMAP_HEIGHT, MINIMAP_WIDTH } from "./minimap";

type DrawOperation =
  | { type: "clearRect" }
  | { type: "fillRect"; left: number; top: number; width: number; height: number }
  | { type: "stroke"; strokeStyle: unknown }
  | { type: "fill"; fillStyle: unknown };

function createFakeCanvasContext() {
  const operations: DrawOperation[] = [];
  const context = {
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown,
    lineWidth: 1,
    setTransform: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    clip: () => {},
    rect: () => {},
    roundRect: () => {},
    clearRect: () => {
      operations.push({ type: "clearRect" });
    },
    fillRect: (left: number, top: number, width: number, height: number) => {
      operations.push({ type: "fillRect", left, top, width, height });
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

function createFakeProject(nodeRectangles: Rectangle[], viewRectangle: Rectangle) {
  return {
    stage: nodeRectangles,
    stageManager: {
      getEntities: () =>
        nodeRectangles.map((rectangle) => ({
          isHiddenBySectionCollapse: false,
          collisionBox: { getRectangle: () => rectangle },
        })),
    },
    renderer: { getCoverWorldRectangle: () => viewRectangle },
    camera: { bombMove: vi.fn() },
  } as unknown as Project;
}

async function renderMinimapOnce(
  project: Project,
  operations: DrawOperation[],
  beforeUnmount?: (canvas: HTMLCanvasElement) => void,
) {
  const canvasPrototype = window.HTMLCanvasElement.prototype;
  const fakeCanvas = createFakeCanvasContext();
  const getContext = vi.spyOn(canvasPrototype, "getContext").mockReturnValue(fakeCanvas.context as never);
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

  // 让 rAF 回调同步跑一次，跑完的绘制指令全部记录在 operations 里
  await act(async () => {
    const frame = frames.shift();
    frame?.(0);
  });

  operations.push(...fakeCanvas.operations);

  const canvas = container.querySelector("canvas");
  if (canvas) beforeUnmount?.(canvas);

  await act(async () => {
    root.unmount();
  });
  container.remove();

  getContext.mockRestore();
  requestAnimationFrame.mockRestore();
  cancelAnimationFrame.mockRestore();
}

describe("小地图绘制", () => {
  it("绘制节点，并在节点之上画出表示当前视野的绿色框", async () => {
    const nodeRectangles = [rectangleOf(0, 0, 100, 100), rectangleOf(300, 300, 100, 100)];
    const viewRectangle = rectangleOf(0, 0, 100, 100);
    const project = createFakeProject(nodeRectangles, viewRectangle);
    const operations: DrawOperation[] = [];

    await renderMinimapOnce(project, operations);

    const fillRectOperations = operations.filter((operation) => operation.type === "fillRect");
    expect(fillRectOperations).toHaveLength(nodeRectangles.length);

    const layout = createLayout(nodeRectangles, viewRectangle);
    for (const operation of fillRectOperations) {
      if (operation.type !== "fillRect") continue;
      expect(operation.left).toBeGreaterThanOrEqual(0);
      expect(operation.top).toBeGreaterThanOrEqual(0);
      expect(operation.left + operation.width).toBeLessThanOrEqual(MINIMAP_WIDTH);
      expect(operation.top + operation.height).toBeLessThanOrEqual(MINIMAP_HEIGHT);
    }

    const viewOperations = operations.filter((operation) => operation.type === "stroke");
    expect(viewOperations).toHaveLength(1);
    const lastViewOperation = viewOperations[0];
    if (lastViewOperation.type !== "stroke") throw new Error("unreachable");
    expect(lastViewOperation.strokeStyle).toBe("rgba(34, 197, 94, 0.95)");

    const clearIndex = operations.findIndex((operation) => operation.type === "clearRect");
    const firstFillIndex = operations.findIndex((operation) => operation.type === "fillRect");
    const strokeIndex = operations.findIndex((operation) => operation.type === "stroke");
    expect(clearIndex).toBeLessThan(firstFillIndex);
    expect(firstFillIndex).toBeLessThan(strokeIndex);

    expect(layout.scale).toBeGreaterThan(0);
  });

  it("点击小地图把视野中心移动到对应世界坐标", async () => {
    const nodeRectangles = [rectangleOf(0, 0, 200, 200), rectangleOf(600, 400, 200, 200)];
    const viewRectangle = rectangleOf(0, 0, 100, 100);
    const project = createFakeProject(nodeRectangles, viewRectangle);
    const layout = createLayout(nodeRectangles, viewRectangle);
    const clickX = 90;
    const clickY = 60;
    const expectedWorld = new Vector(
      (clickX - layout.offset.x) / layout.scale,
      (clickY - layout.offset.y) / layout.scale,
    );

    await renderMinimapOnce(project, [], (canvas) => {
      canvas.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: MINIMAP_WIDTH,
          bottom: MINIMAP_HEIGHT,
          width: MINIMAP_WIDTH,
          height: MINIMAP_HEIGHT,
        }) as DOMRect;
      canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: clickX, clientY: clickY, bubbles: true }));
    });

    const bombMove = (project.camera as unknown as { bombMove: { mock: { calls: [Vector][] } } }).bombMove;
    expect(bombMove.mock.calls).toHaveLength(1);
    const movedTo = bombMove.mock.calls[0][0];
    expect(movedTo.x).toBeCloseTo(expectedWorld.x);
    expect(movedTo.y).toBeCloseTo(expectedWorld.y);
  });

  it("关闭设置后不渲染画布", async () => {
    settingsState.showMinimap = false;
    const project = createFakeProject([rectangleOf(0, 0, 10, 10)], rectangleOf(0, 0, 10, 10));
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
