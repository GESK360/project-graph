import type { Project } from "@/core/Project";
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
import { PenStroke, PenStrokeSegment } from "@/core/stage/stageObject/entity/PenStroke";
import { ReferenceBlockNode } from "@/core/stage/stageObject/entity/ReferenceBlockNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { UrlNode } from "@/core/stage/stageObject/entity/UrlNode";
import { cloneTableFields, normalizeTableData, type PrgTableData } from "@/types/table";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import type { Value } from "platejs";
import type { DocChangeSet, V3EntityRecord } from "./DocClient";
import {
  decodeV3CellValue,
  hydrateTableColumnsFromV3,
  hydrateTableViewsFromV3,
  instantiateAssociationFromV3Record,
  instantiateEdgeFromV3Record,
  instantiateEntityFromV3Record,
} from "./V3Serializer";

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function decodeColor(raw: unknown): Color {
  if (Array.isArray(raw) && raw.length === 4 && raw.every((n) => typeof n === "number")) {
    return new Color(raw[0], raw[1], raw[2], raw[3]);
  }
  return Color.Transparent.clone();
}

function getEntityKind(entity: Entity): V3EntityRecord["kind"] | null {
  if (entity instanceof TextNode) return "text";
  if (entity instanceof Section) return "section";
  if (entity instanceof ImageNode) return "image";
  if (entity instanceof UrlNode) return "url";
  if (entity instanceof LatexNode) return "latex";
  if (entity instanceof MediaNode) return "media";
  if (entity instanceof SvgNode) return "svg";
  if (entity instanceof ReferenceBlockNode) return "reference";
  if (entity instanceof ExtensionEntity) return "extension";
  if (entity instanceof ConnectPoint) return "connect_point";
  if (entity instanceof PenStroke) return "pen_stroke";
  return null;
}

function rewireEntityReferences(project: Project, oldEntity: ConnectableEntity, nextEntity: ConnectableEntity): void {
  const incident =
    typeof project.stageManager?.getIncidentAssociations === "function"
      ? project.stageManager.getIncidentAssociations(oldEntity.uuid)
      : project.stageManager.getAssociations();
  for (const assoc of incident) {
    if (assoc instanceof Edge) {
      if (assoc.source === oldEntity || assoc.source.uuid === oldEntity.uuid) {
        assoc.source = nextEntity;
      }
      if (assoc.target === oldEntity || assoc.target.uuid === oldEntity.uuid) {
        assoc.target = nextEntity;
      }
    } else if (assoc instanceof MultiTargetUndirectedEdge || assoc instanceof SyncAssociation) {
      for (let i = 0; i < assoc.associationList.length; i++) {
        if (assoc.associationList[i] === oldEntity || assoc.associationList[i].uuid === oldEntity.uuid) {
          assoc.associationList[i] = nextEntity;
        }
      }
    }
  }
}

/**
 * 原地更新同类型实体，保留 JS 对象引用、本地选中状态、编辑中文本以及未变动 `ImageNode` 的 `ImageBitmap`。
 */
