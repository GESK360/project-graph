import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WorkspaceManager, WorkspacePaths, type WorkspaceNode } from "@/core/service/workspace/WorkspaceManager";
import { cn } from "@/utils/cn";
import { Folder, FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { mkdir } from "@tauri-apps/plugin-fs";
import { reportWorkspaceError, workspaceDirOf } from "./workspacePath";

export type WorkspaceMoveCopyMode = "move" | "copy";

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
  pagePath,
  pageName,
  onClose,
  onSubmit,
}: {
  pagePath: string | null;
  pageName: string;
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
    if (!pagePath) return;
    setMode("move");
    setSelected(workspaceDirOf(pagePath));
    setCreatingFolder(false);
    setNewFolderName("");
    refreshDirs().catch(reportWorkspaceError);
  }, [pagePath]);

  if (!pagePath) return <></>;

  const root = WorkspaceManager.root;
  const createFolder = async () => {
    if (!root) return;
    const name = newFolderName.trim();
    if (!name) return;
    const parent = selected || root;
    const target = WorkspacePaths.join(parent, name);
    await mkdir(target, { recursive: true });
    setNewFolderName("");
    setCreatingFolder(false);
    await refreshDirs();
    setSelected(target);
    // 新目录也要出现在左边的树里
    WorkspaceManager.emit("change");
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
          <span className="text-muted-foreground">{pageName}</span>
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
              onClick={() => setSelected(root ?? "")}
              className={cn(
                "hover:bg-accent/50 flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs",
                selected === (root ?? "") && "bg-accent/60",
              )}
            >
              <Folder className="text-muted-foreground size-3.5 shrink-0" />
              <span className="truncate">{root}</span>
            </button>
            {dirs.map((dir) => (
              <button
                key={dir.path}
                type="button"
                style={{ paddingLeft: 8 + dir.depth * 12 }}
                onClick={() => setSelected(dir.path)}
                className={cn(
                  "hover:bg-accent/50 flex h-7 w-full items-center gap-1.5 rounded-sm pr-2 text-left text-xs",
                  selected === dir.path && "bg-accent/60",
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
              placeholder={t("newFolder")}
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
            {t("newFolder")}
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
