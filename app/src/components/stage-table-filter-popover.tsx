import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  getRowDisplayTitle,
  getViewOptionBadgeClass,
  StageTableColumnIcon,
} from "@/components/stage-table-views-shared";
import type { StageTableRow } from "@/core/service/dataManageService/stageTableService/StageTableService";
import {
  countActiveFilterConditions,
  getColumnFilterKind,
  getFilterOperatorsForKind,
  operatorRequiresValue,
  parseLocalDateKey,
  TABLE_DATE_FILTER_PRESETS,
  toLocalDateKey,
  type TableColumnFilter,
  type TableColumnFilterKind,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableDateFilterPreset,
  type TableFilterCondition,
  type TableFilterConjunction,
  type TableFilterGroup,
  type TableFilterOperator,
} from "@/types/table";
import { cn } from "@/utils/cn";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleMinus,
  Filter,
  GripVertical,
  Plus,
  Search,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

type FieldPickerEntry =
  | { kind: "group"; key: string; group: TableColumnGroup; columnIds: string[] }
  | { kind: "column"; key: string; columnId: string };

function buildGroupedFieldEntries(
  orderedColumnIds: readonly string[],
  columnGroups: readonly TableColumnGroup[],
): FieldPickerEntry[] {
  const visibleSet = new Set(orderedColumnIds);
  const groupByColId = new Map<string, TableColumnGroup>();
  for (const grp of columnGroups) {
    for (const cid of grp.columnIds) {
      if (visibleSet.has(cid) && !groupByColId.has(cid)) {
        groupByColId.set(cid, grp);
      }
    }
  }

  const entries: FieldPickerEntry[] = [];
  orderedColumnIds.forEach((cid, idx) => {
    const grp = groupByColId.get(cid);
    if (grp) {
      const prev = entries[entries.length - 1];
      if (prev && prev.kind === "group" && prev.group.id === grp.id) {
        prev.columnIds.push(cid);
      } else {
        entries.push({
          kind: "group",
          key: `${grp.id}:${idx}`,
          group: grp,
          columnIds: [cid],
        });
      }
    } else {
      entries.push({
        kind: "column",
        key: cid,
        columnId: cid,
      });
    }
  });
  return entries;
}

