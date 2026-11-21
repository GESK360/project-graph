import { loadAllServicesAfterInit, loadAllServicesBeforeInit } from "@/core/loadAllServices";
import { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  copyFile,
  exists,
  mkdir,
  readDir,
  readFile,
  remove,
  rename,
  stat,
  watch,
  writeFile,
} from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import { toast } from "sonner";
import { URI } from "vscode-uri";

export type WorkspaceNode =
  | { kind: "dir"; name: string; path: string; children: WorkspaceNode[] }
  | { kind: "page"; name: string; path: string }; // name 不含 .prg

export type WorkspaceClipboard = { mode: "cut" | "copy"; paths: string[] };

/** 与 Settings.workspaceSortMode 一一对应；custom 之外的模式都由界面禁用拖拽与上移下移 */
export type WorkspaceSortMode = "custom" | "name" | "createdAt" | "modifiedAt";

type WorkspaceEvent = "change" | "root-change";

const HISTORY_DIR = ".flux-graph/history";
/** 自定义排序文件：key 是相对根目录的目录路径（"" 为根），value 是该目录下的文件名数组 */
const ORDER_DIR = ".flux-graph";
const ORDER_FILE = ".flux-graph/order.json";
const DEFAULT_FOLDER_NAME = "新建文件夹";
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

  /** 文件名（含扩展名）；目录名就是目录名 */
  export function baseName(path: string): string {
    const normalized = normalize(path);
    return normalized.slice(normalized.lastIndexOf("/") + 1);
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
  private watchTask?: Promise<void>;
  private watchUnavailableRoot?: string;
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
    const root = this.requireRoot();
    const mode = Settings.workspaceSortMode;
    // 只有自定义排序才需要 order.json；其它模式按名字/时间排，读进来也用不上
    const order = mode === "custom" ? await this.readOrder() : {};
    return await this.readDirNodes(root, root, order, mode);
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
    if (this.watchingRoot === root && (this.unwatch || this.watchTask || this.watchUnavailableRoot === root)) {
      return;
    }
    await this.startWatching();
  }

  async suggestNewName(dirPath: string, kind: WorkspaceNode["kind"], name: string): Promise<string> {
    this.requireRoot();
    const dir = WorkspacePaths.normalize(dirPath);
    if (kind === "page") {
      const path = await this.uniqueTitlePath(dir, this.sanitizeName(name), ".prg");
      return WorkspacePaths.nameOf(path);
    }
    return WorkspacePaths.baseName(await this.uniqueTitlePath(dir, this.sanitizeFolderName(name)));
  }

  /** 新建空 .prg，返回实际保存的路径 */
  async createPage(dirPath: string, name: string): Promise<string> {
    this.requireRoot();
    const dir = WorkspacePaths.normalize(dirPath);
    const baseName = this.sanitizeName(name);
    await mkdir(dir, { recursive: true });
    const target = await this.uniqueTitlePath(dir, baseName, ".prg");
    const project = Project.newDraft();
    project.uri = URI.file(target);
    loadAllServicesBeforeInit(project);
    try {
      await project.init();
      loadAllServicesAfterInit(project);
      project.stageManager.add(new TextNode(project, { text: WorkspacePaths.nameOf(target) }));
      await project.save({ includeThumbnail: false });
    } finally {
      await project.dispose();
    }
    await this.appendOrder(dir, WorkspacePaths.baseName(target));
    this.emit("change");
    return target;
  }

  async deletePage(path: string): Promise<void> {
    const target = WorkspacePaths.normalize(path);
    await remove(target);
    await this.pruneOrder([WorkspacePaths.dirname(target)]);
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
      await this.updateOrderAfterRename(source, casingTarget);
      await this.pruneOrder([WorkspacePaths.dirname(source)]);
      this.emit("change");
      return casingTarget;
    }
    const target = await this.uniqueTitlePath(WorkspacePaths.dirname(source), baseName, ".prg");
    await this.movePageFile(source, target);
    await this.updateOrderAfterRename(source, target);
    await this.pruneOrder([WorkspacePaths.dirname(source)]);
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
    await this.pruneOrder([WorkspacePaths.dirname(source), dir]);
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

  /** dirPath 下新建空目录；name 省略时用「新建文件夹」，重名依次「新建文件夹（1）」…… */
  async createFolder(dirPath: string, name?: string): Promise<string> {
    this.requireRoot();
    const dir = WorkspacePaths.normalize(dirPath);
    const baseName =
      name === undefined
        ? i18next.t("workspace.newFolderName", { defaultValue: DEFAULT_FOLDER_NAME })
        : this.sanitizeFolderName(name);
    await mkdir(dir, { recursive: true });
    const target = await this.uniqueTitlePath(dir, baseName);
    await mkdir(target, { recursive: true });
    await this.appendOrder(dir, WorkspacePaths.baseName(target));
    this.emit("change");
    return target;
  }

  async renameFolder(path: string, newName: string): Promise<string> {
    const source = WorkspacePaths.normalize(path);
    const baseName = this.sanitizeFolderName(newName);
    const currentName = WorkspacePaths.baseName(source);
    if (baseName === currentName) return source;
    const parent = WorkspacePaths.dirname(source);
    const target =
      baseName.toLowerCase() === currentName.toLowerCase()
        ? WorkspacePaths.join(parent, baseName)
        : await this.uniqueTitlePath(parent, baseName);
    await rename(source, target);
    await this.updateOrderAfterRename(source, target);
    await this.pruneOrder([parent]);
    this.emit("change");
    return target;
  }

  /** 递归删除整棵目录；UI 必须二次确认 */
  async deleteFolder(path: string): Promise<void> {
    const root = this.requireRoot();
    const target = WorkspacePaths.normalize(path);
    // 删掉根目录（或根的上级）等于把整个工作空间端掉，直接拒绝
    if (WorkspacePaths.isInside(root, target)) {
      throw new Error(i18next.t("workspace.invalidName", { defaultValue: target }));
    }
    await remove(target, { recursive: true });
    await this.pruneOrder([WorkspacePaths.dirname(target)]);
    this.emit("change");
  }

  /** 通用：内部判断是目录还是页面 */
  async renameNode(path: string, newName: string): Promise<string> {
    const source = WorkspacePaths.normalize(path);
    if (await this.isFolder(source)) return await this.renameFolder(source, newName);
    return await this.renamePage(source, newName);
  }

  async moveNode(path: string, targetDir: string): Promise<string> {
    const source = WorkspacePaths.normalize(path);
    const dir = WorkspacePaths.normalize(targetDir);
    const folder = await this.isFolder(source);
    // 目录不能挪进自己的子树，页面也不能挪进承载自己子页的那个目录，否则子树会被搬进自身
    const protectedPath = folder ? source : this.childDirOf(source);
    if (WorkspacePaths.isInside(dir, protectedPath)) {
      throw new Error(i18next.t("workspace.dragInvalidTarget", { defaultValue: dir }));
    }
    if (dir === WorkspacePaths.dirname(source)) return source;
    await mkdir(dir, { recursive: true });
    let target: string;
    if (folder) {
      target = await this.uniqueTitlePath(dir, WorkspacePaths.baseName(source));
      await rename(source, target);
    } else {
      target = await this.uniquePath(dir, WorkspacePaths.nameOf(source));
      await this.movePageFile(source, target);
    }
    await this.pruneOrder([WorkspacePaths.dirname(source), dir]);
    this.emit("change");
    return target;
  }

  async copyNode(path: string, targetDir: string): Promise<string> {
    const source = WorkspacePaths.normalize(path);
    const dir = WorkspacePaths.normalize(targetDir);
    const folder = await this.isFolder(source);
    if (folder && WorkspacePaths.isInside(dir, source)) {
      throw new Error(i18next.t("workspace.dragInvalidTarget", { defaultValue: dir }));
    }
    await mkdir(dir, { recursive: true });
    let target: string;
    if (folder) {
      target = await this.uniqueTitlePath(dir, WorkspacePaths.baseName(source));
      await this.copyTree(source, target);
    } else {
      target = await this.uniquePath(dir, WorkspacePaths.nameOf(source));
      await copyFile(source, target);
    }
    this.emit("change");
    return target;
  }

  /** 批量：逐个处理，任一失败抛出但已完成的保留（UI 报错即可，不要回滚） */
  async moveNodes(paths: string[], targetDir: string): Promise<string[]> {
    const moved: string[] = [];
    for (const path of this.withoutNested(paths)) {
      moved.push(await this.moveNode(path, targetDir));
    }
    return moved;
  }

  async copyNodes(paths: string[], targetDir: string): Promise<string[]> {
    const copied: string[] = [];
    for (const path of this.withoutNested(paths)) {
      copied.push(await this.copyNode(path, targetDir));
    }
    return copied;
  }

  cutMany(paths: string[]): void {
    this.clipboard = { mode: "cut", paths: paths.map((path) => WorkspacePaths.normalize(path)) };
    this.emit("change");
  }

  copyMany(paths: string[]): void {
    this.clipboard = { mode: "copy", paths: paths.map((path) => WorkspacePaths.normalize(path)) };
    this.emit("change");
  }

  /** 到 targetDir；cut 走移动、copy 走复制；成功后清空剪贴板 */
  async paste(targetDir: string): Promise<string[]> {
    const clipboard = this.clipboard;
    if (!clipboard) return [];
    this.clipboard = null;
    const paths: string[] = [];
    for (const path of clipboard.paths) {
      // 剪贴板里的项可能已被外部删掉，先剔掉失效的，别让整批失败
      if (await exists(path)) paths.push(path);
    }
    if (paths.length === 0) {
      this.emit("change");
      return [];
    }
    const pasted =
      clipboard.mode === "cut" ? await this.moveNodes(paths, targetDir) : await this.copyNodes(paths, targetDir);
    this.emit("change");
    return pasted;
  }

  /** 将已落在目标目录的节点按拖放顺序一次性写入自定义排序。 */
  async reorderNodes(paths: string[], targetDir: string, beforeFileName?: string): Promise<void> {
    if (!paths.length) return;
    const root = this.requireRoot();
    const dir = WorkspacePaths.normalize(targetDir);
    const moved = new Set(paths.map(WorkspacePaths.baseName));
    if (beforeFileName !== undefined && moved.has(beforeFileName)) return;
    const order = await this.readOrder();
    const key = this.relativeTo(root, dir);
    const names = (order[key] ?? (await this.defaultOrderNames(dir))).filter((name) => !moved.has(name));
    const insertAt = beforeFileName ? names.indexOf(beforeFileName) : -1;
    names.splice(insertAt >= 0 ? insertAt : names.length, 0, ...moved);
    order[key] = names;
    await this.writeOrder(order);
    this.emit("change");
  }

  /** 同级内与上一项交换位置；已是同级第一项时抛错（UI 据此禁用） */
  async moveUp(path: string): Promise<void> {
    await this.swapSibling(path, -1);
  }

  /** 同级内与下一项交换位置；已是同级最后一项时抛错（UI 据此禁用） */
  async moveDown(path: string): Promise<void> {
    await this.swapSibling(path, 1);
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

  private async readDirNodes(
    dirPath: string,
    root: string,
    order: Record<string, string[]>,
    mode: WorkspaceSortMode,
  ): Promise<WorkspaceNode[]> {
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
      if (!isVisibleEntry(entry.name)) continue;
      const entryPath = WorkspacePaths.join(dirPath, entry.name);
      if (entry.isDirectory) {
        dirs.push({
          kind: "dir",
          name: entry.name,
          path: entryPath,
          children: await this.readDirNodes(entryPath, root, order, mode),
        });
      } else if (entry.isFile && isPagePath(entry.name)) {
        pages.push({ kind: "page", name: entry.name.slice(0, -4), path: entryPath });
      }
    }
    return await this.sortNodes([...dirs, ...pages], order[this.relativeTo(root, dirPath)], mode);
  }

  /**
   * 默认顺序：目录在前、各自 localeCompare 升序。
   * 该目录在 order.json 里有记录时严格按记录顺序，记录里没出现的项排到末尾按默认规则。
   * name / createdAt / modifiedAt 三种模式走用户选的排序，跟 order.json 无关（界面此时禁用拖拽）。
   */
  private async sortNodes(
    nodes: WorkspaceNode[],
    record: string[] | undefined,
    mode: WorkspaceSortMode,
  ): Promise<WorkspaceNode[]> {
    if (mode === "name") {
      return [...nodes].sort((left, right) => left.name.localeCompare(right.name));
    }
    if (mode === "createdAt" || mode === "modifiedAt") {
      return await this.sortNodesByTime(nodes, mode);
    }
    const fallback = [...nodes].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    if (!record || record.length === 0) return fallback;
    const rank = new Map<string, number>();
    for (const [index, name] of record.entries()) {
      const key = name.toLowerCase();
      if (!rank.has(key)) rank.set(key, index);
    }
    const rankOf = (node: WorkspaceNode) =>
      rank.get((node.kind === "page" ? `${node.name}.prg` : node.name).toLowerCase());
    const ordered = fallback
      .filter((node) => rankOf(node) !== undefined)
      .sort((left, right) => rankOf(left)! - rankOf(right)!);
    const rest = fallback.filter((node) => rankOf(node) === undefined);
    return [...ordered, ...rest];
  }

  /**
   * 时间排序：同级混排、最新的在前。目录和页面都要 stat 一次取时间，
   * 所以只有日期模式才付这份 IO；一项只 stat 一次。
   * stat 失败或平台不给时间（null）时按名字兜底，不能让一个坏项把整棵目录弄空。
   */
  private async sortNodesByTime(nodes: WorkspaceNode[], mode: "createdAt" | "modifiedAt"): Promise<WorkspaceNode[]> {
    const times = await Promise.all(nodes.map(async (node) => await readNodeTime(node.path, mode)));
    const entries = nodes.map((node, index) => ({ node, time: times[index] }));
    entries.sort((left, right) => {
      const byName = () => left.node.name.localeCompare(right.node.name);
      if (left.time === undefined) return right.time === undefined ? byName() : 1;
      if (right.time === undefined) return -1;
      return right.time - left.time || byName();
    });
    return entries.map((entry) => entry.node);
  }

  private readonly unreadableDirs = new Set<string>();

  private reportUnreadableDir(dirPath: string, error: unknown): void {
    if (this.unreadableDirs.has(dirPath)) return;
    this.unreadableDirs.add(dirPath);
    toast.error(i18next.t("workspace.dirUnreadable", { name: dirPath, defaultValue: String(error) }));
  }

  /** 工作空间里只有目录和 .prg 页面两类节点，stat 一次就能分辨 */
  private async isFolder(path: string): Promise<boolean> {
    // 节点已经被外部删掉时，让 fs 的原始错误往上抛，比编一条"根目录不存在"更准确
    return (await stat(path)).isDirectory;
  }

  /** 目录复制 = 递归复制整棵子树（子目录 + 里面的 .prg），隐藏项与 node_modules 之类照样跳过 */
  private async copyTree(sourceDir: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });
    for (const entry of await readDir(sourceDir)) {
      if (!isVisibleEntry(entry.name)) continue;
      const from = WorkspacePaths.join(sourceDir, entry.name);
      const to = WorkspacePaths.join(targetDir, entry.name);
      if (entry.isDirectory) {
        await this.copyTree(from, to);
      } else if (entry.isFile && entry.name.toLowerCase().endsWith(".prg")) {
        await copyFile(from, to);
      }
    }
  }

  /**
   * 选择集里同时含父子项时只处理父项：子项会跟着父项一起走，单独再处理一次只会报"找不到"。
   * 页面会连带搬走承载子页的同名目录，所以选中页面时那个目录也算被覆盖。
   */
  private withoutNested(paths: string[]): string[] {
    const unique = [...new Set(paths.map((path) => WorkspacePaths.normalize(path)))];
    const carried = new Set(unique.filter((path) => isPagePath(path)).map((path) => this.childDirOf(path)));
    return unique.filter(
      (path) => !carried.has(path) && !unique.some((other) => other !== path && WorkspacePaths.isInside(path, other)),
    );
  }

  /** order.json 是纯缓存：读不出来（不存在/JSON 坏了）就当没有自定义排序，不能让整棵树读不出来 */
  private async readOrder(): Promise<Record<string, string[]>> {
    const root = this.root;
    if (!root) return {};
    const file = WorkspacePaths.join(root, ORDER_FILE);
    if (!(await exists(file))) return {};
    const text = new TextDecoder().decode(await readFile(file));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const order: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      order[key] = value.filter((item): item is string => typeof item === "string");
    }
    return order;
  }

  private async writeOrder(order: Record<string, string[]>): Promise<void> {
    const root = this.root;
    if (!root) return;
    await mkdir(WorkspacePaths.join(root, ORDER_DIR), { recursive: true });
    const content = new TextEncoder().encode(JSON.stringify(order, null, 2));
    await writeFile(WorkspacePaths.join(root, ORDER_FILE), content);
  }

  /** 新建出来的项追加到该目录末尾；首次记录时先按当前显示顺序铺底，否则新项会插到所有项之前 */
  private async appendOrder(dirPath: string, fileName: string): Promise<void> {
    const root = this.root;
    if (!root) return;
    const order = await this.readOrder();
    const key = this.relativeTo(root, dirPath);
    const current = order[key] ?? (await this.defaultOrderNames(dirPath));
    order[key] = [...current.filter((name) => name !== fileName), fileName];
    await this.writeOrder(order);
  }

  /**
   * 同级内与相邻项交换（上移 = offset -1，下移 = +1）。
   * 目录和页面在同一个数组里，只换数组位置、不跨层级；越界直接抛错，让 UI 禁用并提示。
   */
  private async swapSibling(path: string, offset: -1 | 1): Promise<void> {
    const root = this.requireRoot();
    if (Settings.workspaceSortMode !== "custom") {
      throw new Error(i18next.t("workspace.sortLockedHint"));
    }
    const target = WorkspacePaths.normalize(path);
    const dir = WorkspacePaths.dirname(target);
    const fileName = WorkspacePaths.baseName(target);
    const key = this.relativeTo(root, dir);
    const order = await this.readOrder();
    const defaults = await this.defaultOrderNames(dir);
    const existing = new Set(defaults);
    // order 里可能存着已被删掉/改名的项，先跟磁盘现状对齐，否则会跟一个看不见的项交换、看起来没反应
    const names = (order[key] ?? defaults).filter((name) => existing.has(name));
    const seen = new Set(names);
    for (const name of defaults) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    const index = names.indexOf(fileName);
    const neighbor = index + offset;
    if (index < 0 || neighbor < 0 || neighbor >= names.length) {
      throw new Error(i18next.t("workspace.reorderFailed", { defaultValue: fileName }));
    }
    names[index] = names[neighbor];
    names[neighbor] = fileName;
    order[key] = names;
    await this.writeOrder(order);
    this.emit("change");
  }

  /** 删除/改名/移动后把 order 里对不上文件的陈旧项丢掉 */
  private async pruneOrder(dirPaths: string[]): Promise<void> {
    const root = this.root;
    if (!root) return;
    const order = await this.readOrder();
    let dirty = false;
    for (const dirPath of new Set(dirPaths)) {
      const key = this.relativeTo(root, dirPath);
      const names = order[key];
      if (!names) continue;
      const entries = (await exists(dirPath)) ? await readDir(dirPath) : [];
      const existing = new Set(entries.map((entry) => entry.name));
      const kept = names.filter((name) => existing.has(name));
      if (kept.length === names.length) continue;
      dirty = true;
      if (kept.length === 0) delete order[key];
      else order[key] = kept;
    }
    if (dirty) await this.writeOrder(order);
  }

  /** Preserve the current display order across a rename and update nested order keys. */
  private async updateOrderAfterRename(source: string, target: string): Promise<void> {
    const root = this.root;
    if (!root || Settings.workspaceSortMode !== "custom") return;

    const order = await this.readOrder();
    const parent = WorkspacePaths.dirname(source);
    const parentKey = this.relativeTo(root, parent);
    const oldName = WorkspacePaths.baseName(source);
    const newName = WorkspacePaths.baseName(target);
    const currentNames = await this.defaultOrderNames(parent);
    const normalizeName = (name: string) => name.toLowerCase();
    const oldNameKey = normalizeName(oldName);
    const newNameKey = normalizeName(newName);

    if (order[parentKey] && order[parentKey].length > 0) {
      const existing = new Set(currentNames.map(normalizeName));
      const names: string[] = [];
      const seen = new Set<string>();
      for (const name of order[parentKey]) {
        const renamed = normalizeName(name) === oldNameKey ? newName : name;
        const key = normalizeName(renamed);
        if (!existing.has(key) || seen.has(key)) continue;
        seen.add(key);
        names.push(renamed);
      }
      for (const name of currentNames) {
        const key = normalizeName(name);
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
      }
      order[parentKey] = names;
    } else {
      const namesBeforeRename = currentNames.map((name) =>
        normalizeName(name) === newNameKey ? oldName : name,
      );
      namesBeforeRename.sort((left, right) => {
        const leftIsDir = !isPagePath(left);
        const rightIsDir = !isPagePath(right);
        if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;
        return left.localeCompare(right);
      });
      order[parentKey] = namesBeforeRename.map((name) =>
        normalizeName(name) === oldNameKey ? newName : name,
      );
    }

    const sourcePrefix = isPagePath(source)
      ? this.relativeTo(root, this.childDirOf(source))
      : this.relativeTo(root, source);
    const targetPrefix = isPagePath(target)
      ? this.relativeTo(root, this.childDirOf(target))
      : this.relativeTo(root, target);
    if (sourcePrefix !== targetPrefix) {
      for (const [key, value] of Object.entries(order)) {
        if (key !== sourcePrefix && !key.startsWith(`${sourcePrefix}/`)) continue;
        const renamedKey = targetPrefix + key.slice(sourcePrefix.length);
        delete order[key];
        order[renamedKey] = value;
      }
    }

    await this.writeOrder(order);
  }

  /** 该目录的默认顺序：目录在前，各自 localeCompare 升序 */
  private async defaultOrderNames(dirPath: string): Promise<string[]> {
    if (!(await exists(dirPath))) return [];
    const listed = (await readDir(dirPath))
      .filter((entry) => isVisibleEntry(entry.name))
      .filter((entry) => entry.isDirectory || (entry.isFile && entry.name.toLowerCase().endsWith(".prg")))
      .map((entry) => ({ name: entry.name, isDir: entry.isDirectory }));
    listed.sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return listed.map((item) => item.name);
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
    return this.sanitizeFolderName(baseName);
  }

  private sanitizeFolderName(name: string): string {
    const baseName = name.trim();
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

  private async uniqueTitlePath(dirPath: string, name: string, extension = ""): Promise<string> {
    let candidate = WorkspacePaths.join(dirPath, `${name}${extension}`);
    let counter = 1;
    while (await exists(candidate)) {
      candidate = WorkspacePaths.join(dirPath, `${name}（${counter}）${extension}`);
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
    if (!root) {
      this.stopWatching();
      return;
    }
    if (this.watchingRoot === root && (this.unwatch || this.watchTask || this.watchUnavailableRoot === root)) {
      await this.watchTask;
      return;
    }
    this.stopWatching();
    this.watchingRoot = root;
    this.watchUnavailableRoot = undefined;

    const task = (async () => {
      try {
        const unwatch = await watch(root, () => this.scheduleChangeEmit(), { recursive: true, delayMs: 500 });
        if (this.watchingRoot !== root) {
          unwatch();
          return;
        }
        this.unwatch = unwatch;
      } catch (error) {
        if (this.watchingRoot === root) {
          this.watchUnavailableRoot = root;
        }
        toast.error(i18next.t("workspace.watchUnavailable", { defaultValue: String(error) }));
      }
    })();
    this.watchTask = task;
    await task;
    if (this.watchTask === task) this.watchTask = undefined;
  }

  private stopWatching(): void {
    this.watchingRoot = undefined;
    this.watchUnavailableRoot = undefined;
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

function isPagePath(path: string): boolean {
  return path.toLowerCase().endsWith(".prg");
}

function isVisibleEntry(name: string): boolean {
  return !name.startsWith(IGNORED_PREFIX) && !IGNORED_DIR_NAMES.has(name);
}

/**
 * 取节点时间（毫秒）。日期排序下每个目录项都要 stat 一次，这属于常态开销；
 * 拿不到时间（刚被外部删掉、平台不提供 birthtime）时返回 undefined 让调用方按名字兜底，
 * 一个坏项不该把整棵目录树变成空的。
 */
async function readNodeTime(path: string, mode: "createdAt" | "modifiedAt"): Promise<number | undefined> {
  try {
    const info = await stat(path);
    const time = mode === "createdAt" ? info.birthtime : info.mtime;
    return time ? time.getTime() : undefined;
  } catch {
    return undefined;
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
