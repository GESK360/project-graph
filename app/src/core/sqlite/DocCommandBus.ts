import type { Project } from "@/core/Project";
import { ProjectState } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { Association } from "@/core/stage/stageObject/abstract/Association";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { ArcEdge } from "@/core/stage/stageObject/association/ArcEdge";
import { CubicCatmullRomSplineEdge } from "@/core/stage/stageObject/association/CubicCatmullRomSplineEdge";
import { Edge } from "@/core/stage/stageObject/association/Edge";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { MultiTargetUndirectedEdge } from "@/core/stage/stageObject/association/MutiTargetUndirectedEdge";
import { SyncAssociation } from "@/core/stage/stageObject/association/SyncAssociation";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { cloneTableFields, type PrgTableData, type TableCellValue } from "@/types/table";
import {
  DocClient,
  type CellMutationItem,
  type ChangeSource,
  type DocChangeSet,
  type DocCommand,
  type EntityBoundsItem,
  type EntityMoveItem,
  type HistoryStateInfo,
  type ReparentItem,
  type SectionChildOrderPatch,
  type V3AssociationRecord,
  type V3CellKey,
  type V3CellValueRecord,
  type V3EdgeRecord,
  type V3EntityRecord,
  type V3TableColumnRecord,
  type V3TableViewRecord,
} from "./DocClient";
import { applyDocChangeSet } from "./V3PatchApplier";
import {
  serializeAssociationToV3Record,
  serializeCellValueToV3Record,
  serializeColumnToV3Record,
  serializeEdgeToV3Record,
  serializeEntityToV3Record,
  serializeTableMetaJson,
  serializeViewToV3Record,
} from "./V3Serializer";

const DEFAULT_LOCAL_HISTORY_LIMIT = 500;

interface LocalEntityBaseline {
  record: V3EntityRecord;
  tableFields: Record<string, TableCellValue>;
}

interface LocalHistoryStep {
  label: string;
  undoChangeSet: DocChangeSet;
  redoChangeSet: DocChangeSet;
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function collectSectionOrderAndBounds(
  project: Project,
  sectionUuids: Iterable<string>,
): { sectionChildOrders: SectionChildOrderPatch[]; sectionBounds: EntityBoundsItem[] } {
  const sectionChildOrders: SectionChildOrderPatch[] = [];
  const sectionBounds: EntityBoundsItem[] = [];
  const seen = new Set<string>();
  for (const secUuid of sectionUuids) {
    if (!secUuid || seen.has(secUuid)) continue;
    seen.add(secUuid);
    const sec = project.stageManager.get(secUuid);
    if (!(sec instanceof Section)) continue;
    sectionChildOrders.push({
      sectionUuid: sec.uuid,
      childOrder: sec.children.map((c) => c.uuid),
    });
    const rec = serializeEntityToV3Record(sec, 0);
    if (rec) {
      sectionBounds.push({ uuid: rec.uuid, x: rec.x, y: rec.y, w: rec.w, h: rec.h });
    }
  }
  return { sectionChildOrders, sectionBounds };
}

/**
 * 统一 CQRS 增量命令总线：
 * 1. 维护 O(dirty) 脏追踪集合，彻底替代全图 `serialize(project.stage)` 与 `syncSemanticTimestamps()`；
 * 2. 在桌面端 `.prg v3.0.0` 及临时草稿 SQLite 下，串行派发最小 `DocCommand[]` 到 Rust SQLite WAL 并由 `history_ops` 托管行级 Undo/Redo；
 * 3. 在非 Tauri / Vitest 单元测试环境下，自动退化为同步行级内存增量日志（同样零全图序列化、仅保存受影响行）。
 */
export class DocCommandBus {
  public static readonly id = "docCommandBus";
  private writeQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private suppressTracking = false;
  private debouncedCommitTimer: ReturnType<typeof setTimeout> | null = null;
  private debouncedCommitOptions: { label?: string; recordHistory?: boolean } | null = null;

  // ── O(dirty) 增量脏追踪集合（服务所有画布控制器与 recordStep() 调用点）──
  private readonly addedUuids = new Set<string>();
  private readonly deletedEntities = new Map<
    string,
    { record: V3EntityRecord; tableFields: Record<string, TableCellValue> }
  >();
  private readonly deletedEdges = new Map<string, V3EdgeRecord>();
  private readonly deletedAssociations = new Map<string, V3AssociationRecord>();
  private readonly replacedOldEntities = new Map<
    string,
    { record: V3EntityRecord; tableFields: Record<string, TableCellValue> }
  >();
  private readonly geometryDirtyUuids = new Set<string>();
  private readonly semanticDirtyUuids = new Set<string>();
  private readonly styleDirtyUuids = new Set<string>();
  private readonly collapseDirtyUuids = new Set<string>();
  private readonly reparentDirty = new Map<string, { oldParentUuid: string | null; newParentUuid: string | null }>();
  private readonly edgeTopologyDirty = new Map<string, { oldSourceUuid: string; oldTargetUuid: string }>();
  private readonly edgeStyleDirtyUuids = new Set<string>();
  private readonly associationDirtyUuids = new Set<string>();
  private readonly cellDirtyKeys = new Map<string, { touchUpdatedAt: boolean; colIds: Set<string> }>();
  private schemaDirty = false;
  private metadataDirty = false;

  // ── 轻量行级增量基线（仅在非 SQLite / Vitest 本地回退模式下用于同步 row-level undo/redo）──
  private localBaselineReady = false;
  private readonly localEntityBaseline = new Map<string, LocalEntityBaseline>();
  private readonly localEdgeBaseline = new Map<string, V3EdgeRecord>();
  private readonly localAssocBaseline = new Map<string, V3AssociationRecord>();
  private localTableSnapshot: PrgTableData | null = null;
  private localTagsSnapshot: string[] = [];
  private localHistory: LocalHistoryStep[] = [];
  private localHistoryIndex = -1;
  private localRevision = 0;

  private remoteHistoryState: HistoryStateInfo = {
    canUndo: false,
    canRedo: false,
    undoCursor: 0,
    totalEntries: 0,
  };

  constructor(private readonly project: Project) {}

  public get isSuppressingTracking(): boolean {
    return this.suppressTracking;
  }

  public setSuppressTracking(suppress: boolean): void {
    this.suppressTracking = suppress;
  }

  private get usesSqliteBackend(): boolean {
    return this.project.isSqliteV3 && Boolean(this.project.v3DocId) && DocClient.isAvailable();
  }

  // ── 脏追踪钩子（均 O(1)，严禁在 120 FPS 渲染循环内发任何 IPC）──

  public notifyObjectAdded(obj: StageObject): void {
    if (this.suppressTracking) return;
    this.addedUuids.add(obj.uuid);
    this.deletedEntities.delete(obj.uuid);
    this.deletedEdges.delete(obj.uuid);
    this.deletedAssociations.delete(obj.uuid);
  }

