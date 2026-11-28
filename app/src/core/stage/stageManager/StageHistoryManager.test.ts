import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({
  Project: class Project {},
  ProjectState: { Saved: "saved", Unsaved: "unsaved" },
  service: (id: string) => (target: { id?: string }) => {
    target.id = id;
    return target;
  },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    historySize: 100,
    showDebug: false,
  },
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { HistoryManager } from "./StageHistoryManager";

describe("HistoryManager (M2 row-level delegation)", () => {
  const createBus = () => ({
    resetBaseline: vi.fn(),
    commitDirtyStep: vi.fn(() => true),
    undo: vi.fn(),
    redo: vi.fn(),
    getHistoryState: vi.fn(() => ({ canUndo: true, canRedo: false, undoCursor: 1, totalEntries: 1 })),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resets docCommandBus baseline on construct and delegates recordStep/undo/redo/clearHistory without full-stage serialization", () => {
    const bus = createBus();
    const stageTable = { notifyChange: vi.fn() };
    const project: any = {
      stage: [],
      isSqliteV3: true,
      isDraft: false,
      projectState: "saved",
      docCommandBus: bus,
      emit: vi.fn(),
      getService: (id: string) => (id === "stageTable" ? stageTable : undefined),
      stageTable,
    };

    const manager = new HistoryManager(project);
    expect(bus.resetBaseline).toHaveBeenCalledOnce();

    manager.recordStep("move_node");
    expect(bus.commitDirtyStep).toHaveBeenCalledWith({ label: "move_node" });
    expect(stageTable.notifyChange).toHaveBeenCalledWith({ emitSync: false });
    expect(project.emit).toHaveBeenCalledWith("stage-commit");

    manager.undo();
    expect(bus.undo).toHaveBeenCalledOnce();

    manager.redo();
    expect(bus.redo).toHaveBeenCalledOnce();

    manager.clearHistory();
    expect(bus.resetBaseline).toHaveBeenLastCalledWith({ clearRemoteHistory: true });
    expect(project.projectState).toBe("saved");
    expect(manager.getHistoryState()).toEqual({ canUndo: true, canRedo: false, undoCursor: 1, totalEntries: 1 });
  });
});
