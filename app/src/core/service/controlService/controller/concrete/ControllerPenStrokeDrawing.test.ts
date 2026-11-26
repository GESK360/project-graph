import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/core/Project";

const storeEntries = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async init() {}
    async entries() {
      return Array.from(storeEntries.entries());
    }
    async get(key: string) {
      return storeEntries.get(key);
    }
    async set(key: string, value: unknown) {
      storeEntries.set(key, value);
    }
    async save() {}
  },
}));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { confirm: vi.fn() } }));
vi.mock("@/utils/platform", () => ({ isMac: false, isWindows: true, isLinux: false }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/core/Project", () => ({}));
vi.mock("@/core/stage/stageObject/entity/PenStroke", () => ({
  PenStroke: class {
    segments: unknown[];
    constructor(_project: unknown, opts: { segments: unknown[] }) {
      this.segments = opts.segments;
    }
  },
  PenStrokeSegment: class {
    location: unknown;
    pressure: number;
    constructor(location: unknown, pressure: number) {
      this.location = location;
      this.pressure = pressure;
    }
  },
}));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));

import { Settings } from "@/core/service/Settings";
import { buildPenCursorCssValue, CursorNameEnum } from "@/types/cursors";
import { Color, Vector } from "@graphif/data-structures";
import { ControllerPenStrokeDrawingClass } from "./ControllerPenStrokeDrawing";

function createTestProject() {
  const setHandwritingMode = vi.fn((enabled: boolean) => {
    Settings.mouseLeftMode = enabled ? "draw" : "selectAndMove";
  });
  const resetCountdownTimer = vi.fn();
  const setCursorName = vi.fn();
  const addedStrokes: unknown[] = [];
  const project = {
    controller: {
      setHandwritingMode,
      resetCountdownTimer,
      setCursorName,
      pressingKeySet: new Set<string>(),
      isMouseDown: [false, false, false],
      camera: { isPreGrabbingWhenSpace: false },
    },
    camera: { currentScale: 1 },
    renderer: {
      transformView2World: (v: Vector) => v.clone(),
    },
    stageManager: {
      add: vi.fn((stroke: unknown) => addedStrokes.push(stroke)),
      findEntityByLocation: vi.fn(() => null),
    },
    sectionMethods: {
      getInnermostSectionByLocation: vi.fn(() => null),
    },
    historyManager: {
      recordStep: vi.fn(),
    },
  } as unknown as Project;
  return {
    project,
    drawing: new ControllerPenStrokeDrawingClass(project),
    setHandwritingMode,
    resetCountdownTimer,
    setCursorName,
    addedStrokes,
  };
}

describe("ControllerPenStrokeDrawingClass.togglePenAndEraser", () => {
  beforeEach(() => {
    Settings.handwritingPens = [
      { id: "pen-1", color: "#2563EB", width: 5 },
      { id: "pen-2", color: "#EF4444", width: 8 },
      { id: "pen-3", color: "#22C55E", width: 12 },
    ];
    Settings.handwritingErasers = [
      { id: "eraser-1", size: 16, shape: "circle", type: "stroke" },
      { id: "eraser-2", size: 32, shape: "square", type: "point" },
    ];
    Settings.handwritingActiveTool = "pen-1";
    Settings.handwritingPenId = "pen-1";
    Settings.handwritingEraserId = "eraser-1";
    Settings.mouseLeftMode = "selectAndMove";
  });

  it("remembers the last used pen and eraser when toggling back and forth", () => {
    const { drawing, setHandwritingMode, resetCountdownTimer } = createTestProject();

    Settings.handwritingActiveTool = "pen-2";
    expect(Settings.handwritingPenId).toBe("pen-2");

    Settings.handwritingEraserId = "eraser-2";
    Settings.handwritingActiveTool = "eraser";
    expect(Settings.handwritingPenId).toBe("pen-2");

    drawing.togglePenAndEraser();
    expect(Settings.handwritingActiveTool).toBe("pen-2");
    expect(Settings.handwritingEraserId).toBe("eraser-2");
    expect(Settings.mouseLeftMode).toBe("draw");
    expect(setHandwritingMode).toHaveBeenCalledWith(true);
    expect(resetCountdownTimer).toHaveBeenCalledTimes(1);

    drawing.togglePenAndEraser();
    expect(Settings.handwritingActiveTool).toBe("eraser");
    expect(Settings.handwritingEraserId).toBe("eraser-2");
    expect(Settings.handwritingPenId).toBe("pen-2");
    expect(setHandwritingMode).toHaveBeenCalledTimes(1);
    expect(resetCountdownTimer).toHaveBeenCalledTimes(2);
  });

  it("switches to newly selected pen or eraser preset on subsequent toggles", () => {
    const { drawing } = createTestProject();
    Settings.mouseLeftMode = "draw";

    Settings.handwritingActiveTool = "pen-3";
    drawing.togglePenAndEraser();
    expect(Settings.handwritingActiveTool).toBe("eraser");
    expect(Settings.handwritingEraserId).toBe("eraser-1");

    Settings.handwritingEraserId = "eraser-2";
    drawing.togglePenAndEraser();
    expect(Settings.handwritingActiveTool).toBe("pen-3");

    drawing.togglePenAndEraser();
    expect(Settings.handwritingActiveTool).toBe("eraser");
    expect(Settings.handwritingEraserId).toBe("eraser-2");
  });

  it("falls back to the first available preset if the remembered preset was removed", () => {
    const { drawing } = createTestProject();

    Settings.handwritingActiveTool = "pen-2";
    Settings.handwritingEraserId = "eraser-2";
    Settings.handwritingActiveTool = "eraser";

    Settings.handwritingPens = [{ id: "pen-1", color: "#2563EB", width: 5 }];
    Settings.handwritingErasers = [{ id: "eraser-1", size: 16, shape: "circle", type: "stroke" }];

    drawing.togglePenAndEraser();
    expect(Settings.handwritingActiveTool).toBe("pen-1");

    drawing.togglePenAndEraser();
    expect(Settings.handwritingActiveTool).toBe("eraser");
    expect(Settings.handwritingEraserId).toBe("eraser-1");
  });

  it("initializes handwritingPenId from saved handwritingActiveTool when missing on load", async () => {
    storeEntries.clear();
    storeEntries.set("handwritingPens", [
      { id: "pen-1", color: "#2563EB", width: 5 },
      { id: "pen-2", color: "#EF4444", width: 8 },
    ]);
    storeEntries.set("handwritingActiveTool", "pen-2");
    vi.resetModules();

    const { Settings: ReloadedSettings, getSelectedHandwritingPen } = await import("@/core/service/Settings");
    expect(ReloadedSettings.handwritingPenId).toBe("pen-2");
    expect(getSelectedHandwritingPen().id).toBe("pen-2");

    storeEntries.clear();
  });
});