function GroupedFieldPickerContent({
  orderedColumnIds,
  columnGroups,
  customColumnMap,
  selectedColumnId,
  getColumnLabel,
  onSelect,
  t,
}: {
  orderedColumnIds: readonly string[];
  columnGroups: readonly TableColumnGroup[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  selectedColumnId?: string;
  getColumnLabel: (colId: string) => string;
  onSelect: (colId: string) => void;
  t: TranslateFn;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  const entries = useMemo(
    () => buildGroupedFieldEntries(orderedColumnIds, columnGroups),
    [orderedColumnIds, columnGroups],
  );

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  return (
    <div className="select-none">
      <div className="text-muted-foreground px-2 pt-0.5 pb-1.5 text-[11px] font-medium">
        {t("sortFilter.selectFieldTitle")}
      </div>
      <div className="max-h-[min(56vh,360px)] space-y-0.5 overflow-y-auto pr-0.5">
        {entries.map((entry) => {
          if (entry.kind === "group") {
            const isGroupCollapsed = collapsedGroups.has(entry.key);
            return (
              <div key={entry.key} data-filter-field-group={entry.group.id} className="space-y-0.5">
                <button
                  type="button"
                  data-filter-field-group-toggle={entry.group.id}
                  aria-expanded={!isGroupCollapsed}
                  onClick={() => toggleGroup(entry.key)}
                  className="hover:bg-accent/70 text-foreground/90 flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs font-medium transition-colors"
                >
                  {isGroupCollapsed ? (
                    <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                  ) : (
                    <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.group.name}</span>
                </button>
                {!isGroupCollapsed && (
                  <div className="space-y-0.5">
                    {entry.columnIds.map((cid) => {
                      const isSelected = selectedColumnId === cid;
                      return (
                        <button
                          key={cid}
                          type="button"
                          data-filter-field-option={cid}
                          onClick={() => onSelect(cid)}
                          className={cn(
                            "hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-7 text-left text-xs transition-colors",
                            isSelected && "bg-accent/60 font-medium",
                          )}
                        >
                          <StageTableColumnIcon columnId={cid} customColumn={customColumnMap.get(cid)} />
                          <span className="min-w-0 flex-1 truncate">{getColumnLabel(cid)}</span>
                          {isSelected && <Check className="text-primary size-3.5 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          const isSelected = selectedColumnId === entry.columnId;
          return (
            <button
              key={entry.key}
              type="button"
              data-filter-field-option={entry.columnId}
              onClick={() => onSelect(entry.columnId)}
              className={cn(
                "hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
                isSelected && "bg-accent/60 font-medium",
              )}
            >
              <StageTableColumnIcon columnId={entry.columnId} customColumn={customColumnMap.get(entry.columnId)} />
              <span className="min-w-0 flex-1 truncate">{getColumnLabel(entry.columnId)}</span>
              {isSelected && <Check className="text-primary size-3.5 shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function getOperatorLabel(kind: TableColumnFilterKind, operator: TableFilterOperator, t: TranslateFn): string {
  if (kind === "number") {
    switch (operator) {
      case "eq":
        return "=";
      case "neq":
        return "≠";
      case "gt":
        return ">";
      case "gte":
        return "≥";
      case "lt":
        return "<";
      case "lte":
        return "≤";
      case "is_empty":
        return t("sortFilter.opIsEmpty");
      case "is_not_empty":
        return t("sortFilter.opIsNotEmpty");
      default:
        return "=";
    }
  }
  if (kind === "date") {
    switch (operator) {
      case "eq":
        return t("sortFilter.opEq");
      case "neq":
        return t("sortFilter.opNeq");
      case "gt":
        return t("sortFilter.opAfter");
      case "lt":
        return t("sortFilter.opBefore");
      case "gte":
        return t("sortFilter.opOnOrAfter");
      case "lte":
        return t("sortFilter.opOnOrBefore");
      case "is_empty":
        return t("sortFilter.opIsEmpty");
      case "is_not_empty":
        return t("sortFilter.opIsNotEmpty");
      default:
        return t("sortFilter.opEq");
    }
  }
  switch (operator) {
    case "contains":
      return t("sortFilter.opContains");
    case "not_contains":
      return t("sortFilter.opNotContains");
    case "eq":
      return t("sortFilter.opEq");
    case "neq":
      return t("sortFilter.opNeq");
    case "is_empty":
      return t("sortFilter.opIsEmpty");
    case "is_not_empty":
      return t("sortFilter.opIsNotEmpty");
    default:
      return t("sortFilter.opContains");
  }
}

function getDatePresetLabel(preset: TableDateFilterPreset, t: TranslateFn): string {
  return t(`sortFilter.datePreset_${preset}`);
}

interface FilterConditionCardProps {
  condition: TableFilterCondition;
  filterableColumnIds: readonly string[];
  columnGroups: readonly TableColumnGroup[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  allRows: readonly StageTableRow[];
  isDragging: boolean;
  dropPosition: "before" | "after" | null;
  onStartDrag: (conditionId: string, e: React.PointerEvent) => void;
  getColumnLabel: (colId: string) => string;
  onUpdate: (conditionId: string, patch: Partial<Omit<TableFilterCondition, "id">>) => void;
  onRemove: (conditionId: string) => void;
  onToggleCollapse: (conditionId: string) => void;
  t: TranslateFn;
}

function FilterConditionCard({
  condition,
  filterableColumnIds,
  columnGroups,
  customColumnMap,
  allRows,
  isDragging,
  dropPosition,
  onStartDrag,
  getColumnLabel,
  onUpdate,
  onRemove,
  onToggleCollapse,
  t,
}: FilterConditionCardProps) {
  const [fieldOpen, setFieldOpen] = useState(false);
  const [opOpen, setOpOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [optionSearch, setOptionSearch] = useState("");

  const customCol = customColumnMap.get(condition.columnId);
  const kind = getColumnFilterKind(condition.columnId, customCol);
  const operators = getFilterOperatorsForKind(kind);
  const needsValue = operatorRequiresValue(condition.operator);
  const isCollapsed = Boolean(condition.collapsed);

  const selectedExactDate = useMemo(
    () => (condition.datePreset || !condition.value ? undefined : (parseLocalDateKey(condition.value) ?? undefined)),
    [condition.datePreset, condition.value],
  );
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => selectedExactDate ?? new Date());

  useEffect(() => {
    if (dateOpen) {
      setCalendarMonth(selectedExactDate ?? new Date());
    }
  }, [dateOpen, selectedExactDate]);

  const relationCandidates = useMemo(() => {
    if (kind !== "relation") return [];
    const byId = new Map<string, string>();
    for (const row of allRows) {
      const { text } = getRowDisplayTitle(row, t);
      byId.set(row.uuid, text);
    }
    for (const row of allRows) {
      const list =
        condition.columnId === "outer"
          ? row.outer
            ? [row.outer]
            : []
          : row[condition.columnId as "parents" | "children" | "inner"];
      for (const item of list) {
        if (!byId.has(item.uuid)) {
          byId.set(item.uuid, item.label.trim() || item.uuid);
        }
      }
    }
    return Array.from(byId.entries()).map(([uuid, label]) => ({ id: uuid, label }));
  }, [allRows, condition.columnId, kind, t]);

  const collapsedSummary = useMemo(() => {
    const opText = getOperatorLabel(kind, condition.operator, t);
    if (!needsValue) return opText;
    if (kind === "date") {
      if (condition.datePreset) return `${opText} ${getDatePresetLabel(condition.datePreset, t)}`;
      if (condition.value) return `${opText} ${condition.value}`;
      return opText;
    }
    if (kind === "select") {
      const vals = condition.values ?? [];
      if (vals.length === 0) return opText;
      const optMap = new Map((customCol?.options ?? []).map((o) => [o.id, o.name]));
      const names = vals.map((id) => optMap.get(id)).filter((n): n is string => Boolean(n));
      return names.length > 0 ? `${opText} ${names.join(", ")}` : opText;
    }
    if (kind === "relation") {
      const vals = condition.values ?? [];
      if (vals.length === 0) return opText;
      const candMap = new Map(relationCandidates.map((c) => [c.id, c.label]));
      const names = vals.map((id) => candMap.get(id) ?? id);
      return `${opText} ${names.join(", ")}`;
    }
    const textVal = condition.value?.trim() ?? "";
    return textVal ? `${opText} ${textVal}` : opText;
  }, [condition, customCol, kind, needsValue, relationCandidates, t]);

  const selectedValuesSet = useMemo(() => new Set(condition.values ?? []), [condition.values]);
  const singleChoiceMode =
    (customCol?.type === "select" || condition.columnId === "outer") &&
    (condition.operator === "eq" || condition.operator === "neq");

  const toggleSelectableId = (targetId: string) => {
    if (singleChoiceMode) {
      const next = selectedValuesSet.has(targetId) ? [] : [targetId];
      onUpdate(condition.id, { values: next });
      return;
    }
    const next = new Set(selectedValuesSet);
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    onUpdate(condition.id, { values: Array.from(next) });
  };

  const trimmedOptSearch = optionSearch.trim().toLowerCase();
  const filteredSelectOptions = useMemo(() => {
    if (kind !== "select") return [];
    const opts = customCol?.options ?? [];
    if (!trimmedOptSearch) return opts;
    return opts.filter((opt) => opt.name.toLowerCase().includes(trimmedOptSearch));
  }, [customCol?.options, kind, trimmedOptSearch]);

  const filteredRelationCandidates = useMemo(() => {
    if (kind !== "relation") return [];
    if (!trimmedOptSearch) return relationCandidates;
    return relationCandidates.filter((item) => item.label.toLowerCase().includes(trimmedOptSearch));
  }, [kind, relationCandidates, trimmedOptSearch]);

  const dateDisplayLabel = condition.datePreset ? getDatePresetLabel(condition.datePreset, t) : (condition.value ?? "");

  return (
    <div
      data-filter-condition-card={condition.id}
      data-filter-dragging={isDragging ? "true" : undefined}
      data-filter-drop-position={dropPosition ?? undefined}
      className={cn(
        "border-border/80 bg-muted/25 relative rounded-lg border transition-all",
        isDragging && "ring-primary/40 opacity-45 ring-1",
      )}
    >
      {dropPosition === "before" && (
        <div className="bg-primary pointer-events-none absolute -top-1.5 right-1 left-1 z-10 h-0.5 rounded-full" />
      )}
      {dropPosition === "after" && (
        <div className="bg-primary pointer-events-none absolute right-1 -bottom-1.5 left-1 z-10 h-0.5 rounded-full" />
      )}

      {/* 卡片头部：拖动手柄 + 左侧字段切换下拉，右侧删除与展开/收起小箭头 */}
      <div
        onPointerDown={(e) => {
          const target = e.target as HTMLElement | null;
          if (target?.closest("button, input, [role='button']")) return;
          onStartDrag(condition.id, e);
        }}
        className="flex items-center gap-1 px-2 py-2"
      >
        <button
          type="button"
          data-filter-drag-handle={condition.id}
          aria-label={t("sortFilter.dragConditionAria")}
          title={t("sortFilter.dragConditionAria")}
          onPointerDown={(e) => onStartDrag(condition.id, e)}
          className="text-muted-foreground/70 hover:text-foreground flex size-5 shrink-0 cursor-grab items-center justify-center rounded active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </button>

        <Popover open={fieldOpen} onOpenChange={setFieldOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-filter-field-trigger={condition.id}
              className="hover:bg-accent inline-flex max-w-[165px] min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium transition-colors"
            >
              <StageTableColumnIcon columnId={condition.columnId} customColumn={customCol} />
              <span className="truncate">{getColumnLabel(condition.columnId)}</span>
              <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={4}
            className="z-[60] w-56 p-1.5 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <GroupedFieldPickerContent
              orderedColumnIds={filterableColumnIds}
              columnGroups={columnGroups}
              customColumnMap={customColumnMap}
              selectedColumnId={condition.columnId}
              getColumnLabel={getColumnLabel}
              onSelect={(cid) => {
                if (cid !== condition.columnId) {
                  onUpdate(condition.id, { columnId: cid });
                  setOptionSearch("");
                }
                setFieldOpen(false);
              }}
              t={t}
            />
          </PopoverContent>
        </Popover>

        {isCollapsed && (
          <span
            data-filter-collapsed-summary={condition.id}
            className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]"
            title={collapsedSummary}
          >
            {collapsedSummary}
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-filter-remove-condition={condition.id}
            aria-label={t("sortFilter.removeCondition")}
            title={t("sortFilter.removeCondition")}
            onClick={() => onRemove(condition.id)}
            className="text-muted-foreground hover:bg-accent hover:text-destructive flex size-6 cursor-pointer items-center justify-center rounded transition-colors"
          >
            <CircleMinus className="size-3.5" />
          </button>
          <span className="bg-border/80 mx-0.5 h-3.5 w-px" />
          <button
            type="button"
            data-filter-toggle-collapse={condition.id}
            aria-label={isCollapsed ? t("sortFilter.expandCondition") : t("sortFilter.collapseCondition")}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? t("sortFilter.expandCondition") : t("sortFilter.collapseCondition")}
            onClick={() => onToggleCollapse(condition.id)}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded transition-colors"
          >
            {isCollapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* 卡片具体内容区（点击右上角小箭头可展开/收起） */}
      {!isCollapsed && (
        <div
          data-filter-condition-body={condition.id}
          className="border-border/60 bg-background/85 mx-1.5 mb-1.5 rounded-md border p-2"
        >
          {/* 操作符选择下拉 */}
          <Popover open={opOpen} onOpenChange={setOpOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-filter-operator-trigger={condition.id}
                className="text-foreground/90 hover:bg-accent inline-flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-xs transition-colors"
              >
                <span>{getOperatorLabel(kind, condition.operator, t)}</span>
                <ChevronDown className="text-muted-foreground size-3 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={4}
              className="z-[60] w-36 p-1 text-xs select-none"
              onWheel={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {operators.map((op) => {
                const isSelected = op === condition.operator;
                return (
                  <button
                    key={op}
                    type="button"
                    data-filter-operator-option={op}
                    onClick={() => {
                      onUpdate(condition.id, { operator: op });
                      setOpOpen(false);
                    }}
                    className={cn(
                      "hover:bg-accent flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
                      isSelected && "bg-accent/50 font-medium",
                    )}
                  >
                    <span>{getOperatorLabel(kind, op, t)}</span>
                    {isSelected && <Check className="text-primary size-3.5 shrink-0" />}
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>

          {/* 值编辑区（为空 / 不为空 及 图片列均不渲染值输入区） */}
          {needsValue && kind === "number" && (
            <div className="mt-1.5">
              <Input
                data-filter-number-input={condition.id}
                type="number"
                step="any"
                value={condition.value ?? ""}
                onChange={(e) => onUpdate(condition.id, { value: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={t("sortFilter.inputPlaceholder")}
                className="h-8 text-xs tabular-nums"
              />
            </div>
          )}

          {needsValue && kind === "text" && (
            <div className="mt-1.5">
              <Input
                data-filter-text-input={condition.id}
                type="text"
                value={condition.value ?? ""}
                onChange={(e) => onUpdate(condition.id, { value: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={t("sortFilter.inputPlaceholder")}
                className="h-8 text-xs"
              />
            </div>
          )}

          {needsValue && kind === "select" && (
            <div className="border-border/60 mt-1.5 border-t pt-1.5">
              <div className="relative mb-1.5 flex items-center">
                <input
                  type="text"
                  data-filter-select-search={condition.id}
                  value={optionSearch}
                  onChange={(e) => setOptionSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t("sortFilter.selectPlaceholder")}
                  className="placeholder:text-muted-foreground h-7 w-full bg-transparent pr-6 pl-1 text-xs outline-none"
                />
                <Search className="text-muted-foreground pointer-events-none absolute right-1.5 size-3.5" />
              </div>
              <div className="max-h-36 space-y-0.5 overflow-y-auto pr-0.5">
                {filteredSelectOptions.map((opt) => {
                  const checked = selectedValuesSet.has(opt.id);
                  return (
                    <label
                      key={opt.id}
                      data-filter-select-option={opt.id}
                      className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs"
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleSelectableId(opt.id)} />
                      <span
                        className={cn(
                          "inline-flex max-w-[220px] items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
                          getViewOptionBadgeClass(opt.color),
                        )}
                      >
                        <span className="truncate">{opt.name}</span>
                      </span>
                    </label>
                  );
                })}
                {filteredSelectOptions.length === 0 && (
                  <div className="text-muted-foreground py-2 text-center text-[11px]">
                    {(customCol?.options ?? []).length === 0 ? t("sortFilter.noOptions") : t("noMatchingNodes")}
                  </div>
                )}
              </div>
            </div>
          )}

          {needsValue && kind === "relation" && (
            <div className="border-border/60 mt-1.5 border-t pt-1.5">
              <div className="relative mb-1.5 flex items-center">
                <input
                  type="text"
                  data-filter-relation-search={condition.id}
                  value={optionSearch}
                  onChange={(e) => setOptionSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t("sortFilter.selectPlaceholder")}
                  className="placeholder:text-muted-foreground h-7 w-full bg-transparent pr-6 pl-1 text-xs outline-none"
                />
                <Search className="text-muted-foreground pointer-events-none absolute right-1.5 size-3.5" />
              </div>
              <div className="max-h-36 space-y-0.5 overflow-y-auto pr-0.5">
                {filteredRelationCandidates.map((item) => {
                  const checked = selectedValuesSet.has(item.id);
                  return (
                    <label
                      key={item.id}
                      data-filter-relation-option={item.id}
                      className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs"
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleSelectableId(item.id)} />
                      <span className="min-w-0 flex-1 truncate" title={item.label}>
                        {item.label}
                      </span>
                    </label>
                  );
                })}
                {filteredRelationCandidates.length === 0 && (
                  <div className="text-muted-foreground py-2 text-center text-[11px]">{t("noMatchingNodes")}</div>
                )}
              </div>
            </div>
          )}

          {needsValue && kind === "date" && (
            <div className="mt-1.5">
              <Popover open={dateOpen} onOpenChange={setDateOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-filter-date-trigger={condition.id}
                    className="border-input bg-background hover:bg-accent/50 flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 text-xs transition-colors"
                  >
                    <span className={cn("truncate tabular-nums", !dateDisplayLabel && "text-muted-foreground")}>
                      {dateDisplayLabel || t("sortFilter.selectPlaceholder")}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {dateDisplayLabel && (
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label={t("dateCell.clear")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onUpdate(condition.id, { value: undefined, datePreset: undefined });
                          }}
                          className="text-muted-foreground hover:text-foreground rounded p-0.5"
                        >
                          <X className="size-3" />
                        </span>
                      )}
                      <ChevronDown className="text-muted-foreground size-3.5" />
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  sideOffset={4}
                  className="z-[60] w-auto p-2 text-xs select-none"
                  onWheel={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="mb-2 grid grid-cols-2 gap-1">
                    {TABLE_DATE_FILTER_PRESETS.map((preset) => {
                      const active = condition.datePreset === preset;
                      return (
                        <button
                          key={preset}
                          type="button"
                          data-filter-date-preset={preset}
                          onClick={() => {
                            onUpdate(condition.id, { datePreset: preset, value: undefined });
                            setDateOpen(false);
                          }}
                          className={cn(
                            "hover:bg-accent flex h-7 cursor-pointer items-center justify-between gap-1 rounded px-2 text-xs transition-colors",
                            active ? "bg-primary/15 text-primary font-medium" : "text-foreground/90",
                          )}
                        >
                          <span className="truncate">{getDatePresetLabel(preset, t)}</span>
                          {active && <Check className="text-primary size-3 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                  <div className="border-border/60 border-t pt-2">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <Input
                        data-filter-date-input={condition.id}
                        type="date"
                        value={condition.datePreset ? "" : (condition.value ?? "")}
                        onChange={(e) => {
                          const next = e.target.value.trim();
                          onUpdate(condition.id, { value: next || undefined, datePreset: undefined });
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="h-7 flex-1 text-xs tabular-nums"
                      />
                    </div>
                    <Calendar
                      mode="single"
                      month={calendarMonth}
                      onMonthChange={setCalendarMonth}
                      selected={selectedExactDate}
                      onSelect={(date) => {
                        if (date) {
                          onUpdate(condition.id, { value: toLocalDateKey(date), datePreset: undefined });
                          setDateOpen(false);
                        }
                      }}
                    />
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface StageTableFilterToolbarPopoverProps {
  /** 原始表中按从左到右顺序展示的列（未在原始表中展示的列不显示在筛选字段列表中） */
  filterableColumnIds: readonly string[];
  /** 原始表中的字段编组 */
  columnGroups: readonly TableColumnGroup[];
  customColumns: readonly TableColumnSchema[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  allRows: readonly StageTableRow[];
  activeFilters: readonly TableColumnFilter[];
  filterGroup: TableFilterGroup;
  getColumnLabel: (colId: string) => string;
  onSetConjunction: (conjunction: TableFilterConjunction) => void;
  onAddCondition: (columnId?: string) => void;
  onUpdateCondition: (conditionId: string, patch: Partial<Omit<TableFilterCondition, "id">>) => void;
  onRemoveCondition: (conditionId: string) => void;
  onToggleConditionCollapse: (conditionId: string) => void;
  onReorderConditions: (draggedId: string, targetId: string, position: "before" | "after") => void;
  onSetColumnFilter: (columnId: string, filter: { values: string[]; includeEmpty: boolean } | null) => void;
  onClearAllFilters: () => void;
  t: TranslateFn;
}

export function StageTableFilterToolbarPopover({
  filterableColumnIds,
  columnGroups,
  customColumns,
  customColumnMap,
  allRows,
  activeFilters,
  filterGroup,
  getColumnLabel,
  onSetConjunction,
  onAddCondition,
  onUpdateCondition,
  onRemoveCondition,
  onToggleConditionCollapse,
  onReorderConditions,
  onSetColumnFilter,
  onClearAllFilters,
  t,
}: StageTableFilterToolbarPopoverProps) {
  const [conjunctionOpen, setConjunctionOpen] = useState(false);
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [dragState, setDragState] = useState<{
    draggedId: string;
    targetId: string;
    position: "before" | "after";
  } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(filterGroup.conditions.length);

  const activeConditionCount = useMemo(
    () => countActiveFilterConditions(filterGroup, customColumns),
    [filterGroup, customColumns],
  );
  const totalActiveCount = activeConditionCount + activeFilters.length;
  const hasAnyEntries = filterGroup.conditions.length > 0 || activeFilters.length > 0;

  useEffect(() => {
    if (filterGroup.conditions.length > prevCountRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevCountRef.current = filterGroup.conditions.length;
  }, [filterGroup.conditions.length]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  const startConditionDrag = useCallback(
    (draggedId: string, e: React.PointerEvent) => {
      if (e.button !== 0 || filterGroup.conditions.length < 2) return;
      e.preventDefault();
      e.stopPropagation();

      dragCleanupRef.current?.();

      const startY = e.clientY;
      let active = false;
      let latestDrop: { targetId: string; position: "before" | "after" } | null = null;

      const computeDropTarget = (clientY: number): { targetId: string; position: "before" | "after" } | null => {
        const containerEl = listRef.current;
        if (!containerEl) return null;
        const cardEls = Array.from(containerEl.querySelectorAll<HTMLElement>("[data-filter-condition-card]"));
        if (cardEls.length < 2) return null;

        // 拖动靠近滚动容器上下边缘时自动轻柔滚动
        const listRect = containerEl.getBoundingClientRect();
        if (listRect.height > 0) {
          const edgeZone = 28;
          if (clientY < listRect.top + edgeZone) {
            containerEl.scrollTop -= 8;
          } else if (clientY > listRect.bottom - edgeZone) {
            containerEl.scrollTop += 8;
          }
        }

        const measured = cardEls
          .map((el) => ({
            id: el.dataset.filterConditionCard ?? "",
            rect: el.getBoundingClientRect(),
          }))
          .filter((item) => item.id.length > 0);
        if (measured.length === 0) return null;

        if (clientY <= measured[0].rect.top) {
          return { targetId: measured[0].id, position: "before" };
        }
        const last = measured[measured.length - 1];
        if (clientY >= last.rect.bottom) {
          return { targetId: last.id, position: "after" };
        }

        let best = measured[0];
        let bestDist = Number.POSITIVE_INFINITY;
        for (const item of measured) {
          if (clientY >= item.rect.top && clientY <= item.rect.bottom) {
            best = item;
            break;
          }
          const mid = (item.rect.top + item.rect.bottom) / 2;
          const dist = Math.abs(clientY - mid);
          if (dist < bestDist) {
            best = item;
            bestDist = dist;
          }
        }
        const mid = (best.rect.top + best.rect.bottom) / 2;
        return {
          targetId: best.id,
          position: clientY < mid ? "before" : "after",
        };
      };

      const handleMove = (ev: PointerEvent) => {
        if (!active && Math.abs(ev.clientY - startY) < 4) return;
        active = true;
        const drop = computeDropTarget(ev.clientY);
        latestDrop = drop;
        if (drop) {
          setDragState({ draggedId, targetId: drop.targetId, position: drop.position });
        }
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleEnd);
        window.removeEventListener("pointercancel", handleCancel);
        dragCleanupRef.current = null;
      };

      const handleEnd = () => {
        cleanup();
        setDragState(null);
        if (active && latestDrop && latestDrop.targetId !== draggedId) {
          onReorderConditions(draggedId, latestDrop.targetId, latestDrop.position);
        }
      };

      const handleCancel = () => {
        cleanup();
        setDragState(null);
      };

      dragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleEnd);
      window.addEventListener("pointercancel", handleCancel);
    },
    [filterGroup.conditions.length, onReorderConditions],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-stage-table-filter-toolbar
          className={cn(
            "hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors",
            totalActiveCount > 0
              ? "bg-primary/15 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Filter className="size-3.5" />
          <span>{totalActiveCount > 0 ? `${t("toolbar.filter")} ${totalActiveCount}` : t("toolbar.filter")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        data-stage-table-filter-popover
        className="flex max-h-[min(72vh,540px)] w-[364px] flex-col p-3 text-xs select-none"
        onWheel={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "Escape") e.stopPropagation();
        }}
      >
        {/* 标题栏（按要求不做右上角“仅你可见”） */}
        <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
          <span className="text-sm font-semibold">{t("sortFilter.filterTitle")}</span>
          {hasAnyEntries && (
            <button
              type="button"
              data-filter-clear-all
              onClick={onClearAllFilters}
              className="text-muted-foreground hover:text-primary cursor-pointer text-[11px] transition-colors hover:underline"
            >
              {t("sortFilter.clearAllFilters")}
            </button>
          )}
        </div>

        {/* 满足以下 全部条件 / 任一条件 */}
        <div className="text-muted-foreground mb-2.5 flex shrink-0 items-center gap-1 text-xs">
          <span>{t("sortFilter.matchPrefix")}</span>
          <Popover open={conjunctionOpen} onOpenChange={setConjunctionOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-filter-conjunction-trigger
                className="text-primary hover:bg-primary/10 inline-flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 font-medium transition-colors"
              >
                <span>
                  {filterGroup.conjunction === "or" ? t("sortFilter.conjunctionAny") : t("sortFilter.conjunctionAll")}
                </span>
                <ChevronDown className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={4}
              className="z-[60] w-32 p-1 text-xs select-none"
              onWheel={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {(["and", "or"] as const).map((mode) => {
                const active = filterGroup.conjunction === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    data-filter-conjunction-option={mode}
                    onClick={() => {
                      onSetConjunction(mode);
                      setConjunctionOpen(false);
                    }}
                    className={cn(
                      "hover:bg-accent flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
                      active && "bg-accent/50 font-medium",
                    )}
                  >
                    <span>{mode === "or" ? t("sortFilter.conjunctionAny") : t("sortFilter.conjunctionAll")}</span>
                    {active && <Check className="text-primary size-3.5 shrink-0" />}
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>
        </div>

        {/* 条件卡片列表（支持上下拖动排序） */}
        <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-0.5 py-0.5">
          {filterGroup.conditions.length === 0 ? (
            <div className="border-border/70 text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
              {t("sortFilter.noActiveFilters")}
            </div>
          ) : (
            filterGroup.conditions.map((cond) => {
              const isDragging = dragState?.draggedId === cond.id;
              const dropPosition =
                dragState && dragState.draggedId !== cond.id && dragState.targetId === cond.id
                  ? dragState.position
                  : null;
              return (
                <FilterConditionCard
                  key={cond.id}
                  condition={cond}
                  filterableColumnIds={filterableColumnIds}
                  columnGroups={columnGroups}
                  customColumnMap={customColumnMap}
                  allRows={allRows}
                  isDragging={isDragging}
                  dropPosition={dropPosition}
                  onStartDrag={startConditionDrag}
                  getColumnLabel={getColumnLabel}
                  onUpdate={onUpdateCondition}
                  onRemove={onRemoveCondition}
                  onToggleCollapse={onToggleConditionCollapse}
                  t={t}
                />
              );
            })
          )}
        </div>

        {/* 若存在表头快捷勾选筛选，底部补充展示便于一眼知晓与一键清除 */}
        {activeFilters.length > 0 && (
          <div className="border-border/60 mt-2.5 shrink-0 border-t pt-2">
            <div className="text-muted-foreground mb-1 text-[11px] font-medium">
              {t("sortFilter.columnQuickFilters")}
            </div>
            <div className="flex flex-wrap gap-1">
              {activeFilters.map((flt) => (
                <span
                  key={flt.columnId}
                  className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
                >
                  <span className="max-w-[120px] truncate">{getColumnLabel(flt.columnId)}</span>
                  <button
                    type="button"
                    aria-label={t("sortFilter.clearFilter")}
                    onClick={() => onSetColumnFilter(flt.columnId, null)}
                    className="hover:bg-primary/20 cursor-pointer rounded p-0.5"
                  >
                    <X className="size-2.5" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 底部：+ 添加筛选条件（点击弹出按原始表从左到右分组排序的「选择字段」面板） */}
        <div className="mt-2.5 shrink-0 pt-0.5">
          <Popover open={addFieldOpen} onOpenChange={setAddFieldOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-filter-add-condition
                className="border-border/80 bg-muted/35 text-foreground/90 hover:bg-accent inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors"
              >
                <Plus className="size-3.5" />
                <span>{t("sortFilter.addCondition")}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={4}
              data-filter-add-field-popover
              className="z-[60] w-56 p-1.5 text-xs select-none"
              onWheel={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <GroupedFieldPickerContent
                orderedColumnIds={filterableColumnIds}
                columnGroups={columnGroups}
                customColumnMap={customColumnMap}
                getColumnLabel={getColumnLabel}
                onSelect={(cid) => {
                  onAddCondition(cid);
                  setAddFieldOpen(false);
                }}
                t={t}
              />
            </PopoverContent>
          </Popover>
        </div>
      </PopoverContent>
    </Popover>
  );
}
