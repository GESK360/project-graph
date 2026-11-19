import { describe, expect, it } from "vitest";
import {
  eraserScreenDiameterToWorldRadius,
  getPenStrokeLength,
  normalizePenPressure,
  splitStrokeByEraser,
  sweptEraserHitsStrokeSegment,
} from "./handwritingGeometry";

describe("handwriting eraser geometry", () => {
  const strokeStart = { x: 0, y: 0 };
  const strokeEnd = { x: 100, y: 0 };

  it("erases a stroke crossed by a circular eraser sweep", () => {
    expect(sweptEraserHitsStrokeSegment({ x: 50, y: 20 }, { x: 50, y: -20 }, strokeStart, strokeEnd, 4, "circle")).toBe(
      true,
    );
  });

  it("does not erase a parallel stroke outside the circular radius", () => {
    expect(sweptEraserHitsStrokeSegment({ x: 0, y: 10 }, { x: 100, y: 10 }, strokeStart, strokeEnd, 4, "circle")).toBe(
      false,
    );
  });

  it("uses a square hit area for square erasers", () => {
    expect(sweptEraserHitsStrokeSegment({ x: 50, y: 6 }, { x: 50, y: 6 }, strokeStart, strokeEnd, 6, "square")).toBe(
      true,
    );
    expect(sweptEraserHitsStrokeSegment({ x: 50, y: 8 }, { x: 50, y: 8 }, strokeStart, strokeEnd, 6, "square")).toBe(
      false,
    );
  });

  it("handles a stationary eraser point and separated collinear segments", () => {
    expect(sweptEraserHitsStrokeSegment({ x: 50, y: 0 }, { x: 50, y: 0 }, strokeStart, strokeEnd, 2, "circle")).toBe(
      true,
    );
    expect(sweptEraserHitsStrokeSegment({ x: 120, y: 0 }, { x: 130, y: 0 }, strokeStart, strokeEnd, 2, "circle")).toBe(
      false,
    );
  });
});

describe("eraser zoom sizing", () => {
  it.each([0.5, 1, 2, 4])("keeps the screen diameter fixed at scale %s", (scale) => {
    const radius = eraserScreenDiameterToWorldRadius(24, scale);
    expect(radius * 2 * scale).toBeCloseTo(24);
  });
});

describe("pen stroke length", () => {
  it("counts the path from press through sparse samples to release", () => {
    expect(
      getPenStrokeLength(
        [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 40, y: 0 },
        ],
        1,
      ),
    ).toBe(40);
  });

  it("converts world distance to visible distance at the current zoom", () => {
    expect(
      getPenStrokeLength(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        0.5,
      ),
    ).toBe(5);
  });
});

describe("point eraser splitting", () => {
  it("keeps both sides of a stroke when a circular eraser crosses the middle", () => {
    const result = splitStrokeByEraser(
      [
        { x: 0, y: 0, pressure: 1 },
        { x: 100, y: 0, pressure: 1 },
      ],
      { x: 50, y: -20 },
      { x: 50, y: 20 },
      3,
      5,
      1,
      "circle",
    );
    expect(result.erased).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].at(-1)!.x).toBeLessThan(50);
    expect(result.segments[1][0].x).toBeGreaterThan(50);
  });

  it("does not split a stroke outside the eraser bounds", () => {
    const result = splitStrokeByEraser(
      [
        { x: 0, y: 10, pressure: 1 },
        { x: 100, y: 10, pressure: 1 },
      ],
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      2,
      5,
      1,
      "circle",
    );
    expect(result.erased).toBe(false);
    expect(result.segments).toHaveLength(1);
  });
});

describe("pen pressure mapping", () => {
  it("can disable pressure and preserves fixed-width mode", () => {
    expect(normalizePenPressure(0.2, "linear", false)).toBe(1);
    expect(normalizePenPressure(0.2, "fixed", true)).toBe(1);
    expect(normalizePenPressure(0, "linear", true)).toBe(1);
  });

  it.each([
    ["linear", 0.25],
    ["sqrt", 0.5],
    ["cbrt", Math.cbrt(0.25)],
    ["quadratic", 0.0625],
    ["cubic", 0.015625],
  ] as const)("applies the %s curve", (curve, expected) => {
    expect(normalizePenPressure(0.25, curve, true)).toBeCloseTo(expected);
  });
});
