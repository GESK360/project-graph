import { Project } from "@/core/Project";
import { Renderer } from "@/core/render/canvas2d/renderer";
import { Settings } from "@/core/service/Settings";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { ResizeAble } from "@/core/stage/stageObject/abstract/StageObjectInterface";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { MultiTargetUndirectedEdge } from "@/core/stage/stageObject/association/MutiTargetUndirectedEdge";
import { getTextSize } from "@/utils/font";
import { Color, Vector } from "@graphif/data-structures";
import { id, passExtraAtArg1, passObject, serializable } from "@graphif/serializer";
import { Line, Rectangle, Shape } from "@graphif/shapes";
import { Value } from "platejs";
import type { TableFields } from "@/types/table";

@passExtraAtArg1
@passObject
export class Section extends ConnectableEntity implements ResizeAble {
  static readonly AUTO_PADDING = 30;
  static readonly MANUAL_MIN_PADDING = 10;
  static readonly MIN_WIDTH = 100;
  static readonly MIN_HEIGHT = 100;
  /**
   * 节点是否被选中
   */
  _isSelected: boolean = false;
  @id
  @serializable
  public uuid: string;
  _isEditingTitle: boolean = false;
  private _collisionBoxWhenCollapsed: CollisionBox | null = null;
  @serializable
  private _collisionBoxNormal: CollisionBox;

  public get isEditingTitle() {
    return this._isEditingTitle;
  }
  public set isEditingTitle(value: boolean) {
    this._isEditingTitle = value;
    this.project.sectionRenderer.render(this);
  }

  /**
   * 小于多少的情况下，开始渲染大标题
   */
  static bigTitleCameraScale = 0.2;

  private getCollapsedCollisionBox(): CollisionBox {
    return (this._collisionBoxWhenCollapsed ??= this.collapsedCollisionBox());
  }

  public get collisionBox(): CollisionBox {
    if (this.isCollapsed) {
      return this.getCollapsedCollisionBox();
    } else if (this.locked) {
      // 锁定状态下使用整个矩形作为碰撞箱
      return new CollisionBox([this.rectangle]);
    } else {
      return this._collisionBoxNormal;
    }
  }

  /** 获取折叠状态下的碰撞箱 */
  private collapsedCollisionBox(): CollisionBox {
    const centerLocation = this._collisionBoxNormal.getRectangle().center;
    const collapsedRectangleSize = getTextSize(this.text, Renderer.FONT_SIZE).add(
      Vector.same(Renderer.NODE_PADDING).multiply(2),
    );
    const collapsedRectangle = new Rectangle(
      centerLocation.clone().subtract(collapsedRectangleSize.multiply(0.5)),
      collapsedRectangleSize,
    );
    return new CollisionBox([collapsedRectangle]);
  }

  @serializable
  color: Color = Color.Transparent;
  @serializable
  text: string;
  @serializable
  children: Entity[];

  /** 是否是折叠状态 */
  @serializable
  isCollapsed: boolean;
  /**
   * 是否锁定 Section 内部物体
   * 当 locked 为 true 时，Section 内部的所有物体都不能移动或删除
   */
  @serializable
  locked: boolean = false;
  /**
   * 边框样式：实线、虚线、无边框
   */
  @serializable
  borderStyle: "solid" | "dashed" | "none" = "solid";
  /**
   * 尺寸调整模式：auto 自动贴合内部内容；manual 保留用户拖拽调整后的自定义边框范围
   */
  @serializable
  sizeAdjust: "auto" | "manual" = "auto";
  isHiddenBySectionCollapse = false;

