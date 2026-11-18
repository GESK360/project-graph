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

---

# 追加契约（2026-11-18 第二轮迭代）

## A. 取消降级/升级子页

删掉 `demotePage` / `promotePage`（Manager）、`demoteWorkspacePage` / `promoteWorkspacePage`（PageOps）、以及树里的两个菜单项。
i18n 键保留（不引用了也不报错）。**不要**保留半死代码。

## B. 文件夹成为一等公民

```ts
export type WorkspaceClipboard = { mode: "cut" | "copy"; paths: string[] };

/** dirPath 下新建空目录；name 省略时用 "新建文件夹"，重名依次 "新建文件夹（1）"、"（2）"…… */
async createFolder(dirPath: string, name?: string): Promise<string>;
async renameFolder(path: string, newName: string): Promise<string>;
/** 递归删除整棵目录；UI 必须二次确认 */
async deleteFolder(path: string): Promise<void>;

/** 通用：内部按 exists/readDir 判断是目录还是页面 */
async renameNode(path: string, newName: string): Promise<string>;
async moveNode(path: string, targetDir: string): Promise<string>;
async copyNode(path: string, targetDir: string): Promise<string>;

/** 批量：逐个处理，任一失败抛出但已完成的保留（UI 报错即可，不要回滚） */
async moveNodes(paths: string[], targetDir: string): Promise<string[]>;
async copyNodes(paths: string[], targetDir: string): Promise<string[]>;

/** 多选剪贴板 */
cutMany(paths: string[]): void;
copyMany(paths: string[]): void;
/** 返回落成的新路径数组；paste 后清空剪贴板 */
async paste(targetDir: string): Promise<string[]>;
```

规则：

- 目录复制 = 递归复制（含子目录与其中的 `.prg`）；目录移动 = 直接 rename。
- 移动/复制时若目标已存在同名项，按 `uniquePath` 规则加 ` (2)`——**注意**：文件夹的重名后缀用中文全角括号 `（1）`，页面沿用半角 ` (2)`，保持与用户描述一致。
- 禁止把目录移进自己的子树（`isInside` 检查），抛错。

## C. 自定义排序（拖拽"调整位置"）

排序文件：`<root>/.flux-graph/order.json`

```json
{ "": ["a.prg", "笔记", "b.prg"], "笔记": ["x.prg"] }
```

- key 是相对根目录的目录路径（`""` = 根），value 是该目录下**文件名数组**（含扩展名，目录名就是目录名）。
- `readTree` 排序：如果某目录在 order 里有记录 → 严格按数组顺序（目录与页面混排，数组里没出现的项排在末尾按默认规则）；没有记录 → 目录在前、各自 `localeCompare` 升序（保持旧行为）。
- 写入时机：拖拽落点、`createFolder`/`createPage`（追加到末尾）。删除/改名/移动后要顺手清理 order 里的陈旧项（找不到对应文件的项丢掉）。

```ts
/** 把 path 移到 targetDir，并排在 beforeFileName 之前（省略 = 该目录末尾）。beforeFileName 用文件名，如 "a.prg" */
async reorderNode(path: string, targetDir: string, beforeFileName?: string): Promise<void>;
```

## D. 界面：多选 + 拖拽 + 文件夹菜单

树行状态：

- `selectedPaths: ReadonlySet<string>`，`anchorPath?: string`（shift 锚点）
- **单击**：选中该项（清空其它），并打开页面（仅当点的是页面）
- **Ctrl+单击**：切换该项的选中状态（不改变锚点以外的行为）；点页面时仍然打开页面
- **Shift+单击**：选中「锚点 ↔ 当前项」在**当前可见扁平顺序**里的整段（目录与页面都算），不打开页面
- 选中多行时右键任意选中行，菜单作用于整个选择集；右键未选中行则先把它变为唯一选中

文件夹右键菜单：重命名、删除、剪切、复制、粘贴、移动或复制…、新建页面、新建文件夹
页面右键菜单：重命名、删除、剪切、复制、粘贴、复制指向页面的链接、移动或复制…、新建页面、新建文件夹、显示页面版本
空白右键：新建页面、新建文件夹、粘贴、刷新、关闭工作空间

顶部一行按钮顺序：**工作空间名 → 刷新 → 新建文件夹 → 新建页面 → 在资源管理器中显示**

## E. 拖拽

- 页面行与目录行都 `draggable`；`dataTransfer` 里放被拖的路径集合（拖已选中行 → 整个选择集，否则单行）。
- 拖动中在落点画指示：落在**目录行中段** → 高亮整行（表示"放进去"，追加到该目录末尾）；落在**页面/目录行的上 1/2** → 画一条上边线（排它前面）；**下 1/2** → 下边线（排它后面）；落在**空白** → 高亮根区域，追加到根末尾。
- 放下时：先 `moveNodes` 到目标目录，再用 `reorderNode` 记录落点顺序（"放进去"不需要 reorder）。
- 禁止把目录拖进自己的子树：UI 层先判断并给 toast，不要等 Manager 抛。
- 拖动过程中不要触发行点击（点击选中与拖拽要能共存：`onClick` 里判断本次是否发生过 drag）。