  public notifyObjectDeleted(obj: StageObject): void {
    if (this.suppressTracking) return;
    if (this.addedUuids.has(obj.uuid)) {
      this.addedUuids.delete(obj.uuid);
      this.geometryDirtyUuids.delete(obj.uuid);
      this.semanticDirtyUuids.delete(obj.uuid);
      this.styleDirtyUuids.delete(obj.uuid);
      this.collapseDirtyUuids.delete(obj.uuid);
      this.reparentDirty.delete(obj.uuid);
      this.edgeStyleDirtyUuids.delete(obj.uuid);
      this.edgeTopologyDirty.delete(obj.uuid);
      this.associationDirtyUuids.delete(obj.uuid);
      this.cellDirtyKeys.delete(obj.uuid);
      return;
    }
    const order = Math.max(0, this.project.stage.indexOf(obj));
    if (obj instanceof Entity) {
      const rec = serializeEntityToV3Record(obj, order);
      if (rec) {
        this.deletedEntities.set(obj.uuid, { record: rec, tableFields: cloneTableFields(obj.tableFields) });
      }
    } else if (obj instanceof LineEdge || obj instanceof ArcEdge || obj instanceof CubicCatmullRomSplineEdge) {
      const rec = serializeEdgeToV3Record(obj, order);
      if (rec) this.deletedEdges.set(obj.uuid, rec);
    } else if (obj instanceof MultiTargetUndirectedEdge || obj instanceof SyncAssociation) {
      this.deletedAssociations.set(obj.uuid, serializeAssociationToV3Record(obj, order));
    }
  }

  public notifyObjectReplaced(oldObj: StageObject, newObj?: StageObject): void {
    void newObj;
    if (this.suppressTracking) return;
    if (oldObj instanceof Entity && !this.replacedOldEntities.has(oldObj.uuid)) {
      const order = Math.max(0, this.project.stage.indexOf(oldObj));
      const rec = serializeEntityToV3Record(oldObj, order);
      if (rec) {
        this.replacedOldEntities.set(oldObj.uuid, {
          record: rec,
          tableFields: cloneTableFields(oldObj.tableFields),
        });
      }
    }
  }

  public markGeometryDirty(entity: Entity): void {
    if (this.suppressTracking) return;
    this.geometryDirtyUuids.add(entity.uuid);
  }

  public markSemanticDirty(entity: Entity): void {
    if (this.suppressTracking) return;
    this.semanticDirtyUuids.add(entity.uuid);
  }

  public markStyleDirty(entity: Entity): void {
    if (this.suppressTracking) return;
    this.styleDirtyUuids.add(entity.uuid);
  }

  public markCollapseDirty(section: Section): void {
    if (this.suppressTracking) return;
    this.collapseDirtyUuids.add(section.uuid);
  }

  public markReparent(entity: Entity, oldParent: Section | null, newParent: Section | null): void {
    if (this.suppressTracking) return;
    const prev = this.reparentDirty.get(entity.uuid);
    this.reparentDirty.set(entity.uuid, {
      oldParentUuid: prev ? prev.oldParentUuid : (oldParent?.uuid ?? null),
      newParentUuid: newParent?.uuid ?? null,
    });
  }

  public markEdgeTopologyDirty(edge: Edge, oldSourceUuid: string, oldTargetUuid: string): void {
    if (this.suppressTracking) return;
    if (!this.edgeTopologyDirty.has(edge.uuid)) {
      this.edgeTopologyDirty.set(edge.uuid, { oldSourceUuid, oldTargetUuid });
    }
  }

  public markEdgeStyleDirty(edge: Edge): void {
    if (this.suppressTracking) return;
    this.edgeStyleDirtyUuids.add(edge.uuid);
  }

  public markAssociationDirty(assoc: Association): void {
    if (this.suppressTracking) return;
    this.associationDirtyUuids.add(assoc.uuid);
  }

  public markCellsDirty(entityUuid: string, colIds: Iterable<string>, touchUpdatedAt: boolean): void {
    if (this.suppressTracking) return;
    let entry = this.cellDirtyKeys.get(entityUuid);
    if (!entry) {
      entry = { touchUpdatedAt, colIds: new Set() };
      this.cellDirtyKeys.set(entityUuid, entry);
    } else if (touchUpdatedAt) {
      entry.touchUpdatedAt = true;
    }
    for (const id of colIds) {
      entry.colIds.add(id);
    }
  }

  public markSchemaDirty(): void {
    if (this.suppressTracking) return;
    this.schemaDirty = true;
  }

  public markMetadataDirty(): void {
    if (this.suppressTracking) return;
    this.metadataDirty = true;
  }

  public clearDirtySets(): void {
    this.addedUuids.clear();
    this.deletedEntities.clear();
    this.deletedEdges.clear();
    this.deletedAssociations.clear();
    this.replacedOldEntities.clear();
    this.geometryDirtyUuids.clear();
    this.semanticDirtyUuids.clear();
    this.styleDirtyUuids.clear();
    this.collapseDirtyUuids.clear();
    this.reparentDirty.clear();
    this.edgeTopologyDirty.clear();
    this.edgeStyleDirtyUuids.clear();
    this.associationDirtyUuids.clear();
    this.cellDirtyKeys.clear();
    this.schemaDirty = false;
    this.metadataDirty = false;
  }

  public hasPendingDirty(): boolean {
    return (
      this.addedUuids.size > 0 ||
      this.deletedEntities.size > 0 ||
      this.deletedEdges.size > 0 ||
      this.deletedAssociations.size > 0 ||
      this.replacedOldEntities.size > 0 ||
      this.geometryDirtyUuids.size > 0 ||
      this.semanticDirtyUuids.size > 0 ||
      this.styleDirtyUuids.size > 0 ||
      this.collapseDirtyUuids.size > 0 ||
      this.reparentDirty.size > 0 ||
      this.edgeTopologyDirty.size > 0 ||
      this.edgeStyleDirtyUuids.size > 0 ||
      this.associationDirtyUuids.size > 0 ||
      this.cellDirtyKeys.size > 0 ||
      this.schemaDirty ||
      this.metadataDirty
    );
  }

  /**
   * 重置本地增量基线与历史游标（在打开文档或显式 `clearHistory()` 时调用）。
   */
  public resetBaseline(options: { clearRemoteHistory?: boolean } = {}): void {
    this.clearDirtySets();
    this.localHistory = [];
    this.localHistoryIndex = -1;
    this.localBaselineReady = false;
    this.localEntityBaseline.clear();
    this.localEdgeBaseline.clear();
    this.localAssocBaseline.clear();
    this.localTableSnapshot = null;
    this.localTagsSnapshot = [];

    if (!this.usesSqliteBackend) {
      this.ensureLocalBaseline();
    } else if (options.clearRemoteHistory && this.project.v3DocId) {
      const docId = this.project.v3DocId;
      this.writeQueue = this.writeQueue.then(async () => {
        if (this.disposed || !this.usesSqliteBackend) return;
        this.remoteHistoryState = await DocClient.clearHistory(docId);
      });
    }
  }

