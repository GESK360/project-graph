import { Project } from "@/core/Project";
import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { Settings } from "@/core/service/Settings";
import { PenStroke, PenStrokeSegment } from "@/core/stage/stageObject/entity/PenStroke";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { CursorNameEnum } from "@/types/cursors";
import { isMac } from "@/utils/platform";
import { Color, mixColors, Vector } from "@graphif/data-structures";
import { getPointerSamples } from "../ControllerInput";
import {
  eraserScreenDiameterToWorldRadius,
  getPenStrokeLength,
  normalizePenPressure,
  splitStrokeByEraser,
  sweptEraserHitsStrokeSegment,
} from "./handwritingGeometry";

/**
 * 涂鸦功能
 */
export class ControllerPenStrokeDrawingClass extends ControllerClass {
  private _isUsing: boolean = false;

  /** 在移动的过程中，记录这一笔画的笔迹 */
  public currentSegments: PenStrokeSegment[] = [];
  /** 当前是否是在绘制直线 */
  public isDrawingLine = false;

  public currentStrokeWidth: number = 5;
  private activeStrokeWidth = 5;
  private activeStrokeColor: Color = Color.White;
  private activeToolId = "pen-1";
  private lastEraserLocation: Vector | null = null;
  private erasedWhileUsingEraser = false;

  /**
   * 初始化函数
   */
  constructor(protected readonly project: Project) {
    super(project);
  }

