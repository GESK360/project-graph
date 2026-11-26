import { describe, expect, it } from "vitest";
import {
  buildVariableWidthStrokeOutline,
  eraserScreenDiameterToWorldRadius,
  getPenStrokeLength,
  mapPressureToWidthFactor,
  normalizePenPressure,
  splitStrokeByEraser,
  StrokePressureTracker,
  sweptEraserHitsStrokeSegment,
  velocityToPressure,
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

  it("maps higher sensitivity to a broader thin-to-thick width factor range", () => {
    const lowThin = mapPressureToWidthFactor(0.1, "linear", 0.3);
    const lowThick = mapPressureToWidthFactor(0.9, "linear", 0.3);
    const highThin = mapPressureToWidthFactor(0.1, "linear", 0.9);
    const highThick = mapPressureToWidthFactor(0.9, "linear", 0.9);

    expect(highThin).toBeLessThan(lowThin);
    expect(highThick).toBeGreaterThan(lowThick);
    expect(mapPressureToWidthFactor(0.2, "linear", 0)).toBe(1);
    expect(mapPressureToWidthFactor(0.2, "fixed", 0.8)).toBe(1);
  });

  it("maps slower speed to higher simulated pressure than fast sweeps", () => {
    expect(velocityToPressure(0.1)).toBeGreaterThan(velocityToPressure(0.7));
    expect(velocityToPressure(0.7)).toBeGreaterThan(velocityToPressure(2.5));
  });
});

describe("StrokePressureTracker", () => {
  it("keeps uniform width factor 1 when pressure is disabled", () => {
    const tracker = new StrokePressureTracker({
      enabled: false,
      curve: "linear",
      sensitivity: 0.8,
      velocitySensitivity: 0.7,
    });
    expect(tracker.start({ viewX: 0, viewY: 0, pressure: 0.2, pointerType: "pen", timeStamp: 100 })).toBe(1);
    expect(tracker.update({ viewX: 30, viewY: 0, pressure: 0.9, pointerType: "pen", timeStamp: 110 }).widthFactor).toBe(
      1,
    );
    expect(tracker.finish({ viewX: 60, viewY: 0, pressure: 0, pointerType: "pen", timeStamp: 120 })).toBe(1);
  });

  it("responds to hardware pen force and avoids full-width blobs on zero-pressure touchdown", () => {
    const lightTracker = new StrokePressureTracker({
      enabled: true,
      curve: "linear",
      sensitivity: 0.75,
      velocitySensitivity: 0.5,
    });
    const zeroStart = lightTracker.start({ viewX: 0, viewY: 0, pressure: 0, pointerType: "pen", timeStamp: 100 });
    expect(zeroStart).toBeLessThan(0.8);

    const lightFactor = lightTracker.update({
      viewX: 12,
      viewY: 0,
      pressure: 0.15,
      pointerType: "pen",
      timeStamp: 120,
    }).widthFactor;

    const heavyTracker = new StrokePressureTracker({
      enabled: true,
      curve: "linear",
      sensitivity: 0.75,
      velocitySensitivity: 0.5,
    });
    heavyTracker.start({ viewX: 0, viewY: 0, pressure: 0.9, pointerType: "pen", timeStamp: 100 });
    const heavyFactor = heavyTracker.update({
      viewX: 12,
      viewY: 0,
      pressure: 0.95,
      pointerType: "pen",
      timeStamp: 120,
    }).widthFactor;

    expect(heavyFactor).toBeGreaterThan(lightFactor * 1.8);
  });

  it("modulates stylus strokes with speed while keeping mouse strokes responsive to drawing speed", () => {
    const slowMouse = new StrokePressureTracker({
      enabled: true,
      curve: "linear",
      sensitivity: 0.75,
      velocitySensitivity: 0.65,
    });
    slowMouse.start({ viewX: 0, viewY: 0, pressure: 0.5, pointerType: "mouse", timeStamp: 100 });
    let slowWidth = 1;
    for (let i = 1; i <= 6; i++) {
      slowWidth = slowMouse.update({
        viewX: i * 4,
        viewY: 0,
        pressure: 0.5,
        pointerType: "mouse",
        timeStamp: 100 + i * 30,
      }).widthFactor;
    }

    const fastMouse = new StrokePressureTracker({
      enabled: true,
      curve: "linear",
      sensitivity: 0.75,
      velocitySensitivity: 0.65,
    });
    fastMouse.start({ viewX: 0, viewY: 0, pressure: 0.5, pointerType: "mouse", timeStamp: 100 });
    let fastWidth = 1;
    for (let i = 1; i <= 6; i++) {
      fastWidth = fastMouse.update({
        viewX: i * 32,
        viewY: 0,
        pressure: 0.5,
        pointerType: "mouse",
        timeStamp: 100 + i * 10,
      }).widthFactor;
    }
    const fastRelease = fastMouse.finish({
      viewX: 220,
      viewY: 0,
      pressure: 0,
      pointerType: "mouse",
      timeStamp: 170,
    });

    expect(slowWidth).toBeGreaterThan(1.05);
    expect(fastWidth).toBeLessThan(0.65);
    expect(fastRelease).toBeLessThanOrEqual(fastWidth);
  });

  it("keeps mouse strokes uniform when velocity sensitivity is set to zero", () => {
    const tracker = new StrokePressureTracker({
      enabled: true,
      curve: "linear",
      sensitivity: 0.8,
      velocitySensitivity: 0,
    });
    expect(tracker.start({ viewX: 0, viewY: 0, pressure: 0.5, pointerType: "mouse", timeStamp: 100 })).toBe(1);
    expect(
      tracker.update({ viewX: 60, viewY: 0, pressure: 0.5, pointerType: "mouse", timeStamp: 110 }).widthFactor,
    ).toBe(1);
    expect(tracker.finish({ viewX: 100, viewY: 0, pressure: 0, pointerType: "mouse", timeStamp: 120 })).toBe(1);
  });
});

describe("buildVariableWidthStrokeOutline", () => {
  it("builds a wider polygon around higher-pressure regions and stays finite on hairpin turns", () => {
    const outline = buildVariableWidthStrokeOutline(
      [
        { location: { x: 0, y: 0 }, pressure: 0.25 },
        { location: { x: 40, y: 0 }, pressure: 0.8 },
        { location: { x: 80, y: 0 }, pressure: 1.4 },
      ],
      10,
      1,
    );
    expect(outline.length).toBeGreaterThan(10);
    for (const pt of outline) {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
    }

    const leftBandYs = outline.filter((pt) => pt.x >= -2 && pt.x <= 10).map((pt) => pt.y);
    const rightBandYs = outline.filter((pt) => pt.x >= 70 && pt.x <= 85).map((pt) => pt.y);
    const leftThickness = Math.max(...leftBandYs) - Math.min(...leftBandYs);
    const rightThickness = Math.max(...rightBandYs) - Math.min(...rightBandYs);
    expect(rightThickness).toBeGreaterThan(leftThickness * 3);

    const hairpin = buildVariableWidthStrokeOutline(
      [
        { location: { x: 0, y: 0 }, pressure: 0.6 },
        { location: { x: 40, y: 0 }, pressure: 1.2 },
        { location: { x: 0, y: 2 }, pressure: 0.4 },
      ],
      10,
      1,
    );
    expect(hairpin.length).toBeGreaterThan(10);
    for (const pt of hairpin) {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
      expect(Math.abs(pt.x)).toBeLessThan(80);
      expect(Math.abs(pt.y)).toBeLessThan(80);
    }
  });
});
