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
  History,
  IndentDecrease,
  IndentIncrease,
  Link2,
  Pencil,
  RefreshCcw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { isSameWorkspacePath } from "./workspacePath";

export type WorkspacePageNode = Extract<WorkspaceNode, { kind: "page" }>;
export type WorkspaceDirNode = Extract<WorkspaceNode, { kind: "dir" }>;

export interface WorkspaceTreeActions {
  openPage: (node: WorkspacePageNode) => void;
  toggleDir: (node: WorkspaceDirNode) => void;
  newPage: (dirPath: string) => void;
  renamePage: (node: WorkspacePageNode) => void;
  deletePage: (node: WorkspacePageNode) => void;
  cutPage: (node: WorkspacePageNode) => void;
  copyPage: (node: WorkspacePageNode) => void;
  paste: (targetDir: string) => void;
  copyLink: (node: WorkspacePageNode) => void;
  moveOrCopy: (node: WorkspacePageNode) => void;
  demote: (node: WorkspacePageNode) => void;
  promote: (node: WorkspacePageNode) => void;
  collapseDir: (dirPath: string) => void;
  showVersions: (node: WorkspacePageNode) => void;
  /** 打开菜单时补一次快照计数：自动保存写快照不会触发 change 事件 */
  refreshVersions: (path: string) => void;
  refresh: () => void;
  closeWorkspace: () => void;
}

interface LevelProps {
  nodes: WorkspaceNode[];
  depth: number;
  /** 这一层节点所在的目录；根层就是工作空间根目录 */
  dirPath: string;
  root: string;
  collapsedDirs: ReadonlySet<string>;
  activeFsPath: string | undefined;
  clipboard: WorkspaceClipboard | null;
  versionCounts: ReadonlyMap<string, number>;
  actions: WorkspaceTreeActions;
}

export interface WorkspaceTreeProps {
  nodes: WorkspaceNode[];
  root: string;
  collapsedDirs: ReadonlySet<string>;
  activeFsPath: string | undefined;
  clipboard: WorkspaceClipboard | null;
  versionCounts: ReadonlyMap<string, number>;
  actions: WorkspaceTreeActions;
}

const INDENT = 12;

/** 折叠子页折叠的是与页面同名的那一级目录（A/A.prg 与 A/ 并列的约定） */
function findChildrenDir(nodes: WorkspaceNode[], name: string) {
  return nodes.find((node): node is WorkspaceDirNode => node.kind === "dir" && node.name === name);
}

function hasPreviousPage(nodes: WorkspaceNode[], path: string) {
  const index = nodes.findIndex((node) => node.kind === "page" && isSameWorkspacePath(node.path, path));
  for (let i = index - 1; i >= 0; i--) {
    if (nodes[i].kind === "page") return true;
  }
  return false;
}

export default function WorkspaceTree({ nodes, root, actions, ...rest }: WorkspaceTreeProps) {
  const { t } = useTranslation("workspace");
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="min-h-full min-w-full pb-10">
          {nodes.length === 0 && (
            <div className="text-muted-foreground px-3 py-6 text-center text-xs leading-relaxed">{t("emptyHint")}</div>
          )}
          <NodeLevel nodes={nodes} depth={0} dirPath={root} root={root} actions={actions} {...rest} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.newPage(root)}>
          <FilePlus />
          {t("newPage")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!rest.clipboard} onSelect={() => actions.paste(root)}>
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

function NodeLevel({ nodes, ...props }: LevelProps) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "dir" ? (
          <DirRow key={node.path} node={node} siblings={nodes} {...props} />
        ) : (
          <PageRow key={node.path} node={node} siblings={nodes} {...props} />
        ),
      )}
    </>
  );
}

type RowProps = Omit<LevelProps, "nodes"> & { siblings: WorkspaceNode[] };

function DirRow({
  node,
  depth,
  root,
  collapsedDirs,
  activeFsPath,
  clipboard,
  versionCounts,
  actions,
}: RowProps & { node: WorkspaceDirNode }) {
  const { t } = useTranslation("workspace");
  const collapsed = collapsedDirs.has(node.path);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            style={{ paddingLeft: 4 + depth * INDENT }}
            className="hover:bg-accent/50 flex h-6 w-full items-center gap-1 rounded-sm pr-2 text-left text-xs"
            onClick={() => actions.toggleDir(node)}
            onContextMenu={(event) => event.stopPropagation()}
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
          <ContextMenuItem onSelect={() => actions.newPage(node.path)}>
            <FilePlus />
            {t("newPage")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!clipboard} onSelect={() => actions.paste(node.path)}>
            <ClipboardPaste />
            {t("paste")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!collapsed && node.children.length > 0 && (
        <NodeLevel
          nodes={node.children}
          depth={depth + 1}
          dirPath={node.path}
          root={root}
          collapsedDirs={collapsedDirs}
          activeFsPath={activeFsPath}
          clipboard={clipboard}
          versionCounts={versionCounts}
          actions={actions}
        />
      )}
    </>
  );
}

function PageRow({
  node,
  depth,
  dirPath,
  root,
  siblings,
  collapsedDirs,
  activeFsPath,
  clipboard,
  versionCounts,
  actions,
}: RowProps & { node: WorkspacePageNode }) {
  const { t } = useTranslation("workspace");
  const isActive = activeFsPath !== undefined && isSameWorkspacePath(node.path, activeFsPath);
  const isCut = clipboard?.mode === "cut" && isSameWorkspacePath(clipboard.path, node.path);
  const isAtRoot = isSameWorkspacePath(dirPath, root);
  const childrenDir = findChildrenDir(siblings, node.name);
  return (
    <ContextMenu onOpenChange={(open) => open && actions.refreshVersions(node.path)}>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          style={{ paddingLeft: 4 + depth * INDENT + 18 }}
          className={cn(
            "hover:bg-accent/50 flex h-6 w-full items-center gap-1.5 rounded-sm pr-2 text-left text-xs",
            isActive && "bg-accent/60 text-accent-foreground",
            isCut && "opacity-50",
          )}
          onClick={() => actions.openPage(node)}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <FileText className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
          {childrenDir && (
            <ChevronDown
              className={cn(
                "text-muted-foreground/60 ml-auto size-3 shrink-0",
                collapsedDirs.has(childrenDir.path) && "-rotate-90",
              )}
            />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.renamePage(node)}>
          <Pencil />
          {t("rename")}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => actions.deletePage(node)}>
          <Trash2 />
          {t("delete")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.cutPage(node)}>
          <Scissors />
          {t("cut")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.copyPage(node)}>
          <Copy />
          {t("copy")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!clipboard} onSelect={() => actions.paste(dirPath)}>
          <ClipboardPaste />
          {t("paste")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.copyLink(node)}>
          <Link2 />
          {t("copyLink")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.moveOrCopy(node)}>
          <FolderInput />
          {t("moveOrCopy")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.newPage(dirPath)}>
          <FilePlus />
          {t("newPage")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasPreviousPage(siblings, node.path)} onSelect={() => actions.demote(node)}>
          <IndentIncrease />
          {t("demote")}
        </ContextMenuItem>
        <ContextMenuItem disabled={isAtRoot} onSelect={() => actions.promote(node)}>
          <IndentDecrease />
          {t("promote")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!childrenDir} onSelect={() => childrenDir && actions.collapseDir(childrenDir.path)}>
          <ChevronsDownUp />
          {t("collapse")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={(versionCounts.get(node.path) ?? 0) === 0}
          onSelect={() => actions.showVersions(node)}
        >
          <History />
          {t("showVersions")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