  constructor(
    protected readonly project: Project,
    {
      uuid = crypto.randomUUID() as string,
      text = "",
      collisionBox = new CollisionBox([new Rectangle(new Vector(0, 0), new Vector(0, 0))]),
      _collisionBoxNormal: collisionBoxNormal = undefined as CollisionBox | undefined,
      color = Color.Transparent,
      locked = false,
      isCollapsed = false,
      children = [] as Entity[],
      details = [] as Value,
      borderStyle = "solid" as "solid" | "dashed" | "none",
      sizeAdjust = "auto" as "auto" | "manual",
      createdAt = undefined as number | undefined,
      updatedAt = undefined as number | undefined,
      tableFields = undefined as TableFields | undefined,
      tableFieldsOwned = false,
      skipInitialAdjust = false,
    } = {},
    public unknown = false,
  ) {
    super();
    this.uuid = uuid;
    this.restoreEntityTableMetadata({ createdAt, updatedAt, tableFields, tableFieldsOwned });

    if (collisionBoxNormal) {
      // 从序列化数据恢复：直接使用保存的 _collisionBoxNormal（含正确位置）
      this._collisionBoxNormal = collisionBoxNormal;
      // v3 持久化矩形快路径：补齐标题栏可拖动命中矩形，避免开页期重算 adjustLocationAndSize
      if (skipInitialAdjust && text !== "" && this._collisionBoxNormal.shapes.length === 4) {
        const rect = this.getNormalRectangle();
        if (rect.size.x > 0 && rect.size.y > 0) {
          this._collisionBoxNormal.shapes.push(new Rectangle(rect.location.clone(), new Vector(rect.size.x, 50)));
        }
      }
    } else {
      // 新建：从 collisionBox 参数构建 _collisionBoxNormal
      const rect = collisionBox.getRectangle();
      const shapes: Shape[] = rect.getBoundingLines();
      this._collisionBoxNormal = new CollisionBox(shapes);
    }
    this._collisionBoxWhenCollapsed = null;

    this.color = color;
    this.text = text;
    this.locked = locked;
    this.isCollapsed = isCollapsed;
    this.details = details;
    this.children = children;
    this.borderStyle = borderStyle;
    this.sizeAdjust = sizeAdjust;
    // 一定要放在最后；v3 水合第一遍（children 尚未挂载）可跳过重复计算，由第二遍或持久化几何接管
    if (!skipInitialAdjust) {
      this.adjustLocationAndSize();
    }
  }

  /**
   * 根据多个实体创建Section
   * @param entities
   */
  static fromEntities(project: Project, entities: Entity[]): Section {
    const section = new Section(project, {
      text: "section",
      children: entities,
      borderStyle: Settings.sectionInitBorderStyle,
    });

    return section;
  }

  rename(newName: string) {
    if (this.text !== newName) {
      this.project?.docCommandBus?.markSemanticDirty(this);
    }
    this.text = newName;
    this.adjustLocationAndSize();
  }

  private getNormalRectangle(): Rectangle {
    if (this._collisionBoxNormal.shapes.length >= 4) {
      const topLine = this._collisionBoxNormal.shapes[0];
      const rightLine = this._collisionBoxNormal.shapes[1];
      const bottomLine = this._collisionBoxNormal.shapes[2];
      const leftLine = this._collisionBoxNormal.shapes[3];
      if (
        topLine instanceof Line &&
        rightLine instanceof Line &&
        bottomLine instanceof Line &&
        leftLine instanceof Line
      ) {
        return new Rectangle(
          new Vector(leftLine.start.x, topLine.start.y),
          new Vector(rightLine.end.x - leftLine.start.x, bottomLine.end.y - topLine.start.y),
        );
      }
    }
    return this._collisionBoxNormal.getRectangle();
  }

  private getContentBounds(padding: number): Rectangle | null {
    if (this.children.length === 0) {
      return null;
    }
    const bounds = this.children.map((child) => child.collisionBox.getRectangle());
    // 只包含端点全部在框内的包围线；跨分组连线不能反过来撑大两边的框。
    // 优先使用 StageManager 的非直线多目标边缓存（绝大多数图为空数组，将 O(S*E) 降至 O(0)）。
    const multiTargetEdges =
      typeof this.project.stageManager?.getMultiTargetNonLineEdges === "function"
        ? this.project.stageManager.getMultiTargetNonLineEdges()
        : this.project.stageManager.getAssociations();
    if (multiTargetEdges.length > 0) {
      const descendants = new Set<Entity>();
      const collect = (entity: Entity) => {
        if (descendants.has(entity)) return;
        descendants.add(entity);
        if (entity instanceof Section && !entity.isCollapsed) entity.children.forEach(collect);
      };
      this.children.forEach(collect);
      for (const edge of multiTargetEdges) {
        if (
          edge instanceof MultiTargetUndirectedEdge &&
          edge.renderType !== "line" &&
          edge.associationList.length >= 2 &&
          edge.associationList.every((node) => descendants.has(node))
        ) {
          bounds.push(edge.collisionBox.getRectangle());
        }
      }
    }
    return Rectangle.getBoundingRectangle(bounds, padding);
  }

