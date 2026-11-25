import { Project, ProjectState, service } from "@/core/Project";
import type { Service } from "@/core/interfaces/Service";
import { RectangleNoteEffect } from "@/core/service/feedbackService/effectEngine/concrete/RectangleNoteEffect";
import {
  isPersistentMindMapDragEnabled,
  reflowMindMapTreesForEntities,
} from "@/core/service/controlService/controller/concrete/MindMapDrag";
import { Settings } from "@/core/service/Settings";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { Edge } from "@/core/stage/stageObject/association/Edge";
import { MultiTargetUndirectedEdge } from "@/core/stage/stageObject/association/MutiTargetUndirectedEdge";
import { SyncAssociation } from "@/core/stage/stageObject/association/SyncAssociation";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { ConnectPoint } from "@/core/stage/stageObject/entity/ConnectPoint";
import { ExtensionEntity } from "@/core/stage/stageObject/entity/ExtensionEntity";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { LatexNode } from "@/core/stage/stageObject/entity/LatexNode";
import { MediaNode } from "@/core/stage/stageObject/entity/MediaNode";
import { ReferenceBlockNode } from "@/core/stage/stageObject/entity/ReferenceBlockNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { UrlNode } from "@/core/stage/stageObject/entity/UrlNode";
import {
  ALL_SYSTEM_COLUMN_IDS,
  cloneTableFields,
  createColumnGroupId,
  createCustomColumnId,
  createSelectOptionId,
  createTableViewId,
  pickNextSelectOptionColor,
  type CustomColumnType,
  type FormulaEvaluatedCell,
  type SystemColumnId,
  type TableCalendarViewConfig,
  type TableCellValue,
  type TableColumnFilter,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableFields,
  type TableGalleryViewConfig,
  type TableGanttViewConfig,
  type TableKanbanViewConfig,
  type TableRowHeight,
  type TableSelectOption,
  type TableSortConfig,
  type TableSortDirection,
  type TableViewSchema,
  type TableViewType,
} from "@/types/table";
import { Color, ProgressNumber, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { toast } from "sonner";
import { evaluateTableFormulas, materializeFormulaCellToStatic } from "./formulaEngine";

export type StageTableRowKind =
  | "text"
  | "section"
  | "url"
  | "media"
  | "latex"
  | "reference"
  | "image"
  | "svg"
  | "extension";

export interface StageTableRelationItem {
  uuid: string;
  label: string;
  kind: StageTableRowKind;
}

export interface StageTableImageItem {
  uuid: string;
  attachmentId: string;
}

export interface StageTableRow {
  uuid: string;
  entity: ConnectableEntity;
  kind: StageTableRowKind;
  primaryText: string;
  editableText: boolean;
  images: StageTableImageItem[];
  canEditImages: boolean;
  createdAt: number;
  updatedAt: number;
  parents: StageTableRelationItem[];
  children: StageTableRelationItem[];
  outer: StageTableRelationItem | null;
  inner: StageTableRelationItem[];
  canEditInner: boolean;
  tableFields: Record<string, TableCellValue>;
  formulaValues: Record<string, FormulaEvaluatedCell>;
}

interface RowRelationSets {
  parents: ConnectableEntity[];
  children: ConnectableEntity[];
  outer: Section | null;
  inner: ConnectableEntity[];
}

export function isTableRowEntity(object: StageObject): object is ConnectableEntity {
  if (!(object instanceof ConnectableEntity)) {
    return false;
  }
  if (object instanceof ConnectPoint) {
    return false;
  }
  // 单独一张图片不计入多维表格行；当图片进入节点/分组框内时，归入对应行的系统属性「图片」列
  if (object instanceof ImageNode) {
    return false;
  }
  return true;
}

export function getRowEntityKind(entity: ConnectableEntity): StageTableRowKind {
  if (entity instanceof Section) return "section";
  if (entity instanceof TextNode) return "text";
  if (entity instanceof UrlNode) return "url";
  if (entity instanceof MediaNode) return "media";
  if (entity instanceof LatexNode) return "latex";
  if (entity instanceof ReferenceBlockNode) return "reference";
  if (entity instanceof ImageNode) return "image";
  if (entity instanceof SvgNode) return "svg";
  return "extension";
}

export function getRowPrimaryText(entity: ConnectableEntity): string {
  if (entity instanceof TextNode || entity instanceof Section) {
    return entity.text;
  }
  if (entity instanceof UrlNode || entity instanceof MediaNode) {
    return entity.title;
  }
  if (entity instanceof LatexNode) {
    return entity.latexSource;
  }
  if (entity instanceof ReferenceBlockNode) {
    return entity.sectionName ? `[[${entity.fileName}#${entity.sectionName}]]` : `[[${entity.fileName}]]`;
  }
  if (entity instanceof ExtensionEntity) {
    return entity.typeName || entity.extensionId;
  }
  return "";
}

export function isRowPrimaryTextEditable(entity: ConnectableEntity): boolean {
  return (
    entity instanceof TextNode ||
    entity instanceof Section ||
    entity instanceof UrlNode ||
    entity instanceof MediaNode ||
    entity instanceof LatexNode
  );
}

export {
  applyTableFiltersAndSort,
  collectColumnFilterBuckets,
  formatDateBucket,
  getRowFilterTokens,
  type ColumnFilterBucket,
} from "@/types/table";

@service("stageTable")
export class StageTableService implements Service {
  private readonly listeners = new Set<() => void>();
  private readonly selectionListeners = new Set<(selectedUUIDs: string[]) => void>();
  private readonly baselineDigests = new Map<string, string>();
  private readonly detailsJsonCache = new WeakMap<object, string>();
  private readonly fieldsJsonCache = new WeakMap<object, string>();
  private baselineInitialized = false;
  private selectionSyncScheduled = false;
  private suppressCanvasSelectionSync = false;

  constructor(private readonly project: Project) {}

  public dispose(): void {
    this.listeners.clear();
    this.selectionListeners.clear();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeSelection(listener: (selectedUUIDs: string[]) => void): () => void {
    this.selectionListeners.add(listener);
    return () => {
      this.selectionListeners.delete(listener);
    };
  }

  public getSelectedRowUUIDs(): string[] {
    return this.getRowEntities()
      .filter((entity) => entity.isSelected)
      .map((entity) => entity.uuid);
  }

  public scheduleCanvasSelectionSync(): void {
    if (this.suppressCanvasSelectionSync) return;
    if (this.selectionListeners.size === 0) return;
    if (this.selectionSyncScheduled) return;
    this.selectionSyncScheduled = true;
    queueMicrotask(() => {
      this.selectionSyncScheduled = false;
      if (this.suppressCanvasSelectionSync) return;
      const selectedUUIDs = this.getSelectedRowUUIDs();
      for (const listener of this.selectionListeners) {
        listener(selectedUUIDs);
      }
    });
  }

  public notifyChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public getViews(): TableViewSchema[] {
    return this.project.table.views;
  }

  public getActiveView(): TableViewSchema {
    const { views, activeViewId } = this.project.table;
    return views.find((view) => view.id === activeViewId) ?? views[0];
  }

  private buildUniqueViewName(baseName: string, excludeViewId?: string): string {
    const trimmed = baseName.trim() || "视图";
    const existing = new Set(this.project.table.views.filter((v) => v.id !== excludeViewId).map((v) => v.name));
    if (!existing.has(trimmed)) return trimmed;
    let suffix = 2;
    while (existing.has(`${trimmed} ${suffix}`)) {
      suffix++;
    }
    return `${trimmed} ${suffix}`;
  }

  public setActiveView(viewId: string): boolean {
    if (!this.project.table.views.some((v) => v.id === viewId)) {
      return false;
    }
    if (this.project.table.activeViewId === viewId) {
      return true;
    }
    this.project.table = {
      ...this.project.table,
      activeViewId: viewId,
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return true;
  }

  public createView(input: { type: TableViewType; name?: string }): TableViewSchema {
    const defaultLabels: Record<TableViewType, string> = {
      table: "表格",
      kanban: "看板",
      gantt: "甘特",
      gallery: "画册",
      calendar: "日历",
    };
    const baseName = input.name?.trim() || defaultLabels[input.type];
    const uniqueName = this.buildUniqueViewName(baseName);
    const activeView = this.getActiveView();
    const columns = this.project.table.columns;
    const selectCols = columns.filter((c) => c.type === "select");
    const dateCols = columns.filter((c) => c.type === "date");

    const baseVisible = activeView ? [...activeView.visibleColumnIds] : ["name"];
    const baseWidths = activeView?.columnWidths ? { ...activeView.columnWidths } : {};

    let nextView: TableViewSchema = {
      id: createTableViewId(),
      name: uniqueName,
      type: input.type,
      deletable: true,
      visibleColumnIds: baseVisible,
      columnWidths: baseWidths,
    };

    if (input.type === "kanban") {
      nextView = {
        ...nextView,
        kanban: {
          groupByColumnId: selectCols[0]?.id ?? null,
          showCover: false,
          coverFit: "cover",
          showFieldNames: true,
          hideEmptyGroups: false,
        },
      };
    } else if (input.type === "gantt") {
      nextView = {
        ...nextView,
        gantt: {
          startDateColumnId: dateCols[0]?.id ?? "createdAt",
          endDateColumnId: dateCols[1]?.id ?? null,
          colorColumnId: selectCols[0]?.id ?? null,
          timeScale: "month",
          groupByColumnId: null,
          showLeftTable: true,
          leftPaneWidth: 280,
          showBarLabel: true,
          showDuration: true,
          highlightWeekends: true,
        },
      };
    } else if (input.type === "gallery") {
      nextView = {
        ...nextView,
        gallery: {
          coverMode: "images",
          coverFit: "cover",
          cardSize: "medium",
          showFieldNames: false,
        },
      };
    } else if (input.type === "calendar") {
      nextView = {
        ...nextView,
        calendar: {
          dateColumnId: dateCols[0]?.id ?? "createdAt",
          endDateColumnId: dateCols[1]?.id ?? null,
          colorColumnId: selectCols[0]?.id ?? null,
          displayMode: "month",
          cellHeight: "medium",
          weekStartsOn: 1,
          showFieldNames: false,
        },
      };
    }

    this.project.table = {
      ...this.project.table,
      views: [...this.project.table.views, nextView],
      activeViewId: nextView.id,
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return nextView;
  }

  public renameView(viewId: string, nextName: string): boolean {
    const trimmed = nextName.trim();
    if (!trimmed) return false;
    const target = this.project.table.views.find((v) => v.id === viewId);
    if (!target || target.name === trimmed) return false;
    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((v) => (v.id === viewId ? { ...v, name: trimmed } : v)),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return true;
  }

  public duplicateView(viewId: string, copySuffix: string = "副本"): TableViewSchema | null {
    const sourceIdx = this.project.table.views.findIndex((v) => v.id === viewId);
    if (sourceIdx === -1) return null;
    const source = this.project.table.views[sourceIdx];
    const clonedName = this.buildUniqueViewName(`${source.name} ${copySuffix}`);
    const duplicated: TableViewSchema = {
      ...source,
      id: createTableViewId(),
      name: clonedName,
      deletable: true,
      visibleColumnIds: [...source.visibleColumnIds],
      columnWidths: source.columnWidths ? { ...source.columnWidths } : {},
      columnGroups: source.columnGroups
        ? source.columnGroups.map((g) => ({ id: createColumnGroupId(), name: g.name, columnIds: [...g.columnIds] }))
        : undefined,
      sort: source.sort ? { ...source.sort } : undefined,
      filters: source.filters ? source.filters.map((f) => ({ ...f, values: [...f.values] })) : undefined,
      kanban: source.kanban ? { ...source.kanban } : undefined,
      gantt: source.gantt ? { ...source.gantt } : undefined,
      gallery: source.gallery ? { ...source.gallery } : undefined,
      calendar: source.calendar ? { ...source.calendar } : undefined,
    };

    const nextViews = [...this.project.table.views];
    nextViews.splice(sourceIdx + 1, 0, duplicated);
    this.project.table = {
      ...this.project.table,
      views: nextViews,
      activeViewId: duplicated.id,
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return duplicated;
  }

  public deleteView(viewId: string): boolean {
    const views = this.project.table.views;
    const idx = views.findIndex((v) => v.id === viewId);
    if (idx === -1) return false;
    const target = views[idx];
    if (!target.deletable || views.length <= 1) return false;

    const nextViews = views.filter((v) => v.id !== viewId);
    const nextActiveId =
      this.project.table.activeViewId === viewId ? nextViews[Math.max(0, idx - 1)].id : this.project.table.activeViewId;
    this.project.table = {
      ...this.project.table,
      views: nextViews,
      activeViewId: nextActiveId,
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return true;
  }

  public reorderViews(draggedViewId: string, targetViewId: string, position: "before" | "after"): boolean {
    if (draggedViewId === targetViewId) return false;
    const views = this.project.table.views;
    const dragged = views.find((v) => v.id === draggedViewId);
    if (!dragged || !views.some((v) => v.id === targetViewId)) return false;

    const withoutDragged = views.filter((v) => v.id !== draggedViewId);
    const targetIdx = withoutDragged.findIndex((v) => v.id === targetViewId);
    if (targetIdx === -1) return false;
    const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
    const nextViews = [...withoutDragged];
    nextViews.splice(insertIdx, 0, dragged);

    if (nextViews.every((v, i) => v.id === views[i].id)) return false;
    this.project.table = {
      ...this.project.table,
      views: nextViews,
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return true;
  }

  public updateActiveViewConfig(patch: {
    rowHeight?: TableRowHeight;
    kanban?: Partial<TableKanbanViewConfig>;
    gantt?: Partial<TableGanttViewConfig>;
    gallery?: Partial<TableGalleryViewConfig>;
    calendar?: Partial<TableCalendarViewConfig>;
  }): void {
    const activeView = this.getActiveView();
    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) => {
        if (view.id !== activeView.id) return view;
        return {
          ...view,
          ...(patch.rowHeight !== undefined ? { rowHeight: patch.rowHeight } : {}),
          ...(patch.kanban ? { kanban: { ...(view.kanban ?? {}), ...patch.kanban } } : {}),
          ...(patch.gantt ? { gantt: { ...(view.gantt ?? {}), ...patch.gantt } } : {}),
          ...(patch.gallery ? { gallery: { ...(view.gallery ?? {}), ...patch.gallery } } : {}),
          ...(patch.calendar ? { calendar: { ...(view.calendar ?? {}), ...patch.calendar } } : {}),
        };
      }),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
  }

  private pruneColumnReferencesInView(
    view: TableViewSchema,
    columnId: string,
    nextType?: CustomColumnType,
  ): TableViewSchema {
    const removed = nextType === undefined;
    const canColor = nextType === "select" || nextType === "multi_select";
    const canDate = nextType === "date" || nextType === "formula";

    let kanban = view.kanban;
    if (kanban && kanban.groupByColumnId === columnId && removed) {
      kanban = { ...kanban, groupByColumnId: null };
    }

    let gantt = view.gantt;
    if (gantt) {
      let changed = false;
      const nextGantt = { ...gantt };
      if (nextGantt.startDateColumnId === columnId && (removed || !canDate)) {
        nextGantt.startDateColumnId = "createdAt";
        changed = true;
      }
      if (nextGantt.endDateColumnId === columnId && (removed || !canDate)) {
        nextGantt.endDateColumnId = null;
        changed = true;
      }
      if (nextGantt.colorColumnId === columnId && (removed || !canColor)) {
        nextGantt.colorColumnId = null;
        changed = true;
      }
      if (nextGantt.groupByColumnId === columnId && removed) {
        nextGantt.groupByColumnId = null;
        changed = true;
      }
      if (changed) gantt = nextGantt;
    }

    let calendar = view.calendar;
    if (calendar) {
      let changed = false;
      const nextCal = { ...calendar };
      if (nextCal.dateColumnId === columnId && (removed || !canDate)) {
        nextCal.dateColumnId = "createdAt";
        changed = true;
      }
      if (nextCal.endDateColumnId === columnId && (removed || !canDate)) {
        nextCal.endDateColumnId = null;
        changed = true;
      }
      if (nextCal.colorColumnId === columnId && (removed || !canColor)) {
        nextCal.colorColumnId = null;
        changed = true;
      }
      if (changed) calendar = nextCal;
    }

    return {
      ...view,
      ...(kanban ? { kanban } : {}),
      ...(gantt ? { gantt } : {}),
      ...(calendar ? { calendar } : {}),
    };
  }

  public getColumns(): TableColumnSchema[] {
    return this.project.table.columns;
  }

  public getColumnSchema(columnId: string): TableColumnSchema | undefined {
    return this.project.table.columns.find((col) => col.id === columnId);
  }

  public getSystemColumnCustomName(columnId: SystemColumnId): string | undefined {
    return this.project.table.systemColumnNames?.[columnId];
  }

  public getVisibleColumnIds(): string[] {
    const activeView = this.getActiveView();
    const validIds = new Set<string>([...ALL_SYSTEM_COLUMN_IDS, ...this.project.table.columns.map((c) => c.id)]);
    const result: string[] = ["name"];
    const seen = new Set<string>(["name"]);
    for (const id of activeView.visibleColumnIds) {
      if (validIds.has(id) && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }

  public isColumnVisible(columnId: string): boolean {
    if (columnId === "name") return true;
    return this.getVisibleColumnIds().includes(columnId);
  }

  public setColumnVisible(columnId: string, visible: boolean): void {
    if (columnId === "name") return;
    const isSystem = (ALL_SYSTEM_COLUMN_IDS as readonly string[]).includes(columnId);
    const isCustom = this.project.table.columns.some((col) => col.id === columnId);
    if (!isSystem && !isCustom) return;

    const activeView = this.getActiveView();
    const currentVisible = this.getVisibleColumnIds();
    let orderedVisible: string[];
    let nextFrozenId = activeView.frozenColumnId;
    if (visible) {
      orderedVisible = currentVisible.includes(columnId) ? currentVisible : [...currentVisible, columnId];
    } else {
      const idx = currentVisible.indexOf(columnId);
      orderedVisible = currentVisible.filter((id) => id !== columnId);
      if (nextFrozenId === columnId) {
        nextFrozenId = idx > 0 ? currentVisible[idx - 1] : undefined;
      }
    }

    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              visibleColumnIds: orderedVisible,
              frozenColumnId: nextFrozenId,
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
  }

  public reorderColumn(draggedColumnId: string, targetColumnId: string, position: "before" | "after"): boolean {
    if (draggedColumnId === "name" || draggedColumnId === targetColumnId) {
      return false;
    }
    const current = this.getVisibleColumnIds();
    if (!current.includes(draggedColumnId) || !current.includes(targetColumnId)) {
      return false;
    }

    const withoutDragged = current.filter((id) => id !== draggedColumnId);
    const targetIdx = withoutDragged.indexOf(targetColumnId);
    if (targetIdx === -1) return false;

    const insertIdx = targetColumnId === "name" ? 1 : position === "before" ? Math.max(1, targetIdx) : targetIdx + 1;
    const nextOrder = [...withoutDragged];
    nextOrder.splice(insertIdx, 0, draggedColumnId);

    if (nextOrder.every((id, idx) => id === current[idx])) {
      return false;
    }

    const activeView = this.getActiveView();
    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id ? { ...view, visibleColumnIds: nextOrder } : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return true;
  }

  public addCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    targetColumnId?: string;
    side?: "left" | "right";
    formula?: string;
    format?: string;
  }): TableColumnSchema {
    return this.insertCustomColumn(input);
  }

  public insertCustomColumn(input: {
    name: string;
    type: CustomColumnType;
    targetColumnId?: string;
    side?: "left" | "right";
    formula?: string;
    format?: string;
  }): TableColumnSchema {
    const id = createCustomColumnId();
    const trimmedName = input.name.trim() || "未命名";
    const newColumn: TableColumnSchema = {
      id,
      name: trimmedName,
      type: input.type,
      ...(input.type === "select" || input.type === "multi_select" ? { options: [] } : {}),
      ...(input.type === "formula" && input.formula !== undefined ? { formula: input.formula } : {}),
      ...(input.type === "formula" && input.format ? { format: input.format } : {}),
    };

    const activeView = this.getActiveView();
    const currentVisible = this.getVisibleColumnIds();
    const nextVisible = [...currentVisible];

    if (input.targetColumnId && currentVisible.includes(input.targetColumnId)) {
      const targetIdx = currentVisible.indexOf(input.targetColumnId);
      const insertIdx =
        input.targetColumnId === "name" ? 1 : input.side === "left" ? Math.max(1, targetIdx) : targetIdx + 1;
      nextVisible.splice(insertIdx, 0, id);
    } else {
      nextVisible.push(id);
    }

    const nextGroups = (activeView.columnGroups ?? []).map((grp) => {
      if (input.targetColumnId && grp.columnIds.includes(input.targetColumnId)) {
        const gIdx = grp.columnIds.indexOf(input.targetColumnId);
        const nextColIds = [...grp.columnIds];
        nextColIds.splice(input.side === "left" ? gIdx : gIdx + 1, 0, id);
        return { ...grp, columnIds: nextColIds };
      }
      return grp;
    });

    this.project.table = {
      ...this.project.table,
      columns: [...this.project.table.columns, newColumn],
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              visibleColumnIds: nextVisible,
              ...(nextGroups.length > 0 ? { columnGroups: nextGroups } : {}),
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return newColumn;
  }

  public duplicateCustomColumn(sourceColumnId: string, copySuffix: string = "副本"): TableColumnSchema | null {
    const sourceCol = this.project.table.columns.find((col) => col.id === sourceColumnId);
    if (!sourceCol) return null;

    const existingNames = new Set(this.project.table.columns.map((col) => col.name));
    const baseDupName = `${sourceCol.name} ${copySuffix}`;
    let dupName = baseDupName;
    if (existingNames.has(dupName)) {
      let n = 2;
      while (existingNames.has(`${baseDupName} ${n}`)) {
        n++;
      }
      dupName = `${baseDupName} ${n}`;
    }

    const newColId = createCustomColumnId();
    const duplicatedColumn: TableColumnSchema = {
      id: newColId,
      name: dupName,
      type: sourceCol.type,
      width: sourceCol.width,
      format: sourceCol.format,
      formula: sourceCol.formula,
      options: sourceCol.options ? sourceCol.options.map((opt) => ({ ...opt })) : undefined,
    };

    let stageFieldsMutated = false;
    if (sourceCol.type !== "formula") {
      for (const entity of this.getRowEntities()) {
        const val = entity.tableFields[sourceColumnId];
        if (val !== undefined && val !== null && val !== "" && !(Array.isArray(val) && val.length === 0)) {
          const nextFields = cloneTableFields(entity.tableFields);
          nextFields[newColId] = Array.isArray(val) ? [...val] : val;
          entity.tableFields = nextFields;
          stageFieldsMutated = true;
        }
      }
    }

    const activeView = this.getActiveView();
    const currentVisible = this.getVisibleColumnIds();
    const nextVisible = [...currentVisible];
    const sourceIdx = currentVisible.indexOf(sourceColumnId);
    if (sourceIdx !== -1) {
      nextVisible.splice(sourceIdx + 1, 0, newColId);
    } else {
      nextVisible.push(newColId);
    }

    const nextWidths = { ...(activeView.columnWidths ?? {}) };
    if (nextWidths[sourceColumnId] !== undefined) {
      nextWidths[newColId] = nextWidths[sourceColumnId];
    }

    const nextGroups = (activeView.columnGroups ?? []).map((grp) => {
      const gIdx = grp.columnIds.indexOf(sourceColumnId);
      if (gIdx !== -1) {
        const nextColIds = [...grp.columnIds];
        nextColIds.splice(gIdx + 1, 0, newColId);
        return { ...grp, columnIds: nextColIds };
      }
      return grp;
    });

    this.project.table = {
      ...this.project.table,
      columns: [...this.project.table.columns, duplicatedColumn],
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              visibleColumnIds: nextVisible,
              columnWidths: nextWidths,
              ...(nextGroups.length > 0 ? { columnGroups: nextGroups } : {}),
            }
          : view,
      ),
    };

    if (stageFieldsMutated) {
      this.project.historyManager.recordStep();
    } else {
      this.project.projectState = ProjectState.Unsaved;
    }
    this.notifyChange();
    return duplicatedColumn;
  }

  public updateColumn(
    columnId: string,
    patch: { name?: string; type?: CustomColumnType; formula?: string; format?: string | null },
  ): boolean {
    if ((ALL_SYSTEM_COLUMN_IDS as readonly string[]).includes(columnId)) {
      if (patch.name === undefined) return false;
      const sysId = columnId as SystemColumnId;
      const nextNames = { ...(this.project.table.systemColumnNames ?? {}) };
      const trimmed = patch.name.trim();
      if (trimmed.length > 0) {
        nextNames[sysId] = trimmed;
      } else {
        delete nextNames[sysId];
      }
      this.project.table = {
        ...this.project.table,
        systemColumnNames: Object.keys(nextNames).length > 0 ? nextNames : undefined,
      };
      this.project.projectState = ProjectState.Unsaved;
      this.notifyChange();
      return true;
    }

    const existingCol = this.project.table.columns.find((col) => col.id === columnId);
    if (!existingCol) return false;

    const nextName = patch.name !== undefined && patch.name.trim().length > 0 ? patch.name.trim() : existingCol.name;
    const nextType = patch.type ?? existingCol.type;
    const nextFormula =
      nextType === "formula" ? (patch.formula !== undefined ? patch.formula : existingCol.formula) : undefined;
    const nextFormat =
      nextType === "formula"
        ? patch.format === null || patch.format === ""
          ? undefined
          : patch.format !== undefined
            ? patch.format
            : existingCol.format
        : undefined;

    if (
      nextName === existingCol.name &&
      nextType === existingCol.type &&
      nextFormula === existingCol.formula &&
      nextFormat === existingCol.format
    ) {
      return false;
    }

    const nextOptions: TableSelectOption[] | undefined =
      nextType === "select" || nextType === "multi_select" ? [...(existingCol.options ?? [])] : undefined;
    let stageFieldsMutated = false;

    if (nextType !== existingCol.type) {
      const oldOptionNameById = new Map((existingCol.options ?? []).map((o) => [o.id, o.name]));
      const ensureOptionByLabel = (label: string): string | null => {
        const clean = label.trim();
        if (!clean || !nextOptions) return null;
        const found = nextOptions.find((o) => o.name === clean);
        if (found) return found.id;
        const created: TableSelectOption = {
          id: createSelectOptionId(),
          name: clean,
          color: pickNextSelectOptionColor(nextOptions),
        };
        nextOptions.push(created);
        return created.id;
      };

      // Solidify evaluated formula results into static cell values when converting formula -> non-formula
      if (existingCol.type === "formula" && nextType !== "formula") {
        const snapshotRows = this.getRows();
        const snapshotByUuid = new Map(snapshotRows.map((r) => [r.uuid, r]));
        for (const entity of this.getRowEntities()) {
          const evaluatedCell = snapshotByUuid.get(entity.uuid)?.formulaValues[columnId];
          const materialized = materializeFormulaCellToStatic(evaluatedCell, nextType, ensureOptionByLabel);
          const nextFields = cloneTableFields(entity.tableFields);
          if (
            materialized === null ||
            materialized === "" ||
            (Array.isArray(materialized) && materialized.length === 0)
          ) {
            if (columnId in nextFields) {
              delete nextFields[columnId];
              entity.tableFields = nextFields;
              stageFieldsMutated = true;
            }
          } else {
            nextFields[columnId] = materialized;
            entity.tableFields = nextFields;
            stageFieldsMutated = true;
          }
        }
      } else if (nextType === "formula") {
        // Switching static column -> formula: clear stale static entries so they never pollute semantic timestamps
        for (const entity of this.getRowEntities()) {
          if (columnId in entity.tableFields) {
            const nextFields = cloneTableFields(entity.tableFields);
            delete nextFields[columnId];
            entity.tableFields = nextFields;
            stageFieldsMutated = true;
          }
        }
      } else {
        for (const entity of this.getRowEntities()) {
          const rawVal = entity.tableFields[columnId];
          if (rawVal === undefined) continue;

          let converted: TableCellValue = null;
          if (
            (existingCol.type === "select" && nextType === "multi_select") ||
            (existingCol.type === "multi_select" && nextType === "select")
          ) {
            if (nextType === "multi_select" && typeof rawVal === "string" && rawVal) {
              converted = [rawVal];
            } else if (nextType === "select" && Array.isArray(rawVal) && rawVal.length > 0) {
              converted = rawVal[0];
            }
          } else if (nextType === "text") {
            if (existingCol.type === "select" && typeof rawVal === "string") {
              converted = oldOptionNameById.get(rawVal) ?? null;
            } else if (existingCol.type === "multi_select" && Array.isArray(rawVal)) {
              const labels = rawVal.map((id) => oldOptionNameById.get(id)).filter((v): v is string => Boolean(v));
              converted = labels.length > 0 ? labels.join(", ") : null;
            } else if (typeof rawVal === "number" || typeof rawVal === "string") {
              converted = String(rawVal);
            }
          } else if (nextType === "number") {
            if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
              converted = rawVal;
            } else if (typeof rawVal === "string" && rawVal.trim().length > 0) {
              const parsed = Number(rawVal.trim());
              converted = Number.isFinite(parsed) ? parsed : null;
            }
          } else if (nextType === "date") {
            if (typeof rawVal === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawVal.trim())) {
              converted = rawVal.trim();
            }
          } else if (nextType === "select" || nextType === "multi_select") {
            const textCandidate =
              typeof rawVal === "string" ? rawVal : typeof rawVal === "number" ? String(rawVal) : "";
            if (textCandidate.trim()) {
              if (nextType === "select") {
                converted = ensureOptionByLabel(textCandidate);
              } else {
                const parts = textCandidate
                  .split(/[,，]/)
                  .map((s) => ensureOptionByLabel(s))
                  .filter((id): id is string => Boolean(id));
                converted = parts.length > 0 ? Array.from(new Set(parts)) : null;
              }
            }
          }

          const nextFields = cloneTableFields(entity.tableFields);
          if (converted === null || converted === "" || (Array.isArray(converted) && converted.length === 0)) {
            delete nextFields[columnId];
          } else {
            nextFields[columnId] = converted;
          }
          entity.tableFields = nextFields;
          stageFieldsMutated = true;
        }
      }
    }

    const typeChanged = nextType !== existingCol.type;
    this.project.table = {
      ...this.project.table,
      columns: this.project.table.columns.map((col) =>
        col.id === columnId
          ? {
              ...col,
              name: nextName,
              type: nextType,
              options: nextOptions,
              formula: nextFormula,
              format: nextFormat,
            }
          : col,
      ),
      views: typeChanged
        ? this.project.table.views.map((view) => {
            const nextFilters = (view.filters ?? []).filter((f) => f.columnId !== columnId);
            return this.pruneColumnReferencesInView(
              {
                ...view,
                filters: nextFilters.length > 0 ? nextFilters : undefined,
              },
              columnId,
              nextType,
            );
          })
        : this.project.table.views,
    };

    if (stageFieldsMutated) {
      this.project.historyManager.recordStep();
    } else {
      this.project.projectState = ProjectState.Unsaved;
    }
    this.notifyChange();
    return true;
  }

  public deleteCustomColumn(columnId: string): boolean {
    if (!this.project.table.columns.some((col) => col.id === columnId)) {
      return false;
    }

    let stageFieldsMutated = false;
    for (const entity of this.getRowEntities()) {
      if (columnId in entity.tableFields) {
        const nextFields = cloneTableFields(entity.tableFields);
        delete nextFields[columnId];
        entity.tableFields = nextFields;
        stageFieldsMutated = true;
      }
    }

    this.project.table = {
      ...this.project.table,
      columns: this.project.table.columns.filter((col) => col.id !== columnId),
      views: this.project.table.views.map((view) => {
        const nextWidths = { ...(view.columnWidths ?? {}) };
        delete nextWidths[columnId];
        const prevVisible = view.visibleColumnIds;
        const idx = prevVisible.indexOf(columnId);
        let nextFrozen = view.frozenColumnId;
        if (nextFrozen === columnId) {
          nextFrozen = idx > 0 ? prevVisible[idx - 1] : undefined;
        }
        const nextGroups = (view.columnGroups ?? [])
          .map((grp) => ({ ...grp, columnIds: grp.columnIds.filter((id) => id !== columnId) }))
          .filter((grp) => grp.columnIds.length > 0);
        const nextSort = view.sort?.columnId === columnId ? undefined : view.sort;
        const nextFilters = (view.filters ?? []).filter((flt) => flt.columnId !== columnId);
        return this.pruneColumnReferencesInView(
          {
            ...view,
            visibleColumnIds: prevVisible.filter((id) => id !== columnId),
            columnWidths: nextWidths,
            frozenColumnId: nextFrozen,
            columnGroups: nextGroups.length > 0 ? nextGroups : undefined,
            sort: nextSort,
            filters: nextFilters.length > 0 ? nextFilters : undefined,
          },
          columnId,
        );
      }),
    };

    if (stageFieldsMutated) {
      this.project.historyManager.recordStep();
    } else {
      this.project.projectState = ProjectState.Unsaved;
    }
    this.notifyChange();
    return true;
  }

  public createOrGetSelectOption(columnId: string, optionName: string): TableSelectOption | null {
    const cleanName = optionName.trim();
    if (!cleanName) return null;
    const col = this.project.table.columns.find((item) => item.id === columnId);
    if (!col || (col.type !== "select" && col.type !== "multi_select")) {
      return null;
    }

    const currentOptions = col.options ?? [];
    const existing = currentOptions.find((opt) => opt.name === cleanName);
    if (existing) {
      return existing;
    }

    const created: TableSelectOption = {
      id: createSelectOptionId(),
      name: cleanName,
      color: pickNextSelectOptionColor(currentOptions),
    };

    this.project.table = {
      ...this.project.table,
      columns: this.project.table.columns.map((item) =>
        item.id === columnId ? { ...item, options: [...currentOptions, created] } : item,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return created;
  }

  public setColumnWidth(columnId: string, width: number): void {
    const clampedWidth = Math.max(80, Math.min(600, Math.round(width)));
    const activeView = this.getActiveView();
    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              columnWidths: {
                ...(view.columnWidths ?? {}),
                [columnId]: clampedWidth,
              },
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
  }

  private estimateDisplayWidthPx(text: string): number {
    let px = 0;
    for (const ch of text) {
      px += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 12.5 : 7.2;
    }
    return Math.ceil(px);
  }

  public autoFitColumnWidth(columnId: string, headerLabel: string): number {
    const rows = this.getRows();
    const customCol = this.getColumnSchema(columnId);
    let maxWidth = this.estimateDisplayWidthPx(headerLabel) + 50;

    for (const row of rows) {
      let cellWidth = 80;
      if (columnId === "name") {
        const firstLine = (row.primaryText || "未命名节点").split(/\r?\n/)[0];
        cellWidth = this.estimateDisplayWidthPx(firstLine.slice(0, 38)) + 68;
      } else if (columnId === "images") {
        cellWidth = row.images.length > 0 ? row.images.length * 34 + 54 : 96;
      } else if (columnId === "createdAt" || columnId === "updatedAt") {
        cellWidth = 168;
      } else if (columnId === "parents" || columnId === "children" || columnId === "inner") {
        const list = columnId === "parents" ? row.parents : columnId === "children" ? row.children : row.inner;
        if (list.length > 0) {
          const badgesPx = list
            .slice(0, 4)
            .reduce((sum, item) => sum + Math.min(136, this.estimateDisplayWidthPx(item.label || "节点") + 38), 0);
          cellWidth = badgesPx + 24;
        }
      } else if (columnId === "outer") {
        cellWidth = row.outer ? Math.min(200, this.estimateDisplayWidthPx(row.outer.label || "分组框") + 46) : 96;
      } else if (customCol) {
        if (customCol.type === "formula") {
          const displayText = row.formulaValues[customCol.id]?.displayText ?? "";
          cellWidth = displayText ? this.estimateDisplayWidthPx(displayText) + 28 : 96;
        } else {
          const val = row.tableFields[customCol.id];
          if (customCol.type === "date") {
            cellWidth = typeof val === "string" && val ? 138 : 96;
          } else if (customCol.type === "select" || customCol.type === "multi_select") {
            const optMap = new Map((customCol.options ?? []).map((o) => [o.id, o.name]));
            const ids = Array.isArray(val) ? val : typeof val === "string" ? [val] : [];
            if (ids.length > 0) {
              const pillsPx = ids.reduce(
                (sum, id) => sum + Math.min(132, this.estimateDisplayWidthPx(optMap.get(id) ?? "") + 32),
                0,
              );
              cellWidth = pillsPx + 30;
            }
          } else if (val !== null && val !== undefined) {
            cellWidth = this.estimateDisplayWidthPx(String(val)) + 28;
          }
        }
      }
      if (cellWidth > maxWidth) {
        maxWidth = cellWidth;
      }
    }

    const clamped = Math.max(88, Math.min(480, Math.round(maxWidth)));
    this.setColumnWidth(columnId, clamped);
    return clamped;
  }

  public getFrozenColumnId(): string | null {
    const activeView = this.getActiveView();
    const visible = this.getVisibleColumnIds();
    if (activeView.frozenColumnId && visible.includes(activeView.frozenColumnId)) {
      return activeView.frozenColumnId;
    }
    return null;
  }

  public toggleFreezeUpToColumn(columnId: string): string | null {
    const visible = this.getVisibleColumnIds();
    if (!visible.includes(columnId)) {
      return this.getFrozenColumnId();
    }
    const activeView = this.getActiveView();
    const nextFrozen = activeView.frozenColumnId === columnId ? undefined : columnId;
    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id ? { ...view, frozenColumnId: nextFrozen } : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return nextFrozen ?? null;
  }

  public getColumnGroups(): TableColumnGroup[] {
    return this.getActiveView().columnGroups ?? [];
  }

  private alignGroupColumnsContiguously(visible: string[], groupColIds: Set<string>): string[] {
    const membersInOrder = visible.filter((id) => groupColIds.has(id));
    if (membersInOrder.length <= 1) {
      return visible;
    }
    if (groupColIds.has("name")) {
      return ["name", ...membersInOrder.filter((id) => id !== "name"), ...visible.filter((id) => !groupColIds.has(id))];
    }
    const firstIdx = visible.findIndex((id) => groupColIds.has(id));
    const nonMembers = visible.filter((id) => !groupColIds.has(id));
    const insertAt = Math.max(1, Math.min(firstIdx, nonMembers.length));
    const result = [...nonMembers];
    result.splice(insertAt, 0, ...membersInOrder);
    return result;
  }

  public createColumnGroup(name: string, initialColumnIds: string[]): TableColumnGroup | null {
    const visible = this.getVisibleColumnIds();
    const validCols = Array.from(new Set(initialColumnIds.filter((id) => visible.includes(id))));
    if (validCols.length === 0) return null;

    const activeView = this.getActiveView();
    const validSet = new Set(validCols);
    const cleanedExisting = (activeView.columnGroups ?? [])
      .map((grp) => ({ ...grp, columnIds: grp.columnIds.filter((id) => !validSet.has(id)) }))
      .filter((grp) => grp.columnIds.length > 0);

    const newGroup: TableColumnGroup = {
      id: createColumnGroupId(),
      name: name.trim() || "基础信息",
      columnIds: validCols,
    };

    const nextVisible = this.alignGroupColumnsContiguously(visible, validSet);
    const nextGroups = [...cleanedExisting, newGroup];

    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              visibleColumnIds: nextVisible,
              columnGroups: nextGroups,
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return newGroup;
  }

  public renameColumnGroup(groupId: string, nextName: string): boolean {
    const trimmed = nextName.trim();
    if (!trimmed) return false;
    const activeView = this.getActiveView();
    const existing = (activeView.columnGroups ?? []).find((g) => g.id === groupId);
    if (!existing || existing.name === trimmed) return false;

    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              columnGroups: (view.columnGroups ?? []).map((grp) =>
                grp.id === groupId ? { ...grp, name: trimmed } : grp,
              ),
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return true;
  }

  public setColumnInGroup(columnId: string, targetGroupId: string | null): boolean {
    const visible = this.getVisibleColumnIds();
    if (!visible.includes(columnId)) return false;

    const activeView = this.getActiveView();
    let nextGroups = (activeView.columnGroups ?? []).map((grp) => ({
      ...grp,
      columnIds: grp.columnIds.filter((id) => id !== columnId),
    }));

    let nextVisible = [...visible];
    if (targetGroupId !== null) {
      const targetGrp = nextGroups.find((g) => g.id === targetGroupId);
      if (!targetGrp) return false;
      targetGrp.columnIds.push(columnId);
      nextVisible = this.alignGroupColumnsContiguously(visible, new Set(targetGrp.columnIds));
    }

    nextGroups = nextGroups.filter((grp) => grp.columnIds.length > 0);

    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              visibleColumnIds: nextVisible,
              columnGroups: nextGroups.length > 0 ? nextGroups : undefined,
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return true;
  }

  public dissolveColumnGroup(groupId: string): boolean {
    const activeView = this.getActiveView();
    const before = activeView.columnGroups ?? [];
    const nextGroups = before.filter((grp) => grp.id !== groupId);
    if (nextGroups.length === before.length) return false;

    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              columnGroups: nextGroups.length > 0 ? nextGroups : undefined,
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
    return true;
  }

  public getSort(): TableSortConfig | null {
    const sort = this.getActiveView().sort;
    if (!sort) return null;
    const isValid =
      (ALL_SYSTEM_COLUMN_IDS as readonly string[]).includes(sort.columnId) ||
      this.project.table.columns.some((c) => c.id === sort.columnId);
    return isValid ? sort : null;
  }

  public setSort(sort: TableSortConfig | null): void {
    const activeView = this.getActiveView();
    if (
      sort &&
      !(ALL_SYSTEM_COLUMN_IDS as readonly string[]).includes(sort.columnId) &&
      !this.project.table.columns.some((c) => c.id === sort.columnId)
    ) {
      return;
    }
    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              sort: sort ?? undefined,
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
  }

  public toggleColumnSort(columnId: string, preferredDirection?: TableSortDirection): TableSortConfig | null {
    const current = this.getSort();
    let next: TableSortConfig | null;
    if (preferredDirection) {
      next =
        current && current.columnId === columnId && current.direction === preferredDirection
          ? null
          : { columnId, direction: preferredDirection };
    } else if (!current || current.columnId !== columnId) {
      next = { columnId, direction: "asc" };
    } else if (current.direction === "asc") {
      next = { columnId, direction: "desc" };
    } else {
      next = null;
    }
    this.setSort(next);
    return next;
  }

  public getFilters(): TableColumnFilter[] {
    const validIds = new Set<string>([...ALL_SYSTEM_COLUMN_IDS, ...this.project.table.columns.map((c) => c.id)]);
    return (this.getActiveView().filters ?? []).filter((flt) => validIds.has(flt.columnId));
  }

  public getColumnFilter(columnId: string): TableColumnFilter | null {
    return this.getFilters().find((flt) => flt.columnId === columnId) ?? null;
  }

  public setColumnFilter(columnId: string, filter: { values: string[]; includeEmpty: boolean } | null): void {
    const activeView = this.getActiveView();
    const validIds = new Set<string>([...ALL_SYSTEM_COLUMN_IDS, ...this.project.table.columns.map((c) => c.id)]);
    if (!validIds.has(columnId)) return;
    const remaining = (activeView.filters ?? []).filter((flt) => flt.columnId !== columnId);
    const nextFilters = filter
      ? [
          ...remaining,
          { columnId, values: Array.from(new Set(filter.values)), includeEmpty: Boolean(filter.includeEmpty) },
        ]
      : remaining;
    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              filters: nextFilters.length > 0 ? nextFilters : undefined,
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
  }

  public clearAllFilters(): void {
    const activeView = this.getActiveView();
    if (!activeView.filters || activeView.filters.length === 0) return;
    this.project.table = {
      ...this.project.table,
      views: this.project.table.views.map((view) =>
        view.id === activeView.id
          ? {
              ...view,
              filters: undefined,
            }
          : view,
      ),
    };
    this.project.projectState = ProjectState.Unsaved;
    this.notifyChange();
  }

  public getRowEntities(): ConnectableEntity[] {
    return this.project.stage.filter(isTableRowEntity);
  }

  private buildRelationIndex(rowEntities: ConnectableEntity[]): Map<string, RowRelationSets> {
    const rowMap = new Map<string, ConnectableEntity>();
    const relations = new Map<string, RowRelationSets>();
    const parentSeen = new Map<string, Set<string>>();
    const childSeen = new Map<string, Set<string>>();

    for (const entity of rowEntities) {
      rowMap.set(entity.uuid, entity);
      parentSeen.set(entity.uuid, new Set());
      childSeen.set(entity.uuid, new Set());
      const outer = entity.parentSection && isTableRowEntity(entity.parentSection) ? entity.parentSection : null;
      const inner = entity instanceof Section ? entity.children.filter(isTableRowEntity) : [];
      relations.set(entity.uuid, {
        parents: [],
        children: [],
        outer,
        inner,
      });
    }

    for (const edge of this.project.stageManager.getEdges()) {
      const sourceId = edge.source.uuid;
      const targetId = edge.target.uuid;
      if (sourceId === targetId) continue;
      const sourceEntity = rowMap.get(sourceId);
      const targetEntity = rowMap.get(targetId);
      if (!sourceEntity || !targetEntity) continue;

      const childrenSet = childSeen.get(sourceId)!;
      if (!childrenSet.has(targetId)) {
        childrenSet.add(targetId);
        relations.get(sourceId)!.children.push(targetEntity);
      }

      const parentsSet = parentSeen.get(targetId)!;
      if (!parentsSet.has(sourceId)) {
        parentsSet.add(sourceId);
        relations.get(targetId)!.parents.push(sourceEntity);
      }
    }

    for (const entity of rowEntities) {
      const rel = relations.get(entity.uuid)!;
      if (entity.parentSection && rowMap.has(entity.parentSection.uuid)) {
        rel.outer = entity.parentSection;
      } else {
        rel.outer = null;
      }
      if (entity instanceof Section) {
        rel.inner = entity.children.filter(
          (child): child is ConnectableEntity => isTableRowEntity(child) && rowMap.has(child.uuid),
        );
      }
    }

    return relations;
  }

  public toRelationItem(entity: ConnectableEntity): StageTableRelationItem {
    return {
      uuid: entity.uuid,
      label: getRowPrimaryText(entity),
      kind: getRowEntityKind(entity),
    };
  }

  private getRowImageNodes(entity: ConnectableEntity): ImageNode[] {
    if (!(entity instanceof Section)) {
      return [];
    }
    return entity.children.filter((child): child is ImageNode => child instanceof ImageNode && !child.isBackground);
  }

  public getRows(): StageTableRow[] {
    if (!this.baselineInitialized) {
      this.captureBaselineDigests();
    }
    const rowEntities = this.getRowEntities();
    const relationIndex = this.buildRelationIndex(rowEntities);

    const rows: StageTableRow[] = rowEntities.map((entity) => {
      const rel = relationIndex.get(entity.uuid)!;
      const imageNodes = this.getRowImageNodes(entity);
      const isEditableContainer = entity instanceof Section || entity instanceof TextNode;
      return {
        uuid: entity.uuid,
        entity,
        kind: getRowEntityKind(entity),
        primaryText: getRowPrimaryText(entity),
        editableText: isRowPrimaryTextEditable(entity),
        images: imageNodes.map((img) => ({ uuid: img.uuid, attachmentId: img.attachmentId })),
        canEditImages: isEditableContainer,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        parents: rel.parents.map((item) => this.toRelationItem(item)),
        children: rel.children.map((item) => this.toRelationItem(item)),
        outer: rel.outer ? this.toRelationItem(rel.outer) : null,
        inner: rel.inner.map((item) => this.toRelationItem(item)),
        canEditInner: isEditableContainer,
        tableFields: entity.tableFields,
        formulaValues: {},
      };
    });

    const evaluatedMap = evaluateTableFormulas(rows, this.project.table.columns, {
      systemColumnNames: this.project.table.systemColumnNames,
    });
    if (evaluatedMap.size > 0) {
      for (const row of rows) {
        row.formulaValues = evaluatedMap.get(row.uuid) ?? {};
      }
    }

    return rows;
  }

  private getDetailsDigest(details: unknown): string {
    if (details && typeof details === "object") {
      const cached = this.detailsJsonCache.get(details);
      if (cached !== undefined) return cached;
      const serialized = JSON.stringify(details);
      this.detailsJsonCache.set(details, serialized);
      return serialized;
    }
    return String(details ?? "");
  }

  private getFieldsDigest(fields: Record<string, TableCellValue>): string {
    const cached = this.fieldsJsonCache.get(fields);
    if (cached !== undefined) return cached;
    const keys = Object.keys(fields).sort();
    const normalized: Record<string, TableCellValue> = {};
    for (const key of keys) {
      const val = fields[key];
      normalized[key] = Array.isArray(val) ? [...val] : val;
    }
    const serialized = JSON.stringify(normalized);
    this.fieldsJsonCache.set(fields, serialized);
    return serialized;
  }

  private getEntityOwnDataDigest(entity: ConnectableEntity): string {
    if (entity instanceof TextNode || entity instanceof Section) {
      return `text:${entity.text}`;
    }
    if (entity instanceof UrlNode) {
      return `url:${entity.title}|${entity.url}`;
    }
    if (entity instanceof MediaNode) {
      return `media:${entity.title}|${entity.attachmentId}|${entity.mediaKind}`;
    }
    if (entity instanceof LatexNode) {
      return `latex:${entity.latexSource}`;
    }
    if (entity instanceof ImageNode || entity instanceof SvgNode) {
      return `asset:${entity.attachmentId}`;
    }
    if (entity instanceof ReferenceBlockNode) {
      return `ref:${entity.fileName}#${entity.sectionName}`;
    }
    if (entity instanceof ExtensionEntity) {
      return `ext:${entity.extensionId}:${entity.typeName}:${JSON.stringify(entity.customData)}`;
    }
    return "";
  }

  private computeDigestsMap(): Map<string, { entity: ConnectableEntity; digest: string }> {
    const rowEntities = this.getRowEntities();
    const relationIndex = this.buildRelationIndex(rowEntities);
    const result = new Map<string, { entity: ConnectableEntity; digest: string }>();

    for (const entity of rowEntities) {
      const rel = relationIndex.get(entity.uuid)!;
      const parentsIds = rel.parents
        .map((p) => p.uuid)
        .sort()
        .join(",");
      const childrenIds = rel.children
        .map((c) => c.uuid)
        .sort()
        .join(",");
      const outerId = rel.outer?.uuid ?? "";
      const innerIds = rel.inner
        .map((i) => i.uuid)
        .sort()
        .join(",");
      const ownData = this.getEntityOwnDataDigest(entity);
      const detailsData = this.getDetailsDigest(entity.details);
      const fieldsData = this.getFieldsDigest(entity.tableFields);
      const imagesData = this.getRowImageNodes(entity)
        .map((img) => `${img.uuid}:${img.attachmentId}`)
        .join(",");

      const digest = `${ownData}\n${detailsData}\n${fieldsData}\nIMG:${imagesData}\nP:${parentsIds}\nC:${childrenIds}\nO:${outerId}\nI:${innerIds}`;
      result.set(entity.uuid, { entity, digest });
    }

    return result;
  }

  /**
   * 在打开工程、撤销重做或远端协作快照恢复后重新建立语义基线，不改动已有 updatedAt。
   */
  public captureBaselineDigests(): void {
    this.baselineDigests.clear();
    const current = this.computeDigestsMap();
    for (const [uuid, { digest }] of current) {
      this.baselineDigests.set(uuid, digest);
    }
    this.baselineInitialized = true;
  }

  public resetAfterStageRestore(): void {
    this.captureBaselineDigests();
    this.notifyChange();
  }

  /**
   * 对比每行语义数据指纹（不含位置/尺寸/折叠状态），仅刷新数据发生变动的行的 updatedAt。
   */
  public syncSemanticTimestamps(now: number = Date.now()): boolean {
    if (!this.baselineInitialized) {
      this.captureBaselineDigests();
      return false;
    }

    const current = this.computeDigestsMap();
    let anyTimestampUpdated = false;

    for (const [uuid, { entity, digest }] of current) {
      const prevDigest = this.baselineDigests.get(uuid);
      if (prevDigest !== undefined && prevDigest !== digest) {
        entity.updatedAt = Math.trunc(now);
        anyTimestampUpdated = true;
      }
    }

    this.baselineDigests.clear();
    for (const [uuid, { digest }] of current) {
      this.baselineDigests.set(uuid, digest);
    }

    return anyTimestampUpdated;
  }

  public flushPendingTimestamps(): void {
    this.syncSemanticTimestamps();
  }

  public updateRowPrimaryText(uuid: string, nextText: string): boolean {
    const entity = this.project.stageManager.get(uuid);
    if (!entity || !isTableRowEntity(entity) || !isRowPrimaryTextEditable(entity)) {
      return false;
    }
    if (getRowPrimaryText(entity) === nextText) {
      return false;
    }

    const centerBefore = entity.collisionBox.getRectangle().center;
    if (entity instanceof TextNode) {
      entity.rename(nextText);
    } else if (entity instanceof Section) {
      entity.rename(nextText);
      if (!entity._isSyncing) {
        this.project.syncAssociationManager?.syncFrom(entity, "text");
      }
    } else if (entity instanceof UrlNode) {
      entity.rename(nextText);
    } else if (entity instanceof MediaNode) {
      entity.title = nextText;
    } else if (entity instanceof LatexNode) {
      void entity.updateLatex(nextText);
    }

    if (isPersistentMindMapDragEnabled()) {
      reflowMindMapTreesForEntities(this.project, [entity], new Map([[entity.uuid, centerBefore]]));
    }
    this.project.historyManager.recordStep();
    this.notifyChange();
    return true;
  }

  public updateRowCustomField(uuid: string, columnId: string, value: TableCellValue): boolean {
    return this.updateRowCustomFields(uuid, { [columnId]: value });
  }

  public updateRowCustomFields(uuid: string, patch: Record<string, TableCellValue>): boolean {
    const entity = this.project.stageManager.get(uuid);
    if (!entity || !isTableRowEntity(entity)) {
      return false;
    }
    const nextFields = cloneTableFields(entity.tableFields);
    let mutated = false;
    for (const [columnId, value] of Object.entries(patch)) {
      const colSchema = this.getColumnSchema(columnId);
      if (colSchema?.type === "formula") {
        continue;
      }
      if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
        if (columnId in nextFields) {
          delete nextFields[columnId];
          mutated = true;
        }
      } else {
        nextFields[columnId] = Array.isArray(value) ? [...value] : value;
        mutated = true;
      }
    }
    if (!mutated) {
      return false;
    }
    entity.tableFields = nextFields;
    this.project.historyManager.recordStep();
    this.notifyChange();
    return true;
  }

  public createRow(options?: {
    text?: string;
    tableFields?: TableFields;
    outerSectionUuid?: string | null;
  }): StageTableRow | null {
    const now = Date.now();
    const baseCenter = this.project.camera?.location?.clone?.() ?? new Vector(0, 0);
    const existingRects = this.getRowEntities().map((entity) => entity.collisionBox.getRectangle());
    let spawnLocation = new Vector(baseCenter.x - 50, baseCenter.y - 25);

    // 避免与现有节点完全重叠，最多向下错位尝试 24 次
    for (let step = 0; step < 24; step++) {
      const candidateRect = new Rectangle(spawnLocation, new Vector(140, 64));
      const collides = existingRects.some((r) => r.isCollideWith(candidateRect));
      if (!collides) break;
      spawnLocation = new Vector(spawnLocation.x + (step % 4 === 3 ? 180 : 0), spawnLocation.y + 84);
    }

    const sanitizedFields = cloneTableFields(options?.tableFields);
    for (const colId of Object.keys(sanitizedFields)) {
      const schema = this.getColumnSchema(colId);
      if (!schema || schema.type === "formula") {
        delete sanitizedFields[colId];
      }
    }

    const node = new TextNode(this.project, {
      text: options?.text ?? "",
      collisionBox: new CollisionBox([new Rectangle(spawnLocation, new Vector(100, 50))]),
      color: Color.Transparent,
      borderStyle: Settings.textNodeInitBorderStyle ?? "solid",
      createdAt: now,
      updatedAt: now,
      tableFields: sanitizedFields,
    });

    if (typeof this.project.stageManager?.add === "function") {
      this.project.stageManager.add(node);
    } else {
      this.project.stage.push(node);
    }

    if (options?.outerSectionUuid) {
      const targetOuter = this.project.stageManager.get(options.outerSectionUuid);
      if (targetOuter && isTableRowEntity(targetOuter)) {
        let targetSection: Section | null = null;
        if (targetOuter instanceof Section) {
          targetSection = targetOuter;
        } else if (targetOuter instanceof TextNode) {
          targetSection = this.promoteTextNodeToSection(targetOuter);
        }
        if (targetSection) {
          this.placeEntityInsideSection(node, targetSection);
          if (!targetSection.children.includes(node)) {
            targetSection.children.push(node);
          }
          node.parentSection = targetSection;
          targetSection.adjustLocationAndSize();
        }
      }
    }

    this.project.stageManager.updateReferences?.();
    this.project.historyManager.recordStep();
    this.notifyChange();
    return this.getRows().find((r) => r.uuid === node.uuid) ?? null;
  }

  public async addRowImages(uuid: string, blobs: Blob[]): Promise<boolean> {
    const containerEntity = this.project.stageManager.get(uuid);
    if (!containerEntity || !isTableRowEntity(containerEntity)) return false;
    if (!(containerEntity instanceof Section) && !(containerEntity instanceof TextNode)) {
      toast.warning("仅文本节点或分组框可以添加图片");
      return false;
    }
    if (
      (containerEntity instanceof Section && containerEntity.locked) ||
      this.project.sectionMethods.isObjectBeLockedBySection(containerEntity)
    ) {
      toast.warning("当前节点所在分组框已锁定，无法添加图片");
      return false;
    }

    const validBlobs = blobs.filter((blob) => blob && blob.size > 0);
    if (validBlobs.length === 0) return false;

    const preparedItems: Array<{ blob: Blob; width: number; height: number; scale: number }> = [];
    for (const blob of validBlobs) {
      let width = 240;
      let height = 180;
      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob);
        width = Math.max(1, bitmap.width);
        height = Math.max(1, bitmap.height);
        bitmap.close();
      }
      const maxDisplaySize = 280;
      const scale = Math.min(1, maxDisplaySize / Math.max(width, height));
      preparedItems.push({ blob, width, height, scale });
    }

    // 异步解码后重新校验目标实体（防止等待期间节点被删除）
    const latestEntity = this.project.stageManager.get(uuid);
    if (!latestEntity || (!(latestEntity instanceof Section) && !(latestEntity instanceof TextNode))) {
      return false;
    }

    const wasSelected = latestEntity.isSelected;
    const prevCenters = new Map<string, Vector>();
    const ancestorsBefore: Section[] = [];
    prevCenters.set(latestEntity.uuid, latestEntity.collisionBox.getRectangle().center);
    for (let parent = latestEntity.parentSection; parent; parent = parent.parentSection) {
      prevCenters.set(parent.uuid, parent.collisionBox.getRectangle().center);
      ancestorsBefore.push(parent);
    }

    const targetSection = latestEntity instanceof Section ? latestEntity : this.promoteTextNodeToSection(latestEntity);
    if (wasSelected) {
      targetSection.isSelected = true;
    }

    const syncAncestorsAndReflow = (centers: Map<string, Vector>) => {
      targetSection.adjustLocationAndSize();
      const ancestors: Section[] = [];
      for (let parent = targetSection.parentSection; parent; parent = parent.parentSection) {
        parent.adjustLocationAndSize();
        ancestors.push(parent);
      }
      if (isPersistentMindMapDragEnabled()) {
        reflowMindMapTreesForEntities(this.project, [targetSection, ...ancestors], centers);
      }
    };

    for (const item of preparedItems) {
      const attachmentId = this.project.addAttachment(item.blob);
      const displaySize = new Vector(item.width * item.scale, item.height * item.scale);
      const imageNode = new ImageNode(
        this.project,
        {
          attachmentId,
          collisionBox: new CollisionBox([new Rectangle(Vector.getZero(), displaySize)]),
          scale: item.scale,
        },
        false,
        () => {
          const liveSection = this.project.stageManager.get(targetSection.uuid);
          if (liveSection instanceof Section) {
            const beforeSize = liveSection.collisionBox.getRectangle().size.clone();
            const readyCenters = new Map<string, Vector>([
              [liveSection.uuid, liveSection.collisionBox.getRectangle().center],
            ]);
            const readyAncestors: Section[] = [];
            for (let parent = liveSection.parentSection; parent; parent = parent.parentSection) {
              readyCenters.set(parent.uuid, parent.collisionBox.getRectangle().center);
              readyAncestors.push(parent);
            }
            liveSection.adjustLocationAndSize();
            for (const ancestor of readyAncestors) {
              ancestor.adjustLocationAndSize();
            }
            const afterSize = liveSection.collisionBox.getRectangle().size;
            if (
              isPersistentMindMapDragEnabled() &&
              (Math.abs(afterSize.x - beforeSize.x) > 0.5 || Math.abs(afterSize.y - beforeSize.y) > 0.5)
            ) {
              reflowMindMapTreesForEntities(this.project, [liveSection, ...readyAncestors], readyCenters);
            }
          }
          this.notifyChange();
        },
      );
      this.placeEntityInsideSection(imageNode, targetSection);
      this.project.stageManager.add(imageNode, true);
      this.project.sectionInOutManager.attachEntityToSection(imageNode, targetSection);
      targetSection.adjustLocationAndSize();
    }

    this.project.stageManager.updateReferences();
    syncAncestorsAndReflow(prevCenters);
    if (ancestorsBefore.length > 0) {
      this.project.stageManager.updateReferences();
    }
    this.project.historyManager.recordStep();
    this.notifyChange();
    return true;
  }

  public removeRowImage(rowUuid: string, imageNodeUuid: string): boolean {
    const containerEntity = this.project.stageManager.get(rowUuid);
    if (!(containerEntity instanceof Section)) return false;

    if (containerEntity.locked || this.project.sectionMethods.isObjectBeLockedBySection(containerEntity)) {
      toast.warning("当前分组框已锁定，无法移除图片");
      return false;
    }

    const imageNode = containerEntity.children.find(
      (child): child is ImageNode => child instanceof ImageNode && child.uuid === imageNodeUuid,
    );
    if (!imageNode) return false;

    const prevCenter = containerEntity.collisionBox.getRectangle().center;
    this.project.deleteManager.deleteEntities([imageNode]);

    const currentContainer = this.project.stageManager.get(rowUuid);
    if (currentContainer instanceof Section) {
      if (currentContainer.children.length === 0) {
        this.demoteSectionToTextNode(currentContainer);
      } else {
        currentContainer.adjustLocationAndSize();
      }
    }

    if (isPersistentMindMapDragEnabled()) {
      const liveContainer = this.project.stageManager.get(rowUuid);
      if (liveContainer instanceof Entity) {
        reflowMindMapTreesForEntities(this.project, [liveContainer], new Map([[rowUuid, prevCenter]]));
      }
    }
    this.project.historyManager.recordStep();
    this.notifyChange();
    return true;
  }

  public setRowParents(uuid: string, nextParentUUIDs: string[]): boolean {
    const entity = this.project.stageManager.get(uuid);
    if (!entity || !isTableRowEntity(entity)) return false;

    const targetSet = new Set(nextParentUUIDs.filter((id) => id !== uuid));
    const currentEdges = this.project.stageManager
      .getEdges()
      .filter((edge) => edge.target.uuid === uuid && edge.source.uuid !== uuid && isTableRowEntity(edge.source));

    const currentParentIds = new Set(currentEdges.map((edge) => edge.source.uuid));
    const affectedEntities: Entity[] = [entity];
    let changed = false;

    for (const edge of currentEdges) {
      if (!targetSet.has(edge.source.uuid)) {
        const deleted = this.project.deleteManager.deleteEdge(edge);
        if (!deleted && this.project.sectionMethods.isObjectBeLockedBySection(edge)) {
          toast.warning("连线端点位于锁定的分组框内，无法移除");
        } else if (deleted) {
          affectedEntities.push(edge.source);
          changed = true;
        }
      }
    }

    for (const parentId of targetSet) {
      if (currentParentIds.has(parentId)) continue;
      const parentEntity = this.project.stageManager.get(parentId);
      if (parentEntity && isTableRowEntity(parentEntity)) {
        this.project.nodeConnector.connectConnectableEntity(parentEntity, entity);
        affectedEntities.push(parentEntity);
        changed = true;
      }
    }

    if (changed) {
      if (isPersistentMindMapDragEnabled()) {
        reflowMindMapTreesForEntities(this.project, affectedEntities);
      }
      this.project.historyManager.recordStep();
      this.notifyChange();
    }
    return changed;
  }

  public setRowChildren(uuid: string, nextChildUUIDs: string[]): boolean {
    const entity = this.project.stageManager.get(uuid);
    if (!entity || !isTableRowEntity(entity)) return false;

    const targetSet = new Set(nextChildUUIDs.filter((id) => id !== uuid));
    const currentEdges = this.project.stageManager
      .getEdges()
      .filter((edge) => edge.source.uuid === uuid && edge.target.uuid !== uuid && isTableRowEntity(edge.target));

    const currentChildIds = new Set(currentEdges.map((edge) => edge.target.uuid));
    const affectedEntities: Entity[] = [entity];
    let changed = false;

    for (const edge of currentEdges) {
      if (!targetSet.has(edge.target.uuid)) {
        const deleted = this.project.deleteManager.deleteEdge(edge);
        if (!deleted && this.project.sectionMethods.isObjectBeLockedBySection(edge)) {
          toast.warning("连线端点位于锁定的分组框内，无法移除");
        } else if (deleted) {
          affectedEntities.push(edge.target);
          changed = true;
        }
      }
    }

    for (const childId of targetSet) {
      if (currentChildIds.has(childId)) continue;
      const childEntity = this.project.stageManager.get(childId);
      if (childEntity && isTableRowEntity(childEntity)) {
        this.project.nodeConnector.connectConnectableEntity(entity, childEntity);
        affectedEntities.push(childEntity);
        changed = true;
      }
    }

    if (changed) {
      if (isPersistentMindMapDragEnabled()) {
        reflowMindMapTreesForEntities(this.project, affectedEntities);
      }
      this.project.historyManager.recordStep();
      this.notifyChange();
    }
    return changed;
  }

  /**
   * 在不触发同级实体碰撞挤飞的前提下，将实体（含子孙）平移到目标左上角位置。
   */
  private relocateEntityCleanly(entity: Entity, targetLeftTop: Vector): void {
    const currentRect = entity.collisionBox.getRectangle();
    const delta = targetLeftTop.subtract(currentRect.location);
    if (delta.x === 0 && delta.y === 0) return;

    this.project.sectionMoveDepth++;
    try {
      entity.move(delta);
    } finally {
      this.project.sectionMoveDepth--;
    }
  }

  private placeEntityInsideSection(entity: Entity, section: Section): void {
    const sectionRect = section.collisionBox.getRectangle();
    const entityRect = entity.collisionBox.getRectangle();

    const isAlreadyInside =
      section.children.includes(entity) ||
      (section.children.length > 0 &&
        entityRect.left >= sectionRect.left &&
        entityRect.right <= sectionRect.right &&
        entityRect.top >= sectionRect.top &&
        entityRect.bottom <= sectionRect.bottom);

    if (isAlreadyInside) return;

    const existingChildren = section.children.filter((child) => child.uuid !== entity.uuid);
    let targetLocation: Vector;
    if (existingChildren.length === 0) {
      const titleOffset = section.text === "" ? 30 : 80;
      targetLocation = new Vector(sectionRect.left + 30, sectionRect.top + titleOffset);
    } else {
      const bounds = Rectangle.getBoundingRectangle(existingChildren.map((child) => child.collisionBox.getRectangle()));
      targetLocation = new Vector(bounds.right + 40, bounds.top);
    }
    this.relocateEntityCleanly(entity, targetLocation);
  }

  private placeEntityOutsideRect(entity: Entity, containerRect: Rectangle): void {
    const entityRect = entity.collisionBox.getRectangle();
    if (!containerRect.isCollideWith(entityRect)) {
      return;
    }
    this.relocateEntityCleanly(entity, new Vector(containerRect.right + 48, containerRect.top));
  }

  /**
   * 将 TextNode 原地无损升级为相同 uuid 的 Section，继承创建时间、自定义属性及全部连线与孪生关联。
   */
  public promoteTextNodeToSection(textNode: TextNode): Section {
    const fatherSection = textNode.parentSection;
    const textRect = textNode.collisionBox.getRectangle().clone();
    const newSection = new Section(this.project, {
      uuid: textNode.uuid,
      text: textNode.text,
      collisionBox: new CollisionBox([textRect]),
      color: textNode.color.clone(),
      details: textNode.details,
      borderStyle: Settings.sectionInitBorderStyle,
      createdAt: textNode.createdAt,
      updatedAt: textNode.updatedAt,
      tableFields: textNode.tableFields,
    });

    const stageIndex = this.project.stage.indexOf(textNode);
    if (stageIndex !== -1) {
      this.project.stage[stageIndex] = newSection;
    } else {
      this.project.stage.push(newSection);
    }

    if (fatherSection) {
      const childIdx = fatherSection.children.indexOf(textNode);
      if (childIdx !== -1) {
        fatherSection.children[childIdx] = newSection;
      } else {
        fatherSection.children.push(newSection);
      }
      newSection.parentSection = fatherSection;
    }

    this.rewireAssociations(textNode, newSection);
    this.project.stageManager.updateReferences();
    return newSection;
  }

  /**
   * 将空 Section 原地无损降级为相同 uuid 的 TextNode，继承创建时间、自定义属性及全部连线与孪生关联。
   */
  public demoteSectionToTextNode(section: Section): TextNode {
    const fatherSection = section.parentSection;
    const sectionRect = section.collisionBox.getRectangle().clone();
    const textNode = new TextNode(this.project, {
      uuid: section.uuid,
      text: section.text,
      details: section.details,
      collisionBox: new CollisionBox([new Rectangle(sectionRect.location.clone(), sectionRect.size.clone())]),
      color: section.color.clone(),
      borderStyle: section.borderStyle,
      createdAt: section.createdAt,
      updatedAt: section.updatedAt,
      tableFields: section.tableFields,
    });

    const stageIndex = this.project.stage.indexOf(section);
    if (stageIndex !== -1) {
      this.project.stage[stageIndex] = textNode;
    } else {
      this.project.stage.push(textNode);
    }

    if (fatherSection) {
      const childIdx = fatherSection.children.indexOf(section);
      if (childIdx !== -1) {
        fatherSection.children[childIdx] = textNode;
      } else {
        fatherSection.children.push(textNode);
      }
      textNode.parentSection = fatherSection;
    }

    this.rewireAssociations(section, textNode);
    this.project.stageManager.updateReferences();
    return textNode;
  }

  private rewireAssociations(fromEntity: ConnectableEntity, toEntity: ConnectableEntity): void {
    for (const association of this.project.stageManager.getAssociations()) {
      if (association instanceof Edge) {
        if (association.source === fromEntity || association.source.uuid === fromEntity.uuid) {
          association.source = toEntity;
        }
        if (association.target === fromEntity || association.target.uuid === fromEntity.uuid) {
          association.target = toEntity;
        }
      } else if (association instanceof MultiTargetUndirectedEdge || association instanceof SyncAssociation) {
        for (let i = 0; i < association.associationList.length; i++) {
          const item = association.associationList[i];
          if (item === fromEntity || item.uuid === fromEntity.uuid) {
            association.associationList[i] = toEntity;
          }
        }
      }
    }
  }

  public setRowOuter(uuid: string, nextOuterUUID: string | null): boolean {
    const entity = this.project.stageManager.get(uuid);
    if (!entity || !isTableRowEntity(entity)) return false;

    const currentOuter = entity.parentSection;
    if ((currentOuter?.uuid ?? null) === nextOuterUUID) {
      return false;
    }

    if (
      this.project.sectionMethods.isObjectBeLockedBySection(entity) &&
      !(entity instanceof Section && entity.locked)
    ) {
      toast.warning("当前节点所在分组框已锁定，无法修改外节点关系");
      return false;
    }

    if (nextOuterUUID === null) {
      if (!currentOuter) return false;
      const prevCenter = currentOuter.collisionBox.getRectangle().center;
      const outermostList = this.project.sectionMethods.getFatherSectionsList(entity);
      const outermostRect = outermostList[outermostList.length - 1].collisionBox.getRectangle().clone();
      this.project.sectionInOutManager.goOutSection([entity], currentOuter);
      this.placeEntityOutsideRect(entity, outermostRect);
      this.project.stageManager.updateReferences();
      if (isPersistentMindMapDragEnabled()) {
        reflowMindMapTreesForEntities(this.project, [currentOuter], new Map([[currentOuter.uuid, prevCenter]]));
      }
      this.project.historyManager.recordStep();
      this.notifyChange();
      return true;
    }

    if (nextOuterUUID === uuid) {
      toast.warning("节点不能将自身设为外节点");
      return false;
    }

    const rawTarget = this.project.stageManager.get(nextOuterUUID);
    if (!rawTarget || !isTableRowEntity(rawTarget)) return false;

    if (entity instanceof Section && this.project.sectionMethods.isEntityInSection(rawTarget, entity)) {
      toast.warning("不能将外层分组框放入其内部节点中");
      return false;
    }

    let targetSection: Section;
    if (rawTarget instanceof Section) {
      if (rawTarget.locked || this.project.sectionMethods.isObjectBeLockedBySection(rawTarget)) {
        toast.warning("目标分组框已锁定，无法移入");
        return false;
      }
      targetSection = rawTarget;
    } else if (rawTarget instanceof TextNode) {
      if (this.project.sectionMethods.isObjectBeLockedBySection(rawTarget)) {
        toast.warning("目标节点所在分组框已锁定，无法移入");
        return false;
      }
      targetSection = this.promoteTextNodeToSection(rawTarget);
    } else {
      toast.warning("仅文本节点或分组框可以作为外节点容器");
      return false;
    }

    const prevCenters = new Map<string, Vector>([
      [targetSection.uuid, targetSection.collisionBox.getRectangle().center],
    ]);
    if (currentOuter && currentOuter !== targetSection) {
      prevCenters.set(currentOuter.uuid, currentOuter.collisionBox.getRectangle().center);
      this.project.sectionInOutManager.goOutSection([entity], currentOuter);
    }

    this.placeEntityInsideSection(entity, targetSection);
    this.project.sectionInOutManager.goInSection([entity], targetSection);
    if (isPersistentMindMapDragEnabled()) {
      reflowMindMapTreesForEntities(this.project, [targetSection, currentOuter], prevCenters);
    }
    this.project.historyManager.recordStep();
    this.notifyChange();
    return true;
  }

  public setRowInner(uuid: string, nextInnerUUIDs: string[]): boolean {
    const containerEntity = this.project.stageManager.get(uuid);
    if (!containerEntity || !isTableRowEntity(containerEntity)) return false;
    if (!(containerEntity instanceof Section) && !(containerEntity instanceof TextNode)) {
      toast.warning("仅文本节点或分组框可以包含内节点");
      return false;
    }
    if (
      (containerEntity instanceof Section && containerEntity.locked) ||
      this.project.sectionMethods.isObjectBeLockedBySection(containerEntity)
    ) {
      toast.warning("当前分组框已锁定，无法修改内节点");
      return false;
    }

    const targetIds = Array.from(new Set(nextInnerUUIDs.filter((id) => id !== uuid)));
    const validTargets: ConnectableEntity[] = [];

    for (const childId of targetIds) {
      const candidate = this.project.stageManager.get(childId);
      if (!candidate || !isTableRowEntity(candidate)) continue;
      if (candidate instanceof Section && this.project.sectionMethods.isEntityInSection(containerEntity, candidate)) {
        toast.warning("不能将外层分组框设为内部节点");
        return false;
      }
      if (
        this.project.sectionMethods.isObjectBeLockedBySection(candidate) &&
        !(candidate instanceof Section && candidate.locked)
      ) {
        toast.warning("部分目标节点所在分组框已锁定，无法移入");
        return false;
      }
      validTargets.push(candidate);
    }

    if (containerEntity instanceof TextNode) {
      if (validTargets.length === 0) return false;
      const promotedSection = this.promoteTextNodeToSection(containerEntity);
      for (const child of validTargets) {
        if (child.parentSection && child.parentSection !== promotedSection) {
          this.project.sectionInOutManager.goOutSection([child], child.parentSection);
        }
        this.placeEntityInsideSection(child, promotedSection);
        this.project.sectionInOutManager.goInSection([child], promotedSection);
      }
      this.project.historyManager.recordStep();
      this.notifyChange();
      return true;
    }

    const currentInner = containerEntity.children.filter(isTableRowEntity);
    const nextSet = new Set(validTargets.map((item) => item.uuid));
    const currentSet = new Set(currentInner.map((item) => item.uuid));

    const toRemove = currentInner.filter((item) => !nextSet.has(item.uuid));
    const toAdd = validTargets.filter((item) => !currentSet.has(item.uuid));
    if (toRemove.length === 0 && toAdd.length === 0) {
      return false;
    }

    const sectionRectBefore = containerEntity.collisionBox.getRectangle().clone();
    const outerParent = containerEntity.parentSection;
    const prevCenters = new Map<string, Vector>([[containerEntity.uuid, sectionRectBefore.center]]);
    const affectedContainers = new Set<Entity>([containerEntity]);
    if (outerParent) {
      affectedContainers.add(outerParent);
      prevCenters.set(outerParent.uuid, outerParent.collisionBox.getRectangle().center);
    }

    for (const child of toAdd) {
      if (child.parentSection && child.parentSection !== containerEntity) {
        affectedContainers.add(child.parentSection);
        prevCenters.set(child.parentSection.uuid, child.parentSection.collisionBox.getRectangle().center);
        this.project.sectionInOutManager.goOutSection([child], child.parentSection);
      }
      this.placeEntityInsideSection(child, containerEntity);
      this.project.sectionInOutManager.goInSection([child], containerEntity);
    }

    for (const removed of toRemove) {
      const stillExistsSection = this.project.stageManager.get(uuid);
      if (stillExistsSection instanceof Section) {
        this.project.sectionInOutManager.goOutSection([removed], stillExistsSection);
      }
      this.placeEntityOutsideRect(removed, sectionRectBefore);
      if (outerParent && this.project.stage.includes(outerParent)) {
        this.project.sectionInOutManager.goInSection([removed], outerParent);
      }
    }

    this.project.stageManager.updateReferences();
    if (isPersistentMindMapDragEnabled()) {
      reflowMindMapTreesForEntities(this.project, affectedContainers, prevCenters);
    }
    this.project.historyManager.recordStep();
    this.notifyChange();
    return true;
  }

  /**
   * 选中画布上与多维表格指定行对应的节点（支持单选与多选），并确保它们在画布视野中可见。
   */
  public selectRowsOnCanvas(
    uuids: string[],
    options: { focusCamera?: boolean; alwaysCenterSingle?: boolean; panelWidthPx?: number } = {},
  ): void {
    const seen = new Set<string>();
    const targets: ConnectableEntity[] = [];
    for (const uuid of uuids) {
      if (seen.has(uuid)) continue;
      seen.add(uuid);
      const entity = this.project.stageManager.get(uuid);
      if (entity && isTableRowEntity(entity)) {
        targets.push(entity);
      }
    }

    let expandedSection = false;
    for (const entity of targets) {
      let ancestor = entity.parentSection;
      while (ancestor) {
        if (ancestor.isCollapsed) {
          ancestor.isCollapsed = false;
          expandedSection = true;
        }
        ancestor = ancestor.parentSection;
      }
    }
    if (expandedSection) {
      this.project.stageManager.updateReferences();
    }

    this.suppressCanvasSelectionSync = true;
    try {
      this.project.stageManager.clearSelectAll();
      for (const entity of targets) {
        entity.isSelected = true;
      }
    } finally {
      this.suppressCanvasSelectionSync = false;
    }

    const shouldFocusCamera =
      options.focusCamera !== undefined ? options.focusCamera : (Settings.stageTableAutoFocusCanvasOnSelect ?? true);

    if (shouldFocusCamera && targets.length > 0) {
      const rects = targets.map((entity) => entity.collisionBox.getRectangle());
      const boundingRect = Rectangle.getBoundingRectangle(rects);
      const scale = this.project.camera.currentScale || 1;
      const viewWidth = this.project.renderer?.w ?? 0;
      const viewHeight = this.project.renderer?.h ?? 0;
      const panelWidthPx = options.panelWidthPx ?? 0;
      const effectivePanelWidth = panelWidthPx > 0 && viewWidth > panelWidthPx + 80 ? panelWidthPx : 0;

      if (targets.length === 1) {
        const cameraTarget = new Vector(
          boundingRect.center.x + effectivePanelWidth / (2 * scale),
          boundingRect.center.y,
        );
        this.project.camera.bombMove(cameraTarget, 24);
      } else {
        const fitsCurrentScale =
          viewWidth > 0 &&
          viewHeight > 0 &&
          boundingRect.size.x * scale <= viewWidth * 0.85 &&
          boundingRect.size.y * scale <= viewHeight * 0.85;
        if (fitsCurrentScale || typeof this.project.camera.resetByRectangle !== "function") {
          const cameraTarget = new Vector(
            boundingRect.center.x + effectivePanelWidth / (2 * scale),
            boundingRect.center.y,
          );
          this.project.camera.bombMove(cameraTarget, 24);
        } else {
          this.project.camera.resetByRectangle(boundingRect);
        }
      }

      const highlightColor = this.project.stageStyleManager?.currentStyle.CollideBoxSelected ?? Color.Green;
      const effectCount = Math.min(rects.length, 30);
      for (let i = 0; i < effectCount; i++) {
        this.project.effects?.addEffect(new RectangleNoteEffect(new ProgressNumber(0, 45), rects[i], highlightColor));
      }
    }

    this.project.loop?.();
  }

  /**
   * 将画布镜头聚焦到指定行对应的节点，并按扣除右侧表格宽度后的左侧可视区中心对齐。
   */
  public focusRowOnCanvas(uuid: string, panelWidthPx: number = 0): void {
    const entity = this.project.stageManager.get(uuid);
    if (!entity || !isTableRowEntity(entity)) return;
    this.selectRowsOnCanvas([uuid], {
      focusCamera: true,
      alwaysCenterSingle: true,
      panelWidthPx,
    });
    this.scheduleCanvasSelectionSync();
  }
}
