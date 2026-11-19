export type HandwritingPoint = { x: number; y: number };
export type PressurePoint = HandwritingPoint & { pressure: number };
export type EraserShape = "circle" | "square";
export type PressureCurve = "fixed" | "linear" | "sqrt" | "cbrt" | "quadratic" | "cubic";

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

export function normalizePenPressure(pressure: number, curve: PressureCurve, enabled: boolean): number {
  if (!enabled || curve === "fixed" || !Number.isFinite(pressure) || pressure <= 0) return 1;
  const normalized = Math.max(0, Math.min(1, pressure));
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
