import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { WorkspaceClipboard, WorkspaceNode } from "@/core/service/workspace/WorkspaceManager";
import { cn } from "@/utils/cn";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ClipboardPaste,
  Copy,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  History,
  Link2,
  Pencil,
  RefreshCcw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceFlatRow } from "./workspaceFlat";
import { fileNameOf } from "./workspaceFlat";
import { isSameWorkspacePath } from "./workspacePath";

export type WorkspacePageNode = Extract<WorkspaceNode, { kind: "page" }>;
export type WorkspaceDirNode = Extract<WorkspaceNode, { kind: "dir" }>;

/** drop = 放进该目录（目录行中段）；before/after = 排到该行前/后；root = 排到根末尾 */
export type WorkspaceDropTarget =
  | { type: "drop"; path: string }
  | { type: "before"; path: string; dirPath: string; beforeFileName?: string }
  | { type: "after"; path: string; dirPath: string; beforeFileName?: string }
  | { type: "root" };

export interface WorkspaceRowClick {
  path: string;
  ctrlKey: boolean;
  shiftKey: boolean;
}

export interface WorkspaceTreeActions {
  openPage: (node: WorkspacePageNode) => void;
  toggleDir: (node: WorkspaceDirNode) => void;
  clickRow: (click: WorkspaceRowClick) => void;
  /** 右键某行时先确保它被选中，菜单才会作用在它（或它所在的选择集）上 */
  contextRow: (path: string) => void;
  newPage: (dirPath: string) => void;
  newFolder: (dirPath: string) => void;
  renameNode: (node: WorkspaceNode) => void;
  deleteNode: (node: WorkspaceNode) => void;
  cutNode: (node: WorkspaceNode) => void;
  copyNode: (node: WorkspaceNode) => void;
  paste: (targetDir: string) => void;
  copyLink: (node: WorkspacePageNode) => void;
  moveOrCopy: (node: WorkspaceNode) => void;
  collapseDir: (dirPath: string) => void;
  showVersions: (node: WorkspacePageNode) => void;
  /** 打开菜单时补一次快照计数：自动保存写快照不会触发 change 事件 */
  refreshVersions: (path: string) => void;
  refresh: () => void;
  closeWorkspace: () => void;
  dragStart: (paths: string[]) => void;
  dragEnd: () => void;
  /** 传 null 表示当前没有落点（拖到行外/取消拖拽） */
  dragOver: (target: WorkspaceDropTarget | null) => void;
  drop: (target: WorkspaceDropTarget, paths: string[]) => void;
  /** 拖拽落点后浏览器会补一次 click，用它挡掉"拖完顺手打开页面" */
  shouldIgnoreClick: () => boolean;
}

interface TreeState {
  root: string;
  collapsedDirs: ReadonlySet<string>;
  activeFsPath: string | undefined;
  clipboard: WorkspaceClipboard | null;
  versionCounts: ReadonlyMap<string, number>;
  selectedPaths: ReadonlySet<string>;
  dropTarget: WorkspaceDropTarget | null;
  actions: WorkspaceTreeActions;
}

export interface WorkspaceTreeProps extends TreeState {
  nodes: WorkspaceNode[];
  rows: WorkspaceFlatRow[];
}

const INDENT = 12;

/** 折叠子页折叠的是与页面同名的那一级目录（A/A.prg 与 A/ 并列的约定） */
function findChildrenDir(nodes: WorkspaceNode[], name: string) {
  return nodes.find((node): node is WorkspaceDirNode => node.kind === "dir" && node.name === name);
}

/** 右键落在多选集合内的行时，菜单作用于整个选择集 */
function isBatchSelection(selectedPaths: ReadonlySet<string>, path: string) {
  return selectedPaths.size > 1 && selectedPaths.has(path);
}

function isCutPath(clipboard: WorkspaceClipboard | null, path: string) {
  return clipboard?.mode === "cut" && clipboard.paths.some((item) => isSameWorkspacePath(item, path));
}

