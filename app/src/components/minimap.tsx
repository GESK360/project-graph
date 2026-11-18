import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { isClassroomModeAtom } from "@/state";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { useAtom } from "jotai";
import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** 小地图尺寸固定，不随节点数量与视野变化 */
export const MINIMAP_WIDTH = 180;
export const MINIMAP_HEIGHT = 120;
/** 节点外接矩形与画布边缘之间保留的空白 */
export const MINIMAP_PADDING = 6;
/** 节点几何信息的刷新间隔，避免每帧遍历全部节点 */
const GEOMETRY_REFRESH_INTERVAL_MS = 200;
/** 视野框缩得比该像素还小时按该值绘制，保证始终可见 */
const MIN_VIEW_RECT_SIZE = 2;
/** 视野框圆角半径 */
const VIEW_RECT_RADIUS = 4;

const ENTITY_FILL = "rgba(148, 163, 184, 0.75)";
const VIEW_FILL = "rgba(34, 197, 94, 0.12)";
const VIEW_STROKE = "rgba(34, 197, 94, 0.95)";

export type MinimapLayout = {
  /** 世界坐标到小地图像素的缩放比例 */
  scale: number;
  /** 世界坐标原点在小地图上的像素位置 */
  offset: Vector;
};

type MinimapGeometry = {
  entityRectangles: Rectangle[];
  layout: MinimapLayout;
};

/**
 * 按最外侧节点的外接矩形生成布局：小地图尺寸固定，内容自动伸缩到刚好铺满
 */
export function createLayout(rectangles: Rectangle[], fallbackRectangle: Rectangle): MinimapLayout {
  const bounds = rectangles.length > 0 ? Rectangle.getBoundingRectangle(rectangles) : fallbackRectangle;
  const padding = Math.max(bounds.width, bounds.height) * 0.04;
  const paddedBounds = bounds.expandFromCenter(padding);
  const usableWidth = MINIMAP_WIDTH - MINIMAP_PADDING * 2;
  const usableHeight = MINIMAP_HEIGHT - MINIMAP_PADDING * 2;
  const scale = Math.min(
    usableWidth / Math.max(paddedBounds.width, 1e-6),
    usableHeight / Math.max(paddedBounds.height, 1e-6),
  );
  const offset = new Vector(
    MINIMAP_PADDING + (usableWidth - paddedBounds.width * scale) / 2 - paddedBounds.left * scale,
    MINIMAP_PADDING + (usableHeight - paddedBounds.height * scale) / 2 - paddedBounds.top * scale,
  );
  return { scale, offset };
}

export function toMinimapRectangle(rectangle: Rectangle, layout: MinimapLayout): Rectangle {
  return new Rectangle(
    new Vector(rectangle.left * layout.scale + layout.offset.x, rectangle.top * layout.scale + layout.offset.y),
    new Vector(rectangle.width * layout.scale, rectangle.height * layout.scale),
  );
}

function traceRoundedRectangle(context: CanvasRenderingContext2D, rectangle: Rectangle, radius: number) {
  if (typeof context.roundRect === "function") {
    context.roundRect(rectangle.left, rectangle.top, rectangle.width, rectangle.height, radius);
    return;
  }
  context.rect(rectangle.left, rectangle.top, rectangle.width, rectangle.height);
}

/**
 * 画布右下角的小地图：绿色框表示当前视野，节点按最外侧范围自动缩放
 */
export default function Minimap({ project }: { project: Project }) {
  const [showMinimap] = Settings.use("showMinimap");
  const [isClassroomMode] = useAtom(isClassroomModeAtom);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<MinimapLayout | null>(null);

  const enabled = showMinimap && !isClassroomMode;

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(MINIMAP_WIDTH * pixelRatio);
    canvas.height = Math.round(MINIMAP_HEIGHT * pixelRatio);

    let frameId = 0;
    let lastGeometryAt = 0;
    let lastStageLength = -1;
    let geometry: MinimapGeometry | null = null;

    const refreshGeometry = () => {
      const entityRectangles: Rectangle[] = [];
      for (const entity of project.stageManager.getEntities()) {
        if (entity.isHiddenBySectionCollapse) continue;
        entityRectangles.push(entity.collisionBox.getRectangle());
      }
      const layout = createLayout(entityRectangles, project.renderer.getCoverWorldRectangle());
      geometry = { entityRectangles, layout };
      layoutRef.current = layout;
      lastGeometryAt = performance.now();
      lastStageLength = project.stage.length;
    };

    const drawViewRectangle = (layout: MinimapLayout) => {
      const viewRectangle = toMinimapRectangle(project.renderer.getCoverWorldRectangle(), layout);
      const width = Math.max(viewRectangle.width, MIN_VIEW_RECT_SIZE);
      const height = Math.max(viewRectangle.height, MIN_VIEW_RECT_SIZE);
      const center = viewRectangle.center;
      const roundedRectangle = Rectangle.fromEdges(
        center.x - width / 2,
        center.y - height / 2,
        center.x + width / 2,
        center.y + height / 2,
      );
      const radius = Math.min(VIEW_RECT_RADIUS, width / 2, height / 2);

      context.save();
      context.beginPath();
      context.rect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
      context.clip();

      context.beginPath();
      traceRoundedRectangle(context, roundedRectangle, radius);
      context.fillStyle = VIEW_FILL;
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = VIEW_STROKE;
      context.stroke();

      context.restore();
    };

    const draw = () => {
      if (
        geometry === null ||
        performance.now() - lastGeometryAt > GEOMETRY_REFRESH_INTERVAL_MS ||
        project.stage.length !== lastStageLength
      ) {
        refreshGeometry();
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
      if (geometry === null) return;

      context.fillStyle = ENTITY_FILL;
      for (const rectangle of geometry.entityRectangles) {
        const minimapRectangle = toMinimapRectangle(rectangle, geometry.layout);
        context.fillRect(
          minimapRectangle.left,
          minimapRectangle.top,
          Math.max(minimapRectangle.width, 1),
          Math.max(minimapRectangle.height, 1),
        );
      }

      drawViewRectangle(geometry.layout);
    };

    const tick = () => {
      draw();
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frameId);
      layoutRef.current = null;
    };
  }, [enabled, project]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const layout = layoutRef.current;
    if (!layout) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * MINIMAP_WIDTH;
    const y = ((event.clientY - bounds.top) / bounds.height) * MINIMAP_HEIGHT;
    const worldLocation = new Vector((x - layout.offset.x) / layout.scale, (y - layout.offset.y) / layout.scale);
    project.camera.bombMove(worldLocation);
  };

  if (!enabled) return null;

  return (
    <div className="bg-popover/95 supports-backdrop-blur:bg-popover/80 border-border/50 absolute right-3 bottom-3 overflow-hidden rounded-lg border shadow-xl backdrop-blur-md">
      <canvas
        ref={canvasRef}
        style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
        className="block cursor-pointer"
        onPointerDown={handlePointerDown}
      />
    </div>
  );
}