  public mousedown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    if (Settings.mouseLeftMode !== "draw" && event.pointerType !== "pen") {
      return;
    }
    if (this.project.controller.camera.isPreGrabbingWhenSpace) {
      return;
    }
    this._isUsing = true;
    this.activeToolId = Settings.handwritingActiveTool;
    const activePen = Settings.handwritingPens.find((pen) => pen.id === this.activeToolId);
    this.activeStrokeWidth = activePen?.width ?? this.currentStrokeWidth;
    this.currentStrokeWidth = this.activeStrokeWidth;
    this.activeStrokeColor = activePen ? Color.fromCss(activePen.color) : this.getCurrentStrokeColor();
    this.lastEraserLocation = null;
    this.erasedWhileUsingEraser = false;
    if (this.activeToolId === "eraser") {
      const eraserLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
      this.lastEraserLocation = eraserLocation;
      this.eraseAlong(eraserLocation, eraserLocation);
    }
    if (Settings.hideCursorInPenMode) {
      this.project.controller.setCursorName(CursorNameEnum.None);
    }
    const pressWorldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    const pressPressure =
      event.pointerType === "pen"
        ? normalizePenPressure(event.pressure, Settings.penPressureCurve, Settings.enablePenPressure)
        : 1;
    this.currentSegments =
      this.activeToolId === "eraser" ? [] : [new PenStrokeSegment(pressWorldLocation.clone(), pressPressure)];
    if (this.project.controller.pressingKeySet.has("shift")) {
      this.isDrawingLine = true;
    }
    this.lastMoveLocation = pressWorldLocation.clone();
  };

  public mousemove = (event: PointerEvent) => {
    if (!this._isUsing) return;
    if (!this.project.controller.isMouseDown[0] && Settings.mouseLeftMode === "draw") return;
    if (this.project.controller.isMouseDown[0] && Settings.mouseLeftMode !== "draw") return;
    const events = getPointerSamples(event);
    if (this.activeToolId === "eraser") {
      for (const e of events) {
        const eraserLocation = this.project.renderer.transformView2World(new Vector(e.clientX, e.clientY));
        const eraserStart = this.lastEraserLocation ?? eraserLocation;
        this.eraseAlong(eraserStart, eraserLocation);
        this.lastEraserLocation = eraserLocation;
      }
      return;
    }
    for (const e of events) {
      const isPen = e.pointerType === "pen";
      const worldLocation = this.project.renderer.transformView2World(new Vector(e.clientX, e.clientY));
      const finalPressure = isPen
        ? normalizePenPressure(e.pressure, Settings.penPressureCurve, Settings.enablePenPressure)
        : 1;
      this.currentSegments.push(new PenStrokeSegment(worldLocation, finalPressure));
    }
  };

  public mouseup = (event: MouseEvent) => {
    if (!this._isUsing || event.button !== 0) return;
    if (this.activeToolId === "eraser") {
      if (this.erasedWhileUsingEraser) this.project.historyManager.recordStep();
      this.releaseMouseAndClear();
      return;
    }
    if (Settings.mouseLeftMode !== "draw") {
      this.releaseMouseAndClear();
      return;
    }
    // // 计算总长度
    // const length = this.currentSegments.reduce((sum, seg, index) => {
    //   if (index === 0) return 0;
    //   return sum + seg.location.distance(this.currentSegments[index - 1].location);
    // }, 0);
    // toast(`涂鸦长度: ${length}`);
    // // 计算笔迹外接矩形的对角线长度
    // const first = this.currentSegments[0].location;
    // const last = this.currentSegments[this.currentSegments.length - 1].location;
    // const diagonal = first.distance(last);
    // toast(`涂鸦对角线长度: ${diagonal}`);
    const releaseWorldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    const lastSegment = this.currentSegments[this.currentSegments.length - 1];
    if (
      !lastSegment ||
      lastSegment.location.x !== releaseWorldLocation.x ||
      lastSegment.location.y !== releaseWorldLocation.y
    ) {
      this.currentSegments.push(new PenStrokeSegment(releaseWorldLocation, lastSegment?.pressure ?? 1));
    }
    const pathLength = getPenStrokeLength(
      this.currentSegments.map(({ location }) => ({ x: location.x, y: location.y })),
      this.project.camera.currentScale,
    );
    if (pathLength <= 5) {
      // 涂鸦太短，认为是点上色节点
      const entity = this.project.stageManager.findEntityByLocation(releaseWorldLocation);
      if (entity) {
        if (entity instanceof TextNode) {
          if (this.project.controller.pressingKeySet.has("shift")) {
            const entityColor = entity.color.clone();
            entity.color = mixColors(entityColor, this.activeStrokeColor.clone(), 0.1);
          } else {
            entity.color = this.activeStrokeColor.clone();
          }
        }
      }
      this.releaseMouseAndClear();
      return;
    }
    // 正常的划过一段距离
    // 生成笔触
    if (this.project.controller.pressingKeySet.has("shift")) {
      // 直线
      const from = this.currentSegments[0].location.clone();
      const to = this.currentSegments[this.currentSegments.length - 1].location.clone();

      if (this.project.controller.pressingKeySet.has(isMac ? "meta" : "control")) {
        // 垂直于坐标轴的直线
        const dy = Math.abs(to.y - from.y);
        const dx = Math.abs(to.x - from.x);
        if (dy > dx) {
          // 垂直
          to.x = from.x;
        } else {
          // 水平
          to.y = from.y;
        }
      }
      const startX = from.x;
      const startY = from.y;
      const endX = to.x;
      const endY = to.y;

      const stroke = new PenStroke(this.project, {
        segments: [
          new PenStrokeSegment(new Vector(startX, startY), 1),
          new PenStrokeSegment(new Vector(endX, endY), 1),
        ],
        color: this.activeStrokeColor.clone(),
        width: this.activeStrokeWidth,
      });
      this.project.stageManager.add(stroke);
      this.tryAttachStrokeToSection(stroke, new Vector(startX, startY), new Vector(endX, endY));
    } else {
      // 普通笔迹
      const stroke = new PenStroke(this.project, {
        segments: this.currentSegments,
        color: this.activeStrokeColor.clone(),
        width: this.activeStrokeWidth,
      });
      this.project.stageManager.add(stroke);
      const startPt = this.currentSegments[0].location;
      const endPt = this.currentSegments[this.currentSegments.length - 1].location;
      this.tryAttachStrokeToSection(stroke, startPt, endPt);
    }
    this.project.historyManager.recordStep();

    this.releaseMouseAndClear();
  };

  /**
   * 尝试将涂鸦纳入分组框。
   * 当涂鸦的起点和终点都位于同一个 Section 内时，将该涂鸦挂入该 Section。
   */
  private tryAttachStrokeToSection(stroke: PenStroke, startLocation: Vector, endLocation: Vector) {
    const startSection = this.project.sectionMethods.getInnermostSectionByLocation(startLocation);
    if (!startSection) {
      return;
    }
    const endSection = this.project.sectionMethods.getInnermostSectionByLocation(endLocation);
    if (!endSection) {
      return;
    }
    if (startSection.uuid === endSection.uuid) {
      this.project.sectionInOutManager.goInSection([stroke], startSection);
    }
  }

  private releaseMouseAndClear() {
    // 清理
    this.currentSegments = [];
    this.lastEraserLocation = null;
    this.erasedWhileUsingEraser = false;
    this.activeToolId = Settings.handwritingActiveTool;
    this._isUsing = false;
    this.isDrawingLine = false;
  }

  public mouseMoveOutWindowForcedShutdown(_outsideLocation: Vector) {
    super.mouseMoveOutWindowForcedShutdown(_outsideLocation);
    if (this._isUsing) {
      if (this.activeToolId === "eraser" && this.erasedWhileUsingEraser) this.project.historyManager.recordStep();
      this.releaseMouseAndClear();
    }
  }

  public mousewheel: (event: WheelEvent) => void = (event: WheelEvent) => {
    if (!this.project.controller.pressingKeySet.has("shift")) {
      return;
    }
    if (Settings.mouseLeftMode !== "draw") {
      // 涂鸦模式下才能看到量角器，或者转动量角器
      return;
    }
    if (event.deltaY > 0) {
      this.project.drawingControllerRenderer.rotateUpAngle();
    } else {
      this.project.drawingControllerRenderer.rotateDownAngle();
    }
  };

  public getCurrentStrokeColor() {
    if (Settings.handwritingActiveTool === "eraser") return Color.Transparent;
    const activePen = Settings.handwritingPens.find((pen) => pen.id === Settings.handwritingActiveTool);
    if (activePen) return Color.fromCss(activePen.color);
    return Settings.autoFillPenStrokeColorEnable ? new Color(...Settings.autoFillPenStrokeColor) : Color.Transparent;
  }

  public getCurrentStrokeWidth() {
    if (Settings.handwritingActiveTool === "eraser") return 5;
    const activePen = Settings.handwritingPens.find((pen) => pen.id === Settings.handwritingActiveTool);
    return activePen?.width ?? this.currentStrokeWidth;
  }

  public setCurrentStrokeColor(color: Color) {
    const activeTool =
      Settings.handwritingActiveTool === "eraser" ? Settings.handwritingPens[0]?.id : Settings.handwritingActiveTool;
    if (!activeTool) return;
    const activePen = Settings.handwritingPens.find((pen) => pen.id === activeTool);
    if (!activePen) return;
    const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");
    const colorHex =
      `#${channel(color.r)}${channel(color.g)}${channel(color.b)}${channel(color.a * 255)}`.toUpperCase();
    Settings.handwritingPens = Settings.handwritingPens.map((pen) =>
      pen.id === activeTool ? { ...pen, color: colorHex } : pen,
    );
    Settings.autoFillPenStrokeColor = color.toArray();
    Settings.autoFillPenStrokeColorEnable = true;
  }
  public setCurrentStrokeWidth(width: number) {
    const nextWidth = Math.max(1, Math.min(width, 50));
    this.currentStrokeWidth = nextWidth;
    const activeTool = Settings.handwritingActiveTool;
    if (activeTool === "eraser") return;
    const activePen = Settings.handwritingPens.find((pen) => pen.id === activeTool);
    if (!activePen) return;
    Settings.handwritingPens = Settings.handwritingPens.map((pen) =>
      pen.id === activeTool ? { ...pen, width: nextWidth } : pen,
    );
  }

  private eraseAlong(eraserStart: Vector, eraserEnd: Vector) {
    if (Settings.handwritingEraserType === "point") {
      this.erasePointAlong(eraserStart, eraserEnd);
      return;
    }
    const strokes = this.getStrokesHitByEraser(eraserStart, eraserEnd);
    if (strokes.length === 0) return;
    this.project.deleteManager.deleteEntities(strokes);
    this.erasedWhileUsingEraser = true;
  }

  private erasePointAlong(eraserStart: Vector, eraserEnd: Vector) {
    const scale = Math.max(this.project.camera.currentScale, 0.000001);
    const eraserRadius = eraserScreenDiameterToWorldRadius(Settings.handwritingEraserSize, scale);
    const changedStrokes: PenStroke[] = [];
    const deletedStrokes: Array<{ stroke: PenStroke; section: PenStroke["parentSection"] }> = [];
    const newFragments: Array<{ stroke: PenStroke; section: PenStroke["parentSection"] }> = [];

    for (const stroke of this.project.stageManager.getPenStrokes()) {
      if (stroke.isHiddenBySectionCollapse || stroke.segments.length < 2) continue;
      const strokeWidth = stroke.width ?? 5;
      const maxPressure = stroke.segments.reduce((max, segment) => Math.max(max, segment.pressure), 0);
      const padding = eraserRadius + (maxPressure * strokeWidth) / (2 * scale);
      const bounds = stroke.collisionBox.getRectangle();
      if (
        bounds.location.x + bounds.size.x < Math.min(eraserStart.x, eraserEnd.x) - padding ||
        bounds.location.y + bounds.size.y < Math.min(eraserStart.y, eraserEnd.y) - padding ||
        bounds.location.x > Math.max(eraserStart.x, eraserEnd.x) + padding ||
        bounds.location.y > Math.max(eraserStart.y, eraserEnd.y) + padding
      ) {
        continue;
      }

      const result = splitStrokeByEraser(
        stroke.segments.map((segment) => ({
          x: segment.location.x,
          y: segment.location.y,
          pressure: segment.pressure,
        })),
        eraserStart,
        eraserEnd,
        eraserRadius,
        strokeWidth,
        scale,
        Settings.handwritingEraserShape,
      );
      if (!result.erased) continue;

      changedStrokes.push(stroke);
      const parentSection = stroke.parentSection;
      if (result.segments.length === 0) {
        deletedStrokes.push({ stroke, section: parentSection });
        continue;
      }

      const toStrokeSegments = (points: (typeof result.segments)[number]) =>
        points.map((point) => new PenStrokeSegment(new Vector(point.x, point.y), point.pressure));
      stroke.replaceSegments(toStrokeSegments(result.segments[0]));
      for (const fragmentSegments of result.segments.slice(1)) {
        const fragment = new PenStroke(this.project, {
          segments: toStrokeSegments(fragmentSegments),
          color: stroke.color.clone(),
          width: strokeWidth,
        });
        this.project.stageManager.add(fragment, true);
        if (parentSection) newFragments.push({ stroke: fragment, section: parentSection });
      }
    }

    if (changedStrokes.length === 0) return;
    for (const { stroke, section } of deletedStrokes) {
      if (section) this.project.sectionInOutManager.entityDropParent(stroke, false);
      this.project.stageManager.delete(stroke);
    }
    for (const { stroke, section } of newFragments) {
      if (section) this.project.sectionInOutManager.attachEntityToSection(stroke, section);
    }
    this.project.stageManager.updateReferences();
    this.erasedWhileUsingEraser = true;
  }

  private getStrokesHitByEraser(eraserStart: Vector, eraserEnd: Vector) {
    const strokes = this.project.stageManager.getPenStrokes();
    if (strokes.length === 0) return [];
    const scale = Math.max(this.project.camera.currentScale, 0.000001);
    const eraserRadius = eraserScreenDiameterToWorldRadius(Settings.handwritingEraserSize, scale);
    const shape = Settings.handwritingEraserShape;

    return strokes.filter((stroke) => {
      if (stroke.isHiddenBySectionCollapse || stroke.segments.length < 2) return false;
      const maxPressure = stroke.segments.reduce((max, segment) => Math.max(max, segment.pressure), 0);
      const strokeWidth = stroke.width ?? 5;
      const padding = eraserRadius + (maxPressure * strokeWidth) / (2 * scale);
      const bounds = stroke.collisionBox.getRectangle();
      if (
        bounds.location.x + bounds.size.x < Math.min(eraserStart.x, eraserEnd.x) - padding ||
        bounds.location.y + bounds.size.y < Math.min(eraserStart.y, eraserEnd.y) - padding ||
        bounds.location.x > Math.max(eraserStart.x, eraserEnd.x) + padding ||
        bounds.location.y > Math.max(eraserStart.y, eraserEnd.y) + padding
      ) {
        return false;
      }

      for (let strokeIndex = 1; strokeIndex < stroke.segments.length; strokeIndex++) {
        const strokeStart = stroke.segments[strokeIndex - 1];
        const strokeEnd = stroke.segments[strokeIndex];
        const segmentRadius =
          eraserRadius + (Math.max(strokeStart.pressure, strokeEnd.pressure) * strokeWidth) / (2 * scale);
        if (
          sweptEraserHitsStrokeSegment(
            eraserStart,
            eraserEnd,
            strokeStart.location,
            strokeEnd.location,
            segmentRadius,
            shape,
          )
        ) {
          return true;
        }
      }
      return false;
    });
  }
  public changeCurrentStrokeColorAlpha(dAlpha: number) {
    const currentColor = this.getCurrentStrokeColor();
    if (currentColor.a === 0) return;
    const newAlpha = Math.max(Math.min(currentColor.a + dAlpha, 1), 0.01);
    this.setCurrentStrokeColor(currentColor.toNewAlpha(newAlpha));
  }
}