  private ensureLocalBaseline(): void {
    if (this.localBaselineReady) return;
    this.localEntityBaseline.clear();
    this.localEdgeBaseline.clear();
    this.localAssocBaseline.clear();

    for (let i = 0; i < this.project.stage.length; i++) {
      const obj = this.project.stage[i];
      if (obj instanceof Entity) {
        const rec = serializeEntityToV3Record(obj, i);
        if (rec) {
          this.localEntityBaseline.set(obj.uuid, {
            record: rec,
            tableFields: cloneTableFields(obj.tableFields),
          });
        }
      } else if (obj instanceof LineEdge || obj instanceof ArcEdge || obj instanceof CubicCatmullRomSplineEdge) {
        const rec = serializeEdgeToV3Record(obj, i);
        if (rec) this.localEdgeBaseline.set(obj.uuid, rec);
      } else if (obj instanceof MultiTargetUndirectedEdge || obj instanceof SyncAssociation) {
        this.localAssocBaseline.set(obj.uuid, serializeAssociationToV3Record(obj, i));
      }
    }
    this.localTableSnapshot = structuredClone(this.project.table);
    this.localTagsSnapshot = [...(this.project.tags ?? [])];
    this.localBaselineReady = true;
  }

  /**
   * 显式派发最小 `DocCommand[]`（供 `StageTableService` 等结构化调用方直接走强类型 CQRS 通道）。
   */
  public dispatchCommands(
    commands: DocCommand[],
    options: {
      label?: string;
      recordHistory?: boolean;
      nowMs?: number;
      emitStageCommit?: boolean;
      touchedEntityUuidsForLocalSnapshot?: string[];
    } = {},
  ): void {
    if (commands.length === 0) return;
    const nowMs = Math.trunc(options.nowMs ?? Date.now());
    const label = options.label ?? "";
    const recordHistory = options.recordHistory !== false;

    this.applyLocalTimestampsForCommands(commands, nowMs);

    if (this.usesSqliteBackend) {
      this.enqueueSqliteCommands(commands, { label, recordHistory, nowMs });
    } else {
      this.recordLocalRowHistoryStep(commands, label, recordHistory, options.touchedEntityUuidsForLocalSnapshot);
    }

    this.clearDirtySets();
    this.project.bumpStageRevision?.();
    if (!this.usesSqliteBackend || this.project.isDraft) {
      this.project.projectState = ProjectState.Unsaved;
    }
    if (options.emitStageCommit !== false) {
      this.project.emit("stage-commit");
    }
  }

