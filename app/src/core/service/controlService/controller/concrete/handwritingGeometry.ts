export type HandwritingPoint = { x: number; y: number };
export type PressurePoint = HandwritingPoint & { pressure: number };
export type EraserShape = "circle" | "square";
export type PressureCurve = "fixed" | "linear" | "sqrt" | "cbrt" | "quadratic" | "cubic";
export type StrokeRenderSample = { location: HandwritingPoint; pressure: number };

export type PenPressureOptions = {
  enabled: boolean;
  curve: PressureCurve;
  sensitivity: number;
  velocitySensitivity: number;
};

export type PenInputSample = {
  viewX: number;
  viewY: number;
  pressure: number;
  pointerType: string;
  timeStamp: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function getPenStrokeLength(points: HandwritingPoint[], scale: number): number {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    const dx = points[index].x - points[index - 1].x;
    const dy = points[index].y - points[index - 1].y;
    length += Math.hypot(dx, dy);
  }
  return length * scale;
}

function pointSegmentDistanceSquared(point: HandwritingPoint, start: HandwritingPoint, end: HandwritingPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    const pointDx = point.x - start.x;
    const pointDy = point.y - start.y;
    return pointDx * pointDx + pointDy * pointDy;
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const closestX = start.x + t * dx;
  const closestY = start.y + t * dy;
  const distanceX = point.x - closestX;
  const distanceY = point.y - closestY;
  return distanceX * distanceX + distanceY * distanceY;
}

function orientation(a: HandwritingPoint, b: HandwritingPoint, c: HandwritingPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: HandwritingPoint, start: HandwritingPoint, end: HandwritingPoint): boolean {
  return (
    point.x >= Math.min(start.x, end.x) &&
    point.x <= Math.max(start.x, end.x) &&
    point.y >= Math.min(start.y, end.y) &&
    point.y <= Math.max(start.y, end.y)
  );
}

function segmentsIntersect(
  firstStart: HandwritingPoint,
  firstEnd: HandwritingPoint,
  secondStart: HandwritingPoint,
  secondEnd: HandwritingPoint,
): boolean {
  const firstA = orientation(firstStart, firstEnd, secondStart);
  const firstB = orientation(firstStart, firstEnd, secondEnd);
  const secondA = orientation(secondStart, secondEnd, firstStart);
  const secondB = orientation(secondStart, secondEnd, firstEnd);
  if (firstA * firstB < 0 && secondA * secondB < 0) return true;
  if (firstA === 0 && pointOnSegment(secondStart, firstStart, firstEnd)) return true;
  if (firstB === 0 && pointOnSegment(secondEnd, firstStart, firstEnd)) return true;
  if (secondA === 0 && pointOnSegment(firstStart, secondStart, secondEnd)) return true;
  return secondB === 0 && pointOnSegment(firstEnd, secondStart, secondEnd);
}

function segmentDistanceSquared(
  firstStart: HandwritingPoint,
  firstEnd: HandwritingPoint,
  secondStart: HandwritingPoint,
  secondEnd: HandwritingPoint,
): number {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0;
  return Math.min(
    pointSegmentDistanceSquared(firstStart, secondStart, secondEnd),
    pointSegmentDistanceSquared(firstEnd, secondStart, secondEnd),
    pointSegmentDistanceSquared(secondStart, firstStart, firstEnd),
    pointSegmentDistanceSquared(secondEnd, firstStart, firstEnd),
  );
}

function pointSegmentSquareDistance(point: HandwritingPoint, start: HandwritingPoint, end: HandwritingPoint): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const distanceAt = (t: number) =>
    Math.max(Math.abs(point.x - start.x - deltaX * t), Math.abs(point.y - start.y - deltaY * t));
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const first = (2 * low + high) / 3;
    const second = (low + 2 * high) / 3;
    if (distanceAt(first) <= distanceAt(second)) high = second;
    else low = first;
  }
  return Math.min(distanceAt(0), distanceAt(1), distanceAt((low + high) / 2));
}

