# 工作空间文件树（Workspace Explorer）实现契约

> 本文是实现契约，不是产品文案。所有签名、键名、文件名以此为准；实现方不得擅自改签名。
> 目标：像 Obsidian 一样在左侧常驻一个工作空间文件树，树的每个节点对应工作空间目录里的真实 `.prg` 文件，增删改移与磁盘一一对应；切换页面时自动保存。

## 1. 概念模型

- **工作空间** = 用户选定的一个本地目录（`Settings.activeWorkspaceRoot`）。`Settings.workspaceRoots` 记录历史打开的根目录。
- **页面** = 工作空间内一个 `.prg` 文件。节点名 = 去掉 `.prg` 的文件名。
- **父子关系 = 目录层级**：`A/A.prg` 与 `A/` 目录并列时，`A/A.prg` 是父页面，`A/` 下的页面是它的子页。
- 只显示目录与 `.prg` 文件；忽略以 `.` 开头的目录/文件（`.flux-graph`、`.git` 等）与 `node_modules`。
- 排序：目录在前、文件在后，各自按 `localeCompare`（中文拼音）升序。

## 2. 文件清单（写权限边界）

| 范围       | 归属   | 允许改动的文件                                                                                                                                                                                  |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 核心逻辑   | 队友 A | `app/src/core/service/workspace/**`（新目录）                                                                                                                                                   |
| 界面       | 队友 B | `app/src/sub/WorkspaceWindow.tsx`、`app/src/components/workspace/**`（新目录）                                                                                                                  |
| 底座与接线 | Lead   | `Settings.tsx`、`SettingsIcons.tsx`、`sub/SettingsWindow/settings.tsx`、`subWindowOpenModes.ts`、`shortcutKeysRegister.tsx`、`locales/*.yml`、`capabilities/default.json`、`DeepLinkHandler.ts` |

任何人不得改动上表之外的文件；发现必须改，先告知 Lead。

## 3. 核心 API（`app/src/core/service/workspace/WorkspaceManager.ts`）

```ts
export type WorkspaceNode =
  | { kind: "dir"; name: string; path: string; children: WorkspaceNode[] }
  | { kind: "page"; name: string; path: string }; // name 不含 .prg

export type WorkspaceClipboard = { mode: "cut" | "copy"; path: string; name: string };

export class WorkspaceManagerClass {
  /** 当前根目录；未打开时为 undefined */
  get root(): string | undefined;
  /** dir 省略时弹目录选择框；成功后写 Settings.workspaceRoots / activeWorkspaceRoot，emit "root-change" */
  async openWorkspace(dir?: string): Promise<void>;
  async closeWorkspace(): Promise<void>;
  /** 读根目录一级节点（递归到子目录） */
  async readTree(): Promise<WorkspaceNode[]>;
  /** 新建空 .prg：PROJECT.newDraft() → uri → init → save；重名自动加 " (2)"；返回新路径 */
  async createPage(dirPath: string, name: string): Promise<string>;
  async deletePage(path: string): Promise<void>;
  /** 返回新路径；非法字符与重名按 createPage 规则处理 */
  async renamePage(path: string, newName: string): Promise<string>;
  async movePage(path: string, targetDir: string): Promise<string>;
  async copyPage(path: string, targetDir: string): Promise<string>;
  /** 降级：移到"同级前一个页面 P"对应的目录 `<dir>/P/`；没有前一个页面时抛错（UI 据此禁用） */
  async demotePage(path: string): Promise<string>;
  /** 升级：从 `<dir>/P/` 移回 `<dir>/`；已在根层时抛错 */
  async promotePage(path: string): Promise<string>;
  clipboard: WorkspaceClipboard | null;
  cut(path: string): void;
  copy(path: string): void;
  /** 到 targetDir；cut 走移动、copy 走复制；成功后清空剪贴板 */
  async paste(targetDir: string): Promise<string | null>;
  /** 写历史快照：`<root>/.flux-graph/history/<相对目录>/<页面名>/<yyyyMMdd-HHmmss>.prg`，同页 30s 内不重复、每页保留 20 份 */
  async snapshotPage(path: string): Promise<void>;
  async listVersions(path: string): Promise<{ id: string; time: number; filePath: string }[]>;
  /** 用某个快照覆盖当前页面文件（覆盖前先 snapshotPage 保底） */
  async restoreVersion(path: string, versionId: string): Promise<void>;

  on(event: "change" | "root-change", listener: () => void): void;
  off(event: "change" | "root-change", listener: () => void): void;
  /** 自身操作后 emit("change")；同时监听根目录 fs 变化（fs:allow-watch）后 emit */
}
export const WorkspaceManager = new WorkspaceManagerClass();
```

约定：

- 所有路径一律用正斜杠归一化后传给 `fs` 插件（`@tauri-apps/plugin-fs`：`readDir`、`remove`、`rename`、`copyFile`、`mkdir`、`exists`、`readFile`、`writeFile`）。
- 非法文件名：`[\\/:*?"<>|]` 直接抛 `new Error("文件名不能包含以下字符")`，由 UI 用 toast 显示。
- 所有失败向上抛原始 Error，不吞异常（遵守 AGENTS.md 错误处理约定）。

## 4. 页面操作与标签页联动（`app/src/core/service/workspace/WorkspacePageOps.ts`）

