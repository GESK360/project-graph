import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StageTableFilterToolbarPopover } from "@/components/stage-table-filter-popover";
import {
  StageTableAttachmentThumb,
  StageTableColumnIcon,
  StageTableFieldValueDisplay,
  StageTableFieldVisibilityList,
  StageTableSortToolbarPopover,
  getRowDisplayTitle,
  getViewOptionBadgeClass,
} from "@/components/stage-table-views-shared";
import type { Project } from "@/core/Project";
import type { StageTableRow } from "@/core/service/dataManageService/stageTableService/StageTableService";
import type { TableDataSource } from "@/core/service/dataManageService/stageTableService/TableDataSource";
import type {
  TableColumnFilter,
  TableColumnGroup,
  TableColumnSchema,
  TableFields,
  TableFilterGroup,
  TableKanbanViewConfig,
  TableSortConfig,
  TableViewSchema,
} from "@/types/table";
import { cn } from "@/utils/cn";
import { canUseVirtualMeasureElement, createSafeObserveElementRect } from "@/components/stage-table-scroll-container";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Crosshair, FileText, List, ListTree, Pencil, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const UNGROUPED_KEY = "__ungrouped__";
const KANBAN_VIRTUALIZE_THRESHOLD = 80;
const OBSERVE_KANBAN_RECT = createSafeObserveElementRect({ width: 270, height: 600 });

interface KanbanGroupColumn {
  key: string;
  label: string;
  color?: string;
  isUngrouped: boolean;
  rows: StageTableRow[];
}