  private applyNormalRectangle(rectangle: Rectangle, titleBarHeight: number) {
    this._collisionBoxNormal.shapes = rectangle.getBoundingLines();
    // 群友需求：希望分组框扩大交互范围，标题也能拖动
    if (titleBarHeight > 0) {
      const newRect = new Rectangle(rectangle.location.clone(), new Vector(rectangle.size.x, titleBarHeight));
      this._collisionBoxNormal.shapes.push(newRect);
    }
    // 仅折叠态立即重建折叠碰撞箱，展开态置空按需懒建，省去每次 adjust 触发 Canvas measureText
    this._collisionBoxWhenCollapsed = this.isCollapsed ? this.collapsedCollisionBox() : null;
    this.project?.stageManager?.updateSpatialIndex?.(this);
    this.project?.docCommandBus?.markGeometryDirty(this);
  }

  /**
   * 根据子内容 自动调整分组框的位置和大小
   * 如果没有子内容，则
   *   自动调整大小为 标题+padding，位置为 当前碰撞箱外接矩形的左上角
   */
  adjustLocationAndSize() {
    let rectangle: Rectangle;
    const titleSize = getTextSize(this.text, Renderer.FONT_SIZE);
    const titleBarHeight = this.text === "" ? 0 : 50;
    const minWidth = Math.max(titleSize.x + Renderer.NODE_PADDING * 2, Section.MIN_WIDTH);

    if (this.sizeAdjust === "manual") {
      const currentRect = this.getNormalRectangle();
      let left = currentRect.left;
      let top = currentRect.top;
      let right = Math.max(currentRect.right, left + minWidth);
      let bottom = Math.max(currentRect.bottom, top + Section.MIN_HEIGHT);

      const contentRect = this.getContentBounds(Section.MANUAL_MIN_PADDING);
      if (contentRect) {
        left = Math.min(left, contentRect.left);
        top = Math.min(top, contentRect.top - titleBarHeight);
        right = Math.max(right, contentRect.right, left + minWidth);
        bottom = Math.max(bottom, contentRect.bottom, top + Section.MIN_HEIGHT);
      }

      rectangle = new Rectangle(new Vector(left, top), new Vector(right - left, bottom - top));
    } else if (this.children.length === 0) {
      rectangle = new Rectangle(this.getNormalRectangle().location, new Vector(minWidth, Section.MIN_HEIGHT));
    } else {
      rectangle = this.getContentBounds(Section.AUTO_PADDING)!;
      rectangle.size.x = Math.max(rectangle.size.x, titleSize.x + Renderer.NODE_PADDING * 2);
      // 留白范围在上面调整
      rectangle.location = rectangle.location.subtract(new Vector(0, titleBarHeight));
      rectangle.size = rectangle.size.add(new Vector(0, titleBarHeight));
    }

    this.applyNormalRectangle(rectangle, titleBarHeight);
  }

  resizeHandle(delta: Vector) {
    if (this.isCollapsed || this.locked || this.nearestLockedAncestorSection !== null) {
      return;
    }
    const titleSize = getTextSize(this.text, Renderer.FONT_SIZE);
    const titleBarHeight = this.text === "" ? 0 : 50;
    const minWidth = Math.max(titleSize.x + Renderer.NODE_PADDING * 2, Section.MIN_WIDTH);
    const minHeight = Section.MIN_HEIGHT;

    const currentRect = this.getNormalRectangle();
    const left = currentRect.left;
    const top = currentRect.top;
    let minRight = left + minWidth;
    let minBottom = top + minHeight;

    const contentRect = this.getContentBounds(Section.MANUAL_MIN_PADDING);
    if (contentRect) {
      minRight = Math.max(minRight, contentRect.right);
      minBottom = Math.max(minBottom, contentRect.bottom);
    }

    const newRight = Math.max(minRight, currentRect.right + delta.x);
    const newBottom = Math.max(minBottom, currentRect.bottom + delta.y);
    const grew = newRight > currentRect.right || newBottom > currentRect.bottom;

    this.sizeAdjust = "manual";
    this.applyNormalRectangle(
      new Rectangle(new Vector(left, top), new Vector(newRight - left, newBottom - top)),
      titleBarHeight,
    );
    this.updateFatherSectionByMove();
    if (grew) {
      this.project.sectionCollisionSolver?.solveOverlaps(this);
    }
  }

