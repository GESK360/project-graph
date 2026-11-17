import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WorkspaceManager } from "@/core/service/workspace/WorkspaceManager";
import { openVersionAsCopy, reloadWorkspacePage } from "@/core/service/workspace/WorkspacePageOps";
import { cn } from "@/utils/cn";
import { History, RotateCcw, SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { reportWorkspaceError } from "./workspacePath";

export interface WorkspaceVersionEntry {
  id: string;
  time: number;
  filePath: string;
}

export default function WorkspaceVersionsDialog({
  pagePath,
  pageName,
  onClose,
}: {
  pagePath: string | null;
  pageName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [versions, setVersions] = useState<WorkspaceVersionEntry[]>([]);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!pagePath) return;
    setVersions([]);
    WorkspaceManager.listVersions(pagePath)
      .then((list) => setVersions([...list].sort((a, b) => b.time - a.time)))
      .catch(reportWorkspaceError);
  }, [pagePath]);

  if (!pagePath) return <></>;

  const restore = async (version: WorkspaceVersionEntry) => {
    setBusyVersion(version.id);
    try {
      await WorkspaceManager.restoreVersion(pagePath, version.id);
      // 页面开着时内存里还是旧内容，下一次自动保存会把刚恢复的版本覆盖回去
      await reloadWorkspacePage(pagePath);
      toast.success(t("versionRestored"));
      onClose();
    } finally {
      setBusyVersion(null);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("showVersions")}</DialogTitle>
        </DialogHeader>

        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <History className="size-3.5" />
          <span className="truncate">{pageName}</span>
        </div>

        <div className="max-h-80 overflow-y-auto rounded-md border">
          {versions.length === 0 && (
            <div className="text-muted-foreground px-3 py-6 text-center text-xs">{t("versionsEmpty")}</div>
          )}
          {versions.map((version) => (
            <div
              key={version.id}
              className={cn(
                "hover:bg-accent/40 flex items-center gap-2 border-b px-2 py-1.5 text-xs last:border-b-0",
                busyVersion === version.id && "opacity-60",
              )}
            >
              <span className="truncate tabular-nums">{new Date(version.time).toLocaleString()}</span>
              <div className="ml-auto flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  disabled={busyVersion !== null}
                  onClick={() => restore(version).catch(reportWorkspaceError)}
                >
                  <RotateCcw className="size-3.5" />
                  {t("restore")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  disabled={busyVersion !== null}
                  onClick={() => openVersionAsCopy(version.filePath).catch(reportWorkspaceError)}
                >
                  <SquareArrowOutUpRight className="size-3.5" />
                  {t("openAsCopy")}
                </Button>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
