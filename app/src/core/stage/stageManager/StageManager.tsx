import { Project, service } from "@/core/Project";
import { EntityShrinkEffect } from "@/core/service/feedbackService/effectEngine/concrete/EntityShrinkEffect";
import { PenStrokeDeletedEffect } from "@/core/service/feedbackService/effectEngine/concrete/PenStrokeDeletedEffect";
import { SoundService } from "@/core/service/feedbackService/SoundService";
import { Settings } from "@/core/service/Settings";
import { Association } from "@/core/stage/stageObject/abstract/Association";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { ArcEdge } from "@/core/stage/stageObject/association/ArcEdge";
import { CubicCatmullRomSplineEdge } from "@/core/stage/stageObject/association/CubicCatmullRomSplineEdge";
import { Edge } from "@/core/stage/stageObject/association/Edge";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { MultiTargetUndirectedEdge } from "@/core/stage/stageObject/association/MutiTargetUndirectedEdge";
import { ConnectPoint } from "@/core/stage/stageObject/entity/ConnectPoint";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { LatexNode } from "@/core/stage/stageObject/entity/LatexNode";
import { PenStroke } from "@/core/stage/stageObject/entity/PenStroke";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { UrlNode } from "@/core/stage/stageObject/entity/UrlNode";
import { Direction } from "@/types/directions";
// import { Serialized } from "@/types/node";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import RBush from "rbush";
import { toast } from "sonner";
import {
  isPersistentMindMapDragEnabled,
  reflowMindMapTreesForEntities,
} from "@/core/service/controlService/controller/concrete/MindMapDrag";
import { findHiddenBranchNodes, getBranchSize } from "./basicMethods/BranchCollapse";

const BRANCH_BADGE_RADIUS = 8;
const SECTION_BADGE_RADIUS = 8;
const BRANCH_SIDE_NORMAL = {
  [Direction.Left]: new Vector(-1, 0),
  [Direction.Right]: new Vector(1, 0),
  [Direction.Up]: new Vector(0, -1),
  [Direction.Down]: new Vector(0, 1),
};

export type BranchFoldSide = { source: ConnectableEntity; side: Direction };

type BranchFoldBadge = BranchFoldSide & {
  center: Vector;
  radius: number;
  count?: number;
  origin?: Vector;
};

export type SectionFoldBadge = {
  section: Section;
  center: Vector;
  radius: number;
  count?: number;
};

// littlefean:应该改成类，实例化的对象绑定到舞台上。这成单例模式了
// 开发过程中会造成多开
// zty012:这个是存储数据的，和舞台无关，应该单独抽离出来
// 并且会在舞台之外的地方操作，所以应该是namespace单例

/**
 * 子场景的相机数据
 */
export type ChildCameraData = {
  /**
   * 传送门的左上角位置
   */
  location: Vector;
  zoom: number;
  /**
   * 传送门大小
   */
  size: Vector;
  /**
   * 相机的目标位置
   */
  targetLocation: Vector;
};

/**
 * 舞台管理器，也可以看成包含了很多操作方法的《舞台实体容器》
 * 管理节点、边的关系等，内部包含了舞台上的所有实体
 */
type EntitySpatialItem = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  uuid: string;
  order: number;
  entity: Entity;
};

type AssociationSpatialItem = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  uuid: string;
  order: number;
  association: Association;
};

