import { loadAllServicesAfterInit, loadAllServicesBeforeInit } from "@/core/loadAllServices";
import { Project, ProjectState } from "@/core/Project";
import { onOpenFile, waitForOpeningFiles } from "@/core/service/GlobalMenu";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, activeTabAtom, store, tabsAtom } from "@/state";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { URI } from "vscode-uri";
import { WorkspaceManager, WorkspacePaths } from "./WorkspaceManager";

const OPEN_SOURCE = "工作空间文件树";
const deletingEntries = new Map<string, Promise<void>>();
const pendingPeerReopens = new Map<string, string[]>();
let reopeningProjects = 0;
let crossWindowListenersInstalled = false;

interface WorkspaceCoordRequest {
  requestId: string;
  action: "prepare-path-change" | "prepare-delete";
  sourcePath: string;
  targetPath?: string | null;
  sourceWindow: string;
}

interface WorkspaceSyncPayload {
  sourceWindow: string;
  payload:
    | { type: "path-changed"; sourcePath: string; targetPath: string }
    | { type: "path-change-aborted"; sourcePath: string }
    | { type: "path-deleted"; sourcePath: string }
    | { type: "reload-page"; path: string };
}

export async function installWorkspaceCrossWindowListeners(): Promise<void> {
  if (crossWindowListenersInstalled || !isTauri()) return;
  crossWindowListenersInstalled = true;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const currentWindow = getCurrentWindow();

  await currentWindow.listen<WorkspaceCoordRequest>("pg-workspace-coord-request", async ({ payload }) => {
    const source = WorkspacePaths.normalize(payload.sourcePath);
    try {
      await waitForOpeningFiles((uri) => uri.scheme === "file" && WorkspacePaths.isInside(uri.fsPath, source));
      const opened = findOpenProjectsUnder(source, true);
      if (payload.action === "prepare-path-change") {
        const reopening = opened.filter((project) => !project.closing);
        const nested = reopening.map((project) => relativePart(source, project.uri.fsPath));
        if (nested.length > 0) {
          pendingPeerReopens.set(source, nested);
          reopeningProjects += 1;
        }
        await Promise.all(reopening.map(saveIfNeeded));
        await Promise.all(opened.map((project) => TabWorkspace.close(project.id, { animate: false })));
      } else if (payload.action === "prepare-delete") {
        const reopening = opened.filter((project) => !project.closing);
        const nested = reopening.map((project) => relativePart(source, project.uri.fsPath));
        if (nested.length > 0) {
          pendingPeerReopens.set(source, nested);
          reopeningProjects += 1;
        }
        await Promise.all(opened.map((project) => TabWorkspace.close(project.id)));
      }
      await invoke("respond_workspace_action", { requestId: payload.requestId, ok: true });
    } catch {
      await invoke("respond_workspace_action", { requestId: payload.requestId, ok: false });
    }
  });

  await currentWindow.listen<WorkspaceSyncPayload>("pg-workspace-sync", async ({ payload: event }) => {
    const msg = event.payload;
    if (msg.type === "path-changed") {
      const source = WorkspacePaths.normalize(msg.sourcePath);
      const target = WorkspacePaths.normalize(msg.targetPath);
      const nested = pendingPeerReopens.get(source);
      if (!nested) return;
      pendingPeerReopens.delete(source);
      try {
        for (const part of nested) {
          await openWorkspacePage(part ? WorkspacePaths.join(target, part) : target);
        }
      } finally {
        reopeningProjects = Math.max(0, reopeningProjects - 1);
      }
    } else if (msg.type === "path-change-aborted") {
      const source = WorkspacePaths.normalize(msg.sourcePath);
      const nested = pendingPeerReopens.get(source);
      if (!nested) return;
      pendingPeerReopens.delete(source);
      try {
        for (const part of nested) {
          await openWorkspacePage(part ? WorkspacePaths.join(source, part) : source);
        }
      } finally {
        reopeningProjects = Math.max(0, reopeningProjects - 1);
      }
    } else if (msg.type === "path-deleted") {
      const source = WorkspacePaths.normalize(msg.sourcePath);
      if (pendingPeerReopens.delete(source)) {
        reopeningProjects = Math.max(0, reopeningProjects - 1);
      }
    } else if (msg.type === "reload-page") {
      const opened = findOpenProject(msg.path);
      if (!opened) return;
      await TabWorkspace.close(opened.id);
      await openWorkspacePage(msg.path);
    }
  });
}

export function isReopeningWorkspaceProject(): boolean {
  return reopeningProjects > 0;
}

