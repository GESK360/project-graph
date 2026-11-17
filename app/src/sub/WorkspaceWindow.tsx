import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import WorkspaceMoveCopyDialog, { type WorkspaceMoveCopyMode } from "@/components/workspace/WorkspaceMoveCopyDialog";
import WorkspaceTree, { type WorkspacePageNode } from "@/components/workspace/WorkspaceTree";
import WorkspaceVersionsDialog from "@/components/workspace/WorkspaceVersionsDialog";
import { reportWorkspaceError } from "@/components/workspace/workspacePath";
import { createPageDeepLink } from "@/core/service/dataFileService/DeepLinkHandler";
import { Settings } from "@/core/service/Settings";
import { WorkspaceManager, type WorkspaceClipboard } from "@/core/service/workspace/WorkspaceManager";
import {
  copyWorkspacePage,
  deleteWorkspacePage,
  demoteWorkspacePage,
  moveWorkspacePage,
  openWorkspacePage,
  promoteWorkspacePage,
  renameWorkspacePage,
} from "@/core/service/workspace/WorkspacePageOps";
import { ComponentTab, Tab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import { createSubWindow } from "@/core/subWindowOpen";
import { activeResourceTabAtom, store, tabsAtom } from "@/state";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import i18next from "i18next";
import { useAtom } from "jotai";
import { FilePlus, FolderOpen, RefreshCcw, SquareArrowOutUpRight } from "lucide-react";
import { isValidElement, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type WorkspaceNode = Awaited<ReturnType<typeof WorkspaceManager.readTree>>[number];

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

export default function WorkspaceWindow() {
  const { t } = useTranslation("workspace");
  const [activeTab] = useAtom(activeResourceTabAtom);
  const [root] = Settings.use("activeWorkspaceRoot");
  const [tree, setTree] = useState<WorkspaceNode[]>([]);
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set());
  const [versionCounts, setVersionCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const [clipboard, setClipboard] = useState<WorkspaceClipboard | null>(null);
  const [moveCopyTarget, setMoveCopyTarget] = useState<WorkspacePageNode | null>(null);
  const [versionsTarget, setVersionsTarget] = useState<WorkspacePageNode | null>(null);

  const activeFsPath = activeTab && "uri" in activeTab ? activeTab.uri.fsPath : undefined;

  const refresh = useCallback(async () => {
    const currentRoot = WorkspaceManager.root;
    if (!currentRoot) {
      setTree([]);
      setVersionCounts(new Map());
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
  }, []);

  useEffect(() => {
    setCollapsedDirs(new Set(readCollapsedDirs(root)));
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

  const promptRename = useCallback(
    async (node: WorkspacePageNode) => {
      const name = await Dialog.input(t("rename"), node.name, { defaultValue: node.name });
      if (name === undefined) return;
      const trimmed = name.trim();
      if (!trimmed) {
        toast.error(t("nameRequired"));
        return;
      }
      if (trimmed === node.name) return;
      await renameWorkspacePage(node.path, trimmed);
    },
    [t],
  );

  const confirmDelete = useCallback(
    async (node: WorkspacePageNode) => {
      const confirmed = await Dialog.confirm(t("deleteConfirmTitle"), t("deleteConfirmBody"), { destructive: true });
      if (!confirmed) return;
      await deleteWorkspacePage(node.path);
    },
    [t],
  );

  const copyLink = useCallback(
    async (node: WorkspacePageNode) => {
      await writeText(createPageDeepLink(node.path));
      toast.success(t("linkCopied"));
    },
    [t],
  );

  const actions = useMemo(
    () => ({
      openPage: (node: WorkspacePageNode) => {
        openWorkspacePage(node.path).catch(reportWorkspaceError);
      },
      toggleDir: (node: Extract<WorkspaceNode, { kind: "dir" }>) => {
        toggleCollapsed(node.path);
      },
      newPage: (dirPath: string) => {
        promptNewPage(dirPath).catch(reportWorkspaceError);
      },
      renamePage: (node: WorkspacePageNode) => {
        promptRename(node).catch(reportWorkspaceError);
      },
      deletePage: (node: WorkspacePageNode) => {
        confirmDelete(node).catch(reportWorkspaceError);
      },
      cutPage: (node: WorkspacePageNode) => {
        WorkspaceManager.cut(node.path);
        setClipboard(WorkspaceManager.clipboard);
      },
      copyPage: (node: WorkspacePageNode) => {
        WorkspaceManager.copy(node.path);
        setClipboard(WorkspaceManager.clipboard);
      },
      paste: (targetDir: string) => {
        WorkspaceManager.paste(targetDir)
          .then(() => refresh())
          .catch(reportWorkspaceError);
      },
      copyLink: (node: WorkspacePageNode) => {
        copyLink(node).catch(reportWorkspaceError);
      },
      moveOrCopy: (node: WorkspacePageNode) => {
        setMoveCopyTarget(node);
      },
      demote: (node: WorkspacePageNode) => {
        demoteWorkspacePage(node.path)
          .then(() => refresh())
          .catch(reportWorkspaceError);
      },
      promote: (node: WorkspacePageNode) => {
        promoteWorkspacePage(node.path)
          .then(() => refresh())
          .catch(reportWorkspaceError);
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
    }),
    [copyLink, confirmDelete, promptNewPage, promptRename, refresh, root, toggleCollapsed],
  );

  const submitMoveCopy = async (mode: WorkspaceMoveCopyMode, targetDir: string) => {
    if (!moveCopyTarget) return;
    if (mode === "move") await moveWorkspacePage(moveCopyTarget.path, targetDir);
    else await copyWorkspacePage(moveCopyTarget.path, targetDir);
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={root}>
          {root
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() || root}
        </span>
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

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        <WorkspaceTree
          nodes={tree}
          root={root}
          collapsedDirs={collapsedDirs}
          activeFsPath={activeFsPath}
          clipboard={clipboard}
          versionCounts={versionCounts}
          actions={actions}
        />
      </div>

      <WorkspaceMoveCopyDialog
        pagePath={moveCopyTarget?.path ?? null}
        pageName={moveCopyTarget?.name ?? ""}
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

WorkspaceWindow.open = () => {
  createSubWindow("WorkspaceWindow", {
    title: i18next.t("workspace.title"),
    contextTarget: "activeResourceTab",
    children: <WorkspaceWindow />,
    rect: new Rectangle(new Vector(100, 100), new Vector(260, 640)),
  });
};

/** 用元素类型识别自己的 tab，避免跟着语言切换或标题文案变化失效 */
function isWorkspaceTab(tab: Tab) {
  if (!(tab instanceof ComponentTab) || !isValidElement(tab.children)) return false;
  return tab.children.type === WorkspaceWindow;
}

/** 与 open() 配对：已开着就关掉，没开才打开 */
WorkspaceWindow.toggle = () => {
  const existing = store.get(tabsAtom).find(isWorkspaceTab);
  if (existing) void TabWorkspace.close(existing.id);
  else WorkspaceWindow.open();
};