function KanbanColumnCardList({
  project,
  dataSource,
  group,
  effectiveGroupById,
  canDragCards,
  cardFieldIds,
  customColumnMap,
  selectedRowIds,
  draggingRowId,
  showCover,
  coverFit,
  showFieldNames,
  addingCardGroupKey,
  addingCardTitle,
  getColumnLabel,
  onSetDraggingRowId,
  onSetDragOverGroupKey,
  onSelectRows,
  onOpenRecord,
  onPreviewImage,
  onSetAddingCardGroupKey,
  onSetAddingCardTitle,
  onCreateCardInGroup,
  t,
}: {
  project?: Project | null;
  dataSource: TableDataSource;
  group: KanbanGroupColumn;
  effectiveGroupById: string | null;
  canDragCards: boolean;
  cardFieldIds: readonly string[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  selectedRowIds: ReadonlySet<string>;
  draggingRowId: string | null;
  showCover: boolean;
  coverFit: "cover" | "contain";
  showFieldNames: boolean;
  addingCardGroupKey: string | null;
  addingCardTitle: string;
  getColumnLabel: (colId: string) => string;
  onSetDraggingRowId: (id: string | null) => void;
  onSetDragOverGroupKey: (key: string | null) => void;
  onSelectRows: (uuids: string[], focusCamera?: boolean) => void;
  onOpenRecord: (rowUuid: string, row?: StageTableRow) => void;
  onPreviewImage: (attachmentId: string, rowUuid?: string, docId?: string) => void;
  onSetAddingCardGroupKey: (key: string | null) => void;
  onSetAddingCardTitle: (title: string) => void;
  onCreateCardInGroup: (groupKey: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = group.rows.length > KANBAN_VIRTUALIZE_THRESHOLD;
  const allowMeasure = canUseVirtualMeasureElement();

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? group.rows.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => (showCover ? 220 : 112),
    gap: 8,
    overscan: 6,
    initialRect: { width: 270, height: 600 },
    observeElementRect: OBSERVE_KANBAN_RECT,
    measureElement: (el, _entry, instance) => {
      const h = el.getBoundingClientRect().height;
      return h > 0 ? h : instance.options.estimateSize(Number(el.getAttribute("data-index") ?? 0));
    },
  });

  useEffect(() => {
    if (shouldVirtualize) {
      rowVirtualizer.measure();
    }
  }, [shouldVirtualize, showCover, showFieldNames, cardFieldIds, rowVirtualizer]);

  const virtualItems = shouldVirtualize ? rowVirtualizer.getVirtualItems() : [];

  const renderCard = (row: StageTableRow) => {
    const titleInfo = getRowDisplayTitle(row, t);
    const isSelected = selectedRowIds.has(row.uuid);
    const coverImage = showCover && row.images.length > 0 ? row.images[0] : null;

    return (
      <div
        key={row.docId ? `${row.docId}:${row.uuid}` : row.uuid}
        data-kanban-card={row.uuid}
        draggable={canDragCards && Boolean(effectiveGroupById)}
        onDragStart={(e) => {
          onSetDraggingRowId(row.uuid);
          e.dataTransfer.setData("text/plain", row.uuid);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          onSetDraggingRowId(null);
          onSetDragOverGroupKey(null);
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
        onDoubleClick={() => onOpenRecord(row.uuid, row)}
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
              dataSource={dataSource}
              docId={row.docId}
              attachmentId={coverImage.attachmentId}
              className={cn(
                "size-full rounded-none border-0",
                coverFit === "contain" ? "object-contain" : "object-cover",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onPreviewImage(coverImage.attachmentId, row.uuid, row.docId);
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
              dataSource.jumpToNode(row.docId ?? dataSource.getDocId(), row.uuid);
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
              onOpenRecord(row.uuid, row);
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

          {row.sourceFile && effectiveGroupById !== "sourceFile" && !cardFieldIds.includes("sourceFile") && (
            <button
              type="button"
              title={row.sourceRelPath || row.sourceFile}
              onClick={(e) => {
                e.stopPropagation();
                dataSource.jumpToNode(row.docId ?? dataSource.getDocId(), row.uuid);
              }}
              className="text-muted-foreground hover:text-foreground inline-flex max-w-full cursor-pointer items-center gap-1 text-[10px]"
            >
              <FileText className="size-2.5 shrink-0" />
              <span className="truncate">{row.sourceFile}</span>
            </button>
          )}

          {cardFieldIds.map((cid) => {
            const customCol = customColumnMap.get(cid);
            const valNode = (
              <StageTableFieldValueDisplay
                project={project}
                dataSource={dataSource}
                row={row}
                columnId={cid}
                customCol={customCol}
                onPreviewImage={onPreviewImage}
                compact
                t={t}
              />
            );
            const hasContent = (() => {
              if (cid === "sourceFile") return Boolean(row.sourceFile);
              if (cid === "sourceFolder") return Boolean(row.sourceFolder || row.sourceFile);
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
  };

  return (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-1">
      {shouldVirtualize ? (
        <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualItems.map((vItem) => {
            const row = group.rows[vItem.index];
            if (!row) return null;
            return (
              <div
                key={row.uuid}
                data-index={vItem.index}
                ref={allowMeasure ? rowVirtualizer.measureElement : undefined}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vItem.start}px)`,
                }}
              >
                {renderCard(row)}
              </div>
            );
          })}
        </div>
      ) : group.rows.length > 0 ? (
        <div className="flex flex-col gap-2">{group.rows.map((row) => renderCard(row))}</div>
      ) : null}

      {/* 添加卡片 */}
      <div className={cn(group.rows.length > 0 && "mt-2")}>
        {addingCardGroupKey === group.key ? (
          <div className="bg-card border-primary/60 shrink-0 space-y-2 rounded-lg border p-2 shadow-xs">
            <Input
              autoFocus
              data-kanban-add-card-input
              value={addingCardTitle}
              onChange={(e) => onSetAddingCardTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  onCreateCardInGroup(group.key);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onSetAddingCardGroupKey(null);
                  onSetAddingCardTitle("");
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
                  onSetAddingCardGroupKey(null);
                  onSetAddingCardTitle("");
                }}
                className="h-6 px-2 text-xs"
              >
                {t("fieldDialog.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => onCreateCardInGroup(group.key)}
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
              onSetAddingCardGroupKey(group.key);
              onSetAddingCardTitle("");
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
}

export function StageTableKanbanView({
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
  const boardRef = useRef<HTMLDivElement>(null);
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null);
  const [addingCardGroupKey, setAddingCardGroupKey] = useState<string | null>(null);
  const [addingCardTitle, setAddingCardTitle] = useState("");
  const [addingGroupOpen, setAddingGroupOpen] = useState(false);
  const [addingGroupName, setAddingGroupName] = useState("");
  const isWorkspaceMode = dataSource.scopeKind === "workspace";
  const [wsRows, setWsRows] = useState<StageTableRow[]>([]);

  useEffect(() => {
    if (!isWorkspaceMode) return;
    let cancelled = false;
    void dataSource
      .queryPage({
        offset: 0,
        limit: 1000,
        filters: activeFilters,
        filterGroup: activeFilterGroup,
        sort: activeSort,
      })
      .then((res) => {
        if (!cancelled) setWsRows(res.rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isWorkspaceMode, dataSource, dataRevision, activeFilters, activeFilterGroup, activeSort]);

  const effectiveRows = isWorkspaceMode ? wsRows : rows;
  const effectiveAllRows = isWorkspaceMode ? wsRows : allRows;

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
    if (isWorkspaceMode) {
      list.push({ id: "sourceFile", label: getColumnLabel("sourceFile") });
      list.push({ id: "sourceFolder", label: getColumnLabel("sourceFolder") });
    }
    list.push({ id: "outer", label: getColumnLabel("outer") });
    return list;
  }, [customColumns, isWorkspaceMode, getColumnLabel]);

  const effectiveGroupById = useMemo(() => {
    const configured = config.groupByColumnId;
    if (configured) {
      if (configured === "outer") return "outer";
      if (isWorkspaceMode && (configured === "sourceFile" || configured === "sourceFolder")) return configured;
      const col = customColumnMap.get(configured);
      if (col && (col.type === "select" || col.type === "text")) return configured;
    }
    return null;
  }, [config.groupByColumnId, customColumnMap, isWorkspaceMode]);

  const isSourceGroupBy = effectiveGroupById === "sourceFile" || effectiveGroupById === "sourceFolder";
  const groupByCol =
    effectiveGroupById && effectiveGroupById !== "outer" && !isSourceGroupBy
      ? customColumnMap.get(effectiveGroupById)
      : undefined;

  const [sqliteGroupCounts, setSqliteGroupCounts] = useState<ReadonlyMap<string, number> | null>(null);
  useEffect(() => {
    if (!effectiveGroupById || !dataSource.isSqliteBacked()) {
      setSqliteGroupCounts(null);
      return;
    }
    let cancelled = false;
    void dataSource
      .queryGroupCounts({
        groupByColumnId: effectiveGroupById,
        filters: activeFilters,
        filterGroup: activeFilterGroup,
      })
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, number>();
        map.set(UNGROUPED_KEY, res.ungroupedCount);
        for (const g of res.groups) {
          map.set(g.key, g.count);
        }
        setSqliteGroupCounts(map);
      })
      .catch(() => {
        if (!cancelled) setSqliteGroupCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, dataRevision, effectiveGroupById, activeFilters, activeFilterGroup, rows]);

  const groups = useMemo<KanbanGroupColumn[]>(() => {
    if (!effectiveGroupById) {
      return [
        {
          key: UNGROUPED_KEY,
          label: t("kanban.ungrouped"),
          isUngrouped: true,
          rows: [...effectiveRows],
        },
      ];
    }

    if (effectiveGroupById === "sourceFile" || effectiveGroupById === "sourceFolder") {
      const buckets = new Map<string, KanbanGroupColumn>();
      for (const row of effectiveRows) {
        const key =
          effectiveGroupById === "sourceFile"
            ? row.sourceRelPath || row.sourceFile || UNGROUPED_KEY
            : row.sourceFolder || "/";
        const label =
          effectiveGroupById === "sourceFile" ? row.sourceFile || t("kanban.ungrouped") : row.sourceFolder || "/";
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { key, label, isUngrouped: key === UNGROUPED_KEY, rows: [] };
          buckets.set(key, bucket);
        }
        bucket.rows.push(row);
      }
      const list = Array.from(buckets.values());
      return hideEmptyGroups ? list.filter((g) => g.rows.length > 0) : list;
    }

    if (effectiveGroupById === "outer") {
      const sectionBuckets = new Map<string, KanbanGroupColumn>();
      const ungrouped: StageTableRow[] = [];

      // 先将所有分组框加入列，支持拖拽节点进入空分组框
      for (const r of effectiveAllRows) {
        if (r.kind === "section") {
          sectionBuckets.set(r.uuid, {
            key: r.uuid,
            label: getRowDisplayTitle(r, t).text,
            isUngrouped: false,
            rows: [],
          });
        }
      }

      for (const row of effectiveRows) {
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
      for (const row of effectiveRows) {
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
      for (const row of effectiveRows) {
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
        rows: [...effectiveRows],
      },
    ];
  }, [effectiveGroupById, groupByCol, effectiveRows, effectiveAllRows, hideEmptyGroups, t]);

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
    if (!effectiveGroupById || isSourceGroupBy) return;
    const row = effectiveRows.find((r) => r.uuid === rowUuid);
    if (effectiveGroupById === "outer") {
      void dataSource.setRowOuter(rowUuid, targetGroupKey === UNGROUPED_KEY ? null : targetGroupKey, row?.docId);
      return;
    }
    if (groupByCol?.type === "select" || groupByCol?.type === "text") {
      void dataSource.updateRowCustomField(
        rowUuid,
        groupByCol.id,
        targetGroupKey === UNGROUPED_KEY ? null : targetGroupKey,
        row?.docId,
      );
    }
  };

  const handleCreateCardInGroup = (groupKey: string) => {
    const title = addingCardTitle.trim();
    const tableFields: TableFields = {};
    let outerSectionUuid: string | null = null;
    let targetDocId: string | null | undefined;
    if (groupKey !== UNGROUPED_KEY) {
      if (effectiveGroupById === "outer") {
        outerSectionUuid = groupKey;
      } else if (effectiveGroupById === "sourceFile") {
        const matched = dataSource.getWorkspaceDocs?.().find((d) => d.relPath === groupKey || d.title === groupKey);
        if (matched) targetDocId = matched.docId;
      } else if (groupByCol && (groupByCol.type === "select" || groupByCol.type === "text")) {
        tableFields[groupByCol.id] = groupKey;
      }
    }
    setAddingCardTitle("");
    setAddingCardGroupKey(null);
    void Promise.resolve(
      dataSource.createRow({
        docId: targetDocId,
        text: title,
        tableFields,
        outerSectionUuid,
      }),
    ).then((created) => {
      if (created) {
        onSelectRows([created.uuid], false);
      }
    });
  };

  const handleCreateNewGroup = () => {
    const cleanName = addingGroupName.trim();
    if (!cleanName) {
      setAddingGroupOpen(false);
      return;
    }
    if (groupByCol?.type === "select") {
      dataSource.createOrGetSelectOption(groupByCol.id, cleanName);
    } else if (!effectiveGroupById) {
      const newCol = dataSource.addCustomColumn({
        name: t("kanban.defaultGroupColumnName"),
        type: "select",
      });
      if (newCol) {
        dataSource.createOrGetSelectOption(newCol.id, cleanName);
        dataSource.updateActiveViewConfig({
          kanban: { groupByColumnId: newCol.id },
        });
      }
    }
    setAddingGroupName("");
    setAddingGroupOpen(false);
  };

  const handleQuickCreateSelectColumn = () => {
    const newCol = dataSource.addCustomColumn({
      name: t("kanban.defaultGroupColumnName"),
      type: "select",
    });
    if (newCol) {
      dataSource.createOrGetSelectOption(newCol.id, t("kanban.sampleOptionTodo"));
      dataSource.createOrGetSelectOption(newCol.id, t("kanban.sampleOptionDoing"));
      dataSource.createOrGetSelectOption(newCol.id, t("kanban.sampleOptionDone"));
      dataSource.updateActiveViewConfig({
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
                    dataSource.updateActiveViewConfig({ kanban: { showFieldNames: Boolean(val) } })
                  }
                />
                <span>{t("views.showFieldNames")}</span>
              </label>
              <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1">
                <Checkbox
                  checked={showCover}
                  onCheckedChange={(val) => dataSource.updateActiveViewConfig({ kanban: { showCover: Boolean(val) } })}
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
                        onClick={() => dataSource.updateActiveViewConfig({ kanban: { coverFit: fit } })}
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
                    dataSource.updateActiveViewConfig({ kanban: { hideEmptyGroups: Boolean(val) } })
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
                isColumnVisible={(cid) => dataSource.isColumnVisible(cid)}
                onToggleColumn={(cid, visible) => dataSource.setColumnVisible(cid, visible)}
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
                onClick={() => dataSource.updateActiveViewConfig({ kanban: { groupByColumnId: null } })}
                className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-left"
              >
                <span className="text-muted-foreground">{t("kanban.noGrouping")}</span>
                {effectiveGroupById === null && <Check className="text-primary size-3.5" />}
              </button>
              {groupableColumns.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => dataSource.updateActiveViewConfig({ kanban: { groupByColumnId: item.id } })}
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
          filterableColumnIds={filterableColumnIds}
          columnGroups={filterColumnGroups}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          allRows={effectiveAllRows}
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

        <StageTableSortToolbarPopover
          allColumnIds={allColumnIds}
          customColumnMap={customColumnMap}
          activeSort={activeSort}
          getColumnLabel={getColumnLabel}
          onSetSort={(sort) => dataSource.setSort(sort)}
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
                  {t("kanban.itemCount", { count: sqliteGroupCounts?.get(group.key) ?? group.rows.length })}
                </span>
              </div>

              {/* 虚拟化卡片列表（单列独立虚拟滚动，避免大量卡片时 DOM 膨胀） */}
              <KanbanColumnCardList
                project={project}
                dataSource={dataSource}
                group={group}
                effectiveGroupById={effectiveGroupById}
                canDragCards={!isSourceGroupBy}
                cardFieldIds={cardFieldIds}
                customColumnMap={customColumnMap}
                selectedRowIds={selectedRowIds}
                draggingRowId={draggingRowId}
                showCover={showCover}
                coverFit={coverFit}
                showFieldNames={showFieldNames}
                addingCardGroupKey={addingCardGroupKey}
                addingCardTitle={addingCardTitle}
                getColumnLabel={getColumnLabel}
                onSetDraggingRowId={setDraggingRowId}
                onSetDragOverGroupKey={setDragOverGroupKey}
                onSelectRows={onSelectRows}
                onOpenRecord={onOpenRecord}
                onPreviewImage={onPreviewImage}
                onSetAddingCardGroupKey={setAddingCardGroupKey}
                onSetAddingCardTitle={setAddingCardTitle}
                onCreateCardInGroup={handleCreateCardInGroup}
                t={t}
              />
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
