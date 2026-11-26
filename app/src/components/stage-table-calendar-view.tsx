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
  getViewOptionPillAccentClass,
} from "@/components/stage-table-views-shared";
import type { Project } from "@/core/Project";
import type { StageTableRow } from "@/core/service/dataManageService/stageTableService/StageTableService";
import {
  addDaysToDateKey,
  diffCalendarDays,
  getRowSelectOptionColor,
  parseLocalDateKey,
  resolveRowDateRange,
  toLocalDateKey,
  type CalendarCellHeight,
  type CalendarDisplayMode,
  type TableCalendarViewConfig,
  type TableColumnFilter,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableFields,
  type TableFilterGroup,
  type TableSortConfig,
  type TableViewSchema,
} from "@/types/table";
import { cn } from "@/utils/cn";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Pencil,
  Plus,
  UnfoldVertical,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

const CELL_MIN_HEIGHT_CLASS: Record<CalendarCellHeight, string> = {
  compact: "min-h-22",
  medium: "min-h-30",
  tall: "min-h-42",
};

function getStartOfWeek(date: Date, weekStartsOn: 0 | 1): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = (result.getDay() - weekStartsOn + 7) % 7;
  result.setDate(result.getDate() - diff);
  return result;
}

export function StageTableCalendarView({
  project,
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
  project: Project;
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
  onOpenRecord: (rowUuid: string) => void;
  onPreviewImage: (attachmentId: string, rowUuid?: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const todayKey = useMemo(() => toLocalDateKey(new Date()), []);
  const [cursorDateKey, setCursorDateKey] = useState<string>(todayKey);
  const [undatedOpen, setUndatedOpen] = useState(false);
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [dragOverDateKey, setDragOverDateKey] = useState<string | null>(null);

  const config: TableCalendarViewConfig = activeView.calendar ?? {};
  const displayMode: CalendarDisplayMode = config.displayMode ?? "month";
  const cellHeight: CalendarCellHeight = config.cellHeight ?? "medium";
  const weekStartsOn: 0 | 1 = config.weekStartsOn ?? 1;
  const showFieldNames = config.showFieldNames ?? false;

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

  const dateColumnId = config.dateColumnId ?? customColumns.find((c) => c.type === "date")?.id ?? "createdAt";
  const endDateColumnId = config.endDateColumnId ?? null;
  const colorColumnId = config.colorColumnId ?? null;

  const dateColEditable = Boolean(customColumnMap.get(dateColumnId)?.type === "date");
  const endDateColEditable = Boolean(endDateColumnId && customColumnMap.get(endDateColumnId)?.type === "date");

  const cursorDate = parseLocalDateKey(cursorDateKey) ?? new Date();

  // 将所有过滤后的行按日期范围索引，并分离出无日期记录
  const { datedRecords, undatedRows } = useMemo(() => {
    const dated: Array<{ row: StageTableRow; startKey: string; endKey: string; durationDays: number }> = [];
    const undated: StageTableRow[] = [];
    for (const row of rows) {
      const range = resolveRowDateRange(row, dateColumnId, endDateColumnId, customColumnMap);
      if (range) {
        dated.push({ row, ...range });
      } else {
        undated.push(row);
      }
    }
    return { datedRecords: dated, undatedRows: undated };
  }, [rows, dateColumnId, endDateColumnId, customColumnMap]);

  const weekdayOrder = useMemo<number[]>(
    () => (weekStartsOn === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6]),
    [weekStartsOn],
  );

  // 计算月视图网格（5-6 周，共 35 或 42 天）
  const monthGridDays = useMemo(() => {
    const firstOfMonth = new Date(cursorDate.getFullYear(), cursorDate.getMonth(), 1);
    const gridStart = getStartOfWeek(firstOfMonth, weekStartsOn);
    const lastOfMonth = new Date(cursorDate.getFullYear(), cursorDate.getMonth() + 1, 0);
    const totalNeeded = diffCalendarDays(toLocalDateKey(gridStart), toLocalDateKey(lastOfMonth)) + 1;
    const cellCount = totalNeeded > 35 ? 42 : 35;

    const list: Array<{
      key: string;
      year: number;
      month: number;
      day: number;
      inCurrentMonth: boolean;
      isToday: boolean;
    }> = [];
    const startKey = toLocalDateKey(gridStart);
    for (let i = 0; i < cellCount; i++) {
      const k = addDaysToDateKey(startKey, i);
      const dt = parseLocalDateKey(k)!;
      list.push({
        key: k,
        year: dt.getFullYear(),
        month: dt.getMonth() + 1,
        day: dt.getDate(),
        inCurrentMonth: dt.getMonth() === cursorDate.getMonth() && dt.getFullYear() === cursorDate.getFullYear(),
        isToday: k === todayKey,
      });
    }
    return list;
  }, [cursorDate, weekStartsOn, todayKey]);

  // 计算周视图 7 天
  const weekDays = useMemo(() => {
    const start = getStartOfWeek(cursorDate, weekStartsOn);
    const startKey = toLocalDateKey(start);
    return Array.from({ length: 7 }, (_, i) => {
      const k = addDaysToDateKey(startKey, i);
      const dt = parseLocalDateKey(k)!;
      return {
        key: k,
        year: dt.getFullYear(),
        month: dt.getMonth() + 1,
        day: dt.getDate(),
        weekday: dt.getDay(),
        isToday: k === todayKey,
      };
    });
  }, [cursorDate, weekStartsOn, todayKey]);

  // 为当前可见日期构建映射，避免每格重复 O(N) 扫描
  const recordsByDateKey = useMemo(() => {
    const map = new Map<
      string,
      Array<{ row: StageTableRow; isSpanStart: boolean; isSpanEnd: boolean; isMultiDay: boolean }>
    >();
    const visibleKeys =
      displayMode === "month"
        ? monthGridDays.map((d) => d.key)
        : displayMode === "week"
          ? weekDays.map((d) => d.key)
          : [cursorDateKey];
    if (visibleKeys.length === 0) return map;
    const minKey = visibleKeys[0];
    const maxKey = visibleKeys[visibleKeys.length - 1];

    for (const item of datedRecords) {
      if (item.endKey < minKey || item.startKey > maxKey) continue;
      const clampStart = item.startKey < minKey ? minKey : item.startKey;
      const clampEnd = item.endKey > maxKey ? maxKey : item.endKey;
      const days = Math.min(60, diffCalendarDays(clampStart, clampEnd) + 1);
      const isMultiDay = item.startKey !== item.endKey;
      for (let i = 0; i < days; i++) {
        const dk = addDaysToDateKey(clampStart, i);
        const list = map.get(dk) ?? [];
        list.push({
          row: item.row,
          isSpanStart: dk === item.startKey,
          isSpanEnd: dk === item.endKey,
          isMultiDay,
        });
        map.set(dk, list);
      }
    }
    return map;
  }, [datedRecords, displayMode, monthGridDays, weekDays, cursorDateKey]);

  const extraFieldIds = useMemo(
    () =>
      visibleColumnIds.filter(
        (cid) => cid !== "name" && cid !== dateColumnId && cid !== endDateColumnId && cid !== "images",
      ),
    [visibleColumnIds, dateColumnId, endDateColumnId],
  );

  const stepPeriod = (dir: -1 | 1) => {
    if (displayMode === "month") {
      const next = new Date(cursorDate.getFullYear(), cursorDate.getMonth() + dir, 1);
      setCursorDateKey(toLocalDateKey(next));
    } else if (displayMode === "week") {
      setCursorDateKey((prev) => addDaysToDateKey(prev, dir * 7));
    } else {
      setCursorDateKey((prev) => addDaysToDateKey(prev, dir));
    }
  };

  const periodTitle = useMemo(() => {
    if (displayMode === "month") {
      return t("gantt.monthHeader", { year: cursorDate.getFullYear(), month: cursorDate.getMonth() + 1 });
    }
    if (displayMode === "week") {
      const first = weekDays[0];
      const last = weekDays[6];
      return `${first.year}/${first.month}/${first.day} - ${last.month}/${last.day}`;
    }
    const wdLabel = t(`calendar.wdFull_${cursorDate.getDay()}`);
    return `${cursorDate.getFullYear()}-${String(cursorDate.getMonth() + 1).padStart(2, "0")}-${String(cursorDate.getDate()).padStart(2, "0")} ${wdLabel}`;
  }, [displayMode, cursorDate, weekDays, t]);

  const handleMoveRecordToDate = (rowUuid: string, targetDateKey: string) => {
    if (!dateColEditable) return;
    const row = rows.find((r) => r.uuid === rowUuid);
    if (!row) return;
    const prevRange = resolveRowDateRange(row, dateColumnId, endDateColumnId, customColumnMap);
    const patch: Record<string, string> = { [dateColumnId]: targetDateKey };
    if (endDateColEditable && endDateColumnId && prevRange && prevRange.durationDays > 1) {
      patch[endDateColumnId] = addDaysToDateKey(targetDateKey, prevRange.durationDays - 1);
    }
    project.stageTable.updateRowCustomFields?.(rowUuid, patch);
  };

  const handleCreateRecordOnDate = (dateKey: string) => {
    const fields: TableFields = {};
    if (dateColEditable) {
      fields[dateColumnId] = dateKey;
    }
    const created = project.stageTable.createRow?.({
      text: "",
      tableFields: fields,
    });
    if (created) {
      onSelectRows([created.uuid], false);
      onOpenRecord(created.uuid);
    }
  };

  const handleQuickCreateDateColumn = () => {
    const dateCol = project.stageTable.addCustomColumn?.({
      name: t("columnTypes.date"),
      type: "date",
    });
    if (dateCol) {
      project.stageTable.updateActiveViewConfig?.({
        calendar: { dateColumnId: dateCol.id },
      });
    }
  };

  return (
    <div data-stage-table-calendar-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 日历第二行功能栏 */}
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 text-xs [scrollbar-width:none]">
        {/* 日历设置 */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-calendar-settings-trigger
              className="text-foreground hover:bg-accent data-[state=open]:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
            >
              <CalendarDays className="size-3.5" />
              <span>{t("calendar.settings")}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-72 space-y-3 p-3 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="space-y-1.5">
              <div className="text-muted-foreground text-[11px] font-medium">{t("calendar.dateField")}</div>
              <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border p-1">
                {dateColumnCandidates.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => project.stageTable.updateActiveViewConfig?.({ calendar: { dateColumnId: item.id } })}
                    className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left"
                  >
                    <StageTableColumnIcon columnId={item.id} customColumn={item.customCol} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {dateColumnId === item.id && <Check className="text-primary size-3.5 shrink-0" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-muted-foreground text-[11px] font-medium">{t("gantt.endDateField")}</div>
              <div className="max-h-28 space-y-0.5 overflow-y-auto rounded-md border p-1">
                <button
                  type="button"
                  onClick={() => project.stageTable.updateActiveViewConfig?.({ calendar: { endDateColumnId: null } })}
                  className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left"
                >
                  <span className="text-muted-foreground">{t("gantt.singleDayMode")}</span>
                  {endDateColumnId === null && <Check className="text-primary size-3.5" />}
                </button>
                {dateColumnCandidates.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      project.stageTable.updateActiveViewConfig?.({ calendar: { endDateColumnId: item.id } })
                    }
                    className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left"
                  >
                    <StageTableColumnIcon columnId={item.id} customColumn={item.customCol} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {endDateColumnId === item.id && <Check className="text-primary size-3.5 shrink-0" />}
                  </button>
                ))}
              </div>
            </div>

            {!customColumns.some((c) => c.type === "date") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleQuickCreateDateColumn}
                className="h-7 w-full gap-1.5 text-xs"
              >
                <Plus className="size-3.5" />
                <span>{t("calendar.createDateColumn")}</span>
              </Button>
            )}

            {selectColumns.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-muted-foreground text-[11px] font-medium">{t("views.colorBy")}</div>
                <div className="max-h-24 space-y-0.5 overflow-y-auto rounded-md border p-1">
                  <button
                    type="button"
                    onClick={() => project.stageTable.updateActiveViewConfig?.({ calendar: { colorColumnId: null } })}
                    className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left"
                  >
                    <span className="text-muted-foreground">{t("views.defaultColor")}</span>
                    {colorColumnId === null && <Check className="text-primary size-3.5" />}
                  </button>
                  {selectColumns.map((col) => (
                    <button
                      key={col.id}
                      type="button"
                      onClick={() =>
                        project.stageTable.updateActiveViewConfig?.({ calendar: { colorColumnId: col.id } })
                      }
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

            <div className="flex items-center justify-between gap-2">
              <span>{t("calendar.weekStartsOn")}</span>
              <div className="bg-muted flex rounded-md p-0.5">
                {([1, 0] as const).map((ws) => (
                  <button
                    key={ws}
                    type="button"
                    onClick={() => project.stageTable.updateActiveViewConfig?.({ calendar: { weekStartsOn: ws } })}
                    className={cn(
                      "cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors",
                      weekStartsOn === ws
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`calendar.wdFull_${ws}`)}
                  </button>
                ))}
              </div>
            </div>

            <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1 py-1">
              <Checkbox
                checked={showFieldNames}
                onCheckedChange={(v) =>
                  project.stageTable.updateActiveViewConfig?.({ calendar: { showFieldNames: Boolean(v) } })
                }
              />
              <span>{t("views.showFieldNames")}</span>
            </label>

            <div className="border-border/60 border-t pt-2">
              <div className="text-muted-foreground mb-1.5 text-[11px] font-medium">{t("views.cardFields")}</div>
              <StageTableFieldVisibilityList
                allColumnIds={allColumnIds}
                customColumnMap={customColumnMap}
                getColumnLabel={getColumnLabel}
                isColumnVisible={(cid) => project.stageTable.isColumnVisible(cid)}
                onToggleColumn={(cid, visible) => project.stageTable.setColumnVisible(cid, visible)}
                t={t}
              />
            </div>
          </PopoverContent>
        </Popover>

        <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

        <StageTableFilterToolbarPopover
          filterableColumnIds={filterableColumnIds}
          columnGroups={filterColumnGroups}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          allRows={allRows}
          activeFilters={activeFilters}
          filterGroup={activeFilterGroup}
          getColumnLabel={getColumnLabel}
          onSetConjunction={(conj) => project.stageTable.setFilterConjunction?.(conj)}
          onAddCondition={(cid) => project.stageTable.addFilterCondition?.(cid)}
          onUpdateCondition={(id, patch) => project.stageTable.updateFilterCondition?.(id, patch)}
          onRemoveCondition={(id) => project.stageTable.removeFilterCondition?.(id)}
          onToggleConditionCollapse={(id) => project.stageTable.toggleFilterConditionCollapsed?.(id)}
          onReorderConditions={(dragId, targetId, pos) =>
            project.stageTable.reorderFilterConditions?.(dragId, targetId, pos)
          }
          onSetColumnFilter={(cid, flt) => project.stageTable.setColumnFilter?.(cid, flt)}
          onClearAllFilters={() => project.stageTable.clearAllFilters?.()}
          t={t}
        />

        <StageTableSortToolbarPopover
          allColumnIds={allColumnIds}
          customColumnMap={customColumnMap}
          activeSort={activeSort}
          getColumnLabel={getColumnLabel}
          onSetSort={(sort) => project.stageTable.setSort?.(sort)}
          t={t}
        />

        <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

        {/* 日历高度 */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-calendar-height-trigger
              className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
            >
              <UnfoldVertical className="size-3.5" />
              <span>{t("calendar.calendarHeight")}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-36 p-1 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(["compact", "medium", "tall"] as const).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => project.stageTable.updateActiveViewConfig?.({ calendar: { cellHeight: h } })}
                className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5"
              >
                <span>{t(`calendar.height_${h}`)}</span>
                {cellHeight === h && <Check className="text-primary size-3.5" />}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      {/* 日历副头部：年月标题 + 翻页/今天 + 日/周/月 + 无日期记录 */}
      <div className="border-border/60 flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3 select-none">
        <span data-calendar-period-title className="text-sm font-semibold tabular-nums">
          {periodTitle}
        </span>

        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label={t("calendar.prevPeriod")}
              onClick={() => stepPeriod(-1)}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <button
              type="button"
              data-calendar-today-btn
              onClick={() => setCursorDateKey(todayKey)}
              className="text-foreground hover:bg-accent h-6 cursor-pointer rounded px-2 font-medium transition-colors"
            >
              {t("calendar.today")}
            </button>
            <button
              type="button"
              aria-label={t("calendar.nextPeriod")}
              onClick={() => stepPeriod(1)}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>

          <div className="bg-muted border-border/60 flex items-center rounded-md border p-0.5">
            {(["day", "week", "month"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-calendar-mode={mode}
                onClick={() => project.stageTable.updateActiveViewConfig?.({ calendar: { displayMode: mode } })}
                className={cn(
                  "cursor-pointer rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                  displayMode === mode
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`calendar.mode_${mode}`)}
              </button>
            ))}
          </div>

          <button
            type="button"
            data-calendar-undated-trigger
            onClick={() => setUndatedOpen((v) => !v)}
            className={cn(
              "border-border/70 hover:bg-accent inline-flex h-6 cursor-pointer items-center gap-1 rounded border px-2 text-[11px] transition-colors",
              undatedOpen ? "bg-primary/15 border-primary/50 text-primary font-medium" : "text-muted-foreground",
            )}
          >
            <span>{t("calendar.undatedCount", { count: undatedRows.length })}</span>
          </button>
        </div>
      </div>

      {/* 日历主体 + 可折叠无日期记录侧边栏 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {displayMode === "month" && (
            <>
              {/* 周一 ~ 周日表头 */}
              <div className="border-border/60 bg-muted/35 grid shrink-0 grid-cols-7 border-b text-center text-[11px] font-medium select-none">
                {weekdayOrder.map((wd) => (
                  <div key={wd} className="border-border/40 text-muted-foreground border-r py-1.5 last:border-r-0">
                    {t(`calendar.wdFull_${wd}`)}
                  </div>
                ))}
              </div>

              {/* 月视图网格 */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="grid min-h-full grid-cols-7">
                  {monthGridDays.map((cell) => {
                    const cellItems = recordsByDateKey.get(cell.key) ?? [];
                    const isDropOver = dragOverDateKey === cell.key && draggingRowId !== null;
                    return (
                      <div
                        key={cell.key}
                        data-calendar-day-cell={cell.key}
                        onDragOver={(e) => {
                          if (!dateColEditable || !draggingRowId) return;
                          e.preventDefault();
                          if (dragOverDateKey !== cell.key) setDragOverDateKey(cell.key);
                        }}
                        onDragLeave={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                            setDragOverDateKey((prev) => (prev === cell.key ? null : prev));
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const droppedId = e.dataTransfer.getData("text/plain") || draggingRowId;
                          setDragOverDateKey(null);
                          setDraggingRowId(null);
                          if (droppedId) {
                            handleMoveRecordToDate(droppedId, cell.key);
                          }
                        }}
                        className={cn(
                          "group/day border-border/45 flex flex-col border-r border-b p-1.5 transition-colors [&:nth-child(7n)]:border-r-0",
                          CELL_MIN_HEIGHT_CLASS[cellHeight],
                          !cell.inCurrentMonth && "bg-muted/20",
                          isDropOver && "bg-primary/12 ring-primary/50 ring-1 ring-inset",
                        )}
                      >
                        <div className="mb-1 flex items-center justify-between gap-1 select-none">
                          <span
                            className={cn(
                              "inline-flex items-center justify-center text-[11px] tabular-nums",
                              cell.isToday
                                ? "bg-primary text-primary-foreground size-5 rounded-full font-semibold"
                                : cell.inCurrentMonth
                                  ? "text-foreground/90 font-medium"
                                  : "text-muted-foreground/50",
                            )}
                          >
                            {cell.day === 1 && !cell.isToday
                              ? t("calendar.firstOfMonth", { month: cell.month })
                              : cell.day}
                          </span>
                          <button
                            type="button"
                            title={t("gallery.addRecord")}
                            onClick={() => handleCreateRecordOnDate(cell.key)}
                            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-4 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover/day:opacity-100"
                          >
                            <Plus className="size-3" />
                          </button>
                        </div>

                        <div className="flex flex-1 flex-col gap-1 overflow-hidden">
                          {cellItems.map(({ row, isSpanStart, isSpanEnd, isMultiDay }) => {
                            const titleInfo = getRowDisplayTitle(row, t);
                            const isSelected = selectedRowIds.has(row.uuid);
                            const pillColor = getRowSelectOptionColor(row, colorColumnId, customColumnMap);
                            return (
                              <div
                                key={`${cell.key}-${row.uuid}`}
                                data-calendar-event={row.uuid}
                                draggable={dateColEditable}
                                onDragStart={(e) => {
                                  setDraggingRowId(row.uuid);
                                  e.dataTransfer.setData("text/plain", row.uuid);
                                  e.dataTransfer.effectAllowed = "move";
                                }}
                                onDragEnd={() => {
                                  setDraggingRowId(null);
                                  setDragOverDateKey(null);
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectRows([row.uuid]);
                                }}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  onOpenRecord(row.uuid);
                                }}
                                title={titleInfo.text}
                                className={cn(
                                  "border-border/70 hover:border-primary/60 flex cursor-pointer items-center gap-1 truncate rounded border border-l-2 px-1.5 py-0.5 text-[11px] transition-colors select-none",
                                  getViewOptionPillAccentClass(pillColor),
                                  isSelected && "border-primary ring-primary/40 ring-1",
                                  titleInfo.isPlaceholder && "text-muted-foreground",
                                )}
                              >
                                {isMultiDay && !isSpanStart && (
                                  <span className="text-muted-foreground text-[9px]">←</span>
                                )}
                                <span className="min-w-0 flex-1 truncate">{titleInfo.text}</span>
                                {isMultiDay && !isSpanEnd && (
                                  <span className="text-muted-foreground text-[9px]">→</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {displayMode === "week" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="border-border/60 bg-muted/35 grid shrink-0 grid-cols-7 border-b select-none">
                {weekDays.map((day) => (
                  <div
                    key={day.key}
                    className="border-border/40 flex items-center justify-between border-r px-2 py-2 text-xs last:border-r-0"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground text-[11px]">{t(`calendar.wdFull_${day.weekday}`)}</span>
                      <span
                        className={cn(
                          "inline-flex items-center justify-center text-xs tabular-nums",
                          day.isToday
                            ? "bg-primary text-primary-foreground size-5 rounded-full font-semibold"
                            : "font-medium",
                        )}
                      >
                        {day.day}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCreateRecordOnDate(day.key)}
                      className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-5 cursor-pointer items-center justify-center rounded"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto">
                {weekDays.map((day) => {
                  const dayItems = recordsByDateKey.get(day.key) ?? [];
                  const isDropOver = dragOverDateKey === day.key && draggingRowId !== null;
                  return (
                    <div
                      key={day.key}
                      data-calendar-day-cell={day.key}
                      onDragOver={(e) => {
                        if (!dateColEditable || !draggingRowId) return;
                        e.preventDefault();
                        if (dragOverDateKey !== day.key) setDragOverDateKey(day.key);
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          setDragOverDateKey((prev) => (prev === day.key ? null : prev));
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const droppedId = e.dataTransfer.getData("text/plain") || draggingRowId;
                        setDragOverDateKey(null);
                        setDraggingRowId(null);
                        if (droppedId) handleMoveRecordToDate(droppedId, day.key);
                      }}
                      className={cn(
                        "border-border/45 flex flex-col gap-1.5 border-r p-2 last:border-r-0",
                        isDropOver && "bg-primary/10",
                      )}
                    >
                      {dayItems.map(({ row }) => {
                        const titleInfo = getRowDisplayTitle(row, t);
                        const isSelected = selectedRowIds.has(row.uuid);
                        const pillColor = getRowSelectOptionColor(row, colorColumnId, customColumnMap);
                        return (
                          <div
                            key={`${day.key}-${row.uuid}`}
                            data-calendar-event={row.uuid}
                            draggable={dateColEditable}
                            onDragStart={(e) => {
                              setDraggingRowId(row.uuid);
                              e.dataTransfer.setData("text/plain", row.uuid);
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            onDragEnd={() => {
                              setDraggingRowId(null);
                              setDragOverDateKey(null);
                            }}
                            onClick={() => onSelectRows([row.uuid])}
                            onDoubleClick={() => onOpenRecord(row.uuid)}
                            className={cn(
                              "border-border/70 hover:border-primary/60 cursor-pointer space-y-1 rounded-md border border-l-2 p-2 text-xs transition-colors select-none",
                              getViewOptionPillAccentClass(pillColor),
                              isSelected && "border-primary ring-primary/40 ring-1",
                            )}
                          >
                            <div
                              className={cn(
                                "leading-snug font-medium break-words",
                                titleInfo.isPlaceholder && "text-muted-foreground font-normal",
                              )}
                            >
                              {titleInfo.text}
                            </div>
                            {extraFieldIds.slice(0, 3).map((cid) => (
                              <StageTableFieldValueDisplay
                                key={cid}
                                project={project}
                                row={row}
                                columnId={cid}
                                customCol={customColumnMap.get(cid)}
                                onPreviewImage={onPreviewImage}
                                compact
                                t={t}
                              />
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {displayMode === "day" && (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-2xl space-y-2">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-muted-foreground text-xs">
                    {t("kanban.itemCount", { count: (recordsByDateKey.get(cursorDateKey) ?? []).length })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleCreateRecordOnDate(cursorDateKey)}
                    className="h-7 gap-1 px-2.5 text-xs"
                  >
                    <Plus className="size-3.5" />
                    <span>{t("gallery.addRecord")}</span>
                  </Button>
                </div>
                {(recordsByDateKey.get(cursorDateKey) ?? []).length === 0 ? (
                  <div className="border-border/60 text-muted-foreground rounded-lg border border-dashed py-12 text-center text-xs">
                    {t("calendar.noRecordsForDay")}
                  </div>
                ) : (
                  (recordsByDateKey.get(cursorDateKey) ?? []).map(({ row }) => {
                    const titleInfo = getRowDisplayTitle(row, t);
                    const isSelected = selectedRowIds.has(row.uuid);
                    const pillColor = getRowSelectOptionColor(row, colorColumnId, customColumnMap);
                    return (
                      <div
                        key={row.uuid}
                        data-calendar-event={row.uuid}
                        onClick={() => onSelectRows([row.uuid])}
                        onDoubleClick={() => onOpenRecord(row.uuid)}
                        className={cn(
                          "group/dcard border-border/70 hover:border-primary/60 flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-l-4 p-3 transition-colors select-none",
                          getViewOptionPillAccentClass(pillColor),
                          isSelected && "border-primary ring-primary/35 ring-2",
                        )}
                      >
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div
                            className={cn(
                              "text-sm font-medium",
                              titleInfo.isPlaceholder && "text-muted-foreground font-normal",
                            )}
                          >
                            {titleInfo.text}
                          </div>
                          {extraFieldIds.map((cid) => (
                            <div key={cid} className="flex items-center gap-2 text-xs">
                              {showFieldNames && (
                                <span className="text-muted-foreground shrink-0 text-[11px]">
                                  {getColumnLabel(cid)}:
                                </span>
                              )}
                              <StageTableFieldValueDisplay
                                project={project}
                                row={row}
                                columnId={cid}
                                customCol={customColumnMap.get(cid)}
                                onPreviewImage={onPreviewImage}
                                compact
                                t={t}
                              />
                            </div>
                          ))}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            title={t("jumpToNode")}
                            onClick={(e) => {
                              e.stopPropagation();
                              project.stageTable.focusRowOnCanvas(row.uuid);
                            }}
                            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded"
                          >
                            <Crosshair className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            title={t("views.editRecord")}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenRecord(row.uuid);
                            }}
                            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右侧可展开的「无日期记录」抽屉 */}
        {undatedOpen && (
          <div
            data-calendar-undated-drawer
            className="border-border/60 bg-muted/15 flex w-60 shrink-0 flex-col border-l"
          >
            <div className="border-border/60 flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs font-medium">
              <span>{t("calendar.undatedCount", { count: undatedRows.length })}</span>
              <button
                type="button"
                onClick={() => setUndatedOpen(false)}
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-5 cursor-pointer items-center justify-center rounded"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="flex-1 space-y-1.5 overflow-y-auto p-2 text-xs">
              {undatedRows.length === 0 ? (
                <div className="text-muted-foreground py-8 text-center text-[11px]">{t("calendar.noUndated")}</div>
              ) : (
                undatedRows.map((row) => {
                  const titleInfo = getRowDisplayTitle(row, t);
                  return (
                    <div
                      key={row.uuid}
                      draggable={dateColEditable}
                      onDragStart={(e) => {
                        setDraggingRowId(row.uuid);
                        e.dataTransfer.setData("text/plain", row.uuid);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDraggingRowId(null);
                        setDragOverDateKey(null);
                      }}
                      onClick={() => onSelectRows([row.uuid])}
                      onDoubleClick={() => onOpenRecord(row.uuid)}
                      className="bg-card border-border/70 hover:border-primary/50 flex shrink-0 cursor-pointer items-center justify-between gap-1.5 rounded-md border px-2.5 py-2 transition-colors select-none"
                    >
                      <span
                        className={cn("min-w-0 flex-1 truncate", titleInfo.isPlaceholder && "text-muted-foreground")}
                      >
                        {titleInfo.text}
                      </span>
                      {dateColEditable && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveRecordToDate(row.uuid, todayKey);
                          }}
                          className="text-primary hover:bg-primary/10 shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px]"
                        >
                          {t("calendar.setToday")}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
