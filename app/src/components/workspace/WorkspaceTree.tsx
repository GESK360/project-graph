import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type {
  WorkspaceClipboard,
  WorkspaceCreatePlacement,
  WorkspaceNode,
} from "@/core/service/workspace/WorkspaceManager";
import { cn } from "@/utils/cn";
import {
  ArrowDown,
  ArrowUp,
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
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { WorkspaceFlatRow } from "./workspaceFlat";
import { fileNameOf } from "./workspaceFlat";
import { isSameWorkspacePath, reportWorkspaceError } from "./workspacePath";

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
  newPage: (dirPath: string, placement?: WorkspaceCreatePlacement) => void;
  newFolder: (dirPath: string, placement?: WorkspaceCreatePlacement) => void;
  renameNode: (node: WorkspaceNode) => void;
  deleteNode: (node: WorkspaceNode) => void;
  moveUp: (path: string) => void;
  moveDown: (path: string) => void;
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
  renameOnDoubleClick: boolean;
  dropTarget: WorkspaceDropTarget | null;
  /** 手动排序模式（Settings.workspaceSortMode === "custom"）；关掉时拖拽与上移/下移全部禁用 */
  manualOrder: boolean;
  actions: WorkspaceTreeActions;
}

export interface WorkspaceTreeProps extends TreeState {
  nodes: WorkspaceNode[];
  rows: WorkspaceFlatRow[];
  editingPath?: string;
  focusRequest: { path: string } | null;
  finishEdit: (value: string | undefined, restoreFocus: boolean) => Promise<void>;
}

const INDENT = 12;
const RENAME_EVENT = "pg-workspace-rename";

export function focusedWorkspaceRenameRow() {
  const active = document.activeElement;
  return active?.matches("[data-pg-workspace-renameable]") ? active : null;
}

export function requestFocusedWorkspaceRename() {
  focusedWorkspaceRenameRow()?.dispatchEvent(new Event(RENAME_EVENT, { bubbles: true }));
}
/** 位移超过这个距离才算拖拽，之前松手都按普通点击处理 */
const DRAG_START_DISTANCE = 4;
/** 目录行上下各留 25% 给"排到前面/后面"，中间 50% 是"放进去" */
const DIR_DROP_EDGE = 0.25;

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  paths: string[];
  label: string;
  dragging: boolean;
  target: WorkspaceDropTarget | null;
}

interface DragGhost {
  x: number;
  y: number;
  label: string;
}

interface PointerDrag {
  ghost: DragGhost | null;
  start: (event: ReactPointerEvent<HTMLButtonElement>, row: WorkspaceFlatRow) => void;
}

interface RowProps {
  row: WorkspaceFlatRow;
  actions: WorkspaceTreeActions;
  drag: PointerDrag;
}

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

/** 落点指示：目录行中段整行高亮表示"放进去"，上下段画边线表示"排到前/后" */
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

/**
 * 用 elementFromPoint 命中行元素算落点：HTML5 的 dragover 在本项目完全不触发
 * （custom_drag_drop.rs 用 RegisterDragDrop 接管了窗口的 OLE 拖放），所以只能自己算。
 */