function findOpenProject(path: string): Project | undefined {
  const target = WorkspacePaths.normalize(path);
  return store
    .get(tabsAtom)
    .find(
      (tab): tab is Project =>
        tab instanceof Project &&
        !tab.closing &&
        tab.uri.scheme === "file" &&
        WorkspacePaths.normalize(tab.uri.fsPath) === target,
    );
}

async function saveIfNeeded(project: Project | undefined): Promise<void> {
  if (!project) return;
  if (project.projectState === ProjectState.Saved) return;
  await project.save({ includeThumbnail: false });
}

/** 打开/聚焦页面；内部调 onOpenFile(URI.file(path), "工作空间文件树") */
export async function openWorkspacePage(path: string): Promise<void> {
  const target = WorkspacePaths.normalize(path);
  if ([...deletingEntries.keys()].some((entry) => WorkspacePaths.isInside(target, entry))) return;
  const opened = findOpenProject(target);
  if (opened) {
    TabWorkspace.focus(opened.id);
    return;
  }
  await onOpenFile(URI.file(target), OPEN_SOURCE);
}

/** 删除：若该文件已打开 → TabWorkspace.close；确认框由 UI 负责 */
export async function deleteWorkspacePage(path: string): Promise<void> {
  await deleteWorkspaceEntry(path, (target) => WorkspaceManager.deletePage(target));
}

/** 重命名：若已打开 → save → close → rename → 重新打开新路径；返回新路径 */
export async function renameWorkspacePage(path: string, newName: string): Promise<string> {
  return await withPathChange(path, (source) => WorkspaceManager.renamePage(source, newName));
}

export async function moveWorkspacePage(path: string, targetDir: string): Promise<string> {
  if (WorkspacePaths.dirname(path) === WorkspacePaths.normalize(targetDir)) return WorkspacePaths.normalize(path);
  return await withPathChange(path, (source) => WorkspaceManager.movePage(source, targetDir));
}

export async function copyWorkspacePage(path: string, targetDir: string): Promise<string> {
  await saveIfNeeded(findOpenProject(path));
  return await WorkspaceManager.copyPage(path, targetDir);
}

/** 目录下（含子目录）所有已打开的页面 */
function findOpenProjectsUnder(path: string, includeClosing = false): Project[] {
  const target = WorkspacePaths.normalize(path);
  return store
    .get(tabsAtom)
    .filter(
      (tab): tab is Project =>
        tab instanceof Project &&
        (includeClosing || !tab.closing) &&
        tab.uri.scheme === "file" &&
        WorkspacePaths.isInside(WorkspacePaths.normalize(tab.uri.fsPath), target),
    );
}

/** 相对父路径的尾部；父路径本身返回空串 */
function relativePart(parent: string, path: string): string {
  const base = WorkspacePaths.normalize(parent);
  const target = WorkspacePaths.normalize(path);
  return target === base ? "" : target.slice(base.length + 1);
}

/**
 * 通用节点改路径：先把受影响的已打开工程存盘关闭，改完再按新路径重新打开，
 * 否则旧路径的 ownership 锁会挡住新路径，目录改名后子页也会指向不存在的目录。
 */
async function withPathChange(path: string, change: (source: string) => Promise<string>): Promise<string> {
  const source = WorkspacePaths.normalize(path);
  const opened = findOpenProjectsUnder(source, true);
  const reopening = opened.filter((project) => !project.closing);
  const nested = reopening.map((project) => relativePart(source, project.uri.fsPath));
  if (reopening.length) reopeningProjects += 1;
  let peerCoordinationStarted = false;
  try {
    if (crossWindowListenersInstalled && isTauri()) {
      peerCoordinationStarted = true;
      await invoke("coordinate_workspace_action", {
        action: "prepare-path-change",
        sourcePath: source,
        targetPath: null,
      });
    }
    if (opened.length) {
      await Promise.all(reopening.map(saveIfNeeded));
      await Promise.all(opened.map((project) => TabWorkspace.close(project.id, { animate: false })));
    }
    const newPath = await change(source);
    for (const part of nested) {
      await openWorkspacePage(part ? WorkspacePaths.join(newPath, part) : newPath);
    }
    if (peerCoordinationStarted) {
      await invoke("broadcast_workspace_event", {
        payload: { type: "path-changed", sourcePath: source, targetPath: newPath },
      });
    }
    return newPath;
  } catch (error) {
    if (peerCoordinationStarted) {
      await invoke("broadcast_workspace_event", {
        payload: { type: "path-change-aborted", sourcePath: source },
      });
    }
    throw error;
  } finally {
    if (reopening.length) reopeningProjects -= 1;
  }
}

