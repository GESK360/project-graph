import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { isClassroomModeAtom } from "@/state";
import { Vector } from "@graphif/data-structures";
import { Line, Rectangle } from "@graphif/shapes";
import { useAtom } from "jotai";
import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** 小地图尺寸固定，不随节点数量与视野变化 */
export const MINIMAP_WIDTH = 180;
export const MINIMAP_HEIGHT = 120;
/** 节点外接矩形与画布边缘之间保留的空白 */
export const MINIMAP_PADDING = 6;
/** 节点几何信息的兜底刷新间隔（正常修改由 stageRevision 精确触发） */
const STATIC_REFRESH_INTERVAL_IDLE_MS = 800;
/** 相机停止变化后，继续用 requestAnimationFrame 跟几帧再转入低频轮询 */
const ACTIVE_WINDOW_MS = 700;
/** 静止时用定时器轮询视野是否变化，避免常驻 rAF */
const IDLE_CHECK_INTERVAL_MS = 150;
/** 视野框缩得比该像素还小时按该值绘制，保证始终可见 */
const MIN_VIEW_RECT_SIZE = 2;
/** 按下后移动超过该像素才切换为连续拖动，防止轻点手抖打断平滑过渡 */
const DRAG_THRESHOLD_PX = 3;
/** 视野框圆角半径 */
const VIEW_RECT_RADIUS = 4;
/** 小地图画布最多按 2 倍像素比渲染，再高对缩略图没有意义 */
const MAX_PIXEL_RATIO = 2;

const NODE_FILL = "rgba(148, 163, 184, 0.75)";
const EDGE_STROKE = "rgba(148, 163, 184, 0.38)";
const AXIS_STROKE = "rgba(148, 163, 184, 0.6)";
const VIEW_FILL = "rgba(34, 197, 94, 0.12)";
const VIEW_STROKE = "rgba(34, 197, 94, 0.95)";

export type MinimapLayout = {
  /** 世界坐标到小地图像素的缩放比例 */
  scale: number;
  /** 世界坐标原点在小地图上的像素位置 */
  offset: Vector;
  /** 小地图当前覆盖的世界范围 */
  bounds: Rectangle;
};

export type MinimapGeometry = {
  nodeRectangles: Rectangle[];
  edgeLines: Line[];
  layout: MinimapLayout;
};

/**
 * 原点离节点范围太远时并入会让整张图被压成一团，所以只在“不远”时一并显示，
 * 这样 x/y 坐标轴在常见情况下都能落在小地图里。
 */
function includeOrigin(bounds: Rectangle): Rectangle {
  const withOrigin = Rectangle.fromEdges(
    Math.min(bounds.left, 0),
    Math.min(bounds.top, 0),
    Math.max(bounds.right, 0),
    Math.max(bounds.bottom, 0),
  );
  const tooFar = withOrigin.width > bounds.width * 3 || withOrigin.height > bounds.height * 3;
  return tooFar ? bounds : withOrigin;
}

/**
 * 按最外侧节点的外接矩形生成布局：小地图尺寸固定，内容自动伸缩到刚好铺满
 */
export function createLayout(rectangles: Rectangle[], fallbackRectangle: Rectangle): MinimapLayout {
  const contentBounds = rectangles.length > 0 ? Rectangle.getBoundingRectangle(rectangles) : fallbackRectangle;
  const bounds = includeOrigin(contentBounds);
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
  return { scale, offset, bounds: paddedBounds };
}

export function toMinimapPoint(point: Vector, layout: MinimapLayout): Vector {
  return new Vector(point.x * layout.scale + layout.offset.x, point.y * layout.scale + layout.offset.y);
}

export function toMinimapRectangle(rectangle: Rectangle, layout: MinimapLayout): Rectangle {
  return new Rectangle(toMinimapPoint(rectangle.location, layout), rectangle.size.multiply(layout.scale));
}

