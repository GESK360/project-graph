import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { StageTableColumnIcon } from "@/components/stage-table-views-shared";
import { WorkspaceClient, type WorkspaceColumnRecord } from "@/core/sqlite/WorkspaceClient";
import { CREATABLE_CUSTOM_COLUMN_TYPES, type CustomColumnType } from "@/types/table";
import { cn } from "@/utils/cn";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowUpRight, Combine, Layers, Lock, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

const MERGEABLE_TYPES: readonly CustomColumnType[] = ["text", "number", "date", "select", "multi_select"];

/**
 * 工作空间共享字段管理弹窗：
 * - 查看工作空间内所有已对齐字段（受保护间隔重复字段 / 显式共享 `ws:*` / 同名自动对齐 `auto:*`）
 * - 新建跨文件共享字段 (`ws:<uuid>`)
 * - 将 `auto:*` 升级为稳定 `ws:<uuid>` 共享字段（重命名不再丢失跨文件对齐）
 * - 将多个同类型字段合并为同一个共享字段（批量迁移所有相关 `.prg` 文件）
 */
export function WorkspaceColumnsDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const { t } = useTranslation("stageTable");
  const [columns, setColumns] = useState<WorkspaceColumnRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<CustomColumnType>("text");
  const [mergeTargetName, setMergeTargetName] = useState("");

  const loadColumns = useCallback(async () => {
    if (!WorkspaceClient.isAvailable()) return;
    setLoading(true);
    try {
      const list = await WorkspaceClient.listColumns();
      setColumns(list);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setSelectedKeys(new Set());
      setMergeTargetName("");
      void loadColumns();
    }
  }, [open, loadColumns]);

  const selectedRecords = useMemo(
    () => columns.filter((c) => selectedKeys.has(c.canonicalKey)),
    [columns, selectedKeys],
  );

  const canMergeSelected = useMemo(() => {
    if (selectedRecords.length < 2) return false;
    const firstType = selectedRecords[0].type;
    if (!MERGEABLE_TYPES.includes(firstType as CustomColumnType)) return false;
    return selectedRecords.every((c) => c.type === firstType && !c.canonicalKey.startsWith("role:sr:"));
  }, [selectedRecords]);

  useEffect(() => {
    if (selectedRecords.length >= 2 && !mergeTargetName) {
      setMergeTargetName(selectedRecords[0].name);
    }
  }, [selectedRecords, mergeTargetName]);

  const handleCreateShared = async () => {
    const clean = newName.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      const cfg = newType === "select" || newType === "multi_select" ? JSON.stringify({ options: [] }) : "{}";
      await WorkspaceClient.createSharedColumn(clean, newType, cfg);
      setNewName("");
      await loadColumns();
      onChanged?.();
      toast.success(t("workspaceColumns.createdToast", { name: clean }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handlePromote = async (col: WorkspaceColumnRecord) => {
    if (busy) return;
    setBusy(true);
    try {
      await WorkspaceClient.promoteColumnToShared(col.canonicalKey, col.name);
      await loadColumns();
      onChanged?.();
      toast.success(t("workspaceColumns.promotedToast", { name: col.name }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleMerge = async () => {
    if (!canMergeSelected || busy) return;
    const targetName = mergeTargetName.trim() || selectedRecords[0].name;
    setBusy(true);
    try {
      await WorkspaceClient.mergeColumns(
        selectedRecords.map((r) => r.canonicalKey),
        targetName,
      );
      setSelectedKeys(new Set());
      setMergeTargetName("");
      await loadColumns();
      onChanged?.();
      toast.success(t("workspaceColumns.mergedToast", { name: targetName }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <DialogPrimitive.Content
          data-workspace-columns-dialog
          onWheel={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="bg-popover text-popover-foreground border-border fixed top-1/2 left-1/2 z-50 flex max-h-[82vh] w-[600px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border shadow-2xl outline-none"
        >
          <div className="border-border/60 flex items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Layers className="text-primary size-4" />
              <DialogPrimitive.Title className="text-sm font-semibold">
                {t("workspaceColumns.title")}
              </DialogPrimitive.Title>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="refresh"
                onClick={() => void loadColumns()}
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md"
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          <div className="border-border/50 bg-muted/25 space-y-2 border-b px-4 py-3 text-xs">
            <div className="text-muted-foreground text-[11px]">{t("workspaceColumns.description")}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                data-ws-new-col-name
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreateShared();
                  }
                }}
                placeholder={t("workspaceColumns.newColumnPlaceholder")}
                className="h-7 min-w-40 flex-1 text-xs"
              />
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as CustomColumnType)}
                className="border-border bg-background h-7 rounded-md border px-2 text-xs outline-none"
              >
                {CREATABLE_CUSTOM_COLUMN_TYPES.filter((tp) => tp !== "formula").map((tp) => (
                  <option key={tp} value={tp}>
                    {t(`columnTypes.${tp}`)}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                disabled={!newName.trim() || busy}
                onClick={() => void handleCreateShared()}
                className="h-7 gap-1 px-2.5 text-xs"
              >
                <Plus className="size-3.5" />
                <span>{t("workspaceColumns.createShared")}</span>
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2.5 text-xs">
            {columns.length === 0 ? (
              <div className="text-muted-foreground py-10 text-center text-xs">
                {loading ? "..." : t("workspaceColumns.empty")}
              </div>
            ) : (
              <div className="space-y-1">
                {columns.map((col) => {
                  const isProtected = col.canonicalKey.startsWith("role:sr:");
                  const isShared = col.isShared || col.canonicalKey.startsWith("ws:");
                  const canSelectForMerge = !isProtected && MERGEABLE_TYPES.includes(col.type as CustomColumnType);
                  const checked = selectedKeys.has(col.canonicalKey);

                  return (
                    <div
                      key={col.canonicalKey}
                      className={cn(
                        "border-border/50 hover:bg-accent/40 flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors",
                        checked && "border-primary/50 bg-primary/5",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={!canSelectForMerge}
                        onCheckedChange={() => toggleSelect(col.canonicalKey)}
                      />
                      <StageTableColumnIcon
                        columnId={col.canonicalKey}
                        customColumn={{ id: col.canonicalKey, name: col.name, type: col.type as CustomColumnType }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{col.name}</span>
                          <span className="text-muted-foreground text-[10px]">
                            ({t(`columnTypes.${col.type as CustomColumnType}`)})
                          </span>
                        </div>
                      </div>

                      {isProtected ? (
                        <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]">
                          <Lock className="size-2.5" />
                          <span>{t("workspaceColumns.badgeProtected")}</span>
                        </span>
                      ) : isShared ? (
                        <span className="bg-primary/15 text-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
                          <Sparkles className="size-2.5" />
                          <span>{t("workspaceColumns.badgeShared")}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                          {t("workspaceColumns.badgeAuto")}
                        </span>
                      )}

                      <span className="text-muted-foreground w-16 shrink-0 text-right text-[11px] tabular-nums">
                        {t("workspaceColumns.docCount", { count: col.docCount })}
                      </span>

                      {!isProtected && !isShared ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void handlePromote(col)}
                          className="h-6 gap-1 px-2 text-[11px]"
                        >
                          <ArrowUpRight className="size-3" />
                          <span>{t("workspaceColumns.promote")}</span>
                        </Button>
                      ) : (
                        <div className="w-[82px] shrink-0" />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {selectedRecords.length >= 2 && (
            <div className="border-border/60 bg-muted/35 flex flex-wrap items-center gap-2 border-t px-4 py-2.5 text-xs">
              <Combine className="text-primary size-4 shrink-0" />
              {canMergeSelected ? (
                <>
                  <span className="text-muted-foreground">
                    {t("workspaceColumns.mergeSelectedCount", { count: selectedRecords.length })}
                  </span>
                  <Input
                    value={mergeTargetName}
                    onChange={(e) => setMergeTargetName(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={t("workspaceColumns.mergeTargetPlaceholder")}
                    className="h-7 min-w-36 flex-1 text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleMerge()}
                    className="h-7 px-3 text-xs"
                  >
                    {t("workspaceColumns.mergeAction")}
                  </Button>
                </>
              ) : (
                <span className="text-destructive text-[11px]">{t("workspaceColumns.mergeTypeMismatch")}</span>
              )}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