export function sweptEraserHitsStrokeSegment(
  eraserStart: HandwritingPoint,
  eraserEnd: HandwritingPoint,
  strokeStart: HandwritingPoint,
  strokeEnd: HandwritingPoint,
  radius: number,
  shape: EraserShape,
): boolean {
  if (shape === "circle") {
    return segmentDistanceSquared(eraserStart, eraserEnd, strokeStart, strokeEnd) <= radius * radius;
  }

  const dx = eraserEnd.x - eraserStart.x;
  const dy = eraserEnd.y - eraserStart.y;
  const sampleCount = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(radius / 2, 0.5)));
  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    const point = { x: eraserStart.x + dx * t, y: eraserStart.y + dy * t };
    if (pointSegmentSquareDistance(point, strokeStart, strokeEnd) <= radius) return true;
  }
  return false;
}

export function applyPressureCurve(pressure: number, curve: PressureCurve): number {
  if (curve === "fixed") return 1;
  const normalized = clamp01(pressure);
  switch (curve) {
    case "linear":
      return normalized;
    case "sqrt":
      return Math.sqrt(normalized);
    case "cbrt":
      return Math.cbrt(normalized);
    case "quadratic":
      return normalized ** 2;
    case "cubic":
      return normalized ** 3;
  }
}

export function normalizePenPressure(pressure: number, curve: PressureCurve, enabled: boolean): number {
  if (!enabled || curve === "fixed" || !Number.isFinite(pressure) || pressure <= 0) return 1;
  return applyPressureCurve(pressure, curve);
}

/**
 * 将屏幕空间绘制速度 (px/ms) 映射为 [0, 1] 模拟压力：慢写趋近 1（较粗），快划趋近 0（较细）
 */
export function velocityToPressure(speedPxPerMs: number): number {
  const speed = Math.max(0, Number.isFinite(speedPxPerMs) ? speedPxPerMs : 0);
  return 1 / (1 + (speed / 0.65) ** 1.35);
}

/**
 * 将归一化压力 [0, 1] 结合曲线与压感强度映射为笔迹宽度倍率
 */
export function mapPressureToWidthFactor(
  normalizedPressure: number,
  curve: PressureCurve,
  sensitivity: number,
): number {
  if (curve === "fixed" || !Number.isFinite(sensitivity) || sensitivity <= 0) return 1;
  const s = clamp01(sensitivity);
  const curved = applyPressureCurve(normalizedPressure, curve);
  const minFactor = Math.max(0.12, 1 - 0.88 * s);
  const maxFactor = 1 + 0.55 * s;
  return minFactor + (maxFactor - minFactor) * curved;
}

/**
 * 单笔画压感跟踪器：
 * - 数位笔/压力触控：优先响应真实硬件力度，并叠加柔和的速度笔锋调制
 * - 鼠标/触控板/无压感笔：基于屏幕空间移动速度平滑模拟自然压感，并在快速收笔时自然收尖
 */
export class StrokePressureTracker {
  private lastX = 0;
  private lastY = 0;
  private lastTime = 0;
  private hasStarted = false;
  private smoothedVelocity = 0.55;
  private smoothedPressure = 0.52;
  private hasRealHardwarePressure = false;
  private lastHardwarePressure: number | null = null;
  private lastWidthFactor = 1;
  private totalViewDistance = 0;

  constructor(private readonly options: PenPressureOptions) {}

  private isDynamicEnabled(): boolean {
    return this.options.enabled && this.options.curve !== "fixed" && this.options.sensitivity > 0;
  }

  private normalizeTime(timeStamp: number): number {
    if (Number.isFinite(timeStamp) && timeStamp > 0) return timeStamp;
    return this.hasStarted ? this.lastTime + 8 : 0;
  }

  private detectHardwarePressure(pointerType: string, rawPressure: number) {
    if (!Number.isFinite(rawPressure) || rawPressure <= 0) return;
    const clamped = clamp01(rawPressure);
    if (pointerType === "pen") {
      // 标准无压感设备恒报 0.5；真实数位笔会产生偏离 0.5 的力度值（含轻触或满压 1.0）
      if (Math.abs(clamped - 0.5) > 0.002) {
        this.hasRealHardwarePressure = true;
      } else if (this.lastHardwarePressure !== null && Math.abs(clamped - this.lastHardwarePressure) > 0.002) {
        this.hasRealHardwarePressure = true;
      }
      this.lastHardwarePressure = clamped;
    } else if (pointerType === "touch") {
      if (clamped < 1 && Math.abs(clamped - 0.5) > 0.002) {
        this.hasRealHardwarePressure = true;
      } else if (
        this.lastHardwarePressure !== null &&
        clamped < 1 &&
        Math.abs(clamped - this.lastHardwarePressure) > 0.002
      ) {
        this.hasRealHardwarePressure = true;
      }
      if (clamped < 1) this.lastHardwarePressure = clamped;
    }
  }

