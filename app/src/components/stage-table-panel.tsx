import { ImageLightbox, type ImageLightboxItem } from "@/components/image-lightbox";
import { StageTableCalendarView } from "@/components/stage-table-calendar-view";
import {
  StageTableCellEditorPortal,
  StageTableVirtualRow,
  formatTimestamp,
  getDisplayLabel,
  getOptionBadgeClass,
  type ActiveCellEditorState,
  type StageTableVirtualRowCallbacks,
} from "@/components/stage-table-cell-editor-portal";
import { StageTableFilterToolbarPopover } from "@/components/stage-table-filter-popover";
import {
  FormulaPillPreview,
  StageTableFormulaEditorDialog,
  type FormulaEditorColumnOption,
} from "@/components/stage-table-formula-editor";
import { StageTableGalleryView } from "@/components/stage-table-gallery-view";
import { StageTableGanttView } from "@/components/stage-table-gantt-view";
import { StageTableKanbanView } from "@/components/stage-table-kanban-view";
import { TableScrollContainer, createSafeObserveElementRect } from "@/components/stage-table-scroll-container";

const OBSERVE_TABLE_VIRTUAL_RECT = createSafeObserveElementRect({ width: 1000, height: 600 });
import {
  EMPTY_TABLE_SELECTION,
  StageTableSelectionStore,
  extractRowIdsFromCellKeys,
  makeTableCellKey,
  useIsColumnSelected,
  useSelectedRowIdsSnapshot,
  useTableSelectionBadgeInfo,
  useTableSelectionMode,
} from "@/components/stage-table-selection-store";
import { StageTableSpacedRepetitionView } from "@/components/stage-table-spaced-repetition-view";
import { StageTableRecordDialog, ViewTypeIcon } from "@/components/stage-table-views-shared";
import { WorkspaceColumnsDialog } from "@/components/workspace/WorkspaceColumnsDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Project } from "@/core/Project";
import { registerMidnightVolatileWatcher } from "@/core/service/dataManageService/stageTableService/FormulaDagEngine";
import type { StageTableRow } from "@/core/service/dataManageService/stageTableService/StageTableService";
import {
  createSingleFileTableSource,
  type RelationColumnKind,
  type TableDataSource,
} from "@/core/service/dataManageService/stageTableService/TableDataSource";
import {
  createWorkspaceTableSource,
  type WorkspaceTableSource,
} from "@/core/service/dataManageService/stageTableService/WorkspaceTableSource";
import { hasVolatileFormulas } from "@/core/service/dataManageService/stageTableService/formulaEngine";
import { WorkspaceClient } from "@/core/sqlite/WorkspaceClient";
import {
  ALL_SYSTEM_COLUMN_IDS,
  ALL_WORKSPACE_SYSTEM_COLUMN_IDS,
  TABLE_VIEW_TYPES,
  collectColumnFilterBuckets,
  countActiveFilterConditions,
  isFilterConditionActive,
  isProtectedTableColumn,
  type AnySystemColumnId,
  type ColumnFilterBucket,
  type CustomColumnType,
  type SystemColumnId,
  type TableColumnFilter,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableFilterGroup,
  type TableRowHeight,
  type TableSortConfig,
  type TableSortDirection,
  type TableViewSchema,
  type TableViewType,
  type WorkspaceTableScope,
} from "@/types/table";
import { cn } from "@/utils/cn";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpLeft,
  Boxes,
  Calendar as CalendarIcon,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Clock,
  CopyPlus,
  EyeOff,
  FileText,
  Filter,
  Folder,
  FolderPlus,
  FunctionSquare,
  Globe,
  Hash,
  History,
  Image as ImageIcon,
  Info,
  Layers,
  List,
  ListChecks,
  ListTree,
  Lock,
  MoreVertical,
  Pencil,
  Plus,
  PlusCircle,
  Search,
  SquareDashed,
  SquarePen,
  Trash2,
  Type,
  UnfoldHorizontal,
  UnfoldVertical,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const INDEX_COLUMN_WIDTH = 44;
const ADD_COLUMN_WIDTH = 40;
const SQLITE_PAGE_CHUNK_SIZE = 250;

const DEFAULT_SYSTEM_COLUMN_WIDTHS: Record<AnySystemColumnId, number> = {
  name: 220,
  sourceFile: 170,
  sourceFolder: 160,
  images: 170,
  createdAt: 164,
  updatedAt: 164,
  parents: 190,
  children: 190,
  outer: 170,
  inner: 190,
};

const DEFAULT_CUSTOM_COLUMN_WIDTHS: Record<CustomColumnType, number> = {
  text: 170,
  number: 130,
  date: 150,
  select: 165,
  multi_select: 195,
  formula: 160,
};

const FIELD_TYPE_GRID_ORDER: readonly CustomColumnType[] = [
  "text",
  "select",
  "multi_select",
  "number",
  "date",
  "formula",
];

function isSystemColumnId(colId: string): colId is AnySystemColumnId {
  return (ALL_WORKSPACE_SYSTEM_COLUMN_IDS as readonly string[]).includes(colId);
}

function SystemPropertyIcon({ columnId }: { columnId: AnySystemColumnId }) {
  const cls = "size-3.5 shrink-0 text-muted-foreground";
  switch (columnId) {
    case "sourceFile":
      return <FileText className={cls} />;
    case "sourceFolder":
      return <Folder className={cls} />;
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
      return <SquareDashed className={cls} />;
    case "inner":
      return <Boxes className={cls} />;
    case "name":
    default:
      return <Info className={cls} />;
  }
}

function CustomColumnIcon({ type, className }: { type: CustomColumnType; className?: string }) {
  const cls = cn("size-3.5 shrink-0 text-muted-foreground", className);
  switch (type) {
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

function ColumnIcon({ columnId, customColumn }: { columnId: string; customColumn?: TableColumnSchema }) {
  if (customColumn) {
    return <CustomColumnIcon type={customColumn.type} />;
  }
  if (isSystemColumnId(columnId)) {
    return <SystemPropertyIcon columnId={columnId} />;
  }
  return <Type className="text-muted-foreground size-3.5 shrink-0" />;
}

function FreezeColumnIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5 shrink-0", className)}
    >
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <line x1="7.5" y1="2" x2="7.5" y2="14" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <line x1="2.6" y1="6.8" x2="6.8" y2="2.6" />
      <line x1="2.6" y1="12.8" x2="6.8" y2="8.6" />
    </svg>
  );
}

/**
 * 图 2 & 图 4 双列字段类型选择面板（支持全部 6 类自定义字段，含公式）
 */
function FieldTypeGridPicker({
  selectedType,
  onSelectType,
  showTabNextHint = false,
  t,
}: {
  selectedType: CustomColumnType;
  onSelectType: (type: CustomColumnType) => void;
  showTabNextHint?: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="w-60 select-none">
      <div className="text-muted-foreground px-2.5 pt-2 pb-1 text-[11px] font-medium">{t("fieldTypePicker.title")}</div>
      <div className="grid grid-cols-2 gap-1 px-1.5 pb-1.5">
        {FIELD_TYPE_GRID_ORDER.map((type) => {
          const active = selectedType === type;
          return (
            <button
              key={type}
              type="button"
              data-field-type-option={type}
              onClick={() => onSelectType(type)}
              className={cn(
                "hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                active && "bg-accent text-accent-foreground font-medium",
              )}
            >
              <CustomColumnIcon type={type} className={cn(active && "text-foreground")} />
              <span className="truncate">{t(`columnTypes.${type}`)}</span>
            </button>
          );
        })}
      </div>
      <div className="border-border/60 text-muted-foreground flex items-center gap-3 border-t px-2.5 py-1.5 text-[11px]">
        <span>↑↓ {t("fieldTypePicker.navHint")}</span>
        <span>↵ {t("fieldTypePicker.confirmHint")}</span>
        {showTabNextHint && <span>Tab {t("fieldTypePicker.tabAddNext")}</span>}
      </div>
    </div>
  );
}

interface SuperHeaderSegment {
  key: string;
  group: TableColumnGroup | null;
  colIds: string[];
  isFrozen: boolean;
  stickyLeftPx?: number;
  isFreezeBoundary: boolean;
}