function patchExistingEntityInPlace(
  existing: Entity,
  rec: V3EntityRecord,
  preserveEditingNode: boolean,
): { props: Record<string, unknown>; topologyChanged: boolean } {
  const props = safeJsonParse<Record<string, unknown>>(rec.propsJson, {});
  const details = safeJsonParse<Value>(rec.detailsJson, []);
  const rect = new Rectangle(new Vector(rec.x, rec.y), new Vector(rec.w, rec.h));
  let topologyChanged = false;

  existing.createdAt = rec.createdAt;
  existing.updatedAt = rec.updatedAt;
  existing.details = details;

  if (existing instanceof TextNode) {
    const isActivelyEditing = preserveEditingNode && existing.isEditing;
    if (!isActivelyEditing) {
      existing.text = rec.text;
    }
    existing.color = decodeColor(props.color);
    existing.sizeAdjust = props.sizeAdjust === "manual" ? "manual" : "auto";
    existing.fontFamily = typeof props.fontFamily === "string" ? props.fontFamily : "";
    existing.fontWeight = typeof props.fontWeight === "string" ? props.fontWeight : "";
    existing.borderStyle = props.borderStyle === "dashed" || props.borderStyle === "none" ? props.borderStyle : "solid";
    const nextFontScale = typeof props.fontScaleLevel === "number" ? props.fontScaleLevel : 0;
    if (existing.fontScaleLevel !== nextFontScale) {
      existing.setFontScaleLevel(nextFontScale);
    }
    existing.collisionBox = new CollisionBox([rect]);
  } else if (existing instanceof Section) {
    const isActivelyEditing = preserveEditingNode && existing.isEditingTitle;
    if (!isActivelyEditing) {
      existing.text = rec.text;
    }
    existing.color = decodeColor(props.color);
    const nextCollapsed = Boolean(props.isCollapsed);
    if (existing.isCollapsed !== nextCollapsed) {
      existing.isCollapsed = nextCollapsed;
      topologyChanged = true;
    }
    existing.locked = Boolean(props.locked);
    existing.borderStyle = props.borderStyle === "dashed" || props.borderStyle === "none" ? props.borderStyle : "solid";
    existing.sizeAdjust = props.sizeAdjust === "manual" ? "manual" : "auto";
    (existing as unknown as { _collisionBoxNormal: CollisionBox })._collisionBoxNormal = new CollisionBox(
      rect.getBoundingLines(),
    );
    existing.adjustLocationAndSize();
  } else if (existing instanceof ImageNode) {
    const nextAttId = typeof props.attachmentId === "string" ? props.attachmentId : "";
    existing.scale = typeof props.scale === "number" ? props.scale : 1;
    existing.isBackground = Boolean(props.isBackground);
    existing.collisionBox = new CollisionBox([rect]);
    if (existing.attachmentId !== nextAttId) {
      existing.attachmentId = nextAttId;
      existing.bitmap = undefined;
      existing.state = "loading";
      existing.ensureBitmapLoaded();
    }
  } else if (existing instanceof UrlNode) {
    existing.title = typeof props.title === "string" ? props.title : rec.text;
    existing.url = typeof props.url === "string" ? props.url : "";
    existing.color = decodeColor(props.color);
    existing.collisionBox = new CollisionBox([rect]);
  } else if (existing instanceof LatexNode) {
    const nextSrc = typeof props.latexSource === "string" ? props.latexSource : rec.text;
    existing.color = decodeColor(props.color);
    existing.fontScaleLevel = typeof props.fontScaleLevel === "number" ? props.fontScaleLevel : 0;
    existing.collisionBox = new CollisionBox([rect]);
    if (existing.latexSource !== nextSrc) {
      void existing.updateLatex(nextSrc);
    }
  } else if (existing instanceof MediaNode) {
    existing.title = typeof props.title === "string" ? props.title : rec.text;
    existing.collisionBox = new CollisionBox([rect]);
  } else if (existing instanceof SvgNode) {
    existing.scale = typeof props.scale === "number" ? props.scale : 1;
    existing.color = decodeColor(props.color);
    existing.collisionBox = new CollisionBox([rect]);
  } else if (existing instanceof ReferenceBlockNode) {
    existing.fileName = typeof props.fileName === "string" ? props.fileName : "";
    existing.sectionName = typeof props.sectionName === "string" ? props.sectionName : "";
    existing.scale = typeof props.scale === "number" ? props.scale : 1;
    existing.collisionBox = new CollisionBox([rect]);
  } else if (existing instanceof ExtensionEntity) {
    existing.extensionId = typeof props.extensionId === "string" ? props.extensionId : "";
    existing.typeName = typeof props.typeName === "string" ? props.typeName : rec.text;
    existing.customData = props.customData ?? {};
    existing.collisionBox = new CollisionBox([rect]);
  } else if (existing instanceof ConnectPoint) {
    existing.collisionBox = new CollisionBox([rect]);
  } else if (existing instanceof PenStroke) {
    existing.color = decodeColor(props.color);
    existing.width = typeof props.width === "number" ? props.width : 5;
    const rawSegments = Array.isArray(props.segments) ? props.segments : [];
    existing.segments = rawSegments
      .filter((s): s is { x: number; y: number; pressure?: number } => Boolean(s && typeof s === "object"))
      .map(
        (s) =>
          new PenStrokeSegment(
            new Vector(Number(s.x) || 0, Number(s.y) || 0),
            typeof s.pressure === "number" ? s.pressure : 0.5,
          ),
      );
    existing.collisionBox = new CollisionBox([rect]);
  }

  return { props, topologyChanged };
}

