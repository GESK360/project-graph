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
vi.mock("@/core/stage/stageObject/entity/PenStroke", () => ({ PenStroke: class {}, PenStrokeSegment: class {} }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));

import { Settings } from "@/core/service/Settings";
import { ControllerPenStrokeDrawingClass } from "./ControllerPenStrokeDrawing";

function createTestProject() {
  const setHandwritingMode = vi.fn((enabled: boolean) => {
    Settings.mouseLeftMode = enabled ? "draw" : "selectAndMove";
  });
  const resetCountdownTimer = vi.fn();
  const project = {
    controller: {
      setHandwritingMode,
      resetCountdownTimer,
      pressingKeySet: new Set<string>(),
      isMouseDown: [false, false, false],
      camera: { isPreGrabbingWhenSpace: false },
    },
  } as unknown as Project;
  return {
    project,
    drawing: new ControllerPenStrokeDrawingClass(project),
    setHandwritingMode,
    resetCountdownTimer,
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
