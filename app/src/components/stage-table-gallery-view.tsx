import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StageTableFilterToolbarPopover } from "@/components/stage-table-filter-popover";
import {
  StageTableAttachmentThumb,
  StageTableFieldValueDisplay,
  StageTableFieldVisibilityList,
  StageTableSortToolbarPopover,
  getRowDisplayTitle,
} from "@/components/stage-table-views-shared";
import type { Project } from "@/core/Project";
import type { StageTableRow } from "@/core/service/dataManageService/stageTableService/StageTableService";
import type { TableDataSource } from "@/core/service/dataManageService/stageTableService/TableDataSource";
import {
  countActiveFilterConditions,
  type GalleryCardSize,
  type TableColumnFilter,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableFilterGroup,
  type TableGalleryViewConfig,
  type TableSortConfig,
  type TableViewSchema,
} from "@/types/table";
import { cn } from "@/utils/cn";
import { canUseVirtualMeasureElement, createSafeObserveElementRect } from "@/components/stage-table-scroll-container";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Crosshair, FileText, Image as ImageIcon, LayoutGrid, Pencil, PlusCircle, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const OBSERVE_GALLERY_RECT = createSafeObserveElementRect({ width: 960, height: 600 });

const CARD_MIN_WIDTH: Record<GalleryCardSize, number> = {
  small: 185,
  medium: 235,
  large: 300,
};

const COVER_HEIGHT_CLASS: Record<GalleryCardSize, string> = {
  small: "h-32",
  medium: "h-44",
  large: "h-56",
};