  /**
   * 将自上次提交以来脏追踪器收集到的 O(dirty) 变动编译为最小 `DocCommand[]` 并提交。
   * 供 `HistoryManager.recordStep()` 与旧版画布控制器统一调用，零全图序列化、零全表指纹扫描。
   */
  public commitDirtyStep(options: { label?: string; recordHistory?: boolean; nowMs?: number } = {}): boolean {
    const nowMs = Math.trunc(options.nowMs ?? Date.now());
    const label = options.label ?? "";
    const recordHistory = options.recordHistory !== false;

    if (!this.hasPendingDirty()) {
      return false;
    }

    const commands: DocCommand[] = [];
    const touchedSections = new Set<string>();
    const semanticTouchUuids = new Set<string>();

    // 1. 删除的关联与边（非自环两端点需刷新 updatedAt）
    for (const assocUuid of this.deletedAssociations.keys()) {
      commands.push({ type: "delete_association", uuid: assocUuid });
    }
    const deletedEdgeList = Array.from(this.deletedEdges.values());
    if (deletedEdgeList.length > 0) {
      commands.push({ type: "delete_edges", uuids: deletedEdgeList.map((e) => e.uuid) });
      for (const e of deletedEdgeList) {
        if (e.sourceUuid !== e.targetUuid) {
          semanticTouchUuids.add(e.sourceUuid);
          semanticTouchUuids.add(e.targetUuid);
        }
      }
    }

    // 2. 删除的实体（存活父 Section 需刷新 updatedAt）
    const deletedEntityList = Array.from(this.deletedEntities.values());
    if (deletedEntityList.length > 0) {
      const delSet = new Set(deletedEntityList.map((item) => item.record.uuid));
      for (const item of deletedEntityList) {
        if (item.record.parentSectionUuid && !delSet.has(item.record.parentSectionUuid)) {
          touchedSections.add(item.record.parentSectionUuid);
          semanticTouchUuids.add(item.record.parentSectionUuid);
        }
      }
      const { sectionChildOrders, sectionBounds } = collectSectionOrderAndBounds(this.project, touchedSections);
      commands.push({
        type: "delete_entities",
        uuids: Array.from(delSet),
        sectionChildOrders,
        sectionBounds,
      });
    }

    // 3. 类型替换（TextNode ↔ Section 无损升降级）
    for (const [uuid, oldSnap] of this.replacedOldEntities) {
      const live = this.project.stageManager.get(uuid);
      if (!(live instanceof Entity)) continue;
      const liveRec = serializeEntityToV3Record(live, Math.max(0, this.project.stage.indexOf(live)));
      if (!liveRec) continue;
      if (oldSnap.record.kind === "text" && liveRec.kind === "section") {
        commands.push({
          type: "promote_text_to_section",
          uuid,
          propsJson: liveRec.propsJson,
          x: liveRec.x,
          y: liveRec.y,
          w: liveRec.w,
          h: liveRec.h,
          touchUpdatedAt: false,
        });
      } else if (oldSnap.record.kind === "section" && liveRec.kind === "text") {
        commands.push({
          type: "demote_section_to_text",
          uuid,
          propsJson: liveRec.propsJson,
          x: liveRec.x,
          y: liveRec.y,
          w: liveRec.w,
          h: liveRec.h,
          touchUpdatedAt: false,
        });
      } else {
        commands.push({ type: "upsert_entities", entities: [liveRec], touchUpdatedAt: true });
        semanticTouchUuids.add(uuid);
      }
    }

    // 4. 新建的实体 / 边 / 关联
    const createdEntities: V3EntityRecord[] = [];
    const createdEntityCells: CellMutationItem[] = [];
    const createdEdges: V3EdgeRecord[] = [];
    const createdAssocs: V3AssociationRecord[] = [];
    const createdEntityParents = new Set<string>();
    const colByIdForCreate = new Map(this.project.table.columns.map((c) => [c.id, c]));

    for (const uuid of this.addedUuids) {
      const obj = this.project.stageManager.get(uuid);
      if (!obj) continue;
      const order = Math.max(0, this.project.stage.indexOf(obj));
      if (obj instanceof Entity) {
        const rec = serializeEntityToV3Record(obj, order);
        if (rec) {
          createdEntities.push(rec);
          if (rec.parentSectionUuid) {
            createdEntityParents.add(rec.parentSectionUuid);
            semanticTouchUuids.add(rec.parentSectionUuid);
          }
          for (const [colId, val] of Object.entries(obj.tableFields)) {
            const col = colByIdForCreate.get(colId);
            if (!col || col.type === "formula") continue;
            const cellRec = serializeCellValueToV3Record(uuid, col, val);
            if (cellRec) {
              createdEntityCells.push({ entityUuid: uuid, colId, value: cellRec });
            }
          }
        }
      } else if (obj instanceof LineEdge || obj instanceof ArcEdge || obj instanceof CubicCatmullRomSplineEdge) {
        const rec = serializeEdgeToV3Record(obj, order);
        if (rec) {
          createdEdges.push(rec);
          if (rec.sourceUuid !== rec.targetUuid) {
            semanticTouchUuids.add(rec.sourceUuid);
            semanticTouchUuids.add(rec.targetUuid);
          }
        }
      } else if (obj instanceof MultiTargetUndirectedEdge || obj instanceof SyncAssociation) {
        createdAssocs.push(serializeAssociationToV3Record(obj, order));
      }
    }

    if (createdEntities.length > 0) {
      const { sectionChildOrders, sectionBounds } = collectSectionOrderAndBounds(this.project, createdEntityParents);
      commands.push({
        type: "create_entities",
        entities: createdEntities,
        sectionChildOrders,
        sectionBounds,
      });
      if (createdEntityCells.length > 0) {
        commands.push({
          type: "update_cells",
          updates: createdEntityCells,
          touchUpdatedAt: false,
        });
      }
    }

    // 5. Reparent（实体进出分组框：刷新子节点与新旧父 Section updatedAt）
    if (this.reparentDirty.size > 0) {
      const items: ReparentItem[] = [];
      const reparentSections = new Set<string>();
      for (const [uuid, info] of this.reparentDirty) {
        if (this.addedUuids.has(uuid)) continue;
        const live = this.project.stageManager.get(uuid);
        if (!(live instanceof Entity)) continue;
        const rec = serializeEntityToV3Record(live, Math.max(0, this.project.stage.indexOf(live)));
        if (!rec) continue;
        const actualParent = live.parentSection?.uuid ?? null;
        if (info.oldParentUuid !== actualParent) {
          if (info.oldParentUuid) {
            reparentSections.add(info.oldParentUuid);
            semanticTouchUuids.add(info.oldParentUuid);
          }
          if (actualParent) {
            reparentSections.add(actualParent);
            semanticTouchUuids.add(actualParent);
          }
          if (rec.isRow) {
            semanticTouchUuids.add(uuid);
          }
          items.push({
            uuid,
            parentSectionUuid: actualParent,
            x: rec.x,
            y: rec.y,
            w: rec.w,
            h: rec.h,
          });
        }
      }
      if (items.length > 0) {
        const { sectionChildOrders, sectionBounds } = collectSectionOrderAndBounds(this.project, reparentSections);
        commands.push({
          type: "reparent_entities",
          items,
          sectionChildOrders,
          sectionBounds,
        });
      }
    }

    // 6. 语义实体变更（文本 / 详情 / Url / Latex / Reference / Extension）
    const semanticUpserts: V3EntityRecord[] = [];
    for (const uuid of this.semanticDirtyUuids) {
      if (this.addedUuids.has(uuid) || this.deletedEntities.has(uuid)) continue;
      const live = this.project.stageManager.get(uuid);
      if (!(live instanceof Entity)) continue;
      const rec = serializeEntityToV3Record(live, Math.max(0, this.project.stage.indexOf(live)));
      if (!rec) continue;
      if (rec.isRow) semanticTouchUuids.add(uuid);
      semanticUpserts.push(rec);
    }
    if (semanticUpserts.length > 0) {
      commands.push({ type: "upsert_entities", entities: semanticUpserts, touchUpdatedAt: true });
    }

    // 7. 折叠切换 / 样式变更 / 纯几何移动与缩放（绝不刷新 updatedAt）
    for (const uuid of this.collapseDirtyUuids) {
      const live = this.project.stageManager.get(uuid);
      if (live instanceof Section) {
        commands.push({ type: "toggle_section_collapse", uuid, isCollapsed: live.isCollapsed });
      }
    }

    const nonSemanticUpserts: V3EntityRecord[] = [];
    const moves: EntityMoveItem[] = [];
    const handledEntityIds = new Set<string>([
      ...this.addedUuids,
      ...this.semanticDirtyUuids,
      ...this.replacedOldEntities.keys(),
    ]);

    for (const uuid of this.styleDirtyUuids) {
      if (handledEntityIds.has(uuid) || this.deletedEntities.has(uuid)) continue;
      handledEntityIds.add(uuid);
      const live = this.project.stageManager.get(uuid);
      if (!(live instanceof Entity)) continue;
      const rec = serializeEntityToV3Record(live, Math.max(0, this.project.stage.indexOf(live)));
      if (rec) nonSemanticUpserts.push(rec);
    }

    for (const uuid of this.geometryDirtyUuids) {
      if (handledEntityIds.has(uuid) || this.deletedEntities.has(uuid)) continue;
      const live = this.project.stageManager.get(uuid);
      if (!(live instanceof Entity)) continue;
      const rec = serializeEntityToV3Record(live, Math.max(0, this.project.stage.indexOf(live)));
      if (!rec) continue;
      if (live instanceof Section) {
        nonSemanticUpserts.push(rec);
      } else {
        moves.push({ uuid: rec.uuid, x: rec.x, y: rec.y });
      }
    }

    if (moves.length > 0) {
      commands.push({ type: "move_entities", moves });
    }
    if (nonSemanticUpserts.length > 0) {
      commands.push({ type: "upsert_entities", entities: nonSemanticUpserts, touchUpdatedAt: false });
    }

    // 8. 新建/变更的边与关联
    if (createdEdges.length > 0) {
      commands.push({ type: "create_edges", edges: createdEdges });
    }
    const updatedEdgeUuids = new Set<string>([...this.edgeTopologyDirty.keys(), ...this.edgeStyleDirtyUuids]);
    for (const edgeUuid of updatedEdgeUuids) {
      if (this.addedUuids.has(edgeUuid) || this.deletedEdges.has(edgeUuid)) continue;
      const live = this.project.stageManager.get(edgeUuid);
      if (live instanceof LineEdge || live instanceof ArcEdge || live instanceof CubicCatmullRomSplineEdge) {
        const rec = serializeEdgeToV3Record(live, Math.max(0, this.project.stage.indexOf(live)));
        if (rec) {
          commands.push({ type: "update_edge", edge: rec });
          const oldEndpoints = this.edgeTopologyDirty.get(edgeUuid);
          if (
            oldEndpoints &&
            (oldEndpoints.oldSourceUuid !== rec.sourceUuid || oldEndpoints.oldTargetUuid !== rec.targetUuid)
          ) {
            if (oldEndpoints.oldSourceUuid !== oldEndpoints.oldTargetUuid) {
              semanticTouchUuids.add(oldEndpoints.oldSourceUuid);
              semanticTouchUuids.add(oldEndpoints.oldTargetUuid);
            }
            if (rec.sourceUuid !== rec.targetUuid) {
              semanticTouchUuids.add(rec.sourceUuid);
              semanticTouchUuids.add(rec.targetUuid);
            }
          }
        }
      }
    }

    for (const assoc of createdAssocs) {
      commands.push({ type: "upsert_association", association: assoc });
    }
    for (const assocUuid of this.associationDirtyUuids) {
      if (this.addedUuids.has(assocUuid) || this.deletedAssociations.has(assocUuid)) continue;
      const live = this.project.stageManager.get(assocUuid);
      if (live instanceof MultiTargetUndirectedEdge || live instanceof SyncAssociation) {
        commands.push({
          type: "upsert_association",
          association: serializeAssociationToV3Record(live, Math.max(0, this.project.stage.indexOf(live))),
        });
      }
    }

    // 9. 表格单元格增量
    if (this.cellDirtyKeys.size > 0) {
      const colById = new Map(this.project.table.columns.map((c) => [c.id, c]));
      const touchUpdates: CellMutationItem[] = [];
      const silentUpdates: CellMutationItem[] = [];
      for (const [entityUuid, info] of this.cellDirtyKeys) {
        const ent = this.project.stageManager.get(entityUuid);
        if (!(ent instanceof Entity)) continue;
        for (const colId of info.colIds) {
          const col = colById.get(colId);
          if (col?.type === "formula") continue;
          const rawVal = ent.tableFields[colId] ?? null;
          let effectiveCol = col;
          if (!effectiveCol) {
            // SQLite 模式下外键要求列已在 table_columns 中；非 SQLite 测试/回退模式允许临时列
            if (this.usesSqliteBackend) continue;
            effectiveCol = {
              id: colId,
              name: colId,
              type: typeof rawVal === "number" ? "number" : Array.isArray(rawVal) ? "multi_select" : "text",
            };
          }
          const cellRec = rawVal === null ? null : serializeCellValueToV3Record(entityUuid, effectiveCol, rawVal);
          const item: CellMutationItem = { entityUuid, colId, value: cellRec };
          if (info.touchUpdatedAt) {
            touchUpdates.push(item);
            semanticTouchUuids.add(entityUuid);
          } else {
            silentUpdates.push(item);
          }
        }
      }
      if (touchUpdates.length > 0) {
        commands.push({ type: "update_cells", updates: touchUpdates, touchUpdatedAt: true });
      }
      if (silentUpdates.length > 0) {
        commands.push({ type: "update_cells", updates: silentUpdates, touchUpdatedAt: false });
      }
    }

    // 10. 表格 Schema / 文档元数据增量
    if (this.schemaDirty) {
      commands.push(...this.buildTableSchemaSyncCommands());
    }
    if (this.metadataDirty) {
      commands.push({
        type: "update_doc_metadata",
        tags: [...(this.project.tags ?? [])],
        references: this.project.references ?? { sections: {}, files: [] },
        readme: this.project.readme ?? null,
      });
    }

    if (commands.length === 0) {
      this.clearDirtySets();
      return false;
    }

    // 同步精准更新内存实体的 updatedAt（与 Rust 事务规则 100% 一致）
    for (const uuid of semanticTouchUuids) {
      const ent = this.project.stageManager.get(uuid);
      if (ent instanceof Entity && this.isRowKind(ent)) {
        ent.updatedAt = nowMs;
      }
    }

    if (this.usesSqliteBackend) {
      this.enqueueSqliteCommands(commands, { label, recordHistory, nowMs });
    } else {
      this.recordLocalRowHistoryStep(commands, label, recordHistory, Array.from(semanticTouchUuids));
    }

    this.clearDirtySets();
    this.project.bumpStageRevision?.();
    if (!this.usesSqliteBackend || this.project.isDraft) {
      this.project.projectState = ProjectState.Unsaved;
    }
    return true;
  }

