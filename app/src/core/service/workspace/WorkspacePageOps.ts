import { loadAllServicesAfterInit, loadAllServicesBeforeInit } from "@/core/loadAllServices";
import { Project, ProjectState } from "@/core/Project";
import { onOpenFile } from "@/core/service/GlobalMenu";
import { TabWorkspace } from "@/core/TabWorkspace";
import { activeResourceTabAtom, activeTabAtom, store, tabsAtom } from "@/state";
import { URI } from "vscode-uri";
import { WorkspaceManager, WorkspacePaths } from "./WorkspaceManager";

const OPEN_SOURCE = "工作空间文件树";

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

/**
 * 移动/重命名已打开的工程必须先 save 再 close：
 * 新路径要重新走 ProjectOwnership，旧路径的 ownership 锁必须先释放。
 */
async function closeBeforePathChange(project: Project | undefined): Promise<void> {
  if (!project) return;
  await saveIfNeeded(project);
  await TabWorkspace.close(project.id);
}

/** 打开/聚焦页面；内部调 onOpenFile(URI.file(path), "工作空间文件树") */
export async function openWorkspacePage(path: string): Promise<void> {
  const target = WorkspacePaths.normalize(path);
  const opened = findOpenProject(target);
  if (opened) {
    TabWorkspace.focus(opened.id);
    return;
  }
  await onOpenFile(URI.file(target), OPEN_SOURCE);
}

/** 删除：若该文件已打开 → TabWorkspace.close；确认框由 UI 负责 */
export async function deleteWorkspacePage(path: string): Promise<void> {
  const opened = findOpenProject(path);
  if (opened) await TabWorkspace.close(opened.id);
  await WorkspaceManager.deletePage(path);
}

/** 重命名：若已打开 → save → close → rename → 重新打开新路径；返回新路径 */
export async function renameWorkspacePage(path: string, newName: string): Promise<string> {
  const opened = findOpenProject(path);
  await closeBeforePathChange(opened);
  const newPath = await WorkspaceManager.renamePage(path, newName);
  if (opened) await openWorkspacePage(newPath);
  return newPath;
}

export async function moveWorkspacePage(path: string, targetDir: string): Promise<string> {
  const opened = findOpenProject(path);
  await closeBeforePathChange(opened);
  const newPath = await WorkspaceManager.movePage(path, targetDir);
  if (opened) await openWorkspacePage(newPath);
  return newPath;
}

export async function copyWorkspacePage(path: string, targetDir: string): Promise<string> {
  await saveIfNeeded(findOpenProject(path));
  return await WorkspaceManager.copyPage(path, targetDir);
}

export async function demoteWorkspacePage(path: string): Promise<string> {
  const opened = findOpenProject(path);
  await closeBeforePathChange(opened);
  const newPath = await WorkspaceManager.demotePage(path);
  if (opened) await openWorkspacePage(newPath);
  return newPath;
}

export async function promoteWorkspacePage(path: string): Promise<string> {
  const opened = findOpenProject(path);
  await closeBeforePathChange(opened);
  const newPath = await WorkspaceManager.promotePage(path);
  if (opened) await openWorkspacePage(newPath);
  return newPath;
}

/**
 * 磁盘文件被外部改动（例如恢复历史版本）后，让已打开的页面重新从磁盘加载。
 * 不重新加载的话，内存里的旧内容会在下一次自动保存时把恢复结果覆盖掉。
 */
export async function reloadWorkspacePage(path: string): Promise<void> {
  const opened = findOpenProject(path);
  if (!opened) return;
  await TabWorkspace.close(opened.id);
  await openWorkspacePage(path);
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