/** 重命名页面或文件夹（自动判断），返回新路径 */
export async function renameWorkspaceNode(path: string, newName: string): Promise<string> {
  return await withPathChange(path, (source) => WorkspaceManager.renameNode(source, newName));
}

export async function moveWorkspaceNode(path: string, targetDir: string): Promise<string> {
  if (WorkspacePaths.dirname(path) === WorkspacePaths.normalize(targetDir)) return WorkspacePaths.normalize(path);
  return await withPathChange(path, (source) => WorkspaceManager.moveNode(source, targetDir));
}

/** 整棵目录递归删除；目录里已打开的页面先关掉，否则它们会继续往已删除的路径回写 */
export async function deleteWorkspaceFolder(path: string): Promise<void> {
  await deleteWorkspaceEntry(path, (target) => WorkspaceManager.deleteFolder(target));
}

async function deleteWorkspaceEntry(path: string, remove: (target: string) => Promise<void>): Promise<void> {
  const target = WorkspacePaths.normalize(path);
  for (const [entry, pending] of deletingEntries) {
    if (WorkspacePaths.isInside(target, entry)) return pending;
  }
  const task = (async () => {
    const peerCoordinationStarted = crossWindowListenersInstalled && isTauri();
    let removed = false;
    try {
      if (peerCoordinationStarted) {
        await invoke("coordinate_workspace_action", {
          action: "prepare-delete",
          sourcePath: target,
          targetPath: null,
        });
      }
      await waitForOpeningFiles((uri) => uri.scheme === "file" && WorkspacePaths.isInside(uri.fsPath, target));
      await Promise.all(findOpenProjectsUnder(target, true).map((project) => TabWorkspace.close(project.id)));
      await remove(target);
      removed = true;
      if (peerCoordinationStarted) {
        await invoke("broadcast_workspace_event", {
          payload: { type: "path-deleted", sourcePath: target },
        });
      }
    } catch (error) {
      if (peerCoordinationStarted && !removed) {
        await invoke("broadcast_workspace_event", {
          payload: { type: "path-change-aborted", sourcePath: target },
        });
      }
      throw error;
    }
  })();
  deletingEntries.set(target, task);
  try {
    await task;
  } finally {
    deletingEntries.delete(target);
  }
}

/** 批量移动：返回落成的新路径；中途失败时已移动的项保留（与 Manager 语义一致） */
export async function moveWorkspaceNodes(paths: string[], targetDir: string): Promise<string[]> {
  const moved: string[] = [];
  for (const path of paths) {
    moved.push(await moveWorkspaceNode(path, targetDir));
  }
  return moved;
}

export async function copyWorkspaceNodes(paths: string[], targetDir: string): Promise<string[]> {
  const copied: string[] = [];
  for (const path of paths) {
    copied.push(await copyWorkspaceNode(path, targetDir));
  }
  return copied;
}

export async function copyWorkspaceNode(path: string, targetDir: string): Promise<string> {
  await saveIfNeeded(findOpenProject(path));
  return await WorkspaceManager.copyNode(path, targetDir);
}

/**
 * 磁盘文件被外部改动（例如恢复历史版本）后，让已打开的页面重新从磁盘加载。
 * 不重新加载的话，内存里的旧内容会在下一次自动保存时把恢复结果覆盖掉。
 */
export async function reloadWorkspacePage(path: string): Promise<void> {
  const opened = findOpenProject(path);
  if (opened) {
    await TabWorkspace.close(opened.id);
    await openWorkspacePage(path);
  }
  if (crossWindowListenersInstalled && isTauri()) {
    await invoke("broadcast_workspace_event", {
      payload: { type: "reload-page", path },
    });
  }
}

/** 打开指定快照：作为草稿副本打开（不覆盖原文件） */
export async function openVersionAsCopy(versionFilePath: string): Promise<void> {
  const project = Project.newDraft();
  const draftUri = project.uri;
  loadAllServicesBeforeInit(project);
  project.uri = URI.file(WorkspacePaths.normalize(versionFilePath));
  await project.init();
  loadAllServicesAfterInit(project);
  // 读完快照内容后回到草稿身份，这样保存时会另存为新文件而不是覆盖快照
  project.uri = draftUri;
  store.set(tabsAtom, [...store.get(tabsAtom), project]);
  store.set(activeTabAtom, project);
  store.set(activeResourceTabAtom, project);
}
