import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WorkspaceManager, WorkspacePaths, type WorkspaceNode } from "@/core/service/workspace/WorkspaceManager";
import { cn } from "@/utils/cn";
import { Folder, FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { reportWorkspaceError, workspaceDirOf } from "./workspacePath";

export type WorkspaceMoveCopyMode = "move" | "copy";

/** 工作空间里只有页面是 .prg，其余都是目录 */
function isPageLike(path: string) {
  return WorkspacePaths.normalize(path).toLowerCase().endsWith(".prg");
}

interface DirEntry {
  name: string;
  path: string;
  depth: number;
}

function collectDirs(nodes: WorkspaceNode[], depth: number, into: DirEntry[]) {
  for (const node of nodes) {
    if (node.kind !== "dir") continue;
    into.push({ name: node.name, path: node.path, depth });
    collectDirs(node.children, depth + 1, into);
  }
}

export default function WorkspaceMoveCopyDialog({
  paths,
  label,
  initialMode,
  onClose,
  onSubmit,
}: {
  /** 要移动/复制的节点；为空时对话框不显示 */
  paths: string[] | null;
  label: string;
  initialMode: WorkspaceMoveCopyMode;
  onClose: () => void;
  onSubmit: (mode: WorkspaceMoveCopyMode, targetDir: string) => Promise<void>;
}) {
  const { t } = useTranslation("workspace");
  const [mode, setMode] = useState<WorkspaceMoveCopyMode>("move");
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshDirs = async () => {
    const nodes = await WorkspaceManager.readTree();
    const collected: DirEntry[] = [];
    collectDirs(nodes, 0, collected);
    setDirs(collected);
  };

  useEffect(() => {
    if (!paths) return;
    setMode(initialMode);
    setSelected(workspaceDirOf(paths[0]));
    setCreatingFolder(false);
    setNewFolderName("");
    refreshDirs().catch(reportWorkspaceError);
  }, [paths, initialMode]);

  if (!paths || paths.length === 0) return <></>;

  const root = WorkspaceManager.root;

  /** 目录不能移进自己或自己的子树，这类目标直接禁掉，不用等 Manager 抛错 */
  const isForbiddenTarget = (dirPath: string) =>
    mode === "move" && paths.some((path) => !isPageLike(path) && WorkspacePaths.isInside(dirPath, path));

  const createFolder = async () => {
    if (!root) return;
    const name = newFolderName.trim();
    if (!name) return;
    const parent = selected || root;
    const target = await WorkspaceManager.createFolder(parent, name);
    setNewFolderName("");
    setCreatingFolder(false);
    await refreshDirs();
    setSelected(target);
  };

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await onSubmit(mode, selected);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("moveOrCopy")}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-1 text-xs">
          <span className="text-muted-foreground max-w-40 truncate">{label}</span>
          <span className="text-muted-foreground/60">→</span>
          <span className="truncate font-medium">{selected || root}</span>
        </div>

        <div className="flex gap-2">
          <Button size="sm" variant={mode === "move" ? "default" : "outline"} onClick={() => setMode("move")}>
            {t("move")}
          </Button>
          <Button size="sm" variant={mode === "copy" ? "default" : "outline"} onClick={() => setMode("copy")}>
            {t("copyMode")}
          </Button>
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="text-muted-foreground text-xs">{t("targetFolder")}</div>
          <div className="max-h-64 overflow-y-auto rounded-md border p-1">
            <button
              type="button"
              disabled={isForbiddenTarget(root ?? "")}
              onClick={() => setSelected(root ?? "")}
              className={cn(
                "hover:bg-accent/50 flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs",
                selected === (root ?? "") && "bg-accent/60",
                isForbiddenTarget(root ?? "") && "opacity-40",
              )}
            >
              <Folder className="text-muted-foreground size-3.5 shrink-0" />
              <span className="truncate">{root}</span>
            </button>
            {dirs.map((dir) => (
              <button
                key={dir.path}
                type="button"
                disabled={isForbiddenTarget(dir.path)}
                style={{ paddingLeft: 8 + dir.depth * 12 }}
                onClick={() => setSelected(dir.path)}
                className={cn(
                  "hover:bg-accent/50 flex h-7 w-full items-center gap-1.5 rounded-sm pr-2 text-left text-xs",
                  selected === dir.path && "bg-accent/60",
                  isForbiddenTarget(dir.path) && "opacity-40",
                )}
              >
                <Folder className="text-muted-foreground size-3.5 shrink-0" />
                <span className="truncate">{dir.name}</span>
              </button>
            ))}
          </div>
        </div>

        {creatingFolder ? (
          <div className="flex gap-2">
            <Input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t("newFolderName")}
              className="h-8 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") createFolder().catch(reportWorkspaceError);
                if (e.key === "Escape") setCreatingFolder(false);
              }}
            />
            <Button size="sm" variant="outline" onClick={() => createFolder().catch(reportWorkspaceError)}>
              {t("confirm")}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setCreatingFolder(true)}>
            <FolderPlus />
            {t("createFolder")}
          </Button>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button disabled={!selected || busy} onClick={() => submit().catch(reportWorkspaceError)}>
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