function readDraggedPaths(event: DragEvent): string[] {
  const raw = event.dataTransfer.getData("text/plain");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** 落点指示：目录行中段整行高亮表示"放进去"，上下半段画边线表示"排到前/后" */
function rowDropClass(dropTarget: WorkspaceDropTarget | null, path: string) {
  if (!dropTarget) return undefined;
  if (dropTarget.type === "drop" && isSameWorkspacePath(dropTarget.path, path)) {
    return "bg-accent/60 ring-primary ring-1 ring-inset";
  }
  if ((dropTarget.type === "before" || dropTarget.type === "after") && isSameWorkspacePath(dropTarget.path, path)) {
    return dropTarget.type === "before"
      ? "relative before:bg-primary before:absolute before:inset-x-0 before:top-0 before:h-0.5"
      : "relative after:bg-primary after:absolute after:inset-x-0 after:bottom-0 after:h-0.5";
  }
  return undefined;
}

/** 光标在行的上下半段：上半排前、下半排后；目录行中段表示放进去 */
function dropTargetForRow(event: DragEvent<HTMLButtonElement>, row: WorkspaceFlatRow): WorkspaceDropTarget {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
  if (row.node.kind === "dir" && ratio > 1 / 3 && ratio < 2 / 3) {
    return { type: "drop", path: row.node.path };
  }
  if (ratio < 0.5) {
    return { type: "before", path: row.node.path, dirPath: row.dirPath, beforeFileName: fileNameOf(row.node) };
  }
  const next = row.siblings[row.indexInSiblings + 1];
  return {
    type: "after",
    path: row.node.path,
    dirPath: row.dirPath,
    beforeFileName: next ? fileNameOf(next) : undefined,
  };
}

function writeDragData(
  event: DragEvent<HTMLButtonElement>,
  path: string,
  selectedPaths: ReadonlySet<string>,
  actions: WorkspaceTreeActions,
) {
  // 拖已选中的行 = 拖整个选择集；拖未选中的行 = 只拖它自己
  const paths = selectedPaths.has(path) ? [...selectedPaths] : [path];
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", JSON.stringify(paths));
  actions.dragStart(paths);
}

function handleDragOver(event: DragEvent, target: WorkspaceDropTarget, actions: WorkspaceTreeActions) {
  // 不 preventDefault 浏览器就不认这里是合法落点，drop 也不会触发
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "move";
  actions.dragOver(target);
}

/** 光标离开这一行（且没进它的子元素）时清掉落点，不然行高亮会留在上一次经过的行上 */
function handleDragLeave(event: DragEvent<HTMLButtonElement>, actions: WorkspaceTreeActions) {
  const next = event.relatedTarget;
  if (next instanceof Node && event.currentTarget.contains(next)) return;
  actions.dragOver(null);
}

function handleDrop(event: DragEvent, target: WorkspaceDropTarget, actions: WorkspaceTreeActions) {
  event.preventDefault();
  event.stopPropagation();
  const paths = readDraggedPaths(event);
  if (paths.length === 0) return;
  actions.drop(target, paths);
}

function toRowClick(path: string, event: ReactMouseEvent): WorkspaceRowClick {
  return { path, ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey };
}

export default function WorkspaceTree({ nodes, rows, actions, ...state }: WorkspaceTreeProps) {
  const { t } = useTranslation("workspace");
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="flex min-h-full min-w-full flex-col pb-2"
          onDragOver={(event) => handleDragOver(event, { type: "root" }, actions)}
          onDrop={(event) => handleDrop(event, { type: "root" }, actions)}
        >
          {rows.length === 0 && nodes.length === 0 && (
            <div className="text-muted-foreground px-3 py-6 text-center text-xs leading-relaxed">{t("emptyHint")}</div>
          )}
          {rows.map((row) =>
            row.node.kind === "dir" ? (
              <DirRow key={row.node.path} row={row} {...state} actions={actions} />
            ) : (
              <PageRow key={row.node.path} row={row} {...state} actions={actions} />
            ),
          )}
          <RootDropZone active={state.dropTarget?.type === "root"} actions={actions} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.newPage(state.root)}>
          <FilePlus />
          {t("newPage")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.newFolder(state.root)}>
          <FolderPlus />
          {t("createFolder")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!state.clipboard} onSelect={() => actions.paste(state.root)}>
          <ClipboardPaste />
          {t("paste")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.refresh()}>
          <RefreshCcw />
          {t("refresh")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => actions.closeWorkspace()}>
          <X />
          {t("closeWorkspace")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function DirRow({ row, actions, ...state }: TreeState & { row: WorkspaceFlatRow; actions: WorkspaceTreeActions }) {
  const { t } = useTranslation("workspace");
  const node = row.node as WorkspaceDirNode;
  const collapsed = state.collapsedDirs.has(node.path);
  const isSelected = state.selectedPaths.has(node.path);
  const batch = isBatchSelection(state.selectedPaths, node.path);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          draggable
          style={{ paddingLeft: 4 + row.depth * INDENT }}
          className={cn(
            "hover:bg-accent/50 flex h-6 w-full items-center gap-1 rounded-sm pr-2 text-left text-xs",
            isSelected && "bg-accent/60 text-accent-foreground",
            isCutPath(state.clipboard, node.path) && "opacity-50",
            rowDropClass(state.dropTarget, node.path),
          )}
          onClick={(event) => {
            if (actions.shouldIgnoreClick()) return;
            const click = toRowClick(node.path, event);
            actions.clickRow(click);
            // 只有普通单击才折叠/展开；Ctrl 和 Shift 是选行，不该顺手改结构
            if (!click.shiftKey && !click.ctrlKey) actions.toggleDir(node);
          }}
          onContextMenu={(event) => {
            event.stopPropagation();
            actions.contextRow(node.path);
          }}
          onDragStart={(event) => {
            event.stopPropagation();
            writeDragData(event, node.path, state.selectedPaths, actions);
          }}
          onDragEnd={() => actions.dragEnd()}
          onDragOver={(event) => handleDragOver(event, dropTargetForRow(event, row), actions)}
          onDragLeave={(event) => handleDragLeave(event, actions)}
          onDrop={(event) => handleDrop(event, dropTargetForRow(event, row), actions)}
        >
          {collapsed ? (
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <Folder className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={batch} onSelect={() => actions.renameNode(node)}>
          <Pencil />
          {t("rename")}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => actions.deleteNode(node)}>
          <Trash2 />
          {t("delete")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.cutNode(node)}>
          <Scissors />
          {t("cut")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.copyNode(node)}>
          <Copy />
          {t("copy")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!state.clipboard} onSelect={() => actions.paste(node.path)}>
          <ClipboardPaste />
          {t("paste")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.moveOrCopy(node)}>
          <FolderInput />
          {t("moveOrCopy")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.newPage(node.path)}>
          <FilePlus />
          {t("newPage")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.newFolder(node.path)}>
          <FolderPlus />
          {t("createFolder")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function PageRow({ row, actions, ...state }: TreeState & { row: WorkspaceFlatRow; actions: WorkspaceTreeActions }) {
  const { t } = useTranslation("workspace");
  const node = row.node as WorkspacePageNode;
  const isActive = state.activeFsPath !== undefined && isSameWorkspacePath(node.path, state.activeFsPath);
  const isSelected = state.selectedPaths.has(node.path);
  const childrenDir = findChildrenDir(row.siblings, node.name);
  const batch = isBatchSelection(state.selectedPaths, node.path);
  return (
    <ContextMenu onOpenChange={(open) => open && actions.refreshVersions(node.path)}>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          draggable
          style={{ paddingLeft: 4 + row.depth * INDENT + 18 }}
          className={cn(
            "hover:bg-accent/50 flex h-6 w-full items-center gap-1.5 rounded-sm pr-2 text-left text-xs",
            isActive && "bg-accent/60 text-accent-foreground",
            isSelected && !isActive && "bg-accent/60",
            isCutPath(state.clipboard, node.path) && "opacity-50",
            rowDropClass(state.dropTarget, node.path),
          )}
          onClick={(event) => {
            if (actions.shouldIgnoreClick()) return;
            const click = toRowClick(node.path, event);
            actions.clickRow(click);
            if (!click.shiftKey) actions.openPage(node);
          }}
          onContextMenu={(event) => {
            event.stopPropagation();
            actions.contextRow(node.path);
          }}
          onDragStart={(event) => {
            event.stopPropagation();
            writeDragData(event, node.path, state.selectedPaths, actions);
          }}
          onDragEnd={() => actions.dragEnd()}
          onDragOver={(event) => handleDragOver(event, dropTargetForRow(event, row), actions)}
          onDragLeave={(event) => handleDragLeave(event, actions)}
          onDrop={(event) => handleDrop(event, dropTargetForRow(event, row), actions)}
        >
          <FileText className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
          {childrenDir && (
            <ChevronDown
              className={cn(
                "text-muted-foreground/60 ml-auto size-3 shrink-0",
                state.collapsedDirs.has(childrenDir.path) && "-rotate-90",
              )}
            />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={batch} onSelect={() => actions.renameNode(node)}>
          <Pencil />
          {t("rename")}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => actions.deleteNode(node)}>
          <Trash2 />
          {t("delete")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.cutNode(node)}>
          <Scissors />
          {t("cut")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.copyNode(node)}>
          <Copy />
          {t("copy")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!state.clipboard} onSelect={() => actions.paste(row.dirPath)}>
          <ClipboardPaste />
          {t("paste")}
        </ContextMenuItem>
        <ContextMenuItem disabled={batch} onSelect={() => actions.copyLink(node)}>
          <Link2 />
          {t("copyLink")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.moveOrCopy(node)}>
          <FolderInput />
          {t("moveOrCopy")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.newPage(row.dirPath)}>
          <FilePlus />
          {t("newPage")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.newFolder(row.dirPath)}>
          <FolderPlus />
          {t("createFolder")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!childrenDir} onSelect={() => childrenDir && actions.collapseDir(childrenDir.path)}>
          <ChevronsDownUp />
          {t("collapse")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={(state.versionCounts.get(node.path) ?? 0) === 0}
          onSelect={() => actions.showVersions(node)}
        >
          <History />
          {t("showVersions")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 树下方留白：落在这里 = 排到根末尾 */
function RootDropZone({ active, actions }: { active: boolean; actions: WorkspaceTreeActions }) {
  return (
    <div
      className={cn(
        "min-h-16 w-full flex-1 rounded-sm border border-transparent",
        active && "border-primary/60 bg-primary/10",
      )}
      onDragOver={(event) => handleDragOver(event, { type: "root" }, actions)}
      onDrop={(event) => handleDrop(event, { type: "root" }, actions)}
    />
  );
}
