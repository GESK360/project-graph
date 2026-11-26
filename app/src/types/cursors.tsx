import type { Color } from "@graphif/data-structures";

/**
 * 所有鼠标光标的名称枚举
 */
export enum CursorNameEnum {
  None = "none",
  Default = "default",
  Pointer = "pointer",
  Crosshair = "crosshair",
  Move = "move",
  Grab = "grab",
  Grabbing = "grabbing",
  Text = "text",
  NotAllowed = "not-allowed",
  EResize = "e-resize",
  NResize = "n-resize",
  NeResize = "ne-resize",
  NwResize = "nw-resize",
  SResize = "s-resize",
  SeResize = "se-resize",
  SwResize = "sw-resize",
  WResize = "w-resize",
  NsResize = "ns-resize",
  NeswResize = "nesw-resize",
  NwseResize = "nwse-resize",
  ColResize = "col-resize",
  RowResize = "row-resize",
  AllScroll = "all-scroll",
  ZoomIn = "zoom-in",
  ZoomOut = "zoom-out",
  GrabHand = "grab-hand",
  NotAllowedHand = "not-allowed-hand",
  Pen = "pen",
  Eraser = "eraser",
  Handwriting = "handwriting",
  ZoomInHand = "zoom-in-hand",
  ZoomOutHand = "zoom-out-hand",
}

const PEN_CURSOR_HOTSPOT_X = 3;
const PEN_CURSOR_HOTSPOT_Y = 3;
const penCursorCache = new Map<string, string>();
const MAX_PEN_CURSOR_CACHE_SIZE = 64;

/**
 * 生成手写模式画笔光标（参考 Windows 默认鼠标尺寸与左上朝向，尖端带当前画笔颜色小点）
 */
export function buildPenCursorCssValue(color: Pick<Color, "r" | "g" | "b" | "a">): string {
  const r = Math.max(0, Math.min(255, Math.round(color.r)));
  const g = Math.max(0, Math.min(255, Math.round(color.g)));
  const b = Math.max(0, Math.min(255, Math.round(color.b)));
  const alpha = color.a >= 0.99 ? 1 : Number(Math.max(color.a, 0.65).toFixed(2));
  const cacheKey = `${r},${g},${b},${alpha}`;
  const cached = penCursorCache.get(cacheKey);
  if (cached) return cached;

  const dotFill = alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  const dotStroke = luminance > 160 ? "#18181B" : "#FFFFFF";

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<path d="M5.7 6 L11.3 8 L20.9 17.6 A2.55 2.55 0 0 1 17.3 21.2 L7.7 11.6 Z" fill="rgba(0,0,0,0.22)"/>',
    '<path d="M5 5 L10.6 7 L20.2 16.6 A2.55 2.55 0 0 1 16.6 20.2 L7 10.6 Z" fill="#FFFFFF" stroke="#18181B" stroke-width="1.35" stroke-linejoin="round"/>',
    '<path d="M5.5 5.5 L10.2 7.2 L7.2 10.2 Z" fill="#E2E8F0"/>',
    '<path d="M18.5 14.9 L20.2 16.6 A2.55 2.55 0 0 1 16.6 20.2 L14.9 18.5 Z" fill="#E2E8F0" stroke="#18181B" stroke-width="1.15" stroke-linejoin="round"/>',
    '<line x1="10.4" y1="7.2" x2="7.2" y2="10.4" stroke="#18181B" stroke-width="1.15" stroke-linecap="round"/>',
    `<circle cx="${PEN_CURSOR_HOTSPOT_X}" cy="${PEN_CURSOR_HOTSPOT_Y}" r="2.1" fill="${dotFill}" stroke="${dotStroke}" stroke-width="0.85"/>`,
    "</svg>",
  ].join("");

  const cssValue = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") ${PEN_CURSOR_HOTSPOT_X} ${PEN_CURSOR_HOTSPOT_Y}, crosshair`;
  if (penCursorCache.size >= MAX_PEN_CURSOR_CACHE_SIZE) {
    penCursorCache.clear();
  }
  penCursorCache.set(cacheKey, cssValue);
  return cssValue;
}
