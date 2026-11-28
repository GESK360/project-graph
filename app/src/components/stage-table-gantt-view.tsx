import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StageTableFilterToolbarPopover } from "@/components/stage-table-filter-popover";
import {
  StageTableColumnIcon,
  StageTableFieldValueDisplay,
  StageTableFieldVisibilityList,
  StageTableSortToolbarPopover,
  getRowDisplayTitle,
  getViewOptionBadgeClass,
  getViewOptionBarClass,
} from "@/components/stage-table-views-shared";
import type { Project } from "@/core/Project";
import type { StageTableRow } from "@/core/service/dataManageService/stageTableService/StageTableService";
import type { TableDataSource } from "@/core/service/dataManageService/stageTableService/TableDataSource";
import {
  addDaysToDateKey,
  diffCalendarDays,
  getRowSelectOptionColor,
  parseLocalDateKey,
  resolveRowDateRange,
  toLocalDateKey,
  type GanttTimeScale,
  type TableColumnFilter,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableFields,
  type TableFilterGroup,
  type TableGanttViewConfig,
  type TableSortConfig,
  type TableViewSchema,
} from "@/types/table";
import { cn } from "@/utils/cn";
import { createSafeObserveElementRect } from "@/components/stage-table-scroll-container";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChartGantt,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Info,
  List,
  ListTree,
  Plus,
  PlusCircle,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

const OBSERVE_GANTT_RECT = createSafeObserveElementRect({ width: 900, height: 600 });

const ROW_HEIGHT = 36;
const GROUP_ROW_HEIGHT = 30;
const TOP_BAR_HEIGHT = 36;
const AXIS_HEIGHT = 32;

const SCALE_CONFIG: Record<
  GanttTimeScale,
  { dayWidth: number; daysBefore: number; daysAfter: number; stepDays: number }
> = {
  week: { dayWidth: 64, daysBefore: 7, daysAfter: 21, stepDays: 7 },
  month: { dayWidth: 42, daysBefore: 14, daysAfter: 46, stepDays: 14 },
  quarter: { dayWidth: 18, daysBefore: 20, daysAfter: 100, stepDays: 30 },
  year: { dayWidth: 6, daysBefore: 30, daysAfter: 335, stepDays: 90 },
};

type GanttFlatItem =
  | { kind: "group"; key: string; label: string; color?: string; count: number }
  | { kind: "row"; row: StageTableRow; rowIndex: number };

interface GanttDragState {
  rowUuid: string;
  mode: "move" | "resize-start" | "resize-end";
  origStartKey: string;
  origEndKey: string;
  deltaDays: number;
}