export function toWorldPoint(point: Vector, layout: MinimapLayout): Vector {
  return new Vector((point.x - layout.offset.x) / layout.scale, (point.y - layout.offset.y) / layout.scale);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 把指针坐标限制在小地图边框内部，拖动时视野中心不会越出小地图范围 */
export function clampPointToMinimap(point: Vector): Vector {
  return new Vector(clampNumber(point.x, 0, MINIMAP_WIDTH), clampNumber(point.y, 0, MINIMAP_HEIGHT));
}

/**
 * 收集一次绘制所需的全部世界坐标几何信息（小地图用端点中心连线替代精确 bodyLine 求交，避免数千条边拖慢首帧）
 */
export function collectGeometry(project: Project): MinimapGeometry {
  const nodeRectangles: Rectangle[] = [];
  const centerByUuid = new Map<string, Vector>();
  for (const entity of project.stageManager.getEntities()) {
    if (entity.isHiddenBySectionCollapse || project.stageManager.isHiddenByBranchCollapse(entity)) continue;
    const rect = entity.collisionBox.getRectangle();
    nodeRectangles.push(rect);
    centerByUuid.set(entity.uuid, rect.center);
  }
  const edgeLines: Line[] = [];
  for (const edge of project.stageManager.getEdges()) {
    if (edge.isHiddenBySectionCollapse || project.stageManager.isHiddenByBranchCollapse(edge)) continue;
    const start = centerByUuid.get(edge.source.uuid);
    const end = centerByUuid.get(edge.target.uuid);
    if (start && end) {
      edgeLines.push(new Line(start, end));
    }
  }
  const layout = createLayout(nodeRectangles, project.renderer.getCoverWorldRectangle());
  return { nodeRectangles, edgeLines, layout };
}

function traceRoundedRectangle(context: CanvasRenderingContext2D, rectangle: Rectangle, radius: number) {
  if (typeof context.roundRect === "function") {
    context.roundRect(rectangle.left, rectangle.top, rectangle.width, rectangle.height, radius);
    return;
  }
  context.rect(rectangle.left, rectangle.top, rectangle.width, rectangle.height);
}

/**
 * 静态层：坐标轴、连线、节点。只在几何变化时重绘
 */
export function drawStaticLayer(context: CanvasRenderingContext2D, geometry: MinimapGeometry) {
  const { layout, nodeRectangles, edgeLines } = geometry;
  context.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

  // 画布的 x/y 坐标轴（世界坐标 y = 0 与 x = 0）
  const xAxisStart = toMinimapPoint(new Vector(layout.bounds.left, 0), layout);
  const xAxisEnd = toMinimapPoint(new Vector(layout.bounds.right, 0), layout);
  const yAxisStart = toMinimapPoint(new Vector(0, layout.bounds.top), layout);
  const yAxisEnd = toMinimapPoint(new Vector(0, layout.bounds.bottom), layout);
  context.beginPath();
  context.moveTo(xAxisStart.x, xAxisStart.y);
  context.lineTo(xAxisEnd.x, xAxisEnd.y);
  context.moveTo(yAxisStart.x, yAxisStart.y);
  context.lineTo(yAxisEnd.x, yAxisEnd.y);
  context.strokeStyle = AXIS_STROKE;
  context.lineWidth = 1;
  context.stroke();

  // 节点之间的连线，一次性攒进同一条 path，减少绘制调用
  if (edgeLines.length > 0) {
    context.beginPath();
    for (const line of edgeLines) {
      const start = toMinimapPoint(line.start, layout);
      const end = toMinimapPoint(line.end, layout);
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
    }
    context.strokeStyle = EDGE_STROKE;
    context.lineWidth = 0.75;
    context.stroke();
  }

  // 节点：同样攒成一条 path 一次填充
  if (nodeRectangles.length > 0) {
    context.beginPath();
    for (const rectangle of nodeRectangles) {
      const mapped = toMinimapRectangle(rectangle, layout);
      context.rect(mapped.left, mapped.top, Math.max(mapped.width, 1), Math.max(mapped.height, 1));
    }
    context.fillStyle = NODE_FILL;
    context.fill();
  }
}

/**
 * 动态层：绿色视野框。相机每次变化只需重画这一层
 */
export function drawViewLayer(context: CanvasRenderingContext2D, viewRectangle: Rectangle, layout: MinimapLayout) {
  context.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

  const mappedView = toMinimapRectangle(viewRectangle, layout);
  const width = Math.max(mappedView.width, MIN_VIEW_RECT_SIZE);
  const height = Math.max(mappedView.height, MIN_VIEW_RECT_SIZE);
  const center = mappedView.center;
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
}

type DragSession = {
  pointerId: number | undefined;
  /** 拖动期间冻结布局，避免静态层定时刷新或空画布重算造成坐标系漂移 */
  layout: MinimapLayout;
  bounds: DOMRect;
  startClientX: number;
  startClientY: number;
  hasDragged: boolean;
};

function clientToClampedMinimapPoint(clientX: number, clientY: number, bounds: DOMRect): Vector {
  return clampPointToMinimap(
    new Vector(
      ((clientX - bounds.left) / bounds.width) * MINIMAP_WIDTH,
      ((clientY - bounds.top) / bounds.height) * MINIMAP_HEIGHT,
    ),
  );
}

function releasePointerCaptureSafely(canvas: HTMLCanvasElement, pointerId: number | undefined) {
  if (
    typeof pointerId === "number" &&
    typeof canvas.hasPointerCapture === "function" &&
    typeof canvas.releasePointerCapture === "function" &&
    canvas.hasPointerCapture(pointerId)
  ) {
    canvas.releasePointerCapture(pointerId);
  }
}

/**
 * 画布右下角的小地图：绿色框表示当前视野，节点与连线按最外侧范围自动缩放
 */
export default function Minimap({ project }: { project: Project }) {
  const [showMinimap] = Settings.use("showMinimap");
  const [isClassroomMode] = useAtom(isClassroomModeAtom);
  const staticCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<MinimapLayout | null>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const syncViewLayerRef = useRef<((forceDraw?: boolean) => void) | null>(null);

  const enabled = showMinimap && !isClassroomMode;

  const endDrag = (canvas: HTMLCanvasElement | null) => {
    const session = dragSessionRef.current;
    if (!session) return;
    dragSessionRef.current = null;
    if (canvas) {
      releasePointerCaptureSafely(canvas, session.pointerId);
    }
    syncViewLayerRef.current?.();
  };

  useEffect(() => {
    if (!enabled) return;
    const staticCanvas = staticCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!staticCanvas || !overlayCanvas) return;
    const staticContext = staticCanvas.getContext("2d");
    const overlayContext = overlayCanvas.getContext("2d");
    if (!staticContext || !overlayContext) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    for (const canvas of [staticCanvas, overlayCanvas]) {
      canvas.width = Math.round(MINIMAP_WIDTH * pixelRatio);
      canvas.height = Math.round(MINIMAP_HEIGHT * pixelRatio);
    }
    staticContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    overlayContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    let rafId = 0;
    let idleTimerId = 0;
    let activeUntil = 0;
    let lastStaticAt = 0;
    let lastStageLength = -1;
    let lastStageRevision = -1;
    let geometry: MinimapGeometry | null = null;
    let lastCamera: number[] | null = null;
    let lastLayout: MinimapLayout | null = null;

    const readCamera = (): number[] => [
      project.camera.location.x,
      project.camera.location.y,
      project.camera.currentScale,
      project.renderer.w,
      project.renderer.h,
    ];

    const cameraChanged = (current: number[]): boolean => {
      if (!lastCamera) return true;
      for (let index = 0; index < current.length; index++) {
        if (current[index] !== lastCamera[index]) return true;
      }
      return false;
    };

    const layoutChanged = (current: MinimapLayout): boolean => {
      if (!lastLayout) return true;
      return (
        current.scale !== lastLayout.scale ||
        current.offset.x !== lastLayout.offset.x ||
        current.offset.y !== lastLayout.offset.y
      );
    };

    const rebuildStaticLayer = (now: number) => {
      geometry = collectGeometry(project);
      layoutRef.current = geometry.layout;
      drawStaticLayer(staticContext, geometry);
      lastStaticAt = now;
      lastStageLength = project.stage.length;
      lastStageRevision = project.stageRevision ?? 0;
    };

    const stopIdleTimer = () => {
      if (!idleTimerId) return;
      window.clearInterval(idleTimerId);
      idleTimerId = 0;
    };

    const startIdleTimer = () => {
      if (idleTimerId) return;
      idleTimerId = window.setInterval(() => {
        if (document.hidden) return;
        stopIdleTimer();
        scheduleFrame();
      }, IDLE_CHECK_INTERVAL_MS);
    };

    const renderViewIfNeeded = (now: number, forceDraw = false) => {
      const dragSession = dragSessionRef.current;
      const activeLayout = dragSession?.layout ?? geometry?.layout ?? null;
      if (activeLayout === null) return;
      const camera = readCamera();
      if (forceDraw || cameraChanged(camera) || layoutChanged(activeLayout)) {
        drawViewLayer(overlayContext, project.renderer.getCoverWorldRectangle(), activeLayout);
        lastCamera = camera;
        lastLayout = activeLayout;
        activeUntil = Math.max(activeUntil, now + ACTIVE_WINDOW_MS);
      }
    };

    const syncViewLayer = (forceDraw = false) => {
      stopIdleTimer();
      const now = performance.now();
      activeUntil = Math.max(activeUntil, now + ACTIVE_WINDOW_MS);
      renderViewIfNeeded(now, forceDraw);
      scheduleFrame();
    };
    syncViewLayerRef.current = syncViewLayer;

    const tick = () => {
      rafId = 0;
      const now = performance.now();
      const hasDragSession = dragSessionRef.current !== null;
      const active = hasDragSession || now < activeUntil;

      if (!hasDragSession) {
        const currentStageRev = project.stageRevision ?? 0;
        const stageChanged = project.stage.length !== lastStageLength || currentStageRev !== lastStageRevision;
        // 仅在舞台版本/对象数变化，或大间隔兜底时重绘静态层；缩放/平移不再每 200ms 扫描数千节点
        const fallbackInterval = active ? STATIC_REFRESH_INTERVAL_IDLE_MS * 2 : STATIC_REFRESH_INTERVAL_IDLE_MS * 4;
        if (geometry === null || stageChanged || now - lastStaticAt >= fallbackInterval) {
          rebuildStaticLayer(now);
        }
      }

      renderViewIfNeeded(now);

      if (hasDragSession || performance.now() < activeUntil) {
        scheduleFrame();
      } else {
        startIdleTimer();
      }
    };

    function scheduleFrame() {
      if (rafId) return;
      rafId = window.requestAnimationFrame(tick);
    }

    const handleWindowBlur = () => endDrag(overlayCanvas);
    window.addEventListener("blur", handleWindowBlur);

    scheduleFrame();

    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      if (rafId) window.cancelAnimationFrame(rafId);
      stopIdleTimer();
      dragSessionRef.current = null;
      syncViewLayerRef.current = null;
      layoutRef.current = null;
    };
  }, [enabled, project]);

  const moveCameraDirectly = (worldLocation: Vector) => {
    project.camera.stopImmediately?.();
    project.camera.location = worldLocation;
    project.controller?.resetCountdownTimer?.();
  };

  const moveCameraSmoothly = (worldLocation: Vector) => {
    project.camera.bombMove(worldLocation);
    project.controller?.resetCountdownTimer?.();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || dragSessionRef.current !== null) return;
    const layout = layoutRef.current;
    if (!layout || !Number.isFinite(layout.scale) || layout.scale <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;

    event.preventDefault();
    event.stopPropagation();

    dragSessionRef.current = {
      pointerId: event.pointerId,
      layout,
      bounds,
      startClientX: event.clientX,
      startClientY: event.clientY,
      hasDragged: false,
    };

    if (typeof event.pointerId === "number" && typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    const minimapPoint = clientToClampedMinimapPoint(event.clientX, event.clientY, bounds);
    moveCameraSmoothly(toWorldPoint(minimapPoint, layout));
    syncViewLayerRef.current?.();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const session = dragSessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
      endDrag(event.currentTarget);
      return;
    }

    const movedDistance = Math.hypot(event.clientX - session.startClientX, event.clientY - session.startClientY);
    if (!session.hasDragged && movedDistance <= DRAG_THRESHOLD_PX) return;

    session.hasDragged = true;
    const minimapPoint = clientToClampedMinimapPoint(event.clientX, event.clientY, session.bounds);
    moveCameraDirectly(toWorldPoint(minimapPoint, session.layout));
    syncViewLayerRef.current?.();
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const session = dragSessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    endDrag(event.currentTarget);
  };

  if (!enabled) return null;

  return (
    <div
      className="bg-popover/95 supports-backdrop-blur:bg-popover/80 border-border/50 absolute right-3 bottom-3 overflow-hidden rounded-lg border shadow-xl backdrop-blur-md select-none"
      style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
    >
      <canvas
        ref={staticCanvasRef}
        style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
        className="pointer-events-none absolute inset-0 block"
      />
      <canvas
        ref={overlayCanvasRef}
        style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
        className="absolute inset-0 block cursor-pointer touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
      />
    </div>
  );
}