function ColumnFilterSortPopoverContent({
  columnId,
  customCol,
  allRows,
  dataSource,
  activeSort,
  activeFilter,
  onSetSort,
  onSetFilter,
  t,
}: {
  columnId: string;
  customCol?: TableColumnSchema;
  allRows: readonly StageTableRow[];
  dataSource: TableDataSource;
  activeSort: TableSortConfig | null;
  activeFilter: TableColumnFilter | null;
  onSetSort: (sort: TableSortConfig | null) => void;
  onSetFilter: (filter: { values: string[]; includeEmpty: boolean } | null) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [search, setSearch] = useState("");
  const isSqlite = dataSource.isSqliteBacked();

  const syncFallback = useMemo(
    () =>
      isSqlite
        ? { buckets: [] as ColumnFilterBucket[], emptyCount: 0 }
        : collectColumnFilterBuckets(allRows, columnId, customCol),
    [isSqlite, allRows, columnId, customCol],
  );

  const [remoteBuckets, setRemoteBuckets] = useState<{
    buckets: ColumnFilterBucket[];
    emptyCount: number;
  } | null>(null);

  useEffect(() => {
    if (!isSqlite) {
      setRemoteBuckets(null);
      return;
    }
    let cancelled = false;
    void dataSource.queryFilterBuckets({ columnId, limit: 500 }).then((res) => {
      if (cancelled) return;
      setRemoteBuckets({ buckets: res.buckets, emptyCount: res.emptyCount });
    });
    return () => {
      cancelled = true;
    };
  }, [isSqlite, dataSource, columnId]);

  const { buckets, emptyCount } = remoteBuckets ?? syncFallback;

  const isSortAsc = activeSort?.columnId === columnId && activeSort.direction === "asc";
  const isSortDesc = activeSort?.columnId === columnId && activeSort.direction === "desc";
  const isSortedHere = isSortAsc || isSortDesc;

  const allKeys = useMemo(() => buckets.map((b) => b.key), [buckets]);
  const selectedKeySet = useMemo(() => {
    if (!activeFilter) return new Set(allKeys);
    return new Set(activeFilter.values);
  }, [activeFilter, allKeys]);
  const includeEmpty = activeFilter ? activeFilter.includeEmpty : true;

  const formatBucketLabel = useCallback(
    (key: string, label: string) => {
      if (columnId === "images") {
        return t("imagesCell.countLabel", { count: Number(key) });
      }
      return label;
    },
    [columnId, t],
  );

  const emptyLabel = columnId === "images" ? t("imagesCell.emptyLabel") : t("sortFilter.emptyValue");

  const trimmedSearch = search.trim().toLowerCase();
  const visibleBuckets = useMemo(() => {
    if (!trimmedSearch) return buckets;
    return buckets.filter((b) => formatBucketLabel(b.key, b.label).toLowerCase().includes(trimmedSearch));
  }, [buckets, trimmedSearch, formatBucketLabel]);
  const showEmptyRow = emptyCount > 0 && (!trimmedSearch || emptyLabel.toLowerCase().includes(trimmedSearch));

  const commitFilter = (nextKeys: Set<string>, nextIncludeEmpty: boolean) => {
    const allNonEmptyChecked = allKeys.every((k) => nextKeys.has(k));
    const emptySatisfied = emptyCount === 0 || nextIncludeEmpty;
    if (allNonEmptyChecked && emptySatisfied) {
      onSetFilter(null);
    } else {
      onSetFilter({
        values: allKeys.filter((k) => nextKeys.has(k)),
        includeEmpty: emptyCount > 0 ? nextIncludeEmpty : false,
      });
    }
  };

  const toggleBucket = (key: string) => {
    const next = new Set(selectedKeySet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commitFilter(next, includeEmpty);
  };

  const toggleEmpty = () => {
    commitFilter(new Set(selectedKeySet), !includeEmpty);
  };

  const allVisibleChecked = visibleBuckets.every((b) => selectedKeySet.has(b.key)) && (!showEmptyRow || includeEmpty);
  const someVisibleChecked = visibleBuckets.some((b) => selectedKeySet.has(b.key)) || (showEmptyRow && includeEmpty);

  const toggleSelectAllVisible = () => {
    const next = new Set(selectedKeySet);
    let nextEmpty = includeEmpty;
    if (allVisibleChecked) {
      for (const b of visibleBuckets) next.delete(b.key);
      if (showEmptyRow) nextEmpty = false;
    } else {
      for (const b of visibleBuckets) next.add(b.key);
      if (showEmptyRow) nextEmpty = true;
    }
    commitFilter(next, nextEmpty);
  };

  const isOptionType = customCol?.type === "select" || customCol?.type === "multi_select";

  return (
    <div data-col-filter-popover={columnId} className="w-60 p-2 text-xs select-none">
      {/* 排序区：升序 / 降序 */}
      <div className="mb-2 space-y-1">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-muted-foreground text-[11px] font-medium">{t("sortFilter.sortTitle")}</span>
          {isSortedHere && (
            <button
              type="button"
              data-col-clear-sort
              onClick={() => onSetSort(null)}
              className="text-muted-foreground hover:text-foreground cursor-pointer text-[11px] transition-colors"
            >
              {t("sortFilter.clearSort")}
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            data-col-sort-asc
            onClick={() => onSetSort(isSortAsc ? null : { columnId, direction: "asc" })}
            className={cn(
              "flex h-7 cursor-pointer items-center justify-center gap-1 rounded-md border text-xs transition-colors",
              isSortAsc
                ? "border-primary bg-primary/15 text-primary font-medium"
                : "border-border/70 hover:bg-accent text-foreground",
            )}
          >
            <ArrowUp className="size-3.5" />
            <span>{t("sortFilter.sortAsc")}</span>
          </button>
          <button
            type="button"
            data-col-sort-desc
            onClick={() => onSetSort(isSortDesc ? null : { columnId, direction: "desc" })}
            className={cn(
              "flex h-7 cursor-pointer items-center justify-center gap-1 rounded-md border text-xs transition-colors",
              isSortDesc
                ? "border-primary bg-primary/15 text-primary font-medium"
                : "border-border/70 hover:bg-accent text-foreground",
            )}
          >
            <ArrowDown className="size-3.5" />
            <span>{t("sortFilter.sortDesc")}</span>
          </button>
        </div>
      </div>

      {/* 筛选区：值复选列表 */}
      <div className="border-border/60 border-t pt-2">
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <span className="text-muted-foreground text-[11px] font-medium">{t("sortFilter.filterTitle")}</span>
          {activeFilter && (
            <button
              type="button"
              data-col-clear-filter
              onClick={() => onSetFilter(null)}
              className="text-primary cursor-pointer text-[11px] hover:underline"
            >
              {t("sortFilter.clearFilter")}
            </button>
          )}
        </div>

        <div className="relative mb-1.5 flex items-center">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 size-3.5" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={t("sortFilter.searchPlaceholder")}
            className="h-7 pl-7 text-xs"
          />
        </div>

        <label className="hover:bg-accent mb-1 flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs font-medium">
          <Checkbox
            checked={allVisibleChecked ? true : someVisibleChecked ? "indeterminate" : false}
            onCheckedChange={toggleSelectAllVisible}
          />
          <span className="truncate">{t("sortFilter.selectAll")}</span>
        </label>

        <div className="max-h-48 space-y-0.5 overflow-y-auto pr-0.5">
          {visibleBuckets.map((bucket) => {
            const checked = selectedKeySet.has(bucket.key);
            const displayLabel = formatBucketLabel(bucket.key, bucket.label);
            return (
              <label
                key={bucket.key}
                data-col-filter-option={bucket.key}
                className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs"
              >
                <Checkbox checked={checked} onCheckedChange={() => toggleBucket(bucket.key)} />
                {isOptionType ? (
                  <span
                    className={cn(
                      "inline-flex max-w-[140px] items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
                      getOptionBadgeClass(bucket.color),
                    )}
                  >
                    <span className="truncate">{displayLabel}</span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate" title={displayLabel}>
                    {displayLabel}
                  </span>
                )}
                <span className="text-muted-foreground ml-auto shrink-0 text-[11px] tabular-nums">{bucket.count}</span>
              </label>
            );
          })}

          {showEmptyRow && (
            <label
              data-col-filter-empty
              className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs"
            >
              <Checkbox checked={includeEmpty} onCheckedChange={toggleEmpty} />
              <span className="text-muted-foreground min-w-0 flex-1 truncate italic">{emptyLabel}</span>
              <span className="text-muted-foreground ml-auto shrink-0 text-[11px] tabular-nums">{emptyCount}</span>
            </label>
          )}

          {visibleBuckets.length === 0 && !showEmptyRow && (
            <div className="text-muted-foreground py-3 text-center text-xs">{t("noMatchingNodes")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// 原子化订阅选中状态的局部 Header / Badge 子组件（避免 StageTablePanel 顶层因选中态变动全表重渲染）

function SelectAllHeaderCell({
  selectionStore,
  frozenEndIndex,
  title,
  onToggleSelectAll,
}: {
  selectionStore: StageTableSelectionStore;
  frozenEndIndex: number;
  title: string;
  onToggleSelectAll: () => void;
}) {
  const mode = useTableSelectionMode(selectionStore);
  return (
    <th
      data-stage-table-select-all
      title={title}
      onClick={onToggleSelectAll}
      style={frozenEndIndex >= 0 ? { left: "0px" } : undefined}
      className={cn(
        "border-border/50 bg-muted hover:bg-accent/70 h-9 cursor-pointer border-r px-1 text-center text-[11px] font-medium transition-colors select-none",
        mode === "all"
          ? "text-primary after:bg-primary/18 font-semibold after:pointer-events-none after:absolute after:inset-0"
          : "text-muted-foreground/70",
        frozenEndIndex >= 0 ? "sticky z-30" : "relative",
      )}
    >
      #
    </th>
  );
}

function SelectionSummaryBadge({
  selectionStore,
  totalRowCount,
  onClear,
  t,
}: {
  selectionStore: StageTableSelectionStore;
  totalRowCount: number;
  onClear: (clearCanvas: boolean) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const { mode, count } = useTableSelectionBadgeInfo(selectionStore);
  const summaryText =
    mode === "all"
      ? t("selection.allSelected", { count: totalRowCount })
      : mode === "rows" && count > 0
        ? t("selection.rowsCount", { count })
        : mode === "columns" && count > 0
          ? t("selection.colsCount", { count })
          : mode === "cells" && count > 0
            ? t("selection.cellsCount", { count })
            : null;

  if (!summaryText) return null;

  return (
    <div
      data-stage-table-selection-badge
      className="bg-primary/12 text-primary ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium select-none"
    >
      <span>{summaryText}</span>
      <button
        type="button"
        aria-label={t("dateCell.clear")}
        onClick={() => onClear(mode === "rows" || mode === "all" || mode === "cells")}
        className="hover:bg-primary/20 cursor-pointer rounded-full p-0.5 transition-colors"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function SelectableColumnHeaderCell({
  colId,
  colIdx,
  selectionStore,
  isFrozen,
  isFreezeBoundary,
  stickyLeftPx,
  isNameCol,
  isCreatingThis,
  isDraggingThis,
  colSortDir,
  isColFiltered,
  isFilterMenuOpen,
  onPointerDown,
  children,
}: {
  colId: string;
  colIdx: number;
  selectionStore: StageTableSelectionStore;
  isFrozen: boolean;
  isFreezeBoundary: boolean;
  stickyLeftPx: number;
  isNameCol: boolean;
  isCreatingThis: boolean;
  isDraggingThis: boolean;
  colSortDir: TableSortDirection | null;
  isColFiltered: boolean;
  isFilterMenuOpen: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  children: React.ReactNode;
}) {
  const isColSelected = useIsColumnSelected(selectionStore, colId);
  return (
    <th
      data-table-col-id={colId}
      data-col-idx={colIdx}
      data-col-selected={isColSelected ? "true" : undefined}
      data-col-sort={colSortDir ?? undefined}
      data-col-filtered={isColFiltered ? "true" : undefined}
      style={isFrozen ? { left: `${stickyLeftPx}px` } : undefined}
      onPointerDown={onPointerDown}
      className={cn(
        "group/th border-border/50 bg-muted text-muted-foreground h-9 border-r p-0 font-medium select-none",
        !isNameCol && !isCreatingThis ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        isDraggingThis && "bg-accent/60 opacity-60",
        isFrozen ? "sticky z-30" : "relative",
        isFreezeBoundary && "border-r-primary/45 border-r-2",
        (colSortDir || isColFiltered) && "text-foreground",
        isColSelected &&
          "text-foreground after:bg-primary/15 after:border-b-primary after:pointer-events-none after:absolute after:inset-0 after:border-b-2",
        !isColSelected &&
          (colSortDir || isColFiltered || isFilterMenuOpen) &&
          "after:bg-primary/10 after:pointer-events-none after:absolute after:inset-0",
      )}
    >
      {children}
    </th>
  );
}

/**
 * 非表格视图路由容器：仅在激活看板/甘特/画册/日历/间隔重复视图时才订阅选中行快照，
 * 保证主表格视图下选中变更对顶层 `StageTablePanel` 为 0 次重渲染。
 */
function NonTableViewBridge({
  activeViewType,
  project,
  dataSource,
  dataRevision,
  selectionStore,
  activeView,
  allRows,
  rows,
  allColumnIds,
  filterableColumnIds,
  filterColumnGroups,
  visibleColumnIds,
  customColumns,
  customColumnMap,
  activeFilters,
  activeFilterGroup,
  activeSort,
  getColumnLabel,
  onSelectRows,
  onOpenRecord,
  onPreviewImage,
  onOpenFormulaEditor,
  t,
}: {
  activeViewType: Exclude<TableViewType, "table">;
  project?: Project | null;
  dataSource: TableDataSource;
  dataRevision: number;
  selectionStore: StageTableSelectionStore;
  activeView: TableViewSchema;
  allRows: readonly StageTableRow[];
  rows: readonly StageTableRow[];
  allColumnIds: readonly string[];
  filterableColumnIds: readonly string[];
  filterColumnGroups: readonly TableColumnGroup[];
  visibleColumnIds: readonly string[];
  customColumns: readonly TableColumnSchema[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  activeFilters: readonly TableColumnFilter[];
  activeFilterGroup: TableFilterGroup;
  activeSort: TableSortConfig | null;
  getColumnLabel: (colId: string) => string;
  onSelectRows: (uuids: string[], focusCamera?: boolean) => void;
  onOpenRecord: (rowUuid: string, row?: StageTableRow) => void;
  onPreviewImage: (attachmentId: string, rowUuid?: string, docId?: string) => void;
  onOpenFormulaEditor: (colId: string, rowUuid: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const selectedRowIds = useSelectedRowIdsSnapshot(selectionStore);

  if (activeViewType === "kanban") {
    return (
      <StageTableKanbanView
        project={project}
        dataSource={dataSource}
        dataRevision={dataRevision}
        activeView={activeView}
        allRows={allRows}
        rows={rows}
        allColumnIds={allColumnIds}
        filterableColumnIds={filterableColumnIds}
        filterColumnGroups={filterColumnGroups}
        visibleColumnIds={visibleColumnIds}
        customColumns={customColumns}
        customColumnMap={customColumnMap}
        activeFilters={activeFilters}
        activeFilterGroup={activeFilterGroup}
        activeSort={activeSort}
        selectedRowIds={selectedRowIds}
        getColumnLabel={getColumnLabel}
        onSelectRows={onSelectRows}
        onOpenRecord={onOpenRecord}
        onPreviewImage={onPreviewImage}
        t={t}
      />
    );
  }
  if (activeViewType === "gantt") {
    return (
      <StageTableGanttView
        project={project}
        dataSource={dataSource}
        dataRevision={dataRevision}
        activeView={activeView}
        allRows={allRows}
        rows={rows}
        allColumnIds={allColumnIds}
        filterableColumnIds={filterableColumnIds}
        filterColumnGroups={filterColumnGroups}
        visibleColumnIds={visibleColumnIds}
        customColumns={customColumns}
        customColumnMap={customColumnMap}
        activeFilters={activeFilters}
        activeFilterGroup={activeFilterGroup}
        activeSort={activeSort}
        selectedRowIds={selectedRowIds}
        getColumnLabel={getColumnLabel}
        onSelectRows={onSelectRows}
        onOpenRecord={onOpenRecord}
        onPreviewImage={onPreviewImage}
        t={t}
      />
    );
  }
  if (activeViewType === "gallery") {
    return (
      <StageTableGalleryView
        project={project}
        dataSource={dataSource}
        dataRevision={dataRevision}
        activeView={activeView}
        allRows={allRows}
        rows={rows}
        allColumnIds={allColumnIds}
        filterableColumnIds={filterableColumnIds}
        filterColumnGroups={filterColumnGroups}
        visibleColumnIds={visibleColumnIds}
        customColumns={customColumns}
        customColumnMap={customColumnMap}
        activeFilters={activeFilters}
        activeFilterGroup={activeFilterGroup}
        activeSort={activeSort}
        selectedRowIds={selectedRowIds}
        getColumnLabel={getColumnLabel}
        onSelectRows={onSelectRows}
        onOpenRecord={onOpenRecord}
        onPreviewImage={onPreviewImage}
        t={t}
      />
    );
  }
  if (activeViewType === "calendar") {
    return (
      <StageTableCalendarView
        project={project}
        dataSource={dataSource}
        dataRevision={dataRevision}
        activeView={activeView}
        allRows={allRows}
        rows={rows}
        allColumnIds={allColumnIds}
        filterableColumnIds={filterableColumnIds}
        filterColumnGroups={filterColumnGroups}
        visibleColumnIds={visibleColumnIds}
        customColumns={customColumns}
        customColumnMap={customColumnMap}
        activeFilters={activeFilters}
        activeFilterGroup={activeFilterGroup}
        activeSort={activeSort}
        selectedRowIds={selectedRowIds}
        getColumnLabel={getColumnLabel}
        onSelectRows={onSelectRows}
        onOpenRecord={onOpenRecord}
        onPreviewImage={onPreviewImage}
        t={t}
      />
    );
  }
  return (
    <StageTableSpacedRepetitionView
      project={project}
      dataSource={dataSource}
      dataRevision={dataRevision}
      activeView={activeView}
      allRows={allRows}
      rows={rows}
      allColumnIds={allColumnIds}
      filterableColumnIds={filterableColumnIds}
      filterColumnGroups={filterColumnGroups}
      customColumns={customColumns}
      customColumnMap={customColumnMap}
      activeFilters={activeFilters}
      activeFilterGroup={activeFilterGroup}
      activeSort={activeSort}
      selectedRowIds={selectedRowIds}
      getColumnLabel={getColumnLabel}
      onSelectRows={onSelectRows}
      onOpenRecord={onOpenRecord}
      onPreviewImage={onPreviewImage}
      onOpenFormulaEditor={onOpenFormulaEditor}
      t={t}
    />
  );
}

export default function StageTablePanel({
  project,
  dataSource: externalDataSource,
}: {
  project?: Project | null;
  dataSource?: TableDataSource;
}) {
  const { t } = useTranslation("stageTable");
  const [revision, setRevision] = useState(0);
  const [propertySearch, setPropertySearch] = useState("");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const tableGridRef = useRef<HTMLTableElement | null>(null);

  // 单例共享图片上传 input（避免 5,000 行每行挂载 1 个 input[type=file]）
  const rowImageUploadRef = useRef<HTMLInputElement>(null);
  const rowImageUploadTargetRef = useRef<{ rowUuid: string; docId?: string } | null>(null);

  // 入口 1：画布分屏顶部「范围切换」（当前画布 / 当前文件夹 / 整个工作空间）
  const [dockScopeMode, setDockScopeMode] = useState<"current_doc" | "current_folder" | "workspace">("current_doc");
  const [dockWorkspaceSource, setDockWorkspaceSource] = useState<WorkspaceTableSource | null>(null);
  const [workspaceColumnsDialogOpen, setWorkspaceColumnsDialogOpen] = useState(false);
  const [scopeSearch, setScopeSearch] = useState("");

  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  useEffect(() => {
    if (!WorkspaceClient.isAvailable()) {
      setWorkspaceRoot(null);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void import("@/core/service/workspace/WorkspaceManager")
      .then(({ WorkspaceManager }) => {
        if (cancelled) return;
        const syncRoot = () => setWorkspaceRoot(WorkspaceManager.root ?? null);
        syncRoot();
        WorkspaceManager.on("root-change", syncRoot);
        unsubscribe = () => WorkspaceManager.off("root-change", syncRoot);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  const canSwitchDockScope = Boolean(project && !externalDataSource && workspaceRoot && WorkspaceClient.isAvailable());

  const currentRelFolder = useMemo(() => {
    if (!project || !workspaceRoot || project.uri?.scheme !== "file") return "";
    const normRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const normFile = project.uri.fsPath.replace(/\\/g, "/");
    if (!normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) return "";
    const rel = normFile.slice(normRoot.length + 1);
    const idx = rel.lastIndexOf("/");
    return idx > 0 ? rel.slice(0, idx) : "";
  }, [project, workspaceRoot]);

  useEffect(() => {
    setDockScopeMode("current_doc");
  }, [project]);

  useEffect(() => {
    if (!canSwitchDockScope || dockScopeMode === "current_doc") {
      setDockWorkspaceSource(null);
      return;
    }
    const scope: WorkspaceTableScope =
      dockScopeMode === "current_folder" && currentRelFolder
        ? { kind: "folders", paths: [currentRelFolder] }
        : { kind: "all", paths: [] };
    const ws = createWorkspaceTableSource({
      overrideScope: scope,
      defaultCreateDocId: project?.v3DocId ?? null,
    });
    setDockWorkspaceSource(ws);
    return () => {
      ws.dispose();
    };
  }, [canSwitchDockScope, dockScopeMode, currentRelFolder, project?.v3DocId]);

  const singleDocSource = useMemo(() => (project ? createSingleFileTableSource(project) : null), [project]);
  const dataSource = useMemo<TableDataSource | null>(
    () =>
      externalDataSource ??
      (dockScopeMode === "current_doc" ? singleDocSource : dockWorkspaceSource) ??
      singleDocSource,
    [externalDataSource, dockScopeMode, singleDocSource, dockWorkspaceSource],
  );

  // 原子化外部选中态 Store（彻底避免顶层 selection state 引发全表重渲染）
  const selectionStore = useMemo(() => new StageTableSelectionStore(), []);
  const wasSoleActiveOnDownRef = useRef(false);
  const suppressCellClickRef = useRef(false);
  const lastCanvasSelectedRef = useRef<string[]>([]);

  // 单例单元格浮层 / 内联编辑器状态
  const [activeEditor, setActiveEditor] = useState<ActiveCellEditorState | null>(null);

  // 列筛选/排序弹窗状态
  const [filterPopoverColId, setFilterPopoverColId] = useState<string | null>(null);

  // 字段修改面板状态
  const [editingFieldState, setEditingFieldState] = useState<{
    colId: string;
    anchor: "header" | "floating";
  } | null>(null);
  const [editFieldName, setEditFieldName] = useState("");
  const [editFieldType, setEditFieldType] = useState<CustomColumnType>("text");
  const [editTypeDropdownOpen, setEditTypeDropdownOpen] = useState(false);
  const editNameInputRef = useRef<HTMLInputElement>(null);

  // 公式列编辑器弹窗状态
  const [formulaEditorState, setFormulaEditorState] = useState<{
    colId: string;
    previewRowUuid?: string | null;
  } | null>(null);

  // 插入字段 / 新建列内联标题 + 双列类型面板状态
  const [creatingColState, setCreatingColState] = useState<{
    colId: string;
    draftTitle: string;
    selectedType: CustomColumnType;
  } | null>(null);
  const creatingColStateRef = useRef(creatingColState);
  creatingColStateRef.current = creatingColState;
  const creatingTitleInputRef = useRef<HTMLInputElement>(null);

  // 顶部分组表头重命名状态
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renamingGroupDraft, setRenamingGroupDraft] = useState("");
  const groupRenameInputRef = useRef<HTMLInputElement>(null);

  // 图片放大预览灯箱状态
  const [previewLightboxState, setPreviewLightboxState] = useState<{
    items: ImageLightboxItem[];
    initialIndex: number;
    allItems?: ImageLightboxItem[];
    allInitialIndex?: number;
  } | null>(null);

  // 多视图标签栏状态
  const viewBarRef = useRef<HTMLDivElement>(null);
  const suppressViewClickRef = useRef(false);
  const [addViewPopoverOpen, setAddViewPopoverOpen] = useState(false);
  const [viewMenuOpenId, setViewMenuOpenId] = useState<string | null>(null);
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null);
  const [renamingViewDraft, setRenamingViewDraft] = useState("");
  const viewRenameInputRef = useRef<HTMLInputElement>(null);
  const [draggingViewId, setDraggingViewId] = useState<string | null>(null);
  const [dropViewHint, setDropViewHint] = useState<{ targetViewId: string; position: "before" | "after" } | null>(null);
  const [recordDialogTarget, setRecordDialogTarget] = useState<{
    uuid: string;
    docId?: string;
    snapshot?: StageTableRow;
  } | null>(null);
  const recordDialogRowUuid = recordDialogTarget?.uuid ?? null;

  // 表头拖拽重排状态
  const headerRowRef = useRef<HTMLTableRowElement>(null);
  const [draggingColId, setDraggingColId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetColId: string; position: "before" | "after" } | null>(null);

  const forceRefresh = useCallback(() => {
    setRevision((v) => v + 1);
  }, []);

  const isWorkspaceMode = dataSource?.scopeKind === "workspace";
  const hasStageTableService = Boolean(dataSource && (isWorkspaceMode || project?.getService?.("stageTable")));

  // 计算视图配置与表结构（仅在 revision/dataSource 变化时更新）
  const activeView = hasStageTableService && dataSource ? dataSource.getActiveView() : null;
  const views: TableViewSchema[] = hasStageTableService && dataSource ? dataSource.getViews() : [];
  const activeViewType: TableViewType = activeView?.type ?? "table";
  const tableRowHeight: TableRowHeight = activeView?.rowHeight ?? "medium";
  const customColumns = useMemo(
    () => (hasStageTableService && dataSource ? dataSource.getColumns() : []),
    [hasStageTableService, dataSource, revision],
  );
  const customColumnMap = useMemo(
    () => new Map<string, TableColumnSchema>(customColumns.map((col) => [col.id, col])),
    [customColumns],
  );

  const visibleColumnIds = useMemo(
    () => (hasStageTableService && dataSource ? dataSource.getVisibleColumnIds() : ["name"]),
    [hasStageTableService, dataSource, revision],
  );
  const visibleColumnSet = useMemo(() => new Set(visibleColumnIds), [visibleColumnIds]);

  const activeSort: TableSortConfig | null = useMemo(
    () => (hasStageTableService && dataSource ? dataSource.getSort() : null),
    [hasStageTableService, dataSource, revision],
  );
  const activeFilters: TableColumnFilter[] = useMemo(
    () => (hasStageTableService && dataSource ? dataSource.getFilters() : []),
    [hasStageTableService, dataSource, revision],
  );
  const activeFilterGroup: TableFilterGroup = useMemo(
    () => (hasStageTableService && dataSource ? dataSource.getFilterGroup() : { conjunction: "and", conditions: [] }),
    [hasStageTableService, dataSource, revision],
  );
  const activeWorkspaceScope = useMemo(
    () => (hasStageTableService && dataSource?.getScope ? dataSource.getScope() : null),
    [hasStageTableService, dataSource, revision],
  );

  // SQLite 模式下由 Rust 引擎分页查询主表格；非 SQLite / 单文件非表格视图使用内存热缓存（O(dirty) 公式 DAG）
  const isSqliteBacked = Boolean(hasStageTableService && dataSource?.isSqliteBacked());
  const useSqliteTablePaging = isSqliteBacked && activeViewType === "table";

  const [sqliteTableState, setSqliteTableState] = useState<{
    queryKey: string;
    totalCount: number;
    unfilteredTotalCount: number;
    rowsByIndex: Map<number, StageTableRow>;
  }>({
    queryKey: "",
    totalCount: 0,
    unfilteredTotalCount: 0,
    rowsByIndex: new Map(),
  });
  const sqliteInFlightChunksRef = useRef<Set<string>>(new Set());

  const queryFingerprint = useMemo(
    () =>
      JSON.stringify({
        rev: revision,
        scopeKind: dataSource?.scopeKind ?? "",
        scope: activeWorkspaceScope,
        docId: dataSource?.getDocId() ?? null,
        viewId: activeView?.id ?? "",
        filters: activeFilters,
        filterGroup: activeFilterGroup,
        sort: activeSort,
      }),
    [revision, dataSource, activeWorkspaceScope, activeView?.id, activeFilters, activeFilterGroup, activeSort],
  );

  // 内存/同步查询（仅单文件模式在未使用 SQLite 分页或打开公式编辑器/详情弹窗等需要时按需计算）
  const needAllRowsInMemory =
    hasStageTableService &&
    !isWorkspaceMode &&
    (!useSqliteTablePaging || Boolean(formulaEditorState) || Boolean(recordDialogRowUuid));

  const syncData = useMemo(() => {
    if (!needAllRowsInMemory || !dataSource) {
      return { allRows: [] as StageTableRow[], rows: [] as StageTableRow[], unfilteredTotalCount: 0 };
    }
    const allRows = dataSource.getAllRowsSync();
    const page = dataSource.queryPageSync({
      filters: activeFilters,
      filterGroup: activeFilterGroup,
      sort: activeSort,
      offset: 0,
      limit: Math.max(allRows.length, 1),
    });
    return {
      allRows,
      rows: page.rows,
      unfilteredTotalCount: page.unfilteredTotalCount,
    };
  }, [needAllRowsInMemory, dataSource, revision, activeFilters, activeFilterGroup, activeSort]);

  const fetchSqliteChunk = useCallback(
    (chunkIndex: number, targetQueryKey: string) => {
      if (!useSqliteTablePaging || !dataSource) return;
      const chunkKey = `${targetQueryKey}#${chunkIndex}`;
      if (sqliteInFlightChunksRef.current.has(chunkKey)) return;
      sqliteInFlightChunksRef.current.add(chunkKey);

      const offset = chunkIndex * SQLITE_PAGE_CHUNK_SIZE;
      void dataSource
        .queryPage({
          offset,
          limit: SQLITE_PAGE_CHUNK_SIZE,
          filters: activeFilters,
          filterGroup: activeFilterGroup,
          sort: activeSort,
        })
        .then((res) => {
          sqliteInFlightChunksRef.current.delete(chunkKey);
          setSqliteTableState((prev) => {
            const nextMap =
              prev.queryKey === targetQueryKey ? new Map(prev.rowsByIndex) : new Map<number, StageTableRow>();
            res.rows.forEach((row, i) => {
              nextMap.set(res.offset + i, row);
            });
            return {
              queryKey: targetQueryKey,
              totalCount: res.totalCount,
              unfilteredTotalCount: res.unfilteredTotalCount,
              rowsByIndex: nextMap,
            };
          });
        })
        .catch(() => {
          sqliteInFlightChunksRef.current.delete(chunkKey);
        });
    },
    [useSqliteTablePaging, dataSource, activeFilters, activeFilterGroup, activeSort],
  );

  // SQLite 模式下查询条件/数据版本变更时拉取首页
  useEffect(() => {
    if (!useSqliteTablePaging) return;
    sqliteInFlightChunksRef.current.clear();
    fetchSqliteChunk(0, queryFingerprint);
  }, [useSqliteTablePaging, queryFingerprint, fetchSqliteChunk]);

  const effectiveTotalRowCount = useSqliteTablePaging ? sqliteTableState.totalCount : syncData.rows.length;
  const effectiveUnfilteredCount = useSqliteTablePaging
    ? sqliteTableState.unfilteredTotalCount
    : syncData.unfilteredTotalCount;

  const getRowAtIndex = useCallback(
    (index: number): StageTableRow | undefined => {
      if (useSqliteTablePaging) {
        return sqliteTableState.rowsByIndex.get(index);
      }
      return syncData.rows[index];
    },
    [useSqliteTablePaging, sqliteTableState.rowsByIndex, syncData.rows],
  );

  const loadedRowsList = useMemo<StageTableRow[]>(() => {
    if (!useSqliteTablePaging) return syncData.rows;
    return Array.from(sqliteTableState.rowsByIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([, row]) => row);
  }, [useSqliteTablePaging, syncData.rows, sqliteTableState.rowsByIndex]);

  const displayedRowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    if (useSqliteTablePaging) {
      for (const [idx, row] of sqliteTableState.rowsByIndex) {
        map.set(row.uuid, idx);
      }
    } else {
      syncData.rows.forEach((r, idx) => map.set(r.uuid, idx));
    }
    return map;
  }, [useSqliteTablePaging, sqliteTableState.rowsByIndex, syncData.rows]);

  const loadedRowByUuid = useMemo(() => {
    const map = new Map<string, StageTableRow>();
    for (const r of loadedRowsList) map.set(r.uuid, r);
    return map;
  }, [loadedRowsList]);

  const estimatedRowHeight = tableRowHeight === "compact" ? 32 : tableRowHeight === "tall" ? 56 : 40;

  // @tanstack/react-virtual 行虚拟化器（initialRect 确保 jsdom 单测与首帧均正确渲染可视行）
  const rowVirtualizer = useVirtualizer({
    count: activeViewType === "table" ? effectiveTotalRowCount : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 4,
    initialRect: { width: 1000, height: 600 },
    observeElementRect: OBSERVE_TABLE_VIRTUAL_RECT,
  });

  const virtualItems = activeViewType === "table" ? rowVirtualizer.getVirtualItems() : [];
  const totalVirtualSize = activeViewType === "table" ? rowVirtualizer.getTotalSize() : 0;
  const virtualPaddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const virtualPaddingBottom =
    virtualItems.length > 0 ? Math.max(0, totalVirtualSize - virtualItems[virtualItems.length - 1].end) : 0;

  // 滚动时按需拉取尚未加载的 SQLite 分页块
  useEffect(() => {
    if (!useSqliteTablePaging || virtualItems.length === 0) return;
    const firstChunk = Math.floor(virtualItems[0].index / SQLITE_PAGE_CHUNK_SIZE);
    const lastChunk = Math.floor(virtualItems[virtualItems.length - 1].index / SQLITE_PAGE_CHUNK_SIZE);
    for (let c = firstChunk; c <= lastChunk; c++) {
      const sampleIdx = c * SQLITE_PAGE_CHUNK_SIZE;
      if (sampleIdx < sqliteTableState.totalCount && !sqliteTableState.rowsByIndex.has(sampleIdx)) {
        fetchSqliteChunk(c, queryFingerprint);
      }
    }
  }, [
    useSqliteTablePaging,
    virtualItems,
    sqliteTableState.totalCount,
    sqliteTableState.rowsByIndex,
    queryFingerprint,
    fetchSqliteChunk,
  ]);

  const scrollRowIntoViewIfNeeded = useCallback(
    (rowUuid: string) => {
      const idx = displayedRowIndexById.get(rowUuid);
      if (idx !== undefined && activeViewType === "table") {
        rowVirtualizer.scrollToIndex(idx, { align: "auto" });
        return;
      }
      const vp = viewportRef.current;
      if (!vp) return;
      const rowEl = Array.from(vp.querySelectorAll<HTMLElement>("tr[data-stage-table-row-id]")).find(
        (el) => el.dataset.stageTableRowId === rowUuid,
      );
      if (!rowEl) return;
      const theadHeight = vp.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      const vpRect = vp.getBoundingClientRect();
      const rowRect = rowEl.getBoundingClientRect();
      const visibleTop = vpRect.top + theadHeight;
      const visibleBottom = vpRect.bottom;
      if (rowRect.top < visibleTop) {
        vp.scrollTop -= visibleTop - rowRect.top + 4;
      } else if (rowRect.bottom > visibleBottom) {
        vp.scrollTop += rowRect.bottom - visibleBottom + 4;
      }
    },
    [displayedRowIndexById, activeViewType, rowVirtualizer],
  );
  const scrollRowIntoViewRef = useRef(scrollRowIntoViewIfNeeded);
  scrollRowIntoViewRef.current = scrollRowIntoViewIfNeeded;

  useEffect(() => {
    if (!hasStageTableService || !dataSource) return;
    forceRefresh();
    const unsubChanges = dataSource.subscribeChanges(forceRefresh);

    // 画布选中变化 -> 直接写入外部原子 SelectionStore，不触发顶层 StageTablePanel 重渲染！
    const applyCanvasSelection = (selectedUUIDs: string[], shouldScroll: boolean) => {
      const prevSet = new Set(lastCanvasSelectedRef.current);
      lastCanvasSelectedRef.current = selectedUUIDs;
      if (selectedUUIDs.length === 0) {
        selectionStore.setState((prev) => (prev.mode === "rows" || prev.mode === "all" ? EMPTY_TABLE_SELECTION : prev));
        return;
      }
      const nextRowSet = new Set(selectedUUIDs);
      selectionStore.setState({
        mode: "rows",
        rowIds: nextRowSet,
        colIds: new Set<string>(),
        cells: new Set<string>(),
        anchorRowId: selectedUUIDs[0],
        anchorColId: null,
        activeCell: null,
      });
      if (shouldScroll) {
        const newlySelected = selectedUUIDs.find((id) => !prevSet.has(id)) ?? selectedUUIDs[0];
        requestAnimationFrame(() => scrollRowIntoViewRef.current(newlySelected));
      }
    };

    const initialSelected = dataSource.getSelectedRowUUIDs();
    if (initialSelected.length > 0) {
      applyCanvasSelection(initialSelected, true);
    } else {
      lastCanvasSelectedRef.current = [];
      selectionStore.setState(EMPTY_TABLE_SELECTION);
    }

    const unsubSelection = dataSource.subscribeSelection((uuids) => applyCanvasSelection(uuids, true));

    return () => {
      unsubChanges();
      unsubSelection();
    };
  }, [hasStageTableService, dataSource, selectionStore, forceRefresh]);

  useEffect(() => {
    if (editingFieldState) {
      const id = requestAnimationFrame(() => {
        editNameInputRef.current?.focus();
        editNameInputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [editingFieldState]);

  useEffect(() => {
    if (creatingColState?.colId) {
      const id = requestAnimationFrame(() => {
        creatingTitleInputRef.current?.focus();
        creatingTitleInputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [creatingColState?.colId]);

  useEffect(() => {
    if (renamingGroupId) {
      const id = requestAnimationFrame(() => {
        groupRenameInputRef.current?.focus();
        groupRenameInputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [renamingGroupId]);

  useEffect(() => {
    if (renamingViewId) {
      const id = requestAnimationFrame(() => {
        viewRenameInputRef.current?.focus();
        viewRenameInputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [renamingViewId]);

  // 彻底移除 60 秒全表 setInterval：改用跨午夜单次定时器 + 切回前台日期检查刷新易变公式列
  const hasVolatileFormulaCols = useMemo(
    () => (hasStageTableService ? hasVolatileFormulas(customColumns) : false),
    [hasStageTableService, customColumns],
  );

  useEffect(() => {
    if (!hasVolatileFormulaCols || !hasStageTableService || !dataSource) return;
    return registerMidnightVolatileWatcher(() => {
      const refreshed = dataSource.refreshVolatileFormulasIfDayChanged?.();
      if (!refreshed) {
        forceRefresh();
      }
    });
  }, [hasVolatileFormulaCols, hasStageTableService, dataSource, forceRefresh]);

  const visibleColIndexById = useMemo(
    () => new Map<string, number>(visibleColumnIds.map((c, idx) => [c, idx])),
    [visibleColumnIds],
  );

  // Refs 用于保持 StageTableVirtualRow 回调引用稳定，避免破坏 React.memo
  const rowsContextRef = useRef({
    loadedRowsList,
    displayedRowIndexById,
    visibleColumnIds,
    visibleColIndexById,
    getRowAtIndex,
    effectiveTotalRowCount,
  });
  rowsContextRef.current = {
    loadedRowsList,
    displayedRowIndexById,
    visibleColumnIds,
    visibleColIndexById,
    getRowAtIndex,
    effectiveTotalRowCount,
  };

  const syncSelectedRowsToCanvas = useCallback(
    (rowIds: Iterable<string>, focusCamera?: boolean) => {
      if (!dataSource) return;
      const ids = Array.from(rowIds);
      lastCanvasSelectedRef.current = ids;
      if (focusCamera === undefined) {
        dataSource.selectRows(ids);
      } else {
        dataSource.selectRows(ids, { focusCamera });
      }
    },
    [dataSource],
  );

  const clearSelection = useCallback(
    (clearCanvas = false) => {
      selectionStore.clear();
      if (clearCanvas) {
        syncSelectedRowsToCanvas([], false);
      }
    },
    [selectionStore, syncSelectedRowsToCanvas],
  );

  const selectRowsRange = useCallback(
    (startRowId: string, endRowId: string, commitToCanvas: boolean) => {
      const ctx = rowsContextRef.current;
      const startIdx = ctx.displayedRowIndexById.get(startRowId);
      const endIdx = ctx.displayedRowIndexById.get(endRowId);
      if (startIdx === undefined || endIdx === undefined) return;
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      const nextRowIds = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const row = ctx.getRowAtIndex(i);
        if (row) nextRowIds.add(row.uuid);
      }
      selectionStore.setState({
        mode: "rows",
        rowIds: nextRowIds,
        colIds: new Set<string>(),
        cells: new Set<string>(),
        anchorRowId: startRowId,
        anchorColId: null,
        activeCell: null,
      });
      if (commitToCanvas) {
        syncSelectedRowsToCanvas(nextRowIds);
      }
    },
    [selectionStore, syncSelectedRowsToCanvas],
  );

  const buildCellRectSet = useCallback((r1: string, c1: string, r2: string, c2: string): Set<string> => {
    const ctx = rowsContextRef.current;
    const ri1 = ctx.displayedRowIndexById.get(r1);
    const ri2 = ctx.displayedRowIndexById.get(r2);
    const ci1 = ctx.visibleColIndexById.get(c1);
    const ci2 = ctx.visibleColIndexById.get(c2);
    if (ri1 === undefined || ri2 === undefined || ci1 === undefined || ci2 === undefined) {
      return new Set([makeTableCellKey(r2, c2)]);
    }
    const rLo = Math.min(ri1, ri2);
    const rHi = Math.max(ri1, ri2);
    const cLo = Math.min(ci1, ci2);
    const cHi = Math.max(ci1, ci2);
    const result = new Set<string>();
    for (let r = rLo; r <= rHi; r++) {
      const row = ctx.getRowAtIndex(r);
      if (!row) continue;
      for (let c = cLo; c <= cHi; c++) {
        result.add(makeTableCellKey(row.uuid, ctx.visibleColumnIds[c]));
      }
    }
    return result;
  }, []);

  const handleRowIndexPointerDown = useCallback(
    (rowId: string, event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      panelRef.current?.focus({ preventScroll: true });

      const ctx = rowsContextRef.current;
      const isToggle = event.ctrlKey || event.metaKey;
      const isRange = event.shiftKey;
      const prev = selectionStore.getState();

      if (isRange) {
        const anchor = prev.anchorRowId && ctx.displayedRowIndexById.has(prev.anchorRowId) ? prev.anchorRowId : rowId;
        selectRowsRange(anchor, rowId, true);
        return;
      }

      if (isToggle) {
        const base =
          prev.mode === "all"
            ? new Set(ctx.loadedRowsList.map((r) => r.uuid))
            : prev.mode === "rows"
              ? new Set(prev.rowIds)
              : new Set<string>();
        if (base.has(rowId)) {
          base.delete(rowId);
        } else {
          base.add(rowId);
        }
        if (base.size === 0) {
          clearSelection(true);
        } else {
          selectionStore.setState({
            mode: "rows",
            rowIds: base,
            colIds: new Set<string>(),
            cells: new Set<string>(),
            anchorRowId: rowId,
            anchorColId: null,
            activeCell: null,
          });
          syncSelectedRowsToCanvas(base);
        }
        return;
      }

      const initialSet = new Set([rowId]);
      selectionStore.setState({
        mode: "rows",
        rowIds: initialSet,
        colIds: new Set<string>(),
        cells: new Set<string>(),
        anchorRowId: rowId,
        anchorColId: null,
        activeCell: null,
      });
      syncSelectedRowsToCanvas(initialSet);

      let lastHoveredId = rowId;
      let draggedMulti = false;

      const onPointerMove = (moveEvent: PointerEvent) => {
        const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const tr = el?.closest<HTMLElement>("tr[data-stage-table-row-id]");
        const hoveredRowId = tr?.dataset.stageTableRowId;
        if (!hoveredRowId || hoveredRowId === lastHoveredId) return;
        lastHoveredId = hoveredRowId;
        draggedMulti = true;
        selectRowsRange(rowId, hoveredRowId, false);
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        if (draggedMulti) {
          syncSelectedRowsToCanvas(selectionStore.getState().rowIds);
        }
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [selectionStore, selectRowsRange, clearSelection, syncSelectedRowsToCanvas],
  );

  const handleCellPointerDown = useCallback(
    (rowId: string, colId: string, event: React.PointerEvent) => {
      if (event.button !== 0) return;
      const targetEl = event.target as HTMLElement | null;
      if (
        targetEl?.closest(
          "[data-slot='popover-content'], [role='dialog'], [role='menu'], input, textarea, [data-cell-action]",
        )
      ) {
        return;
      }

      const ctx = rowsContextRef.current;
      const prev = selectionStore.getState();
      const key = makeTableCellKey(rowId, colId);
      const isToggle = event.ctrlKey || event.metaKey;
      const isRange = event.shiftKey;

      if (isRange) {
        event.preventDefault();
        wasSoleActiveOnDownRef.current = false;
        const anchorRow =
          prev.anchorRowId && ctx.displayedRowIndexById.has(prev.anchorRowId) ? prev.anchorRowId : rowId;
        const anchorCol = prev.anchorColId && ctx.visibleColIndexById.has(prev.anchorColId) ? prev.anchorColId : colId;
        const nextCells = buildCellRectSet(anchorRow, anchorCol, rowId, colId);
        selectionStore.setState({
          mode: "cells",
          rowIds: new Set<string>(),
          colIds: new Set<string>(),
          cells: nextCells,
          anchorRowId: anchorRow,
          anchorColId: anchorCol,
          activeCell: { rowId, colId },
        });
        syncSelectedRowsToCanvas(extractRowIdsFromCellKeys(nextCells));
        return;
      }

      if (isToggle) {
        event.preventDefault();
        wasSoleActiveOnDownRef.current = false;
        const base = prev.mode === "cells" ? new Set(prev.cells) : new Set<string>();
        if (base.has(key)) {
          base.delete(key);
        } else {
          base.add(key);
        }
        if (base.size === 0) {
          clearSelection(true);
        } else {
          selectionStore.setState({
            mode: "cells",
            rowIds: new Set<string>(),
            colIds: new Set<string>(),
            cells: base,
            anchorRowId: rowId,
            anchorColId: colId,
            activeCell: { rowId, colId },
          });
          syncSelectedRowsToCanvas(extractRowIdsFromCellKeys(base));
        }
        return;
      }

      const wasSoleActive =
        prev.mode === "cells" &&
        prev.cells.size === 1 &&
        prev.activeCell?.rowId === rowId &&
        prev.activeCell?.colId === colId;
      wasSoleActiveOnDownRef.current = wasSoleActive;

      selectionStore.setState({
        mode: "cells",
        rowIds: new Set<string>(),
        colIds: new Set<string>(),
        cells: new Set([key]),
        anchorRowId: rowId,
        anchorColId: colId,
        activeCell: { rowId, colId },
      });
      syncSelectedRowsToCanvas([rowId]);

      let didDragCells = false;
      let lastHoverKey = key;

      const onPointerMove = (moveEvent: PointerEvent) => {
        const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const td = el?.closest<HTMLElement>("td[data-stage-table-cell]");
        const hoverRowId = td?.dataset.rowId;
        const hoverColId = td?.dataset.colId;
        if (!hoverRowId || !hoverColId) return;
        const hoverKey = makeTableCellKey(hoverRowId, hoverColId);
        if (hoverKey === lastHoverKey) return;
        lastHoverKey = hoverKey;
        didDragCells = true;
        wasSoleActiveOnDownRef.current = false;
        selectionStore.setState({
          mode: "cells",
          rowIds: new Set<string>(),
          colIds: new Set<string>(),
          cells: buildCellRectSet(rowId, colId, hoverRowId, hoverColId),
          anchorRowId: rowId,
          anchorColId: colId,
          activeCell: { rowId: hoverRowId, colId: hoverColId },
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        if (didDragCells) {
          syncSelectedRowsToCanvas(extractRowIdsFromCellKeys(selectionStore.getState().cells));
          suppressCellClickRef.current = true;
          queueMicrotask(() => {
            suppressCellClickRef.current = false;
          });
        }
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [selectionStore, buildCellRectSet, clearSelection, syncSelectedRowsToCanvas],
  );

  const openImagePreview = useCallback(
    (attachmentId: string, sourceRowUuid?: string, sourceDocId?: string) => {
      const currentRows = rowsContextRef.current.loadedRowsList;
      const allTableImages: ImageLightboxItem[] = [];
      for (const r of currentRows) {
        const label = getDisplayLabel(r, t);
        for (const img of r.images ?? []) {
          allTableImages.push({
            attachmentId: img.attachmentId,
            docId: r.docId,
            label,
            rowUuid: r.uuid,
            imageNodeUuid: img.uuid,
          });
        }
      }

      const findIdx = (list: ImageLightboxItem[]) => {
        const exact = sourceRowUuid
          ? list.findIndex(
              (item) =>
                item.attachmentId === attachmentId &&
                item.rowUuid === sourceRowUuid &&
                (!sourceDocId || !item.docId || item.docId === sourceDocId),
            )
          : -1;
        if (exact >= 0) return exact;
        const byAtt = list.findIndex((item) => item.attachmentId === attachmentId);
        return byAtt >= 0 ? byAtt : 0;
      };

      const sourceRow = sourceRowUuid
        ? (currentRows.find((r) => r.uuid === sourceRowUuid && (!sourceDocId || !r.docId || r.docId === sourceDocId)) ??
          dataSource?.getCachedRow?.(sourceRowUuid, sourceDocId))
        : undefined;
      const rowImages: ImageLightboxItem[] = sourceRow
        ? (sourceRow.images ?? []).map((img) => ({
            attachmentId: img.attachmentId,
            docId: sourceRow.docId ?? sourceDocId,
            label: getDisplayLabel(sourceRow, t),
            rowUuid: sourceRow.uuid,
            imageNodeUuid: img.uuid,
          }))
        : [];

      if (rowImages.length > 1) {
        setPreviewLightboxState({
          items: rowImages,
          initialIndex: findIdx(rowImages),
          allItems: allTableImages.length > rowImages.length ? allTableImages : undefined,
          allInitialIndex: allTableImages.length > rowImages.length ? findIdx(allTableImages) : undefined,
        });
        return;
      }

      if (allTableImages.length > 0 && rowImages.length <= 1 && !sourceDocId) {
        setPreviewLightboxState({
          items: allTableImages,
          initialIndex: findIdx(allTableImages),
        });
        return;
      }

      if (rowImages.length === 1) {
        setPreviewLightboxState({
          items: rowImages,
          initialIndex: 0,
          allItems: allTableImages.length > 1 ? allTableImages : undefined,
          allInitialIndex: allTableImages.length > 1 ? findIdx(allTableImages) : undefined,
        });
        return;
      }

      setPreviewLightboxState({
        items: [{ attachmentId, docId: sourceDocId }],
        initialIndex: 0,
      });
    },
    [t, dataSource],
  );

  const openFormulaEditorForColumn = useCallback((colId: string, previewRowUuid?: string | null) => {
    setCreatingColState(null);
    setEditTypeDropdownOpen(false);
    setEditingFieldState(null);
    setFormulaEditorState({ colId, previewRowUuid: previewRowUuid ?? null });
  }, []);

  const rowCallbacks = useMemo<StageTableVirtualRowCallbacks>(
    () => ({
      onRowIndexPointerDown: handleRowIndexPointerDown,
      onCellPointerDown: handleCellPointerDown,
      shouldSuppressCellClick: () => suppressCellClickRef.current,
      canEditOnClick: () => wasSoleActiveOnDownRef.current,
      onStartInlineEdit: (rowUuid, colId, docId) => setActiveEditor({ kind: "inline_text", rowUuid, docId, colId }),
      onCloseEditor: () => setActiveEditor(null),
      onOpenPopoverEditor: (state) => setActiveEditor(state),
      onCommitPrimaryText: (rowUuid, nextText, docId) => {
        void dataSource?.executeMutation({ type: "update_primary_text", docId, rowUuid, text: nextText });
      },
      onCommitCustomField: (rowUuid, columnId, value, docId) => {
        void dataSource?.executeMutation({ type: "update_custom_field", docId, rowUuid, columnId, value });
      },
      onJumpToRow: (rowUuid, docId) => {
        dataSource?.jumpToNode(docId ?? dataSource.getDocId(), rowUuid);
      },
      onRequestUploadImages: (rowUuid, docId) => {
        rowImageUploadTargetRef.current = { rowUuid, docId };
        rowImageUploadRef.current?.click();
      },
      onAddImages: (rowUuid, blobs, docId) => {
        void dataSource?.executeMutation({ type: "add_images", docId, rowUuid, blobs });
      },
      onRemoveImage: (rowUuid, imageNodeUuid, docId) => {
        void dataSource?.executeMutation({ type: "remove_image", docId, rowUuid, imageNodeUuid });
      },
      onPreviewImage: (attId, rowUuid, docId) => openImagePreview(attId, rowUuid, docId),
      onRemoveRelationItem: (rowUuid, kind, nextIds, docId) => {
        if (!dataSource) return;
        if (kind === "outer") {
          void dataSource.executeMutation({ type: "set_outer", docId, rowUuid, outerUuid: null });
        } else if (kind === "parents") {
          void dataSource.executeMutation({ type: "set_parents", docId, rowUuid, parentUuids: nextIds ?? [] });
        } else if (kind === "children") {
          void dataSource.executeMutation({ type: "set_children", docId, rowUuid, childUuids: nextIds ?? [] });
        } else {
          void dataSource.executeMutation({ type: "set_inner", docId, rowUuid, innerUuids: nextIds ?? [] });
        }
      },
      onOpenFormulaEditor: (colId, rowUuid) => openFormulaEditorForColumn(colId, rowUuid),
    }),
    [handleRowIndexPointerDown, handleCellPointerDown, dataSource, openImagePreview, openFormulaEditorForColumn],
  );

  if (!hasStageTableService || !activeView || !dataSource) {
    return null;
  }

  const activeFilterByColId = new Map<string, TableColumnFilter>(activeFilters.map((f) => [f.columnId, f]));
  const activeFilterGroupColIds = new Set<string>(
    activeFilterGroup.conditions
      .filter((cond) => isFilterConditionActive(cond, customColumnMap.get(cond.columnId)))
      .map((cond) => cond.columnId),
  );
  const activeFilterConditionCount = countActiveFilterConditions(activeFilterGroup, customColumns);
  const hasAnyActiveFilter = activeFilters.length > 0 || activeFilterConditionCount > 0;

  const handleToggleSelectAll = () => {
    if (selectionStore.getState().mode === "all") {
      clearSelection(true);
      return;
    }
    const allIds = loadedRowsList.map((r) => r.uuid);
    selectionStore.setState({
      mode: "all",
      rowIds: new Set(allIds),
      colIds: new Set(visibleColumnIds),
      cells: new Set<string>(),
      anchorRowId: allIds[0] ?? null,
      anchorColId: visibleColumnIds[0] ?? null,
      activeCell: null,
    });
    syncSelectedRowsToCanvas(allIds);
  };

  const selectColumnByInteraction = (
    colId: string,
    modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => {
    panelRef.current?.focus({ preventScroll: true });
    const prev = selectionStore.getState();
    const isToggle = modifiers.ctrlKey || modifiers.metaKey;
    const isRange = modifiers.shiftKey;

    if (isRange) {
      const anchor = prev.anchorColId && visibleColIndexById.has(prev.anchorColId) ? prev.anchorColId : colId;
      const startIdx = visibleColIndexById.get(anchor);
      const endIdx = visibleColIndexById.get(colId);
      if (startIdx === undefined || endIdx === undefined) return;
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      const nextCols = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        nextCols.add(visibleColumnIds[i]);
      }
      selectionStore.setState({
        mode: "columns",
        rowIds: new Set<string>(),
        colIds: nextCols,
        cells: new Set<string>(),
        anchorRowId: null,
        anchorColId: anchor,
        activeCell: null,
      });
      return;
    }

    if (isToggle) {
      const base =
        prev.mode === "all"
          ? new Set(visibleColumnIds)
          : prev.mode === "columns"
            ? new Set(prev.colIds)
            : new Set<string>();
      if (base.has(colId)) {
        base.delete(colId);
      } else {
        base.add(colId);
      }
      if (base.size === 0) {
        selectionStore.clear();
      } else {
        selectionStore.setState({
          mode: "columns",
          rowIds: new Set<string>(),
          colIds: base,
          cells: new Set<string>(),
          anchorRowId: null,
          anchorColId: colId,
          activeCell: null,
        });
      }
      return;
    }

    selectionStore.setState({
      mode: "columns",
      rowIds: new Set<string>(),
      colIds: new Set([colId]),
      cells: new Set<string>(),
      anchorRowId: null,
      anchorColId: colId,
      activeCell: null,
    });
  };

  const getCellCopyText = (row: StageTableRow, colId: string): string => {
    switch (colId) {
      case "name":
        return row.primaryText;
      case "sourceFile":
        return row.sourceFile ?? "";
      case "sourceFolder":
        return row.sourceFolder ?? "";
      case "images":
        return row.images.length > 0 ? t("imagesCell.countLabel", { count: row.images.length }) : "";
      case "createdAt":
        return formatTimestamp(row.createdAt);
      case "updatedAt":
        return formatTimestamp(row.updatedAt);
      case "parents":
        return row.parents.map((i) => getDisplayLabel(i, t)).join(", ");
      case "children":
        return row.children.map((i) => getDisplayLabel(i, t)).join(", ");
      case "outer":
        return row.outer ? getDisplayLabel(row.outer, t) : "";
      case "inner":
        return row.inner.map((i) => getDisplayLabel(i, t)).join(", ");
      default: {
        const customCol = customColumnMap.get(colId);
        if (customCol?.type === "formula") {
          return row.formulaValues?.[colId]?.displayText ?? "";
        }
        const val = row.tableFields?.[colId];
        if (!customCol || val === undefined || val === null) return "";
        if (customCol.type === "select" || customCol.type === "multi_select") {
          const optMap = new Map((customCol.options ?? []).map((o) => [o.id, o.name]));
          const ids = Array.isArray(val) ? val : [String(val)];
          return ids
            .map((id) => optMap.get(id))
            .filter(Boolean)
            .join(", ");
        }
        return Array.isArray(val) ? val.join(", ") : String(val);
      }
    }
  };

  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true']")) return;
    const selection = selectionStore.getState();

    if (e.key === "Escape" && selection.mode !== "none") {
      e.preventDefault();
      e.stopPropagation();
      clearSelection(selection.mode === "rows" || selection.mode === "all" || selection.mode === "cells");
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      const allIds = loadedRowsList.map((r) => r.uuid);
      selectionStore.setState({
        mode: "all",
        rowIds: new Set(allIds),
        colIds: new Set(visibleColumnIds),
        cells: new Set<string>(),
        anchorRowId: allIds[0] ?? null,
        anchorColId: visibleColumnIds[0] ?? null,
        activeCell: null,
      });
      syncSelectedRowsToCanvas(allIds);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selection.mode !== "none") {
      const nativeSelected = window.getSelection()?.toString();
      if (nativeSelected) return;
      const selectedRowsList =
        selection.mode === "all" || selection.mode === "columns"
          ? loadedRowsList
          : selection.mode === "rows"
            ? loadedRowsList.filter((r) => selection.rowIds.has(r.uuid))
            : loadedRowsList.filter((r) =>
                visibleColumnIds.some((c) => selection.cells.has(makeTableCellKey(r.uuid, c))),
              );
      const selectedColsList =
        selection.mode === "all" || selection.mode === "rows"
          ? visibleColumnIds
          : selection.mode === "columns"
            ? visibleColumnIds.filter((c) => selection.colIds.has(c))
            : visibleColumnIds.filter((c) =>
                selectedRowsList.some((r) => selection.cells.has(makeTableCellKey(r.uuid, c))),
              );
      if (selectedRowsList.length > 0 && selectedColsList.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const tsv = selectedRowsList
          .map((row) =>
            selectedColsList
              .map((colId) =>
                selection.mode === "cells" && !selection.cells.has(makeTableCellKey(row.uuid, colId))
                  ? ""
                  : getCellCopyText(row, colId).replace(/\t|\r?\n/g, " "),
              )
              .join("\t"),
          )
          .join("\n");
        void navigator.clipboard?.writeText(tsv);
      }
      return;
    }

    if (
      selection.mode === "cells" &&
      selection.activeCell &&
      (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")
    ) {
      const curRowIdx = displayedRowIndexById.get(selection.activeCell.rowId);
      const curColIdx = visibleColIndexById.get(selection.activeCell.colId);
      if (curRowIdx === undefined || curColIdx === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      const nextRowIdx =
        e.key === "ArrowUp"
          ? Math.max(0, curRowIdx - 1)
          : e.key === "ArrowDown"
            ? Math.min(effectiveTotalRowCount - 1, curRowIdx + 1)
            : curRowIdx;
      const nextColIdx =
        e.key === "ArrowLeft"
          ? Math.max(0, curColIdx - 1)
          : e.key === "ArrowRight"
            ? Math.min(visibleColumnIds.length - 1, curColIdx + 1)
            : curColIdx;
      const nextRow = getRowAtIndex(nextRowIdx);
      const nextColId = visibleColumnIds[nextColIdx];
      if (!nextRow || !nextColId) return;
      const nextRowId = nextRow.uuid;
      if (e.shiftKey) {
        const anchorRow = selection.anchorRowId ?? selection.activeCell.rowId;
        const anchorCol = selection.anchorColId ?? selection.activeCell.colId;
        const nextCells = buildCellRectSet(anchorRow, anchorCol, nextRowId, nextColId);
        selectionStore.setState({
          mode: "cells",
          rowIds: new Set<string>(),
          colIds: new Set<string>(),
          cells: nextCells,
          anchorRowId: anchorRow,
          anchorColId: anchorCol,
          activeCell: { rowId: nextRowId, colId: nextColId },
        });
        syncSelectedRowsToCanvas(extractRowIdsFromCellKeys(nextCells));
      } else {
        selectionStore.setState({
          mode: "cells",
          rowIds: new Set<string>(),
          colIds: new Set<string>(),
          cells: new Set([makeTableCellKey(nextRowId, nextColId)]),
          anchorRowId: nextRowId,
          anchorColId: nextColId,
          activeCell: { rowId: nextRowId, colId: nextColId },
        });
        syncSelectedRowsToCanvas([nextRowId]);
      }
      scrollRowIntoViewIfNeeded(nextRowId);
    }
  };

  const getColumnLabel = (colId: string): string => {
    const customCol = customColumnMap.get(colId);
    if (customCol) return customCol.name;
    if (isSystemColumnId(colId)) {
      const override = dataSource.getSystemColumnCustomName(colId);
      return override || t(`columns.${colId}`);
    }
    return colId;
  };

  const getColumnTypeName = (colId: string): string => {
    const customCol = customColumnMap.get(colId);
    if (customCol) return t(`columnTypes.${customCol.type}`);
    if (isSystemColumnId(colId)) return t(`columns.${colId}`);
    return "";
  };

  const getColumnWidth = (colId: string): number => {
    const saved = activeView.columnWidths?.[colId];
    if (typeof saved === "number" && Number.isFinite(saved)) return saved;
    const customCol = customColumnMap.get(colId);
    if (customCol) return customCol.width ?? DEFAULT_CUSTOM_COLUMN_WIDTHS[customCol.type];
    if (isSystemColumnId(colId)) return DEFAULT_SYSTEM_COLUMN_WIDTHS[colId];
    return 160;
  };

  const buildUniqueDefaultColumnName = (type: CustomColumnType, excludeColId?: string): string => {
    const base = t(`columnTypes.${type}`);
    const existingNames = new Set(customColumns.filter((c) => c.id !== excludeColId).map((c) => c.name));
    if (!existingNames.has(base)) return base;
    let suffix = 2;
    while (existingNames.has(`${base} ${suffix}`)) {
      suffix++;
    }
    return `${base} ${suffix}`;
  };

  // 冻结列计算
  const frozenColumnId: string | null = dataSource.getFrozenColumnId();
  const frozenEndIndex = frozenColumnId ? visibleColumnIds.indexOf(frozenColumnId) : -1;

  const columnLeftOffsets: number[] = [];
  let runningLeft = INDEX_COLUMN_WIDTH;
  for (const colId of visibleColumnIds) {
    columnLeftOffsets.push(runningLeft);
    runningLeft += getColumnWidth(colId);
  }
  const totalTableWidth = runningLeft + ADD_COLUMN_WIDTH;

  /**
   * 零重渲染列宽拖拽：
   * 拖动期间仅通过 DOM / CSS 变量实时更新当前列宽、总宽与冻结列偏移，
   * 仅在 `pointerup` 时落库提交 1 次 `setColumnWidth`。
   */
  const startColumnResize = (columnId: string, currentWidth: number, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    let latestWidth = currentWidth;
    const resizedColIdx = visibleColumnIds.indexOf(columnId);
    const gridEl = tableGridRef.current;
    const targetColEl =
      Array.from(gridEl?.querySelectorAll<HTMLElement>("colgroup col[data-col-width-id]") ?? []).find(
        (el) => el.dataset.colWidthId === columnId,
      ) ?? null;
    const baseTotalWidth = totalTableWidth;
    const baseOffsets = [...columnLeftOffsets];

    const onPointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.max(80, Math.min(600, Math.round(currentWidth + (moveEvent.clientX - startX))));
      if (nextWidth === latestWidth) return;
      latestWidth = nextWidth;
      const delta = nextWidth - currentWidth;
      if (targetColEl) {
        targetColEl.style.width = `${nextWidth}px`;
      }
      if (gridEl) {
        gridEl.style.width = `${baseTotalWidth + delta}px`;
        if (resizedColIdx >= 0 && frozenEndIndex >= 0) {
          for (let i = resizedColIdx + 1; i <= frozenEndIndex; i++) {
            const nextLeft = baseOffsets[i] + delta;
            gridEl.style.setProperty(`--col-left-${i}`, `${nextLeft}px`);
            const th = gridEl.querySelector<HTMLElement>(`thead th[data-col-idx="${i}"]`);
            if (th) th.style.left = `${nextLeft}px`;
          }
        }
      }
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (gridEl && resizedColIdx >= 0 && frozenEndIndex >= 0) {
        for (let i = resizedColIdx + 1; i <= frozenEndIndex; i++) {
          gridEl.style.removeProperty(`--col-left-${i}`);
        }
      }
      if (latestWidth !== currentWidth) {
        dataSource.setColumnWidth(columnId, latestWidth);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const startColumnDragReorder = (colId: string, event: React.PointerEvent) => {
    if (event.button !== 0 || creatingColState?.colId === colId) return;
    const targetEl = event.target as HTMLElement | null;
    if (targetEl?.closest("[data-col-resizer], [data-col-filter-trigger], [data-col-sort-indicator], input, button")) {
      return;
    }

    const modifiers = { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey };
    if (colId === "name" || modifiers.shiftKey || modifiers.ctrlKey || modifiers.metaKey) {
      selectColumnByInteraction(colId, modifiers);
      return;
    }

    const startX = event.clientX;
    let isDragging = false;
    let latestHint: { targetColId: string; position: "before" | "after" } | null = null;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!isDragging) {
        if (Math.abs(moveEvent.clientX - startX) < 5) return;
        isDragging = true;
        setDraggingColId(colId);
      }

      const rowEl = headerRowRef.current;
      if (!rowEl) return;
      const thNodes = Array.from(rowEl.querySelectorAll<HTMLElement>("[data-table-col-id]"));
      let matched: { targetColId: string; position: "before" | "after" } | null = null;

      for (const th of thNodes) {
        const thColId = th.dataset.tableColId;
        if (!thColId || thColId === colId) continue;
        const rect = th.getBoundingClientRect();
        if (moveEvent.clientX >= rect.left && moveEvent.clientX <= rect.right) {
          if (thColId === "name") {
            matched = { targetColId: "name", position: "after" };
          } else {
            const mid = rect.left + rect.width / 2;
            matched = { targetColId: thColId, position: moveEvent.clientX < mid ? "before" : "after" };
          }
          break;
        }
      }

      if (!matched && thNodes.length > 0) {
        const firstNonSelf = thNodes.find((n) => n.dataset.tableColId && n.dataset.tableColId !== colId);
        const lastNonSelf = [...thNodes].reverse().find((n) => n.dataset.tableColId && n.dataset.tableColId !== colId);
        if (firstNonSelf && moveEvent.clientX < firstNonSelf.getBoundingClientRect().left) {
          const id = firstNonSelf.dataset.tableColId!;
          matched = { targetColId: id, position: id === "name" ? "after" : "before" };
        } else if (lastNonSelf && moveEvent.clientX > lastNonSelf.getBoundingClientRect().right) {
          matched = { targetColId: lastNonSelf.dataset.tableColId!, position: "after" };
        }
      }

      latestHint = matched;
      setDropHint(matched);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (isDragging && latestHint) {
        dataSource.reorderColumn(colId, latestHint.targetColId, latestHint.position);
      } else if (!isDragging) {
        selectColumnByInteraction(colId, modifiers);
      }
      setDraggingColId(null);
      setDropHint(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const openEditFieldPanel = (colId: string, preferredAnchor: "header" | "floating" = "header") => {
    const customCol = customColumnMap.get(colId);
    const effectiveAnchor = preferredAnchor === "header" && visibleColumnSet.has(colId) ? "header" : "floating";
    setCreatingColState(null);
    setEditFieldName(getColumnLabel(colId));
    setEditFieldType(customCol ? customCol.type : "text");
    setEditTypeDropdownOpen(false);
    setEditingFieldState({ colId, anchor: effectiveAnchor });
  };

  const handleSaveEditField = () => {
    if (!editingFieldState) return;
    const { colId } = editingFieldState;
    const existingCol = customColumnMap.get(colId);
    const isCustom = Boolean(existingCol);
    const switchedToNewFormula = isCustom && existingCol?.type !== "formula" && editFieldType === "formula";
    dataSource.updateColumn(colId, {
      name: editFieldName,
      ...(isCustom ? { type: editFieldType } : {}),
    });
    setEditTypeDropdownOpen(false);
    setEditingFieldState(null);
    if (switchedToNewFormula) {
      setFormulaEditorState({ colId, previewRowUuid: null });
    }
  };

  const commitCreatingColumn = (explicitType?: CustomColumnType, options?: { openFormulaEditor?: boolean }) => {
    const current = creatingColStateRef.current;
    if (!current) return null;
    const chosenType = explicitType ?? current.selectedType;
    const finalName = current.draftTitle.trim() || buildUniqueDefaultColumnName(chosenType, current.colId);
    dataSource.updateColumn(current.colId, {
      name: finalName,
      type: chosenType,
    });
    const finishedColId = current.colId;
    setCreatingColState(null);
    if (chosenType === "formula" && (options?.openFormulaEditor ?? true)) {
      setFormulaEditorState({ colId: finishedColId, previewRowUuid: null });
    }
    return finishedColId;
  };

  const triggerInsertNewColumn = (targetColumnId?: string, side?: "left" | "right") => {
    if (creatingColStateRef.current) {
      commitCreatingColumn();
    }
    setEditingFieldState(null);
    const defaultName = buildUniqueDefaultColumnName("text");
    const created =
      dataSource.insertCustomColumn({
        name: defaultName,
        type: "text",
        targetColumnId,
        side,
      }) ??
      dataSource.addCustomColumn({
        name: defaultName,
        type: "text",
      });
    if (!created) return;
    setCreatingColState({
      colId: created.id,
      draftTitle: "",
      selectedType: "text",
    });
  };

  const scheduleAfterContextMenu = (fn: () => void) => {
    setTimeout(fn, 0);
  };

  const handleCreateTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (!creatingColState) return;
    const currentIdx = FIELD_TYPE_GRID_ORDER.indexOf(creatingColState.selectedType);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIdx = Math.min(FIELD_TYPE_GRID_ORDER.length - 1, currentIdx + 2);
      setCreatingColState({ ...creatingColState, selectedType: FIELD_TYPE_GRID_ORDER[nextIdx] });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const nextIdx = Math.max(0, currentIdx - 2);
      setCreatingColState({ ...creatingColState, selectedType: FIELD_TYPE_GRID_ORDER[nextIdx] });
    } else if (e.key === "ArrowRight" && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      const nextIdx = Math.min(FIELD_TYPE_GRID_ORDER.length - 1, currentIdx + 1);
      if (nextIdx !== currentIdx) {
        e.preventDefault();
        setCreatingColState({ ...creatingColState, selectedType: FIELD_TYPE_GRID_ORDER[nextIdx] });
      }
    } else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) {
      const nextIdx = Math.max(0, currentIdx - 1);
      if (nextIdx !== currentIdx) {
        e.preventDefault();
        setCreatingColState({ ...creatingColState, selectedType: FIELD_TYPE_GRID_ORDER[nextIdx] });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitCreatingColumn();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const prevId = commitCreatingColumn(undefined, { openFormulaEditor: false });
      if (prevId) {
        triggerInsertNewColumn(prevId, "right");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      commitCreatingColumn(undefined, { openFormulaEditor: false });
    }
  };

  const allPropertyIds: string[] = [...dataSource.getSystemColumnIds(), ...customColumns.map((col) => col.id)];
  const originalTableView = views.find((v) => !v.deletable) ?? views[0] ?? activeView;
  const validPropertyIdSet = new Set<string>(allPropertyIds);
  const filterableColumnIds: string[] = isWorkspaceMode
    ? allPropertyIds
    : Array.from(
        new Set([
          "name",
          ...(originalTableView.visibleColumnIds ?? []).filter(
            (colId) => colId !== "name" && validPropertyIdSet.has(colId),
          ),
        ]),
      );
  const filterColumnGroups: TableColumnGroup[] = originalTableView.columnGroups ?? [];

  const filteredPropertyIds = allPropertyIds.filter((colId) => {
    const q = propertySearch.trim().toLowerCase();
    if (!q) return true;
    return getColumnLabel(colId).toLowerCase().includes(q);
  });

  // 跨列分组表头连续区间计算
  const columnGroups: TableColumnGroup[] = dataSource.getColumnGroups();
  const groupByColId = new Map<string, TableColumnGroup>();
  for (const grp of columnGroups) {
    for (const cid of grp.columnIds) {
      if (visibleColumnSet.has(cid) && !groupByColId.has(cid)) {
        groupByColId.set(cid, grp);
      }
    }
  }
  const hasVisibleColumnGroups = groupByColId.size > 0;

  const superHeaderSegments: SuperHeaderSegment[] = [];
  if (hasVisibleColumnGroups) {
    visibleColumnIds.forEach((colId, idx) => {
      const grp = groupByColId.get(colId) ?? null;
      const isFrozen = idx <= frozenEndIndex;
      const prev = superHeaderSegments[superHeaderSegments.length - 1];
      if (prev && prev.group?.id === grp?.id && prev.isFrozen === isFrozen) {
        prev.colIds.push(colId);
        prev.isFreezeBoundary = idx === frozenEndIndex;
      } else {
        superHeaderSegments.push({
          key: `${grp?.id ?? "ungrouped"}:${idx}`,
          group: grp,
          colIds: [colId],
          isFrozen,
          stickyLeftPx: isFrozen ? columnLeftOffsets[idx] : undefined,
          isFreezeBoundary: idx === frozenEndIndex,
        });
      }
    });
  }

  const layoutDepsKey = `${project?.uri?.toString?.() ?? dataSource.scopeKind}:${effectiveTotalRowCount}:${tableRowHeight}:${activeSort ? `${activeSort.columnId}:${activeSort.direction}` : ""}:${activeFilters.length}:${activeFilterConditionCount}:${frozenColumnId ?? ""}:${hasVisibleColumnGroups ? 1 : 0}:${visibleColumnIds.map((c) => `${c}=${getColumnWidth(c)}`).join(",")}`;

  const systemColumnLabels: Partial<Record<SystemColumnId, string>> = {
    name: t("columns.name"),
    images: t("columns.images"),
    createdAt: t("columns.createdAt"),
    updatedAt: t("columns.updatedAt"),
    parents: t("columns.parents"),
    children: t("columns.children"),
    outer: t("columns.outer"),
    inner: t("columns.inner"),
  };

  const formulaEditorColumnOptions: FormulaEditorColumnOption[] = [
    ...ALL_SYSTEM_COLUMN_IDS.map((sysId) => ({
      id: sysId,
      name: getColumnLabel(sysId),
      kind: "system" as const,
      columnType: sysId,
    })),
    ...customColumns.map((col) => ({
      id: col.id,
      name: col.name,
      kind: "custom" as const,
      columnType: col.type,
      isSelf: col.id === formulaEditorState?.colId,
    })),
  ];

  const formulaEditorColOptionMap = new Map(formulaEditorColumnOptions.map((item) => [item.id, item]));

  const renderEditFieldFormContent = (colId: string) => {
    const customCol = customColumnMap.get(colId);
    const isCustom = Boolean(customCol);
    const isProtectedCol = isProtectedTableColumn(customCol);
    const isTypeLockedCol = Boolean(customCol?.protectedRole);
    return (
      <div data-stage-table-edit-field-panel className="w-64 p-3 text-xs select-none">
        <Input
          ref={editNameInputRef}
          value={editFieldName}
          onChange={(e) => setEditFieldName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              handleSaveEditField();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditingFieldState(null);
            }
          }}
          className="border-primary/80 focus-visible:ring-primary/50 h-8 text-xs"
        />

        <div className="mt-2.5">
          {isCustom && !isTypeLockedCol ? (
            <Popover open={editTypeDropdownOpen} onOpenChange={setEditTypeDropdownOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-edit-field-type-trigger
                  className="border-border bg-background/60 hover:bg-accent/50 flex h-8 w-full cursor-pointer items-center justify-between rounded-md border px-2.5 text-xs transition-colors"
                >
                  <span className="flex items-center gap-2 truncate">
                    <CustomColumnIcon type={editFieldType} />
                    <span className="truncate">{t(`columnTypes.${editFieldType}`)}</span>
                  </span>
                  <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={4}
                className="w-auto p-0"
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <FieldTypeGridPicker
                  selectedType={editFieldType}
                  onSelectType={(nextType) => {
                    setEditFieldType(nextType);
                    setEditTypeDropdownOpen(false);
                  }}
                  t={t}
                />
              </PopoverContent>
            </Popover>
          ) : (
            <div className="border-border/70 bg-muted/40 text-muted-foreground flex h-8 w-full items-center justify-between rounded-md border px-2.5 text-xs">
              <span className="flex items-center gap-2 truncate">
                <ColumnIcon columnId={colId} customColumn={customCol} />
                <span className="truncate">{getColumnTypeName(colId)}</span>
              </span>
              {isTypeLockedCol ? (
                <Lock className="size-3.5 shrink-0 opacity-60" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 opacity-40" />
              )}
            </div>
          )}
          {isProtectedCol && (
            <div className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
              {isTypeLockedCol
                ? t("fieldDialog.spacedRepetitionLocked")
                : t("fieldDialog.spacedRepetitionCustomLocked")}
            </div>
          )}
        </div>

        {isCustom && editFieldType === "formula" && (
          <div className="mt-2.5 space-y-1.5">
            <button
              type="button"
              data-open-formula-editor
              onClick={() => {
                dataSource.updateColumn(colId, {
                  name: editFieldName,
                  type: "formula",
                });
                openFormulaEditorForColumn(colId);
              }}
              className="border-border bg-muted/35 hover:bg-accent/50 flex min-h-9 w-full cursor-pointer flex-col items-start justify-center rounded-md border px-2.5 py-1.5 text-left transition-colors"
            >
              {customCol?.formula?.trim() ? (
                <FormulaPillPreview
                  formula={customCol.formula}
                  colMap={formulaEditorColOptionMap}
                  tableLabel={t("formulaEditor.currentTable")}
                  deletedLabel={t("formulaEditor.deletedColumn")}
                  className="max-h-14 overflow-hidden"
                />
              ) : (
                <span className="text-muted-foreground text-[11px]">{t("formulaEditor.clickToSetFormula")}</span>
              )}
            </button>
          </div>
        )}

        {isCustom && customCol?.type === "formula" && editFieldType !== "formula" && (
          <div className="text-muted-foreground bg-muted/40 mt-2 rounded-md px-2 py-1.5 text-[11px] leading-snug">
            {t("formulaEditor.solidifyHint")}
          </div>
        )}

        <div className="border-border/60 mt-3 flex items-center justify-end gap-2 border-t pt-2.5">
          <Button type="button" size="sm" onClick={handleSaveEditField} className="h-7 px-3 text-xs">
            {t("fieldDialog.confirm")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditTypeDropdownOpen(false);
              setEditingFieldState(null);
            }}
            className="h-7 px-3 text-xs"
          >
            {t("fieldDialog.cancel")}
          </Button>
        </div>
      </div>
    );
  };

  const handleViewSelectRows = (uuids: string[], focusCamera?: boolean) => {
    if (uuids.length === 0) {
      clearSelection(true);
      return;
    }
    selectionStore.setState({
      mode: "rows",
      rowIds: new Set(uuids),
      colIds: new Set<string>(),
      cells: new Set<string>(),
      anchorRowId: uuids[0],
      anchorColId: null,
      activeCell: null,
    });
    syncSelectedRowsToCanvas(uuids, focusCamera);
  };

  const commitRenameView = (viewId: string) => {
    const trimmed = renamingViewDraft.trim();
    if (trimmed) {
      dataSource.renameView(viewId, trimmed);
    }
    setRenamingViewId(null);
  };

  const handleCreateView = (type: TableViewType) => {
    dataSource.createView({
      type,
      name: t(`views.defaultName_${type}`),
    });
    setAddViewPopoverOpen(false);
    setActiveEditor(null);
    selectionStore.clear();
  };

  const handleTableAddRow = () => {
    void Promise.resolve(dataSource.createRow({ text: "" })).then((created) => {
      if (created) {
        handleViewSelectRows([created.uuid], false);
        requestAnimationFrame(() => scrollRowIntoViewIfNeeded(created.uuid));
      }
    });
  };

  const tableRowHeightClass = tableRowHeight === "compact" ? "h-8" : tableRowHeight === "tall" ? "h-14" : "h-10";

  const startViewTabDragReorder = (viewId: string, event: React.PointerEvent) => {
    if (event.button !== 0 || renamingViewId === viewId) return;
    const targetEl = event.target as HTMLElement | null;
    if (targetEl?.closest("[data-view-tab-menu-trigger], input, button")) {
      return;
    }

    const startX = event.clientX;
    let isDragging = false;
    let latestHint: { targetViewId: string; position: "before" | "after" } | null = null;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!isDragging) {
        if (Math.abs(moveEvent.clientX - startX) < 5) return;
        isDragging = true;
        setDraggingViewId(viewId);
      }

      const barEl = viewBarRef.current;
      if (!barEl) return;
      const tabNodes = Array.from(barEl.querySelectorAll<HTMLElement>("[data-stage-table-view-tab]"));
      let matched: { targetViewId: string; position: "before" | "after" } | null = null;

      for (const tabEl of tabNodes) {
        const tabId = tabEl.dataset.stageTableViewTab;
        if (!tabId || tabId === viewId) continue;
        const rect = tabEl.getBoundingClientRect();
        if (moveEvent.clientX >= rect.left && moveEvent.clientX <= rect.right) {
          const mid = rect.left + rect.width / 2;
          matched = { targetViewId: tabId, position: moveEvent.clientX < mid ? "before" : "after" };
          break;
        }
      }

      if (!matched && tabNodes.length > 0) {
        const firstOther = tabNodes.find((n) => n.dataset.stageTableViewTab && n.dataset.stageTableViewTab !== viewId);
        const lastOther = [...tabNodes]
          .reverse()
          .find((n) => n.dataset.stageTableViewTab && n.dataset.stageTableViewTab !== viewId);
        if (firstOther && moveEvent.clientX < firstOther.getBoundingClientRect().left) {
          matched = { targetViewId: firstOther.dataset.stageTableViewTab!, position: "before" };
        } else if (lastOther && moveEvent.clientX > lastOther.getBoundingClientRect().right) {
          matched = { targetViewId: lastOther.dataset.stageTableViewTab!, position: "after" };
        }
      }

      latestHint = matched;
      setDropViewHint(matched);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (isDragging) {
        suppressViewClickRef.current = true;
        queueMicrotask(() => {
          suppressViewClickRef.current = false;
        });
        if (latestHint) {
          dataSource.reorderViews(viewId, latestHint.targetViewId, latestHint.position);
        }
      }
      setDraggingViewId(null);
      setDropViewHint(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const activeEditorRow = activeEditor
    ? (loadedRowsList.find(
        (r) => r.uuid === activeEditor.rowUuid && (!activeEditor.docId || !r.docId || r.docId === activeEditor.docId),
      ) ??
      loadedRowByUuid.get(activeEditor.rowUuid) ??
      null)
    : null;
  const activeEditorCol = activeEditor ? customColumnMap.get(activeEditor.colId) : undefined;
  const recordDialogRow = recordDialogTarget
    ? (syncData.allRows.find((r) => r.uuid === recordDialogTarget.uuid) ??
      dataSource.getCachedRow?.(recordDialogTarget.uuid, recordDialogTarget.docId) ??
      loadedRowByUuid.get(recordDialogTarget.uuid) ??
      recordDialogTarget.snapshot ??
      null)
    : null;

  const workspaceDocs = dataSource.getWorkspaceDocs?.() ?? [];
  const workspaceFolders = Array.from(
    new Set(workspaceDocs.map((d) => d.folderPath).filter((f) => f.length > 0)),
  ).sort();
  const filteredScopeDocs = scopeSearch.trim()
    ? workspaceDocs.filter(
        (d) =>
          d.title.toLowerCase().includes(scopeSearch.trim().toLowerCase()) ||
          d.relPath.toLowerCase().includes(scopeSearch.trim().toLowerCase()),
      )
    : workspaceDocs;
  const workspaceScopeLabel = (() => {
    if (!activeWorkspaceScope || activeWorkspaceScope.kind === "all") return t("scope.allWorkspace");
    if (activeWorkspaceScope.kind === "folders") {
      return activeWorkspaceScope.paths.length > 0
        ? t("scope.selectedFolders", { count: activeWorkspaceScope.paths.length })
        : t("scope.allWorkspace");
    }
    return activeWorkspaceScope.paths.length > 0
      ? t("scope.selectedDocs", { count: activeWorkspaceScope.paths.length })
      : t("scope.allWorkspace");
  })();

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-stage-table-panel
      onKeyDown={handlePanelKeyDown}
      onWheel={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      className="bg-background relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden outline-none"
    >
      {/* 共享隐藏图片上传 input */}
      <input
        ref={rowImageUploadRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? []);
          const target = rowImageUploadTargetRef.current;
          if (target && selected.length > 0) {
            void dataSource.executeMutation({
              type: "add_images",
              docId: target.docId,
              rowUuid: target.rowUuid,
              blobs: selected,
            });
          }
          rowImageUploadTargetRef.current = null;
          e.target.value = "";
        }}
      />

      {/* 第一行：顶部多视图标签栏 */}
      <div
        ref={viewBarRef}
        data-stage-table-view-bar
        className="border-border/60 flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 pt-1 [scrollbar-width:none]"
      >
        {views.map((view) => {
          const isActive = view.id === activeView.id;
          const isRenaming = renamingViewId === view.id;
          const canDelete = view.deletable && views.length > 1;
          const showBefore = dropViewHint?.targetViewId === view.id && dropViewHint.position === "before";
          const showAfter = dropViewHint?.targetViewId === view.id && dropViewHint.position === "after";

          return (
            <ContextMenu key={view.id}>
              <ContextMenuTrigger asChild>
                <div
                  data-stage-table-view-tab={view.id}
                  data-view-type={view.type}
                  data-view-active={isActive ? "true" : undefined}
                  onPointerDown={(e) => startViewTabDragReorder(view.id, e)}
                  onClick={() => {
                    if (suppressViewClickRef.current) return;
                    if (!isActive && !isRenaming) {
                      dataSource.setActiveView(view.id);
                      setActiveEditor(null);
                      selectionStore.clear();
                    }
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenamingViewId(view.id);
                    setRenamingViewDraft(view.name);
                  }}
                  className={cn(
                    "relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors select-none",
                    !isRenaming ? "cursor-grab active:cursor-grabbing" : "cursor-text",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    draggingViewId === view.id && "opacity-50",
                  )}
                >
                  {showBefore && (
                    <div className="bg-primary pointer-events-none absolute top-1 bottom-1 left-0 w-0.5 rounded-full" />
                  )}
                  {showAfter && (
                    <div className="bg-primary pointer-events-none absolute top-1 right-0 bottom-1 w-0.5 rounded-full" />
                  )}

                  <ViewTypeIcon type={view.type} />

                  {isRenaming ? (
                    <Input
                      ref={viewRenameInputRef}
                      data-view-rename-input
                      value={renamingViewDraft}
                      onChange={(e) => setRenamingViewDraft(e.target.value)}
                      onBlur={() => commitRenameView(view.id)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRenameView(view.id);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenamingViewId(null);
                        }
                      }}
                      className="h-5 w-24 px-1.5 py-0 text-xs"
                    />
                  ) : (
                    <span className="max-w-32 truncate">{view.name || t("defaultViewName")}</span>
                  )}

                  {isActive && !isRenaming && (
                    <Popover
                      open={viewMenuOpenId === view.id}
                      onOpenChange={(open) => setViewMenuOpenId(open ? view.id : null)}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          data-view-tab-menu-trigger={view.id}
                          aria-label={t("views.manageView")}
                          onClick={(e) => e.stopPropagation()}
                          className="text-muted-foreground hover:bg-background/70 hover:text-foreground -mr-1 flex size-4 cursor-pointer items-center justify-center rounded transition-colors"
                        >
                          <MoreVertical className="size-3 shrink-0" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className="w-40 p-1 text-xs select-none"
                        onWheel={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          data-view-action-rename
                          onClick={() => {
                            setViewMenuOpenId(null);
                            setRenamingViewId(view.id);
                            setRenamingViewDraft(view.name);
                          }}
                          className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left"
                        >
                          <Pencil className="size-3.5" />
                          <span>{t("views.renameView")}</span>
                        </button>
                        <button
                          type="button"
                          data-view-action-duplicate
                          onClick={() => {
                            setViewMenuOpenId(null);
                            dataSource.duplicateView(view.id, t("headerMenu.copySuffix"));
                          }}
                          className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left"
                        >
                          <CopyPlus className="size-3.5" />
                          <span>{t("views.duplicateView")}</span>
                        </button>
                        <div className="bg-border/70 my-1 h-px" />
                        <button
                          type="button"
                          data-view-action-delete
                          disabled={!canDelete}
                          onClick={() => {
                            setViewMenuOpenId(null);
                            dataSource.deleteView(view.id);
                          }}
                          className="text-destructive hover:bg-destructive/12 flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left disabled:pointer-events-none disabled:opacity-40"
                        >
                          <Trash2 className="size-3.5" />
                          <span>{t("views.deleteView")}</span>
                        </button>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                className="w-40"
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <ContextMenuItem
                  onSelect={() =>
                    scheduleAfterContextMenu(() => {
                      setRenamingViewId(view.id);
                      setRenamingViewDraft(view.name);
                    })
                  }
                  className="text-xs"
                >
                  <Pencil className="size-3.5" />
                  <span>{t("views.renameView")}</span>
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => dataSource.duplicateView(view.id, t("headerMenu.copySuffix"))}
                  className="text-xs"
                >
                  <CopyPlus className="size-3.5" />
                  <span>{t("views.duplicateView")}</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  disabled={!canDelete}
                  onSelect={() => dataSource.deleteView(view.id)}
                  className="text-xs"
                >
                  <Trash2 className="size-3.5" />
                  <span>{t("views.deleteView")}</span>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}

        <div className="bg-border mx-1 h-3.5 w-px shrink-0" />

        {/* 新建视图菜单 */}
        <Popover open={addViewPopoverOpen} onOpenChange={setAddViewPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-stage-table-add-view-btn
              aria-label={t("addViewPlaceholder")}
              className="text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
            >
              <Plus className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            data-stage-table-add-view-menu
            className="w-44 p-1.5 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-muted-foreground mb-1 flex items-center gap-1 px-2 py-1 text-[11px] font-medium">
              <span>{t("views.createViewTitle")}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex cursor-help items-center">
                    <Info className="size-3 opacity-75" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-52 text-xs">
                  {t("views.createViewHint")}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="space-y-0.5">
              {TABLE_VIEW_TYPES.map((viewType) => (
                <button
                  key={viewType}
                  type="button"
                  data-create-view-option={viewType}
                  onClick={() => handleCreateView(viewType)}
                  className="hover:bg-accent text-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs transition-colors"
                >
                  <ViewTypeIcon type={viewType} className="size-4" />
                  <span>{t(`views.type_${viewType}`)}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* 工作空间范围切换（入口 1：画布分屏快捷切换 / 入口 2：全屏工作空间视图级范围选择）+ 共享字段管理 */}
        {(canSwitchDockScope || isWorkspaceMode) && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
            {canSwitchDockScope && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-stage-table-dock-scope-trigger
                    className={cn(
                      "border-border/70 hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px] transition-colors select-none",
                      dockScopeMode !== "current_doc"
                        ? "border-primary/50 bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {dockScopeMode === "current_doc" ? (
                      <FileText className="size-3" />
                    ) : dockScopeMode === "current_folder" ? (
                      <Folder className="size-3" />
                    ) : (
                      <Globe className="size-3" />
                    )}
                    <span>
                      {dockScopeMode === "current_doc"
                        ? t("scope.currentDoc")
                        : dockScopeMode === "current_folder"
                          ? t("scope.currentFolder")
                          : t("scope.allWorkspace")}
                    </span>
                    <ChevronDown className="size-3 opacity-70" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-44 p-1 text-xs select-none"
                  onWheel={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {(
                    [
                      { id: "current_doc", label: t("scope.currentDoc"), icon: FileText },
                      ...(currentRelFolder
                        ? [{ id: "current_folder" as const, label: t("scope.currentFolder"), icon: Folder }]
                        : []),
                      { id: "workspace", label: t("scope.allWorkspace"), icon: Globe },
                    ] as Array<{
                      id: "current_doc" | "current_folder" | "workspace";
                      label: string;
                      icon: typeof FileText;
                    }>
                  ).map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setDockScopeMode(item.id);
                          setActiveEditor(null);
                          selectionStore.clear();
                        }}
                        className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left"
                      >
                        <Icon className="text-muted-foreground size-3.5" />
                        <span className="flex-1 truncate">{item.label}</span>
                        {dockScopeMode === item.id && <Check className="text-primary size-3.5" />}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            )}

            {isWorkspaceMode && !project && dataSource.setScope && (
              <Popover
                onOpenChange={(open) => {
                  if (!open) setScopeSearch("");
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-workspace-scope-picker
                    className="border-border/70 hover:bg-accent text-foreground inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px] transition-colors select-none"
                  >
                    <Globe className="text-primary size-3" />
                    <span className="max-w-36 truncate">{workspaceScopeLabel}</span>
                    <ChevronDown className="size-3 opacity-70" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-72 space-y-2 p-2.5 text-xs select-none"
                  onWheel={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="bg-muted grid grid-cols-3 rounded-md p-0.5 text-[11px]">
                    {(["all", "folders", "docs"] as const).map((kind) => {
                      const active = (activeWorkspaceScope?.kind ?? "all") === kind;
                      return (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => {
                            if (kind === "all") {
                              dataSource.setScope?.({ kind: "all", paths: [] });
                            } else if (kind === "folders") {
                              dataSource.setScope?.({
                                kind: "folders",
                                paths: activeWorkspaceScope?.kind === "folders" ? activeWorkspaceScope.paths : [],
                              });
                            } else {
                              dataSource.setScope?.({
                                kind: "docs",
                                paths: activeWorkspaceScope?.kind === "docs" ? activeWorkspaceScope.paths : [],
                              });
                            }
                          }}
                          className={cn(
                            "cursor-pointer rounded px-2 py-1 text-center transition-colors",
                            active
                              ? "bg-background text-foreground font-medium shadow-xs"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {t(`scope.mode_${kind}`)}
                        </button>
                      );
                    })}
                  </div>

                  {activeWorkspaceScope?.kind === "all" && (
                    <div className="text-muted-foreground px-1 py-2 text-[11px]">
                      {t("scope.allSummary", { count: workspaceDocs.length })}
                    </div>
                  )}

                  {activeWorkspaceScope?.kind === "folders" && (
                    <div className="max-h-52 space-y-0.5 overflow-y-auto">
                      {workspaceFolders.length === 0 ? (
                        <div className="text-muted-foreground py-4 text-center text-[11px]">{t("scope.noFolders")}</div>
                      ) : (
                        workspaceFolders.map((folder) => {
                          const checked = activeWorkspaceScope.paths.includes(folder);
                          return (
                            <label
                              key={folder}
                              className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(val) => {
                                  const next = val
                                    ? Array.from(new Set([...activeWorkspaceScope.paths, folder]))
                                    : activeWorkspaceScope.paths.filter((p) => p !== folder);
                                  dataSource.setScope?.({ kind: "folders", paths: next });
                                }}
                              />
                              <Folder className="text-muted-foreground size-3.5 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">{folder}</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  )}

                  {activeWorkspaceScope?.kind === "docs" && (
                    <div className="space-y-1.5">
                      <Input
                        value={scopeSearch}
                        onChange={(e) => setScopeSearch(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                        placeholder={t("propertiesPopover.searchPlaceholder")}
                        className="h-7 text-xs"
                      />
                      <div className="max-h-52 space-y-0.5 overflow-y-auto">
                        {filteredScopeDocs.map((doc) => {
                          const checked = activeWorkspaceScope.paths.includes(doc.relPath);
                          return (
                            <label
                              key={doc.docId}
                              className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(val) => {
                                  const next = val
                                    ? Array.from(new Set([...activeWorkspaceScope.paths, doc.relPath]))
                                    : activeWorkspaceScope.paths.filter((p) => p !== doc.relPath);
                                  dataSource.setScope?.({ kind: "docs", paths: next });
                                }}
                              />
                              <FileText className="text-muted-foreground size-3.5 shrink-0" />
                              <span className="min-w-0 flex-1 truncate" title={doc.relPath}>
                                {doc.title}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            )}

            {isWorkspaceMode && (
              <button
                type="button"
                data-workspace-columns-trigger
                onClick={() => setWorkspaceColumnsDialogOpen(true)}
                className="border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px] transition-colors select-none"
              >
                <Layers className="size-3" />
                <span>{t("workspaceColumns.button")}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* 非表格 5 大视图 */}
      {activeViewType !== "table" && (
        <NonTableViewBridge
          activeViewType={activeViewType}
          project={project ?? null}
          dataSource={dataSource}
          dataRevision={revision}
          selectionStore={selectionStore}
          activeView={activeView}
          allRows={syncData.allRows}
          rows={syncData.rows}
          allColumnIds={allPropertyIds}
          filterableColumnIds={filterableColumnIds}
          filterColumnGroups={filterColumnGroups}
          visibleColumnIds={visibleColumnIds}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          activeFilters={activeFilters}
          activeFilterGroup={activeFilterGroup}
          activeSort={activeSort}
          getColumnLabel={getColumnLabel}
          onSelectRows={handleViewSelectRows}
          onOpenRecord={(uuid, row) => setRecordDialogTarget({ uuid, docId: row?.docId, snapshot: row })}
          onPreviewImage={(attId, rowUuid, docId) => openImagePreview(attId, rowUuid, docId)}
          onOpenFormulaEditor={(colId, rowUuid) => openFormulaEditorForColumn(colId, rowUuid)}
          t={t}
        />
      )}

      {/* 主表格视图（虚拟化行 + 单例浮层 + 零重渲染列宽拖拽） */}
      {activeViewType === "table" && (
        <>
          <div className="border-border/60 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 text-xs [scrollbar-width:none]">
            <button
              type="button"
              data-stage-table-add-row
              onClick={handleTableAddRow}
              className="text-primary hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 font-medium transition-colors"
            >
              <PlusCircle className="size-3.5" />
              <span>{t("toolbar.addRow")}</span>
            </button>

            <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

            {/* 属性显隐弹窗 */}
            <Popover
              onOpenChange={(open) => {
                if (!open) setPropertySearch("");
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="text-foreground hover:bg-accent data-[state=open]:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
                >
                  <List className="size-3.5" />
                  <span>{t("toolbar.properties")}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-60 p-0"
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="border-b p-2">
                  <div className="relative flex items-center">
                    <Search className="text-muted-foreground pointer-events-none absolute left-2 size-3.5" />
                    <Input
                      value={propertySearch}
                      onChange={(e) => setPropertySearch(e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                      placeholder={t("propertiesPopover.searchPlaceholder")}
                      className="h-7 pl-7 text-xs"
                    />
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto p-1">
                  {filteredPropertyIds.map((colId) => {
                    const isPrimary = colId === "name";
                    const checked = dataSource.isColumnVisible(colId);
                    const customCol = customColumnMap.get(colId);
                    return (
                      <div
                        key={colId}
                        className={cn(
                          "hover:bg-accent flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs select-none",
                          isPrimary && "opacity-85",
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={isPrimary}
                          onCheckedChange={(val) => {
                            if (!isPrimary) {
                              dataSource.setColumnVisible(colId, Boolean(val));
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (!isPrimary) {
                              dataSource.setColumnVisible(colId, !checked);
                            }
                          }}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2 text-left",
                            isPrimary ? "cursor-default" : "cursor-pointer",
                          )}
                        >
                          <ColumnIcon columnId={colId} customColumn={customCol} />
                          <span className="min-w-0 flex-1 truncate">{getColumnLabel(colId)}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={t("headerMenu.editField")}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditFieldPanel(colId, "floating");
                          }}
                          className="text-muted-foreground/70 hover:bg-background hover:text-foreground rounded p-0.5"
                        >
                          <ChevronRight className="size-3.5 shrink-0" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>

            <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

            <StageTableFilterToolbarPopover
              filterableColumnIds={filterableColumnIds}
              columnGroups={filterColumnGroups}
              customColumns={customColumns}
              customColumnMap={customColumnMap}
              allRows={loadedRowsList}
              dataSource={dataSource}
              activeFilters={activeFilters}
              filterGroup={activeFilterGroup}
              getColumnLabel={getColumnLabel}
              onSetConjunction={(conj) => dataSource.setFilterConjunction(conj)}
              onAddCondition={(cid) => dataSource.addFilterCondition(cid)}
              onUpdateCondition={(id, patch) => dataSource.updateFilterCondition(id, patch)}
              onRemoveCondition={(id) => dataSource.removeFilterCondition(id)}
              onToggleConditionCollapse={(id) => dataSource.toggleFilterConditionCollapsed(id)}
              onReorderConditions={(dragId, targetId, pos) => dataSource.reorderFilterConditions(dragId, targetId, pos)}
              onSetColumnFilter={(cid, flt) => dataSource.setColumnFilter(cid, flt)}
              onClearAllFilters={() => dataSource.clearAllFilters()}
              t={t}
            />

            <button
              type="button"
              className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-6 shrink-0 items-center gap-1 rounded px-2 transition-colors"
            >
              <ListTree className="size-3.5" />
              <span>{t("toolbar.group")}</span>
            </button>

            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-stage-table-sort-toolbar
                  className={cn(
                    "hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors",
                    activeSort
                      ? "bg-primary/15 text-primary font-medium"
                      : "text-muted-foreground hover:text-foreground",
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
                      onClick={() => dataSource.setSort(null)}
                      className="text-primary cursor-pointer text-[11px] hover:underline"
                    >
                      {t("sortFilter.clearSort")}
                    </button>
                  )}
                </div>
                <div className="max-h-56 space-y-0.5 overflow-y-auto">
                  {visibleColumnIds.map((cid) => {
                    const isAsc = activeSort?.columnId === cid && activeSort.direction === "asc";
                    const isDesc = activeSort?.columnId === cid && activeSort.direction === "desc";
                    return (
                      <div
                        key={cid}
                        className="hover:bg-accent/60 flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs"
                      >
                        <ColumnIcon columnId={cid} customColumn={customColumnMap.get(cid)} />
                        <span
                          className={cn("min-w-0 flex-1 truncate", (isAsc || isDesc) && "text-primary font-medium")}
                        >
                          {getColumnLabel(cid)}
                        </span>
                        <button
                          type="button"
                          aria-label={t("sortFilter.sortAsc")}
                          onClick={() => dataSource.setSort(isAsc ? null : { columnId: cid, direction: "asc" })}
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
                          onClick={() => dataSource.setSort(isDesc ? null : { columnId: cid, direction: "desc" })}
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

            <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-stage-table-row-height
                  className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
                >
                  <UnfoldVertical className="size-3.5" />
                  <span>{t("toolbar.rowHeight")}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-32 p-1 text-xs select-none"
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {(["compact", "medium", "tall"] as const).map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => dataSource.updateActiveViewConfig({ rowHeight: h })}
                    className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5"
                  >
                    <span>{t(`calendar.height_${h}`)}</span>
                    {tableRowHeight === h && <Check className="text-primary size-3.5" />}
                  </button>
                ))}
              </PopoverContent>
            </Popover>

            <SelectionSummaryBadge
              selectionStore={selectionStore}
              totalRowCount={effectiveTotalRowCount}
              onClear={clearSelection}
              t={t}
            />
          </div>

          <TableScrollContainer layoutDepsKey={layoutDepsKey} externalViewportRef={viewportRef}>
            <table
              ref={tableGridRef}
              data-stage-table-grid
              style={{ width: `${totalTableWidth}px`, tableLayout: "fixed" }}
              className="border-collapse text-left text-xs"
            >
              <colgroup>
                <col style={{ width: `${INDEX_COLUMN_WIDTH}px` }} />
                {visibleColumnIds.map((colId) => (
                  <col key={colId} data-col-width-id={colId} style={{ width: `${getColumnWidth(colId)}px` }} />
                ))}
                <col style={{ width: `${ADD_COLUMN_WIDTH}px` }} />
              </colgroup>

              <thead className="bg-muted sticky top-0 z-20">
                {hasVisibleColumnGroups && (
                  <tr data-stage-table-group-row className="border-border/60 border-b">
                    <th
                      style={frozenEndIndex >= 0 ? { left: "0px" } : undefined}
                      className={cn(
                        "border-border/50 bg-muted h-7 border-r p-0 select-none",
                        frozenEndIndex >= 0 && "sticky z-30",
                      )}
                    />
                    {superHeaderSegments.map((seg) => {
                      const grp = seg.group;
                      const isRenamingThis = grp && renamingGroupId === grp.id;
                      return (
                        <th
                          key={seg.key}
                          colSpan={seg.colIds.length}
                          style={seg.isFrozen ? { left: `${seg.stickyLeftPx ?? 0}px` } : undefined}
                          className={cn(
                            "border-border/50 bg-muted relative h-7 border-r px-2 font-medium select-none",
                            seg.isFrozen && "sticky z-30",
                            seg.isFreezeBoundary && "border-r-primary/45 border-r-2",
                          )}
                        >
                          {grp ? (
                            isRenamingThis ? (
                              <Input
                                ref={groupRenameInputRef}
                                value={renamingGroupDraft}
                                onChange={(e) => setRenamingGroupDraft(e.target.value)}
                                onBlur={() => {
                                  if (renamingGroupDraft.trim()) {
                                    dataSource.renameColumnGroup(grp.id, renamingGroupDraft);
                                  }
                                  setRenamingGroupId(null);
                                }}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    if (renamingGroupDraft.trim()) {
                                      dataSource.renameColumnGroup(grp.id, renamingGroupDraft);
                                    }
                                    setRenamingGroupId(null);
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    setRenamingGroupId(null);
                                  }
                                }}
                                className="h-5 px-1.5 py-0 text-center text-[11px]"
                              />
                            ) : (
                              <div
                                onDoubleClick={() => {
                                  setRenamingGroupId(grp.id);
                                  setRenamingGroupDraft(grp.name);
                                }}
                                className="flex h-full w-full items-center justify-center gap-1"
                              >
                                <span className="text-foreground/90 truncate text-[11px] font-medium">{grp.name}</span>
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      data-column-group-menu-trigger={grp.id}
                                      aria-label={t("columnGroups.manageGroup")}
                                      className="text-muted-foreground hover:bg-accent hover:text-foreground absolute right-1.5 flex size-4 items-center justify-center rounded-xs transition-colors"
                                    >
                                      <ChevronDown className="size-3" />
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    align="end"
                                    className="w-56 p-2"
                                    onWheel={(e) => e.stopPropagation()}
                                    onMouseDown={(e) => e.stopPropagation()}
                                  >
                                    <div className="mb-2 space-y-1">
                                      <div className="text-muted-foreground px-1 text-[11px] font-medium">
                                        {t("columnGroups.groupNameLabel")}
                                      </div>
                                      <Input
                                        defaultValue={grp.name}
                                        onBlur={(e) => {
                                          if (e.target.value.trim()) {
                                            dataSource.renameColumnGroup(grp.id, e.target.value);
                                          }
                                        }}
                                        onKeyDown={(e) => {
                                          e.stopPropagation();
                                          if (e.key === "Enter") {
                                            e.preventDefault();
                                            const val = (e.currentTarget as HTMLInputElement).value;
                                            if (val.trim()) {
                                              dataSource.renameColumnGroup(grp.id, val);
                                            }
                                          }
                                        }}
                                        className="h-7 text-xs"
                                      />
                                    </div>
                                    <div className="text-muted-foreground mb-1 px-1 text-[11px] font-medium">
                                      {t("columnGroups.includedColumns")}
                                    </div>
                                    <div className="max-h-44 space-y-0.5 overflow-y-auto">
                                      {visibleColumnIds.map((cid) => {
                                        const inThisGroup = grp.columnIds.includes(cid);
                                        return (
                                          <label
                                            key={cid}
                                            className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs"
                                          >
                                            <Checkbox
                                              checked={inThisGroup}
                                              onCheckedChange={(checked) => {
                                                dataSource.setColumnInGroup(cid, checked ? grp.id : null);
                                              }}
                                            />
                                            <ColumnIcon columnId={cid} customColumn={customColumnMap.get(cid)} />
                                            <span className="truncate">{getColumnLabel(cid)}</span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                    <div className="border-border/60 mt-2 border-t pt-1.5">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => dataSource.dissolveColumnGroup(grp.id)}
                                        className="text-destructive hover:text-destructive h-7 w-full justify-start gap-1.5 px-2 text-xs"
                                      >
                                        <Trash2 className="size-3.5" />
                                        <span>{t("columnGroups.dissolveGroup")}</span>
                                      </Button>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              </div>
                            )
                          ) : (
                            <div className="group/ungrp flex h-full w-full items-center justify-center">
                              <button
                                type="button"
                                onClick={() => {
                                  const createdGrp = dataSource.createColumnGroup(
                                    t("columnGroups.defaultName"),
                                    seg.colIds,
                                  );
                                  if (createdGrp) {
                                    setRenamingGroupId(createdGrp.id);
                                    setRenamingGroupDraft(createdGrp.name);
                                  }
                                }}
                                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] opacity-0 transition-opacity group-hover/ungrp:opacity-100"
                              >
                                <Plus className="size-3" />
                                <span>{t("columnGroups.createGroup")}</span>
                              </button>
                            </div>
                          )}
                        </th>
                      );
                    })}
                    <th className="bg-muted h-7 p-0" />
                  </tr>
                )}

                <tr ref={headerRowRef} className="border-border/60 border-b">
                  <SelectAllHeaderCell
                    selectionStore={selectionStore}
                    frozenEndIndex={frozenEndIndex}
                    title={t("selection.selectAllAria")}
                    onToggleSelectAll={handleToggleSelectAll}
                  />

                  {visibleColumnIds.map((colId, colIdx) => {
                    const width = getColumnWidth(colId);
                    const customCol = customColumnMap.get(colId);
                    const isNameCol = colId === "name";
                    const isDraggingThis = draggingColId === colId;
                    const showDropBefore = dropHint?.targetColId === colId && dropHint.position === "before";
                    const showDropAfter = dropHint?.targetColId === colId && dropHint.position === "after";
                    const isFrozen = colIdx <= frozenEndIndex;
                    const isFreezeBoundary = colIdx === frozenEndIndex;
                    const isFrozenTarget = frozenColumnId === colId;
                    const isHeaderEditing = editingFieldState?.colId === colId && editingFieldState.anchor === "header";
                    const isCreatingThis = creatingColState?.colId === colId;
                    const currentGroup = groupByColId.get(colId);
                    const colSortDir: TableSortDirection | null =
                      activeSort?.columnId === colId ? activeSort.direction : null;
                    const colFilter = activeFilterByColId.get(colId) ?? null;
                    const isColFiltered = colFilter !== null || activeFilterGroupColIds.has(colId);
                    const isFilterMenuOpen = filterPopoverColId === colId;

                    return (
                      <SelectableColumnHeaderCell
                        key={colId}
                        colId={colId}
                        colIdx={colIdx}
                        selectionStore={selectionStore}
                        isFrozen={isFrozen}
                        isFreezeBoundary={isFreezeBoundary}
                        stickyLeftPx={columnLeftOffsets[colIdx]}
                        isNameCol={isNameCol}
                        isCreatingThis={isCreatingThis}
                        isDraggingThis={isDraggingThis}
                        colSortDir={colSortDir}
                        isColFiltered={isColFiltered}
                        isFilterMenuOpen={isFilterMenuOpen}
                        onPointerDown={(e) => startColumnDragReorder(colId, e)}
                      >
                        <Popover
                          open={isHeaderEditing || isCreatingThis}
                          onOpenChange={(open) => {
                            if (!open) {
                              if (isHeaderEditing) {
                                setEditTypeDropdownOpen(false);
                                setEditingFieldState(null);
                              }
                              if (isCreatingThis) {
                                commitCreatingColumn();
                              }
                            }
                          }}
                        >
                          <PopoverAnchor asChild>
                            <div data-col-popover-anchor={colId} className="size-full">
                              {isCreatingThis ? (
                                <div className="border-b-primary bg-background/90 flex h-full w-full items-center border-b-2 px-2">
                                  <input
                                    ref={creatingTitleInputRef}
                                    data-creating-col-title-input
                                    value={creatingColState.draftTitle}
                                    onChange={(e) =>
                                      setCreatingColState({ ...creatingColState, draftTitle: e.target.value })
                                    }
                                    onKeyDown={handleCreateTitleKeyDown}
                                    placeholder={t("insertFieldPopover.titlePlaceholder")}
                                    className="text-foreground placeholder:text-muted-foreground h-full w-full bg-transparent text-center text-xs outline-none"
                                  />
                                </div>
                              ) : (
                                <ContextMenu>
                                  <ContextMenuTrigger asChild>
                                    <div
                                      onDoubleClick={(e) => {
                                        const targetEl = e.target as HTMLElement | null;
                                        if (targetEl?.closest("[data-col-filter-trigger], [data-col-sort-indicator]")) {
                                          return;
                                        }
                                        e.stopPropagation();
                                        dataSource.toggleColumnSort(colId);
                                      }}
                                      className="hover:bg-accent/40 relative flex h-full w-full items-stretch"
                                    >
                                      {colSortDir && (
                                        <button
                                          type="button"
                                          data-col-sort-indicator={colId}
                                          data-sort-direction={colSortDir}
                                          aria-label={t("sortFilter.toggleSortAria")}
                                          title={
                                            colSortDir === "asc" ? t("sortFilter.sortAsc") : t("sortFilter.sortDesc")
                                          }
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            dataSource.toggleColumnSort(colId, colSortDir === "asc" ? "desc" : "asc");
                                          }}
                                          className="text-primary hover:bg-primary/15 absolute top-0 left-1/2 z-10 flex h-3.5 w-6 -translate-x-1/2 cursor-pointer items-center justify-center rounded-b transition-colors"
                                        >
                                          {colSortDir === "asc" ? (
                                            <ChevronUp className="size-3 stroke-[2.25]" />
                                          ) : (
                                            <ChevronDown className="size-3 stroke-[2.25]" />
                                          )}
                                        </button>
                                      )}

                                      <div
                                        className={cn(
                                          "flex min-w-0 flex-1 items-center gap-1.5 truncate pr-1 pl-2.5",
                                          colSortDir && "pt-1.5",
                                        )}
                                      >
                                        <ColumnIcon columnId={colId} customColumn={customCol} />
                                        <span className="truncate">{getColumnLabel(colId)}</span>
                                      </div>

                                      <Popover
                                        open={isFilterMenuOpen}
                                        onOpenChange={(open) => setFilterPopoverColId(open ? colId : null)}
                                      >
                                        <PopoverTrigger asChild>
                                          <button
                                            type="button"
                                            data-col-filter-trigger={colId}
                                            aria-label={t("sortFilter.columnFilterAria")}
                                            onPointerDown={(e) => e.stopPropagation()}
                                            onClick={(e) => e.stopPropagation()}
                                            className={cn(
                                              "relative mr-1 flex w-6 shrink-0 cursor-pointer items-center justify-center border-l transition-all",
                                              isColFiltered || colSortDir || isFilterMenuOpen
                                                ? "border-border/70 bg-primary/10 text-primary opacity-100"
                                                : "text-muted-foreground/80 group-hover/th:border-border/60 hover:bg-accent hover:text-foreground border-transparent opacity-45 group-hover/th:opacity-100",
                                            )}
                                          >
                                            <ChevronDown className="size-3" />
                                            {isColFiltered && (
                                              <span className="bg-primary absolute top-1 right-1 size-1.5 rounded-full" />
                                            )}
                                          </button>
                                        </PopoverTrigger>
                                        {isFilterMenuOpen && (
                                          <PopoverContent
                                            align="end"
                                            sideOffset={4}
                                            className="w-auto p-0"
                                            onWheel={(e) => e.stopPropagation()}
                                            onMouseDown={(e) => e.stopPropagation()}
                                            onPointerDown={(e) => e.stopPropagation()}
                                          >
                                            <ColumnFilterSortPopoverContent
                                              columnId={colId}
                                              customCol={customCol}
                                              allRows={syncData.allRows}
                                              dataSource={dataSource}
                                              activeSort={activeSort}
                                              activeFilter={colFilter}
                                              onSetSort={(nextSort) => dataSource.setSort(nextSort)}
                                              onSetFilter={(nextFlt) => dataSource.setColumnFilter(colId, nextFlt)}
                                              t={t}
                                            />
                                          </PopoverContent>
                                        )}
                                      </Popover>
                                    </div>
                                  </ContextMenuTrigger>

                                  <ContextMenuContent
                                    className="w-52"
                                    onWheel={(e) => e.stopPropagation()}
                                    onMouseDown={(e) => e.stopPropagation()}
                                  >
                                    <ContextMenuItem
                                      onSelect={() =>
                                        scheduleAfterContextMenu(() => openEditFieldPanel(colId, "header"))
                                      }
                                      className="text-xs"
                                    >
                                      <SquarePen className="size-3.5" />
                                      <span>{t("headerMenu.editField")}</span>
                                      <span className="text-muted-foreground ml-auto pl-4 text-[11px]">
                                        {getColumnTypeName(colId)}
                                      </span>
                                    </ContextMenuItem>

                                    {customCol?.type === "formula" && (
                                      <ContextMenuItem
                                        onSelect={() =>
                                          scheduleAfterContextMenu(() => openFormulaEditorForColumn(colId))
                                        }
                                        className="text-xs"
                                      >
                                        <FunctionSquare className="size-3.5" />
                                        <span>{t("formulaEditor.editFormula")}</span>
                                      </ContextMenuItem>
                                    )}

                                    <ContextMenuSub>
                                      <ContextMenuSubTrigger inset className="text-xs">
                                        <span>{t("headerMenu.insertField")}</span>
                                      </ContextMenuSubTrigger>
                                      <ContextMenuSubContent
                                        className="w-36"
                                        onWheel={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => e.stopPropagation()}
                                      >
                                        <ContextMenuItem
                                          disabled={isNameCol}
                                          onSelect={() =>
                                            scheduleAfterContextMenu(() => triggerInsertNewColumn(colId, "left"))
                                          }
                                          className="text-xs"
                                        >
                                          <ArrowLeft className="size-3.5" />
                                          <span>{t("headerMenu.insertLeft")}</span>
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                          onSelect={() =>
                                            scheduleAfterContextMenu(() => triggerInsertNewColumn(colId, "right"))
                                          }
                                          className="text-xs"
                                        >
                                          <ArrowRight className="size-3.5" />
                                          <span>{t("headerMenu.insertRight")}</span>
                                        </ContextMenuItem>
                                      </ContextMenuSubContent>
                                    </ContextMenuSub>

                                    <ContextMenuSub>
                                      <ContextMenuSubTrigger className="text-xs">
                                        <FolderPlus className="size-3.5" />
                                        <span>{t("columnGroups.menuLabel")}</span>
                                      </ContextMenuSubTrigger>
                                      <ContextMenuSubContent
                                        className="w-44"
                                        onWheel={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => e.stopPropagation()}
                                      >
                                        <ContextMenuItem
                                          onSelect={() =>
                                            scheduleAfterContextMenu(() => {
                                              const grp = dataSource.createColumnGroup(t("columnGroups.defaultName"), [
                                                colId,
                                              ]);
                                              if (grp) {
                                                setRenamingGroupId(grp.id);
                                                setRenamingGroupDraft(grp.name);
                                              }
                                            })
                                          }
                                          className="text-xs"
                                        >
                                          <Plus className="size-3.5" />
                                          <span>{t("columnGroups.createGroup")}</span>
                                        </ContextMenuItem>

                                        {columnGroups.length > 0 && <ContextMenuSeparator />}

                                        {columnGroups.map((grp) => {
                                          const active = currentGroup?.id === grp.id;
                                          return (
                                            <ContextMenuItem
                                              key={grp.id}
                                              onSelect={() =>
                                                dataSource.setColumnInGroup(colId, active ? null : grp.id)
                                              }
                                              className="text-xs"
                                            >
                                              <span className="flex size-3.5 shrink-0 items-center justify-center">
                                                {active && <Check className="text-primary size-3.5" />}
                                              </span>
                                              <span className="truncate">{grp.name}</span>
                                            </ContextMenuItem>
                                          );
                                        })}

                                        {currentGroup && (
                                          <>
                                            <ContextMenuSeparator />
                                            <ContextMenuItem
                                              onSelect={() => dataSource.setColumnInGroup(colId, null)}
                                              className="text-xs"
                                            >
                                              <X className="size-3.5" />
                                              <span>{t("columnGroups.removeFromGroup")}</span>
                                            </ContextMenuItem>
                                            <ContextMenuItem
                                              variant="destructive"
                                              onSelect={() => dataSource.dissolveColumnGroup(currentGroup.id)}
                                              className="text-xs"
                                            >
                                              <Trash2 className="size-3.5" />
                                              <span>{t("columnGroups.dissolveGroup")}</span>
                                            </ContextMenuItem>
                                          </>
                                        )}
                                      </ContextMenuSubContent>
                                    </ContextMenuSub>

                                    <ContextMenuSeparator />

                                    <ContextMenuItem
                                      onSelect={() => scheduleAfterContextMenu(() => setFilterPopoverColId(colId))}
                                      className="text-xs"
                                    >
                                      <Filter className="size-3.5" />
                                      <span>{t("toolbar.filter")}</span>
                                    </ContextMenuItem>

                                    <ContextMenuItem className="text-xs">
                                      <ListTree className="size-3.5" />
                                      <span>{t("toolbar.group")}</span>
                                    </ContextMenuItem>

                                    <ContextMenuSub>
                                      <ContextMenuSubTrigger className="text-xs">
                                        <ArrowUpDown className="size-3.5" />
                                        <span>{t("toolbar.sort")}</span>
                                      </ContextMenuSubTrigger>
                                      <ContextMenuSubContent
                                        className="w-36"
                                        onWheel={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => e.stopPropagation()}
                                      >
                                        <ContextMenuItem
                                          onSelect={() => dataSource.setSort({ columnId: colId, direction: "asc" })}
                                          className="text-xs"
                                        >
                                          <ArrowUp className="size-3.5" />
                                          <span>{t("sortFilter.sortAsc")}</span>
                                          {colSortDir === "asc" && <Check className="text-primary ml-auto size-3.5" />}
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                          onSelect={() => dataSource.setSort({ columnId: colId, direction: "desc" })}
                                          className="text-xs"
                                        >
                                          <ArrowDown className="size-3.5" />
                                          <span>{t("sortFilter.sortDesc")}</span>
                                          {colSortDir === "desc" && <Check className="text-primary ml-auto size-3.5" />}
                                        </ContextMenuItem>
                                        {colSortDir && (
                                          <>
                                            <ContextMenuSeparator />
                                            <ContextMenuItem
                                              onSelect={() => dataSource.setSort(null)}
                                              className="text-xs"
                                            >
                                              <X className="size-3.5" />
                                              <span>{t("sortFilter.clearSort")}</span>
                                            </ContextMenuItem>
                                          </>
                                        )}
                                      </ContextMenuSubContent>
                                    </ContextMenuSub>

                                    <ContextMenuSeparator />

                                    <div
                                      data-header-menu-bottom-actions
                                      className="flex items-center justify-between gap-0.5 px-1 py-0.5"
                                    >
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            disabled={!customCol}
                                            aria-label={t("headerMenu.duplicate")}
                                            onSelect={() =>
                                              dataSource.duplicateCustomColumn?.(colId, t("headerMenu.copySuffix"))
                                            }
                                            className="text-muted-foreground hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-35"
                                          >
                                            <CopyPlus className="size-3.5" />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">{t("headerMenu.duplicate")}</TooltipContent>
                                      </Tooltip>

                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            aria-label={t("headerMenu.autoFitWidth")}
                                            onSelect={() =>
                                              dataSource.autoFitColumnWidth?.(colId, undefined, getColumnLabel(colId))
                                            }
                                            className="text-muted-foreground hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md outline-none"
                                          >
                                            <UnfoldHorizontal className="size-3.5" />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">{t("headerMenu.autoFitWidth")}</TooltipContent>
                                      </Tooltip>

                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            aria-label={
                                              isFrozenTarget ? t("headerMenu.unfreeze") : t("headerMenu.freeze")
                                            }
                                            onSelect={() => dataSource.toggleFreezeColumn(colId)}
                                            className={cn(
                                              "hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md outline-none",
                                              isFrozenTarget ? "bg-accent text-primary" : "text-muted-foreground",
                                            )}
                                          >
                                            <FreezeColumnIcon />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">
                                          {isFrozenTarget ? t("headerMenu.unfreeze") : t("headerMenu.freeze")}
                                        </TooltipContent>
                                      </Tooltip>

                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            disabled={isNameCol}
                                            aria-label={t("headerMenu.hide")}
                                            onSelect={() => dataSource.setColumnVisible(colId, false)}
                                            className="text-muted-foreground hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-35"
                                          >
                                            <EyeOff className="size-3.5" />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">{t("headerMenu.hide")}</TooltipContent>
                                      </Tooltip>

                                      <div className="bg-border mx-0.5 h-4 w-px shrink-0" />

                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            disabled={!customCol || isProtectedTableColumn(customCol)}
                                            aria-label={
                                              isProtectedTableColumn(customCol)
                                                ? t("headerMenu.protectedCannotDelete")
                                                : t("headerMenu.delete")
                                            }
                                            onSelect={() => dataSource.deleteCustomColumn(colId)}
                                            className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive focus:bg-destructive/15 focus:text-destructive flex size-7 cursor-pointer items-center justify-center rounded-md outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-35"
                                          >
                                            <Trash2 className="size-3.5" />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">
                                          {isProtectedTableColumn(customCol)
                                            ? t("headerMenu.protectedCannotDelete")
                                            : t("headerMenu.delete")}
                                        </TooltipContent>
                                      </Tooltip>
                                    </div>
                                  </ContextMenuContent>
                                </ContextMenu>
                              )}
                            </div>
                          </PopoverAnchor>

                          <PopoverContent
                            align="start"
                            sideOffset={2}
                            className="w-auto p-0"
                            onOpenAutoFocus={(e) => e.preventDefault()}
                            onFocusOutside={(e) => {
                              const target = e.target as Element | null;
                              if (
                                target
                                  ?.closest?.("[data-col-popover-anchor]")
                                  ?.getAttribute("data-col-popover-anchor") === colId
                              ) {
                                e.preventDefault();
                              }
                            }}
                            onPointerDownOutside={(e) => {
                              const target = e.target as Element | null;
                              if (
                                target
                                  ?.closest?.("[data-col-popover-anchor]")
                                  ?.getAttribute("data-col-popover-anchor") === colId ||
                                target?.closest?.("[data-stage-table-add-col]")
                              ) {
                                e.preventDefault();
                              }
                            }}
                            onWheel={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            {isHeaderEditing && renderEditFieldFormContent(colId)}
                            {isCreatingThis && creatingColState && (
                              <FieldTypeGridPicker
                                selectedType={creatingColState.selectedType}
                                onSelectType={(chosenType) => commitCreatingColumn(chosenType)}
                                showTabNextHint
                                t={t}
                              />
                            )}
                          </PopoverContent>
                        </Popover>

                        {showDropBefore && (
                          <div className="bg-primary pointer-events-none absolute top-0 bottom-0 left-0 z-30 w-0.5" />
                        )}
                        {showDropAfter && (
                          <div className="bg-primary pointer-events-none absolute top-0 right-0 bottom-0 z-30 w-0.5" />
                        )}

                        <div
                          role="separator"
                          data-col-resizer={colId}
                          aria-orientation="vertical"
                          onPointerDown={(e) => startColumnResize(colId, width, e)}
                          className="hover:bg-primary/60 absolute top-0 -right-0.5 bottom-0 z-20 w-1.5 cursor-col-resize"
                        />
                      </SelectableColumnHeaderCell>
                    );
                  })}

                  <th className="border-border/50 bg-muted h-9 p-0 text-center select-none">
                    <button
                      type="button"
                      data-stage-table-add-col
                      aria-label={t("addColumnPopover.triggerAria")}
                      onClick={() => triggerInsertNewColumn()}
                      className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-full items-center justify-center transition-colors"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </th>
                </tr>
              </thead>

              <tbody>
                {effectiveTotalRowCount === 0 ? (
                  <tr>
                    <td
                      colSpan={visibleColumnIds.length + 2}
                      className="text-muted-foreground py-12 text-center text-xs"
                    >
                      {effectiveUnfilteredCount > 0 && hasAnyActiveFilter ? (
                        <div className="flex flex-col items-center gap-2">
                          <span>{t("sortFilter.noFilterMatch")}</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => dataSource.clearAllFilters()}
                            className="h-7 px-3 text-xs"
                          >
                            {t("sortFilter.clearAllFilters")}
                          </Button>
                        </div>
                      ) : (
                        t("emptyCanvas")
                      )}
                    </td>
                  </tr>
                ) : (
                  <>
                    {virtualPaddingTop > 0 && (
                      <tr aria-hidden data-virtual-spacer="top">
                        <td
                          colSpan={visibleColumnIds.length + 2}
                          style={{ height: `${virtualPaddingTop}px`, padding: 0, border: 0 }}
                        />
                      </tr>
                    )}

                    {virtualItems.map((vItem) => {
                      const row = getRowAtIndex(vItem.index);
                      if (!row) {
                        return (
                          <tr
                            key={`loading-${vItem.index}`}
                            style={{ height: `${vItem.size}px` }}
                            className="border-border/40 border-b"
                          >
                            <td className="text-muted-foreground px-1 text-center text-[11px] tabular-nums">
                              {vItem.index + 1}
                            </td>
                            <td colSpan={visibleColumnIds.length + 1} className="px-2.5 text-[11px] opacity-40">
                              ...
                            </td>
                          </tr>
                        );
                      }
                      const rowActiveEditor =
                        activeEditor?.rowUuid === row.uuid &&
                        (!activeEditor.docId || !row.docId || activeEditor.docId === row.docId)
                          ? activeEditor
                          : null;
                      return (
                        <StageTableVirtualRow
                          key={row.docId ? `${row.docId}:${row.uuid}` : row.uuid}
                          project={project ?? null}
                          dataSource={dataSource}
                          row={row}
                          rowIndex={vItem.index}
                          visibleColumnIds={visibleColumnIds}
                          customColumnMap={customColumnMap}
                          frozenEndIndex={frozenEndIndex}
                          columnLeftOffsets={columnLeftOffsets}
                          tableRowHeightClass={tableRowHeightClass}
                          activeEditor={rowActiveEditor}
                          selectionStore={selectionStore}
                          callbacks={rowCallbacks}
                          t={t}
                        />
                      );
                    })}

                    {virtualPaddingBottom > 0 && (
                      <tr aria-hidden data-virtual-spacer="bottom">
                        <td
                          colSpan={visibleColumnIds.length + 2}
                          style={{ height: `${virtualPaddingBottom}px`, padding: 0, border: 0 }}
                        />
                      </tr>
                    )}
                  </>
                )}
              </tbody>
            </table>
          </TableScrollContainer>

          {/* 单例共享单元格浮层编辑器（日期日历 / 单选多选 / 关系按需搜索） */}
          <StageTableCellEditorPortal
            activeEditor={activeEditor}
            row={activeEditorRow}
            customCol={activeEditorCol}
            dataSource={dataSource}
            onClose={() => setActiveEditor(null)}
            onCommitCustomField={(rowUuid, columnId, val, docId) => {
              void dataSource.executeMutation({ type: "update_custom_field", docId, rowUuid, columnId, value: val });
            }}
            onCreateOrGetOption={(colId, optName) => dataSource.createOrGetSelectOption(colId, optName)}
            onCommitRelation={(rowUuid, relationKind: RelationColumnKind, nextIds, docId) => {
              if (relationKind === "outer") {
                void dataSource.executeMutation({
                  type: "set_outer",
                  docId,
                  rowUuid,
                  outerUuid: typeof nextIds === "string" ? nextIds : null,
                });
              } else if (relationKind === "parents") {
                void dataSource.executeMutation({
                  type: "set_parents",
                  docId,
                  rowUuid,
                  parentUuids: Array.isArray(nextIds) ? nextIds : [],
                });
              } else if (relationKind === "children") {
                void dataSource.executeMutation({
                  type: "set_children",
                  docId,
                  rowUuid,
                  childUuids: Array.isArray(nextIds) ? nextIds : [],
                });
              } else {
                void dataSource.executeMutation({
                  type: "set_inner",
                  docId,
                  rowUuid,
                  innerUuids: Array.isArray(nextIds) ? nextIds : [],
                });
              }
            }}
            t={t}
          />
        </>
      )}

      {/* 记录详情编辑弹窗 */}
      <StageTableRecordDialog
        project={project ?? null}
        dataSource={dataSource}
        row={recordDialogRow}
        customColumns={customColumns}
        getColumnLabel={getColumnLabel}
        onClose={() => setRecordDialogTarget(null)}
        onPreviewImage={(attId, rowUuid, docId) => openImagePreview(attId, rowUuid, docId)}
        onOpenFormulaEditor={(colId, rowUuid) => {
          setRecordDialogTarget(null);
          openFormulaEditorForColumn(colId, rowUuid);
        }}
        t={t}
      />

      {/* 工作空间共享字段管理弹窗 */}
      {isWorkspaceMode && (
        <WorkspaceColumnsDialog
          open={workspaceColumnsDialogOpen}
          onOpenChange={setWorkspaceColumnsDialogOpen}
          onChanged={() => void dataSource.refreshWorkspaceMetadata?.()}
        />
      )}

      {/* 隐藏列修改字段悬浮兜底面板 */}
      <DialogPrimitive.Root
        open={editingFieldState !== null && editingFieldState.anchor === "floating"}
        onOpenChange={(open) => {
          if (!open) {
            setEditTypeDropdownOpen(false);
            setEditingFieldState(null);
          }
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25" />
          <DialogPrimitive.Content
            onOpenAutoFocus={(e) => e.preventDefault()}
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-xl border shadow-xl outline-none"
          >
            <DialogPrimitive.Title className="sr-only">{t("headerMenu.editField")}</DialogPrimitive.Title>
            {editingFieldState && renderEditFieldFormContent(editingFieldState.colId)}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* 公式编辑器弹窗 */}
      {(() => {
        const targetCol = formulaEditorState ? customColumnMap.get(formulaEditorState.colId) : undefined;
        return (
          <StageTableFormulaEditorDialog
            open={Boolean(formulaEditorState && targetCol)}
            onOpenChange={(open) => {
              if (!open) setFormulaEditorState(null);
            }}
            columnId={targetCol?.id ?? ""}
            columnName={targetCol?.name ?? ""}
            initialFormula={targetCol?.formula ?? ""}
            initialFormat={targetCol?.format}
            tableViewName={activeView.name || t("defaultViewName")}
            columns={formulaEditorColumnOptions}
            customColumnSchemas={customColumns}
            systemColumnNames={project?.table?.systemColumnNames}
            systemColumnLabels={systemColumnLabels}
            rows={isWorkspaceMode ? loadedRowsList : syncData.allRows}
            initialPreviewRowUuid={formulaEditorState?.previewRowUuid ?? null}
            onSave={({ name, formula, format }) => {
              if (!targetCol) return;
              dataSource.updateColumn(targetCol.id, {
                name,
                type: "formula",
                formula,
                format: format ?? undefined,
              });
            }}
            t={t}
          />
        );
      })()}

      {/* 图片大图灯箱 */}
      <ImageLightbox
        project={project ?? null}
        resolveMediaUrl={(attId, dId, opts) => dataSource.getMediaUrl(dId ?? dataSource.getDocId(), attId, opts)}
        open={previewLightboxState !== null}
        items={previewLightboxState?.items ?? []}
        initialIndex={previewLightboxState?.initialIndex ?? 0}
        allItems={previewLightboxState?.allItems}
        allInitialIndex={previewLightboxState?.allInitialIndex}
        onClose={() => setPreviewLightboxState(null)}
      />
    </div>
  );
}
