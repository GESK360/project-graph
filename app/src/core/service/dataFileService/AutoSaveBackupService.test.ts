import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/platform", () => ({ family: () => "unix" }));
vi.mock("@/core/Project", () => ({
  Project: class {},
  service: () => () => {},
  ProjectState: { Saved: "saved", Unsaved: "unsaved" },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    autoSave: true,
    autoBackup: false,
    autoSaveInterval: 1,
    autoBackupInterval: 1,
    autoBackupStrategy: "sideBySide",
    autoBackupLimitCount: 10,
  },
}));
vi.mock("@tauri-apps/api/path", () => ({
  appCacheDir: vi.fn(async () => "/tmp/cache"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async () => true),
  readDir: vi.fn(async () => []),
  stat: vi.fn(),
  remove: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockCheckpointAndSnapshot = vi.fn();
vi.mock("@/core/sqlite/DocClient", () => ({
  DocClient: {
    isAvailable: () => true,
    checkpointAndSnapshot: (...args: unknown[]) => mockCheckpointAndSnapshot(...args),
  },
}));

import { AutoSaveBackupService } from "./AutoSaveBackupService";
import { Settings } from "@/core/service/Settings";
import type { Project } from "@/core/Project";

afterEach(() => {
  vi.restoreAllMocks();
  mockCheckpointAndSnapshot.mockReset();
  Settings.autoBackup = false;
});

describe("automatic project persistence (M2 SQLite online backup)", () => {
  it("skips an active manual save and collaborative documents", () => {
    vi.spyOn(Date, "now").mockReturnValue(10000);
    const project = {
      uri: {},
      isSaving: true,
      isSqliteV3: false,
      projectState: "unsaved",
      save: vi.fn(),
      flushV3Persist: vi.fn(),
    };
    const service = new AutoSaveBackupService(project as unknown as Project);
    service.tick();
    expect(project.save).not.toHaveBeenCalled();
    project.isSaving = false;
    Object.assign(project, { isCollab: true });
    service.tick();
    expect(project.save).not.toHaveBeenCalled();
  });

  it("uses v3Revision + DocClient.checkpointAndSnapshot without full-stage stageHash or overlapping backups", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    Settings.autoBackup = true;
    let finishSnapshot!: () => void;
    mockCheckpointAndSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSnapshot = () => resolve({ walPages: 1, snapshotPath: "/tmp/test_backup.prg" });
        }),
    );

    const project = {
      uri: { fsPath: "/tmp/test.prg", toString: () => "file:///tmp/test.prg" },
      isDraft: false,
      isCollab: false,
      isSaving: false,
      isSqliteV3: true,
      v3DocId: "doc-1",
      v3Revision: 3,
      projectState: "saved",
      flushV3Persist: vi.fn(async () => {}),
      save: vi.fn(),
    };

    const service = new AutoSaveBackupService(project as unknown as Project);
    now.mockReturnValue(2000);
    service.tick();
    await vi.waitFor(() => expect(mockCheckpointAndSnapshot).toHaveBeenCalledOnce());

    // 备份进行中不重入，也不触发并发 autoSave
    now.mockReturnValue(5000);
    service.tick();
    expect(mockCheckpointAndSnapshot).toHaveBeenCalledOnce();
    expect(project.save).not.toHaveBeenCalled();

    finishSnapshot();
    await vi.waitFor(() => expect((service as unknown as { isBackingUp: boolean }).isBackingUp).toBe(false));

    // revision 未增长时跳过重复快照
    now.mockReturnValue(8000);
    service.tick();
    await Promise.resolve();
    expect(mockCheckpointAndSnapshot).toHaveBeenCalledOnce();

    // revision 增长后触发下一次在线快照
    project.v3Revision = 4;
    now.mockReturnValue(11000);
    service.tick();
    await vi.waitFor(() => expect(mockCheckpointAndSnapshot).toHaveBeenCalledTimes(2));
  });
});