export interface ApplyChangeSetOptions {
  /** 远端窗口同步时保留本地正在输入的 TextNode / Section 标题 */
  preserveEditingNode?: boolean;
  /** 是否触发 `stageTable.notifyChange({ emitSync: false })` */
  notifyTable?: boolean;
}

/**
 * 将 Rust 事务命令 / 撤销重做 / 跨窗口 `pg-doc-changeset` 返回的增量 `DocChangeSet`
 * 以 O(dirty) 局部热补丁应用到内存 `Project`（零全图重建、不销毁未变动 `ImageNode` 位图）。
 */
export function applyDocChangeSet(
  project: Project,
  changeset: DocChangeSet,
  options: ApplyChangeSetOptions = {},
): void {
  const preserveEditingNode = options.preserveEditingNode ?? false;
  const stageManager = project.stageManager;

  // 在应用远端/历史补丁期间暂停脏追踪，避免补丁自身被再次当作用户写命令提交
  const prevSuppress = project.docCommandBus?.isSuppressingTracking ?? false;
  project.docCommandBus?.setSuppressTracking(true);

  let topologyChanged = false;
  let stageObjectCountChanged = false;

  try {
    // 1. 先处理表格 Schema 变更（列/视图/别名），确保后续单元格值对齐最新列定义
    if (changeset.schemaChanged) {
      const tableMeta = safeJsonParse<{
        activeViewId?: string;
        systemColumnNames?: PrgTableData["systemColumnNames"];
      }>(changeset.tableMetaJson, {});
      const columns = changeset.tableColumns
        ? hydrateTableColumnsFromV3(changeset.tableColumns)
        : project.table.columns;
      const views = changeset.tableViews ? hydrateTableViewsFromV3(changeset.tableViews) : project.table.views;
      project.table = normalizeTableData({
        columns,
        views,
        activeViewId: tableMeta.activeViewId ?? project.table.activeViewId,
        systemColumnNames: tableMeta.systemColumnNames ?? project.table.systemColumnNames,
      });
    }

    // 2. 文档级元数据（tags / references / readme）
    if (changeset.metadataChanged) {
      if (changeset.tags !== undefined && changeset.tags !== null) {
        project.tags = [...changeset.tags];
        if (project.getService?.("tagManager")) {
          project.tagManager.reset(project.tags);
        }
      }
      if (changeset.references !== undefined && changeset.references !== null) {
        project.references = structuredClone(changeset.references);
      }
      if (changeset.readme !== undefined) {
        project.readme = changeset.readme ?? undefined;
      }
    }

    // 3. 删除已移除的边与关联（在删除实体前先摘除）
    for (const assocUuid of changeset.deletedAssociationUuids) {
      const existing = stageManager.get(assocUuid);
      if (existing) {
        stageManager.delete(existing);
        topologyChanged = true;
        stageObjectCountChanged = true;
      }
    }
    for (const edgeUuid of changeset.deletedEdgeUuids) {
      const existing = stageManager.get(edgeUuid);
      if (existing) {
        stageManager.delete(existing);
        topologyChanged = true;
        stageObjectCountChanged = true;
      }
    }

    // 4. 删除已移除的实体（并仅释放被真正删除的实体资源）
    for (const entityUuid of changeset.deletedEntityUuids) {
      const existing = stageManager.get(entityUuid);
      if (existing instanceof Entity) {
        if (existing.parentSection) {
          existing.parentSection.children = existing.parentSection.children.filter((c) => c.uuid !== entityUuid);
        }
        stageManager.delete(existing);
        void existing.dispose?.();
        topologyChanged = true;
        stageObjectCountChanged = true;
      }
    }

    // 5. 新增 / 原地更新 / 升降级（TextNode ↔ Section）实体
    const touchedSectionOrders = new Map<string, string[]>();
    const parentTargetByEntity = new Map<string, string | null>();
    const newlyInsertedEntities: Entity[] = [];

    for (const rec of changeset.dirtyEntities) {
      const existing = stageManager.get(rec.uuid);
      if (existing instanceof Entity) {
        const currentKind = getEntityKind(existing);
        if (currentKind === rec.kind) {
          const prevParentUuid = existing.parentSection?.uuid ?? null;
          const { props, topologyChanged: entTopo } = patchExistingEntityInPlace(existing, rec, preserveEditingNode);
          if (entTopo) topologyChanged = true;
          if (prevParentUuid !== rec.parentSectionUuid) {
            parentTargetByEntity.set(rec.uuid, rec.parentSectionUuid);
            topologyChanged = true;
          }
          if (rec.kind === "section" && Array.isArray(props.childOrder)) {
            touchedSectionOrders.set(
              rec.uuid,
              props.childOrder.filter((id): id is string => typeof id === "string"),
            );
          }
          stageManager.updateSpatialIndex(existing);
        } else {
          // 同 UUID 实体类型切换（如 TextNode ↔ Section 无损升降级或撤销恢复）
          const prevSelected = existing.isSelected;
          const prevTableFields = cloneTableFields(existing.tableFields);
          const created = instantiateEntityFromV3Record(project, rec, prevTableFields, {
            deferBitmapLoad: Boolean(project.imageBitmapCache),
          });
          if (created) {
            created.entity.isSelected = prevSelected;
            const prevParent = existing.parentSection;
            if (prevParent) {
              const cIdx = prevParent.children.indexOf(existing);
              if (cIdx !== -1) prevParent.children[cIdx] = created.entity;
              created.entity.parentSection = prevParent;
            }
            if (existing instanceof Section && created.entity instanceof Section) {
              created.entity.children = existing.children;
            }
            stageManager.replaceStageObject(existing, created.entity);
            if (existing instanceof ConnectableEntity && created.entity instanceof ConnectableEntity) {
              rewireEntityReferences(project, existing, created.entity);
            }
            parentTargetByEntity.set(rec.uuid, rec.parentSectionUuid);
            if (rec.kind === "section" && Array.isArray(created.props.childOrder)) {
              touchedSectionOrders.set(
                rec.uuid,
                created.props.childOrder.filter((id): id is string => typeof id === "string"),
              );
            }
            topologyChanged = true;
          }
        }
      } else {
        const created = instantiateEntityFromV3Record(project, rec, undefined, {
          deferBitmapLoad: Boolean(project.imageBitmapCache),
        });
        if (created) {
          stageManager.add(created.entity, true);
          newlyInsertedEntities.push(created.entity);
          parentTargetByEntity.set(rec.uuid, rec.parentSectionUuid);
          if (rec.kind === "section" && Array.isArray(created.props.childOrder)) {
            touchedSectionOrders.set(
              rec.uuid,
              created.props.childOrder.filter((id): id is string => typeof id === "string"),
            );
          }
          topologyChanged = true;
          stageObjectCountChanged = true;
        }
      }
    }

    // 6. 同步父子 Section 挂载关系与 childOrder
    for (const [entityUuid, nextParentUuid] of parentTargetByEntity) {
      const entity = stageManager.get(entityUuid);
      if (!(entity instanceof Entity)) continue;
      const oldParent = entity.parentSection;
      if (oldParent && oldParent.uuid !== nextParentUuid) {
        oldParent.children = oldParent.children.filter((c) => c.uuid !== entityUuid);
      }
      if (nextParentUuid) {
        const nextParent = stageManager.get(nextParentUuid);
        if (nextParent instanceof Section) {
          if (!nextParent.children.some((c) => c.uuid === entityUuid)) {
            nextParent.children.push(entity);
          }
          entity.parentSection = nextParent;
        } else {
          entity.parentSection = null;
        }
      } else {
        entity.parentSection = null;
      }
    }

    for (const [secUuid, desiredOrder] of touchedSectionOrders) {
      const sec = stageManager.get(secUuid);
      if (!(sec instanceof Section)) continue;
      const ordered: Entity[] = [];
      const seen = new Set<string>();
      for (const childId of desiredOrder) {
        if (seen.has(childId) || childId === secUuid) continue;
        const child = stageManager.get(childId);
        if (child instanceof Entity) {
          seen.add(childId);
          child.parentSection = sec;
          ordered.push(child);
        }
      }
      for (const existingChild of sec.children) {
        if (seen.has(existingChild.uuid) || existingChild.uuid === secUuid) continue;
        if (stageManager.get(existingChild.uuid) === existingChild && existingChild.parentSection === sec) {
          seen.add(existingChild.uuid);
          ordered.push(existingChild);
        }
      }
      sec.children = ordered;
      topologyChanged = true;
    }

    // 7. 新增 / 更新有向边
    const lookupEntity = (uuid: string): Entity | undefined => {
      const obj = stageManager.get(uuid);
      return obj instanceof Entity ? obj : undefined;
    };
    for (const rec of changeset.dirtyEdges) {
      const existing = stageManager.get(rec.uuid);
      const rebuilt = instantiateEdgeFromV3Record(project, rec, lookupEntity);
      if (!rebuilt) continue;
      if (existing) {
        rebuilt.isSelected = existing.isSelected;
        stageManager.replaceStageObject(existing, rebuilt);
      } else {
        stageManager.add(rebuilt, true);
        stageObjectCountChanged = true;
      }
      topologyChanged = true;
    }

    // 8. 新增 / 更新多目标无向边 & 孪生关联
    const lookupObject = (uuid: string): StageObject | undefined => stageManager.get(uuid);
    for (const rec of changeset.dirtyAssociations) {
      const existing = stageManager.get(rec.uuid);
      const rebuilt = instantiateAssociationFromV3Record(project, rec, lookupObject);
      if (!rebuilt) continue;
      if (existing) {
        rebuilt.isSelected = existing.isSelected;
        stageManager.replaceStageObject(existing, rebuilt);
      } else {
        stageManager.add(rebuilt, true);
        stageObjectCountChanged = true;
      }
      topologyChanged = true;
    }

    // 9. 应用单元格增量更新与删除（遵守 tableFields 不可变引用铁律）
    const touchedFieldEntities = new Map<string, Record<string, ReturnType<typeof decodeV3CellValue>>>();
    const ensureClonedFields = (entityUuid: string) => {
      let fields = touchedFieldEntities.get(entityUuid);
      if (fields) return fields;
      const ent = stageManager.get(entityUuid);
      if (!(ent instanceof Entity)) return undefined;
      fields = cloneTableFields(ent.tableFields);
      touchedFieldEntities.set(entityUuid, fields);
      return fields;
    };

    for (const del of changeset.deletedCells) {
      const fields = ensureClonedFields(del.entityUuid);
      if (fields && del.colId in fields) {
        delete fields[del.colId];
      }
    }
    for (const cell of changeset.dirtyCells) {
      const fields = ensureClonedFields(cell.entityUuid);
      if (!fields) continue;
      const decoded = decodeV3CellValue(cell);
      if (decoded === null || (Array.isArray(decoded) && decoded.length === 0)) {
        delete fields[cell.colId];
      } else {
        fields[cell.colId] = decoded;
      }
    }
    for (const [entityUuid, nextFields] of touchedFieldEntities) {
      const ent = stageManager.get(entityUuid);
      if (ent instanceof Entity) {
        ent.tableFields = nextFields;
      }
    }

    // 10. 仅当拓扑结构（增删对象、父子 Section、边、折叠）变动时才刷新运行时引用索引
    if (topologyChanged || stageObjectCountChanged || newlyInsertedEntities.length > 0) {
      stageManager.updateReferences();
    }

    if (changeset.revision > project.v3Revision) {
      project.v3Revision = changeset.revision;
    }
    project.bumpStageRevision?.();
  } finally {
    project.docCommandBus?.setSuppressTracking(prevSuppress);
  }

  if (options.notifyTable !== false && project.getService?.("stageTable")) {
    project.stageTable.onDocChangeSetApplied?.(changeset, {
      persistToSqlite: changeset.source !== "command",
    });
    project.stageTable.notifyChange({ emitSync: false });
  }
}