  private isRowKind(ent: Entity): boolean {
    const rec = serializeEntityToV3Record(ent, 0);
    return rec?.isRow ?? false;
  }

  public buildTableSchemaSyncCommands(): DocCommand[] {
    const cmds: DocCommand[] = [];
    this.project.table.columns.forEach((col, idx) => {
      cmds.push({ type: "upsert_column", column: serializeColumnToV3Record(col, idx) });
    });
    this.project.table.views.forEach((view, idx) => {
      cmds.push({ type: "upsert_view", view: serializeViewToV3Record(view, idx) });
    });
    cmds.push({ type: "update_table_meta", tableMetaJson: serializeTableMetaJson(this.project.table) });
    return cmds;
  }

  private applyLocalTimestampsForCommands(commands: DocCommand[], nowMs: number): void {
    const toTouch = new Set<string>();
    const visit = (cmd: DocCommand) => {
      switch (cmd.type) {
        case "batch":
          cmd.commands.forEach(visit);
          break;
        case "update_entity_text":
        case "update_entity_details":
          toTouch.add(cmd.uuid);
          break;
        case "promote_text_to_section":
        case "demote_section_to_text":
          if (cmd.touchUpdatedAt) toTouch.add(cmd.uuid);
          break;
        case "add_entity_image":
        case "remove_entity_image":
          toTouch.add(cmd.parentSectionUuid);
          break;
        case "reparent_entities":
          for (const item of cmd.items) {
            toTouch.add(item.uuid);
            if (item.parentSectionUuid) toTouch.add(item.parentSectionUuid);
          }
          for (const order of cmd.sectionChildOrders ?? []) {
            toTouch.add(order.sectionUuid);
          }
          break;
        case "upsert_entities":
          if (cmd.touchUpdatedAt) {
            for (const e of cmd.entities) {
              if (e.isRow) toTouch.add(e.uuid);
            }
          }
          break;
        case "create_edges":
          for (const e of cmd.edges) {
            if (e.sourceUuid !== e.targetUuid) {
              toTouch.add(e.sourceUuid);
              toTouch.add(e.targetUuid);
            }
          }
          break;
        case "delete_edges":
          for (const uuid of cmd.uuids) {
            const old = this.deletedEdges.get(uuid) ?? this.localEdgeBaseline.get(uuid);
            if (old && old.sourceUuid !== old.targetUuid) {
              toTouch.add(old.sourceUuid);
              toTouch.add(old.targetUuid);
            }
          }
          break;
        case "update_cells":
          if (cmd.touchUpdatedAt) {
            for (const u of cmd.updates) toTouch.add(u.entityUuid);
          }
          break;
        default:
          break;
      }
    };
    commands.forEach(visit);
    for (const uuid of toTouch) {
      const ent = this.project.stageManager.get(uuid);
      if (ent instanceof Entity && this.isRowKind(ent)) {
        ent.updatedAt = nowMs;
      }
    }
  }

