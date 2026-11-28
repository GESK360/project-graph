import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LegacyScanReport } from "@/core/sqlite/DocClient";
import {
  migrateWorkspaceLegacyPrg,
  type WorkspaceMigrationProgress,
  type WorkspaceMigrationResult,
} from "@/core/sqlite/V2ToV3Migrator";
import { AlertCircle, CheckCircle2, Database, FolderArchive, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function UpgradeV3Dialog({
  report,
  onClose,
  onCompleted,
}: {
  report: LegacyScanReport | null;
  onClose: () => void;
  onCompleted?: (result: WorkspaceMigrationResult) => void;
}) {
  const { t } = useTranslation("workspace");
  const [phase, setPhase] = useState<"prompt" | "running" | "done">("prompt");
  const [progress, setProgress] = useState<WorkspaceMigrationProgress | null>(null);
  const [result, setResult] = useState<WorkspaceMigrationResult | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  if (!report) return null;

  const totalCount = report.files.length;
  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;

  const startMigration = async () => {
    setPhase("running");
    setFatalError(null);
    setProgress({
      phase: "backing_up",
      completed: 0,
      total: totalCount,
    });
    try {
      const res = await migrateWorkspaceLegacyPrg(report, (next) => {
        setProgress(next);
      });
      setResult(res);
      setPhase("done");
      onCompleted?.(res);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
      setPhase("done");
    }
  };

  const handleDismiss = () => {
    if (phase === "running") return;
    setPhase("prompt");
    setProgress(null);
    setResult(null);
    setFatalError(null);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleDismiss();
      }}
    >
      <DialogContent className="sm:max-w-lg" onPointerDownOutside={(e) => phase === "running" && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="text-primary size-4" />
            {t("upgradeV3.title")}
          </DialogTitle>
          <DialogDescription>
            {t("upgradeV3.description", {
              count: totalCount,
              size: formatBytes(report.totalBytes),
            })}
          </DialogDescription>
        </DialogHeader>

        {phase === "prompt" && (
          <div className="space-y-3 text-xs">
            <div className="bg-muted/60 flex items-start gap-2 rounded-md border p-2.5">
              <FolderArchive className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <div className="text-muted-foreground space-y-1">
                <div>{t("upgradeV3.backupHint")}</div>
                <div className="font-mono text-[11px] opacity-85">.flux-graph/backup-v2/&lt;timestamp&gt;/</div>
              </div>
            </div>

            <div className="max-h-48 overflow-y-auto rounded-md border">
              {report.files.slice(0, 50).map((item) => (
                <div
                  key={item.path}
                  className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5 last:border-b-0"
                >
                  <span className="truncate font-mono text-[11px]">{item.relPath}</span>
                  <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                    {formatBytes(item.sizeBytes)}
                  </span>
                </div>
              ))}
              {report.files.length > 50 && (
                <div className="text-muted-foreground px-2.5 py-1.5 text-center text-[11px]">
                  {t("upgradeV3.moreFiles", { count: report.files.length - 50 })}
                </div>
              )}
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="space-y-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <Loader2 className="text-primary size-4 animate-spin" />
              <span>
                {progress?.phase === "backing_up"
                  ? t("upgradeV3.backingUp")
                  : t("upgradeV3.migratingFile", {
                      completed: progress?.completed ?? 0,
                      total: progress?.total ?? totalCount,
                      file: progress?.currentFile ?? "",
                    })}
              </span>
            </div>
            <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-all duration-150"
                style={{ width: `${progress?.phase === "backing_up" ? 8 : Math.max(8, percent)}%` }}
              />
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="space-y-3 text-xs">
            {fatalError ? (
              <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border p-2.5">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <div className="break-all">{fatalError}</div>
              </div>
            ) : result ? (
              <>
                <div className="bg-muted/50 flex items-start gap-2 rounded-md border p-2.5">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  <div className="space-y-1">
                    <div>
                      {t("upgradeV3.summary", {
                        succeeded: result.succeeded.length,
                        failed: result.failed.length,
                      })}
                    </div>
                    <div className="text-muted-foreground font-mono text-[11px] break-all">
                      {t("upgradeV3.backupSavedAt", { dir: result.backupDir })}
                    </div>
                  </div>
                </div>
                {result.failed.length > 0 && (
                  <div className="border-destructive/30 max-h-40 overflow-y-auto rounded-md border">
                    {result.failed.map((item) => (
                      <div key={item.path} className="border-b px-2.5 py-1.5 last:border-b-0">
                        <div className="font-mono text-[11px] font-medium">{item.relPath}</div>
                        <div className="text-destructive text-[11px] break-all">{item.error}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {phase === "prompt" && (
            <>
              <Button variant="ghost" onClick={handleDismiss}>
                {t("upgradeV3.later")}
              </Button>
              <Button onClick={() => void startMigration()}>{t("upgradeV3.confirmUpgrade")}</Button>
            </>
          )}
          {phase === "running" && (
            <Button disabled>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              {t("upgradeV3.upgrading")}
            </Button>
          )}
          {phase === "done" && <Button onClick={handleDismiss}>{t("upgradeV3.done")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
