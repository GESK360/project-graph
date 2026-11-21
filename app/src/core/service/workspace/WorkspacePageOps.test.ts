import { beforeEach, expect, it, vi } from "vitest";
import { URI } from "vscode-uri";
import { Project } from "@/core/Project";
import { TabFactory } from "@/core/TabFactory";
import { TabWorkspace } from "@/core/TabWorkspace";
import { onOpenFile } from "@/core/service/GlobalMenu";
import { store, tabsAtom } from "@/state";
import { invoke } from "@tauri-apps/api/core";
import { WorkspaceManager } from "./WorkspaceManager";
import { deleteWorkspacePage, openWorkspacePage } from "./WorkspacePageOps";

vi.mock("@/components/global-menu-content", () => ({ default: () => null }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: vi.fn() } }));
vi.mock("@/sub/CollaborationWindow", () => ({ default: {} }));
vi.mock("@/core/extension/Extension", () => ({ Extension: class {} }));
vi.mock("@/core/loadAllServices", () => ({ loadAllServicesBeforeInit: vi.fn(), loadAllServicesAfterInit: vi.fn() }));
vi.mock("@/core/OpenProjectRuntimeHost", () => ({ ensureOpenProjectRuntimeBridgeListener: vi.fn() }));
vi.mock("@/core/Project", () => ({
  ProjectState: { Saved: "saved" },
  Project: class {
    constructor(readonly uri: URI) {}
    id = "page-tab";
    closing = false;
    stage = [];
    attachments = new Map();
    projectState = "saved";
    attachProjectOwnership = vi.fn();
    activateOpenRuntimeHost = vi.fn();
    init = vi.fn();
  },
}));
vi.mock("@/core/Tab", () => ({ isResourceTab: () => true }));
vi.mock("@/core/TabFactory", () => ({ TabFactory: { create: vi.fn() } }));
vi.mock("@/core/TabWorkspace", () => ({ TabWorkspace: { close: vi.fn(), focus: vi.fn() } }));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: { event: vi.fn() } }));
vi.mock("@/core/service/FeatureFlags", () => ({ FeatureFlags: {} }));
vi.mock("@/core/service/dataFileService/RecentFileManager", () => ({
  RecentFileManager: { addRecentFileByUri: vi.fn() },
}));
vi.mock("@/core/stage/ProjectUpgrader", () => ({ ProjectUpgrader: {} }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));
vi.mock("@/utils/platform", () => ({ isMac: false }));
vi.mock("@/utils/readPrgThumbnail", () => ({ ensurePrgThumbnailCached: vi.fn() }));
vi.mock("@/state", async () => {
  const { atom, createStore } = await import("jotai");
  return {
    tabsAtom: atom([]),
    activeTabAtom: atom(undefined),
    activeResourceTabAtom: atom(undefined),
    store: createStore(),
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    promise: (load: () => Promise<void>, options: { success: () => Promise<string> }) => ({
      unwrap: async () => {
        await load();
        await options.success();
      },
    }),
  },
}));

const path = "c:/workspace/新建页面.prg";
const uri = URI.file(path);

beforeEach(() => {
  vi.resetAllMocks();
  store.set(tabsAtom, []);
  vi.mocked(invoke).mockResolvedValue({ status: "acquired", ownershipId: "page-owner", canonicalPath: path });
  vi.mocked(TabFactory.create).mockImplementation(async (uri) => new Project(uri));
});

it("shares a single load between automatic opening and a click on the same new page", async () => {
  const [page, secondOpen] = await Promise.all([onOpenFile(uri), onOpenFile(uri)]);

  expect(page).toBe(secondOpen);
  expect(TabFactory.create).toHaveBeenCalledOnce();
  expect(page?.activateOpenRuntimeHost).toHaveBeenCalledOnce();
  expect(store.get(tabsAtom)).toEqual([page]);
});

it("finishes in-flight opens and releases the old tab before deleting a path that can be reused", async () => {
  const oldPage = new Project(uri);
  const load = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  vi.mocked(oldPage.init).mockReturnValue(load.promise);
  vi.mocked(TabFactory.create).mockResolvedValueOnce(oldPage);
  vi.mocked(TabWorkspace.close).mockImplementation(async () => {
    oldPage.closing = true;
    await closing.promise;
    store.set(tabsAtom, []);
  });
  const remove = vi.spyOn(WorkspaceManager, "deletePage").mockResolvedValue(undefined);
  try {
    const opening = openWorkspacePage(path);
    await vi.waitFor(() => expect(oldPage.init).toHaveBeenCalledOnce());
    const deleting = deleteWorkspacePage(path);
    await openWorkspacePage(path);
    expect(TabWorkspace.close).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    load.resolve();
    await opening;
    await vi.waitFor(() => expect(TabWorkspace.close).toHaveBeenCalledExactlyOnceWith(oldPage.id));
    expect(remove).not.toHaveBeenCalled();
    closing.resolve();
    await deleting;
    expect(remove).toHaveBeenCalledExactlyOnceWith(path);

    const newPage = await onOpenFile(uri);
    expect(newPage).toBeDefined();
    expect(newPage).not.toBe(oldPage);
    expect(store.get(tabsAtom)).toEqual([newPage]);
    expect(TabFactory.create).toHaveBeenCalledTimes(2);
  } finally {
    load.resolve();
    closing.resolve();
    remove.mockRestore();
  }
});
