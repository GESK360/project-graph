// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "jotai";
import { URI } from "vscode-uri";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceNode } from "@/core/service/workspace/WorkspaceManager";
import { activeResourceTabAtom, store } from "@/state";
import WorkspaceWindow from "./WorkspaceWindow";

const { rootDir, pageA, pageB, dirNode, listeners, stateRef } = vi.hoisted(() => {
  const rootDir = "c:/workspace";
  const pageA: WorkspaceNode = { kind: "page", name: "06生", path: `${rootDir}/06生.prg` };
  const pageB: WorkspaceNode = { kind: "page", name: "为什么", path: `${rootDir}/为什么.prg` };
  const dirNode: WorkspaceNode = { kind: "dir", name: "时间草稿", path: `${rootDir}/时间草稿`, children: [] };
  return {
    rootDir,
    pageA,
    pageB,
    dirNode,
    listeners: new Set<() => void>(),
    stateRef: {
      treeNodes: [pageA, pageB, dirNode] as WorkspaceNode[],
      showCreatePageToast: true,
    },
  };
});

vi.mock("@/core/loadAllServices", () => ({}));
vi.mock("@/core/Project", () => ({}));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { confirm: vi.fn(async () => true) } }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: unknown }) => children,
  DropdownMenuContent: () => null,
  DropdownMenuRadioGroup: ({ children }: { children: unknown }) => children,
  DropdownMenuRadioItem: () => null,
  DropdownMenuTrigger: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/workspace/WorkspaceMoveCopyDialog", () => ({ default: () => null }));