## F. i18n 新增键（Lead 负责写入）

`workspace.newFolderName`（"新建文件夹"）、`workspace.createFolder`（新建文件夹）、`workspace.folderCreated`、`workspace.deleteFolderTitle`、`workspace.deleteFolderBody`、`workspace.dragInvalidTarget`、`workspace.selectedCount`（"已选 {{count}} 项"）、`workspace.moveMany`、`workspace.copyMany`、`workspace.deleteManyTitle`、`workspace.deleteManyBody`

---

# 追加契约（2026-11-18 第三轮）

## 0. 背景：HTML5 拖拽在本项目不可用（已证实）

`app/src-tauri/src/custom_drag_drop.rs` 在 Windows 上用 `RegisterDragDrop(hwnd, …)` 接管了**整个窗口的 OLE 拖放**（这是"从资源管理器拖 .prg 进画布"依赖的通道）。WebView2 的 HTML5 `draggable` / `dragstart` 因此在应用内完全不触发——这就是"鼠标拖动没有生效"的根因。

**结论**：树内拖拽一律改用 **pointer 事件自研**，不要再用 `draggable` / `dataTransfer`，也不要改动 `custom_drag_drop.rs`（动了就废掉外部拖文件进画布）。

## G. Pointer 拖拽（替代 HTML5 拖拽）

- 行元素上 `onPointerDown`：记录 `{ path, startX, startY, pointerId }`，**不要** preventDefault（要保持点击能力）。
- 在 `window` 上挂 `pointermove` / `pointerup`（按下时挂、松手时摘；组件卸载也要摘）。
- 位移超过 **4px** 才进入"拖拽中"状态；在此之前松手 = 普通点击（保留现有的单击/Ctrl/Shift 语义）。
- 进入拖拽后：
  - 给 `document.body` 加 `cursor: grabbing`，拖拽层渲染一个跟随鼠标的幽灵标签（被拖的项名 / "N 项"）。
  - 用 `document.elementFromPoint(x, y)` 找最近的 `[data-pg-workspace-row]`（行元素上带该属性 + `data-pg-workspace-path`），算落点；找不到行 = 落在空白 → `{ type: "root" }`。
  - 落点规则保持不变：目录行**中段**（上下各 25% 之外的中间区域）→ `drop`；行的**上 1/4** → `before`；**下 1/4** → `after`；空白 → `root`。
  - 落点用和现在一样的视觉：整行高亮 / 上边线 / 下边线 / 根区高亮。
- `pointerup`：若在拖拽中则执行 drop，并**吃掉紧随其后的 click**（用 `Date.now()` 时间戳窗口，200ms 足够）；否则按普通点击处理。
- 拖拽中 `event.preventDefault()` 防止选中文本；松手后恢复正常。

## H. 排序模式（顶部下拉按钮）

设置项（Lead 写入 Settings.tsx）：

```ts
workspaceSortMode: z.union([
  z.literal("custom"),
  z.literal("name"),
  z.literal("createdAt"),
  z.literal("modifiedAt"),
]).default("custom");
```

- `custom`：用户自定义顺序（`order.json`），即截图里的「无」。
- `name`：同级**混排**按 `localeCompare` 升序（目录和页面混在一起排，跟 Obsidian 一致）。
- `createdAt` / `modifiedAt`：同级混排按时间**降序**（最新的在前）。目录的时间取目录自身的 `stat`；`stat` 拿不到时间（null）时按名字兜底。
- 非 `custom` 模式下：**禁用**拖拽排序与上移/下移（UI 置灰 + tooltip 提示「切换到『无』才能手动排序」）。

界面：文件树顶部一行，在工作空间名右侧加一个"排序"下拉按钮（图标 `ArrowUpDown`），菜单四项（Radio 样式，当前项打勾）：

```
无(N)            按字母顺序(A)        创建日期(C)        修改日期(M)
```

## I. 上移 / 下移（右键菜单）

```ts
/** 同级内与相邻项交换位置；与首/末项交换时抛错（UI 据此禁用） */
async moveUp(path: string): Promise<void>;
async moveDown(path: string): Promise<void>;
```

- 只在 `workspaceSortMode === "custom"` 下允许；内部若发现不是 custom，直接抛错。
- 顺序数组取 `order[key] ?? defaultOrderNames(dir)`，把自身与上一个/下一个**同级项**交换后写回。目录与页面在同一个数组里，**不跨级**。
- 已是同级第一项时 `moveUp` 不可用，最后一项时 `moveDown` 不可用（UI 置灰）。

## J. 需要 Lead 写入的 i18n 键

`workspace.sortBy`（排序）、`workspace.sortCustom`（无）、`workspace.sortName`（按字母顺序）、`workspace.sortCreatedAt`（创建日期）、`workspace.sortModifiedAt`（修改日期）、`workspace.moveUp`（上移）、`workspace.moveDown`（下移）、`workspace.sortLockedHint`（切换到「无」才能手动排序）、`workspace.dragHint`（拖动排序 / 放入文件夹）
