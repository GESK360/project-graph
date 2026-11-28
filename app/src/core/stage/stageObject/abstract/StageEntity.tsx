import { Settings } from "@/core/service/Settings";
import { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import type { Section } from "@/core/stage/stageObject/entity/Section";
import { cloneTableFields, type TableFields } from "@/types/table";
import { Vector } from "@graphif/data-structures";
import { serializable } from "@graphif/serializer";
import { Circle, Rectangle } from "@graphif/shapes";
import type { Value } from "platejs";
import { DetailsManager } from "../tools/entityDetailsManager";
/**
 * 一切独立存在、能被移动的东西，且放在框里能被连带移动的东西
 * 实体
 */
export abstract class Entity extends StageObject {
  /**
   * 将某个物体移动某个距离
   * @param delta
   */
  abstract move(delta: Vector): void;

  /**
   * 是否忽略自动对齐功能
   * 例如涂鸦就不吸附对齐
   */
  public isAlignExcluded = false;
  /**
   * 将某个物体移动到某个位置
   * 注意：看的是最小外接矩形的左上角位置，不是中心位置
   * @param location
   */
  abstract moveTo(location: Vector): void;

  /**
   * [
   *  { type: 'p', children: [{ text: 'Serialize just this paragraph.' }] },
   *  { type: 'h1', children: [{ text: 'And this heading.' }] }
   * ]
   */
  @serializable
  public details: Value = [];

  @serializable
  public createdAt: number = Date.now();

  @serializable
  public updatedAt: number = this.createdAt;

  @serializable
  public tableFields: TableFields = {};

  protected restoreEntityTableMetadata(raw?: {
    createdAt?: number;
    updatedAt?: number;
    tableFields?: Record<string, unknown>;
    tableFieldsOwned?: boolean;
  }) {
    const validCreated =
      typeof raw?.createdAt === "number" && Number.isFinite(raw.createdAt) && raw.createdAt > 0
        ? Math.trunc(raw.createdAt)
        : 0;
    const created = validCreated > 0 ? validCreated : Date.now();
    const updated =
      typeof raw?.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0
        ? Math.trunc(raw.updatedAt)
        : created;
    this.createdAt = created;
    this.updatedAt = updated;
    if (!raw?.tableFields) {
      this.tableFields = {};
    } else if (raw.tableFieldsOwned) {
      this.tableFields = raw.tableFields as TableFields;
    } else {
      this.tableFields = cloneTableFields(raw.tableFields);
    }
  }

  /**
   * 运行时直接父级 Section。
   * 不参与序列化，打开文件后由 `StageManager.updateReferences()` 重建。
   */
  public parentSection: Section | null = null;

  /**
   * 运行时层级深度。
   * 顶层实体和根 Section 都为 0，嵌套越深数值越大。
   */
  public sectionDepth: number = 0;

  /**
   * 运行时最近的锁定祖先 Section。
   * 沿父链读取当前状态，避免锁定切换后缓存过期。
   */
  public get nearestLockedAncestorSection(): Section | null {
    let current = this.parentSection;
    while (current) {
      if (current.locked) return current;
      current = current.parentSection;
    }
    return null;
  }

  /** 用于交互使用，比如鼠标悬浮显示details */
  public isMouseHover: boolean = false;

  public detailsButtonRectangle(): Rectangle {
    const thisRectangle = this.collisionBox.getRectangle();
    return new Rectangle(thisRectangle.rightTop.subtract(new Vector(10, 10)), new Vector(25, 25));
  }
  public isMouseInDetailsButton(mouseWorldLocation: Vector): boolean {
    return this.detailsButtonRectangle().isPointIn(mouseWorldLocation);
  }

  public referenceButtonCircle(): Circle {
    const thisRectangle = this.collisionBox.getRectangle();
    return new Circle(thisRectangle.leftTop.subtract(new Vector(25, 25)), 25);
  }
  public isMouseInReferenceButton(mouseWorldLocation: Vector): boolean {
    return this.referenceButtonCircle().isPointIn(mouseWorldLocation);
  }

  /**
   * 由于自身位置的移动，递归的更新所有父级Section的位置和大小。
   * 每次父框 adjustLocationAndSize 后，调用碰撞求解器推开与其重叠的同级分支。
   */
  protected updateFatherSectionByMove() {
    this.project?.stageManager?.updateSpatialIndex?.(this);
    this.project?.docCommandBus?.markGeometryDirty(this);
    if (this.project.sectionMoveDepth > 0) return;
    let current = this.parentSection;
    while (current) {
      current.adjustLocationAndSize();
      // 父框增大后，检测并推移与其重叠的同级 Section 分支
      this.project.sectionCollisionSolver.solveOverlaps(current);
      current = current.parentSection;
    }
  }
  /**
   * 由于自身位置的更新，排开所有同级节点的位置
   * 此函数在move函数中被调用，更新
   */
  protected updateOtherEntityLocationByMove() {
    if (!Settings.isEnableEntityCollision || this.project.sectionMoveDepth > 0) {
      return;
    }
    const candidates =
      typeof this.project.stageManager?.queryEntitiesInRect === "function"
        ? this.project.stageManager.queryEntitiesInRect(this.collisionBox.getRectangle(), { preserveOrder: false })
        : this.project.stageManager.getEntities();
    for (const entity of candidates) {
      if (entity === this) {
        continue;
      }
      this.collideWithOtherEntity(entity);
    }
  }

  /**
   * 与其他实体碰撞，调整位置；能够递归传递
   * @param other 其他实体
   */
  protected collideWithOtherEntity(other: Entity) {
    if (!Settings.isEnableEntityCollision) {
      return;
    }
    const selfRectangle = this.collisionBox.getRectangle();
    const otherRectangle = other.collisionBox.getRectangle();
    if (!selfRectangle.isCollideWith(otherRectangle)) {
      return;
    }

    // 两者相交，需要调整位置
    // Equal centers still need a nonzero direction; intersection size alone also cannot separate contained rectangles.
    const dx =
      otherRectangle.center.x >= selfRectangle.center.x
        ? selfRectangle.right - otherRectangle.left
        : selfRectangle.left - otherRectangle.right;
    const dy =
      otherRectangle.center.y >= selfRectangle.center.y
        ? selfRectangle.bottom - otherRectangle.top
        : selfRectangle.top - otherRectangle.bottom;
    const moveDelta = Math.abs(dx) < Math.abs(dy) ? new Vector(dx, 0) : new Vector(0, dy);
    other.move(moveDelta);
  }
  /**
   * 是不是因为所在的Section被折叠而隐藏了
   * 因为任何Entity都可以放入Section
   */
  abstract isHiddenBySectionCollapse: boolean;

  // 懒加载桥接器：避免打开数千节点工程时在构造期预分配数千个 DetailsManager + WeakMap 对象
  private _detailsManager?: DetailsManager;
  public get detailsManager(): DetailsManager {
    return (this._detailsManager ??= new DetailsManager(this));
  }
}