vi.mock("@/components/workspace/WorkspaceVersionsDialog", () => ({ default: () => null }));
vi.mock("@/core/service/dataFileService/DeepLinkHandler", () => ({ createPageDeepLink: vi.fn(() => "") }));
vi.mock("@/core/Tab", () => ({ ComponentTab: class {}, Tab: class {} }));
vi.mock("@/core/TabWorkspace", () => ({
  dockWorkspacePanel: vi.fn(),
  TabWorkspace: { focus: vi.fn(), close: vi.fn() },
}));
vi.mock("@/core/subWindowOpen", () => ({ createSubWindow: vi.fn() }));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    use: (key: string) => {
      switch (key) {
        case "activeWorkspaceRoot":
          return [rootDir, vi.fn()];
        case "workspaceSortMode":
          return ["custom", vi.fn()];
        case "workspaceTreeOpacity":
          return [1, vi.fn()];
        case "workspaceRenameOnDoubleClick":
          return [true, vi.fn()];
        case "workspaceShowCreatePageToast":
          return [stateRef.showCreatePageToast, vi.fn()];
        default:
          return [undefined, vi.fn()];
      }
    },
  },
}));
vi.mock("@/state", async () => {
  const { atom, createStore } = await import("jotai");
  return {
    tabsAtom: atom([]),
    activeResourceTabAtom: atom<any>(undefined),
    store: createStore(),
  };
});
vi.mock("@/core/service/workspace/WorkspaceManager", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/core/service/workspace/WorkspaceManager")>();
  return {
    WorkspacePaths: original.WorkspacePaths,
    WorkspaceManager: {
      get root() {
        return rootDir;
      },
      clipboard: null,
      ensureWatching: vi.fn(async () => undefined),
      readTree: vi.fn(async () => stateRef.treeNodes),
      suggestNewName: vi.fn(async (_dir: string, _kind: WorkspaceNode["kind"], baseName: string) => baseName),
      createPage: vi.fn(async (dir: string, name: string) => `${dir}/${name}.prg`),
      createFolder: vi.fn(async (dir: string, name?: string) => `${dir}/${name ?? "新建文件夹"}`),
      listVersions: vi.fn(async () => []),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === "change") listeners.add(listener);
      }),
      off: vi.fn((event: string, listener: () => void) => {
        if (event === "change") listeners.delete(listener);
      }),
    },
  };
});
vi.mock("@/core/service/workspace/WorkspacePageOps", () => ({
  copyWorkspaceNodes: vi.fn(async () => []),
  copyWorkspacePage: vi.fn(async () => ""),
  deleteWorkspaceFolder: vi.fn(async () => undefined),
  deleteWorkspacePage: vi.fn(async () => undefined),
  isReopeningWorkspaceProject: vi.fn(() => false),
  moveWorkspaceNodes: vi.fn(async () => []),
  moveWorkspacePage: vi.fn(async () => ""),
  openWorkspacePage: vi.fn(async (path: string) => {
    store.set(activeResourceTabAtom, { uri: URI.file(path) } as any);
  }),
  renameWorkspaceNode: vi.fn(async (path: string) => path),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function rowButton(path: string) {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-pg-workspace-row]"));
  const match = buttons.find((button) => button.dataset.pgWorkspacePath === path);
  if (!match) throw new Error(`Row not found: ${path}`);
  return match;
}

function isSelectedRow(path: string) {
  return rowButton(path).className.includes("bg-accent/60");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  listeners.clear();
  stateRef.treeNodes = [pageA, pageB, dirNode];
  stateRef.showCreatePageToast = true;
  store.set(activeResourceTabAtom, undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("switches selected style exclusively from page to folder when clicking a folder", async () => {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <WorkspaceWindow />
      </Provider>,
    ),
  );
  await vi.waitFor(() => expect(rowButton(pageB.path)).toBeTruthy());

  // 点击页面：页面高亮并成为当前激活标签
  await act(async () => {
    rowButton(pageB.path).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  });
  expect(isSelectedRow(pageB.path)).toBe(true);
  expect(isSelectedRow(dirNode.path)).toBe(false);
  expect(rowButton(pageB.path).getAttribute("aria-current")).toBe("page");

  // 再点击文件夹：切换为只选中文件夹，页面不再显示选中样式
  await act(async () => {
    rowButton(dirNode.path).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  });
  expect(isSelectedRow(dirNode.path)).toBe(true);
  expect(isSelectedRow(pageB.path)).toBe(false);
  expect(rowButton(pageB.path).getAttribute("aria-current")).toBe("page");

  // 再次点击页面：切换回只选中页面
  await act(async () => {
    rowButton(pageB.path).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  });
  expect(isSelectedRow(pageB.path)).toBe(true);
  expect(isSelectedRow(dirNode.path)).toBe(false);
});

it("syncs selection on initial load and external tab switches without breaking Ctrl multi-select", async () => {
  store.set(activeResourceTabAtom, { uri: URI.file(pageB.path) } as any);
  await act(async () =>
    root.render(
      <Provider store={store}>
        <WorkspaceWindow />
      </Provider>,
    ),
  );
  await vi.waitFor(() => expect(isSelectedRow(pageB.path)).toBe(true));
  expect(isSelectedRow(pageA.path)).toBe(false);

  // Ctrl+单击另一页面应保留多选，不被异步切页覆盖
  await act(async () => {
    rowButton(pageA.path).dispatchEvent(new MouseEvent("click", { detail: 1, ctrlKey: true, bubbles: true }));
  });
  expect(isSelectedRow(pageA.path)).toBe(true);
  expect(isSelectedRow(pageB.path)).toBe(true);

  // 外部切换顶部标签页后，树选中态同步到新页面
  await act(async () => {
    store.set(activeResourceTabAtom, { uri: URI.file(pageB.path) } as any);
  });
  expect(isSelectedRow(pageB.path)).toBe(true);
  expect(isSelectedRow(pageA.path)).toBe(false);

  // 切换到非工作空间草稿页后，清除之前激活页面的选中态
  await act(async () => {
    store.set(activeResourceTabAtom, { uri: URI.parse("draft:/1") } as any);
  });
  expect(isSelectedRow(pageB.path)).toBe(false);
});

it("keeps folder selected when an async page open or tree refresh finishes afterward, and allows Ctrl-deselect", async () => {
  const { openWorkspacePage } = await import("@/core/service/workspace/WorkspacePageOps");
  let resolveOpen!: () => void;
  vi.mocked(openWorkspacePage).mockImplementationOnce(
    (path: string) =>
      new Promise<void>((resolve) => {
        resolveOpen = () => {
          store.set(activeResourceTabAtom, { uri: URI.file(path) } as any);
          resolve();
        };
      }),
  );

  await act(async () =>
    root.render(
      <Provider store={store}>
        <WorkspaceWindow />
      </Provider>,
    ),
  );
  await vi.waitFor(() => expect(rowButton(pageB.path)).toBeTruthy());

  // 点页面后在异步打开完成前立刻改点文件夹，打开完成不能抢回选中态
  await act(async () => {
    rowButton(pageB.path).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    rowButton(dirNode.path).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  });
  await act(async () => {
    resolveOpen();
  });
  expect(isSelectedRow(dirNode.path)).toBe(true);
  expect(isSelectedRow(pageB.path)).toBe(false);

  // 工作空间刷新后仍保持文件夹选中
  await act(async () => {
    for (const listener of listeners) listener();
    await Promise.resolve();
  });
  expect(isSelectedRow(dirNode.path)).toBe(true);
  expect(isSelectedRow(pageB.path)).toBe(false);

  // 点击页面后再 Ctrl+单击同一页面取消选中，不再残留选中高亮
  await act(async () => {
    rowButton(pageB.path).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  });
  expect(isSelectedRow(pageB.path)).toBe(true);
  await act(async () => {
    rowButton(pageB.path).dispatchEvent(new MouseEvent("click", { detail: 1, ctrlKey: true, bubbles: true }));
  });
  expect(isSelectedRow(pageB.path)).toBe(false);
});

it("commits the newly created page atomically with the refreshed tree and respects workspaceShowCreatePageToast", async () => {
  const { WorkspaceManager } = await import("@/core/service/workspace/WorkspaceManager");
  const { toast } = await import("sonner");
  vi.mocked(toast.success).mockClear();

  const createdPage: WorkspaceNode = { kind: "page", name: "测试页", path: `${rootDir}/测试页.prg` };
  let resolveTree!: (nodes: WorkspaceNode[]) => void;

  vi.mocked(WorkspaceManager.createPage).mockImplementationOnce(async () => {
    stateRef.treeNodes = [pageA, pageB, dirNode, createdPage];
    for (const listener of listeners) listener();
    return createdPage.path;
  });

  stateRef.showCreatePageToast = false;
  await act(async () =>
    root.render(
      <Provider store={store}>
        <WorkspaceWindow />
      </Provider>,
    ),
  );
  await vi.waitFor(() => expect(rowButton(pageB.path)).toBeTruthy());

  // 顶部工具栏有 5 个图标按钮，第 4 个是新建页面
  const toolbarButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
    (button) => !button.hasAttribute("data-pg-workspace-row"),
  );
  const newPageButton = toolbarButtons[3]!;
  await act(async () => {
    newPageButton.click();
  });
  const input = await vi.waitFor(() => {
    const el = container.querySelector<HTMLInputElement>("input");
    expect(el).toBeTruthy();
    return el!;
  });

  // 模拟落盘后读取最新树存在异步延迟：确认输入期间输入框应保持挂载，不先消失闪动
  vi.mocked(WorkspaceManager.readTree).mockImplementationOnce(
    () =>
      new Promise<WorkspaceNode[]>((resolve) => {
        resolveTree = resolve;
      }),
  );

  input.value = "测试页";
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  expect(container.querySelector("input")).toBeTruthy();
  expect(container.querySelector(`[data-pg-workspace-path="${createdPage.path}"]`)).toBeNull();

  // 树读完后在同一次提交里替换为正式页面行并选中
  await act(async () => {
    resolveTree([pageA, pageB, dirNode, createdPage]);
    await Promise.resolve();
  });
  expect(container.querySelector("input")).toBeNull();
  expect(isSelectedRow(createdPage.path)).toBe(true);
  expect(toast.success).not.toHaveBeenCalled();

  // 开启提示开关后再新建页面，应弹出成功提示
  stateRef.showCreatePageToast = true;
  const secondPage: WorkspaceNode = { kind: "page", name: "测试页2", path: `${rootDir}/测试页2.prg` };
  vi.mocked(WorkspaceManager.createPage).mockImplementationOnce(async () => {
    stateRef.treeNodes = [pageA, pageB, dirNode, createdPage, secondPage];
    return secondPage.path;
  });
  await act(async () =>
    root.render(
      <Provider store={store}>
        <WorkspaceWindow />
      </Provider>,
    ),
  );
  await act(async () => {
    newPageButton.click();
  });
  const secondInput = await vi.waitFor(() => {
    const el = container.querySelector<HTMLInputElement>("input");
    expect(el).toBeTruthy();
    return el!;
  });
  secondInput.value = "测试页2";
  await act(async () => {
    secondInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(isSelectedRow(secondPage.path)).toBe(true));
  expect(toast.success).toHaveBeenCalledExactlyOnceWith("pageCreated");
});
