import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Project } from "@/core/Project";
import type {
  StageTableRow,
  StageTableRowKind,
} from "@/core/service/dataManageService/stageTableService/StageTableService";
import {
  ALL_SYSTEM_COLUMN_IDS,
  collectColumnFilterBuckets,
  parseLocalDateKey,
  toLocalDateKey,
  type SystemColumnId,
  type TableColumnFilter,
  type TableColumnSchema,
  type TableSelectOption,
  type TableSortConfig,
  type TableViewType,
} from "@/types/table";
import { cn } from "@/utils/cn";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowDown,
  ArrowDownRight,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  ArrowUpLeft,
  Box,
  Boxes,
  Calendar as CalendarIcon,
  CalendarDays,
  ChartGantt,
  Check,
  ChevronRight,
  CircleDot,
  Clock,
  Crosshair,
  FileCode2,
  Film,
  Filter,
  FolderKanban,
  FunctionSquare,
  Hash,
  History,
  Image as ImageIcon,
  LayoutGrid,
  Link2,
  ListChecks,
  Plus,
  Search,
  Sigma,
  SquareDashed,
  SquareKanban,
  Table2,
  Type,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

export const VIEW_OPTION_BADGE_CLASSES: Record<string, string> = {
  gray: "bg-zinc-500/25 text-zinc-900 dark:bg-zinc-400/30 dark:text-zinc-100",
  purple: "bg-purple-600/85 text-white dark:bg-purple-500/85 dark:text-white",
  blue: "bg-blue-600/85 text-white dark:bg-blue-500/85 dark:text-white",
  green: "bg-emerald-600/85 text-white dark:bg-emerald-500/85 dark:text-white",
  amber: "bg-amber-500/85 text-white dark:bg-amber-500/85 dark:text-white",
  rose: "bg-rose-600/85 text-white dark:bg-rose-500/85 dark:text-white",
  cyan: "bg-cyan-600/85 text-white dark:bg-cyan-500/85 dark:text-white",
  orange: "bg-orange-600/85 text-white dark:bg-orange-500/85 dark:text-white",
};

export const VIEW_OPTION_BAR_CLASSES: Record<string, string> = {
  gray: "bg-zinc-500/35 border-zinc-400/60 text-foreground",
  purple: "bg-purple-600/75 border-purple-400/70 text-white",
  blue: "bg-blue-600/75 border-blue-400/70 text-white",
  green: "bg-emerald-600/75 border-emerald-400/70 text-white",
  amber: "bg-amber-500/80 border-amber-300/70 text-white",
  rose: "bg-rose-600/75 border-rose-400/70 text-white",
  cyan: "bg-cyan-600/75 border-cyan-400/70 text-white",
  orange: "bg-orange-600/75 border-orange-400/70 text-white",
};

export const VIEW_OPTION_PILL_ACCENT_CLASSES: Record<string, string> = {
  gray: "border-l-zinc-400 bg-muted/65",
  purple: "border-l-purple-500 bg-purple-500/15",
  blue: "border-l-blue-500 bg-blue-500/15",
  green: "border-l-emerald-500 bg-emerald-500/15",
  amber: "border-l-amber-500 bg-amber-500/15",
  rose: "border-l-rose-500 bg-rose-500/15",
  cyan: "border-l-cyan-500 bg-cyan-500/15",
  orange: "border-l-orange-500 bg-orange-500/15",
};

export function getViewOptionBadgeClass(color?: string): string {
  return (color && VIEW_OPTION_BADGE_CLASSES[color]) || VIEW_OPTION_BADGE_CLASSES.gray;
}

export function getViewOptionBarClass(color?: string): string {
  return (color && VIEW_OPTION_BAR_CLASSES[color]) || "bg-muted-foreground/30 border-border text-foreground";
}

export function getViewOptionPillAccentClass(color?: string): string {
  return (color && VIEW_OPTION_PILL_ACCENT_CLASSES[color]) || "border-l-primary/70 bg-muted/50";
}

export function isSystemColumnId(colId: string): colId is SystemColumnId {
  return (ALL_SYSTEM_COLUMN_IDS as readonly string[]).includes(colId);
}

export function formatViewTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function getRowDisplayTitle(
  row: { primaryText?: string; label?: string; kind: StageTableRowKind; uuid: string },
  t: (key: string, opts?: Record<string, unknown>) => string,
): { text: string; isPlaceholder: boolean } {
  const raw = (row.primaryText ?? row.label ?? "").trim();
  if (raw.length > 0) return { text: raw, isPlaceholder: false };
  switch (row.kind) {
    case "section":
      return { text: t("fallbackLabels.unnamedSection"), isPlaceholder: true };
    case "image":
      return { text: t("fallbackLabels.image"), isPlaceholder: true };
    case "svg":
      return { text: t("fallbackLabels.svg"), isPlaceholder: true };
    case "media":
      return { text: t("fallbackLabels.media"), isPlaceholder: true };
    case "url":
      return { text: t("fallbackLabels.url"), isPlaceholder: true };
    case "latex":
      return { text: t("fallbackLabels.latex"), isPlaceholder: true };
    case "reference":
      return { text: t("fallbackLabels.reference"), isPlaceholder: true };
    case "text":
    default:
      return { text: t("views.unnamedRecord"), isPlaceholder: true };
  }
}

