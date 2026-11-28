import { Vector } from "@graphif/data-structures";
import { serializable } from "@graphif/serializer";
import { Line, Rectangle, Shape } from "@graphif/shapes";

/**
 * 碰撞箱类
 */
export class CollisionBox {
  @serializable
  shapes: Shape[] = [];

  constructor(shapes: Shape[]) {
    this.shapes = shapes;
  }

  /**
   *
   * @param shapes 更新碰撞箱的形状列表
   */
  updateShapeList(shapes: Shape[]): void {
    this.shapes = shapes;
  }

  public isContainsPoint(location: Vector): boolean {
    for (const shape of this.shapes) {
      if (shape.isPointIn(location)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 碰撞框选
   * @param rectangle
   * @returns
   */
  public isIntersectsWithRectangle(rectangle: Rectangle): boolean {
    for (const shape of this.shapes) {
      if (shape.isCollideWithRectangle(rectangle)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 完全覆盖框选
   * @param rectangle
   * @returns
   */
  public isContainedByRectangle(rectangle: Rectangle): boolean {
    for (const shape of this.shapes) {
      const shapeRectangle = shape.getRectangle();
      const shapeLeftTop = shapeRectangle.location;
      const shapeRightBottom = new Vector(
        shapeLeftTop.x + shapeRectangle.size.x,
        shapeLeftTop.y + shapeRectangle.size.y,
      );

      const rectLeftTop = rectangle.location;
      const rectRightBottom = new Vector(rectLeftTop.x + rectangle.size.x, rectLeftTop.y + rectangle.size.y);

      // 判断每个形状的最小外接矩形是否完全在给定矩形内
      if (
        shapeLeftTop.x < rectLeftTop.x ||
        shapeLeftTop.y < rectLeftTop.y ||
        shapeRightBottom.x > rectRightBottom.x ||
        shapeRightBottom.y > rectRightBottom.y
      ) {
        return false;
      }
    }
    return true;
  }

  public isIntersectsWithLine(line: Line): boolean {
    for (const shape of this.shapes) {
      if (shape.isCollideWithLine(line)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取碰撞箱们的最小外接矩形
   * 如果形状数组为空，则返回00点的无大小矩形
   */
  getRectangle(): Rectangle {
    const len = this.shapes.length;
    if (len === 0) {
      return new Rectangle(Vector.getZero(), Vector.getZero());
    }
    if (len === 1) {
      const first = this.shapes[0];
      if (first instanceof Rectangle) {
        return new Rectangle(new Vector(first.location.x, first.location.y), new Vector(first.size.x, first.size.y));
      }
      return first.getRectangle();
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < len; i++) {
      const rectangle = this.shapes[i].getRectangle();
      const x = rectangle.location.x;
      const y = rectangle.location.y;
      const x2 = x + rectangle.size.x;
      const y2 = y + rectangle.size.y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    return new Rectangle(new Vector(minX, minY), new Vector(maxX - minX, maxY - minY));
  }
}
