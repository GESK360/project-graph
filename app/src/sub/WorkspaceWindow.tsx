import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import WorkspaceMoveCopyDialog, { type WorkspaceMoveCopyMode } from "@/components/workspace/WorkspaceMoveCopyDialog";
import WorkspaceTree, {
  type WorkspaceDropTarget,
  type WorkspacePageNode,
  type WorkspaceRowClick,
} from "@/components/workspace/WorkspaceTree";
import WorkspaceVersionsDialog from "@/components/workspace/WorkspaceVersionsDialog";
import { flattenWorkspaceTree } from "@/components/workspace/workspaceFlat";
import { isSameWorkspacePath, reportWorkspaceError } from "@/components/workspace/workspacePath";
import { createPageDeepLink } from "@/core/service/dataFileService/DeepLinkHandler";
import { Settings } from "@/core/service/Settings";
import {
  WorkspaceManager,
  WorkspacePaths,
  type WorkspaceClipboard,
  type WorkspaceNode,
} from "@/core/service/workspace/WorkspaceManager";
import {
  copyWorkspaceNodes,
  copyWorkspacePage,
  deleteWorkspaceFolder,
  deleteWorkspacePage,
  moveWorkspaceNodes,
  moveWorkspacePage,
  openWorkspacePage,
  renameWorkspaceNode,
} from "@/core/service/workspace/WorkspacePageOps";
import { ComponentTab, Tab } from "@/core/Tab";
import { dockWorkspacePanel, TabWorkspace } from "@/core/TabWorkspace";
import { createSubWindow } from "@/core/subWindowOpen";
import { activeResourceTabAtom, store, tabsAtom } from "@/state";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import i18next from "i18next";
import { useAtom } from "jotai";
import {
  ArrowUpDown,
  Copy,
  FilePlus,
  FolderOpen,
  FolderPlus,
  RefreshCcw,
  SquareArrowOutUpRight,
  Trash2,
  FolderInput,
} from "lucide-react";
import { isValidElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

const COLLAPSED_KEY_PREFIX = "workspace:collapsed:";

function readCollapsedDirs(root: string): string[] {
  const raw = localStorage.getItem(COLLAPSED_KEY_PREFIX + root);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function writeCollapsedDirs(root: string, dirs: string[]) {
  localStorage.setItem(COLLAPSED_KEY_PREFIX + root, JSON.stringify(dirs));
}

function isPagePath(path: string) {
  return WorkspacePaths.normalize(path).toLowerCase().endsWith(".prg");
}

export default function WorkspaceWindow() {
  const { t } = useTranslation("workspace");
  const [activeTab] = useAtom(activeResourceTabAtom);
  const [root] = Settings.use("activeWorkspaceRoot");
  const [sortMode, setSortMode] = Settings.use("workspaceSortMode");
  const [tree, setTree] = useState<WorkspaceNode[]>([]);
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set());
  const [versionCounts, setVersionCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const [clipboard, setClipboard] = useState<WorkspaceClipboard | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<WorkspaceDropTarget | null>(null);
  const [moveCopyTarget, setMoveCopyTarget] = useState<{
    paths: string[];
    label: string;
    mode: WorkspaceMoveCopyMode;
  } | null>(null);
  const [versionsTarget, setVersionsTarget] = useState<WorkspacePageNode | null>(null);
  const anchorPathRef = useRef<string | undefined>(undefined);
  const dragPathsRef = useRef<string[]>([]);
  const dragOccurredRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const dragOverKeyRef = useRef("");

  const activeFsPath = activeTab && "uri" in activeTab ? activeTab.uri.fsPath : undefined;

  const refresh = useCallback(async () => {
    const currentRoot = WorkspaceManager.root;
    if (!currentRoot) {
      setTree([]);
      setVersionCounts(new Map());
      setSelectedPaths(new Set());
      return;
    }
    const nodes = await WorkspaceManager.readTree();
    setTree(nodes);
    const pages: WorkspacePageNode[] = [];
    const walk = (list: WorkspaceNode[]) => {
      for (const node of list) {
        if (node.kind === "page") pages.push(node);
        else walk(node.children);
      }
    };
    walk(nodes);
    const counts = new Map<string, number>();
    await Promise.all(
      pages.map(async (page) => {
        counts.set(page.path, (await WorkspaceManager.listVersions(page.path)).length);
      }),
    );
    setVersionCounts(counts);
    setClipboard(WorkspaceManager.clipboard);
    // 文件被外部改动后选中的路径可能已经不存在，顺手清掉
    const existing = new Set<string>(pages.map((page) => page.path));
    const walkDirs = (list: WorkspaceNode[]) => {
      for (const node of list) {
        if (node.kind === "dir") {
          existing.add(node.path);
          walkDirs(node.children);
        }
      }
    };
    walkDirs(nodes);
    setSelectedPaths((previous) => {
      const next = new Set([...previous].filter((path) => existing.has(path)));
      return next.size === previous.size ? previous : next;
    });
  }, []);

  useEffect(() => {
    setCollapsedDirs(new Set(readCollapsedDirs(root)));
    setSelectedPaths(new Set());
    anchorPathRef.current = undefined;
  }, [root]);

  useEffect(() => {
    // watcher 是进程内的，应用重启后根目录还在但没有监听
    WorkspaceManager.ensureWatching().catch(reportWorkspaceError);
    refresh().catch(reportWorkspaceError);
  }, [refresh, root]);

  useEffect(() => {
    const onChange = () => {
      refresh().catch(reportWorkspaceError);
    };
    WorkspaceManager.on("change", onChange);
    WorkspaceManager.on("root-change", onChange);
    return () => {
      WorkspaceManager.off("change", onChange);
      WorkspaceManager.off("root-change", onChange);
    };
  }, [refresh]);

  const rows = useMemo(
    () => (root ? flattenWorkspaceTree(tree, collapsedDirs, root) : []),
    [tree, collapsedDirs, root],
  );

  // 折叠目录里的节点也要能判断出类型（删除/落点校验会用到），所以按整棵树收集而不是可见行
  const kindByPath = useMemo(() => {
    const map = new Map<string, "dir" | "page">();
    const walk = (list: WorkspaceNode[]) => {
      for (const node of list) {
        map.set(node.path, node.kind);
        if (node.kind === "dir") walk(node.children);
      }
    };
    walk(tree);
    return map;
  }, [tree]);

  const toggleCollapsed = useCallback(
    (dirPath: string) => {
      if (!root) return;
      setCollapsedDirs((previous) => {
        const next = new Set(previous);
        if (next.has(dirPath)) next.delete(dirPath);
        else next.add(dirPath);
        writeCollapsedDirs(root, [...next]);
        return next;
      });
    },
    [root],
  );

  const clickRow = useCallback(
    (click: WorkspaceRowClick) => {
      const anchor = anchorPathRef.current;
      if (click.shiftKey && anchor) {
        const anchorIndex = rows.findIndex((row) => isSameWorkspacePath(row.node.path, anchor));
        const currentIndex = rows.findIndex((row) => isSameWorkspacePath(row.node.path, click.path));
        if (anchorIndex >= 0 && currentIndex >= 0) {
          const start = Math.min(anchorIndex, currentIndex);
          const end = Math.max(anchorIndex, currentIndex);
          setSelectedPaths(new Set(rows.slice(start, end + 1).map((row) => row.node.path)));
          return;
        }
      }
      if (click.ctrlKey) {
        setSelectedPaths((previous) => {
          const next = new Set(previous);
          if (next.has(click.path)) next.delete(click.path);
          else next.add(click.path);
          return next;
        });
        anchorPathRef.current = click.path;
        return;
      }
      setSelectedPaths(new Set([click.path]));
      anchorPathRef.current = click.path;
    },
    [rows],
  );

  /** 右键未选中的行时先把它变成唯一选中，菜单才会指向它 */
  const contextRow = useCallback((path: string) => {
    setSelectedPaths((previous) => (previous.has(path) ? previous : new Set([path])));
    anchorPathRef.current = path;
  }, []);

  /** 右键落在多选集合内 → 作用于整个选择集；否则只作用于该行 */
  const targetPathsFor = useCallback(
    (path: string) => (selectedPaths.size > 1 && selectedPaths.has(path) ? [...selectedPaths] : [path]),
    [selectedPaths],
  );

  const promptNewPage = useCallback(
    async (dirPath: string) => {
      const name = await Dialog.input(t("newPage"), "", { placeholder: t("unnamedPage") });
      if (name === undefined) return;
      const finalName = name.trim() || t("unnamedPage");
      const path = await WorkspaceManager.createPage(dirPath, finalName);
      await openWorkspacePage(path);
      toast.success(t("pageCreated"));
    },
    [t],
  );

  const createFolder = useCallback(
    async (dirPath: string) => {
      await WorkspaceManager.createFolder(dirPath, t("newFolderName"));
      toast.success(t("folderCreated"));
    },
    [t],
  );

  const promptRenameNode = useCallback(
    async (node: WorkspaceNode) => {
      const isDir = node.kind === "dir";
      const name = await Dialog.input(isDir ? t("renameFolder") : t("rename"), node.name, { defaultValue: node.name });
      if (name === undefined) return;
      const trimmed = name.trim();
      if (!trimmed) {
        toast.error(t("nameRequired"));
        return;
      }
      if (trimmed === node.name) return;
      // 统一走 PageOps：无论页面还是目录，都会先存盘关掉受影响的标签再改路径
      const newPath = await renameWorkspaceNode(node.path, trimmed);
      setSelectedPaths(new Set([newPath]));
      anchorPathRef.current = newPath;
    },
    [t],
  );

  const deleteEntries = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        // 目录走 PageOps：它会先把目录里已打开的页面存盘关闭，再递归删除
        if (kindByPath.get(path) === "dir") await deleteWorkspaceFolder(path);
        else await deleteWorkspacePage(path);
      }
      setSelectedPaths(new Set());
      anchorPathRef.current = undefined;
    },
    [kindByPath],
  );

  const confirmDelete = useCallback(
    async (node: WorkspaceNode) => {
      const paths = targetPathsFor(node.path);
      if (paths.length > 1) {
        const confirmed = await Dialog.confirm(t("deleteManyTitle"), t("deleteManyBody", { count: paths.length }), {
          destructive: true,
        });
        if (!confirmed) return;
        await deleteEntries(paths);
        return;
      }
      if (node.kind === "dir") {
        const confirmed = await Dialog.confirm(t("deleteFolderTitle"), t("deleteFolderBody", { name: node.name }), {
          destructive: true,
        });
        if (!confirmed) return;
        await deleteEntries([node.path]);
        return;
      }
      const confirmed = await Dialog.confirm(t("deleteConfirmTitle"), t("deleteConfirmBody", { name: node.name }), {
        destructive: true,
      });
      if (!confirmed) return;
      await deleteEntries([node.path]);
    },
    [deleteEntries, t, targetPathsFor],
  );

  const copyLink = useCallback(
    async (node: WorkspacePageNode) => {
      await writeText(createPageDeepLink(node.path));
      toast.success(t("linkCopied"));
    },
    [t],
  );

  const cutOrCopy = useCallback(
    (node: WorkspaceNode, mode: "cut" | "copy") => {
      const paths = targetPathsFor(node.path);
      if (mode === "cut") WorkspaceManager.cutMany(paths);
      else WorkspaceManager.copyMany(paths);
      setClipboard(WorkspaceManager.clipboard);
    },
    [targetPathsFor],
  );

  /** 拖完/移完把选中集换成新路径，否则选择会指向已经不存在的旧路径 */
  const adoptMovedPaths = useCallback((moved: string[]) => {
    if (moved.length === 0) return;
    setSelectedPaths(new Set(moved));
    anchorPathRef.current = moved[0];
  }, []);

  const paste = useCallback(
    (targetDir: string) => {
      WorkspaceManager.paste(targetDir)
        .then(async (pasted) => {
          adoptMovedPaths(pasted);
          await refresh();
        })
        .catch(reportWorkspaceError);
    },
    [adoptMovedPaths, refresh],
  );

  /** 单个页面走 PageOps（要处理已打开的标签页），批量或目录走 Manager 的通用节点操作 */
  const moveEntries = useCallback(
    async (paths: string[], targetDir: string) => {
      const moved =
        paths.length === 1 && isPagePath(paths[0])
          ? [await moveWorkspacePage(paths[0], targetDir)]
          : await moveWorkspaceNodes(paths, targetDir);
      adoptMovedPaths(moved);
      return moved;
    },
    [adoptMovedPaths],
  );

  const copyEntries = useCallback(
    async (paths: string[], targetDir: string) => {
      const copied =
        paths.length === 1 && isPagePath(paths[0])
          ? [await copyWorkspacePage(paths[0], targetDir)]
          : await copyWorkspaceNodes(paths, targetDir);
      adoptMovedPaths(copied);
      return copied;
    },
    [adoptMovedPaths],
  );

  const dropEntries = useCallback(
    async (target: WorkspaceDropTarget, paths: string[]) => {
      dragOverKeyRef.current = "";
      const currentRoot = WorkspaceManager.root;
      if (!currentRoot) return;
      const targetDir = target.type === "drop" ? target.path : target.type === "root" ? currentRoot : target.dirPath;
      // 目录不能放进自己或自己的子树，UI 先拦，省得 Manager 抛错
      const invalid = paths.some((path) => kindByPath.get(path) === "dir" && WorkspacePaths.isInside(targetDir, path));
      if (invalid) {
        toast.error(t("dragInvalidTarget"));
        return;
      }
      // 名字要在移动前取：重名会让落地路径带上「(2)」之类的后缀
      const originalNames = new Set(paths.map((path) => WorkspacePaths.baseName(path)));
      const moved = await moveEntries(paths, targetDir);
      if (target.type === "drop") return;
      // 落点在某个文件之前/之后、或者空白处（排到末尾）：记进 order.json，树重读后就是新顺序
      const beforeFileName = target.type === "root" ? undefined : target.beforeFileName;
      // 落点锚点本身就在被拖的这批里 → 相对顺序没变，不用动 order.json
      if (beforeFileName !== undefined && originalNames.has(beforeFileName)) return;
      for (const path of moved) {
        await WorkspaceManager.reorderNode(path, targetDir, beforeFileName);
      }
    },
    [kindByPath, moveEntries, t],
  );

  const actions = useMemo(
    () => ({
      openPage: (node: WorkspacePageNode) => {
        openWorkspacePage(node.path).catch(reportWorkspaceError);
      },
      toggleDir: (node: Extract<WorkspaceNode, { kind: "dir" }>) => {
        toggleCollapsed(node.path);
      },
      clickRow,
      contextRow,
      newPage: (dirPath: string) => {
        promptNewPage(dirPath).catch(reportWorkspaceError);
      },
      newFolder: (dirPath: string) => {
        createFolder(dirPath).catch(reportWorkspaceError);
      },
      renameNode: (node: WorkspaceNode) => {
        promptRenameNode(node).catch(reportWorkspaceError);
      },
      deleteNode: (node: WorkspaceNode) => {
        confirmDelete(node).catch(reportWorkspaceError);
      },
      moveUp: (path: string) => {
        WorkspaceManager.moveUp(path).catch(reportWorkspaceError);
      },
      moveDown: (path: string) => {
        WorkspaceManager.moveDown(path).catch(reportWorkspaceError);
      },
      cutNode: (node: WorkspaceNode) => {
        cutOrCopy(node, "cut");
      },
      copyNode: (node: WorkspaceNode) => {
        cutOrCopy(node, "copy");
      },
      paste,
      copyLink: (node: WorkspacePageNode) => {
        copyLink(node).catch(reportWorkspaceError);
      },
      moveOrCopy: (node: WorkspaceNode) => {
        const paths = targetPathsFor(node.path);
        setMoveCopyTarget({
          paths,
          label: paths.length > 1 ? t("selectedCount", { count: paths.length }) : node.name,
          mode: "move",
        });
      },
      collapseDir: (dirPath: string) => {
        if (!root) return;
        setCollapsedDirs((previous) => {
          const next = new Set(previous);
          next.add(dirPath);
          writeCollapsedDirs(root, [...next]);
          return next;
        });
      },
      showVersions: (node: WorkspacePageNode) => {
        setVersionsTarget(node);
      },
      refreshVersions: (pagePath: string) => {
        WorkspaceManager.listVersions(pagePath)
          .then((versions) => {
            setVersionCounts((previous) => new Map(previous).set(pagePath, versions.length));
          })
          .catch(reportWorkspaceError);
      },
      refresh: () => {
        refresh().catch(reportWorkspaceError);
      },
      closeWorkspace: () => {
        WorkspaceManager.closeWorkspace().catch(reportWorkspaceError);
      },
      dragStart: (paths: string[]) => {
        dragPathsRef.current = paths;
        dragOccurredRef.current = true;
      },
      dragEnd: () => {
        dragPathsRef.current = [];
        dragOverKeyRef.current = "";
        setDropTarget(null);
        // 拖拽结束后浏览器可能补一次 click，200ms 内的点击一律当拖拽处理
        if (dragOccurredRef.current) {
          dragOccurredRef.current = false;
          suppressClickUntilRef.current = Date.now() + 200;
        }
      },
      dragOver: (target: WorkspaceDropTarget | null) => {
        // dragover 每秒触发几十次，同一落点不要重复 setState
        const key = target ? `${target.type}:${"path" in target ? target.path : ""}` : "";
        if (dragOverKeyRef.current === key) return;
        dragOverKeyRef.current = key;
        setDropTarget(target);
      },
      drop: (target: WorkspaceDropTarget, paths: string[]) => {
        setDropTarget(null);
        const dropped = paths.length > 0 ? paths : dragPathsRef.current;
        dropEntries(target, dropped).catch(reportWorkspaceError);
      },
      shouldIgnoreClick: () => {
        if (Date.now() < suppressClickUntilRef.current) {
          // 只吃掉拖拽后紧跟的那一次 click，不影响之后的正常点击
          suppressClickUntilRef.current = 0;
          return true;
        }
        return false;
      },
    }),
    [
      clickRow,
      confirmDelete,
      contextRow,
      copyLink,
      createFolder,
      cutOrCopy,
      dropEntries,
      paste,
      promptNewPage,
      promptRenameNode,
      refresh,
      root,
      t,
      targetPathsFor,
      toggleCollapsed,
    ],
  );

  const submitMoveCopy = async (mode: WorkspaceMoveCopyMode, targetDir: string) => {
    if (!moveCopyTarget) return;
    if (mode === "move") await moveEntries(moveCopyTarget.paths, targetDir);
    else await copyEntries(moveCopyTarget.paths, targetDir);
    await refresh();
  };

  const openFolder = () => {
    WorkspaceManager.openWorkspace().catch(reportWorkspaceError);
  };

  if (!root) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <FolderOpen className="text-muted-foreground size-6" />
        <div className="text-muted-foreground text-xs leading-relaxed">{t("emptyHint")}</div>
        <Button size="sm" onClick={openFolder}>
          <FolderOpen />
          {t("openFolder")}
        </Button>
      </div>
    );
  }

  const selectedList = [...selectedPaths];
  const rootName =
    root
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || root;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={root}>
          {rootName}
        </span>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="size-6">
                  <ArrowUpDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{sortMode === "custom" ? t("dragHint") : t("sortLockedHint")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={sortMode}
              onValueChange={(value) => {
                setSortMode(value as typeof sortMode);
                // 树是按 Settings 里的模式排的，换模式后要重新读一遍
                refresh().catch(reportWorkspaceError);
              }}
            >
              <DropdownMenuRadioItem value="custom">{t("sortCustom")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="name">{t("sortName")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="createdAt">{t("sortCreatedAt")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="modifiedAt">{t("sortModifiedAt")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-6" onClick={() => actions.refresh()}>
              <RefreshCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("refresh")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-6" onClick={() => actions.newFolder(root)}>
              <FolderPlus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("createFolder")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-6" onClick={() => actions.newPage(root)}>
              <FilePlus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("newPage")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-6" onClick={() => shellOpen(root)}>
              <SquareArrowOutUpRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("revealInExplorer")}</TooltipContent>
        </Tooltip>
      </div>

      {selectedPaths.size > 1 && (
        <div className="bg-accent/30 flex items-center gap-1 border-b px-2 py-1 text-xs">
          <span className="text-muted-foreground min-w-0 flex-1 truncate">
            {t("selectedCount", { count: selectedPaths.size })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() =>
              setMoveCopyTarget({
                paths: selectedList,
                label: t("selectedCount", { count: selectedPaths.size }),
                mode: "move",
              })
            }
          >
            <FolderInput className="size-3.5" />
            {t("moveMany")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() =>
              setMoveCopyTarget({
                paths: selectedList,
                label: t("selectedCount", { count: selectedPaths.size }),
                mode: "copy",
              })
            }
          >
            <Copy className="size-3.5" />
            {t("copyMany")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive h-6 px-1.5 text-xs"
            onClick={() => {
              Dialog.confirm(t("deleteManyTitle"), t("deleteManyBody", { count: selectedPaths.size }), {
                destructive: true,
              })
                .then((confirmed) => (confirmed ? deleteEntries(selectedList) : undefined))
                .catch(reportWorkspaceError);
            }}
          >
            <Trash2 className="size-3.5" />
            {t("delete")}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        <WorkspaceTree
          nodes={tree}
          rows={rows}
          root={root}
          collapsedDirs={collapsedDirs}
          activeFsPath={activeFsPath}
          clipboard={clipboard}
          versionCounts={versionCounts}
          selectedPaths={selectedPaths}
          dropTarget={dropTarget}
          manualOrder={sortMode === "custom"}
          actions={actions}
        />
      </div>

      <WorkspaceMoveCopyDialog
        paths={moveCopyTarget?.paths ?? null}
        label={moveCopyTarget?.label ?? ""}
        initialMode={moveCopyTarget?.mode ?? "move"}
        onClose={() => setMoveCopyTarget(null)}
        onSubmit={submitMoveCopy}
      />
      <WorkspaceVersionsDialog
        pagePath={versionsTarget?.path ?? null}
        pageName={versionsTarget?.name ?? ""}
        onClose={() => setVersionsTarget(null)}
      />
    </div>
  );
}

/** 已经开着就只聚焦，别开第二个（快捷键和菜单都会调它） */
export function findWorkspaceTab(): Tab | undefined {
  return store.get(tabsAtom).find(isWorkspaceTab);
}

WorkspaceWindow.open = () => {
  const existing = findWorkspaceTab();
  if (existing) {
    TabWorkspace.focus(existing.id);
    return;
  }
  const tab = createSubWindow("WorkspaceWindow", {
    title: i18next.t("workspace.title"),
    contextTarget: "activeResourceTab",
    children: <WorkspaceWindow />,
    rect: new Rectangle(new Vector(100, 100), new Vector(260, 640)),
  });
  // 从主组挪到工作空间专属固定组，之后的标签就不会挤掉它
  dockWorkspacePanel(tab.id);
};

/** 用元素类型识别自己的 tab，避免跟着语言切换或标题文案变化失效 */
function isWorkspaceTab(tab: Tab) {
  if (!(tab instanceof ComponentTab) || !isValidElement(tab.children)) return false;
  return tab.children.type === WorkspaceWindow;
}

/** 与 open() 配对：已开着就关掉，没开才打开 */
WorkspaceWindow.toggle = () => {
  const existing = findWorkspaceTab();
  if (existing) void TabWorkspace.close(existing.id);
  else WorkspaceWindow.open();
};