export function StageTableGalleryView({
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRowRef = useRef<{ rowUuid: string; docId?: string } | null>(null);
  const [containerWidth, setContainerWidth] = useState(960);
  const isWorkspaceMode = dataSource.scopeKind === "workspace";
  const [wsPageState, setWsPageState] = useState<{
    rows: StageTableRow[];
    unfilteredTotalCount: number;
  }>({ rows: [], unfilteredTotalCount: 0 });

  useEffect(() => {
    if (!isWorkspaceMode) return;
    let cancelled = false;
    void dataSource
      .queryPage({
        offset: 0,
        limit: 500,
        filters: activeFilters,
        filterGroup: activeFilterGroup,
        sort: activeSort,
      })
      .then((res) => {
        if (!cancelled) {
          setWsPageState({ rows: res.rows, unfilteredTotalCount: res.unfilteredTotalCount });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isWorkspaceMode, dataSource, dataRevision, activeFilters, activeFilterGroup, activeSort]);

  const effectiveRows = isWorkspaceMode ? wsPageState.rows : rows;
  const effectiveUnfilteredCount = isWorkspaceMode ? wsPageState.unfilteredTotalCount : allRows.length;

  const config: TableGalleryViewConfig = activeView.gallery ?? {};
  const hasAnyActiveFilter =
    activeFilters.length > 0 || countActiveFilterConditions(activeFilterGroup, customColumns) > 0;
  const coverMode = config.coverMode ?? "images";
  const coverFit = config.coverFit ?? "cover";
  const cardSize: GalleryCardSize = config.cardSize ?? "medium";
  const showFieldNames = config.showFieldNames ?? false;

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const updateWidth = () => {
      // 扣除左右 padding (p-3 -> 24px)
      const inner = el.clientWidth - 24;
      if (inner > 0) setContainerWidth(inner);
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const colsPerRow = useMemo(() => {
    const gap = 12;
    const minW = CARD_MIN_WIDTH[cardSize];
    return Math.max(1, Math.floor((containerWidth + gap) / (minW + gap)));
  }, [containerWidth, cardSize]);

  const galleryGridRows = useMemo<StageTableRow[][]>(() => {
    const out: StageTableRow[][] = [];
    for (let i = 0; i < effectiveRows.length; i += colsPerRow) {
      out.push(effectiveRows.slice(i, i + colsPerRow) as StageTableRow[]);
    }
    return out;
  }, [effectiveRows, colsPerRow]);

  const rowVirtualizer = useVirtualizer({
    count: galleryGridRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => (coverMode === "none" ? 132 : cardSize === "small" ? 236 : cardSize === "large" ? 336 : 284),
    gap: 12,
    overscan: 4,
    initialRect: { width: 960, height: 600 },
    observeElementRect: OBSERVE_GALLERY_RECT,
    measureElement: (el, _entry, instance) => {
      const h = el.getBoundingClientRect().height;
      return h > 0 ? h : instance.options.estimateSize(Number(el.getAttribute("data-index") ?? 0));
    },
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [colsPerRow, cardSize, coverMode, showFieldNames, rowVirtualizer]);

  const virtualGridRows = rowVirtualizer.getVirtualItems();

  const cardFieldIds = useMemo(
    () =>
      visibleColumnIds.filter((cid) => {
        if (cid === "name") return false;
        if (coverMode !== "none" && cid === "images") return false;
        return true;
      }),
    [visibleColumnIds, coverMode],
  );

  const handleAddRecord = () => {
    void Promise.resolve(dataSource.createRow({ text: "" })).then((created) => {
      if (created) {
        onSelectRows([created.uuid], false);
        onOpenRecord(created.uuid);
      }
    });
  };

  return (
    <div data-stage-table-gallery-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          const target = uploadTargetRowRef.current;
          if (target && files.length > 0) {
            void dataSource.addRowImages(target.rowUuid, files, target.docId);
          }
          uploadTargetRowRef.current = null;
          e.target.value = "";
        }}
      />

      {/* 画册第二行功能栏 */}
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 text-xs [scrollbar-width:none]">
        <button
          type="button"
          data-gallery-add-record
          onClick={handleAddRecord}
          className="text-primary hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 font-medium transition-colors"
        >
          <PlusCircle className="size-3.5" />
          <span>{t("gallery.addRecord")}</span>
        </button>

        <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

        {/* 画册设置 */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-gallery-settings-trigger
              className="text-foreground hover:bg-accent data-[state=open]:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
            >
              <LayoutGrid className="size-3.5" />
              <span>{t("gallery.settings")}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-64 space-y-3 p-3 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="space-y-2">
              <div className="text-muted-foreground text-[11px] font-medium">{t("gallery.coverSettings")}</div>
              <div className="flex items-center justify-between gap-2 px-1">
                <span>{t("gallery.coverSource")}</span>
                <div className="bg-muted flex rounded-md p-0.5">
                  {(["images", "none"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => dataSource.updateActiveViewConfig({ gallery: { coverMode: mode } })}
                      className={cn(
                        "cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors",
                        coverMode === mode
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(`gallery.coverMode_${mode}`)}
                    </button>
                  ))}
                </div>
              </div>

              {coverMode !== "none" && (
                <div className="flex items-center justify-between gap-2 px-1">
                  <span>{t("gallery.coverFit")}</span>
                  <div className="bg-muted flex rounded-md p-0.5">
                    {(["cover", "contain"] as const).map((fit) => (
                      <button
                        key={fit}
                        type="button"
                        onClick={() => dataSource.updateActiveViewConfig({ gallery: { coverFit: fit } })}
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

              <div className="flex items-center justify-between gap-2 px-1">
                <span>{t("gallery.cardSize")}</span>
                <div className="bg-muted flex rounded-md p-0.5">
                  {(["small", "medium", "large"] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => dataSource.updateActiveViewConfig({ gallery: { cardSize: sz } })}
                      className={cn(
                        "cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors",
                        cardSize === sz
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(`gallery.size_${sz}`)}
                    </button>
                  ))}
                </div>
              </div>

              <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1 py-1">
                <Checkbox
                  checked={showFieldNames}
                  onCheckedChange={(val) =>
                    dataSource.updateActiveViewConfig({ gallery: { showFieldNames: Boolean(val) } })
                  }
                />
                <span>{t("views.showFieldNames")}</span>
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

        <StageTableSortToolbarPopover
          allColumnIds={allColumnIds}
          customColumnMap={customColumnMap}
          activeSort={activeSort}
          getColumnLabel={getColumnLabel}
          onSetSort={(sort) => dataSource.setSort(sort)}
          t={t}
        />
      </div>

      {/* 虚拟化画册卡片网格 */}
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        {effectiveRows.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-xs">
            <span>
              {effectiveUnfilteredCount > 0 && hasAnyActiveFilter ? t("sortFilter.noFilterMatch") : t("emptyCanvas")}
            </span>
            {effectiveUnfilteredCount > 0 && hasAnyActiveFilter && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => dataSource.clearAllFilters()}
                className="h-7 px-3 text-xs"
              >
                {t("sortFilter.clearAllFilters")}
              </Button>
            )}
          </div>
        ) : (
          <div
            data-gallery-grid
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              position: "relative",
            }}
          >
            {virtualGridRows.map((vRow) => {
              const rowSlice = galleryGridRows[vRow.index];
              if (!rowSlice) return null;
              return (
                <div
                  key={vRow.key}
                  data-index={vRow.index}
                  ref={canUseVirtualMeasureElement() ? rowVirtualizer.measureElement : undefined}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vRow.start}px)`,
                    gridTemplateColumns: `repeat(${colsPerRow}, minmax(0, 1fr))`,
                  }}
                  className="grid gap-3"
                >
                  {rowSlice.map((row) => {
                    const titleInfo = getRowDisplayTitle(row, t);
                    const isSelected = selectedRowIds.has(row.uuid);
                    const firstImage = row.images[0] ?? null;

                    return (
                      <div
                        key={row.docId ? `${row.docId}:${row.uuid}` : row.uuid}
                        data-gallery-card={row.uuid}
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
                          "group/gcard bg-card border-border/70 hover:border-primary/50 relative flex cursor-pointer flex-col overflow-hidden rounded-lg border transition-all select-none",
                          isSelected && "border-primary ring-primary/35 ring-2",
                        )}
                      >
                        {/* 悬浮快捷操作 */}
                        <div className="bg-background/85 border-border/60 absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-md border p-0.5 opacity-0 shadow-xs backdrop-blur-xs transition-opacity group-hover/gcard:opacity-100">
                          {row.canEditImages !== false && (
                            <button
                              type="button"
                              title={t("imagesCell.add")}
                              onClick={(e) => {
                                e.stopPropagation();
                                uploadTargetRowRef.current = { rowUuid: row.uuid, docId: row.docId };
                                uploadInputRef.current?.click();
                              }}
                              className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded"
                            >
                              <Upload className="size-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            title={t("jumpToNode")}
                            onClick={(e) => {
                              e.stopPropagation();
                              dataSource.jumpToNode(row.docId ?? dataSource.getDocId(), row.uuid);
                            }}
                            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded"
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
                            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded"
                          >
                            <Pencil className="size-3" />
                          </button>
                        </div>

                        {/* 封面图区域 */}
                        {coverMode !== "none" && (
                          <div
                            className={cn(
                              "bg-muted/35 border-border/50 relative w-full shrink-0 overflow-hidden border-b",
                              COVER_HEIGHT_CLASS[cardSize],
                            )}
                          >
                            {firstImage ? (
                              <>
                                <StageTableAttachmentThumb
                                  project={project}
                                  dataSource={dataSource}
                                  docId={row.docId}
                                  attachmentId={firstImage.attachmentId}
                                  className={cn(
                                    "size-full rounded-none border-0",
                                    coverFit === "contain" ? "object-contain p-1" : "object-cover",
                                  )}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onPreviewImage(firstImage.attachmentId, row.uuid, row.docId);
                                  }}
                                />
                                {row.images.length > 1 && (
                                  <span className="bg-background/80 text-foreground absolute right-2 bottom-2 rounded px-1.5 py-0.5 text-[10px] font-medium shadow-xs backdrop-blur-xs">
                                    +{row.images.length - 1}
                                  </span>
                                )}
                              </>
                            ) : (
                              <div className="text-muted-foreground/35 flex size-full items-center justify-center">
                                <ImageIcon className="size-8 stroke-[1.5]" />
                              </div>
                            )}
                          </div>
                        )}

                        {/* 卡片信息区 */}
                        <div className="flex flex-1 flex-col gap-1.5 p-3">
                          <div
                            className={cn(
                              "text-sm leading-snug font-medium break-words",
                              titleInfo.isPlaceholder && "text-muted-foreground/60 font-normal",
                            )}
                          >
                            {titleInfo.text}
                          </div>

                          {row.sourceFile && !cardFieldIds.includes("sourceFile") && (
                            <button
                              type="button"
                              title={row.sourceRelPath || row.sourceFile}
                              onClick={(e) => {
                                e.stopPropagation();
                                dataSource.jumpToNode(row.docId ?? dataSource.getDocId(), row.uuid);
                              }}
                              className="text-muted-foreground hover:text-foreground inline-flex max-w-full cursor-pointer items-center gap-1 self-start text-[10px]"
                            >
                              <FileText className="size-2.5 shrink-0" />
                              <span className="truncate">{row.sourceFile}</span>
                            </button>
                          )}

                          {cardFieldIds.map((cid) => {
                            const customCol = customColumnMap.get(cid);
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
                                  <div className="text-muted-foreground truncate text-[11px]">
                                    {getColumnLabel(cid)}
                                  </div>
                                )}
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
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