export function StageTableGanttView({
  project,
  dataSource,
  dataRevision = 0,
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
  selectedRowIds,
  getColumnLabel,
  onSelectRows,
  onOpenRecord,
  onPreviewImage,
  t,
}: {
  project?: Project | null;
  dataSource: TableDataSource;
  dataRevision?: number;
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
  selectedRowIds: ReadonlySet<string>;
  getColumnLabel: (colId: string) => string;
  onSelectRows: (uuids: string[], focusCamera?: boolean) => void;
  onOpenRecord: (rowUuid: string, row?: StageTableRow) => void;
  onPreviewImage: (attachmentId: string, rowUuid?: string, docId?: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const todayKey = useMemo(() => toLocalDateKey(new Date()), []);
  const [anchorKey, setAnchorKey] = useState<string>(todayKey);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [dragState, setDragState] = useState<GanttDragState | null>(null);
  const isWorkspaceMode = dataSource.scopeKind === "workspace";
  const [wsRows, setWsRows] = useState<StageTableRow[]>([]);

  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const syncingScrollRef = useRef<"left" | "right" | null>(null);
  const hasAutoScrolledRef = useRef(false);

  const config: TableGanttViewConfig = activeView.gantt ?? {};
  const timeScale: GanttTimeScale = config.timeScale ?? "month";
  const showLeftTable = config.showLeftTable ?? true;
  const leftPaneWidth = config.leftPaneWidth ?? 280;
  const showBarLabel = config.showBarLabel ?? true;
  const showDuration = config.showDuration ?? true;
  const highlightWeekends = config.highlightWeekends ?? true;

  const dateColumnCandidates = useMemo(() => {
    const items: Array<{ id: string; label: string; customCol?: TableColumnSchema; editable: boolean }> = [];
    for (const col of customColumns) {
      if (col.type === "date" || col.type === "formula") {
        items.push({ id: col.id, label: col.name, customCol: col, editable: col.type === "date" });
      }
    }
    items.push({ id: "createdAt", label: getColumnLabel("createdAt"), editable: false });
    items.push({ id: "updatedAt", label: getColumnLabel("updatedAt"), editable: false });
    return items;
  }, [customColumns, getColumnLabel]);

  const selectColumns = useMemo(
    () => customColumns.filter((c) => c.type === "select" || c.type === "multi_select"),
    [customColumns],
  );

  const groupableColumns = useMemo(() => {
    const list: Array<{ id: string; label: string; customCol?: TableColumnSchema }> = [];
    for (const col of customColumns) {
      if (col.type === "select") list.push({ id: col.id, label: col.name, customCol: col });
    }
    if (isWorkspaceMode) {
      list.push({ id: "sourceFile", label: getColumnLabel("sourceFile") });
      list.push({ id: "sourceFolder", label: getColumnLabel("sourceFolder") });
    }
    list.push({ id: "outer", label: getColumnLabel("outer") });
    return list;
  }, [customColumns, isWorkspaceMode, getColumnLabel]);

  const startDateColId = config.startDateColumnId ?? customColumns.find((c) => c.type === "date")?.id ?? "createdAt";
  const endDateColId = config.endDateColumnId ?? null;
  const colorColumnId = config.colorColumnId ?? null;
  const groupByColumnId = config.groupByColumnId ?? null;

  const startColEditable = Boolean(customColumnMap.get(startDateColId)?.type === "date");
  const endColEditable = Boolean(endDateColId && customColumnMap.get(endDateColId)?.type === "date");

  const scaleMeta = SCALE_CONFIG[timeScale];
  const dayWidth = scaleMeta.dayWidth;

  const timelineDays = useMemo(() => {
    const startKey = addDaysToDateKey(anchorKey, -scaleMeta.daysBefore);
    const totalDays = scaleMeta.daysBefore + scaleMeta.daysAfter + 1;
    const list: Array<{
      key: string;
      year: number;
      month: number;
      day: number;
      weekday: number;
      isWeekend: boolean;
      isToday: boolean;
    }> = [];
    for (let i = 0; i < totalDays; i++) {
      const k = addDaysToDateKey(startKey, i);
      const dt = parseLocalDateKey(k)!;
      const wd = dt.getDay();
      list.push({
        key: k,
        year: dt.getFullYear(),
        month: dt.getMonth() + 1,
        day: dt.getDate(),
        weekday: wd,
        isWeekend: wd === 0 || wd === 6,
        isToday: k === todayKey,
      });
    }
    return list;
  }, [anchorKey, scaleMeta.daysBefore, scaleMeta.daysAfter, todayKey]);

  const timelineStartKey = timelineDays[0]?.key ?? todayKey;
  const timelineEndKey = timelineDays[timelineDays.length - 1]?.key ?? todayKey;
  const totalTimelineWidth = timelineDays.length * dayWidth;

  useEffect(() => {
    if (!isWorkspaceMode) return;
    let cancelled = false;
    void dataSource
      .queryDateRange({
        startColumnId: startDateColId,
        endColumnId: endDateColId,
        minDate: timelineStartKey,
        maxDate: timelineEndKey,
        filters: activeFilters,
        filterGroup: activeFilterGroup,
        sort: activeSort,
        includeUndated: true,
        undatedLimit: 200,
      })
      .then((res) => {
        if (!cancelled) {
          setWsRows([...res.rows, ...res.undatedRows]);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    isWorkspaceMode,
    dataSource,
    dataRevision,
    startDateColId,
    endDateColId,
    timelineStartKey,
    timelineEndKey,
    activeFilters,
    activeFilterGroup,
    activeSort,
  ]);

  const effectiveRows = isWorkspaceMode ? wsRows : rows;

  const todayOffsetPx = useMemo(() => {
    const diff = diffCalendarDays(timelineStartKey, todayKey);
    if (diff < 0 || diff >= timelineDays.length) return null;
    return diff * dayWidth + dayWidth / 2;
  }, [timelineStartKey, todayKey, timelineDays.length, dayWidth]);

  // 季度/年视图按月合并表头段
  const monthSegments = useMemo(() => {
    const segs: Array<{ key: string; label: string; startIdx: number; count: number }> = [];
    timelineDays.forEach((d, idx) => {
      const mKey = `${d.year}-${d.month}`;
      const prev = segs[segs.length - 1];
      if (prev && prev.key === mKey) {
        prev.count++;
      } else {
        segs.push({
          key: mKey,
          label: t("gantt.monthHeader", { year: d.year, month: d.month }),
          startIdx: idx,
          count: 1,
        });
      }
    });
    return segs;
  }, [timelineDays, t]);

  const anchorDateObj = parseLocalDateKey(anchorKey) ?? new Date();
  const headerMonthTitle = t("gantt.monthHeader", {
    year: anchorDateObj.getFullYear(),
    month: anchorDateObj.getMonth() + 1,
  });

  // 初始挂载或切换尺度后自动滚动使锚点日期居中偏左可见
  useEffect(() => {
    const vp = rightScrollRef.current;
    if (!vp) return;
    if (!hasAutoScrolledRef.current) {
      hasAutoScrolledRef.current = true;
    }
    const anchorIdx = diffCalendarDays(timelineStartKey, anchorKey);
    const targetLeft = Math.max(0, anchorIdx * dayWidth - vp.clientWidth * 0.35);
    vp.scrollLeft = targetLeft;
  }, [timeScale, anchorKey, timelineStartKey, dayWidth]);

  const flatItems = useMemo<GanttFlatItem[]>(() => {
    if (!groupByColumnId) {
      return effectiveRows.map((row, idx) => ({ kind: "row", row, rowIndex: idx }));
    }

    const groupsMap = new Map<string, { label: string; color?: string; rows: StageTableRow[] }>();
    const ungroupedKey = "__ungrouped__";
    groupsMap.set(ungroupedKey, { label: t("kanban.ungrouped"), rows: [] });

    if (groupByColumnId === "sourceFile" || groupByColumnId === "sourceFolder") {
      for (const row of effectiveRows) {
        const key =
          groupByColumnId === "sourceFile"
            ? row.sourceRelPath || row.sourceFile || ungroupedKey
            : row.sourceFolder || "/";
        const label =
          groupByColumnId === "sourceFile" ? row.sourceFile || t("kanban.ungrouped") : row.sourceFolder || "/";
        let g = groupsMap.get(key);
        if (!g) {
          g = { label, rows: [] };
          groupsMap.set(key, g);
        }
        g.rows.push(row);
      }
    } else if (groupByColumnId === "outer") {
      for (const row of effectiveRows) {
        if (row.outer) {
          let g = groupsMap.get(row.outer.uuid);
          if (!g) {
            g = { label: getRowDisplayTitle(row.outer, t).text, rows: [] };
            groupsMap.set(row.outer.uuid, g);
          }
          g.rows.push(row);
        } else {
          groupsMap.get(ungroupedKey)!.rows.push(row);
        }
      }
    } else {
      const col = customColumnMap.get(groupByColumnId);
      if (col?.type === "select") {
        for (const opt of col.options ?? []) {
          groupsMap.set(opt.id, { label: opt.name, color: opt.color, rows: [] });
        }
        for (const row of effectiveRows) {
          const raw = row.tableFields?.[col.id];
          const optId = typeof raw === "string" ? raw : undefined;
          const g = optId ? groupsMap.get(optId) : undefined;
          if (g) g.rows.push(row);
          else groupsMap.get(ungroupedKey)!.rows.push(row);
        }
      } else {
        return effectiveRows.map((row, idx) => ({ kind: "row", row, rowIndex: idx }));
      }
    }

    const result: GanttFlatItem[] = [];
    let runningIdx = 0;
    for (const [key, g] of groupsMap.entries()) {
      if (g.rows.length === 0) continue;
      result.push({ kind: "group", key, label: g.label, color: g.color, count: g.rows.length });
      if (!collapsedGroups.has(key)) {
        for (const row of g.rows) {
          result.push({ kind: "row", row, rowIndex: runningIdx++ });
        }
      }
    }
    return result;
  }, [effectiveRows, groupByColumnId, customColumnMap, collapsedGroups, t]);

  const rowVirtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => rightScrollRef.current,
    estimateSize: (index) => (flatItems[index]?.kind === "group" ? GROUP_ROW_HEIGHT : ROW_HEIGHT),
    overscan: 8,
    initialRect: { width: 900, height: 600 },
    observeElementRect: OBSERVE_GANTT_RECT,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [flatItems, rowVirtualizer]);

  const virtualFlatItems = rowVirtualizer.getVirtualItems();
  const totalVirtualHeight = rowVirtualizer.getTotalSize();

  const handleLeftScroll = () => {
    if (syncingScrollRef.current === "right") return;
    syncingScrollRef.current = "left";
    if (leftScrollRef.current && rightScrollRef.current) {
      rightScrollRef.current.scrollTop = leftScrollRef.current.scrollTop;
    }
    requestAnimationFrame(() => {
      syncingScrollRef.current = null;
    });
  };

  const handleRightScroll = () => {
    if (syncingScrollRef.current === "left") return;
    syncingScrollRef.current = "right";
    if (leftScrollRef.current && rightScrollRef.current) {
      leftScrollRef.current.scrollTop = rightScrollRef.current.scrollTop;
    }
    requestAnimationFrame(() => {
      syncingScrollRef.current = null;
    });
  };

  const handleAddRow = () => {
    const fields: TableFields = {};
    if (startColEditable) {
      fields[startDateColId] = todayKey;
    }
    void Promise.resolve(
      dataSource.createRow({
        text: "",
        tableFields: fields,
      }),
    ).then((created) => {
      if (created) {
        onSelectRows([created.uuid], false);
      }
    });
  };

  const handleQuickCreateDateColumns = () => {
    const startCol = dataSource.addCustomColumn({
      name: t("gantt.defaultStartColName"),
      type: "date",
    });
    const endCol = dataSource.addCustomColumn({
      name: t("gantt.defaultEndColName"),
      type: "date",
    });
    if (startCol) {
      dataSource.updateActiveViewConfig({
        gantt: {
          startDateColumnId: startCol.id,
          endDateColumnId: endCol?.id ?? null,
        },
      });
    }
  };

  const startBarPointerDrag = (
    event: React.PointerEvent,
    rowUuid: string,
    mode: "move" | "resize-start" | "resize-end",
    origStartKey: string,
    origEndKey: string,
    docId?: string,
  ) => {
    if (event.button !== 0) return;
    if (mode === "move" && !startColEditable) return;
    if (mode === "resize-start" && !startColEditable) return;
    if (mode === "resize-end" && !endColEditable) return;

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    let latestDelta = 0;

    setDragState({ rowUuid, mode, origStartKey, origEndKey, deltaDays: 0 });

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const nextDelta = Math.round(dx / dayWidth);
      if (nextDelta !== latestDelta) {
        latestDelta = nextDelta;
        setDragState({ rowUuid, mode, origStartKey, origEndKey, deltaDays: nextDelta });
      }
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      setDragState(null);

      if (latestDelta === 0) return;

      if (mode === "move") {
        const nextStart = addDaysToDateKey(origStartKey, latestDelta);
        const patch: Record<string, string> = { [startDateColId]: nextStart };
        if (endColEditable && endDateColId) {
          patch[endDateColId] = addDaysToDateKey(origEndKey, latestDelta);
        }
        void dataSource.updateRowCustomFields(rowUuid, patch, docId);
      } else if (mode === "resize-start") {
        const candidateStart = addDaysToDateKey(origStartKey, latestDelta);
        const clampedStart = diffCalendarDays(candidateStart, origEndKey) < 0 ? origEndKey : candidateStart;
        void dataSource.updateRowCustomField(rowUuid, startDateColId, clampedStart, docId);
      } else if (mode === "resize-end" && endDateColId) {
        const candidateEnd = addDaysToDateKey(origEndKey, latestDelta);
        const clampedEnd = diffCalendarDays(origStartKey, candidateEnd) < 0 ? origStartKey : candidateEnd;
        void dataSource.updateRowCustomField(rowUuid, endDateColId, clampedEnd, docId);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const startPaneResize = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const origWidth = leftPaneWidth;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const next = Math.max(180, Math.min(560, origWidth + (moveEvent.clientX - startX)));
      dataSource.updateActiveViewConfig({ gantt: { leftPaneWidth: next } });
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const weekdayShortLabels = [
    t("calendar.wdShort_0"),
    t("calendar.wdShort_1"),
    t("calendar.wdShort_2"),
    t("calendar.wdShort_3"),
    t("calendar.wdShort_4"),
    t("calendar.wdShort_5"),
    t("calendar.wdShort_6"),
  ];

  // 左侧表格展示列（始终含名称，其余取可见列）
  const leftTableColIds = visibleColumnIds;

  return (
    <div data-stage-table-gantt-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 甘特第二行功能栏 */}
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 text-xs [scrollbar-width:none]">
        <button
          type="button"
          data-gantt-add-row
          onClick={handleAddRow}
          className="text-primary hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 font-medium transition-colors"
        >
          <PlusCircle className="size-3.5" />
          <span>{t("toolbar.addRow")}</span>
        </button>

        <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

        {/* 表格设置（左侧字段显隐） */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-gantt-table-settings-trigger
              className="text-foreground hover:bg-accent data-[state=open]:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
            >
              <List className="size-3.5" />
              <span>{t("gantt.tableSettings")}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-60 p-3 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-muted-foreground mb-1.5 text-[11px] font-medium">{t("gantt.leftTableFields")}</div>
            <StageTableFieldVisibilityList
              allColumnIds={allColumnIds}
              customColumnMap={customColumnMap}
              getColumnLabel={getColumnLabel}
              isColumnVisible={(cid) => dataSource.isColumnVisible(cid)}
              onToggleColumn={(cid, visible) => dataSource.setColumnVisible(cid, visible)}
              t={t}
            />
          </PopoverContent>
        </Popover>

        {/* 甘特设置 */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-gantt-settings-trigger
              className="text-foreground hover:bg-accent data-[state=open]:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
            >
              <ChartGantt className="size-3.5" />
              <span>{t("gantt.settings")}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-72 space-y-3 p-3 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="space-y-1.5">
              <div className="text-muted-foreground text-[11px] font-medium">{t("gantt.startDateField")}</div>
              <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border p-1">
                {dateColumnCandidates.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => dataSource.updateActiveViewConfig({ gantt: { startDateColumnId: item.id } })}
                    className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left"
                  >
                    <StageTableColumnIcon columnId={item.id} customColumn={item.customCol} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {startDateColId === item.id && <Check className="text-primary size-3.5 shrink-0" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-muted-foreground text-[11px] font-medium">{t("gantt.endDateField")}</div>
              <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border p-1">
                <button
                  type="button"
                  onClick={() => dataSource.updateActiveViewConfig({ gantt: { endDateColumnId: null } })}
                  className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left"
                >
                  <span className="text-muted-foreground">{t("gantt.singleDayMode")}</span>
                  {endDateColId === null && <Check className="text-primary size-3.5" />}
                </button>
                {dateColumnCandidates.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => dataSource.updateActiveViewConfig({ gantt: { endDateColumnId: item.id } })}
                    className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left"
                  >
                    <StageTableColumnIcon columnId={item.id} customColumn={item.customCol} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {endDateColId === item.id && <Check className="text-primary size-3.5 shrink-0" />}
                  </button>
                ))}
              </div>
            </div>

            {!customColumns.some((c) => c.type === "date") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleQuickCreateDateColumns}
                className="h-7 w-full gap-1.5 text-xs"
              >
                <Plus className="size-3.5" />
                <span>{t("gantt.createDateColumns")}</span>
              </Button>
            )}

            {selectColumns.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-muted-foreground text-[11px] font-medium">{t("views.colorBy")}</div>
                <div className="max-h-28 space-y-0.5 overflow-y-auto rounded-md border p-1">
                  <button
                    type="button"
                    onClick={() => dataSource.updateActiveViewConfig({ gantt: { colorColumnId: null } })}
                    className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left"
                  >
                    <span className="text-muted-foreground">{t("views.defaultColor")}</span>
                    {colorColumnId === null && <Check className="text-primary size-3.5" />}
                  </button>
                  {selectColumns.map((col) => (
                    <button
                      key={col.id}
                      type="button"
                      onClick={() => dataSource.updateActiveViewConfig({ gantt: { colorColumnId: col.id } })}
                      className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left"
                    >
                      <StageTableColumnIcon columnId={col.id} customColumn={col} />
                      <span className="min-w-0 flex-1 truncate">{col.name}</span>
                      {colorColumnId === col.id && <Check className="text-primary size-3.5 shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="border-border/60 space-y-1 border-t pt-2">
              <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1">
                <Checkbox
                  checked={showBarLabel}
                  onCheckedChange={(v) => dataSource.updateActiveViewConfig({ gantt: { showBarLabel: Boolean(v) } })}
                />
                <span>{t("gantt.showBarLabel")}</span>
              </label>
              <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1">
                <Checkbox
                  checked={showDuration}
                  onCheckedChange={(v) => dataSource.updateActiveViewConfig({ gantt: { showDuration: Boolean(v) } })}
                />
                <span>{t("gantt.showDuration")}</span>
              </label>
              <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1">
                <Checkbox
                  checked={highlightWeekends}
                  onCheckedChange={(v) =>
                    dataSource.updateActiveViewConfig({ gantt: { highlightWeekends: Boolean(v) } })
                  }
                />
                <span>{t("gantt.highlightWeekends")}</span>
              </label>
            </div>
          </PopoverContent>
        </Popover>

        <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

        <StageTableFilterToolbarPopover
          filterableColumnIds={filterableColumnIds}
          columnGroups={filterColumnGroups}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          allRows={isWorkspaceMode ? effectiveRows : allRows}
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

        {/* 分组 */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors",
                groupByColumnId
                  ? "bg-primary/15 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ListTree className="size-3.5" />
              <span>
                {groupByColumnId ? `${t("toolbar.group")}: ${getColumnLabel(groupByColumnId)}` : t("toolbar.group")}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-56 p-2 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-muted-foreground mb-1 px-1 text-[11px] font-medium">
              {t("kanban.selectGroupField")}
            </div>
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={() => dataSource.updateActiveViewConfig({ gantt: { groupByColumnId: null } })}
                className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left"
              >
                <span className="text-muted-foreground">{t("kanban.noGrouping")}</span>
                {groupByColumnId === null && <Check className="text-primary size-3.5" />}
              </button>
              {groupableColumns.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => dataSource.updateActiveViewConfig({ gantt: { groupByColumnId: item.id } })}
                  className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left"
                >
                  <StageTableColumnIcon columnId={item.id} customColumn={item.customCol} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {groupByColumnId === item.id && <Check className="text-primary size-3.5 shrink-0" />}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <StageTableSortToolbarPopover
          allColumnIds={allColumnIds}
          customColumnMap={customColumnMap}
          activeSort={activeSort}
          getColumnLabel={getColumnLabel}
          onSetSort={(sort) => dataSource.setSort(sort)}
          t={t}
        />
      </div>

      {/* 甘特图左右分栏主体 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左侧精简表格区 */}
        {showLeftTable && (
          <div
            data-gantt-left-pane
            style={{ width: `${leftPaneWidth}px` }}
            className="border-border/60 relative flex shrink-0 flex-col border-r"
          >
            {/* 与右侧双层时间轴等高的左表头 */}
            <div
              style={{ height: `${TOP_BAR_HEIGHT + AXIS_HEIGHT}px` }}
              className="border-border/60 bg-muted/60 flex shrink-0 flex-col border-b select-none"
            >
              <div
                style={{ height: `${TOP_BAR_HEIGHT}px` }}
                className="border-border/40 text-muted-foreground flex items-center justify-center border-b px-2 text-[11px] font-medium"
              >
                {t("gantt.basicInfo")}
              </div>
              <div style={{ height: `${AXIS_HEIGHT}px` }} className="flex items-center text-[11px] font-medium">
                <div className="border-border/40 text-muted-foreground flex h-full w-9 shrink-0 items-center justify-center border-r">
                  #
                </div>
                {leftTableColIds.map((cid, idx) => (
                  <div
                    key={cid}
                    className={cn(
                      "border-border/40 text-muted-foreground flex h-full items-center gap-1 truncate border-r px-2",
                      idx === 0 ? "min-w-28 flex-1" : "w-24 shrink-0",
                    )}
                  >
                    <StageTableColumnIcon columnId={cid} customColumn={customColumnMap.get(cid)} className="size-3" />
                    <span className="truncate">{getColumnLabel(cid)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 左侧同步滚动行列表（与右侧共用同一个行虚拟化器保持 1px 严格对齐） */}
            <div
              ref={leftScrollRef}
              onScroll={handleLeftScroll}
              className="min-h-0 flex-1 overflow-x-auto overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <div style={{ height: `${totalVirtualHeight}px`, position: "relative" }}>
                {virtualFlatItems.map((vItem) => {
                  const item = flatItems[vItem.index];
                  if (!item) return null;
                  if (item.kind === "group") {
                    const collapsed = collapsedGroups.has(item.key);
                    return (
                      <div
                        key={`lg-${item.key}`}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${GROUP_ROW_HEIGHT}px`,
                          transform: `translateY(${vItem.start}px)`,
                        }}
                        onClick={() => {
                          setCollapsedGroups((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.key)) next.delete(item.key);
                            else next.add(item.key);
                            return next;
                          });
                        }}
                        className="border-border/40 bg-muted/35 hover:bg-muted/60 flex cursor-pointer items-center gap-1.5 border-b px-2 text-xs select-none"
                      >
                        {collapsed ? (
                          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                        ) : (
                          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                        )}
                        {item.color ? (
                          <span
                            className={cn(
                              "truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
                              getViewOptionBadgeClass(item.color),
                            )}
                          >
                            {item.label}
                          </span>
                        ) : (
                          <span className="truncate font-medium">{item.label}</span>
                        )}
                        <span className="text-muted-foreground text-[10px] tabular-nums">{item.count}</span>
                      </div>
                    );
                  }

                  const { row, rowIndex } = item;
                  const isSelected = selectedRowIds.has(row.uuid);
                  const titleInfo = getRowDisplayTitle(row, t);

                  return (
                    <div
                      key={`lr-${row.docId ?? ""}:${row.uuid}`}
                      data-gantt-left-row={row.uuid}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${ROW_HEIGHT}px`,
                        transform: `translateY(${vItem.start}px)`,
                      }}
                      onClick={() => onSelectRows([row.uuid])}
                      onDoubleClick={() => onOpenRecord(row.uuid, row)}
                      className={cn(
                        "border-border/40 flex cursor-pointer items-center border-b text-xs transition-colors select-none",
                        isSelected ? "bg-primary/12" : "hover:bg-muted/30",
                      )}
                    >
                      <div className="border-border/40 text-muted-foreground flex h-full w-9 shrink-0 items-center justify-center border-r text-[11px] tabular-nums">
                        {rowIndex + 1}
                      </div>
                      {leftTableColIds.map((cid, idx) => (
                        <div
                          key={cid}
                          className={cn(
                            "border-border/40 flex h-full items-center overflow-hidden border-r px-2",
                            idx === 0 ? "min-w-28 flex-1" : "w-24 shrink-0",
                          )}
                        >
                          {cid === "name" ? (
                            <span
                              className={cn(
                                "truncate font-medium",
                                titleInfo.isPlaceholder && "text-muted-foreground/55 font-normal",
                              )}
                            >
                              {titleInfo.text}
                            </span>
                          ) : (
                            <StageTableFieldValueDisplay
                              project={project}
                              dataSource={dataSource}
                              row={row}
                              columnId={cid}
                              customCol={customColumnMap.get(cid)}
                              onPreviewImage={onPreviewImage}
                              compact
                              t={t}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>

              {/* 底部 + 行 */}
              <button
                type="button"
                onClick={handleAddRow}
                style={{ height: `${ROW_HEIGHT}px` }}
                className="border-border/40 text-muted-foreground hover:bg-accent/50 hover:text-foreground flex w-full cursor-pointer items-center gap-1.5 border-b px-3 text-xs transition-colors"
              >
                <Plus className="size-3.5" />
              </button>
            </div>

            {/* 左右分栏宽度拖拽手柄 */}
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startPaneResize}
              className="hover:bg-primary/60 absolute top-0 -right-0.5 bottom-0 z-30 w-1.5 cursor-col-resize"
            />
          </div>
        )}

        {/* 右侧时间轴区 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 顶部时间导航与尺度切换栏 */}
          <div
            style={{ height: `${TOP_BAR_HEIGHT}px` }}
            className="border-border/60 bg-muted/40 flex shrink-0 items-center justify-between gap-2 border-b px-2.5 text-xs select-none"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-gantt-toggle-left
                title={showLeftTable ? t("gantt.collapseTable") : t("gantt.expandTable")}
                onClick={() => dataSource.updateActiveViewConfig({ gantt: { showLeftTable: !showLeftTable } })}
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded transition-colors"
              >
                {showLeftTable ? <ChevronsLeft className="size-4" /> : <ChevronsRight className="size-4" />}
              </button>
              <span className="font-semibold tabular-nums">{headerMonthTitle}</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label={t("calendar.prevPeriod")}
                  onClick={() => setAnchorKey((prev) => addDaysToDateKey(prev, -scaleMeta.stepDays))}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <button
                  type="button"
                  data-gantt-today-btn
                  onClick={() => setAnchorKey(todayKey)}
                  className="text-foreground hover:bg-accent h-6 cursor-pointer rounded px-2 text-xs font-medium transition-colors"
                >
                  {t("calendar.today")}
                </button>
                <button
                  type="button"
                  aria-label={t("calendar.nextPeriod")}
                  onClick={() => setAnchorKey((prev) => addDaysToDateKey(prev, scaleMeta.stepDays))}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>

              {/* 尺度切换：周 | 月 | 季 | 年 */}
              <div className="bg-muted border-border/60 flex items-center rounded-md border p-0.5">
                {(["week", "month", "quarter", "year"] as const).map((sc) => (
                  <button
                    key={sc}
                    type="button"
                    data-gantt-scale={sc}
                    onClick={() => dataSource.updateActiveViewConfig({ gantt: { timeScale: sc } })}
                    className={cn(
                      "cursor-pointer rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                      timeScale === sc
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`gantt.scale_${sc}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 右侧双向滚动的时间轴刻度 + 甘特条主体 */}
          <div
            ref={rightScrollRef}
            onScroll={handleRightScroll}
            onWheel={(e) => {
              if (e.shiftKey && rightScrollRef.current) {
                rightScrollRef.current.scrollLeft += e.deltaY;
                e.preventDefault();
              }
            }}
            className="relative min-h-0 flex-1 overflow-auto"
          >
            <div style={{ width: `${totalTimelineWidth}px` }} className="relative min-h-full">
              {/* 吸顶时间刻度行 */}
              <div
                style={{ height: `${AXIS_HEIGHT}px` }}
                className="border-border/60 bg-muted/60 sticky top-0 z-20 flex border-b select-none"
              >
                {timeScale === "week" || timeScale === "month"
                  ? timelineDays.map((d) => (
                      <div
                        key={d.key}
                        style={{ width: `${dayWidth}px` }}
                        className={cn(
                          "border-border/35 flex h-full shrink-0 items-center justify-center gap-0.5 border-r text-[11px] tabular-nums",
                          d.isToday
                            ? "text-primary font-semibold"
                            : d.isWeekend && highlightWeekends
                              ? "text-muted-foreground/70 bg-muted/50"
                              : "text-muted-foreground",
                        )}
                      >
                        <span>{d.day}</span>
                        <span className="text-[10px] opacity-80">{weekdayShortLabels[d.weekday]}</span>
                      </div>
                    ))
                  : monthSegments.map((seg) => (
                      <div
                        key={seg.key}
                        style={{ width: `${seg.count * dayWidth}px` }}
                        className="border-border/50 text-muted-foreground flex h-full shrink-0 items-center border-r px-2 text-[11px] font-medium tabular-nums"
                      >
                        <span className="truncate">{seg.label}</span>
                      </div>
                    ))}
              </div>

              {/* 背景网格竖线与周末阴影 */}
              <div
                style={{ top: `${AXIS_HEIGHT}px` }}
                className="pointer-events-none absolute right-0 bottom-0 left-0 z-0 flex"
              >
                {timeScale === "week" || timeScale === "month"
                  ? timelineDays.map((d) => (
                      <div
                        key={d.key}
                        style={{ width: `${dayWidth}px` }}
                        className={cn(
                          "border-border/25 h-full shrink-0 border-r",
                          d.isWeekend && highlightWeekends && "bg-muted/25",
                        )}
                      />
                    ))
                  : monthSegments.map((seg) => (
                      <div
                        key={seg.key}
                        style={{ width: `${seg.count * dayWidth}px` }}
                        className="border-border/35 h-full shrink-0 border-r"
                      />
                    ))}
              </div>

              {/* 今日蓝色竖线与圆点 */}
              {todayOffsetPx !== null && (
                <div
                  style={{ left: `${todayOffsetPx}px`, top: `${AXIS_HEIGHT - 4}px` }}
                  className="pointer-events-none absolute bottom-0 z-20 flex flex-col items-center"
                >
                  <div className="bg-primary size-2 -translate-x-1/2 rounded-full" />
                  <div className="bg-primary/85 w-[1.5px] flex-1 -translate-x-1/2" />
                </div>
              )}

              {/* 行与甘特条（同步虚拟滚动） */}
              <div className="relative z-10">
                <div style={{ height: `${totalVirtualHeight}px`, position: "relative" }}>
                  {virtualFlatItems.map((vItem) => {
                    const item = flatItems[vItem.index];
                    if (!item) return null;
                    if (item.kind === "group") {
                      return (
                        <div
                          key={`rg-${item.key}`}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: `${GROUP_ROW_HEIGHT}px`,
                            transform: `translateY(${vItem.start}px)`,
                          }}
                          className="border-border/40 bg-muted/25 border-b"
                        />
                      );
                    }

                    const { row } = item;
                    const isSelected = selectedRowIds.has(row.uuid);
                    const titleInfo = getRowDisplayTitle(row, t);
                    const baseRange = resolveRowDateRange(row, startDateColId, endDateColId, customColumnMap);

                    const activeDrag = dragState?.rowUuid === row.uuid ? dragState : null;
                    const effectiveRange = (() => {
                      if (!baseRange) return null;
                      if (!activeDrag || activeDrag.deltaDays === 0) return baseRange;
                      let s = baseRange.startKey;
                      let e = baseRange.endKey;
                      if (activeDrag.mode === "move") {
                        s = addDaysToDateKey(s, activeDrag.deltaDays);
                        e = addDaysToDateKey(e, activeDrag.deltaDays);
                      } else if (activeDrag.mode === "resize-start") {
                        const cand = addDaysToDateKey(s, activeDrag.deltaDays);
                        s = diffCalendarDays(cand, e) < 0 ? e : cand;
                      } else if (activeDrag.mode === "resize-end") {
                        const cand = addDaysToDateKey(e, activeDrag.deltaDays);
                        e = diffCalendarDays(s, cand) < 0 ? s : cand;
                      }
                      return {
                        startKey: s,
                        endKey: e,
                        durationDays: Math.max(1, diffCalendarDays(s, e) + 1),
                      };
                    })();

                    const barColor = getRowSelectOptionColor(row, colorColumnId, customColumnMap);

                    return (
                      <div
                        key={`rr-${row.docId ?? ""}:${row.uuid}`}
                        data-gantt-timeline-row={row.uuid}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${ROW_HEIGHT}px`,
                          transform: `translateY(${vItem.start}px)`,
                        }}
                        onClick={(e) => {
                          if (effectiveRange || !startColEditable) {
                            onSelectRows([row.uuid]);
                            return;
                          }
                          // 无日期行：点击时间轴空白位置直接排期到对应日期
                          const rect = e.currentTarget.getBoundingClientRect();
                          const clickX = e.clientX - rect.left;
                          const dayIdx = Math.max(0, Math.min(timelineDays.length - 1, Math.floor(clickX / dayWidth)));
                          const clickedDateKey = timelineDays[dayIdx]?.key;
                          if (clickedDateKey) {
                            void dataSource.updateRowCustomField(row.uuid, startDateColId, clickedDateKey, row.docId);
                          }
                        }}
                        className={cn(
                          "border-border/35 flex items-center border-b transition-colors",
                          isSelected && "bg-primary/8",
                          !effectiveRange && startColEditable && "hover:bg-accent/25 cursor-crosshair",
                        )}
                      >
                        {effectiveRange ? (
                          (() => {
                            const startOffsetDays = diffCalendarDays(timelineStartKey, effectiveRange.startKey);
                            const leftPx = startOffsetDays * dayWidth;
                            const widthPx = Math.max(effectiveRange.durationDays * dayWidth, Math.min(dayWidth, 26));
                            const durationLabel = t("gantt.durationDays", { count: effectiveRange.durationDays });
                            return (
                              <div
                                data-gantt-bar={row.uuid}
                                style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                                onPointerDown={(e) =>
                                  startBarPointerDrag(
                                    e,
                                    row.uuid,
                                    "move",
                                    baseRange!.startKey,
                                    baseRange!.endKey,
                                    row.docId,
                                  )
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectRows([row.uuid]);
                                }}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  onOpenRecord(row.uuid, row);
                                }}
                                title={`${titleInfo.text} (${effectiveRange.startKey}${effectiveRange.endKey !== effectiveRange.startKey ? ` ~ ${effectiveRange.endKey}` : ""})`}
                                className={cn(
                                  "group/gbar absolute flex h-6 items-center rounded-md border text-[11px] shadow-2xs transition-shadow select-none",
                                  startColEditable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                                  getViewOptionBarClass(barColor),
                                  isSelected && "ring-primary ring-2",
                                )}
                              >
                                {/* 左边缘调整开始日期 */}
                                {startColEditable && (
                                  <div
                                    onPointerDown={(e) =>
                                      startBarPointerDrag(
                                        e,
                                        row.uuid,
                                        "resize-start",
                                        baseRange!.startKey,
                                        baseRange!.endKey,
                                        row.docId,
                                      )
                                    }
                                    className="hover:bg-primary/50 absolute top-0 bottom-0 left-0 w-1.5 cursor-ew-resize rounded-l-md"
                                  />
                                )}

                                {/* 条内/条外延伸标题与天数（贴合截图 3 效果） */}
                                {(showBarLabel || showDuration) && (
                                  <div className="pointer-events-none flex items-center gap-1 px-2 whitespace-nowrap">
                                    {showBarLabel && (
                                      <span className="drop-shadow-2xs font-medium">{titleInfo.text}</span>
                                    )}
                                    {showDuration && (
                                      <span className="text-muted-foreground/95 text-[10px] tabular-nums">
                                        · {durationLabel}
                                      </span>
                                    )}
                                  </div>
                                )}

                                {/* 右边缘调整结束日期 */}
                                {endColEditable && (
                                  <div
                                    onPointerDown={(e) =>
                                      startBarPointerDrag(
                                        e,
                                        row.uuid,
                                        "resize-end",
                                        baseRange!.startKey,
                                        baseRange!.endKey,
                                        row.docId,
                                      )
                                    }
                                    className="hover:bg-primary/50 absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize rounded-r-md"
                                  />
                                )}
                              </div>
                            );
                          })()
                        ) : (
                          /* 未设置日期的记录：在今日附近展示信息提示，点击空白轴即可排期 */
                          <div
                            style={{
                              left: `${Math.max(8, (todayOffsetPx ?? 120) - 120)}px`,
                            }}
                            className="text-muted-foreground pointer-events-none absolute flex items-center gap-1.5 text-[11px] whitespace-nowrap select-none"
                          >
                            <Info className="text-primary size-3.5 shrink-0" />
                            <span>{titleInfo.text}</span>
                            {startColEditable && (
                              <span className="text-muted-foreground/60 text-[10px]">
                                ({t("gantt.clickToSchedule")})
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* 与左侧 + 行对应的占位行 */}
                <div style={{ height: `${ROW_HEIGHT}px` }} className="border-border/35 border-b" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
