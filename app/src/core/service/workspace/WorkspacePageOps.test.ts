import { beforeEach, expect, it, vi } from "vitest";
import { URI } from "vscode-uri";
import { Project } from "@/core/Project";
import { ProjectOwnershipLease } from "@/core/ProjectOwnership";
import { TabFactory } from "@/core/TabFactory";
import { TabWorkspace } from "@/core/TabWorkspace";
import { onOpenFile } from "@/core/service/GlobalMenu";
import { Settings } from "@/core/service/Settings";
import { store, tabsAtom } from "@/state";
import { invoke } from "@tauri-apps/api/core";
import { exists, readDir, readFile, rename, stat, writeFile } from "@tauri-apps/plugin-fs";
import { WorkspaceManager, WorkspacePaths } from "./WorkspaceManager";
import { deleteWorkspacePage, moveWorkspaceNodes, moveWorkspacePage, openWorkspacePage } from "./WorkspacePageOps";

vi.mock("@/components/global-menu-content", () => ({ default: () => null }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: vi.fn() } }));
vi.mock("@/sub/CollaborationWindow", () => ({ default: {} }));
vi.mock("@/core/extension/Extension", () => ({ Extension: class {} }));
vi.mock("@/core/loadAllServices", () => ({ loadAllServicesBeforeInit: vi.fn(), loadAllServicesAfterInit: vi.fn() }));
vi.mock("@/core/OpenProjectRuntimeHost", () => ({ ensureOpenProjectRuntimeBridgeListener: vi.fn() }));
vi.mock("@/core/Project", () => ({
  ProjectState: { Saved: "saved" },
  Project: class {
    static newDraft() {
      return new this(URI.parse("draft:/new"));
    }
    constructor(public uri: URI) {}
    id = crypto.randomUUID();
    closing = false;
    stage = [];
    stageManager = { add: vi.fn() };
    attachments = new Map();
    projectState = "saved";
    projectOwnerIdentity?: string;
    canonicalProjectPath?: string;
    attachProjectOwnership(ownership: { ownershipId: string; canonicalPath: string }) {
      this.projectOwnerIdentity = ownership.ownershipId;
      this.canonicalProjectPath = ownership.canonicalPath;
    }
    activateOpenRuntimeHost = vi.fn();
    init = vi.fn();
    save = vi.fn();
    dispose = vi.fn();
    loop = vi.fn();
    pause = vi.fn();
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
vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/plugin-fs")>()),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
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

it.each(["single", "batch"])("opens the auto-renamed destination once during a %s move", async (moveMode) => {
  const dir = "c:/workspace/destination";
  const original = new Project(URI.file(`${dir}/Example.prg`));
  const source = new Project(URI.file("c:/workspace/Example.prg"));
  const sourcePath = WorkspacePaths.normalize(source.uri.fsPath);
  const originalPath = WorkspacePaths.normalize(original.uri.fsPath);
  const target = `${dir}/Example (2).prg`;
  const movedPage = new Project(URI.file(target));
  const acquired = Promise.withResolvers<{ status: "acquired"; ownershipId: string; canonicalPath: string }>();
  const init = Promise.withResolvers<void>();
  const ownership = { ownershipId: "moved-page-owner", canonicalPath: target };
  const files = new Map([[sourcePath, "moved contents"], [originalPath, "existing contents"]]);
  const runtimeHosts = new Set<string>();

  store.set(tabsAtom, [original, source]);
  vi.mocked(TabWorkspace.close).mockImplementation(async () => store.set(tabsAtom, [original]));
  vi.mocked(exists).mockImplementation(async (path) => files.has(String(path)));
  vi.mocked(stat).mockResolvedValue({ isDirectory: false } as Awaited<ReturnType<typeof stat>>);
  vi.mocked(rename).mockImplementation(async (from, to) => {
    const fromPath = String(from);
    const toPath = String(to);
    const contents = files.get(fromPath);
    if (contents === undefined || files.has(toPath)) throw new Error("Invalid test move");
    files.set(toPath, contents);
    files.delete(fromPath);
  });
  vi.mocked(movedPage.init).mockReturnValue(init.promise);
  vi.mocked(TabFactory.create).mockImplementation(async (uri) => {
    const page = uri.fsPath === movedPage.uri.fsPath ? new Project(uri) : movedPage;
    vi.mocked(page.activateOpenRuntimeHost).mockImplementation(() => {
      const canonicalPath = page.canonicalProjectPath!;
      if (runtimeHosts.has(canonicalPath)) throw new Error("Open Project Runtime Host already exists for this path");
      runtimeHosts.add(canonicalPath);
    });
    return page;
  });
  vi.mocked(invoke)
    .mockReturnValueOnce(acquired.promise)
    .mockResolvedValueOnce({ status: "already_owned", ...ownership });

  try {
    const moving =
      moveMode === "single"
        ? moveWorkspacePage(sourcePath, dir).then((path) => [path])
        : moveWorkspaceNodes([sourcePath], dir);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const opening = onOpenFile(URI.file(`${dir}/EXAMPLE (2).prg`));
    await vi.waitFor(() => expect(movedPage.init).toHaveBeenCalledOnce());
    acquired.resolve({ status: "acquired", ...ownership });
    init.resolve();

    expect(await moving).toEqual([target]);
    expect(await opening).toBe(movedPage);
    expect(TabWorkspace.close).toHaveBeenCalledExactlyOnceWith(source.id, { animate: false });
    expect(files.get(originalPath)).toBe("existing contents");
    expect(files.get(target)).toBe("moved contents");
    expect(files.has(sourcePath)).toBe(false);
    expect(store.get(tabsAtom)).toEqual([original, movedPage]);
    expect(TabFactory.create).toHaveBeenCalledOnce();
    expect(movedPage.activateOpenRuntimeHost).toHaveBeenCalledOnce();
  } finally {
    acquired.resolve({ status: "acquired", ...ownership });
    init.resolve();
  }
});

it("keeps the current project open when rearranging it in the same folder", async () => {
  const page = new Project(uri);
  store.set(tabsAtom, [page]);

  await expect(moveWorkspacePage(path, "c:/workspace")).resolves.toBe(path);
  await expect(moveWorkspaceNodes([path], "c:/workspace")).resolves.toEqual([path]);
  expect(TabWorkspace.close).not.toHaveBeenCalled();
  expect(TabFactory.create).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  expect(store.get(tabsAtom)).toEqual([page]);
});

it("orders all moved filenames in one write, including the suffix used to avoid a collision", async () => {
  const root = "c:/workspace";
  const targetDir = `${root}/destination`;
  const orderFile = `${root}/.flux-graph/order.json`;
  const previousRoot = Settings.activeWorkspaceRoot;
  Settings.activeWorkspaceRoot = root;
  vi.mocked(exists).mockResolvedValue(true);
  vi.mocked(readFile).mockResolvedValue(new TextEncoder().encode(JSON.stringify({ destination: ["Example.prg"] })));
  try {
    await WorkspaceManager.reorderNodes(
      [`${targetDir}/Example (2).prg`, `${targetDir}/Notes.prg`],
      targetDir,
      "Example.prg",
    );

    expect(readFile).toHaveBeenCalledExactlyOnceWith(orderFile);
    expect(writeFile).toHaveBeenCalledOnce();
    const [writtenFile, content] = vi.mocked(writeFile).mock.calls[0];
    expect(writtenFile).toBe(orderFile);
    expect(JSON.parse(new TextDecoder().decode(content as Uint8Array))).toEqual({
      destination: ["Example (2).prg", "Notes.prg", "Example.prg"],
    });
    expect(stat).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  } finally {
    Settings.activeWorkspaceRoot = previousRoot;
  }
});

it("waits for a closing project before reopening it through a path alias", async () => {
  const oldPage = new Project(uri);
  oldPage.attachProjectOwnership(new ProjectOwnershipLease("old-owner", path));
  oldPage.closing = true;
  store.set(tabsAtom, [oldPage]);
  const closed = Promise.withResolvers<void>();
  vi.mocked(TabWorkspace.close).mockImplementation(async () => {
    await closed.promise;
    store.set(tabsAtom, []);
  });
  vi.mocked(invoke).mockResolvedValueOnce({ status: "already_owned", ownershipId: "old-owner", canonicalPath: path });

  const opening = onOpenFile(URI.file("c:/WORKSPACE/新建页面.prg"));
  try {
    await vi.waitFor(() => expect(TabWorkspace.close).toHaveBeenCalledExactlyOnceWith(oldPage.id));
    expect(TabFactory.create).not.toHaveBeenCalled();
    closed.resolve();
    const reopened = await opening;
    expect(reopened).toBeDefined();
    expect(reopened).not.toBe(oldPage);
    expect(store.get(tabsAtom)).toEqual([reopened]);
  } finally {
    closed.resolve();
  }
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

it("inserts newly created pages and folders right after the anchor page or at the start of a folder in custom sort mode", async () => {
  const root = "c:/workspace";
  const folder = `${root}/时间草稿`;
  const orderFile = `${root}/.flux-graph/order.json`;
  const previousRoot = Settings.activeWorkspaceRoot;
  const previousSortMode = Settings.workspaceSortMode;
  let storedOrder: Record<string, string[]> = {
    "": ["06生.prg", "为什么.prg", "时间草稿"],
    时间草稿: ["旧子页1.prg", "旧子页2.prg"],
  };
  const diskEntries = new Map<string, Array<{ name: string; isDirectory: boolean; isFile: boolean }>>([
    [
      root,
      [
        { name: "06生.prg", isDirectory: false, isFile: true },
        { name: "为什么.prg", isDirectory: false, isFile: true },
        { name: "时间草稿", isDirectory: true, isFile: false },
        { name: "1321424321.prg", isDirectory: false, isFile: true },
      ],
    ],
    [
      folder,
      [
        { name: "旧子页1.prg", isDirectory: false, isFile: true },
        { name: "旧子页2.prg", isDirectory: false, isFile: true },
      ],
    ],
  ]);

  Settings.activeWorkspaceRoot = root;
  Settings.workspaceSortMode = "custom";
  vi.mocked(exists).mockImplementation(async (target) => {
    const p = String(target);
    if (p === orderFile || diskEntries.has(p)) return true;
    const parent = WorkspacePaths.dirname(p);
    const name = WorkspacePaths.baseName(p);
    return (diskEntries.get(parent) ?? []).some((entry) => entry.name.toLowerCase() === name.toLowerCase());
  });
  vi.mocked(readDir).mockImplementation(async (dir) => (diskEntries.get(String(dir)) ?? []) as any);
  vi.mocked(readFile).mockImplementation(async () => new TextEncoder().encode(JSON.stringify(storedOrder)));
  vi.mocked(writeFile).mockImplementation(async (_file, content) => {
    storedOrder = JSON.parse(new TextDecoder().decode(content as Uint8Array));
  });

  try {
    // 1. 右键页面「为什么」新建页面 -> 插入到「为什么.prg」正后方（且补齐未入表的 1321424321.prg）
    diskEntries.get(root)!.push({ name: "新页面.prg", isDirectory: false, isFile: true });
    vi.mocked(exists).mockImplementationOnce(async () => false);
    await WorkspaceManager.createPage(root, "新页面", { type: "after", fileName: "为什么.prg" });
    expect(storedOrder[""]).toEqual(["06生.prg", "为什么.prg", "新页面.prg", "时间草稿", "1321424321.prg"]);

    // 2. 右键页面「新页面」新建文件夹 -> 插入到「新页面.prg」正后方
    diskEntries.get(root)!.push({ name: "新文件夹", isDirectory: true, isFile: false });
    vi.mocked(exists).mockImplementationOnce(async () => false);
    await WorkspaceManager.createFolder(root, "新文件夹", { type: "after", fileName: "新页面.prg" });
    expect(storedOrder[""]).toEqual(["06生.prg", "为什么.prg", "新页面.prg", "新文件夹", "时间草稿", "1321424321.prg"]);

    // 3. 右键文件夹「时间草稿」新建页面 -> 插入到该文件夹子项第 1 位
    diskEntries.get(folder)!.push({ name: "首子页.prg", isDirectory: false, isFile: true });
    vi.mocked(exists).mockImplementationOnce(async () => false);
    await WorkspaceManager.createPage(folder, "首子页", { type: "start" });
    expect(storedOrder["时间草稿"]).toEqual(["首子页.prg", "旧子页1.prg", "旧子页2.prg"]);

    // 4. 非「无」排序模式下，不按指定落点插队，沿用追加到末尾
    Settings.workspaceSortMode = "name";
    diskEntries.get(folder)!.push({ name: "名称模式页.prg", isDirectory: false, isFile: true });
    vi.mocked(exists).mockImplementationOnce(async () => false);
    await WorkspaceManager.createPage(folder, "名称模式页", { type: "start" });
    expect(storedOrder["时间草稿"]).toEqual(["首子页.prg", "旧子页1.prg", "旧子页2.prg", "名称模式页.prg"]);
  } finally {
    Settings.activeWorkspaceRoot = previousRoot;
    Settings.workspaceSortMode = previousSortMode;
  }
});