  private enqueueSqliteCommands(
    commands: DocCommand[],
    opts: { label: string; recordHistory: boolean; nowMs: number },
  ): void {
    const docId = this.project.v3DocId;
    if (!docId || this.disposed) return;
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.disposed || !this.usesSqliteBackend || this.project.v3DocId !== docId) return;
      const cs = await DocClient.applyCommands({
        docId,
        commands,
        label: opts.label,
        recordHistory: opts.recordHistory,
        nowMs: opts.nowMs,
        maxHistorySize: Math.max(50, Settings.historySize || DEFAULT_LOCAL_HISTORY_LIMIT),
      });
      this.project.v3Revision = Math.max(this.project.v3Revision, cs.revision);
      this.remoteHistoryState = {
        canUndo: cs.canUndo,
        canRedo: cs.canRedo,
        undoCursor: cs.undoCursor,
        totalEntries: this.remoteHistoryState.totalEntries,
      };
      this.project.docIdNeedsSave = false;
      if (!this.project.isDraft) {
        this.project.projectState = ProjectState.Saved;
      }
      // 若本次画布/撤销命令不是公式缓存回写自身，则按 ChangeSet 增量重算受影响公式并写回 SQLite
      const isFormulaSyncOnly =
        opts.label === "formula_cache_sync" || commands.every((c) => c.type === "update_formula_cache_batch");
      if (
        !isFormulaSyncOnly &&
        this.project.getService?.("stageTable") &&
        (cs.dirtyEntities.length > 0 ||
          cs.deletedEntityUuids.length > 0 ||
          cs.dirtyEdges.length > 0 ||
          cs.deletedEdgeUuids.length > 0 ||
          cs.dirtyCells.length > 0 ||
          cs.deletedCells.length > 0 ||
          cs.schemaChanged)
      ) {
        this.project.stageTable.onDocChangeSetApplied?.(cs, { persistToSqlite: true });
      }
    });
  }

  /**
   * 非 Tauri / Vitest 环境的同步行级历史记录：只对比本次脏 UUID 的单行基线，不扫描全图。
   */
  private recordLocalRowHistoryStep(
    commands: DocCommand[],
    label: string,
    recordHistory: boolean,
    extraEntityUuids?: string[],
  ): void {
    this.ensureLocalBaseline();

    const candidateEntityIds = new Set<string>(extraEntityUuids ?? []);
    const candidateEdgeIds = new Set<string>();
    const candidateAssocIds = new Set<string>();
    let schemaTouched = this.schemaDirty;
    let metadataTouched = this.metadataDirty;

    const collectFromCmd = (cmd: DocCommand) => {
      switch (cmd.type) {
        case "batch":
          cmd.commands.forEach(collectFromCmd);
          break;
        case "move_entities":
          cmd.moves.forEach((m) => candidateEntityIds.add(m.uuid));
          cmd.sectionBounds?.forEach((b) => candidateEntityIds.add(b.uuid));
          break;
        case "resize_entity":
          candidateEntityIds.add(cmd.uuid);
          cmd.sectionBounds?.forEach((b) => candidateEntityIds.add(b.uuid));
          break;
        case "toggle_section_collapse":
        case "update_entity_text":
        case "update_entity_details":
        case "promote_text_to_section":
        case "demote_section_to_text":
          candidateEntityIds.add(cmd.uuid);
          if ("sectionBounds" in cmd) cmd.sectionBounds?.forEach((b) => candidateEntityIds.add(b.uuid));
          break;
        case "toggle_branch_collapse":
          cmd.edgeUuids.forEach((u) => candidateEdgeIds.add(u));
          break;
        case "set_style_props":
          cmd.entityPatches?.forEach((p) => candidateEntityIds.add(p.uuid));
          cmd.edgePatches?.forEach((p) => candidateEdgeIds.add(p.uuid));
          cmd.associationPatches?.forEach((p) => candidateAssocIds.add(p.uuid));
          break;
        case "create_entities":
          cmd.entities.forEach((e) => candidateEntityIds.add(e.uuid));
          cmd.sectionChildOrders?.forEach((s) => candidateEntityIds.add(s.sectionUuid));
          cmd.sectionBounds?.forEach((b) => candidateEntityIds.add(b.uuid));
          break;
        case "delete_entities":
          cmd.uuids.forEach((u) => candidateEntityIds.add(u));
          cmd.sectionChildOrders?.forEach((s) => candidateEntityIds.add(s.sectionUuid));
          cmd.sectionBounds?.forEach((b) => candidateEntityIds.add(b.uuid));
          break;
        case "reparent_entities":
          cmd.items.forEach((i) => {
            candidateEntityIds.add(i.uuid);
            if (i.parentSectionUuid) candidateEntityIds.add(i.parentSectionUuid);
          });
          cmd.sectionChildOrders?.forEach((s) => candidateEntityIds.add(s.sectionUuid));
          cmd.sectionBounds?.forEach((b) => candidateEntityIds.add(b.uuid));
          break;
        case "add_entity_image":
          candidateEntityIds.add(cmd.imageEntity.uuid);
          candidateEntityIds.add(cmd.parentSectionUuid);
          cmd.sectionBounds?.forEach((b) => candidateEntityIds.add(b.uuid));
          break;
        case "remove_entity_image":
          candidateEntityIds.add(cmd.imageUuid);
          candidateEntityIds.add(cmd.parentSectionUuid);
          cmd.sectionBounds?.forEach((b) => candidateEntityIds.add(b.uuid));
          break;
        case "upsert_entities":
          cmd.entities.forEach((e) => candidateEntityIds.add(e.uuid));
          break;
        case "create_edges":
          cmd.edges.forEach((e) => {
            candidateEdgeIds.add(e.uuid);
            candidateEntityIds.add(e.sourceUuid);
            candidateEntityIds.add(e.targetUuid);
          });
          break;
        case "delete_edges":
          cmd.uuids.forEach((u) => {
            candidateEdgeIds.add(u);
            const old = this.localEdgeBaseline.get(u);
            if (old) {
              candidateEntityIds.add(old.sourceUuid);
              candidateEntityIds.add(old.targetUuid);
            }
          });
          break;
        case "update_edge":
          candidateEdgeIds.add(cmd.edge.uuid);
          candidateEntityIds.add(cmd.edge.sourceUuid);
          candidateEntityIds.add(cmd.edge.targetUuid);
          break;
        case "upsert_association":
          candidateAssocIds.add(cmd.association.uuid);
          break;
        case "delete_association":
          candidateAssocIds.add(cmd.uuid);
          break;
        case "update_cells":
          cmd.updates.forEach((u) => candidateEntityIds.add(u.entityUuid));
          break;
        case "upsert_column":
        case "delete_column":
        case "reorder_columns":
        case "upsert_view":
        case "delete_view":
        case "reorder_views":
        case "update_table_meta":
          schemaTouched = true;
          break;
        case "update_doc_metadata":
          metadataTouched = true;
          break;
      }
    };
    commands.forEach(collectFromCmd);
    for (const u of this.reparentDirty.values()) {
      if (u.oldParentUuid) candidateEntityIds.add(u.oldParentUuid);
      if (u.newParentUuid) candidateEntityIds.add(u.newParentUuid);
    }

    const undoDirtyEntities: V3EntityRecord[] = [];
    const undoDeletedEntities: string[] = [];
    const redoDirtyEntities: V3EntityRecord[] = [];
    const redoDeletedEntities: string[] = [];
    const undoDirtyCells: V3CellValueRecord[] = [];
    const undoDeletedCells: V3CellKey[] = [];
    const redoDirtyCells: V3CellValueRecord[] = [];
    const redoDeletedCells: V3CellKey[] = [];

    const colById = new Map(this.project.table.columns.map((c) => [c.id, c]));
    const fallbackCol = (colId: string, val: TableCellValue) => ({
      id: colId,
      name: colId,
      type: (typeof val === "number" ? "number" : Array.isArray(val) ? "multi_select" : "text") as
        | "number"
        | "multi_select"
        | "text",
    });

    for (const uuid of candidateEntityIds) {
      const prev = this.localEntityBaseline.get(uuid);
      const live = this.project.stageManager.get(uuid);
      const liveEntity = live instanceof Entity ? live : undefined;
      const nextRec = liveEntity
        ? serializeEntityToV3Record(liveEntity, Math.max(0, this.project.stage.indexOf(liveEntity)))
        : null;
      const nextFields = liveEntity ? cloneTableFields(liveEntity.tableFields) : null;

      if (!prev && nextRec && nextFields) {
        undoDeletedEntities.push(uuid);
        redoDirtyEntities.push(nextRec);
        for (const [colId, val] of Object.entries(nextFields)) {
          const rec = serializeCellValueToV3Record(uuid, colById.get(colId) ?? fallbackCol(colId, val), val);
          if (rec) redoDirtyCells.push(rec);
        }
        this.localEntityBaseline.set(uuid, { record: nextRec, tableFields: nextFields });
      } else if (prev && !nextRec) {
        undoDirtyEntities.push(prev.record);
        for (const [colId, val] of Object.entries(prev.tableFields)) {
          const rec = serializeCellValueToV3Record(uuid, colById.get(colId) ?? fallbackCol(colId, val), val);
          if (rec) undoDirtyCells.push(rec);
        }
        redoDeletedEntities.push(uuid);
        this.localEntityBaseline.delete(uuid);
      } else if (prev && nextRec && nextFields) {
        if (!sameJsonValue(prev.record, nextRec)) {
          undoDirtyEntities.push(prev.record);
          redoDirtyEntities.push(nextRec);
        }
        const allCols = new Set([...Object.keys(prev.tableFields), ...Object.keys(nextFields)]);
        for (const colId of allCols) {
          const oldVal = prev.tableFields[colId];
          const newVal = nextFields[colId];
          if (sameJsonValue(oldVal, newVal)) continue;
          if (oldVal === undefined) {
            undoDeletedCells.push({ entityUuid: uuid, colId });
          } else {
            const rec = serializeCellValueToV3Record(uuid, colById.get(colId) ?? fallbackCol(colId, oldVal), oldVal);
            if (rec) undoDirtyCells.push(rec);
          }
          if (newVal === undefined) {
            redoDeletedCells.push({ entityUuid: uuid, colId });
          } else {
            const rec = serializeCellValueToV3Record(uuid, colById.get(colId) ?? fallbackCol(colId, newVal), newVal);
            if (rec) redoDirtyCells.push(rec);
          }
        }
        this.localEntityBaseline.set(uuid, { record: nextRec, tableFields: nextFields });
      }
    }

    const undoDirtyEdges: V3EdgeRecord[] = [];
    const undoDeletedEdges: string[] = [];
    const redoDirtyEdges: V3EdgeRecord[] = [];
    const redoDeletedEdges: string[] = [];
    for (const uuid of candidateEdgeIds) {
      const prev = this.localEdgeBaseline.get(uuid);
      const live = this.project.stageManager.get(uuid);
      const nextRec =
        live instanceof LineEdge || live instanceof ArcEdge || live instanceof CubicCatmullRomSplineEdge
          ? serializeEdgeToV3Record(live, Math.max(0, this.project.stage.indexOf(live)))
          : null;
      if (!prev && nextRec) {
        undoDeletedEdges.push(uuid);
        redoDirtyEdges.push(nextRec);
        this.localEdgeBaseline.set(uuid, nextRec);
      } else if (prev && !nextRec) {
        undoDirtyEdges.push(prev);
        redoDeletedEdges.push(uuid);
        this.localEdgeBaseline.delete(uuid);
      } else if (prev && nextRec && !sameJsonValue(prev, nextRec)) {
        undoDirtyEdges.push(prev);
        redoDirtyEdges.push(nextRec);
        this.localEdgeBaseline.set(uuid, nextRec);
      }
    }

    const undoDirtyAssocs: V3AssociationRecord[] = [];
    const undoDeletedAssocs: string[] = [];
    const redoDirtyAssocs: V3AssociationRecord[] = [];
    const redoDeletedAssocs: string[] = [];
    for (const uuid of candidateAssocIds) {
      const prev = this.localAssocBaseline.get(uuid);
      const live = this.project.stageManager.get(uuid);
      const nextRec =
        live instanceof MultiTargetUndirectedEdge || live instanceof SyncAssociation
          ? serializeAssociationToV3Record(live, Math.max(0, this.project.stage.indexOf(live)))
          : null;
      if (!prev && nextRec) {
        undoDeletedAssocs.push(uuid);
        redoDirtyAssocs.push(nextRec);
        this.localAssocBaseline.set(uuid, nextRec);
      } else if (prev && !nextRec) {
        undoDirtyAssocs.push(prev);
        redoDeletedAssocs.push(uuid);
        this.localAssocBaseline.delete(uuid);
      } else if (prev && nextRec && !sameJsonValue(prev, nextRec)) {
        undoDirtyAssocs.push(prev);
        redoDirtyAssocs.push(nextRec);
        this.localAssocBaseline.set(uuid, nextRec);
      }
    }

    let undoCols: V3TableColumnRecord[] | undefined;
    let undoViews: V3TableViewRecord[] | undefined;
    let undoMeta: string | undefined;
    let redoCols: V3TableColumnRecord[] | undefined;
    let redoViews: V3TableViewRecord[] | undefined;
    let redoMeta: string | undefined;
    if (schemaTouched && this.localTableSnapshot) {
      undoCols = this.localTableSnapshot.columns.map((c, i) => serializeColumnToV3Record(c, i));
      undoViews = this.localTableSnapshot.views.map((v, i) => serializeViewToV3Record(v, i));
      undoMeta = serializeTableMetaJson(this.localTableSnapshot);
      redoCols = this.project.table.columns.map((c, i) => serializeColumnToV3Record(c, i));
      redoViews = this.project.table.views.map((v, i) => serializeViewToV3Record(v, i));
      redoMeta = serializeTableMetaJson(this.project.table);
      this.localTableSnapshot = structuredClone(this.project.table);
    }

    let undoTags: string[] | undefined;
    let redoTags: string[] | undefined;
    if (metadataTouched) {
      undoTags = [...this.localTagsSnapshot];
      redoTags = [...(this.project.tags ?? [])];
      this.localTagsSnapshot = [...redoTags];
    }

    const hasDiff =
      undoDirtyEntities.length > 0 ||
      undoDeletedEntities.length > 0 ||
      undoDirtyEdges.length > 0 ||
      undoDeletedEdges.length > 0 ||
      undoDirtyAssocs.length > 0 ||
      undoDeletedAssocs.length > 0 ||
      undoDirtyCells.length > 0 ||
      undoDeletedCells.length > 0 ||
      schemaTouched ||
      metadataTouched;

    if (!recordHistory || !hasDiff) return;

    const docId = this.project.v3DocId ?? this.project.metadata?.docId ?? "local";
    const makeChangeSet = (
      source: ChangeSource,
      dirtyEntities: V3EntityRecord[],
      deletedEntityUuids: string[],
      dirtyEdges: V3EdgeRecord[],
      deletedEdgeUuids: string[],
      dirtyAssociations: V3AssociationRecord[],
      deletedAssociationUuids: string[],
      dirtyCells: V3CellValueRecord[],
      deletedCells: V3CellKey[],
      cols?: V3TableColumnRecord[],
      views?: V3TableViewRecord[],
      metaJson?: string,
      tags?: string[],
    ): DocChangeSet => ({
      docId,
      canonicalPath: this.project.canonicalProjectPath ?? "",
      revision: ++this.localRevision,
      originWindow: "local",
      source,
      dirtyEntities,
      deletedEntityUuids,
      dirtyEdges,
      deletedEdgeUuids,
      dirtyAssociations,
      deletedAssociationUuids,
      dirtyCells,
      deletedCells,
      schemaChanged: Boolean(cols),
      tableColumns: cols ?? null,
      tableViews: views ?? null,
      tableMetaJson: metaJson ?? null,
      metadataChanged: Boolean(tags),
      tags: tags ?? null,
      references: null,
      readme: undefined,
      canUndo: true,
      canRedo: false,
      undoCursor: 0,
    });

    this.localHistory.splice(this.localHistoryIndex + 1);
    this.localHistory.push({
      label,
      undoChangeSet: makeChangeSet(
        "undo",
        undoDirtyEntities,
        undoDeletedEntities,
        undoDirtyEdges,
        undoDeletedEdges,
        undoDirtyAssocs,
        undoDeletedAssocs,
        undoDirtyCells,
        undoDeletedCells,
        undoCols,
        undoViews,
        undoMeta,
        undoTags,
      ),
      redoChangeSet: makeChangeSet(
        "redo",
        redoDirtyEntities,
        redoDeletedEntities,
        redoDirtyEdges,
        redoDeletedEdges,
        redoDirtyAssocs,
        redoDeletedAssocs,
        redoDirtyCells,
        redoDeletedCells,
        redoCols,
        redoViews,
        redoMeta,
        redoTags,
      ),
    });
    const maxHistory = Math.max(50, Settings.historySize || DEFAULT_LOCAL_HISTORY_LIMIT);
    while (this.localHistory.length > maxHistory) {
      this.localHistory.shift();
    }
    this.localHistoryIndex = this.localHistory.length - 1;
  }

  private syncLocalBaselineFromChangeSet(cs: DocChangeSet): void {
    for (const uuid of cs.deletedEntityUuids) {
      this.localEntityBaseline.delete(uuid);
    }
    for (const rec of cs.dirtyEntities) {
      const live = this.project.stageManager.get(rec.uuid);
      if (live instanceof Entity) {
        this.localEntityBaseline.set(rec.uuid, {
          record: rec,
          tableFields: cloneTableFields(live.tableFields),
        });
      }
    }
    for (const uuid of cs.deletedEdgeUuids) {
      this.localEdgeBaseline.delete(uuid);
    }
    for (const rec of cs.dirtyEdges) {
      this.localEdgeBaseline.set(rec.uuid, rec);
    }
    for (const uuid of cs.deletedAssociationUuids) {
      this.localAssocBaseline.delete(uuid);
    }
    for (const rec of cs.dirtyAssociations) {
      this.localAssocBaseline.set(rec.uuid, rec);
    }
    for (const cell of cs.dirtyCells) {
      const base = this.localEntityBaseline.get(cell.entityUuid);
      const live = this.project.stageManager.get(cell.entityUuid);
      if (base && live instanceof Entity) {
        base.tableFields = cloneTableFields(live.tableFields);
      }
    }
    for (const del of cs.deletedCells) {
      const base = this.localEntityBaseline.get(del.entityUuid);
      const live = this.project.stageManager.get(del.entityUuid);
      if (base && live instanceof Entity) {
        base.tableFields = cloneTableFields(live.tableFields);
      }
    }
    if (cs.schemaChanged) {
      this.localTableSnapshot = structuredClone(this.project.table);
    }
    if (cs.metadataChanged) {
      this.localTagsSnapshot = [...(this.project.tags ?? [])];
    }
  }

  public undo(): void | Promise<void> {
    if (this.usesSqliteBackend && this.project.v3DocId) {
      const docId = this.project.v3DocId;
      this.writeQueue = this.writeQueue.then(async () => {
        if (this.disposed || !this.usesSqliteBackend || this.project.v3DocId !== docId) return;
        const cs = await DocClient.undo(docId);
        if (!cs) return;
        applyDocChangeSet(this.project, cs, { preserveEditingNode: false });
        this.remoteHistoryState = {
          canUndo: cs.canUndo,
          canRedo: cs.canRedo,
          undoCursor: cs.undoCursor,
          totalEntries: this.remoteHistoryState.totalEntries,
        };
        this.project.emit("stage-commit");
        this.project.renderer?.tick?.(true);
        this.project.loop?.();
      });
      return this.writeQueue;
    }

    if (this.localHistoryIndex < 0) return;
    const step = this.localHistory[this.localHistoryIndex];
    this.localHistoryIndex--;
    applyDocChangeSet(this.project, step.undoChangeSet, { preserveEditingNode: false });
    this.syncLocalBaselineFromChangeSet(step.undoChangeSet);
    this.project.emit("stage-commit");
  }

  public redo(): void | Promise<void> {
    if (this.usesSqliteBackend && this.project.v3DocId) {
      const docId = this.project.v3DocId;
      this.writeQueue = this.writeQueue.then(async () => {
        if (this.disposed || !this.usesSqliteBackend || this.project.v3DocId !== docId) return;
        const cs = await DocClient.redo(docId);
        if (!cs) return;
        applyDocChangeSet(this.project, cs, { preserveEditingNode: false });
        this.remoteHistoryState = {
          canUndo: cs.canUndo,
          canRedo: cs.canRedo,
          undoCursor: cs.undoCursor,
          totalEntries: this.remoteHistoryState.totalEntries,
        };
        this.project.emit("stage-commit");
        this.project.renderer?.tick?.(true);
        this.project.loop?.();
      });
      return this.writeQueue;
    }

    if (this.localHistoryIndex >= this.localHistory.length - 1) return;
    this.localHistoryIndex++;
    const step = this.localHistory[this.localHistoryIndex];
    applyDocChangeSet(this.project, step.redoChangeSet, { preserveEditingNode: false });
    this.syncLocalBaselineFromChangeSet(step.redoChangeSet);
    this.project.emit("stage-commit");
  }

  public getHistoryState(): HistoryStateInfo {
    if (this.usesSqliteBackend) {
      return { ...this.remoteHistoryState };
    }
    return {
      canUndo: this.localHistoryIndex >= 0,
      canRedo: this.localHistoryIndex < this.localHistory.length - 1,
      undoCursor: this.localHistoryIndex + 1,
      totalEntries: this.localHistory.length,
    };
  }

  public scheduleDebouncedCommit(options: { label?: string; recordHistory?: boolean; delayMs?: number } = {}): void {
    if (this.disposed) return;
    if (this.debouncedCommitTimer) {
      clearTimeout(this.debouncedCommitTimer);
    }
    this.debouncedCommitOptions = {
      label: options.label ?? this.debouncedCommitOptions?.label,
      recordHistory: options.recordHistory ?? this.debouncedCommitOptions?.recordHistory,
    };
    this.debouncedCommitTimer = setTimeout(() => {
      this.debouncedCommitTimer = null;
      const opts = this.debouncedCommitOptions ?? {};
      this.debouncedCommitOptions = null;
      if (!this.disposed && this.hasPendingDirty()) {
        this.commitDirtyStep(opts);
      }
    }, options.delayMs ?? 300);
  }

  public async flush(): Promise<void> {
    if (this.debouncedCommitTimer) {
      clearTimeout(this.debouncedCommitTimer);
      this.debouncedCommitTimer = null;
      const opts = this.debouncedCommitOptions ?? {};
      this.debouncedCommitOptions = null;
      if (!this.disposed && this.hasPendingDirty()) {
        this.commitDirtyStep(opts);
      }
    }
    await this.writeQueue;
  }

  public async dispose(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.disposed = true;
      this.clearDirtySets();
      this.localHistory = [];
      this.localEntityBaseline.clear();
      this.localEdgeBaseline.clear();
      this.localAssocBaseline.clear();
    }
  }
}