  resetAutoSize() {
    if (this.isCollapsed || this.locked || this.nearestLockedAncestorSection !== null) {
      return;
    }
    this.sizeAdjust = "auto";
    this.adjustLocationAndSize();
    this.updateFatherSectionByMove();
  }

  getResizeHandleRect(): Rectangle {
    const rect = this.rectangle;
    return new Rectangle(new Vector(rect.right - 25, rect.bottom - 25), new Vector(25, 25));
  }
  /**
   * 根据自身的折叠状态调整子节点的状态
   * 以屏蔽触碰和显示
   */
  adjustChildrenStateByCollapse(parentCollapsed = false) {
    const shouldHide = parentCollapsed || this.isCollapsed;
    if (shouldHide) {
      this.children.forEach((child) => {
        child.isHiddenBySectionCollapse = true;
        if (child instanceof Section) {
          child.adjustChildrenStateByCollapse(true);
        }
      });
    } else {
      this.children.forEach((child) => {
        if (child instanceof Section) {
          child.adjustChildrenStateByCollapse(false);
        }
      });
    }
  }

  /**
   * 获取节点的选中状态
   */
  public get isSelected() {
    return this._isSelected;
  }
  public set isSelected(value: boolean) {
    super.isSelected = value;
  }

  /**
   * 只读，获取节点的矩形
   * 若要修改节点的矩形，请使用 moveTo等 方法
   */
  public get rectangle(): Rectangle {
    if (this.isCollapsed) {
      return this.getCollapsedCollisionBox().getRectangle();
    } else {
      return this.getNormalRectangle();
    }
  }

  public get geometryCenter() {
    return this.rectangle.location.clone().add(this.rectangle.size.clone().multiply(0.5));
  }

  move(delta: Vector): void {
    const outermostMove = this.project.sectionMoveDepth === 0;
    this.project.sectionMoveDepth++;
    try {
      // 锁定时 collisionBox 是临时创建的矩形；两种状态下实际保存的边界都要跟着子节点移动。
      const boxes = this._collisionBoxWhenCollapsed
        ? [this._collisionBoxNormal, this._collisionBoxWhenCollapsed]
        : [this._collisionBoxNormal];
      for (const box of boxes) {
        for (const shape of box.shapes) {
          if (shape instanceof Line) {
            shape.start = shape.start.add(delta);
            shape.end = shape.end.add(delta);
          } else if (shape instanceof Rectangle) {
            shape.location = shape.location.add(delta);
          }
        }
      }
      // 让内部元素也移动
      for (const child of this.children) {
        // 跳过已被选中的子元素，避免重复移动（解决速度叠加bug）
        if (child.isSelected) {
          continue;
        }
        child.move(delta);
      }
    } finally {
      this.project.sectionMoveDepth--;
    }

    // 移动雪花特效
    if (!this.isHiddenBySectionCollapse) {
      this.project.effects.addMoveShadow(this.rectangle, delta);
    }
    if (outermostMove) {
      this.updateFatherSectionByMove();
      // 移动其他实体，递归碰撞
      this.updateOtherEntityLocationByMove();
    } else {
      this.project?.stageManager?.updateSpatialIndex?.(this);
      this.project?.docCommandBus?.markGeometryDirty(this);
    }
  }
  protected override collideWithOtherEntity(other: Entity): void {
    if (!Settings.isEnableEntityCollision) {
      return;
    }
    if (other instanceof Section) {
      if (this.project.sectionMethods.isEntityInSection(this, other)) {
        return;
      }
    }
    if (this.project.sectionMethods.isEntityInSection(other, this)) {
      return;
    }
    super.collideWithOtherEntity(other);
  }

  /**
   * 将某个物体 的最小外接矩形的左上角位置 移动到某个位置
   * @param location
   */
  moveTo(location: Vector): void {
    const currentLeftTop = this.rectangle.location;
    const delta = location.clone().subtract(currentLeftTop);
    this.move(delta);
    this.updateFatherSectionByMove();
  }
}
