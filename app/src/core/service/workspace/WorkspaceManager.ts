import { loadAllServicesAfterInit, loadAllServicesBeforeInit } from "@/core/loadAllServices";
import { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { copyFile, exists, mkdir, readDir, remove, rename, watch } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";
import { URI } from "vscode-uri";

export type WorkspaceNode =
  | { kind: "dir"; name: string; path: string; children: WorkspaceNode[] }
  | { kind: "page"; name: string; path: string }; // name 不含 .prg

export type WorkspaceClipboard = { mode: "cut" | "copy"; path: string; name: string };

type WorkspaceEvent = "change" | "root-change";

const HISTORY_DIR = ".flux-graph/history";
/** 同一页面两次快照的最小间隔，避免自动保存把历史冲刷掉 */
const SNAPSHOT_INTERVAL_MS = 30_000;
const SNAPSHOT_KEEP_COUNT = 20;
/** 树里只显示目录和 .prg 页面，其余文件类型一律不出现 */
const IGNORED_DIR_NAMES = new Set(["node_modules", "dist", "__pycache__", "target"]);
const IGNORED_PREFIX = ".";

/**
 * 路径工具。工作空间内所有路径一律用正斜杠，且盘符小写，
 * 这样可以直接和 vscode-uri 的 uri.fsPath 比对（Windows 上 fsPath 是反斜杠 + 小写盘符）。
 */
export namespace WorkspacePaths {
  export function normalize(path: string): string {
    let result = path.replace(/\\/g, "/");
    while (result.length > 1 && result.endsWith("/") && !/^[a-zA-Z]:\/$/.test(result)) {
      result = result.slice(0, -1);
    }
    if (/^[a-zA-Z]:\//.test(result)) {
      result = result[0].toLowerCase() + result.slice(1);
    }
    return result;
  }

  export function dirname(path: string): string {
    const normalized = normalize(path);
    const index = normalized.lastIndexOf("/");
    if (index < 0) return normalized;
    if (index === 0) return "/";
    if (index === 2 && /^[a-z]:\//.test(normalized)) return normalized.slice(0, 3);
    return normalized.slice(0, index);
  }

  export function join(...parts: string[]): string {
    return normalize(
      parts
        .map((part) => normalize(part))
        .filter((part) => part !== "")
        .join("/")
        .replace(/\/+/g, "/"),
    );
  }

  /** 页面显示名：去掉 .prg 的文件名 */
  export function nameOf(path: string): string {
    const normalized = normalize(path);
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    return base.toLowerCase().endsWith(".prg") ? base.slice(0, -4) : base;
  }

  export function isInside(path: string, parent: string): boolean {
    const target = normalize(path);
    const base = normalize(parent);
    return target === base || target.startsWith(base.endsWith("/") ? base : base + "/");
  }
}

export class WorkspaceManagerClass {
  clipboard: WorkspaceClipboard | null = null;

  private readonly listeners: Record<WorkspaceEvent, Set<() => void>> = {
    change: new Set(),
    "root-change": new Set(),
  };
  private unwatch?: () => void;
  private watchingRoot?: string;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private readonly snapshotTimes = new Map<string, number>();

  /** 当前根目录；未打开时为 undefined */
  get root(): string | undefined {
    const root = Settings.activeWorkspaceRoot;
    return root ? WorkspacePaths.normalize(root) : undefined;
  }

  /** dir 省略时弹目录选择框；成功后写 Settings.workspaceRoots / activeWorkspaceRoot，emit "root-change" */
  async openWorkspace(dir?: string): Promise<void> {
    const picked = dir ?? (await openWorkspaceFolderByDialog());
    if (!picked) return;
    const root = WorkspacePaths.normalize(picked);
    if (!(await exists(root))) {
      throw new Error(i18next.t("workspace.rootMissing", { defaultValue: root }));
    }
    const roots = Settings.workspaceRoots.map((item) => WorkspacePaths.normalize(item));
    if (!roots.includes(root)) {
      Settings.workspaceRoots = [...roots, root];
    }
    Settings.activeWorkspaceRoot = root;
    this.clipboard = null;
    this.snapshotTimes.clear();
    await this.startWatching();
    this.emit("root-change");
    this.emit("change");
  }

  async closeWorkspace(): Promise<void> {
    this.stopWatching();
    this.clipboard = null;
    Settings.activeWorkspaceRoot = "";
    this.emit("root-change");
  }

  /** 读根目录一级节点（递归到子目录） */
  async readTree(): Promise<WorkspaceNode[]> {
    return await this.readDirNodes(this.requireRoot());
  }

  /**
   * 应用重启后 Settings 里还有根目录，但 watcher 只活在进程内，需要重新挂上。
   * 面板挂载时调用一次即可，重复调用无副作用。
   */
  async ensureWatching(): Promise<void> {
    const root = this.root;
    if (!root) {
      this.stopWatching();
      return;
    }
    if (this.watchingRoot === root && this.unwatch) return;
    await this.startWatching();
  }

  /** 新建空 .prg：PROJECT.newDraft() → uri → init → save；重名自动加 " (2)"；返回新路径 */
  async createPage(dirPath: string, name: string): Promise<string> {
    this.requireRoot();
    const dir = WorkspacePaths.normalize(dirPath);
    const baseName = this.sanitizeName(name);
    await mkdir(dir, { recursive: true });
    const target = await this.uniquePath(dir, baseName);
    const project = Project.newDraft();
    project.uri = URI.file(target);
    loadAllServicesBeforeInit(project);
    try {
      await project.init();
      loadAllServicesAfterInit(project);
      project.stageManager.add(new TextNode(project, { text: baseName }));
      await project.save({ includeThumbnail: false });
    } finally {
      await project.dispose();
    }
    this.emit("change");
    return target;
  }

  async deletePage(path: string): Promise<void> {
    await remove(WorkspacePaths.normalize(path));
    this.emit("change");
  }

  /** 返回新路径；非法字符与重名按 createPage 规则处理 */
  async renamePage(path: string, newName: string): Promise<string> {
    const source = WorkspacePaths.normalize(path);
    const baseName = this.sanitizeName(newName);
    const currentName = WorkspacePaths.nameOf(source);
    if (baseName === currentName) return source;
    if (baseName.toLowerCase() === currentName.toLowerCase()) {
      const casingTarget = WorkspacePaths.join(WorkspacePaths.dirname(source), `${baseName}.prg`);
      await this.movePageFile(source, casingTarget);
      this.emit("change");
      return casingTarget;
    }
    const target = await this.uniquePath(WorkspacePaths.dirname(source), baseName);
    await this.movePageFile(source, target);
    this.emit("change");
    return target;
  }

  async movePage(path: string, targetDir: string): Promise<string> {
    const source = WorkspacePaths.normalize(path);
    const dir = WorkspacePaths.normalize(targetDir);
    if (dir === WorkspacePaths.dirname(source)) return source;
    // 移到自己的子页目录里会把子页目录搬进自身，导致目录结构自引用
    if (WorkspacePaths.isInside(dir, this.childDirOf(source))) {
      throw new Error(i18next.t("workspace.invalidName", { defaultValue: dir }));
    }
    await mkdir(dir, { recursive: true });
    const target = await this.uniquePath(dir, WorkspacePaths.nameOf(source));
    await this.movePageFile(source, target);
    this.emit("change");
    return target;
  }

  async copyPage(path: string, targetDir: string): Promise<string> {
    const source = WorkspacePaths.normalize(path);
    const dir = WorkspacePaths.normalize(targetDir);
    await mkdir(dir, { recursive: true });
    const target = await this.uniquePath(dir, WorkspacePaths.nameOf(source));
    await copyFile(source, target);
    this.emit("change");
    return target;
  }

  /** 降级：移到"同级前一个页面 P"对应的目录 `<dir>/P/`；没有前一个页面时抛错（UI 据此禁用） */
  async demotePage(path: string): Promise<string> {
    const source = WorkspacePaths.normalize(path);
    const previous = await this.previousSiblingPage(source);
    if (!previous) {
      throw new Error(i18next.t("workspace.demoteUnavailable", { defaultValue: WorkspacePaths.nameOf(source) }));
    }
    return await this.movePage(source, this.childDirOf(previous));
  }

  /** 升级：从 `<dir>/P/` 移回 `<dir>/`；已在根层时抛错 */
  async promotePage(path: string): Promise<string> {
    const root = this.requireRoot();
    const source = WorkspacePaths.normalize(path);
    const dir = WorkspacePaths.dirname(source);
    if (dir === root || !WorkspacePaths.isInside(dir, root)) {
      throw new Error(i18next.t("workspace.promoteUnavailable", { defaultValue: WorkspacePaths.nameOf(source) }));
    }
    return await this.movePage(source, WorkspacePaths.dirname(dir));
  }

  cut(path: string): void {
    const target = WorkspacePaths.normalize(path);
    this.clipboard = { mode: "cut", path: target, name: WorkspacePaths.nameOf(target) };
    this.emit("change");
  }

  copy(path: string): void {
    const target = WorkspacePaths.normalize(path);
    this.clipboard = { mode: "copy", path: target, name: WorkspacePaths.nameOf(target) };
    this.emit("change");
  }

  /** 到 targetDir；cut 走移动、copy 走复制；成功后清空剪贴板 */
  async paste(targetDir: string): Promise<string | null> {
    const clipboard = this.clipboard;
    if (!clipboard) return null;
    if (!(await exists(clipboard.path))) {
      // 剪贴板里的文件已经被删/移走，粘贴没有目标，直接作废
      this.clipboard = null;
      this.emit("change");
      return null;
    }
    const target =
      clipboard.mode === "cut"
        ? await this.movePage(clipboard.path, targetDir)
        : await this.copyPage(clipboard.path, targetDir);
    this.clipboard = null;
    this.emit("change");
    return target;
  }

  /** 写历史快照：`<root>/.flux-graph/history/<相对目录>/<页面名>/<yyyyMMdd-HHmmss>.prg`，同页 30s 内不重复、每页保留 20 份 */
  async snapshotPage(path: string): Promise<void> {
    await this.writeSnapshot(path, false);
  }

  async listVersions(path: string): Promise<{ id: string; time: number; filePath: string }[]> {
    if (!this.root) return [];
    const dir = this.versionDir(WorkspacePaths.normalize(path));
    if (!(await exists(dir))) return [];
    const entries = await readDir(dir);
    return entries
      .filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith(".prg"))
      .map((entry) => {
        const id = entry.name.slice(0, -4);
        return { id, time: parseVersionId(id), filePath: WorkspacePaths.join(dir, entry.name) };
      })
      .sort((left, right) => right.time - left.time);
  }

  /** 用某个快照覆盖当前页面文件（覆盖前先 snapshotPage 保底） */
  async restoreVersion(path: string, versionId: string): Promise<void> {
    const source = WorkspacePaths.normalize(path);
    const versionPath = WorkspacePaths.join(this.versionDir(source), `${versionId}.prg`);
    if (!(await exists(versionPath))) {
      throw new Error(i18next.t("workspace.versionsEmpty", { defaultValue: versionId }));
    }
    await this.writeSnapshot(source, true);
    await copyFile(versionPath, source);
    this.emit("change");
  }

  on(event: WorkspaceEvent, listener: () => void): void {
    this.listeners[event].add(listener);
  }

  off(event: WorkspaceEvent, listener: () => void): void {
    this.listeners[event].delete(listener);
  }

  emit(event: WorkspaceEvent): void {
    for (const listener of [...this.listeners[event]]) {
      listener();
    }
  }

  private requireRoot(): string {
    const root = this.root;
    if (!root) throw new Error(i18next.t("workspace.notAWorkspace"));
    return root;
  }

  private async readDirNodes(dirPath: string): Promise<WorkspaceNode[]> {
    if (!(await exists(dirPath))) return [];
    let entries;
    try {
      entries = await readDir(dirPath);
    } catch (error) {
      // 单个子目录读不出来（权限/占用）不该让整棵树空白，但要让人知道哪一层出了问题
      this.reportUnreadableDir(dirPath, error);
      return [];
    }
    const dirs: WorkspaceNode[] = [];
    const pages: WorkspaceNode[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(IGNORED_PREFIX) || IGNORED_DIR_NAMES.has(entry.name)) continue;
      const entryPath = WorkspacePaths.join(dirPath, entry.name);
      if (entry.isDirectory) {
        dirs.push({ kind: "dir", name: entry.name, path: entryPath, children: await this.readDirNodes(entryPath) });
      } else if (entry.isFile && entry.name.toLowerCase().endsWith(".prg")) {
        pages.push({ kind: "page", name: entry.name.slice(0, -4), path: entryPath });
      }
    }
    dirs.sort((left, right) => left.name.localeCompare(right.name));
    pages.sort((left, right) => left.name.localeCompare(right.name));
    return [...dirs, ...pages];
  }

  private readonly unreadableDirs = new Set<string>();

  private reportUnreadableDir(dirPath: string, error: unknown): void {
    if (this.unreadableDirs.has(dirPath)) return;
    this.unreadableDirs.add(dirPath);
    toast.error(i18next.t("workspace.dirUnreadable", { name: dirPath, defaultValue: String(error) }));
  }

  private async listPagePaths(dirPath: string): Promise<string[]> {
    if (!(await exists(dirPath))) return [];
    const entries = await readDir(dirPath);
    return entries
      .filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith(".prg") && !entry.name.startsWith("."))
      .map((entry) => WorkspacePaths.join(dirPath, entry.name))
      .sort((left, right) => WorkspacePaths.nameOf(left).localeCompare(WorkspacePaths.nameOf(right)));
  }

  private async previousSiblingPage(source: string): Promise<string | undefined> {
    const siblings = await this.listPagePaths(WorkspacePaths.dirname(source));
    const index = siblings.indexOf(source);
    return index > 0 ? siblings[index - 1] : undefined;
  }

  /** 页面的子页目录：与页面同级的同名目录 */
  private childDirOf(pagePath: string): string {
    return WorkspacePaths.join(WorkspacePaths.dirname(pagePath), WorkspacePaths.nameOf(pagePath));
  }

  /**
   * 移动页面文件本身，并把它承载的子页目录一起搬走，
   * 否则改名的页面会留下一个对不上名字的子页目录（父子关系就是目录层级）。
   */
  private async movePageFile(source: string, target: string): Promise<void> {
    await rename(source, target);
    const sourceChildren = this.childDirOf(source);
    if (!(await exists(sourceChildren))) return;
    const targetChildren = this.childDirOf(target);
    if (await exists(targetChildren)) return;
    await rename(sourceChildren, targetChildren);
  }

  private sanitizeName(name: string): string {
    let baseName = name.trim();
    if (baseName.toLowerCase().endsWith(".prg")) baseName = baseName.slice(0, -4);
    if (!baseName) throw new Error(i18next.t("workspace.nameRequired"));
    if (/[\\/:*?"<>|]/.test(baseName)) throw new Error(i18next.t("workspace.invalidName"));
    return baseName;
  }

  /** 重名时依次尝试 "名字 (2)"、"名字 (3)"…… */
  private async uniquePath(dirPath: string, name: string): Promise<string> {
    let candidate = WorkspacePaths.join(dirPath, `${name}.prg`);
    let counter = 2;
    while (await exists(candidate)) {
      candidate = WorkspacePaths.join(dirPath, `${name} (${counter}).prg`);
      counter += 1;
    }
    return candidate;
  }

  private relativeTo(root: string, path: string): string {
    const target = WorkspacePaths.normalize(path);
    return target === root ? "" : target.slice(root.length + 1);
  }

  private versionDir(pagePath: string): string {
    const root = this.requireRoot();
    return WorkspacePaths.join(
      root,
      HISTORY_DIR,
      this.relativeTo(root, WorkspacePaths.dirname(pagePath)),
      WorkspacePaths.nameOf(pagePath),
    );
  }

  private async writeSnapshot(path: string, force: boolean): Promise<void> {
    if (!Settings.workspaceVersionHistory) return;
    // 没打开工作空间时没有快照目录可写，自动保存会频繁触发，因此静默返回
    const root = this.root;
    if (!root) return;
    const source = WorkspacePaths.normalize(path);
    // 自动保存会把工作空间外的工程也传进来，这里只给工作空间内的页面留快照
    if (!WorkspacePaths.isInside(source, root)) return;
    if (!(await exists(source))) return;
    const now = Date.now();
    const last = this.snapshotTimes.get(source);
    if (!force && last !== undefined && now - last < SNAPSHOT_INTERVAL_MS) return;
    const dir = this.versionDir(source);
    await mkdir(dir, { recursive: true });
    this.snapshotTimes.set(source, now);
    await copyFile(source, WorkspacePaths.join(dir, `${formatVersionId(now)}.prg`));
    await this.pruneVersions(dir);
  }

  private async pruneVersions(dirPath: string): Promise<void> {
    const entries = await readDir(dirPath);
    const names = entries
      .filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith(".prg"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of names.slice(SNAPSHOT_KEEP_COUNT)) {
      await remove(WorkspacePaths.join(dirPath, name));
    }
  }

  private async startWatching(): Promise<void> {
    const root = this.root;
    this.stopWatching();
    if (!root) return;
    this.watchingRoot = root;
    try {
      const unwatch = await watch(root, () => this.scheduleChangeEmit(), { recursive: true, delayMs: 500 });
      if (this.watchingRoot !== root) {
        unwatch();
        return;
      }
      this.unwatch = unwatch;
    } catch (error) {
      toast.error(i18next.t("workspace.watchUnavailable", { defaultValue: String(error) }));
    }
  }

  private stopWatching(): void {
    this.watchingRoot = undefined;
    if (this.changeTimer !== undefined) {
      clearTimeout(this.changeTimer);
      this.changeTimer = undefined;
    }
    this.unwatch?.();
    this.unwatch = undefined;
  }

  private scheduleChangeEmit(): void {
    if (this.changeTimer !== undefined) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.emit("change");
    }, 300);
  }
}

async function openWorkspaceFolderByDialog(): Promise<string | undefined> {
  const picked = await openDialog({ directory: true, multiple: false });
  return Array.isArray(picked) ? picked[0] : (picked ?? undefined);
}

function formatVersionId(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseVersionId(id: string): number {
  const matched = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!matched) return 0;
  const [, year, month, day, hour, minute, second] = matched;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
}

export const WorkspaceManager = new WorkspaceManagerClass();
