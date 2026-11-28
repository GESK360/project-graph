// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { URI } from "vscode-uri";

const mockInvoke = vi.fn();
const mockLoadBefore = vi.fn();
const mockLoadAfter = vi.fn();
const mockSynchronizeGroups = vi.fn();
const mockInitWithPreloadedV3 = vi.fn();
const mockTabFactoryCreate = vi.fn();
const mockAddRecent = vi.fn();

vi.mock("@/components/global-menu-content", () => ({ default: () => null }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: vi.fn() } }));
vi.mock("@/sub/CollaborationWindow", () => ({ default: {} }));
vi.mock("@/core/extension/Extension", () => ({ Extension: class {} }));
vi.mock("@/core/loadAllServices", () => ({
  loadAllServicesBeforeInit: (...args: unknown[]) => mockLoadBefore(...args),
  loadAllServicesAfterInit: (...args: unknown[]) => mockLoadAfter(...args),
}));
vi.mock("@/core/OpenProjectRuntimeHost", () => ({ ensureOpenProjectRuntimeBridgeListener: vi.fn() }));
vi.mock("@/core/Tab", () => ({ isResourceTab: () => true }));
vi.mock("@/core/TabFactory", () => ({ TabFactory: { create: (...args: unknown[]) => mockTabFactoryCreate(...args) } }));
vi.mock("@/core/TabWorkspace", () => ({
  TabWorkspace: {
    close: vi.fn(),
    focus: vi.fn(),
    synchronizeGroups: () => mockSynchronizeGroups(),
  },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    showFileOpenSuccessToast: true,
    showRecentFilesThumbnails: false,
    autoImportTxtFileWhenOpenPrg: false,
    pauseRenderWhenTabUnfocused: false,
  },
}));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: { event: vi.fn() } }));
vi.mock("@/core/service/FeatureFlags", () => ({ FeatureFlags: {} }));
vi.mock("@/core/service/dataFileService/RecentFileManager", () => ({
  RecentFileManager: { addRecentFileByUri: (...args: unknown[]) => mockAddRecent(...args) },
}));
vi.mock("@/core/service/dataFileService/LocalDocumentSync", () => ({
  LocalDocumentSync: { attach: vi.fn(), detach: vi.fn(), notifySaved: vi.fn() },
}));
vi.mock("@/core/stage/ProjectUpgrader", () => ({ ProjectUpgrader: {} }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));
vi.mock("@/utils/platform", () => ({ isMac: false }));
vi.mock("@/utils/readPrgThumbnail", () => ({ ensurePrgThumbnailCached: vi.fn() }));
vi.mock("@/core/Project", () => ({
  ProjectState: { Saved: 0, Stashed: 1, Unsaved: 2 },
  Project: class {
    constructor(public uri: URI) {}
    id = crypto.randomUUID();
    closing = false;
    stage: unknown[] = [];
    totalAttachmentCount = 0;
    isSqliteV3 = true;
    isDraft = false;
    wasUpgraded = false;
    projectState = 0;
    projectOwnerIdentity?: string;
    canonicalProjectPath?: string;
    attachProjectOwnership(ownership: { ownershipId: string; canonicalPath: string }) {
      this.projectOwnerIdentity = ownership.ownershipId;
      this.canonicalProjectPath = ownership.canonicalPath;
    }
    activateOpenRuntimeHost = vi.fn();
    init = vi.fn();
    initWithPreloadedV3 = (...args: unknown[]) => mockInitWithPreloadedV3(...args);
    dispose = vi.fn();
    loop = vi.fn();
    pause = vi.fn();
  },
}));
vi.mock("@/state", async () => {
  const { atom, createStore } = await import("jotai");
  return {
    tabsAtom: atom([]),
    activeTabAtom: atom(undefined),
    activeResourceTabAtom: atom(undefined),
    store: createStore(),
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  isTauri: () => true,
}));
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { onOpenFile } from "@/core/service/GlobalMenu";
import { activeResourceTabAtom, activeTabAtom, store, tabsAtom } from "@/state";
import { toast } from "sonner";

describe("GlobalMenu fused v3 fast open", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    store.set(tabsAtom, []);
    store.set(activeTabAtom, undefined);
    store.set(activeResourceTabAtom, undefined);
    mockInitWithPreloadedV3.mockResolvedValue(true);
    mockAddRecent.mockResolvedValue(undefined);
  });

  it("opens local v3 .prg in a single fused IPC without dummyProject double service load or loading toast", async () => {
    const filePath = "D:/workspace/demo.prg";
    const fakeDoc = {
      canonicalPath: filePath,
      docId: "doc-fast-1",
      formatVersion: "3.0.0",
      revision: 1,
      tags: [],
      references: { sections: {}, files: [] },
      tableMetaJson: "{}",
      entities: [],
      edges: [],
      associations: [],
      tableColumns: [],
      tableViews: [],
      cellValues: [],
      attachments: [],
      needsFormulaRecompute: false,
    };
    mockInvoke.mockResolvedValueOnce({
      status: "opened_v3",
      ownershipId: "own-1",
      canonicalPath: filePath,
      doc: fakeDoc,
    });

    const t0 = performance.now();
    const project = await onOpenFile(URI.file(filePath), "工作空间文件树");
    const elapsedMs = performance.now() - t0;

    expect(project).toBeDefined();
    // 仅调用 1 次融合 IPC（无重复 detectFormat / exists / doc_open）
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("doc_open_with_ownership", { path: URI.file(filePath).fsPath });
    // 仅初始化 1 次服务（已消除 dummyProject 二次初始化与泄漏）
    expect(mockLoadBefore).toHaveBeenCalledTimes(1);
    expect(mockLoadAfter).toHaveBeenCalledTimes(1);
    expect(mockTabFactoryCreate).not.toHaveBeenCalled();
    expect(mockInitWithPreloadedV3).toHaveBeenCalledWith(fakeDoc, { attachAutoPersist: true });
    expect(mockSynchronizeGroups).toHaveBeenCalledTimes(1);
    expect(store.get(tabsAtom)).toHaveLength(1);
    expect(store.get(activeTabAtom)).toBe(project);
    expect(store.get(activeResourceTabAtom)).toBe(project);
    // 秒开场景不应提前闪烁 loading toast
    expect(toast.loading).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(100);

    // 预热 V8 后验证第二次秒开稳定 < 20ms
    const filePath2 = "D:/workspace/demo2.prg";
    mockInvoke.mockResolvedValueOnce({
      status: "opened_v3",
      ownershipId: "own-2",
      canonicalPath: filePath2,
      doc: { ...fakeDoc, canonicalPath: filePath2, docId: "doc-fast-2" },
    });
    const tWarm = performance.now();
    await onOpenFile(URI.file(filePath2), "工作空间文件树");
    expect(performance.now() - tWarm).toBeLessThan(20);
  });
});