describe("pen cursor and pressure drawing integration", () => {
  beforeEach(() => {
    Settings.handwritingPens = [{ id: "pen-1", color: "#2563EB", width: 5 }];
    Settings.handwritingActiveTool = "pen-1";
    Settings.handwritingPenId = "pen-1";
    Settings.mouseLeftMode = "draw";
    Settings.enablePenPressure = true;
    Settings.penPressureCurve = "linear";
    Settings.penPressureSensitivity = 0.75;
    Settings.penVelocitySensitivity = 0.65;
    Settings.hideCursorInPenMode = false;
  });

  it("builds a top-left SVG pen cursor with a colored tip dot and adaptive contrast stroke", () => {
    const blueCursor = buildPenCursorCssValue(new Color(37, 99, 235, 1));
    expect(blueCursor).toContain('url("data:image/svg+xml;charset=utf-8,');
    expect(blueCursor).toContain(") 3 3, crosshair");
    const decodedBlue = decodeURIComponent(blueCursor);
    expect(decodedBlue).toContain('cx="3" cy="3"');
    expect(decodedBlue).toContain('fill="rgb(37,99,235)"');
    expect(decodedBlue).toContain('stroke="#FFFFFF"');

    const whiteCursor = buildPenCursorCssValue(new Color(255, 255, 255, 1));
    const decodedWhite = decodeURIComponent(whiteCursor);
    expect(decodedWhite).toContain('fill="rgb(255,255,255)"');
    expect(decodedWhite).toContain('stroke="#18181B"');
  });

  it("hides and restores the cursor across a stroke when hideCursorInPenMode is enabled", () => {
    Settings.hideCursorInPenMode = true;
    const { project, drawing, setCursorName } = createTestProject();
    project.controller.isMouseDown[0] = true;
    drawing.mousedown({
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerType: "mouse",
      pressure: 0.5,
      timeStamp: 100,
    } as PointerEvent);
    expect(setCursorName).toHaveBeenCalledWith(CursorNameEnum.None);

    drawing.mouseup({
      button: 0,
      clientX: 40,
      clientY: 10,
      pointerType: "mouse",
      pressure: 0,
      timeStamp: 140,
    } as PointerEvent);
    expect(setCursorName).toHaveBeenLastCalledWith(CursorNameEnum.Default);
  });

  it("produces dynamic pressure widths for mouse strokes when enabled and uniform widths when disabled", () => {
    const runStroke = (enabled: boolean) => {
      Settings.enablePenPressure = enabled;
      const { project, drawing, addedStrokes } = createTestProject();
      project.controller.isMouseDown[0] = true;
      drawing.mousedown({
        button: 0,
        clientX: 0,
        clientY: 0,
        pointerType: "mouse",
        pressure: 0.5,
        timeStamp: 100,
      } as PointerEvent);
      // 先慢画再快划
      const samples = [
        [3, 0, 140],
        [6, 0, 180],
        [10, 0, 220],
        [45, 0, 232],
        [95, 0, 244],
        [155, 0, 256],
      ];
      for (const [x, y, t] of samples) {
        drawing.mousemove({
          clientX: x,
          clientY: y,
          pointerType: "mouse",
          pressure: 0.5,
          timeStamp: t,
        } as PointerEvent);
      }
      drawing.mouseup({
        button: 0,
        clientX: 185,
        clientY: 0,
        pointerType: "mouse",
        pressure: 0,
        timeStamp: 266,
      } as PointerEvent);
      return (addedStrokes[0] as { segments: Array<{ pressure: number }> }).segments.map((s) => s.pressure);
    };

    const dynamicPressures = runStroke(true);
    expect(Math.max(...dynamicPressures) - Math.min(...dynamicPressures)).toBeGreaterThan(0.35);

    const fixedPressures = runStroke(false);
    expect(fixedPressures.every((p) => p === 1)).toBe(true);
  });
});