导出后可被 UI 调用：

```ts
/** 打开/聚焦页面；内部调 onOpenFile(URI.file(path), "工作空间文件树") */
export async function openWorkspacePage(path: string): Promise<void>;
/** 删除：若该文件已打开 → TabWorkspace.close；确认框由 UI 负责 */
export async function deleteWorkspacePage(path: string): Promise<void>;
/** 重命名：若已打开 → save → close → rename → 重新打开新路径；返回新路径 */
export async function renameWorkspacePage(path: string, newName: string): Promise<string>;
export async function moveWorkspacePage(path: string, targetDir: string): Promise<string>;
export async function copyWorkspacePage(path: string, targetDir: string): Promise<string>;
export async function demoteWorkspacePage(path: string): Promise<string>;
export async function promoteWorkspacePage(path: string): Promise<string>;
/** 打开指定快照：作为草稿副本打开（不覆盖原文件） */
export async function openVersionAsCopy(versionFilePath: string): Promise<void>;
```

移动/重命名已打开的工程必须先 `save()` 再 `close()`，避免 ownership 锁与新路径冲突。

## 5. 切换自动保存（`app/src/core/service/workspace/AutoSaveOnSwitch.ts`）

```ts
export const AutoSaveOnSwitch = {
  /** 幂等；在 main.tsx 启动阶段调用一次 */
  install(): void,
};
```

行为：订阅 `activeResourceTabAtom`（jotai `store.sub`）；当活跃资源从 Project A 切到其它 Project B 时，若 `Settings.autoSaveOnSwitch` 为真、A 非 draft/collab 且 `projectState === Unsaved`，则串行执行 `A.save({ includeThumbnail: false })`，随后 `WorkspaceManager.snapshotPage(A.uri.fsPath)`（若启用了 `Settings.workspaceVersionHistory`）。保存失败用 `toast.error` 报出，不阻断切换。

## 6. 界面契约（`app/src/sub/WorkspaceWindow.tsx`）

- `WorkspaceWindow.open()` 通过 `createSubWindow("WorkspaceWindow", {...})` 打开，`contextTarget: "activeResourceTab"`。
- 未打开工作空间时：居中提示 + "打开文件夹"按钮。
- 已打开时：顶部一行（工作空间名、刷新、新建页面、在资源管理器中显示）；下方树。
- 树行为：单击页面 = `openWorkspacePage`；单击目录 = 折叠/展开；当前打开的文件高亮（对比 `activeResourceTabAtom` 的 `uri.fsPath`）。
- 折叠状态存 localStorage：`workspace:collapsed:<root>` → `string[]`。
- 右键菜单（顺序固定）：重命名、删除、剪切、复制、粘贴、复制指向页面的链接、移动或复制…、新建页面、降级子页、升级子页、折叠子页、显示页面版本。
- 禁用规则：粘贴（剪贴板空）、降级（无同级前一页面）、升级（已在根层）、显示页面版本（无快照）。
- 空白处右键：新建页面、粘贴、刷新、关闭工作空间。
- "移动或复制…"：Dialog 内列出工作空间所有目录（含"新建文件夹…"），并有"移动/复制"单选。
- "显示页面版本"：列出快照（时间倒序），每项可"恢复"或"作为副本打开"。

## 7. 设置项（Lead 写入 Settings.tsx，UI 只读）

| 键                        | 类型                                 | 默认   | 说明             |
| ------------------------- | ------------------------------------ | ------ | ---------------- |
| `workspaceRoots`          | `z.array(z.string())`                | `[]`   | 打开过的工作空间 |
| `activeWorkspaceRoot`     | `z.string()`                         | `""`   | 当前工作空间     |
| `autoSaveOnSwitch`        | `z.boolean()`                        | `true` | 切换页面自动保存 |
| `workspaceVersionHistory` | `z.boolean()`                        | `true` | 保存历史快照     |
| `workspacePanelWidth`     | `z.number().int().min(140).max(600)` | `240`  | 面板宽度提示值   |

## 8. i18n 键（Lead 写入 locales；UI 直接使用）

顶层新增 `workspace:`，键：

```
workspace.title / openFolder / emptyHint / newPage / rename / delete / cut / copy / paste
workspace.copyLink / moveOrCopy / demote / promote / collapse / showVersions
workspace.refresh / revealInExplorer / closeWorkspace / move / copyMode / targetFolder
workspace.newFolder / confirm / cancel / unnamedPage / deleteConfirmTitle / deleteConfirmBody
workspace.versionsEmpty / restore / openAsCopy / versionRestored / linkCopied / pageCreated
workspace.nameRequired / invalidName / rootMissing / notAWorkspace
```

`keyBinds` 下新增：`openWorkspace.title`、`closeWorkspace.title`、`toggleWorkspacePanel.title`。
`settings` 下新增：`autoSaveOnSwitch.{title,description}`、`workspaceVersionHistory.{title,description}`、`activeWorkspaceRoot.{title,description}`。

## 9. 验收

- `pnpm --filter @graphif/project-graph type-check` 零报错（唯一验证手段，禁止 build）。
- 手工验收清单写在 PR 描述里：打开工作空间 → 新建页面 → 树出现 → 编辑 → 切到另一个页面 → 前一个文件 mtime 更新 → 重命名/删除/剪切粘贴/降级升级 → 链接可点开。