export function ViewTypeIcon({ type, className }: { type: TableViewType; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  switch (type) {
    case "kanban":
      return <SquareKanban className={cls} />;
    case "gantt":
      return <ChartGantt className={cls} />;
    case "gallery":
      return <LayoutGrid className={cls} />;
    case "calendar":
      return <CalendarDays className={cls} />;
    case "table":
    default:
      return <Table2 className={cls} />;
  }
}

export function StageTableRowKindIcon({ kind, className }: { kind: StageTableRowKind; className?: string }) {
  const cls = cn("size-3.5 shrink-0 text-muted-foreground", className);
  switch (kind) {
    case "section":
      return <SquareDashed className={cls} />;
    case "image":
      return <ImageIcon className={cls} />;
    case "url":
      return <Link2 className={cls} />;
    case "media":
      return <Film className={cls} />;
    case "latex":
      return <Sigma className={cls} />;
    case "reference":
      return <FolderKanban className={cls} />;
    case "svg":
      return <FileCode2 className={cls} />;
    case "extension":
      return <Box className={cls} />;
    case "text":
    default:
      return <Type className={cls} />;
  }
}

export function StageTableColumnIcon({
  columnId,
  customColumn,
  className,
}: {
  columnId: string;
  customColumn?: TableColumnSchema;
  className?: string;
}) {
  const cls = cn("size-3.5 shrink-0 text-muted-foreground", className);
  if (customColumn) {
    switch (customColumn.type) {
      case "number":
        return <Hash className={cls} />;
      case "date":
        return <CalendarIcon className={cls} />;
      case "select":
        return <CircleDot className={cls} />;
      case "multi_select":
        return <ListChecks className={cls} />;
      case "formula":
        return <FunctionSquare className={cls} />;
      case "text":
      default:
        return <Type className={cls} />;
    }
  }
  switch (columnId) {
    case "images":
      return <ImageIcon className={cls} />;
    case "createdAt":
      return <Clock className={cls} />;
    case "updatedAt":
      return <History className={cls} />;
    case "parents":
      return <ArrowUpLeft className={cls} />;
    case "children":
      return <ArrowDownRight className={cls} />;
    case "outer":
      return <Box className={cls} />;
    case "inner":
      return <Boxes className={cls} />;
    case "name":
    default:
      return <Type className={cls} />;
  }
}

export function StageTableAttachmentThumb({
  project,
  attachmentId,
  className,
  onClick,
}: {
  project: Project;
  attachmentId: string;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const blob = project.attachments?.get?.(attachmentId);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== "function") {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL?.(url);
    };
  }, [blob]);

  if (!objectUrl) {
    return (
      <div
        onClick={onClick}
        className={cn(
          "bg-muted text-muted-foreground flex size-7 items-center justify-center rounded border",
          className,
        )}
      >
        <ImageIcon className="size-4 opacity-50" />
      </div>
    );
  }

  return (
    <img
      src={objectUrl}
      alt=""
      onClick={onClick}
      className={cn("border-border/70 size-7 rounded border object-cover", onClick && "cursor-zoom-in", className)}
    />
  );
}