  public start(sample: PenInputSample): number {
    this.lastX = sample.viewX;
    this.lastY = sample.viewY;
    this.lastTime = this.normalizeTime(sample.timeStamp);
    this.hasStarted = true;
    this.totalViewDistance = 0;

    if (!this.isDynamicEnabled()) {
      this.lastWidthFactor = 1;
      return 1;
    }

    const { curve, sensitivity, velocitySensitivity } = this.options;
    this.detectHardwarePressure(sample.pointerType, sample.pressure);

    if (this.hasRealHardwarePressure) {
      this.smoothedPressure = clamp01(sample.pressure);
      this.lastWidthFactor = mapPressureToWidthFactor(this.smoothedPressure, curve, sensitivity);
    } else if (sample.pointerType === "pen" && Number.isFinite(sample.pressure) && sample.pressure === 0) {
      // 部分数位笔驱动在 pointerdown 瞬间先报 0 压感，落笔从偏细起笔而非跳成满粗
      this.smoothedPressure = 0.25;
      this.lastWidthFactor = mapPressureToWidthFactor(this.smoothedPressure, curve, sensitivity);
    } else if (velocitySensitivity <= 0) {
      this.smoothedPressure = 0.5;
      this.lastWidthFactor = 1;
    } else {
      this.smoothedVelocity = 0.55;
      this.smoothedPressure = 0.52;
      const effectiveSensitivity = sensitivity * Math.min(1, velocitySensitivity * 1.35);
      this.lastWidthFactor = mapPressureToWidthFactor(this.smoothedPressure, curve, effectiveSensitivity);
    }
    return this.lastWidthFactor;
  }

  public update(sample: PenInputSample): { widthFactor: number; shouldKeep: boolean } {
    if (!this.hasStarted) {
      return { widthFactor: this.start(sample), shouldKeep: true };
    }

    const dist = Math.hypot(sample.viewX - this.lastX, sample.viewY - this.lastY);
    const time = this.normalizeTime(sample.timeStamp);
    const rawDt = Math.max(0, time - this.lastTime);

    if (!this.isDynamicEnabled()) {
      const shouldKeep = dist >= 0.75;
      if (shouldKeep) {
        this.lastX = sample.viewX;
        this.lastY = sample.viewY;
        this.lastTime = time;
        this.totalViewDistance += dist;
      }
      this.lastWidthFactor = 1;
      return { widthFactor: 1, shouldKeep };
    }

    const { curve, sensitivity, velocitySensitivity } = this.options;
    this.detectHardwarePressure(sample.pointerType, sample.pressure);

    const effectiveDt = rawDt >= 1 ? rawDt : 4;
    if (dist > 0.1 || rawDt > 60) {
      const instantVelocity = Math.min(8, dist / effectiveDt);
      const velAlpha = 1 - Math.exp(-Math.min(effectiveDt, 80) / 28);
      this.smoothedVelocity += (instantVelocity - this.smoothedVelocity) * velAlpha;
    }

    const velocityP = velocityToPressure(this.smoothedVelocity);
    let widthFactor: number;

    if (this.hasRealHardwarePressure) {
      const hwPressure =
        Number.isFinite(sample.pressure) && sample.pressure >= 0
          ? clamp01(sample.pressure)
          : (this.lastHardwarePressure ?? this.smoothedPressure);
      const velMod = (velocityP - 0.5) * 0.4 * clamp01(velocitySensitivity) * (0.35 + 0.65 * hwPressure);
      const targetP = clamp01(hwPressure + velMod);
      const pAlpha = 1 - Math.exp(-Math.min(effectiveDt, 60) / 14);
      this.smoothedPressure += (targetP - this.smoothedPressure) * pAlpha;
      widthFactor = mapPressureToWidthFactor(this.smoothedPressure, curve, sensitivity);
    } else if (velocitySensitivity <= 0) {
      widthFactor = 1;
    } else {
      const pAlpha = 1 - Math.exp(-Math.min(effectiveDt, 80) / 30);
      this.smoothedPressure += (velocityP - this.smoothedPressure) * pAlpha;
      const effectiveSensitivity = sensitivity * Math.min(1, clamp01(velocitySensitivity) * 1.35);
      widthFactor = mapPressureToWidthFactor(this.smoothedPressure, curve, effectiveSensitivity);
    }

    const shouldKeep = dist >= 0.75 || Math.abs(widthFactor - this.lastWidthFactor) >= 0.04;
    if (shouldKeep) {
      this.lastX = sample.viewX;
      this.lastY = sample.viewY;
      this.lastTime = time;
      this.totalViewDistance += dist;
      this.lastWidthFactor = widthFactor;
    }
    return { widthFactor, shouldKeep };
  }

