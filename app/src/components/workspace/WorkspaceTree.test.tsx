// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { exists } from "@tauri-apps/plugin-fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceManager, type WorkspaceNode } from "@/core/service/workspace/WorkspaceManager";
import WorkspaceTree, { requestFocusedWorkspaceRename, type WorkspaceTreeActions } from "./WorkspaceTree";
import { flattenWorkspaceTree } from "./workspaceFlat";

vi.mock("@/core/loadAllServices", () => ({}));
vi.mock("@/core/Project", () => ({}));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({}));
vi.mock("@/core/service/Settings", () => ({ Settings: { activeWorkspaceRoot: "c:/workspace" } }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const parent = "c:/workspace";
const node: WorkspaceNode = { kind: "dir", path: `${parent}/笔记`, name: "笔记", children: [] };
const actions = {} as WorkspaceTreeActions;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("numbers default names independently for pages and folders in the target directory", async () => {
  const disk = new Set([
    `${parent}/新建文件夹`,
    `${parent}/新建文件夹（1）`,
    `${parent}/新建页面.prg`,
    `${parent}/新建页面（1）.prg`,
  ]);
  vi.mocked(exists).mockImplementation(async (path) => disk.has(String(path)));
  await expect(WorkspaceManager.suggestNewName(parent, "dir", "新建文件夹")).resolves.toBe("新建文件夹（2）");
  await expect(WorkspaceManager.suggestNewName(parent, "page", "新建页面")).resolves.toBe("新建页面（2）");
  await expect(WorkspaceManager.suggestNewName(node.path, "page", "新建页面")).resolves.toBe("新建页面");
});

it("places the pending row under its parent, selects its name, and confirms Enter only once", async () => {
  const page: WorkspaceNode = { kind: "page", path: `${node.path}/.pending`, name: "新建页面" };
  const rows = flattenWorkspaceTree([node], new Set(), parent, { dirPath: node.path, node: page });
  expect(rows[1]).toMatchObject({ node: page, dirPath: node.path, depth: 1 });
  const finishEdit = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <WorkspaceTree
        nodes={[node]}
        rows={rows}
        root={parent}
        actions={actions}
        collapsedDirs={new Set()}
        selectedPaths={new Set()}
        activeFsPath={undefined}
        clipboard={null}
        versionCounts={new Map()}
        dropTarget={null}
        manualOrder={false}
        renameOnDoubleClick={true}
        editingPath={page.path}
        focusRequest={null}
        finishEdit={finishEdit}
      />,
    ),
  );
  const input = container.querySelector("input")!;
  await vi.waitFor(() => expect(document.activeElement).toBe(input));
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, page.name.length]);
  input.value = "作业记录";
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    expect(finishEdit).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.blur();
  });
  expect(finishEdit).toHaveBeenCalledExactlyOnceWith("作业记录", true);
});

it("routes the rename shortcut only to a single selected row with focus", async () => {
  const renameNode = vi.fn();
  const rows = flattenWorkspaceTree([node], new Set(), parent);
  await act(async () =>
    root.render(
      <WorkspaceTree
        nodes={[node]}
        rows={rows}
        root={parent}
        actions={{ ...actions, renameNode }}
        collapsedDirs={new Set()}
        selectedPaths={new Set([node.path])}
        activeFsPath={undefined}
        clipboard={null}
        versionCounts={new Map()}
        dropTarget={null}
        manualOrder={false}
        renameOnDoubleClick={true}
        focusRequest={null}
        finishEdit={vi.fn()}
      />,
    ),
  );
  requestFocusedWorkspaceRename();
  expect(renameNode).not.toHaveBeenCalled();
  container.querySelector<HTMLButtonElement>("[data-pg-workspace-row]")!.focus();
  requestFocusedWorkspaceRename();
  expect(renameNode).toHaveBeenCalledExactlyOnceWith(node);
});

it.each<WorkspaceNode>([node, { kind: "page", name: "作业", path: `${parent}/作业.prg` }])(
  "renames $kind on the second click only when enabled",
  async (entry) => {
    const renameNode = vi.fn();
    const activate = vi.fn();
    const shouldIgnoreClick = vi.fn(() => false);
    const rows = flattenWorkspaceTree([entry], new Set(), parent);
    const render = async (enabled: boolean, selectedPaths: ReadonlySet<string>) =>
      act(async () =>
        root.render(
          <WorkspaceTree
            nodes={[entry]}
            rows={rows}
            root={parent}
            actions={{
              ...actions,
              renameNode,
              shouldIgnoreClick,
              clickRow: vi.fn(),
              openPage: activate,
              toggleDir: activate,
            }}
            collapsedDirs={new Set()}
            selectedPaths={selectedPaths}
            activeFsPath={undefined}
            clipboard={null}
            versionCounts={new Map()}
            dropTarget={null}
            manualOrder={false}
            renameOnDoubleClick={enabled}
            focusRequest={null}
            finishEdit={vi.fn()}
          />,
        ),
      );
    const click = (detail: number) =>
      act(async () => {
        const button = container.querySelector("[data-pg-workspace-row]")!;
        button.dispatchEvent(new MouseEvent("click", { detail, bubbles: true }));
      });

    await render(true, new Set());
    await click(1);
    expect(activate).toHaveBeenCalledOnce();
    expect(renameNode).not.toHaveBeenCalled();

    const selected = new Set([entry.path]);
    await render(true, selected);
    shouldIgnoreClick.mockReturnValueOnce(true);
    await click(2);
    expect(renameNode).not.toHaveBeenCalled();
    await click(2);
    expect(renameNode).toHaveBeenCalledExactlyOnceWith(entry);
    expect(activate).toHaveBeenCalledOnce();

    await render(false, selected);
    await click(2);
    expect(renameNode).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledTimes(2);
  },
);