export function StageTableFieldValueDisplay({
  project,
  row,
  columnId,
  customCol,
  onPreviewImage,
  compact = false,
  t,
}: {
  project: Project;
  row: StageTableRow;
  columnId: string;
  customCol?: TableColumnSchema;
  onPreviewImage?: (attachmentId: string, rowUuid?: string) => void;
  compact?: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactElement | null {
  if (columnId === "name") {
    const title = getRowDisplayTitle(row, t);
    return <span className={cn("truncate", title.isPlaceholder && "text-muted-foreground/60")}>{title.text}</span>;
  }
  if (columnId === "images") {
    if (row.images.length === 0) return null;
    const shown = compact ? row.images.slice(0, 2) : row.images.slice(0, 4);
    return (
      <div className="flex flex-wrap items-center gap-1">
        {shown.map((img) => (
          <StageTableAttachmentThumb
            key={img.uuid}
            project={project}
            attachmentId={img.attachmentId}
            className={compact ? "size-5" : "size-6"}
            onClick={
              onPreviewImage
                ? (e) => {
                    e.stopPropagation();
                    onPreviewImage(img.attachmentId, row.uuid);
                  }
                : undefined
            }
          />
        ))}
        {row.images.length > shown.length && (
          <span className="text-muted-foreground text-[10px]">+{row.images.length - shown.length}</span>
        )}
      </div>
    );
  }
  if (columnId === "createdAt") {
    if (!Number.isFinite(row.createdAt) || row.createdAt <= 0) return null;
    return (
      <span className="text-muted-foreground truncate text-[11px] tabular-nums">
        {formatViewTimestamp(row.createdAt)}
      </span>
    );
  }
  if (columnId === "updatedAt") {
    if (!Number.isFinite(row.updatedAt) || row.updatedAt <= 0) return null;
    return (
      <span className="text-muted-foreground truncate text-[11px] tabular-nums">
        {formatViewTimestamp(row.updatedAt)}
      </span>
    );
  }
  if (columnId === "parents" || columnId === "children" || columnId === "inner") {
    const list = row[columnId];
    if (list.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-1">
        {list.slice(0, compact ? 2 : 4).map((item) => (
          <span
            key={item.uuid}
            className="bg-muted text-foreground/90 inline-flex max-w-28 truncate rounded px-1.5 py-0.5 text-[11px]"
          >
            {getRowDisplayTitle(item, t).text}
          </span>
        ))}
        {list.length > (compact ? 2 : 4) && (
          <span className="text-muted-foreground text-[10px]">+{list.length - (compact ? 2 : 4)}</span>
        )}
      </div>
    );
  }
  if (columnId === "outer") {
    if (!row.outer) return null;
    return (
      <span className="bg-muted text-foreground/90 inline-flex max-w-36 truncate rounded px-1.5 py-0.5 text-[11px]">
        {getRowDisplayTitle(row.outer, t).text}
      </span>
    );
  }

  if (!customCol) return null;

  if (customCol.type === "formula") {
    const cell = row.formulaValues?.[customCol.id];
    if (!cell || cell.kind === "empty") return null;
    if (cell.kind === "error") {
      return (
        <span className="bg-destructive/15 text-destructive inline-flex rounded px-1.5 py-0.5 font-mono text-[10px]">
          {cell.errorCode ?? "#ERROR!"}
        </span>
      );
    }
    if (cell.kind === "list" && cell.listItems && cell.listItems.length > 0) {
      return (
        <div className="flex flex-wrap items-center gap-1">
          {cell.listItems.slice(0, 3).map((item, idx) => (
            <span
              key={`${idx}-${item}`}
              className="bg-muted text-foreground inline-flex truncate rounded px-1.5 py-0.5 text-[11px]"
            >
              {item}
            </span>
          ))}
        </div>
      );
    }
    return <span className="text-foreground/90 truncate text-xs tabular-nums">{cell.displayText}</span>;
  }

  const raw = row.tableFields?.[customCol.id];
  if (raw === undefined || raw === null || raw === "") return null;

  if (customCol.type === "select" || customCol.type === "multi_select") {
    const optMap = new Map((customCol.options ?? []).map((o) => [o.id, o]));
    const ids = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const matched = ids.map((id) => optMap.get(id)).filter((o): o is TableSelectOption => Boolean(o));
    if (matched.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-1">
        {matched.map((opt) => (
          <span
            key={opt.id}
            className={cn(
              "inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-[11px] leading-tight font-medium",
              getViewOptionBadgeClass(opt.color),
            )}
          >
            {opt.name}
          </span>
        ))}
      </div>
    );
  }

  if (customCol.type === "number") {
    return typeof raw === "number" && Number.isFinite(raw) ? (
      <span className="text-foreground/90 truncate text-xs tabular-nums">{String(raw)}</span>
    ) : null;
  }

  const text = Array.isArray(raw) ? raw.join(", ") : String(raw);
  if (!text.trim()) return null;
  return <span className="text-foreground/90 line-clamp-2 text-xs break-words">{text}</span>;
}

export function StageTableFieldVisibilityList({
  allColumnIds,
  customColumnMap,
  getColumnLabel,
  isColumnVisible,
  onToggleColumn,
  t,
}: {
  allColumnIds: readonly string[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  getColumnLabel: (colId: string) => string;
  isColumnVisible: (colId: string) => boolean;
  onToggleColumn: (colId: string, visible: boolean) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [search, setSearch] = useState("");
  const filtered = allColumnIds.filter((cid) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return getColumnLabel(cid).toLowerCase().includes(q);
  });

  return (
    <div>
      <div className="mb-1.5">
        <div className="relative flex items-center">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 size-3" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={t("propertiesPopover.searchPlaceholder")}
            className="h-7 pl-6 text-xs"
          />
        </div>
      </div>
      <div className="max-h-52 space-y-0.5 overflow-y-auto">
        {filtered.map((colId) => {
          const isPrimary = colId === "name";
          const checked = isColumnVisible(colId);
          return (
            <label
              key={colId}
              className={cn(
                "hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs select-none",
                isPrimary && "cursor-default opacity-80",
              )}
            >
              <Checkbox
                checked={checked}
                disabled={isPrimary}
                onCheckedChange={(val) => {
                  if (!isPrimary) onToggleColumn(colId, Boolean(val));
                }}
              />
              <StageTableColumnIcon columnId={colId} customColumn={customColumnMap.get(colId)} />
              <span className="min-w-0 flex-1 truncate">{getColumnLabel(colId)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function StageTableFilterToolbarPopover({
  allColumnIds,
  customColumnMap,
  allRows,
  activeFilters,
  getColumnLabel,
  onSetColumnFilter,
  onClearAllFilters,
  t,
}: {
  allColumnIds: readonly string[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  allRows: readonly StageTableRow[];
  activeFilters: readonly TableColumnFilter[];
  getColumnLabel: (colId: string) => string;
  onSetColumnFilter: (columnId: string, filter: { values: string[]; includeEmpty: boolean } | null) => void;
  onClearAllFilters: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [selectedColId, setSelectedColId] = useState<string | null>(null);
  const [bucketSearch, setBucketSearch] = useState("");
  const activeFilterMap = useMemo(() => new Map(activeFilters.map((f) => [f.columnId, f])), [activeFilters]);

  const selectedCol = selectedColId ? customColumnMap.get(selectedColId) : undefined;
  const bucketData = useMemo(() => {
    if (!selectedColId) return null;
    return collectColumnFilterBuckets(allRows, selectedColId, selectedCol);
  }, [allRows, selectedColId, selectedCol]);

  const activeColFilter = selectedColId ? (activeFilterMap.get(selectedColId) ?? null) : null;

  const commitBucketChange = (nextValues: Set<string>, nextIncludeEmpty: boolean) => {
    if (!selectedColId || !bucketData) return;
    const allBucketKeys = bucketData.buckets.map((b) => b.key);
    const allSelected =
      allBucketKeys.every((k) => nextValues.has(k)) && (bucketData.emptyCount === 0 || nextIncludeEmpty);
    if (allSelected) {
      onSetColumnFilter(selectedColId, null);
    } else {
      onSetColumnFilter(selectedColId, {
        values: Array.from(nextValues),
        includeEmpty: nextIncludeEmpty,
      });
    }
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) {
          setSelectedColId(null);
          setBucketSearch("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-stage-table-filter-toolbar
          className={cn(
            "hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors",
            activeFilters.length > 0
              ? "bg-primary/15 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Filter className="size-3.5" />
          <span>
            {activeFilters.length > 0 ? `${t("toolbar.filter")} (${activeFilters.length})` : t("toolbar.filter")}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-2 text-xs select-none"
        onWheel={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {!selectedColId ? (
          <>
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-muted-foreground text-[11px] font-medium">{t("sortFilter.filterTitle")}</span>
              {activeFilters.length > 0 && (
                <button
                  type="button"
                  onClick={onClearAllFilters}
                  className="text-primary cursor-pointer text-[11px] hover:underline"
                >
                  {t("sortFilter.clearAllFilters")}
                </button>
              )}
            </div>
            {activeFilters.length === 0 && (
              <div className="text-muted-foreground mb-1.5 px-1 text-[11px]">{t("sortFilter.noActiveFilters")}</div>
            )}
            <div className="max-h-60 space-y-0.5 overflow-y-auto">
              {allColumnIds.map((cid) => {
                const hasFilter = activeFilterMap.has(cid);
                return (
                  <div
                    key={cid}
                    className="hover:bg-accent flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedColId(cid);
                        setBucketSearch("");
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    >
                      <StageTableColumnIcon columnId={cid} customColumn={customColumnMap.get(cid)} />
                      <span className={cn("min-w-0 flex-1 truncate", hasFilter && "text-primary font-medium")}>
                        {getColumnLabel(cid)}
                      </span>
                      <ChevronRight className="text-muted-foreground size-3 shrink-0" />
                    </button>
                    {hasFilter && (
                      <button
                        type="button"
                        aria-label={t("sortFilter.clearFilter")}
                        onClick={() => onSetColumnFilter(cid, null)}
                        className="text-muted-foreground hover:text-foreground cursor-pointer rounded p-0.5"
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          bucketData && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedColId(null)}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-5 cursor-pointer items-center justify-center rounded"
                >
                  <ArrowLeft className="size-3.5" />
                </button>
                <StageTableColumnIcon columnId={selectedColId} customColumn={selectedCol} />
                <span className="min-w-0 flex-1 truncate font-medium">{getColumnLabel(selectedColId)}</span>
                {activeColFilter && (
                  <button
                    type="button"
                    onClick={() => onSetColumnFilter(selectedColId, null)}
                    className="text-primary cursor-pointer text-[11px] hover:underline"
                  >
                    {t("sortFilter.clearFilter")}
                  </button>
                )}
              </div>
              <div className="relative mb-1.5 flex items-center">
                <Search className="text-muted-foreground pointer-events-none absolute left-2 size-3" />
                <Input
                  value={bucketSearch}
                  onChange={(e) => setBucketSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t("sortFilter.searchPlaceholder")}
                  className="h-7 pl-6 text-xs"
                />
              </div>
              <div className="max-h-52 space-y-0.5 overflow-y-auto">
                {(() => {
                  const selectedSet = new Set(
                    activeColFilter ? activeColFilter.values : bucketData.buckets.map((b) => b.key),
                  );
                  const includeEmpty = activeColFilter ? activeColFilter.includeEmpty : true;
                  const allSelected =
                    bucketData.buckets.every((b) => selectedSet.has(b.key)) &&
                    (bucketData.emptyCount === 0 || includeEmpty);
                  const q = bucketSearch.trim().toLowerCase();
                  const visibleBuckets = bucketData.buckets.filter((b) => !q || b.label.toLowerCase().includes(q));
                  return (
                    <>
                      <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              onSetColumnFilter(selectedColId, null);
                            } else {
                              onSetColumnFilter(selectedColId, { values: [], includeEmpty: false });
                            }
                          }}
                        />
                        <span className="font-medium">{t("sortFilter.selectAll")}</span>
                      </label>
                      {bucketData.emptyCount > 0 && (!q || t("sortFilter.emptyValue").toLowerCase().includes(q)) && (
                        <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs">
                          <Checkbox
                            checked={includeEmpty}
                            onCheckedChange={(checked) => {
                              commitBucketChange(new Set(selectedSet), Boolean(checked));
                            }}
                          />
                          <span className="text-muted-foreground min-w-0 flex-1 truncate italic">
                            {t("sortFilter.emptyValue")}
                          </span>
                          <span className="text-muted-foreground text-[10px] tabular-nums">
                            {bucketData.emptyCount}
                          </span>
                        </label>
                      )}
                      {visibleBuckets.map((bucket) => {
                        const checked = selectedSet.has(bucket.key);
                        return (
                          <label
                            key={bucket.key}
                            className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(val) => {
                                const next = new Set(selectedSet);
                                if (val) next.add(bucket.key);
                                else next.delete(bucket.key);
                                commitBucketChange(next, includeEmpty);
                              }}
                            />
                            {bucket.color ? (
                              <span
                                className={cn(
                                  "min-w-0 truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
                                  getViewOptionBadgeClass(bucket.color),
                                )}
                              >
                                {bucket.label}
                              </span>
                            ) : (
                              <span className="min-w-0 flex-1 truncate">{bucket.label}</span>
                            )}
                            <span className="text-muted-foreground ml-auto text-[10px] tabular-nums">
                              {bucket.count}
                            </span>
                          </label>
                        );
                      })}
                    </>
                  );
                })()}
              </div>
            </div>
          )
        )}
      </PopoverContent>
    </Popover>
  );
}

export function StageTableSortToolbarPopover({
  allColumnIds,
  customColumnMap,
  activeSort,
  getColumnLabel,
  onSetSort,
  t,
}: {
  allColumnIds: readonly string[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  activeSort: TableSortConfig | null;
  getColumnLabel: (colId: string) => string;
  onSetSort: (sort: TableSortConfig | null) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-stage-table-sort-toolbar
          className={cn(
            "hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors",
            activeSort ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <ArrowUpDown className="size-3.5" />
          <span>
            {activeSort
              ? `${t("toolbar.sort")}: ${getColumnLabel(activeSort.columnId)} ${activeSort.direction === "asc" ? "↑" : "↓"}`
              : t("toolbar.sort")}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-2 text-xs select-none"
        onWheel={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-muted-foreground text-[11px] font-medium">{t("sortFilter.sortTitle")}</span>
          {activeSort && (
            <button
              type="button"
              onClick={() => onSetSort(null)}
              className="text-primary cursor-pointer text-[11px] hover:underline"
            >
              {t("sortFilter.clearSort")}
            </button>
          )}
        </div>
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {allColumnIds.map((cid) => {
            const isAsc = activeSort?.columnId === cid && activeSort.direction === "asc";
            const isDesc = activeSort?.columnId === cid && activeSort.direction === "desc";
            return (
              <div key={cid} className="hover:bg-accent/60 flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs">
                <StageTableColumnIcon columnId={cid} customColumn={customColumnMap.get(cid)} />
                <span className={cn("min-w-0 flex-1 truncate", (isAsc || isDesc) && "text-primary font-medium")}>
                  {getColumnLabel(cid)}
                </span>
                <button
                  type="button"
                  aria-label={t("sortFilter.sortAsc")}
                  onClick={() => onSetSort(isAsc ? null : { columnId: cid, direction: "asc" })}
                  className={cn(
                    "flex size-6 cursor-pointer items-center justify-center rounded border transition-colors",
                    isAsc
                      ? "border-primary bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-background hover:text-foreground border-transparent",
                  )}
                >
                  <ArrowUp className="size-3" />
                </button>
                <button
                  type="button"
                  aria-label={t("sortFilter.sortDesc")}
                  onClick={() => onSetSort(isDesc ? null : { columnId: cid, direction: "desc" })}
                  className={cn(
                    "flex size-6 cursor-pointer items-center justify-center rounded border transition-colors",
                    isDesc
                      ? "border-primary bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-background hover:text-foreground border-transparent",
                  )}
                >
                  <ArrowDown className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function StageTableRecordDialog({
  project,
  row,
  customColumns,
  getColumnLabel,
  onClose,
  onPreviewImage,
  onOpenFormulaEditor,
  t,
}: {
  project: Project;
  row: StageTableRow | null;
  customColumns: readonly TableColumnSchema[];
  getColumnLabel: (colId: string) => string;
  onClose: () => void;
  onPreviewImage: (attachmentId: string, rowUuid?: string) => void;
  onOpenFormulaEditor?: (colId: string, rowUuid: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [titleDraft, setTitleDraft] = useState("");
  const [selectQueryByCol, setSelectQueryByCol] = useState<Record<string, string>>({});
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitleDraft(row?.primaryText ?? "");
    setSelectQueryByCol({});
  }, [row?.uuid, row?.primaryText]);

  return (
    <DialogPrimitive.Root
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <DialogPrimitive.Content
          data-stage-table-record-dialog
          onWheel={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="bg-popover text-popover-foreground border-border fixed top-1/2 left-1/2 z-50 flex max-h-[82vh] w-[520px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border shadow-2xl outline-none"
        >
          {row && (
            <>
              <div className="border-border/60 flex items-center gap-2 border-b px-4 py-3">
                <StageTableRowKindIcon kind={row.kind} className="size-4" />
                <DialogPrimitive.Title className="sr-only">{getRowDisplayTitle(row, t).text}</DialogPrimitive.Title>
                {row.editableText ? (
                  <Input
                    data-record-dialog-title-input
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={() => {
                      if (titleDraft !== row.primaryText) {
                        project.stageTable.updateRowPrimaryText(row.uuid, titleDraft);
                      }
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (titleDraft !== row.primaryText) {
                          project.stageTable.updateRowPrimaryText(row.uuid, titleDraft);
                        }
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder={t("views.unnamedRecord")}
                    className="hover:border-border focus-visible:border-primary h-8 flex-1 border-transparent bg-transparent px-1.5 text-sm font-semibold shadow-none"
                  />
                ) : (
                  <span className="flex-1 truncate text-sm font-semibold">{getRowDisplayTitle(row, t).text}</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => project.stageTable.focusRowOnCanvas(row.uuid)}
                  className="h-7 gap-1 px-2 text-xs"
                >
                  <Crosshair className="size-3.5" />
                  <span>{t("jumpToNode")}</span>
                </Button>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
                {/* 系统图片属性 */}
                <div className="grid grid-cols-[120px_1fr] items-start gap-2">
                  <div className="text-muted-foreground flex items-center gap-1.5 pt-1">
                    <ImageIcon className="size-3.5" />
                    <span className="truncate">{getColumnLabel("images")}</span>
                  </div>
                  <div
                    className="flex flex-wrap items-center gap-1.5"
                    onPaste={(e) => {
                      if (row.canEditImages === false) return;
                      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
                      if (files.length > 0) {
                        e.preventDefault();
                        void project.stageTable.addRowImages?.(row.uuid, files);
                      }
                    }}
                  >
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const selected = Array.from(e.target.files ?? []);
                        if (selected.length > 0) {
                          void project.stageTable.addRowImages?.(row.uuid, selected);
                        }
                        e.target.value = "";
                      }}
                    />
                    {row.images.map((img) => (
                      <div key={img.uuid} className="group/rthumb relative inline-flex">
                        <StageTableAttachmentThumb
                          project={project}
                          attachmentId={img.attachmentId}
                          className="size-12 rounded-md"
                          onClick={() => onPreviewImage(img.attachmentId, row.uuid)}
                        />
                        {row.canEditImages !== false && (
                          <button
                            type="button"
                            onClick={() => project.stageTable.removeRowImage?.(row.uuid, img.uuid)}
                            className="bg-background/90 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground border-border absolute -top-1 -right-1 flex size-4 cursor-pointer items-center justify-center rounded-full border opacity-0 shadow-xs transition-opacity group-hover/rthumb:opacity-100"
                          >
                            <X className="size-2.5" />
                          </button>
                        )}
                      </div>
                    ))}
                    {row.canEditImages !== false && (
                      <button
                        type="button"
                        onClick={() => imageInputRef.current?.click()}
                        className="border-border hover:border-primary/60 hover:bg-accent text-muted-foreground hover:text-foreground inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-dashed px-2.5 text-xs transition-colors"
                      >
                        <Plus className="size-3.5" />
                        <span>{t("imagesCell.add")}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* 自定义属性列 */}
                {customColumns.map((col) => {
                  const raw = row.tableFields?.[col.id];
                  return (
                    <div key={col.id} className="grid grid-cols-[120px_1fr] items-start gap-2">
                      <div className="text-muted-foreground flex items-center gap-1.5 pt-1.5">
                        <StageTableColumnIcon columnId={col.id} customColumn={col} />
                        <span className="truncate" title={col.name}>
                          {col.name}
                        </span>
                      </div>
                      <div className="min-w-0">
                        {col.type === "text" && (
                          <Input
                            key={`${row.uuid}-${col.id}-${String(raw ?? "")}`}
                            defaultValue={typeof raw === "string" ? raw : ""}
                            onBlur={(e) => {
                              const next = e.target.value;
                              if (next !== (typeof raw === "string" ? raw : "")) {
                                project.stageTable.updateRowCustomField(row.uuid, col.id, next || null);
                              }
                            }}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter") {
                                e.currentTarget.blur();
                              }
                            }}
                            className="h-8 text-xs"
                          />
                        )}

                        {col.type === "number" && (
                          <Input
                            key={`${row.uuid}-${col.id}-${String(raw ?? "")}`}
                            type="number"
                            defaultValue={typeof raw === "number" && Number.isFinite(raw) ? String(raw) : ""}
                            onBlur={(e) => {
                              const trimmed = e.target.value.trim();
                              if (!trimmed) {
                                project.stageTable.updateRowCustomField(row.uuid, col.id, null);
                                return;
                              }
                              const num = Number(trimmed);
                              if (Number.isFinite(num)) {
                                project.stageTable.updateRowCustomField(row.uuid, col.id, num);
                              }
                            }}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter") e.currentTarget.blur();
                            }}
                            className="h-8 text-xs tabular-nums"
                          />
                        )}

                        {col.type === "date" && (
                          <div className="flex items-center gap-1.5">
                            <Popover>
                              <PopoverTrigger asChild>
                                <button
                                  type="button"
                                  className="border-border bg-background/60 hover:bg-accent flex h-8 flex-1 cursor-pointer items-center justify-between rounded-md border px-2.5 text-left text-xs tabular-nums"
                                >
                                  <span className={cn(!raw && "text-muted-foreground/60")}>
                                    {typeof raw === "string" && raw ? raw : t("views.pickDate")}
                                  </span>
                                  <CalendarIcon className="text-muted-foreground size-3.5" />
                                </button>
                              </PopoverTrigger>
                              <PopoverContent
                                align="start"
                                className="w-auto p-2"
                                onWheel={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                              >
                                <Calendar
                                  mode="single"
                                  selected={typeof raw === "string" ? (parseLocalDateKey(raw) ?? undefined) : undefined}
                                  onSelect={(day) => {
                                    project.stageTable.updateRowCustomField(
                                      row.uuid,
                                      col.id,
                                      day ? toLocalDateKey(day) : null,
                                    );
                                  }}
                                />
                              </PopoverContent>
                            </Popover>
                            {typeof raw === "string" && raw && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => project.stageTable.updateRowCustomField(row.uuid, col.id, null)}
                                className="h-8 px-2 text-xs"
                              >
                                {t("dateCell.clear")}
                              </Button>
                            )}
                          </div>
                        )}

                        {(col.type === "select" || col.type === "multi_select") &&
                          (() => {
                            const selectedIds =
                              col.type === "multi_select"
                                ? Array.isArray(raw)
                                  ? raw
                                  : typeof raw === "string"
                                    ? [raw]
                                    : []
                                : typeof raw === "string"
                                  ? [raw]
                                  : [];
                            const options = col.options ?? [];
                            const query = selectQueryByCol[col.id] ?? "";
                            const filteredOpts = options.filter(
                              (o) => !query.trim() || o.name.toLowerCase().includes(query.trim().toLowerCase()),
                            );
                            const exactExists = options.some(
                              (o) => o.name.toLowerCase() === query.trim().toLowerCase(),
                            );
                            return (
                              <Popover>
                                <PopoverTrigger asChild>
                                  <button
                                    type="button"
                                    className="border-border bg-background/60 hover:bg-accent flex min-h-8 w-full cursor-pointer flex-wrap items-center gap-1 rounded-md border px-2 py-1 text-left"
                                  >
                                    {selectedIds.length === 0 ? (
                                      <span className="text-muted-foreground/60 text-xs">
                                        {t("selectCell.searchOrAddPlaceholder")}
                                      </span>
                                    ) : (
                                      selectedIds.map((id) => {
                                        const opt = options.find((o) => o.id === id);
                                        if (!opt) return null;
                                        return (
                                          <span
                                            key={opt.id}
                                            className={cn(
                                              "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
                                              getViewOptionBadgeClass(opt.color),
                                            )}
                                          >
                                            {opt.name}
                                          </span>
                                        );
                                      })
                                    )}
                                  </button>
                                </PopoverTrigger>
                                <PopoverContent
                                  align="start"
                                  className="w-60 p-2 text-xs"
                                  onWheel={(e) => e.stopPropagation()}
                                  onMouseDown={(e) => e.stopPropagation()}
                                >
                                  <Input
                                    value={query}
                                    onChange={(e) =>
                                      setSelectQueryByCol((prev) => ({ ...prev, [col.id]: e.target.value }))
                                    }
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === "Enter" && query.trim()) {
                                        e.preventDefault();
                                        const opt = project.stageTable.createOrGetSelectOption?.(col.id, query.trim());
                                        if (opt) {
                                          if (col.type === "multi_select") {
                                            const next = Array.from(new Set([...selectedIds, opt.id]));
                                            project.stageTable.updateRowCustomField(row.uuid, col.id, next);
                                          } else {
                                            project.stageTable.updateRowCustomField(row.uuid, col.id, opt.id);
                                          }
                                          setSelectQueryByCol((prev) => ({ ...prev, [col.id]: "" }));
                                        }
                                      }
                                    }}
                                    placeholder={t("selectCell.searchOrAddPlaceholder")}
                                    className="mb-1.5 h-7 text-xs"
                                  />
                                  <div className="max-h-44 space-y-0.5 overflow-y-auto">
                                    {filteredOpts.map((opt) => {
                                      const active = selectedIds.includes(opt.id);
                                      return (
                                        <button
                                          key={opt.id}
                                          type="button"
                                          onClick={() => {
                                            if (col.type === "multi_select") {
                                              const next = active
                                                ? selectedIds.filter((id) => id !== opt.id)
                                                : [...selectedIds, opt.id];
                                              project.stageTable.updateRowCustomField(
                                                row.uuid,
                                                col.id,
                                                next.length > 0 ? next : null,
                                              );
                                            } else {
                                              project.stageTable.updateRowCustomField(
                                                row.uuid,
                                                col.id,
                                                active ? null : opt.id,
                                              );
                                            }
                                          }}
                                          className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-1.5 py-1"
                                        >
                                          <span
                                            className={cn(
                                              "rounded px-1.5 py-0.5 text-[11px] font-medium",
                                              getViewOptionBadgeClass(opt.color),
                                            )}
                                          >
                                            {opt.name}
                                          </span>
                                          {active && <Check className="text-primary size-3.5" />}
                                        </button>
                                      );
                                    })}
                                    {query.trim() && !exactExists && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const opt = project.stageTable.createOrGetSelectOption?.(
                                            col.id,
                                            query.trim(),
                                          );
                                          if (opt) {
                                            if (col.type === "multi_select") {
                                              project.stageTable.updateRowCustomField(
                                                row.uuid,
                                                col.id,
                                                Array.from(new Set([...selectedIds, opt.id])),
                                              );
                                            } else {
                                              project.stageTable.updateRowCustomField(row.uuid, col.id, opt.id);
                                            }
                                            setSelectQueryByCol((prev) => ({ ...prev, [col.id]: "" }));
                                          }
                                        }}
                                        className="hover:bg-accent text-primary flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left"
                                      >
                                        <Plus className="size-3" />
                                        <span>
                                          {t("selectCell.createPrefix")} &ldquo;{query.trim()}&rdquo;
                                        </span>
                                      </button>
                                    )}
                                  </div>
                                </PopoverContent>
                              </Popover>
                            );
                          })()}

                        {col.type === "formula" && (
                          <div className="bg-muted/40 border-border/60 flex min-h-8 items-center justify-between gap-2 rounded-md border px-2.5 py-1">
                            <StageTableFieldValueDisplay
                              project={project}
                              row={row}
                              columnId={col.id}
                              customCol={col}
                              t={t}
                            />
                            {onOpenFormulaEditor && (
                              <button
                                type="button"
                                onClick={() => onOpenFormulaEditor(col.id, row.uuid)}
                                className="text-primary shrink-0 cursor-pointer text-[11px] hover:underline"
                              >
                                {t("formulaEditor.editFormula")}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* 拓扑关系与时间只读摘要 */}
                <div className="border-border/50 space-y-2 border-t pt-2.5">
                  {(["parents", "children", "outer", "inner"] as const).map((relCol) => {
                    const valueEl = <StageTableFieldValueDisplay project={project} row={row} columnId={relCol} t={t} />;
                    const hasVal = relCol === "outer" ? Boolean(row.outer) : row[relCol].length > 0;
                    if (!hasVal) return null;
                    return (
                      <div key={relCol} className="grid grid-cols-[120px_1fr] items-start gap-2">
                        <div className="text-muted-foreground flex items-center gap-1.5 pt-0.5">
                          <StageTableColumnIcon columnId={relCol} />
                          <span className="truncate">{getColumnLabel(relCol)}</span>
                        </div>
                        <div>{valueEl}</div>
                      </div>
                    );
                  })}
                  <div className="text-muted-foreground grid grid-cols-[120px_1fr] items-center gap-2 text-[11px]">
                    <span className="flex items-center gap-1.5">
                      <Clock className="size-3.5" />
                      {getColumnLabel("createdAt")}
                    </span>
                    <span className="tabular-nums">{formatViewTimestamp(row.createdAt)}</span>
                  </div>
                  <div className="text-muted-foreground grid grid-cols-[120px_1fr] items-center gap-2 text-[11px]">
                    <span className="flex items-center gap-1.5">
                      <History className="size-3.5" />
                      {getColumnLabel("updatedAt")}
                    </span>
                    <span className="tabular-nums">{formatViewTimestamp(row.updatedAt)}</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