  public finish(sample: PenInputSample): number {
    if (!this.isDynamicEnabled()) return 1;
    if (!this.hasStarted) return this.start(sample);

    const dist = Math.hypot(sample.viewX - this.lastX, sample.viewY - this.lastY);
    if (dist > 0.1) {
      this.update(sample);
    }

    const { curve, sensitivity, velocitySensitivity } = this.options;
    if (this.hasRealHardwarePressure) {
      const minFactor = Math.max(0.12, 1 - 0.88 * clamp01(sensitivity));
      if (Number.isFinite(sample.pressure) && sample.pressure > 0) {
        const liftFactor = mapPressureToWidthFactor(clamp01(sample.pressure), curve, sensitivity);
        return Math.min(this.lastWidthFactor, liftFactor);
      }
      if (this.totalViewDistance > 10 && this.smoothedVelocity > 0.45) {
        const taper = 1 - Math.min(0.45, (this.smoothedVelocity - 0.45) * 0.22);
        return Math.max(minFactor * 0.6, this.lastWidthFactor * taper);
      }
      return this.lastWidthFactor;
    }

    if (velocitySensitivity <= 0) return 1;
    if (this.totalViewDistance > 12 && this.smoothedVelocity > 0.45) {
      const effectiveSensitivity = sensitivity * Math.min(1, clamp01(velocitySensitivity) * 1.35);
      const minFactor = Math.max(0.12, 1 - 0.88 * clamp01(effectiveSensitivity));
      const taper = 1 - Math.min(0.45, (this.smoothedVelocity - 0.45) * 0.22);
      return Math.max(minFactor * 0.65, this.lastWidthFactor * taper);
    }
    return this.lastWidthFactor;
  }
}

/**
 * 为变宽压感笔迹构建平滑闭合多边形轮廓（含圆弧端点与尖角防交叉保护），供 Canvas 单次 fill() 渲染
 */