function dropTargetAtPoint(x: number, y: number, rows: WorkspaceFlatRow[]): WorkspaceDropTarget {
  const element = document.elementFromPoint(x, y);
  const rowElement = element?.closest("[data-pg-workspace-row]");
  const rowPath = rowElement instanceof HTMLElement ? rowElement.dataset.pgWorkspacePath : undefined;
  const row = rowPath === undefined ? undefined : rows.find((item) => isSameWorkspacePath(item.node.path, rowPath));
  if (!(rowElement instanceof HTMLElement) || !row) return { type: "root" };
  const rect = rowElement.getBoundingClientRect();
  const ratio = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  if (row.node.kind === "dir" && ratio > DIR_DROP_EDGE && ratio < 1 - DIR_DROP_EDGE) {
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

function usePointerDrag(
  enabled: boolean,
  rows: WorkspaceFlatRow[],
  selectedPaths: ReadonlySet<string>,
  actions: WorkspaceTreeActions,
): PointerDrag {
  const { t } = useTranslation("workspace");
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const rowsRef = useRef(rows);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    return () => {
      detachRef.current?.();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  const start = (event: ReactPointerEvent<HTMLButtonElement>, row: WorkspaceFlatRow) => {
    if (!enabled || event.button !== 0 || sessionRef.current) return;
    const rowElement = event.currentTarget;
    // 拖已选中的行 = 拖整个选择集；拖未选中的行 = 只拖它自己
    const paths = selectedPaths.has(row.node.path) ? [...selectedPaths] : [row.node.path];
    const session: DragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      paths,
      label: paths.length > 1 ? t("selectedCount", { count: paths.length }) : row.node.name,
      dragging: false,
      target: null,
    };
    sessionRef.current = session;
    // 捕获指针，鼠标拖到窗口外再松手也能收到 pointerup，不会卡在拖拽态
    rowElement.setPointerCapture(event.pointerId);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const current = sessionRef.current;
      if (!current) return;
      if (!current.dragging) {
        if (Math.hypot(moveEvent.clientX - current.startX, moveEvent.clientY - current.startY) <= DRAG_START_DISTANCE) {
          return;
        }
        current.dragging = true;
        // 拖拽中要吃掉默认行为：否则会把行里的文字选中，光标也不是"抓起"的样子
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        window.getSelection()?.removeAllRanges();
        actions.dragStart(current.paths);
      }
      moveEvent.preventDefault();
      setGhost({ x: moveEvent.clientX, y: moveEvent.clientY, label: current.label });
      const target = dropTargetAtPoint(moveEvent.clientX, moveEvent.clientY, rowsRef.current);
      current.target = target;
      actions.dragOver(target);
    };

    const detach = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (rowElement.hasPointerCapture(session.pointerId)) rowElement.releasePointerCapture(session.pointerId);
      if (detachRef.current === detach) detachRef.current = null;
    };

    const onPointerUp = () => {
      const current = sessionRef.current;
      sessionRef.current = null;
      detach();
      if (!current?.dragging) return;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setGhost(null);
      actions.dragEnd();
      if (current.target) actions.drop(current.target, current.paths);
      else actions.dragOver(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    detachRef.current = detach;
  };

  return { ghost, start };
}

function toRowClick(path: string, event: ReactMouseEvent): WorkspaceRowClick {
  return { path, ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey };
}

function isRenameClick(
  event: ReactMouseEvent,
  path: string,
  state: Pick<TreeState, "renameOnDoubleClick" | "selectedPaths">,
) {
  // 在第二次 click 直接改名，避免随后才收到 dblclick 时已重复展开目录或打开页面。
  return (
    state.renameOnDoubleClick &&
    event.detail === 2 &&
    state.selectedPaths.size === 1 &&
    state.selectedPaths.has(path) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export default function WorkspaceTree({
  nodes,
  rows,
  actions,
  editingPath,
  focusRequest,
  finishEdit,
  ...state
}: WorkspaceTreeProps) {
  const { t } = useTranslation("workspace");
  const drag = usePointerDrag(state.manualOrder, rows, state.selectedPaths, actions);
  const treeRef = useRef<HTMLDivElement>(null);
  const lastFocusRequest = useRef<typeof focusRequest>(null);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const renameFocusedRow = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = rows.find(({ node }) => node.path === target.dataset.pgWorkspacePath);
      if (row) actions.renameNode(row.node);
    };
    tree.addEventListener(RENAME_EVENT, renameFocusedRow);
    return () => tree.removeEventListener(RENAME_EVENT, renameFocusedRow);
  }, [rows, actions]);

  useEffect(() => {
    if (!focusRequest || focusRequest === lastFocusRequest.current) return;
    const buttons = treeRef.current?.querySelectorAll<HTMLButtonElement>("[data-pg-workspace-row]");
    const target =
      buttons && Array.from(buttons).find((button) => button.dataset.pgWorkspacePath === focusRequest.path);
    if (!target) return;
    lastFocusRequest.current = focusRequest;
    if (document.activeElement === document.body) target.focus({ preventScroll: true });
  }, [focusRequest, rows]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={treeRef} className="flex min-h-full min-w-full flex-col pb-2">
          {rows.length === 0 && nodes.length === 0 && (
            <div className="text-muted-foreground px-3 py-6 text-center text-xs leading-relaxed">{t("emptyHint")}</div>
          )}
          {rows.map((row) =>
            row.node.path === editingPath ? (
              <EditingRow key={row.node.path} row={row} finishEdit={finishEdit} />
            ) : row.node.kind === "dir" ? (
              <DirRow key={row.node.path} row={row} {...state} actions={actions} drag={drag} />
            ) : (
              <PageRow key={row.node.path} row={row} {...state} actions={actions} drag={drag} />
            ),
          )}
          <RootDropZone active={state.dropTarget?.type === "root"} />
          {drag.ghost &&
            createPortal(
              <div
                className="bg-popover text-popover-foreground pointer-events-none fixed z-[1000] max-w-56 truncate rounded border px-2 py-1 text-xs shadow-md"
                style={{ left: drag.ghost.x + 10, top: drag.ghost.y + 10 }}
              >
                {drag.ghost.label}
              </div>,
              document.body,
            )}
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

function EditingRow({ row, finishEdit }: Pick<WorkspaceTreeProps, "finishEdit"> & { row: WorkspaceFlatRow }) {
  const { t } = useTranslation("workspace");
  const inputRef = useRef<HTMLInputElement>(null);
  const finishingRef = useRef(false);
  const isDir = row.node.kind === "dir";

  useEffect(() => {
    // 右键菜单关闭时会归还焦点，等它退出后再把光标放进输入框。
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = async (value: string | undefined, restoreFocus: boolean) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    try {
      await finishEdit(value, restoreFocus);
    } catch (error) {
      reportWorkspaceError(error);
      if (restoreFocus) inputRef.current?.focus();
    } finally {
      finishingRef.current = false;
    }
  };

  return (
    <div
      className={cn(
        "bg-accent/60 text-accent-foreground flex h-6 w-full items-center rounded-sm pr-2 text-xs",
        isDir ? "gap-1" : "gap-1.5",
      )}
      style={{ paddingLeft: 4 + row.depth * INDENT + (isDir ? 0 : 18) }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {isDir ? (
        <>
          <span className="size-3.5 shrink-0" />
          <Folder className="text-muted-foreground size-3.5 shrink-0" />
        </>
      ) : (
        <FileText className="text-muted-foreground size-3.5 shrink-0" />
      )}
      <input
        ref={inputRef}
        aria-label={t(isDir ? "renameFolder" : "rename")}
        className="border-ring bg-background text-foreground h-5 min-w-0 flex-1 rounded-sm border px-1 outline-none"
        defaultValue={row.node.name}
        onBlur={(event) => void finish(event.currentTarget.value, false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          void finish(event.key === "Escape" ? undefined : event.currentTarget.value, true);
        }}
      />
    </div>
  );
}

/** 上移/下移：非手动排序模式或已在同级首/末项时置灰 */
function MoveItems({
  row,
  actions,
  manualOrder,
  disabled,
}: Pick<RowProps, "row" | "actions"> & { manualOrder: boolean; disabled: boolean }) {
  const { t } = useTranslation("workspace");
  return (
    <>
      <ContextMenuItem
        disabled={!manualOrder || disabled || row.indexInSiblings === 0}
        onSelect={() => actions.moveUp(row.node.path)}
      >
        <ArrowUp />
        {t("moveUp")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!manualOrder || disabled || row.indexInSiblings >= row.siblings.length - 1}
        onSelect={() => actions.moveDown(row.node.path)}
      >
        <ArrowDown />
        {t("moveDown")}
      </ContextMenuItem>
    </>
  );
}

function DirRow({ row, actions, drag, ...state }: TreeState & RowProps) {
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
          data-pg-workspace-row=""
          data-pg-workspace-path={node.path}
          data-pg-workspace-renameable={isSelected && !batch ? "" : undefined}
          style={{ paddingLeft: 4 + row.depth * INDENT }}
          className={cn(
            "hover:bg-accent/50 flex h-6 w-full items-center gap-1 rounded-sm pr-2 text-left text-xs",
            isSelected && "bg-accent/60 text-accent-foreground",
            isCutPath(state.clipboard, node.path) && "opacity-50",
            rowDropClass(state.dropTarget, node.path),
          )}
          onPointerDown={(event) => drag.start(event, row)}
          onClick={(event) => {
            if (actions.shouldIgnoreClick()) return;
            if (isRenameClick(event, node.path, state)) {
              actions.renameNode(node);
              return;
            }
            const click = toRowClick(node.path, event);
            actions.clickRow(click);
            // 只有普通单击才折叠/展开；Ctrl 和 Shift 是选行，不该顺手改结构
            if (!click.shiftKey && !click.ctrlKey) actions.toggleDir(node);
          }}
          onContextMenu={(event) => {
            event.stopPropagation();
            event.currentTarget.focus({ preventScroll: true });
            actions.contextRow(node.path);
          }}
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
        <MoveItems row={row} actions={actions} manualOrder={state.manualOrder} disabled={batch} />
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
        <ContextMenuItem onSelect={() => actions.newPage(node.path, { type: "start" })}>
          <FilePlus />
          {t("newPage")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.newFolder(node.path, { type: "start" })}>
          <FolderPlus />
          {t("createFolder")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function PageRow({ row, actions, drag, ...state }: TreeState & RowProps) {
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
          aria-current={isActive ? "page" : undefined}
          data-pg-workspace-row=""
          data-pg-workspace-path={node.path}
          data-pg-workspace-renameable={isSelected && !batch ? "" : undefined}
          style={{ paddingLeft: 4 + row.depth * INDENT + 18 }}
          className={cn(
            "hover:bg-accent/50 flex h-6 w-full items-center gap-1.5 rounded-sm pr-2 text-left text-xs",
            isSelected && "bg-accent/60 text-accent-foreground",
            isCutPath(state.clipboard, node.path) && "opacity-50",
            rowDropClass(state.dropTarget, node.path),
          )}
          onPointerDown={(event) => drag.start(event, row)}
          onClick={(event) => {
            if (actions.shouldIgnoreClick()) return;
            if (isRenameClick(event, node.path, state)) {
              actions.renameNode(node);
              return;
            }
            const click = toRowClick(node.path, event);
            actions.clickRow(click);
            if (!click.shiftKey) actions.openPage(node);
          }}
          onContextMenu={(event) => {
            event.stopPropagation();
            event.currentTarget.focus({ preventScroll: true });
            actions.contextRow(node.path);
          }}
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
        <MoveItems row={row} actions={actions} manualOrder={state.manualOrder} disabled={batch} />
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
        <ContextMenuItem onSelect={() => actions.newPage(row.dirPath, { type: "after", fileName: fileNameOf(node) })}>
          <FilePlus />
          {t("newPage")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.newFolder(row.dirPath, { type: "after", fileName: fileNameOf(node) })}>
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

/** 树下方留白：落在空白 = 排到根末尾 */
function RootDropZone({ active }: { active: boolean }) {
  return (
    <div
      className={cn(
        "min-h-16 w-full flex-1 rounded-sm border border-transparent",
        active && "border-primary/60 bg-primary/10",
      )}
    />
  );
}