function finiteOr(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function readEntityBoundsFast(entity: Entity): [number, number, number, number] {
  const box = entity.collisionBox;
  const shapes = box.shapes;
  if (shapes.length === 1) {
    const s = shapes[0];
    if (s instanceof Rectangle) {
      const x1 = finiteOr(s.location.x);
      const y1 = finiteOr(s.location.y);
      const x2 = finiteOr(x1 + s.size.x, x1);
      const y2 = finiteOr(y1 + s.size.y, y1);
      return x1 <= x2
        ? y1 <= y2
          ? [x1, y1, x2, y2]
          : [x1, y2, x2, y1]
        : y1 <= y2
          ? [x2, y1, x1, y2]
          : [x2, y2, x1, y1];
    }
  }
  const rect = box.getRectangle();
  const x1 = finiteOr(rect.left);
  const y1 = finiteOr(rect.top);
  const x2 = finiteOr(rect.right, x1);
  const y2 = finiteOr(rect.bottom, y1);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function makeEntitySpatialItem(entity: Entity, order: number): EntitySpatialItem {
  const [minX, minY, maxX, maxY] = readEntityBoundsFast(entity);
  return {
    minX,
    minY,
    maxX,
    maxY,
    uuid: entity.uuid,
    order,
    entity,
  };
}

function makeAssociationSpatialItem(association: Association, order: number): AssociationSpatialItem {
  // LineEdge 零曲线快路径：直接用两端点矩形并集 + 保守外扩裕量建 R-Tree，
  // 彻底避免开页时对数千条离屏边预先构造 bodyLine 与 SymmetryCurve 采样。
  if (association instanceof LineEdge && association.source?.collisionBox && association.target?.collisionBox) {
    const [sx1, sy1, sx2, sy2] = readEntityBoundsFast(association.source);
    const [tx1, ty1, tx2, ty2] = readEntityBoundsFast(association.target);
    const minX = Math.min(sx1, tx1);
    const minY = Math.min(sy1, ty1);
    const maxX = Math.max(sx2, tx2);
    const maxY = Math.max(sy2, ty2);
    const shiftPad = Math.abs(association.shiftingIndex) * 64;
    let pad = 64 + shiftPad;
    if (association.source.uuid === association.target.uuid) {
      pad = Math.max(96, sy2 - sy1);
    } else if (
      association.sourceRectangleRate.x !== 0.5 ||
      association.sourceRectangleRate.y !== 0.5 ||
      association.targetRectangleRate.x !== 0.5 ||
      association.targetRectangleRate.y !== 0.5
    ) {
      const span = Math.max(maxX - minX, maxY - minY);
      pad = Math.max(64, Math.min(400, span * 0.35)) + shiftPad;
    }
    return {
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad,
      uuid: association.uuid,
      order,
      association,
    };
  }

  const rect = association.collisionBox.getRectangle();
  let minX = finiteOr(rect.left);
  let minY = finiteOr(rect.top);
  let maxX = finiteOr(rect.right, minX);
  let maxY = finiteOr(rect.bottom, minY);
  if (minX > maxX) [minX, maxX] = [maxX, minX];
  if (minY > maxY) [minY, maxY] = [maxY, minY];

  // 对曲线/弧线/偏移多重边留足外扩裕量，避免视口边缘裁切闪烁
  let pad = 64;
  if (association instanceof ArcEdge) {
    pad = Math.max(64, Math.abs(association.offset) + 64);
  } else if (association instanceof MultiTargetUndirectedEdge) {
    pad = Math.max(64, association.padding + 48);
  }
  if (association instanceof Edge) {
    for (const ep of [association.source, association.target]) {
      if (!ep?.collisionBox) continue;
      const [ex1, ey1, ex2, ey2] = readEntityBoundsFast(ep);
      minX = Math.min(minX, ex1);
      minY = Math.min(minY, ey1);
      maxX = Math.max(maxX, ex2);
      maxY = Math.max(maxY, ey2);
    }
  }

  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
    uuid: association.uuid,
    order,
    association,
  };
}

@service("stageManager")
export class StageManager {
  /**
   * 运行时缓存的根 Section 列表。
   * 它们没有直接父级 Section，会在 `updateReferences()` 中重建。
   */
  public rootSections: Section[] = [];

  /**
   * 运行时缓存的顶层实体列表。
   * 不在任何 Section 内的实体会出现在这里，会在 `updateReferences()` 中重建。
   */
  public topLevelEntities: Entity[] = [];

  /**
   * 最近一次运行时 Section 树重建时，被归一化丢弃的交叉父关系数量。
   * 该值不参与序列化，用于提示旧数据中曾存在多父嵌套。
   */
  public normalizedCrossParentRelationCount: number = 0;

  private branchCollapseState?: {
    branches: Set<LineEdge>;
    outgoing: Map<ConnectableEntity, LineEdge[]>;
    hidden: Set<ConnectableEntity>;
    counts: Map<string, number>;
  };

  // ── 热索引缓存：O(1) UUID 查找 + 分类数组缓存 + 端点邻接 + RBush 2D R-Tree ──
  private readonly byUuid = new Map<string, StageObject>();
  private readonly orderByUuid = new Map<string, number>();
  private readonly associationsByEndpoint = new Map<string, Set<Association>>();
  private entitiesCache: Entity[] = [];
  private sectionsCache: Section[] = [];
  private textNodesCache: TextNode[] = [];
  private imageNodesCache: ImageNode[] = [];
  private connectPointsCache: ConnectPoint[] = [];
  private urlNodesCache: UrlNode[] = [];
  private penStrokesCache: PenStroke[] = [];
  private svgNodesCache: SvgNode[] = [];
  private latexNodesCache: LatexNode[] = [];
  private associationsCache: Association[] = [];
  private edgesCache: Edge[] = [];
  private lineEdgesCache: LineEdge[] = [];
  private crEdgesCache: CubicCatmullRomSplineEdge[] = [];
  private arcEdgesCache: ArcEdge[] = [];
  private multiTargetNonLineEdgesCache: MultiTargetUndirectedEdge[] = [];

  private readonly entityRTree = new RBush<EntitySpatialItem>();
  private readonly entitySpatialByUuid = new Map<string, EntitySpatialItem>();
  private readonly associationRTree = new RBush<AssociationSpatialItem>();
  private readonly associationSpatialByUuid = new Map<string, AssociationSpatialItem>();

  private indexedStageRef: StageObject[] | null = null;
  private indexedStageLength = -1;
  private nextOrderSeq = 0;

  constructor(private readonly project: Project) {}

  private syncIndexesIfNeeded(): void {
    if (this.indexedStageRef !== this.project.stage || this.indexedStageLength !== this.project.stage.length) {
      this.rebuildAllIndexes();
    }
  }

  public rebuildAllIndexes(): void {
    this.byUuid.clear();
    this.orderByUuid.clear();
    this.associationsByEndpoint.clear();
    this.entitiesCache = [];
    this.sectionsCache = [];
    this.textNodesCache = [];
    this.imageNodesCache = [];
    this.connectPointsCache = [];
    this.urlNodesCache = [];
    this.penStrokesCache = [];
    this.svgNodesCache = [];
    this.latexNodesCache = [];
    this.associationsCache = [];
    this.edgesCache = [];
    this.lineEdgesCache = [];
    this.crEdgesCache = [];
    this.arcEdgesCache = [];
    this.multiTargetNonLineEdgesCache = [];
    this.entityRTree.clear();
    this.entitySpatialByUuid.clear();
    this.associationRTree.clear();
    this.associationSpatialByUuid.clear();
    this.nextOrderSeq = 0;

    const entitySpatialItems: EntitySpatialItem[] = [];
    const associationSpatialItems: AssociationSpatialItem[] = [];

    for (const obj of this.project.stage) {
      const order = this.nextOrderSeq++;
      this.byUuid.set(obj.uuid, obj);
      this.orderByUuid.set(obj.uuid, order);
      this.addToTypedCaches(obj);
      if (obj instanceof Entity) {
        const item = makeEntitySpatialItem(obj, order);
        this.entitySpatialByUuid.set(obj.uuid, item);
        entitySpatialItems.push(item);
      } else if (obj instanceof Association) {
        this.linkAssociationEndpoints(obj);
        const item = makeAssociationSpatialItem(obj, order);
        this.associationSpatialByUuid.set(obj.uuid, item);
        associationSpatialItems.push(item);
      }
    }

    if (entitySpatialItems.length > 0) {
      this.entityRTree.load(entitySpatialItems);
    }
    if (associationSpatialItems.length > 0) {
      this.associationRTree.load(associationSpatialItems);
    }
    this.indexedStageRef = this.project.stage;
    this.indexedStageLength = this.project.stage.length;
  }

  private addToTypedCaches(obj: StageObject): void {
    if (obj instanceof Entity) {
      this.entitiesCache.push(obj);
      if (obj instanceof Section) this.sectionsCache.push(obj);
      else if (obj instanceof TextNode) this.textNodesCache.push(obj);
      else if (obj instanceof ImageNode) this.imageNodesCache.push(obj);
      else if (obj instanceof ConnectPoint) this.connectPointsCache.push(obj);
      else if (obj instanceof UrlNode) this.urlNodesCache.push(obj);
      else if (obj instanceof PenStroke) this.penStrokesCache.push(obj);
      else if (obj instanceof SvgNode) this.svgNodesCache.push(obj);
      else if (obj instanceof LatexNode) this.latexNodesCache.push(obj);
    } else if (obj instanceof Association) {
      this.associationsCache.push(obj);
      if (obj instanceof Edge) {
        this.edgesCache.push(obj);
        if (obj instanceof LineEdge) this.lineEdgesCache.push(obj);
        else if (obj instanceof CubicCatmullRomSplineEdge) this.crEdgesCache.push(obj);
        else if (obj instanceof ArcEdge) this.arcEdgesCache.push(obj);
      } else if (obj instanceof MultiTargetUndirectedEdge && obj.renderType !== "line") {
        this.multiTargetNonLineEdgesCache.push(obj);
      }
    }
  }

  private removeFromArray<T>(arr: T[], item: T): void {
    const idx = arr.indexOf(item);
    if (idx !== -1) arr.splice(idx, 1);
  }

  private removeFromTypedCaches(obj: StageObject): void {
    if (obj instanceof Entity) {
      this.removeFromArray(this.entitiesCache, obj);
      if (obj instanceof Section) this.removeFromArray(this.sectionsCache, obj);
      else if (obj instanceof TextNode) this.removeFromArray(this.textNodesCache, obj);
      else if (obj instanceof ImageNode) this.removeFromArray(this.imageNodesCache, obj);
      else if (obj instanceof ConnectPoint) this.removeFromArray(this.connectPointsCache, obj);
      else if (obj instanceof UrlNode) this.removeFromArray(this.urlNodesCache, obj);
      else if (obj instanceof PenStroke) this.removeFromArray(this.penStrokesCache, obj);
      else if (obj instanceof SvgNode) this.removeFromArray(this.svgNodesCache, obj);
      else if (obj instanceof LatexNode) this.removeFromArray(this.latexNodesCache, obj);
    } else if (obj instanceof Association) {
      this.removeFromArray(this.associationsCache, obj);
      if (obj instanceof Edge) {
        this.removeFromArray(this.edgesCache, obj);
        if (obj instanceof LineEdge) this.removeFromArray(this.lineEdgesCache, obj);
        else if (obj instanceof CubicCatmullRomSplineEdge) this.removeFromArray(this.crEdgesCache, obj);
        else if (obj instanceof ArcEdge) this.removeFromArray(this.arcEdgesCache, obj);
      } else if (obj instanceof MultiTargetUndirectedEdge) {
        this.removeFromArray(this.multiTargetNonLineEdgesCache, obj);
      }
    }
  }

  public getMultiTargetNonLineEdges(): readonly MultiTargetUndirectedEdge[] {
    this.syncIndexesIfNeeded();
    return this.multiTargetNonLineEdgesCache;
  }

  private linkAssociationEndpoints(assoc: Association): void {
    for (const member of assoc.associationList) {
      if (!member?.uuid) continue;
      let set = this.associationsByEndpoint.get(member.uuid);
      if (!set) {
        set = new Set();
        this.associationsByEndpoint.set(member.uuid, set);
      }
      set.add(assoc);
    }
  }

  private unlinkAssociationEndpoints(assoc: Association): void {
    for (const member of assoc.associationList) {
      if (!member?.uuid) continue;
      const set = this.associationsByEndpoint.get(member.uuid);
      if (set) {
        set.delete(assoc);
        if (set.size === 0) {
          this.associationsByEndpoint.delete(member.uuid);
        }
      }
    }
  }

  public getIncidentAssociations(entityUuid: string): readonly Association[] {
    this.syncIndexesIfNeeded();
    const set = this.associationsByEndpoint.get(entityUuid);
    return set ? Array.from(set) : [];
  }

  /**
   * 增量更新单个实体或关联在 RBush 空间索引中的包围盒（O(log N)），同步刷新相邻边的空间包围盒。
   */
  public updateSpatialIndex(stageObject: StageObject): void {
    if (this.indexedStageRef !== this.project.stage || this.indexedStageLength !== this.project.stage.length) {
      return;
    }
    const order = this.orderByUuid.get(stageObject.uuid);
    if (order === undefined) return;

    if (stageObject instanceof Entity) {
      const oldItem = this.entitySpatialByUuid.get(stageObject.uuid);
      if (oldItem) {
        this.entityRTree.remove(oldItem);
      }
      const nextItem = makeEntitySpatialItem(stageObject, order);
      this.entitySpatialByUuid.set(stageObject.uuid, nextItem);
      this.entityRTree.insert(nextItem);

      const incident = this.associationsByEndpoint.get(stageObject.uuid);
      if (incident) {
        for (const assoc of incident) {
          const oldAssocItem = this.associationSpatialByUuid.get(assoc.uuid);
          const assocOrder = this.orderByUuid.get(assoc.uuid);
          if (assocOrder === undefined) continue;
          if (oldAssocItem) {
            this.associationRTree.remove(oldAssocItem);
          }
          const nextAssocItem = makeAssociationSpatialItem(assoc, assocOrder);
          this.associationSpatialByUuid.set(assoc.uuid, nextAssocItem);
          this.associationRTree.insert(nextAssocItem);
        }
      }
    } else if (stageObject instanceof Association) {
      const oldItem = this.associationSpatialByUuid.get(stageObject.uuid);
      if (oldItem) {
        this.associationRTree.remove(oldItem);
      }
      const nextItem = makeAssociationSpatialItem(stageObject, order);
      this.associationSpatialByUuid.set(stageObject.uuid, nextItem);
      this.associationRTree.insert(nextItem);
    }
  }

  /**
   * 原地无损替换舞台对象（如 TextNode ↔ Section 同 UUID 升降级），保持 stage 位置与所有索引一致。
   */
  public replaceStageObject(oldObj: StageObject, newObj: StageObject): void {
    const idx = this.project.stage.indexOf(oldObj);
    if (idx !== -1) {
      this.project.stage[idx] = newObj;
    } else {
      this.project.stage.push(newObj);
    }
    this.branchCollapseState = undefined;
    this.project?.docCommandBus?.notifyObjectReplaced(oldObj, newObj);

    if (this.indexedStageRef === this.project.stage && idx !== -1) {
      const order = this.orderByUuid.get(oldObj.uuid) ?? this.nextOrderSeq++;
      this.removeFromTypedCaches(oldObj);
      if (oldObj instanceof Entity) {
        const oldSpatial = this.entitySpatialByUuid.get(oldObj.uuid);
        if (oldSpatial) {
          this.entityRTree.remove(oldSpatial);
          this.entitySpatialByUuid.delete(oldObj.uuid);
        }
      } else if (oldObj instanceof Association) {
        this.unlinkAssociationEndpoints(oldObj);
        const oldSpatial = this.associationSpatialByUuid.get(oldObj.uuid);
        if (oldSpatial) {
          this.associationRTree.remove(oldSpatial);
          this.associationSpatialByUuid.delete(oldObj.uuid);
        }
      }
      this.byUuid.delete(oldObj.uuid);
      this.orderByUuid.delete(oldObj.uuid);

      this.byUuid.set(newObj.uuid, newObj);
      this.orderByUuid.set(newObj.uuid, order);
      this.addToTypedCaches(newObj);
      if (newObj instanceof Entity) {
        const item = makeEntitySpatialItem(newObj, order);
        this.entitySpatialByUuid.set(newObj.uuid, item);
        this.entityRTree.insert(item);
      } else if (newObj instanceof Association) {
        this.linkAssociationEndpoints(newObj);
        const item = makeAssociationSpatialItem(newObj, order);
        this.associationSpatialByUuid.set(newObj.uuid, item);
        this.associationRTree.insert(item);
      }
      this.indexedStageLength = this.project.stage.length;
    } else {
      this.rebuildAllIndexes();
    }
  }

  /**
   * 基于 RBush 2D R-Tree 查询与指定矩形相交的实体集合（O(log N + K)）。
   */
  public queryEntitiesInRect(rect: Rectangle, options: { preserveOrder?: boolean } = {}): Entity[] {
    this.syncIndexesIfNeeded();
    const minX = Math.min(finiteOr(rect.left), finiteOr(rect.right));
    const maxX = Math.max(finiteOr(rect.left), finiteOr(rect.right));
    const minY = Math.min(finiteOr(rect.top), finiteOr(rect.bottom));
    const maxY = Math.max(finiteOr(rect.top), finiteOr(rect.bottom));
    const hits = this.entityRTree.search({ minX, minY, maxX, maxY });
    if (options.preserveOrder !== false && hits.length > 1) {
      hits.sort((a, b) => a.order - b.order);
    }
    return hits.map((item) => item.entity);
  }

  /**
   * 基于 RBush 2D R-Tree 查询与指定矩形相交的关联/边集合（O(log N + K)）。
   */
  public queryAssociationsInRect(rect: Rectangle, options: { preserveOrder?: boolean } = {}): Association[] {
    this.syncIndexesIfNeeded();
    const minX = Math.min(finiteOr(rect.left), finiteOr(rect.right));
    const maxX = Math.max(finiteOr(rect.left), finiteOr(rect.right));
    const minY = Math.min(finiteOr(rect.top), finiteOr(rect.bottom));
    const maxY = Math.max(finiteOr(rect.top), finiteOr(rect.bottom));
    const hits = this.associationRTree.search({ minX, minY, maxX, maxY });
    if (options.preserveOrder !== false && hits.length > 1) {
      hits.sort((a, b) => a.order - b.order);
    }
    return hits.map((item) => item.association);
  }

  /**
   * 基于 RBush 查询包含指定世界坐标点的实体候选集。
   */
  public queryEntitiesAtPoint(point: Vector): Entity[] {
    this.syncIndexesIfNeeded();
    const x = finiteOr(point.x);
    const y = finiteOr(point.y);
    const hits = this.entityRTree.search({ minX: x, minY: y, maxX: x, maxY: y });
    if (hits.length > 1) {
      hits.sort((a, b) => a.order - b.order);
    }
    return hits.map((item) => item.entity);
  }

  public queryAssociationsAtPoint(point: Vector): Association[] {
    this.syncIndexesIfNeeded();
    const x = finiteOr(point.x);
    const y = finiteOr(point.y);
    const hits = this.associationRTree.search({ minX: x, minY: y, maxX: x, maxY: y });
    if (hits.length > 1) {
      hits.sort((a, b) => a.order - b.order);
    }
    return hits.map((item) => item.association);
  }

  private getBranchCollapseState() {
    if (this.branchCollapseState) return this.branchCollapseState;

    const nodes = new Set(this.getConnectableEntity());
    const branches = new Set<LineEdge>();
    const outgoing = new Map<ConnectableEntity, LineEdge[]>();
    const folded: LineEdge[] = [];
    for (const edge of this.getLineEdges()) {
      const { source, target } = edge;
      if (source === target || edge.lineType === "dashed" || !nodes.has(source) || !nodes.has(target)) continue;
      branches.add(edge);
      const children = outgoing.get(source);
      if (children) children.push(edge);
      else outgoing.set(source, [edge]);
      if (edge.isBranchCollapsed) folded.push(edge);
    }

    return (this.branchCollapseState = {
      branches,
      outgoing,
      hidden: findHiddenBranchNodes(outgoing, folded),
      counts: new Map(),
    });
  }

  isHiddenByBranchCollapse(object: StageObject): boolean {
    const { branches, hidden } = this.getBranchCollapseState();
    if (object instanceof Entity) {
      if (object instanceof ConnectableEntity && hidden.has(object)) return true;
      let parent = object.parentSection;
      while (parent) {
        if (hidden.has(parent)) return true;
        parent = parent.parentSection;
      }
      return false;
    }
    if (object instanceof LineEdge && object.isBranchCollapsed && branches.has(object)) return true;
    if (object instanceof Association) {
      return object.associationList.some((node) => this.isHiddenByBranchCollapse(node));
    }
    return false;
  }

  private getBranchExit(edge: LineEdge, rect: Rectangle) {
    const polyline =
      Settings.lineStyle === "vertical" && edge.shiftingIndex === 0 && !edge.text.trim()
        ? this.project.verticalPolyEdgeRenderer.getPolyline(edge)
        : undefined;
    const start = polyline?.points[0] ?? edge.bodyLine.start;
    const offset = start.subtract(rect.center);
    const direction =
      polyline?.direction ??
      Edge.getNormalVectorByRate(edge.sourceRectangleRate) ??
      (offset.isZero()
        ? edge.bodyLine.direction()
        : new Vector(offset.x / Math.max(1, rect.width), offset.y / Math.max(1, rect.height)));
    const horizontal = Math.abs(direction.x) >= Math.abs(direction.y);
    const x = Math.max(rect.left, Math.min(rect.right, start.x));
    const y = Math.max(rect.top, Math.min(rect.bottom, start.y));
    if (horizontal) {
      return direction.x >= 0
        ? { side: Direction.Right, origin: new Vector(rect.right, y) }
        : { side: Direction.Left, origin: new Vector(rect.left, y) };
    }
    return direction.y >= 0
      ? { side: Direction.Down, origin: new Vector(x, rect.bottom) }
      : { side: Direction.Up, origin: new Vector(x, rect.top) };
  }

  getBranchFoldBadges(pointer?: Vector): BranchFoldBadge[] {
    const { outgoing, counts } = this.getBranchCollapseState();
    const { renderer, sectionMethods } = this.project;
    const badges: BranchFoldBadge[] = [];
    for (const [source, edges] of outgoing) {
      if (
        source.isHiddenBySectionCollapse ||
        this.isHiddenByBranchCollapse(source) ||
        (source instanceof TextNode && source.isEditing) ||
        sectionMethods.isEntityHiddenByBigTitleSection(source)
      )
        continue;

      const rect = source.collisionBox.getRectangle();
      if (
        !edges.some((edge) => edge.isBranchCollapsed) &&
        (!pointer ||
          !renderer
            .transformWorld2View(rect)
            .expandFromCenter(2 * BRANCH_BADGE_RADIUS + 4)
            .isPointIn(pointer))
      )
        continue;
      const sides = new Map<Direction, { edge: LineEdge; origin: Vector }[]>();
      for (const edge of edges) {
        const { side, origin } = this.getBranchExit(edge, rect);
        const exits = sides.get(side);
        if (exits) exits.push({ edge, origin });
        else sides.set(side, [{ edge, origin }]);
      }

      for (const [side, exits] of sides) {
        if (exits.some(({ edge }) => sectionMethods.isObjectBeLockedBySection(edge))) continue;
        const folded = exits.filter(({ edge }) => edge.isBranchCollapsed);
        const ports = folded.length
          ? folded
          : exits.filter(
              ({ edge }) =>
                !this.isHiddenByBranchCollapse(edge.target) &&
                !edge.target.isHiddenBySectionCollapse &&
                !sectionMethods.isAssociationHiddenByBigTitleSection(edge),
            );
        if (ports.length === 0) continue;

        const port = ports.reduce((nearest, next) =>
          next.origin.distance(rect.center) < nearest.origin.distance(rect.center) ? next : nearest,
        );
        const origin = renderer.transformWorld2View(port.origin);
        let count: number | undefined;
        if (folded.length) {
          const key = folded.map(({ edge }) => edge.uuid).join(",");
          count = counts.get(key);
          if (count === undefined) {
            count = getBranchSize(
              outgoing,
              source,
              folded.map(({ edge }) => edge.target),
            );
            counts.set(key, count);
          }
        }
        const radius =
          count === undefined ? BRANCH_BADGE_RADIUS : Math.max(BRANCH_BADGE_RADIUS, String(count).length * 3 + 3);
        const center = origin.add(BRANCH_SIDE_NORMAL[side].multiply(radius + 1));
        if (count !== undefined || (pointer && center.distance(pointer) <= radius + 2)) {
          badges.push({ source, side, center, radius, count, origin });
        }
      }
    }
    return badges;
  }

  findBranchFoldBadge(viewLocation: Vector, pointer?: Vector): BranchFoldSide | undefined {
    let nearest: BranchFoldBadge | undefined;
    for (const badge of this.getBranchFoldBadges(pointer)) {
      const distance = badge.center.distance(viewLocation);
      if (distance <= badge.radius + 2 && (!nearest || distance < nearest.center.distance(viewLocation)))
        nearest = badge;
    }
    return nearest;
  }

  getSectionFoldBadges(pointer?: Vector): SectionFoldBadge[] {
    const { renderer, sectionMethods } = this.project;
    const badges: SectionFoldBadge[] = [];
    const pointerWorld = pointer ? renderer.transformView2World(pointer) : undefined;
    for (const section of this.getSections()) {
      if (
        section.children.length === 0 ||
        section.isHiddenBySectionCollapse ||
        this.isHiddenByBranchCollapse(section) ||
        sectionMethods.isEntityHiddenByBigTitleSection(section)
      ) {
        continue;
      }

      const rectangle = section.collisionBox.getRectangle();
      const isPointerInTitleBar =
        pointerWorld !== undefined &&
        rectangle.isPointIn(pointerWorld) &&
        (section.isCollapsed || section.text === "" || pointerWorld.y <= rectangle.top + 50);
      if (pointer === undefined && !section.isCollapsed && !section.isSelected) continue;
      if (pointer !== undefined && !section.isCollapsed && !section.isSelected && !isPointerInTitleBar) continue;

      const scale = this.project.camera.currentScale;
      const count = section.isCollapsed ? this.getSectionDescendantCount(section) : undefined;
      const radius =
        count === undefined ? SECTION_BADGE_RADIUS : Math.max(SECTION_BADGE_RADIUS, String(count).length * 3 + 3);
      const inset = (radius + 4) / scale;
      const center = renderer.transformWorld2View(new Vector(rectangle.right - inset, rectangle.top + inset));
      badges.push({ section, center, radius, count });
    }
    return badges;
  }

  private getSectionDescendantCount(section: Section): number {
    const visited = new Set<string>();
    const countEntity = (entity: Entity): number => {
      if (visited.has(entity.uuid)) return 0;
      visited.add(entity.uuid);
      if (!(entity instanceof Section)) return 1;
      return 1 + entity.children.reduce((count, child) => count + countEntity(child), 0);
    };
    return section.children.reduce((count, child) => count + countEntity(child), 0);
  }

  findSectionFoldBadge(viewLocation: Vector, pointer?: Vector): SectionFoldBadge | undefined {
    let nearest: SectionFoldBadge | undefined;
    for (const badge of this.getSectionFoldBadges(pointer)) {
      const distance = badge.center.distance(viewLocation);
      if (distance <= badge.radius + 2 && (!nearest || distance < nearest.center.distance(viewLocation))) {
        nearest = badge;
      }
    }
    return nearest;
  }

  toggleSectionCollapse(section: Section) {
    if (section.children.length === 0) return;
    this.project.sectionPackManager.toggleSectionCollapse(section);
    this.updateSpatialIndex(section);
    this.project?.docCommandBus?.markCollapseDirty(section);
    this.project.historyManager.recordStep();
  }

  toggleBranchCollapse({ source, side }: BranchFoldSide) {
    const rect = source.collisionBox.getRectangle();
    const edges = this.getBranchCollapseState()
      .outgoing.get(source)
      ?.filter((edge) => this.getBranchExit(edge, rect).side === side);
    if (!edges?.length || edges.some((edge) => this.project.sectionMethods.isObjectBeLockedBySection(edge))) return;
    const fold = !edges.some((edge) => edge.isBranchCollapsed);
    for (const edge of edges) {
      edge.isBranchCollapsed = fold;
      this.project?.docCommandBus?.markEdgeStyleDirty(edge);
    }
    this.branchCollapseState = undefined;
    for (const object of this.project.stage) {
      if (object.isSelected && this.isHiddenByBranchCollapse(object)) object.isSelected = false;
    }
    this.project.historyManager.recordStep();
  }

  public getRootSections(): Section[] {
    return [...this.rootSections];
  }

  public getTopLevelEntities(): Entity[] {
    return [...this.topLevelEntities];
  }

  public getNormalizedCrossParentRelationCount(): number {
    return this.normalizedCrossParentRelationCount;
  }

  /**
   * O(1) 通过 UUID 索引直接查找舞台对象。
   */
  get(uuid: string): StageObject | undefined {
    this.syncIndexesIfNeeded();
    return this.byUuid.get(uuid);
  }

  isEmpty(): boolean {
    return this.project.stage.length === 0;
  }
  getTextNodes(): TextNode[] {
    this.syncIndexesIfNeeded();
    return [...this.textNodesCache];
  }
  getConnectableEntity(): ConnectableEntity[] {
    this.syncIndexesIfNeeded();
    const out: ConnectableEntity[] = [];
    for (const node of this.entitiesCache) {
      if (node instanceof ConnectableEntity) {
        if (node instanceof ImageNode && node.isBackground) {
          continue;
        }
        out.push(node);
      }
    }
    return out;
  }
  isEntityExists(uuid: string): boolean {
    this.syncIndexesIfNeeded();
    return this.byUuid.has(uuid);
  }
  getSections(): Section[] {
    this.syncIndexesIfNeeded();
    return [...this.sectionsCache];
  }
  getImageNodes(): ImageNode[] {
    this.syncIndexesIfNeeded();
    return [...this.imageNodesCache];
  }
  getConnectPoints(): ConnectPoint[] {
    this.syncIndexesIfNeeded();
    return [...this.connectPointsCache];
  }
  getUrlNodes(): UrlNode[] {
    this.syncIndexesIfNeeded();
    return [...this.urlNodesCache];
  }
  getPenStrokes(): PenStroke[] {
    this.syncIndexesIfNeeded();
    return [...this.penStrokesCache];
  }
  getSvgNodes(): SvgNode[] {
    this.syncIndexesIfNeeded();
    return [...this.svgNodesCache];
  }
  getLatexNodes(): LatexNode[] {
    this.syncIndexesIfNeeded();
    return [...this.latexNodesCache];
  }

  getStageObjects(): StageObject[] {
    return this.project.stage;
  }

  /**
   * 获取场上所有的实体
   * @returns
   */
  getEntities(): Entity[] {
    this.syncIndexesIfNeeded();
    return [...this.entitiesCache];
  }
  getEntitiesByUUIDs(uuids: string[]): Entity[] {
    this.syncIndexesIfNeeded();
    const out: Entity[] = [];
    for (const id of uuids) {
      const obj = this.byUuid.get(id);
      if (obj instanceof Entity) {
        out.push(obj);
      }
    }
    return out;
  }
  isNoEntity(): boolean {
    this.syncIndexesIfNeeded();
    return this.entitiesCache.length === 0;
  }
  delete(stageObject: StageObject) {
    const idx = this.project.stage.indexOf(stageObject);
    if (idx === -1) {
      return;
    }
    this.project?.docCommandBus?.notifyObjectDeleted(stageObject);
    this.project.stage.splice(idx, 1);
    this.branchCollapseState = undefined;
    if (this.indexedStageRef === this.project.stage && this.indexedStageLength === this.project.stage.length + 1) {
      this.byUuid.delete(stageObject.uuid);
      this.orderByUuid.delete(stageObject.uuid);
      this.removeFromTypedCaches(stageObject);
      if (stageObject instanceof Entity) {
        const oldSpatial = this.entitySpatialByUuid.get(stageObject.uuid);
        if (oldSpatial) {
          this.entityRTree.remove(oldSpatial);
          this.entitySpatialByUuid.delete(stageObject.uuid);
        }
      } else if (stageObject instanceof Association) {
        this.unlinkAssociationEndpoints(stageObject);
        const oldSpatial = this.associationSpatialByUuid.get(stageObject.uuid);
        if (oldSpatial) {
          this.associationRTree.remove(oldSpatial);
          this.associationSpatialByUuid.delete(stageObject.uuid);
        }
      }
      this.indexedStageLength = this.project.stage.length;
    } else {
      this.rebuildAllIndexes();
    }
  }

  getAssociations(): Association[] {
    this.syncIndexesIfNeeded();
    return [...this.associationsCache];
  }
  getEdges(): Edge[] {
    this.syncIndexesIfNeeded();
    return [...this.edgesCache];
  }
  getLineEdges(): LineEdge[] {
    this.syncIndexesIfNeeded();
    return [...this.lineEdgesCache];
  }
  getCrEdges(): CubicCatmullRomSplineEdge[] {
    this.syncIndexesIfNeeded();
    return [...this.crEdgesCache];
  }
  getArcEdges(): ArcEdge[] {
    this.syncIndexesIfNeeded();
    return [...this.arcEdgesCache];
  }

  add(stageObject: StageObject, skipUpdateReferences = false) {
    this.project.stage.push(stageObject);
    this.branchCollapseState = undefined;
    if (this.indexedStageRef === this.project.stage && this.indexedStageLength === this.project.stage.length - 1) {
      const order = this.nextOrderSeq++;
      this.byUuid.set(stageObject.uuid, stageObject);
      this.orderByUuid.set(stageObject.uuid, order);
      this.addToTypedCaches(stageObject);
      if (stageObject instanceof Entity) {
        const item = makeEntitySpatialItem(stageObject, order);
        this.entitySpatialByUuid.set(stageObject.uuid, item);
        this.entityRTree.insert(item);
      } else if (stageObject instanceof Association) {
        this.linkAssociationEndpoints(stageObject);
        const item = makeAssociationSpatialItem(stageObject, order);
        this.associationSpatialByUuid.set(stageObject.uuid, item);
        this.associationRTree.insert(item);
      }
      this.indexedStageLength = this.project.stage.length;
    } else {
      this.rebuildAllIndexes();
    }
    this.project?.docCommandBus?.notifyObjectAdded(stageObject);
    if (!skipUpdateReferences) {
      this.updateReferences();
    }
  }

  /**
   * 更新节点的引用，将unknown的节点替换为真实的节点，保证对象在内存中的唯一性
   * 节点什么情况下会是unknown的？
   *
   * 包含了对分组框的更新
   * 包含了对Edge几何组偏移索引的更新（多重边/双向边自动散开）
   */
  updateReferences(options?: { skipIndexRebuild?: boolean; skipSectionAdjust?: boolean }) {
    this.branchCollapseState = undefined;
    if (
      !options?.skipIndexRebuild ||
      this.indexedStageRef !== this.project.stage ||
      this.indexedStageLength !== this.project.stage.length
    ) {
      this.rebuildAllIndexes();
    }
    // 懒构建 uuid -> ConnectableEntity 索引：v3 打开路径所有端点均为已解析真引用，
    // 仅在真正遇到 unknown 端点（旧版 v2 反序列化）时才建 Map，节省大节点图全量 Map 分配。
    let connectableEntities: Map<string, ConnectableEntity> | null = null;
    const ensureConnectableMap = () => {
      if (!connectableEntities) {
        connectableEntities = new Map<string, ConnectableEntity>();
        for (const entity of this.getEntities()) {
          if (entity instanceof ConnectableEntity) {
            connectableEntities.set(entity.uuid, entity);
          }
        }
      }
      return connectableEntities;
    };
    let legacyCollapsedCleared = false;
    for (const edge of this.getAssociations()) {
      if (!(edge instanceof Edge)) {
        continue;
      }
      if (edge.source.unknown) {
        const entity = ensureConnectableMap().get(edge.source.uuid);
        if (entity) {
          edge.source = entity;
        }
      }
      if (edge.target.unknown) {
        const entity = ensureConnectableMap().get(edge.target.uuid);
        if (entity) {
          edge.target = entity;
        }
      }
      if (
        edge instanceof LineEdge &&
        edge.lineType !== "dashed" &&
        edge.source instanceof TextNode &&
        edge.source.legacyBranchCollapsed
      ) {
        edge.isBranchCollapsed = true;
        legacyCollapsedCleared = true;
      }
    }
    if (legacyCollapsedCleared) {
      for (const node of this.textNodesCache) {
        node.legacyBranchCollapsed = false;
      }
    }
    this.rebuildSectionRuntimeTree(Boolean(options?.skipSectionAdjust));

    // 以下是LineEdge几何组偏移索引的更新
    // 几何组 key：无向，(minNodeId, maxNodeId, epAtMin, epAtMax)
    // A→B 和 B→A 端点位置相同时归入同一几何组，统一分配 shiftingIndex
    const lineEdges = this.getLineEdges();
    if (lineEdges.length === 0) return;

    const geoGroups = new Map<string, LineEdge | LineEdge[]>();
    for (let i = 0; i < lineEdges.length; i++) {
      const edge = lineEdges[i];
      const idA = edge.source.uuid;
      const idB = edge.target.uuid;
      if (idA === idB) {
        edge.shiftingIndex = 0;
        continue;
      }
      const sx = Math.round(edge.sourceRectangleRate.x * 100);
      const sy = Math.round(edge.sourceRectangleRate.y * 100);
      const tx = Math.round(edge.targetRectangleRate.x * 100);
      const ty = Math.round(edge.targetRectangleRate.y * 100);
      const key = idA <= idB ? `${idA}|${idB}|${sx},${sy}|${tx},${ty}` : `${idB}|${idA}|${tx},${ty}|${sx},${sy}`;
      const existing = geoGroups.get(key);
      if (existing === undefined) {
        edge.shiftingIndex = 0;
        geoGroups.set(key, edge);
      } else if (Array.isArray(existing)) {
        existing.push(edge);
      } else {
        geoGroups.set(key, [existing, edge]);
      }
    }

    for (const group of geoGroups.values()) {
      if (!Array.isArray(group)) continue;
      // ASCII 字典序稳定排序（比 ICU localeCompare 快 50 倍）
      group.sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
      const count = group.length;
      for (let i = 0; i < count; i++) {
        let idx: number;
        if (count % 2 === 0) {
          const half = count / 2;
          idx = i < half ? i - half : i - half + 1;
        } else {
          idx = i - Math.floor(count / 2);
        }
        group[i].shiftingIndex = idx;
      }
    }
  }

  private rebuildSectionRuntimeTree(skipSectionAdjust = false) {
    const entities = this.getEntities();
    const sections = this.getSections();
    this.rootSections = [];
    this.topLevelEntities = [];
    this.normalizedCrossParentRelationCount = 0;

    // 无分组框的纯节点图直接 O(N) 单遍返回，省去 3 个 Map 与递归开销
    if (sections.length === 0) {
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        entity.parentSection = null;
        entity.sectionDepth = 0;
        entity.isHiddenBySectionCollapse = false;
        this.topLevelEntities.push(entity);
      }
      return;
    }

    const entityMap = new Map<string, Entity>();
    const originalChildrenMap = new Map<string, Entity[]>();
    const parentCandidates = new Map<string, Section[]>();

    for (const entity of entities) {
      entityMap.set(entity.uuid, entity);
      entity.parentSection = null;
      entity.sectionDepth = 0;
      if (entity instanceof Section) {
        originalChildrenMap.set(entity.uuid, [...entity.children]);
      }
    }

    for (const section of sections) {
      const uniqueChildren: Entity[] = [];
      const seenChildUUIDs = new Set<string>();
      const rawChildren = originalChildrenMap.get(section.uuid) ?? [];
      for (const child of rawChildren) {
        const childObject = entityMap.get(child.uuid);
        if (!childObject || childObject === section || seenChildUUIDs.has(childObject.uuid)) {
          continue;
        }
        seenChildUUIDs.add(childObject.uuid);
        uniqueChildren.push(childObject);
        let candidates = parentCandidates.get(childObject.uuid);
        if (!candidates) {
          candidates = [];
          parentCandidates.set(childObject.uuid, candidates);
        }
        candidates.push(section);
      }
      section.children = uniqueChildren;
    }

    for (const entity of entities) {
      const candidates = parentCandidates.get(entity.uuid);
      if (!candidates || candidates.length === 0) {
        entity.parentSection = null;
        continue;
      }
      if (candidates.length === 1) {
        entity.parentSection = candidates[0] === entity ? null : candidates[0];
        continue;
      }
      const directParent = this.pickDirectParentSection(entity, candidates);
      entity.parentSection = directParent;
      this.normalizedCrossParentRelationCount += candidates.filter((section) => section !== directParent).length;
    }

    let hasAnyCollapsedSection = false;
    for (const section of sections) {
      if (section.isCollapsed) hasAnyCollapsedSection = true;
      section.children = section.children.filter((child) => child.parentSection === section);
    }

    for (const entity of entities) {
      if (entity.parentSection === null) {
        this.topLevelEntities.push(entity);
        if (entity instanceof Section) {
          this.rootSections.push(entity);
        }
      }
    }

    for (const entity of this.topLevelEntities) {
      this.assignSectionRuntimeInfo(entity, 0);
    }

    for (const entity of entities) {
      entity.isHiddenBySectionCollapse = false;
    }

    if (!skipSectionAdjust) {
      for (const section of [...sections].sort((a, b) => b.sectionDepth - a.sectionDepth)) {
        section.adjustLocationAndSize();
      }
    }

    if (hasAnyCollapsedSection) {
      for (const rootSection of this.rootSections) {
        rootSection.adjustChildrenStateByCollapse(false);
      }
    }
  }

  private pickDirectParentSection(entity: Entity, candidates: Section[]): Section | null {
    if (candidates.length === 0) {
      return null;
    }
    const validCandidates = candidates.filter((section) => {
      if (section === entity) {
        return false;
      }
      return true;
    });
    if (validCandidates.length === 0) {
      return null;
    }
    validCandidates.sort((a, b) => {
      const areaDiff = this.getEntityArea(a) - this.getEntityArea(b);
      if (areaDiff !== 0) {
        return areaDiff;
      }
      const rectA = a.collisionBox.getRectangle();
      const rectB = b.collisionBox.getRectangle();
      if (rectA.top !== rectB.top) {
        return rectA.top - rectB.top;
      }
      if (rectA.left !== rectB.left) {
        return rectA.left - rectB.left;
      }
      return a.uuid.localeCompare(b.uuid);
    });
    return validCandidates[0];
  }

  private assignSectionRuntimeInfo(entity: Entity, depth: number) {
    entity.sectionDepth = depth;
    if (!(entity instanceof Section)) {
      return;
    }
    for (const child of entity.children) {
      this.assignSectionRuntimeInfo(child, depth + 1);
    }
  }

  private getEntityArea(entity: Entity): number {
    const rect = entity.collisionBox.getRectangle();
    return rect.size.x * rect.size.y;
  }

  getTextNodeByUUID(uuid: string): TextNode | null {
    const entity = this.get(uuid);
    return entity instanceof TextNode ? entity : null;
  }
  getConnectableEntityByUUID(uuid: string): ConnectableEntity | null {
    const entity = this.get(uuid);
    if (entity instanceof ConnectableEntity) {
      if (entity instanceof ImageNode && entity.isBackground) {
        return null;
      }
      return entity;
    }
    return null;
  }
  isSectionByUUID(uuid: string): boolean {
    return this.get(uuid) instanceof Section;
  }
  getSectionByUUID(uuid: string): Section | null {
    const entity = this.get(uuid);
    if (entity instanceof Section) {
      return entity;
    }
    return null;
  }

  /**
   * 计算所有节点的中心点（O(1) 复用实体 R-Tree 根包围盒，避免视野重置时遍历全图数千条边）
   */
  getCenter(): Vector {
    if (this.project.stage.length === 0) {
      return Vector.getZero();
    }
    return this.getBoundingRectangle().center;
  }

  /**
   * 计算所有节点的大小
   */
  getSize(): Vector {
    if (this.project.stage.length === 0) {
      return new Vector(this.project.renderer.w, this.project.renderer.h);
    }
    return this.getBoundingRectangle().size;
  }

  /**
   * 获取舞台的矩形对象（优先 O(1) 读取实体 R-Tree 根包围盒）
   */
  getBoundingRectangle(): Rectangle {
    this.syncIndexesIfNeeded();
    if (this.entitiesCache.length > 0) {
      const root = (
        this.entityRTree as unknown as {
          data?: { minX: number; minY: number; maxX: number; maxY: number };
        }
      ).data;
      if (root && Number.isFinite(root.minX) && Number.isFinite(root.maxX)) {
        return new Rectangle(
          new Vector(root.minX, root.minY),
          new Vector(root.maxX - root.minX, root.maxY - root.minY),
        );
      }
    }
    const physicalObjects = this.project.stage.filter((node) => node.isPhysical);
    if (physicalObjects.length === 0) {
      return new Rectangle(Vector.getZero(), Vector.getZero());
    }
    return Rectangle.getBoundingRectangle(physicalObjects.map((node) => node.collisionBox.getRectangle()));
  }

  /**
   * 根据位置查找节点，常用于点击事件
   * @param location
   * @returns
   */
  findTextNodeByLocation(location: Vector): TextNode | null {
    for (const node of this.queryEntitiesAtPoint(location)) {
      if (!(node instanceof TextNode)) continue;
      if (this.isHiddenByBranchCollapse(node)) continue;
      if (node.collisionBox.isContainsPoint(location)) {
        return node;
      }
    }
    return null;
  }

  /**
   * 用于鼠标悬停时查找边
   * @param location
   * @returns
   */
  findLineEdgeByLocation(location: Vector): LineEdge | null {
    for (const edge of this.queryAssociationsAtPoint(location)) {
      if (!(edge instanceof LineEdge)) continue;
      if (this.isHiddenByBranchCollapse(edge)) continue;
      if (edge.collisionBox.isContainsPoint(location)) {
        return edge;
      }
    }
    return null;
  }

  findAssociationByLocation(location: Vector): Association | null {
    for (const association of this.queryAssociationsAtPoint(location)) {
      if (this.isHiddenByBranchCollapse(association)) continue;
      if (association.collisionBox.isContainsPoint(location)) {
        return association;
      }
    }
    return null;
  }

  findSectionByLocation(location: Vector): Section | null {
    for (const section of this.queryEntitiesAtPoint(location)) {
      if (!(section instanceof Section)) continue;
      if (section.collisionBox.isContainsPoint(location)) {
        return section;
      }
    }
    return null;
  }

  findImageNodeByLocation(location: Vector): ImageNode | null {
    for (const node of this.queryEntitiesAtPoint(location)) {
      if (!(node instanceof ImageNode)) continue;
      if (!node.isBackground && !this.isHiddenByBranchCollapse(node) && node.collisionBox.isContainsPoint(location)) {
        return node;
      }
    }
    return null;
  }

  findConnectableEntityByLocation(location: Vector): ConnectableEntity | null {
    return this.findEntityInHierarchyByLocation(
      this.topLevelEntities,
      location,
      (entity): entity is ConnectableEntity => entity instanceof ConnectableEntity,
      false,
      false,
    );
  }

  findBranchDragNodeByLocation(location: Vector): ConnectableEntity | null {
    // Section backgrounds can overlap visible nodes; the renderer draws the nodes above those backgrounds.
    const hits = this.queryEntitiesAtPoint(location).filter(
      (node): node is ConnectableEntity =>
        node instanceof ConnectableEntity &&
        !(node instanceof ImageNode && node.isBackground) &&
        !node.isHiddenBySectionCollapse &&
        !this.isHiddenByBranchCollapse(node) &&
        !this.project.sectionMethods.isEntityHiddenByBigTitleSection(node) &&
        node.collisionBox.isContainsPoint(location),
    );
    return (
      hits.findLast((node) => !(node instanceof Section)) ??
      hits.reduce<Section | null>((hit, node) => {
        if (node instanceof Section && (!hit || node.sectionDepth >= hit.sectionDepth)) return node;
        return hit;
      }, null)
    );
  }

  /**
   * 优先级：
   * 涂鸦 > 其他
   * @param location
   * @returns
   */
  findEntityByLocation(location: Vector): Entity | null {
    return this.findEntityInHierarchyByLocation(
      this.topLevelEntities,
      location,
      (entity): entity is Entity => entity instanceof Entity,
      true,
      false,
    );
  }

  private findEntityInHierarchyByLocation<T extends Entity>(
    entities: Entity[],
    location: Vector,
    accept: (entity: Entity) => entity is T,
    prioritizePenStroke: boolean,
    sectionOnlyMode: boolean,
  ): T | null {
    if (prioritizePenStroke && !sectionOnlyMode) {
      for (let i = entities.length - 1; i >= 0; i--) {
        const entity = entities[i];
        if (!(entity instanceof PenStroke)) {
          continue;
        }
        if (entity.isHiddenBySectionCollapse) {
          continue;
        }
        if (entity.collisionBox.isContainsPoint(location)) {
          return accept(entity) ? entity : null;
        }
      }
    }

    for (let i = entities.length - 1; i >= 0; i--) {
      const entity = entities[i];
      if (entity.isHiddenBySectionCollapse || this.isHiddenByBranchCollapse(entity)) {
        continue;
      }
      if (entity instanceof ImageNode && entity.isBackground) {
        continue;
      }
      if (sectionOnlyMode && !(entity instanceof Section)) {
        continue;
      }
      if (prioritizePenStroke && entity instanceof PenStroke) {
        continue;
      }

      if (entity instanceof Section) {
        if (entity.rectangle.isPointIn(location)) {
          const isBigTitleActive = this.project.sectionMethods.isSectionBigTitleActive(entity);
          if (isBigTitleActive && accept(entity)) {
            return entity;
          }
          const nextSectionOnlyMode = sectionOnlyMode || isBigTitleActive;
          if (!nextSectionOnlyMode) {
            const childHit = this.findEntityInHierarchyByLocation(
              entity.children,
              location,
              accept,
              prioritizePenStroke,
              false,
            );
            if (childHit) {
              return childHit;
            }
          }
        }
        if (accept(entity) && entity.collisionBox.isContainsPoint(location)) {
          return entity;
        }
        continue;
      }

      if (accept(entity) && entity.collisionBox.isContainsPoint(location)) {
        return entity;
      }
    }
    return null;
  }

  findConnectPointByLocation(location: Vector): ConnectPoint | null {
    for (const point of this.queryEntitiesAtPoint(location)) {
      if (!(point instanceof ConnectPoint)) continue;
      if (point.isHiddenBySectionCollapse || this.isHiddenByBranchCollapse(point)) {
        continue;
      }
      if (point.collisionBox.isContainsPoint(location)) {
        return point;
      }
    }
    return null;
  }
  isHaveEntitySelected(): boolean {
    for (const entity of this.getEntities()) {
      if (entity.isSelected) {
        return true;
      }
    }
    return false;
  }

  /**
   * O(n)
   * @returns
   */
  getSelectedEntities(): Entity[] {
    return this.project.stage.filter(
      (so) => so.isSelected && so instanceof Entity && !(so instanceof ImageNode && (so as ImageNode).isBackground),
    ) as Entity[];
  }
  getSelectedAssociations(): Association[] {
    return this.project.stage.filter((so) => so.isSelected && so instanceof Association) as Association[];
  }
  getSelectedStageObjects(): StageObject[] {
    const result: StageObject[] = [];
    result.push(...this.getSelectedEntities());
    result.push(...this.getSelectedAssociations());
    return result;
  }

  /**
   * 获取选中内容的边界矩形
   * @returns
   */
  getBoundingBoxOfSelected(): Rectangle {
    const selectedObjects = this.getSelectedStageObjects();
    if (selectedObjects.length === 0) {
      // 如果没有选中任何对象，返回一个默认的矩形
      return new Rectangle(Vector.getZero(), new Vector(100, 100));
    }

    const rectangles = selectedObjects.map((obj) => obj.collisionBox.getRectangle());
    return Rectangle.getBoundingRectangle(rectangles);
  }

  /**
   * 判断某一点是否有实体存在（排除实体的被Section折叠）
   * @param location
   * @returns
   */
  isEntityOnLocation(location: Vector): boolean {
    for (const entity of this.queryEntitiesAtPoint(location)) {
      if (entity.isHiddenBySectionCollapse || this.isHiddenByBranchCollapse(entity)) {
        continue;
      }
      if (entity instanceof ImageNode && entity.isBackground) {
        continue;
      }
      if (entity.collisionBox.isContainsPoint(location)) {
        return true;
      }
    }
    return false;
  }
  isAssociationOnLocation(location: Vector): boolean {
    for (const association of this.queryAssociationsAtPoint(location)) {
      if (this.isHiddenByBranchCollapse(association)) continue;
      if (association instanceof Edge) {
        if (association.target.isHiddenBySectionCollapse && association.source.isHiddenBySectionCollapse) {
          continue;
        }
      }
      if (association.collisionBox.isContainsPoint(location)) {
        return true;
      }
    }
    return false;
  }

  // region 以下为舞台操作相关的函数
  // 建议不同的功能分类到具体的文件中，然后最后集中到这里调用，使得下面的显示简短一些
  // 每个操作函数尾部都要加一个记录历史的操作

  deleteEntities(deleteNodes: Entity[]) {
    if (deleteNodes.length === 0) {
      // 此处return 性能优化60ms
      return;
    }
    const deletingSet = new Set<Entity>(deleteNodes);
    const affectedContainers = new Set<Entity>();
    const previousCenters = new Map<string, Vector>();
    if (isPersistentMindMapDragEnabled()) {
      for (const node of deleteNodes) {
        if (node.parentSection && !deletingSet.has(node.parentSection)) {
          affectedContainers.add(node.parentSection);
          previousCenters.set(node.parentSection.uuid, node.parentSection.collisionBox.getRectangle().center);
        }
        if (node instanceof ConnectableEntity) {
          for (const parent of this.project.graphMethods.nodeParentArray(node)) {
            if (!deletingSet.has(parent)) {
              affectedContainers.add(parent);
              previousCenters.set(parent.uuid, parent.collisionBox.getRectangle().center);
            }
          }
        }
      }
    }
    this.project.deleteManager.deleteEntities(deleteNodes);
    if (affectedContainers.size > 0 && isPersistentMindMapDragEnabled()) {
      this.updateReferences();
      reflowMindMapTreesForEntities(this.project, affectedContainers, previousCenters);
    }
    this.project.historyManager.recordStep();
  }

  /**
   * 外部的交互层的delete键可以直接调用这个函数
   */
  deleteSelectedStageObjects() {
    const selectedEntities = this.getEntities().filter((node) => node.isSelected);

    // 检查选中的实体是否在锁定的 section 内，或者实体本身是否是锁定的 section，或者是背景图片
    const filteredEntities = selectedEntities.filter((entity) => {
      return (
        !this.project.sectionMethods.isObjectBeLockedBySection(entity) &&
        !(entity instanceof ImageNode && entity.isBackground)
      );
    });

    for (const entity of filteredEntities) {
      if (entity instanceof PenStroke) {
        this.project.effects.addEffect(PenStrokeDeletedEffect.fromPenStroke(entity));
      } else {
        this.project.effects.addEffect(EntityShrinkEffect.fromEntity(entity));
      }
    }

    const parentSet = new Set<ConnectableEntity>();
    for (const entity of filteredEntities) {
      if (entity instanceof ConnectableEntity) {
        for (const parent of this.project.graphMethods.nodeParentArray(entity)) {
          parentSet.add(parent);
        }
      }
    }

    this.deleteEntities(filteredEntities);
    // feature：delete键删除的时候，如果有父节点，让选中状态移动到父节点上
    if (parentSet.size > 0) {
      const firstParent = parentSet.values().next().value;
      if (firstParent) {
        firstParent.isSelected = true;
      }
    }

    // 处理所有类型的边，包括普通边和多目标无向边
    for (const association of this.getAssociations()) {
      if (association.isSelected) {
        // 检查连线是否连接了锁定的 section 内的物体
        if (this.project.sectionMethods.isObjectBeLockedBySection(association)) {
          continue; // 连接了锁定 section 内物体的连线不参与删除
        }

        this.deleteAssociation(association);
        if (association instanceof Edge) {
          this.project.effects.addEffects(this.project.edgeRenderer.getCuttingEffects(association));
        }
      }
    }
  }
  deleteAssociation(deleteAssociation: Association): boolean {
    if (deleteAssociation instanceof Edge) {
      return this.deleteEdge(deleteAssociation);
    } else if (deleteAssociation instanceof MultiTargetUndirectedEdge) {
      const res = this.project.deleteManager.deleteMultiTargetUndirectedEdge(deleteAssociation);
      this.project.historyManager.recordStep();
      return res;
    }
    toast.error("无法删除未知类型的关系");
    return false;
  }

  deleteEdge(deleteEdge: Edge): boolean {
    const res = this.project.deleteManager.deleteEdge(deleteEdge);
    this.project.historyManager.recordStep();
    return res;
  }

  // 一个简单的文案
  private static w = `自环已被禁止，可在设置>控制>连线 中打开允许添加自环选项，
    但您可能并不是想添加自环，您可能是想打开右键菜单，所以请在空白位置右键。
    如果您不需要添加自环的操作但想保持能够通过在节点上右键打开菜单的操作，
    可在设置>控制>连线 中关闭“启用右键点击连线功能”。
    但如果您既要右键点击节点创建连线功能，又想要在节点上右键展开右键菜单操作，很抱歉，这两个功能在逻辑上冲突了。
    `;

  connectEntity(fromNode: ConnectableEntity, toNode: ConnectableEntity, isCrEdge: boolean = false) {
    if (fromNode === toNode && !Settings.allowAddCycleEdge) {
      toast.warning(
        <div>
          <span>{StageManager.w}</span>
        </div>,
      );
      return false;
    }
    if (isCrEdge) {
      this.project.nodeConnector.addCrEdge(fromNode, toNode);
    } else {
      this.project.nodeConnector.connectConnectableEntity(fromNode, toNode);
    }

    this.project.historyManager.recordStep();
    return this.project.graphMethods.isConnected(fromNode, toNode);
  }

  /**
   * 多重连接，只记录一次历史
   * @param fromNodes
   * @param toNode
   * @param isCrEdge
   * @returns
   */
  connectMultipleEntities(
    fromNodes: ConnectableEntity[],
    toNode: ConnectableEntity,
    isCrEdge: boolean = false,
    sourceRectRate?: [number, number],
    targetRectRate?: [number, number],
    isArcEdge: boolean = false,
  ) {
    if (fromNodes.length === 0) {
      return false;
    }
    for (const fromNode of fromNodes) {
      if (fromNode === toNode && !Settings.allowAddCycleEdge) {
        toast.warning(
          <div>
            <h2 className="text-xl">请在空白处右键</h2>
            <span>{StageManager.w}</span>
          </div>,
        );
        continue;
      }
      if (isArcEdge) {
        this.project.nodeConnector.addArcEdge(fromNode, toNode);
      } else if (isCrEdge) {
        this.project.nodeConnector.addCrEdge(fromNode, toNode);
      } else {
        this.project.nodeConnector.connectConnectableEntity(fromNode, toNode, "", targetRectRate, sourceRectRate);
      }
    }
    this.project.historyManager.recordStep();
    return true;
  }

  reverseSelectedEdges() {
    const selectedEdges = this.getLineEdges().filter((edge) => edge.isSelected);
    if (selectedEdges.length === 0) {
      return;
    }
    this.project.nodeConnector.reverseEdges(selectedEdges);
  }

  // addSerializedData(serializedData: Serialized.File, diffLocation = new Vector(0, 0)) {
  //   this.project.serializedDataAdder.addSerializedData(serializedData, diffLocation);
  //   this.project.historyManager.recordStep();
  // }

  generateNodeTreeByText(text: string, indention: number = 4, location = this.project.camera.location) {
    this.project.nodeAdder.addNodeTreeByText(text, indention, location);
    this.project.historyManager.recordStep();
  }

  generateNodeGraphByText(text: string, location = this.project.camera.location) {
    try {
      this.project.nodeAdder.addNodeGraphByText(text, location);
      this.project.historyManager.recordStep();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  generateNodeMermaidByText(text: string, location = this.project.camera.location) {
    try {
      this.project.nodeAdder.addNodeMermaidByText(text, location);
      this.project.historyManager.recordStep();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  generateNodeByMarkdown(text: string, location = this.project.camera.location, autoLayout = true) {
    this.project.nodeAdder.addNodeByMarkdown(text, location, autoLayout);
    this.project.historyManager.recordStep();
  }

  /** 将多个实体打包成一个section，并添加到舞台中 */
  async packEntityToSection(addEntities: Entity[]) {
    await this.project.sectionPackManager.packEntityToSection(addEntities);
    this.project.historyManager.recordStep();
  }

  /** 将选中的实体打包成一个section，并添加到舞台中 */
  async packEntityToSectionBySelected() {
    const selectedNodes = this.getSelectedEntities();
    if (selectedNodes.length === 0) {
      return;
    }
    this.packEntityToSection(selectedNodes);
  }

  goInSection(entities: Entity[], section: Section) {
    const affected = new Set<Entity>([section]);
    const previousCenters = new Map<string, Vector>([[section.uuid, section.collisionBox.getRectangle().center]]);
    for (const entity of entities) {
      if (entity.parentSection) {
        affected.add(entity.parentSection);
        previousCenters.set(entity.parentSection.uuid, entity.parentSection.collisionBox.getRectangle().center);
      }
    }
    this.project.sectionInOutManager.goInSection(entities, section);
    if (isPersistentMindMapDragEnabled()) {
      reflowMindMapTreesForEntities(this.project, affected, previousCenters);
    }
    this.project.historyManager.recordStep();
  }

  goOutSection(entities: Entity[], section: Section) {
    const previousCenters = new Map<string, Vector>([[section.uuid, section.collisionBox.getRectangle().center]]);
    this.project.sectionInOutManager.goOutSection(entities, section);
    if (isPersistentMindMapDragEnabled()) {
      reflowMindMapTreesForEntities(this.project, [section], previousCenters);
    }
    this.project.historyManager.recordStep();
  }
  /** 将所有选中的Section折叠起来 */
  packSelectedSection() {
    this.project.sectionPackManager.packSection();
    this.project.historyManager.recordStep();
  }

  /** 将所有选中的Section展开 */
  unpackSelectedSection() {
    this.project.sectionPackManager.unpackSection();
    this.project.historyManager.recordStep();
  }

  /**
   * 切换选中的Section的折叠状态
   */
  sectionSwitchCollapse() {
    this.project.sectionPackManager.switchCollapse();
    this.project.historyManager.recordStep();
  }

  connectEntityByCrEdge(fromNode: ConnectableEntity, toNode: ConnectableEntity) {
    return this.project.nodeConnector.addCrEdge(fromNode, toNode);
  }

  /**
   * 刷新所有舞台内容
   */
  refreshAllStageObjects() {
    const entities = this.getEntities();
    for (const entity of entities) {
      if (entity instanceof TextNode) {
        if (entity.sizeAdjust === "auto") {
          entity.forceAdjustSizeByText();
        }
      } else if (entity instanceof Section) {
        entity.adjustLocationAndSize();
      }
    }
  }

  /**
   * 刷新选中内容
   */
  refreshSelected() {
    const entities = this.getSelectedEntities();
    for (const entity of entities) {
      if (entity instanceof ImageNode) {
        // entity.refresh();
      }
    }
  }

  /**
   * 改变连线的目标接头点位置
   * @param direction
   */
  changeSelectedEdgeConnectLocation(direction: Direction | null, isSource: boolean = false) {
    const edges = this.getSelectedAssociations().filter((edge) => edge instanceof Edge);
    this.changeEdgesConnectLocation(edges, direction, isSource);
  }

  /**
   * 更改多个连线的目标接头点位置
   * @param edges
   * @param direction
   * @param isSource
   */
  changeEdgesConnectLocation(edges: Edge[], direction: Direction | null, isSource: boolean = false) {
    const newLocationRate = new Vector(0.5, 0.5);
    if (direction === Direction.Left) {
      newLocationRate.x = 0.01;
    } else if (direction === Direction.Right) {
      newLocationRate.x = 0.99;
    } else if (direction === Direction.Up) {
      newLocationRate.y = 0.01;
    } else if (direction === Direction.Down) {
      newLocationRate.y = 0.99;
    }

    for (const edge of edges) {
      if (isSource) {
        edge.sourceRectangleRate = newLocationRate;
      } else {
        edge.targetRectangleRate = newLocationRate;
      }
      this.project.docCommandBus?.markEdgeStyleDirty(edge);
    }
    // 播放连线调整音效
    SoundService.play.associationAdjustSoundFile();
  }

  switchLineEdgeToCrEdge() {
    const prepareDeleteLineEdge: LineEdge[] = [];
    for (const edge of this.getLineEdges()) {
      if (edge instanceof LineEdge && edge.isSelected) {
        // 删除这个连线，并准备创建cr曲线
        prepareDeleteLineEdge.push(edge);
      }
    }
    for (const lineEdge of prepareDeleteLineEdge) {
      this.deleteEdge(lineEdge);
      this.connectEntityByCrEdge(lineEdge.source, lineEdge.target);
    }
  }

  /**
   * 有向边转无向边
   */
  switchEdgeToUndirectedEdge() {
    const prepareDeleteLineEdge: LineEdge[] = [];
    for (const edge of this.getLineEdges()) {
      if (edge instanceof LineEdge && edge.isSelected) {
        // 删除这个连线，并准备创建
        prepareDeleteLineEdge.push(edge);
      }
    }
    for (const edge of prepareDeleteLineEdge) {
      if (edge.target === edge.source) {
        continue;
      }
      this.deleteEdge(edge);
      const undirectedEdge = MultiTargetUndirectedEdge.createFromSomeEntity(this.project, [edge.target, edge.source]);
      undirectedEdge.text = edge.text;
      undirectedEdge.color = edge.color.clone();
      undirectedEdge.arrow = "outer";
      // undirectedEdge.isSelected = true;
      this.add(undirectedEdge);
    }
  }
  /**
   * 有向边转弧形边
   */
  switchEdgeToArcEdge() {
    const prepareConvert: LineEdge[] = [];
    for (const edge of this.getLineEdges()) {
      if (edge.isSelected) {
        prepareConvert.push(edge);
      }
    }
    for (const edge of prepareConvert) {
      if (edge.target === edge.source) {
        continue;
      }
      this.deleteEdge(edge);
      const arcEdge = new ArcEdge(this.project, {
        associationList: [edge.source, edge.target],
        text: edge.text,
        color: edge.color.clone(),
        sourceRectangleRate: edge.sourceRectangleRate.clone(),
        targetRectangleRate: edge.targetRectangleRate.clone(),
        lineType: edge.lineType,
        arrowType: edge.arrowType,
        offset: 10,
      });
      this.add(arcEdge);
    }
  }
  /**
   * 无向边转有向边
   */
  switchUndirectedEdgeToEdge() {
    const prepareDeleteUndirectedEdge: MultiTargetUndirectedEdge[] = [];
    for (const edge of this.getAssociations()) {
      if (edge instanceof MultiTargetUndirectedEdge && edge.isSelected) {
        // 删除这个连线，并准备创建
        prepareDeleteUndirectedEdge.push(edge);
      }
    }
    for (const edge of prepareDeleteUndirectedEdge) {
      if (edge.associationList.length !== 2) {
        continue;
      }

      const [fromNode, toNode] = edge.associationList;
      if (fromNode && toNode && fromNode instanceof ConnectableEntity && toNode instanceof ConnectableEntity) {
        const lineEdge = LineEdge.fromTwoEntity(this.project, fromNode, toNode);
        lineEdge.text = edge.text;
        lineEdge.color = edge.color.clone();
        this.deleteAssociation(edge);
        this.add(lineEdge);
        this.updateReferences();
      }
    }
  }

  addSelectedCREdgeControlPoint() {
    const selectedCREdge = this.getSelectedAssociations().filter((edge) => edge instanceof CubicCatmullRomSplineEdge);
    for (const edge of selectedCREdge) {
      edge.addControlPoint();
      this.project.docCommandBus?.markEdgeStyleDirty(edge);
    }
  }

  addSelectedCREdgeTension() {
    const selectedCREdge = this.getSelectedAssociations().filter((edge) => edge instanceof CubicCatmullRomSplineEdge);
    for (const edge of selectedCREdge) {
      edge.tension += 0.25;
      edge.tension = Math.min(1, edge.tension);
      this.project.docCommandBus?.markEdgeStyleDirty(edge);
    }
  }

  reduceSelectedCREdgeTension() {
    const selectedCREdge = this.getSelectedAssociations().filter((edge) => edge instanceof CubicCatmullRomSplineEdge);
    for (const edge of selectedCREdge) {
      edge.tension -= 0.25;
      edge.tension = Math.max(0, edge.tension);
      this.project.docCommandBus?.markEdgeStyleDirty(edge);
    }
  }

  /**
   * 设置选中Edge的线条类型
   */
  setSelectedEdgeLineType(lineType: string) {
    const selectedEdges = this.getSelectedAssociations().filter(
      (edge) => edge instanceof LineEdge || edge instanceof ArcEdge || edge instanceof MultiTargetUndirectedEdge,
    );
    for (const edge of selectedEdges) {
      (edge as LineEdge | ArcEdge | MultiTargetUndirectedEdge).lineType = lineType;
      if (edge instanceof Edge) {
        this.project.docCommandBus?.markEdgeStyleDirty(edge);
      } else {
        this.project.docCommandBus?.markAssociationDirty(edge);
      }
    }
    this.branchCollapseState = undefined;
  }

  /**
   * 设置选中Edge的箭头类型
   */
  setSelectedEdgeArrowType(arrowType: string) {
    const selectedEdges = this.getSelectedAssociations().filter(
      (edge) => edge instanceof LineEdge || edge instanceof ArcEdge || edge instanceof MultiTargetUndirectedEdge,
    );
    for (const edge of selectedEdges) {
      (edge as LineEdge | ArcEdge | MultiTargetUndirectedEdge).arrowType = arrowType;
      if (edge instanceof Edge) {
        this.project.docCommandBus?.markEdgeStyleDirty(edge);
      } else {
        this.project.docCommandBus?.markAssociationDirty(edge);
      }
    }
  }

  /**
   * ctrl + A 全选
   */
  selectAll() {
    const allEntity = this.project.stage;
    for (const entity of allEntity) {
      if (!this.isHiddenByBranchCollapse(entity)) entity.isSelected = true;
    }
  }
  clearSelectAll() {
    for (const entity of this.project.stage) {
      entity.isSelected = false;
    }
  }
}