export function buildVariableWidthStrokeOutline(
  stroke: StrokeRenderSample[],
  width: number,
  scale: number,
): HandwritingPoint[] {
  if (stroke.length === 0) return [];
  const safeScale = Math.max(scale, 0.000001);
  const safeWidth = Math.max(0.5, width);
  const radiusOf = (pressure: number) => Math.max(0.35, (Math.max(0.05, pressure) * safeWidth * safeScale) / 2);

  const spine: Array<{ x: number; y: number; r: number }> = [];
  const pushSpine = (x: number, y: number, r: number, force = false) => {
    const prev = spine.at(-1);
    if (!prev || force || Math.hypot(x - prev.x, y - prev.y) >= 0.45) {
      spine.push({ x, y, r });
    }
  };

  const first = stroke[0];
  pushSpine(first.location.x, first.location.y, radiusOf(first.pressure), true);

  if (stroke.length === 2) {
    const second = stroke[1];
    const r0 = radiusOf(first.pressure);
    const r1 = radiusOf(second.pressure);
    const dist = Math.hypot(second.location.x - first.location.x, second.location.y - first.location.y);
    const steps = Math.max(1, Math.min(12, Math.ceil(dist / 6)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      pushSpine(
        first.location.x + (second.location.x - first.location.x) * t,
        first.location.y + (second.location.y - first.location.y) * t,
        r0 + (r1 - r0) * t,
        s === steps,
      );
    }
  } else if (stroke.length >= 3) {
    let startX = first.location.x;
    let startY = first.location.y;
    let startR = radiusOf(first.pressure);

    for (let i = 1; i < stroke.length - 1; i++) {
      const curr = stroke[i];
      const next = stroke[i + 1];
      const currR = radiusOf(curr.pressure);
      const nextR = radiusOf(next.pressure);
      const midX = (curr.location.x + next.location.x) / 2;
      const midY = (curr.location.y + next.location.y) / 2;
      const midR = (currR + nextR) / 2;

      const segLen =
        Math.hypot(curr.location.x - startX, curr.location.y - startY) +
        Math.hypot(midX - curr.location.x, midY - curr.location.y);
      const steps = Math.max(1, Math.min(8, Math.ceil(segLen / 4)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const omt = 1 - t;
        const x = omt * omt * startX + 2 * omt * t * curr.location.x + t * t * midX;
        const y = omt * omt * startY + 2 * omt * t * curr.location.y + t * t * midY;
        const r = omt * omt * startR + 2 * omt * t * currR + t * t * midR;
        pushSpine(x, y, r);
      }

      startX = midX;
      startY = midY;
      startR = midR;
    }

    const last = stroke[stroke.length - 1];
    const lastR = radiusOf(last.pressure);
    const tailDist = Math.hypot(last.location.x - startX, last.location.y - startY);
    const tailSteps = Math.max(1, Math.min(8, Math.ceil(tailDist / 4)));
    for (let s = 1; s <= tailSteps; s++) {
      const t = s / tailSteps;
      pushSpine(
        startX + (last.location.x - startX) * t,
        startY + (last.location.y - startY) * t,
        startR + (lastR - startR) * t,
        s === tailSteps,
      );
    }
  }

  // 合并过近尾点，确保每段切线非零
  while (spine.length >= 2) {
    const a = spine[spine.length - 2];
    const b = spine[spine.length - 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.05) {
      a.r = Math.max(a.r, b.r);
      spine.pop();
    } else {
      break;
    }
  }

  if (spine.length < 2) {
    const center = spine[0];
    const circle: HandwritingPoint[] = [];
    const segments = 12;
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      circle.push({
        x: center.x + Math.cos(angle) * center.r,
        y: center.y + Math.sin(angle) * center.r,
      });
    }
    return circle;
  }

  const dirs: HandwritingPoint[] = [];
  for (let i = 0; i < spine.length - 1; i++) {
    const dx = spine[i + 1].x - spine[i].x;
    const dy = spine[i + 1].y - spine[i].y;
    const len = Math.hypot(dx, dy) || 1;
    dirs.push({ x: dx / len, y: dy / len });
  }

  const left: HandwritingPoint[] = [];
  const right: HandwritingPoint[] = [];

  const firstDir = dirs[0];
  left.push({ x: spine[0].x - firstDir.y * spine[0].r, y: spine[0].y + firstDir.x * spine[0].r });
  right.push({ x: spine[0].x + firstDir.y * spine[0].r, y: spine[0].y - firstDir.x * spine[0].r });

  for (let i = 1; i < spine.length - 1; i++) {
    const p = spine[i];
    const d1 = dirs[i - 1];
    const d2 = dirs[i];
    const dot = d1.x * d2.x + d1.y * d2.y;

    if (dot >= 0.15) {
      const tx = d1.x + d2.x;
      const ty = d1.y + d2.y;
      const tLen = Math.hypot(tx, ty) || 1;
      const nx = -ty / tLen;
      const ny = tx / tLen;
      left.push({ x: p.x + nx * p.r, y: p.y + ny * p.r });
      right.push({ x: p.x - nx * p.r, y: p.y - ny * p.r });
    } else {
      const cross = d1.x * d2.y - d1.y * d2.x;
      const n1x = -d1.y;
      const n1y = d1.x;
      const n2x = -d2.y;
      const n2y = d2.x;
      const outerRight = cross >= 0;
      const uStartX = outerRight ? -n1x : n1x;
      const uStartY = outerRight ? -n1y : n1y;
      const uEndX = outerRight ? -n2x : n2x;
      const uEndY = outerRight ? -n2y : n2y;
      const arcCos = Math.max(-1, Math.min(1, uStartX * uEndX + uStartY * uEndY));
      const totalAngle = Math.acos(arcCos);
      const sign = outerRight ? 1 : -1;
      const arcSteps = 3;
      const outerTarget = outerRight ? right : left;
      for (let step = 0; step <= arcSteps; step++) {
        const theta = sign * totalAngle * (step / arcSteps);
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const rx = uStartX * cosT - uStartY * sinT;
        const ry = uStartX * sinT + uStartY * cosT;
        outerTarget.push({ x: p.x + rx * p.r, y: p.y + ry * p.r });
      }
      const innerTarget = outerRight ? left : right;
      const ix = (outerRight ? n1x + n2x : -(n1x + n2x)) * 0.5;
      const iy = (outerRight ? n1y + n2y : -(n1y + n2y)) * 0.5;
      const iLen = Math.hypot(ix, iy);
      if (iLen > 0.2) {
        innerTarget.push({ x: p.x + (ix / iLen) * p.r, y: p.y + (iy / iLen) * p.r });
      } else {
        innerTarget.push({ x: p.x, y: p.y });
      }
    }
  }

  const lastIdx = spine.length - 1;
  const lastDir = dirs[dirs.length - 1];
  const lastPt = spine[lastIdx];
  left.push({ x: lastPt.x - lastDir.y * lastPt.r, y: lastPt.y + lastDir.x * lastPt.r });
  right.push({ x: lastPt.x + lastDir.y * lastPt.r, y: lastPt.y - lastDir.x * lastPt.r });

  const outline: HandwritingPoint[] = [...left];

  // 末端圆弧封口
  const endNx = -lastDir.y;
  const endNy = lastDir.x;
  const capSteps = 6;
  for (let k = 1; k < capSteps; k++) {
    const theta = (k / capSteps) * Math.PI;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    outline.push({
      x: lastPt.x + (endNx * cosT + lastDir.x * sinT) * lastPt.r,
      y: lastPt.y + (endNy * cosT + lastDir.y * sinT) * lastPt.r,
    });
  }

  for (let i = right.length - 1; i >= 0; i--) {
    outline.push(right[i]);
  }

  // 起点圆弧封口
  const startPt = spine[0];
  const startNx = -firstDir.y;
  const startNy = firstDir.x;
  for (let k = 1; k < capSteps; k++) {
    const theta = (k / capSteps) * Math.PI;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    outline.push({
      x: startPt.x + (-startNx * cosT - firstDir.x * sinT) * startPt.r,
      y: startPt.y + (-startNy * cosT - firstDir.y * sinT) * startPt.r,
    });
  }

  return outline;
}

export function splitStrokeByEraser(
  stroke: PressurePoint[],
  eraserStart: HandwritingPoint,
  eraserEnd: HandwritingPoint,
  eraserRadius: number,
  strokeWidth: number,
  scale: number,
  shape: EraserShape,
): { erased: boolean; segments: PressurePoint[][] } {
  if (stroke.length < 2) return { erased: false, segments: [stroke] };
  const safeScale = Math.max(scale, 0.000001);
  let erased = false;
  let current: PressurePoint[] = [];
  const segments: PressurePoint[][] = [];
  const finishSegment = () => {
    if (current.length >= 2) segments.push(current);
    current = [];
  };

  for (let segmentIndex = 1; segmentIndex < stroke.length; segmentIndex++) {
    const start = stroke[segmentIndex - 1];
    const end = stroke[segmentIndex];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const sampleCount = Math.max(1, Math.min(4096, Math.ceil((distance * safeScale) / 2)));
    for (let sampleIndex = segmentIndex === 1 ? 0 : 1; sampleIndex <= sampleCount; sampleIndex++) {
      const t = sampleIndex / sampleCount;
      const sample = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        pressure: start.pressure + (end.pressure - start.pressure) * t,
      };
      const radius = eraserRadius + (sample.pressure * strokeWidth) / (2 * safeScale);
      if (sweptEraserHitsStrokeSegment(eraserStart, eraserEnd, sample, sample, radius, shape)) {
        erased = true;
        finishSegment();
      } else if (
        current.length === 0 ||
        Math.hypot(sample.x - current.at(-1)!.x, sample.y - current.at(-1)!.y) > 0.0001
      ) {
        current.push(sample);
      }
    }
  }
  finishSegment();
  return { erased, segments };
}

export function eraserScreenDiameterToWorldRadius(diameter: number, scale: number): number {
  return diameter / (2 * Math.max(scale, 0.000001));
}
