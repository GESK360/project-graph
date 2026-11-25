import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  StageTableAttachmentThumb,
  StageTableColumnIcon,
  StageTableFieldValueDisplay,
  StageTableFieldVisibilityList,
  StageTableFilterToolbarPopover,
  StageTableSortToolbarPopover,
  getRowDisplayTitle,
  getViewOptionBadgeClass,
} from "@/components/stage-table-views-shared";
import type { Project } from "@/core/Project";
import type { StageTableRow } from "@/core/service/dataManageService/stageTableService/StageTableService";
import type {
  TableColumnFilter,
  TableColumnSchema,
  TableFields,
  TableKanbanViewConfig,
  TableSortConfig,
  TableViewSchema,
} from "@/types/table";
import { cn } from "@/utils/cn";
import { Check, Crosshair, List, ListTree, Pencil, Plus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

const UNGROUPED_KEY = "__ungrouped__";

interface KanbanGroupColumn {
  key: string;
  label: string;
  color?: string;
  isUngrouped: boolean;
  rows: StageTableRow[];
}

export function StageTableKanbanView({
  project,
  activeView,
  allRows,
  rows,
  allColumnIds,
  visibleColumnIds,
  customColumns,
  customColumnMap,
  activeFilters,
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
  visibleColumnIds: readonly string[];
  customColumns: readonly TableColumnSchema[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  activeFilters: readonly TableColumnFilter[];
  activeSort: TableSortConfig | null;
  selectedRowIds: ReadonlySet<string>;
  getColumnLabel: (colId: string) => string;
  onSelectRows: (uuids: string[], focusCamera?: boolean) => void;
  onOpenRecord: (rowUuid: string) => void;
  onPreviewImage: (attachmentId: string, rowUuid?: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null);
  const [addingCardGroupKey, setAddingCardGroupKey] = useState<string | null>(null);
  const [addingCardTitle, setAddingCardTitle] = useState("");
  const [addingGroupOpen, setAddingGroupOpen] = useState(false);
  const [addingGroupName, setAddingGroupName] = useState("");

  const config: TableKanbanViewConfig = activeView.kanban ?? {};
  const showCover = config.showCover ?? false;
  const coverFit = config.coverFit ?? "cover";
  const showFieldNames = config.showFieldNames ?? true;
  const hideEmptyGroups = config.hideEmptyGroups ?? false;

  const groupableColumns = useMemo(() => {
    const list: Array<{ id: string; label: string; customCol?: TableColumnSchema }> = [];
    for (const col of customColumns) {
      if (col.type === "select" || col.type === "text") {
        list.push({ id: col.id, label: col.name, customCol: col });
      }
    }
    list.push({ id: "outer", label: getColumnLabel("outer") });
    return list;
  }, [customColumns, getColumnLabel]);

  const effectiveGroupById = useMemo(() => {
    const configured = config.groupByColumnId;
    if (configured) {
      if (configured === "outer") return "outer";
      const col = customColumnMap.get(configured);
      if (col && (col.type === "select" || col.type === "text")) return configured;
    }
    return null;
  }, [config.groupByColumnId, customColumnMap]);

  const groupByCol =
    effectiveGroupById && effectiveGroupById !== "outer" ? customColumnMap.get(effectiveGroupById) : undefined;

  const groups = useMemo<KanbanGroupColumn[]>(() => {
    if (!effectiveGroupById) {
      return [
        {
          key: UNGROUPED_KEY,
          label: t("kanban.ungrouped"),
          isUngrouped: true,
          rows: [...rows],
        },
      ];
    }

    if (effectiveGroupById === "outer") {
      const sectionBuckets = new Map<string, KanbanGroupColumn>();
      const ungrouped: StageTableRow[] = [];

      // 先将所有分组框加入列，支持拖拽节点进入空分组框
      for (const r of allRows) {
        if (r.kind === "section") {
          sectionBuckets.set(r.uuid, {
            key: r.uuid,
            label: getRowDisplayTitle(r, t).text,
            isUngrouped: false,
            rows: [],
          });
        }
      }

      for (const row of rows) {
        if (row.outer) {
          let bucket = sectionBuckets.get(row.outer.uuid);
          if (!bucket) {
            bucket = {
              key: row.outer.uuid,
              label: getRowDisplayTitle(row.outer, t).text,
              isUngrouped: false,
              rows: [],
            };
            sectionBuckets.set(row.outer.uuid, bucket);
          }
          bucket.rows.push(row);
        } else {
          ungrouped.push(row);
        }
      }

      const result: KanbanGroupColumn[] = [
        {
          key: UNGROUPED_KEY,
          label: t("kanban.ungrouped"),
          isUngrouped: true,
          rows: ungrouped,
        },
        ...Array.from(sectionBuckets.values()),
      ];
      return hideEmptyGroups ? result.filter((g) => g.rows.length > 0) : result;
    }

    if (groupByCol?.type === "select") {
      const optionBuckets = new Map<string, KanbanGroupColumn>();
      for (const opt of groupByCol.options ?? []) {
        optionBuckets.set(opt.id, {
          key: opt.id,
          label: opt.name,
          color: opt.color,
          isUngrouped: false,
          rows: [],
        });
      }
      const ungrouped: StageTableRow[] = [];
      for (const row of rows) {
        const raw = row.tableFields?.[groupByCol.id];
        const optId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
        const bucket = optId ? optionBuckets.get(optId) : undefined;
        if (bucket) {
          bucket.rows.push(row);
        } else {
          ungrouped.push(row);
        }
      }
      const result: KanbanGroupColumn[] = [
        {
          key: UNGROUPED_KEY,
          label: t("kanban.ungrouped"),
          isUngrouped: true,
          rows: ungrouped,
        },
        ...Array.from(optionBuckets.values()),
      ];
      return hideEmptyGroups ? result.filter((g) => g.rows.length > 0) : result;
    }

    if (groupByCol?.type === "text") {
      const textBuckets = new Map<string, KanbanGroupColumn>();
      const ungrouped: StageTableRow[] = [];
      for (const row of rows) {
        const raw = row.tableFields?.[groupByCol.id];
        const val = typeof raw === "string" ? raw.trim() : "";
        if (!val) {
          ungrouped.push(row);
          continue;
        }
        let bucket = textBuckets.get(val);
        if (!bucket) {
          bucket = {
            key: val,
            label: val,
            isUngrouped: false,
            rows: [],
          };
          textBuckets.set(val, bucket);
        }
        bucket.rows.push(row);
      }
      const result: KanbanGroupColumn[] = [
        {
          key: UNGROUPED_KEY,
          label: t("kanban.ungrouped"),
          isUngrouped: true,
          rows: ungrouped,
        },
        ...Array.from(textBuckets.values()),
      ];
      return hideEmptyGroups ? result.filter((g) => g.rows.length > 0) : result;
    }

    return [
      {
        key: UNGROUPED_KEY,
        label: t("kanban.ungrouped"),
        isUngrouped: true,
        rows: [...rows],
      },
    ];
  }, [effectiveGroupById, groupByCol, rows, allRows, hideEmptyGroups, t]);

  const cardFieldIds = useMemo(
    () =>
      visibleColumnIds.filter((cid) => {
        if (cid === "name") return false;
        if (cid === effectiveGroupById) return false;
        if (showCover && cid === "images") return false;
        return true;
      }),
    [visibleColumnIds, effectiveGroupById, showCover],
  );

  const handleMoveCardToGroup = (rowUuid: string, targetGroupKey: string) => {
    if (!effectiveGroupById) return;
    if (effectiveGroupById === "outer") {
      project.stageTable.setRowOuter(rowUuid, targetGroupKey === UNGROUPED_KEY ? null : targetGroupKey);
      return;
    }
    if (groupByCol?.type === "select" || groupByCol?.type === "text") {
      project.stageTable.updateRowCustomField(
        rowUuid,
        groupByCol.id,
        targetGroupKey === UNGROUPED_KEY ? null : targetGroupKey,
      );
    }
  };

  const handleCreateCardInGroup = (groupKey: string) => {
    const title = addingCardTitle.trim();
    const tableFields: TableFields = {};
    let outerSectionUuid: string | null = null;
    if (groupKey !== UNGROUPED_KEY) {
      if (effectiveGroupById === "outer") {
        outerSectionUuid = groupKey;
      } else if (groupByCol && (groupByCol.type === "select" || groupByCol.type === "text")) {
        tableFields[groupByCol.id] = groupKey;
      }
    }
    const created = project.stageTable.createRow?.({
      text: title,
      tableFields,
      outerSectionUuid,
    });
    setAddingCardTitle("");
    setAddingCardGroupKey(null);
    if (created) {
      onSelectRows([created.uuid], false);
    }
  };

  const handleCreateNewGroup = () => {
    const cleanName = addingGroupName.trim();
    if (!cleanName) {
      setAddingGroupOpen(false);
      return;
    }
    if (groupByCol?.type === "select") {
      project.stageTable.createOrGetSelectOption?.(groupByCol.id, cleanName);
    } else if (!effectiveGroupById) {
      // 尚未选择分组字段时，自动创建一个单选字段并添加该分组选项
      const newCol = project.stageTable.addCustomColumn?.({
        name: t("kanban.defaultGroupColumnName"),
        type: "select",
      });
      if (newCol) {
        project.stageTable.createOrGetSelectOption?.(newCol.id, cleanName);
        project.stageTable.updateActiveViewConfig?.({
          kanban: { groupByColumnId: newCol.id },
        });
      }
    }
    setAddingGroupName("");
    setAddingGroupOpen(false);
  };

  const handleQuickCreateSelectColumn = () => {
    const newCol = project.stageTable.addCustomColumn?.({
      name: t("kanban.defaultGroupColumnName"),
      type: "select",
    });
    if (newCol) {
      project.stageTable.createOrGetSelectOption?.(newCol.id, t("kanban.sampleOptionTodo"));
      project.stageTable.createOrGetSelectOption?.(newCol.id, t("kanban.sampleOptionDoing"));
      project.stageTable.createOrGetSelectOption?.(newCol.id, t("kanban.sampleOptionDone"));
      project.stageTable.updateActiveViewConfig?.({
        kanban: { groupByColumnId: newCol.id },
      });
    }
  };

  const canAddGroupColumn = !effectiveGroupById || groupByCol?.type === "select";

  return (
    <div data-stage-table-kanban-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 看板第二行功能栏 */}
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 text-xs [scrollbar-width:none]">
        {/* 看板设置 */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-kanban-settings-trigger
              className="text-foreground hover:bg-accent data-[state=open]:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
            >
              <List className="size-3.5" />
              <span>{t("kanban.settings")}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-64 space-y-3 p-3 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="space-y-2">
              <div className="text-muted-foreground text-[11px] font-medium">{t("kanban.displayOptions")}</div>
              <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1">
                <Checkbox
                  checked={showFieldNames}
                  onCheckedChange={(val) =>
                    project.stageTable.updateActiveViewConfig?.({ kanban: { showFieldNames: Boolean(val) } })
                  }
                />
                <span>{t("views.showFieldNames")}</span>
              </label>
              <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1">
                <Checkbox
                  checked={showCover}
                  onCheckedChange={(val) =>
                    project.stageTable.updateActiveViewConfig?.({ kanban: { showCover: Boolean(val) } })
                  }
                />
                <span>{t("kanban.showCover")}</span>
              </label>
              {showCover && (
                <div className="flex items-center justify-between gap-2 px-1.5">
                  <span className="text-muted-foreground text-[11px]">{t("gallery.coverFit")}</span>
                  <div className="bg-muted flex rounded-md p-0.5">
                    {(["cover", "contain"] as const).map((fit) => (
                      <button
                        key={fit}
                        type="button"
                        onClick={() => project.stageTable.updateActiveViewConfig?.({ kanban: { coverFit: fit } })}
                        className={cn(
                          "cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors",
                          coverFit === fit
                            ? "bg-background text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {t(`gallery.fit_${fit}`)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1">
                <Checkbox
                  checked={hideEmptyGroups}
                  onCheckedChange={(val) =>
                    project.stageTable.updateActiveViewConfig?.({ kanban: { hideEmptyGroups: Boolean(val) } })
                  }
                />
                <span>{t("kanban.hideEmptyGroups")}</span>
              </label>
            </div>

            <div className="border-border/60 border-t pt-2.5">
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

        {/* 分组依据 */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-kanban-groupby-trigger
              className={cn(
                "hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors",
                effectiveGroupById
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ListTree className="size-3.5" />
              <span>
                {effectiveGroupById
                  ? `${t("kanban.groupBy")}: ${getColumnLabel(effectiveGroupById)}`
                  : t("kanban.groupBy")}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-60 p-2 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-muted-foreground mb-1.5 px-1 text-[11px] font-medium">
              {t("kanban.selectGroupField")}
            </div>
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              <button
                type="button"
                onClick={() => project.stageTable.updateActiveViewConfig?.({ kanban: { groupByColumnId: null } })}
                className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-left"
              >
                <span className="text-muted-foreground">{t("kanban.noGrouping")}</span>
                {effectiveGroupById === null && <Check className="text-primary size-3.5" />}
              </button>
              {groupableColumns.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => project.stageTable.updateActiveViewConfig?.({ kanban: { groupByColumnId: item.id } })}
                  className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left"
                >
                  <StageTableColumnIcon columnId={item.id} customColumn={item.customCol} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {effectiveGroupById === item.id && <Check className="text-primary size-3.5 shrink-0" />}
                </button>
              ))}
            </div>
            <div className="border-border/60 mt-2 border-t pt-1.5">
              <button
                type="button"
                onClick={handleQuickCreateSelectColumn}
                className="hover:bg-accent text-primary flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-left font-medium"
              >
                <Plus className="size-3.5" />
                <span>{t("kanban.createSelectGroupField")}</span>
              </button>
            </div>
          </PopoverContent>
        </Popover>

        <StageTableFilterToolbarPopover
          allColumnIds={allColumnIds}
          customColumnMap={customColumnMap}
          allRows={allRows}
          activeFilters={activeFilters}
          getColumnLabel={getColumnLabel}
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
      </div>

      {/* 看板列主体 */}
      <div
        ref={boardRef}
        onWheel={(e) => {
          if (e.shiftKey && boardRef.current) {
            boardRef.current.scrollLeft += e.deltaY;
            e.preventDefault();
          }
        }}
        className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto overflow-y-hidden p-3"
      >
        {groups.map((group) => {
          const isDropTarget = dragOverGroupKey === group.key && draggingRowId !== null;
          return (
            <div
              key={group.key}
              data-kanban-group={group.key}
              onDragOver={(e) => {
                if (!effectiveGroupById || !draggingRowId) return;
                e.preventDefault();
                if (dragOverGroupKey !== group.key) {
                  setDragOverGroupKey(group.key);
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDragOverGroupKey((prev) => (prev === group.key ? null : prev));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const droppedRowId = e.dataTransfer.getData("text/plain") || draggingRowId;
                setDragOverGroupKey(null);
                setDraggingRowId(null);
                if (droppedRowId) {
                  handleMoveCardToGroup(droppedRowId, group.key);
                }
              }}
              className={cn(
                "flex h-full max-h-full w-72 shrink-0 flex-col rounded-xl p-1.5 transition-colors",
                isDropTarget ? "bg-primary/10 ring-primary/50 ring-2" : "bg-muted/20",
              )}
            >
              {/* 分组标题行 */}
              <div className="mb-2 flex shrink-0 items-center gap-2 px-1.5 py-1 select-none">
                {group.isUngrouped ? (
                  <span className="text-foreground text-xs font-semibold">{group.label}</span>
                ) : group.color ? (
                  <span
                    className={cn(
                      "inline-flex max-w-44 truncate rounded px-2 py-0.5 text-xs font-medium",
                      getViewOptionBadgeClass(group.color),
                    )}
                  >
                    {group.label}
                  </span>
                ) : (
                  <span className="bg-muted text-foreground inline-flex max-w-44 truncate rounded px-2 py-0.5 text-xs font-medium">
                    {group.label}
                  </span>
                )}
                <span className="text-muted-foreground text-xs tabular-nums">
                  {t("kanban.itemCount", { count: group.rows.length })}
                </span>
              </div>

              {/* 卡片列表（卡片必须 shrink-0，防止大量记录时被 flex 压缩成细线） */}
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-0.5 pb-1">
                {group.rows.map((row) => {
                  const titleInfo = getRowDisplayTitle(row, t);
                  const isSelected = selectedRowIds.has(row.uuid);
                  const coverImage = showCover && row.images.length > 0 ? row.images[0] : null;

                  return (
                    <div
                      key={row.uuid}
                      data-kanban-card={row.uuid}
                      draggable={Boolean(effectiveGroupById)}
                      onDragStart={(e) => {
                        setDraggingRowId(row.uuid);
                        e.dataTransfer.setData("text/plain", row.uuid);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDraggingRowId(null);
                        setDragOverGroupKey(null);
                      }}
                      onClick={(e) => {
                        if (e.ctrlKey || e.metaKey) {
                          const next = new Set(selectedRowIds);
                          if (next.has(row.uuid)) next.delete(row.uuid);
                          else next.add(row.uuid);
                          onSelectRows(Array.from(next));
                        } else {
                          onSelectRows([row.uuid]);
                        }
                      }}
                      onDoubleClick={() => onOpenRecord(row.uuid)}
                      className={cn(
                        "group/kcard bg-card border-border/70 hover:border-primary/50 relative shrink-0 cursor-pointer overflow-hidden rounded-lg border transition-all select-none",
                        isSelected && "border-primary ring-primary/35 ring-2",
                        draggingRowId === row.uuid && "opacity-50",
                      )}
                    >
                      {coverImage && (
                        <div className="bg-muted/40 border-border/40 relative h-28 w-full overflow-hidden border-b">
                          <StageTableAttachmentThumb
                            project={project}
                            attachmentId={coverImage.attachmentId}
                            className={cn(
                              "size-full rounded-none border-0",
                              coverFit === "contain" ? "object-contain" : "object-cover",
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              onPreviewImage(coverImage.attachmentId, row.uuid);
                            }}
                          />
                        </div>
                      )}

                      {/* 悬浮快捷操作 */}
                      <div className="bg-background/85 border-border/60 absolute top-1.5 right-1.5 z-10 flex items-center gap-0.5 rounded-md border p-0.5 opacity-0 shadow-xs backdrop-blur-xs transition-opacity group-hover/kcard:opacity-100">
                        <button
                          type="button"
                          title={t("jumpToNode")}
                          onClick={(e) => {
                            e.stopPropagation();
                            project.stageTable.focusRowOnCanvas(row.uuid);
                          }}
                          className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-5 cursor-pointer items-center justify-center rounded"
                        >
                          <Crosshair className="size-3" />
                        </button>
                        <button
                          type="button"
                          title={t("views.editRecord")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenRecord(row.uuid);
                          }}
                          className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-5 cursor-pointer items-center justify-center rounded"
                        >
                          <Pencil className="size-3" />
                        </button>
                      </div>

                      <div className="space-y-2 p-3">
                        <div
                          className={cn(
                            "pr-10 text-sm leading-snug font-medium break-words",
                            titleInfo.isPlaceholder && "text-muted-foreground/60 font-normal",
                          )}
                        >
                          {titleInfo.text}
                        </div>

                        {cardFieldIds.map((cid) => {
                          const customCol = customColumnMap.get(cid);
                          const valNode = (
                            <StageTableFieldValueDisplay
                              project={project}
                              row={row}
                              columnId={cid}
                              customCol={customCol}
                              onPreviewImage={onPreviewImage}
                              compact
                              t={t}
                            />
                          );
                          // 检查是否有实际非空内容
                          const hasContent = (() => {
                            if (cid === "images") return row.images.length > 0;
                            if (cid === "createdAt") return row.createdAt > 0;
                            if (cid === "updatedAt") return row.updatedAt > 0;
                            if (cid === "parents") return row.parents.length > 0;
                            if (cid === "children") return row.children.length > 0;
                            if (cid === "outer") return row.outer !== null;
                            if (cid === "inner") return row.inner.length > 0;
                            if (!customCol) return false;
                            if (customCol.type === "formula") {
                              const cell = row.formulaValues?.[customCol.id];
                              return Boolean(cell && cell.kind !== "empty");
                            }
                            const raw = row.tableFields?.[customCol.id];
                            if (raw === null || raw === undefined || raw === "") return false;
                            if (Array.isArray(raw)) return raw.length > 0;
                            return true;
                          })();
                          if (!hasContent) return null;
                          return (
                            <div key={cid} className="space-y-0.5">
                              {showFieldNames && (
                                <div className="text-muted-foreground truncate text-[11px]">{getColumnLabel(cid)}</div>
                              )}
                              <div>{valNode}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* 添加卡片 */}
                {addingCardGroupKey === group.key ? (
                  <div className="bg-card border-primary/60 shrink-0 space-y-2 rounded-lg border p-2 shadow-xs">
                    <Input
                      autoFocus
                      data-kanban-add-card-input
                      value={addingCardTitle}
                      onChange={(e) => setAddingCardTitle(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleCreateCardInGroup(group.key);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setAddingCardGroupKey(null);
                          setAddingCardTitle("");
                        }
                      }}
                      placeholder={t("kanban.cardTitlePlaceholder")}
                      className="h-7 text-xs"
                    />
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAddingCardGroupKey(null);
                          setAddingCardTitle("");
                        }}
                        className="h-6 px-2 text-xs"
                      >
                        {t("fieldDialog.cancel")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => handleCreateCardInGroup(group.key)}
                        className="h-6 px-2.5 text-xs"
                      >
                        {t("kanban.addCardConfirm")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-kanban-add-card-btn={group.key}
                    onClick={() => {
                      setAddingCardGroupKey(group.key);
                      setAddingCardTitle("");
                    }}
                    className="border-border/60 text-muted-foreground hover:border-border hover:bg-card/80 hover:text-foreground flex h-9 w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors"
                  >
                    <Plus className="size-3.5" />
                    <span>{t("kanban.addCard")}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* 最右侧：+ 新建分组 */}
        {canAddGroupColumn && (
          <div className="w-60 shrink-0 pt-1">
            {addingGroupOpen ? (
              <div className="bg-card border-primary/60 space-y-2 rounded-xl border p-2.5 shadow-xs">
                <Input
                  autoFocus
                  data-kanban-add-group-input
                  value={addingGroupName}
                  onChange={(e) => setAddingGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreateNewGroup();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setAddingGroupOpen(false);
                      setAddingGroupName("");
                    }
                  }}
                  placeholder={t("kanban.groupNamePlaceholder")}
                  className="h-7 text-xs"
                />
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setAddingGroupOpen(false);
                      setAddingGroupName("");
                    }}
                    className="text-muted-foreground hover:bg-accent flex size-6 cursor-pointer items-center justify-center rounded"
                  >
                    <X className="size-3.5" />
                  </button>
                  <Button type="button" size="sm" onClick={handleCreateNewGroup} className="h-6 px-2.5 text-xs">
                    {t("fieldDialog.confirm")}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                data-kanban-add-group-btn
                onClick={() => {
                  setAddingGroupOpen(true);
                  setAddingGroupName("");
                }}
                className="text-muted-foreground hover:bg-accent/70 hover:text-foreground inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors"
              >
                <Plus className="size-3.5" />
                <span>{t("kanban.addGroup")}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
