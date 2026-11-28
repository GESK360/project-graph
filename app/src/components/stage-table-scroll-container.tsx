import { cn } from "@/utils/cn";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const MIN_THUMB_SIZE = 32;

/**
 * 为 `@tanstack/react-virtual` 提供安全的容器尺寸监听：
 * - 在真实桌面 WebView 中实时上报 `getBoundingClientRect()` / `ResizeObserver` 尺寸；
 * - 在 jsdom 或面板尚未完成布局（宽高为 0）时回退至 `fallbackRect`，避免虚拟列表塌陷为 0 项；
 * - 兼容仅实现 `observe/disconnect` 的精简 `ResizeObserver` 测试桩，卸载时安全检查 `unobserve`。
 */
export function createSafeObserveElementRect(fallbackRect: { width: number; height: number }) {
  return (
    instance: { scrollElement: Element | null },
    cb: (rect: { width: number; height: number }) => void,
  ): (() => void) | void => {
    const el = instance.scrollElement;
    if (!el) return;

    const emit = (width: number, height: number) => {
      if (width > 0 || height > 0) {
        cb({
          width: width > 0 ? Math.round(width) : fallbackRect.width,
          height: height > 0 ? Math.round(height) : fallbackRect.height,
        });
      } else {
        cb(fallbackRect);
      }
    };

    const rect = el.getBoundingClientRect();
    emit(rect.width, rect.height);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.borderBoxSize?.[0];
      if (box) {
        emit(box.inlineSize, box.blockSize);
      } else {
        emit(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => {
      if (typeof observer.unobserve === "function") {
        observer.unobserve(el);
      }
      observer.disconnect();
    };
  };
}

/**
 * 校验当前运行环境的 `ResizeObserver` 是否实现了 `unobserve`（兼容精简测试桩，避免虚拟器卸载时报错）。
 */
export function canUseVirtualMeasureElement(): boolean {
  return typeof ResizeObserver === "undefined" || typeof ResizeObserver.prototype?.unobserve === "function";
}

interface ScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  vTrackHeight: number;
  hTrackWidth: number;
}

/**
 * 带右侧垂直滑块与底部水平滑块的滚动容器：
 * 支持鼠标拖拽滑块、点击轨道跳转、以及滚轮控制（含底部滑块悬停滚轮与 Shift+滚轮横向滚动）。
 * 严格保留冒泡阶段 `onWheel` 隔离，绝不使用 `onWheelCapture`。
 */
export function TableScrollContainer({
  children,
  layoutDepsKey,
  externalViewportRef,
}: {
  children: React.ReactNode;
  layoutDepsKey: string;
  externalViewportRef?: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const assignViewportRef = useCallback(
    (el: HTMLDivElement | null) => {
      viewportRef.current = el;
      if (externalViewportRef) {
        externalViewportRef.current = el;
      }
    },
    [externalViewportRef],
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const vTrackRef = useRef<HTMLDivElement>(null);
  const hTrackRef = useRef<HTMLDivElement>(null);

  const vDragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    maxScrollTop: number;
    maxThumbTop: number;
  } | null>(null);

  const hDragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    maxScrollLeft: number;
    maxThumbLeft: number;
  } | null>(null);

  const [metrics, setMetrics] = useState<ScrollMetrics>({
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientHeight: 0,
    clientWidth: 0,
    vTrackHeight: 0,
    hTrackWidth: 0,
  });

  const syncMetrics = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const next: ScrollMetrics = {
      scrollTop: vp.scrollTop,
      scrollLeft: vp.scrollLeft,
      scrollHeight: vp.scrollHeight,
      scrollWidth: vp.scrollWidth,
      clientHeight: vp.clientHeight,
      clientWidth: vp.clientWidth,
      vTrackHeight: vTrackRef.current?.clientHeight ?? vp.clientHeight,
      hTrackWidth: hTrackRef.current?.clientWidth ?? vp.clientWidth,
    };
    setMetrics((prev) => {
      if (
        prev.scrollTop === next.scrollTop &&
        prev.scrollLeft === next.scrollLeft &&
        prev.scrollHeight === next.scrollHeight &&
        prev.scrollWidth === next.scrollWidth &&
        prev.clientHeight === next.clientHeight &&
        prev.clientWidth === next.clientWidth &&
        prev.vTrackHeight === next.vTrackHeight &&
        prev.hTrackWidth === next.hTrackWidth
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    syncMetrics();
  }, [syncMetrics, layoutDepsKey]);

  useEffect(() => {
    const vp = viewportRef.current;
    const content = contentRef.current;
    const vTrack = vTrackRef.current;
    const hTrack = hTrackRef.current;
    if (!vp || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncMetrics());
    observer.observe(vp);
    if (content) observer.observe(content);
    if (vTrack) observer.observe(vTrack);
    if (hTrack) observer.observe(hTrack);
    return () => observer.disconnect();
  }, [syncMetrics]);

  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const hasVerticalOverflow = maxScrollTop > 1;
  const vInnerTrack = Math.max(0, metrics.vTrackHeight - 4);
  const vThumbHeight = hasVerticalOverflow
    ? Math.max(
        MIN_THUMB_SIZE,
        Math.min(vInnerTrack, Math.round((metrics.clientHeight / metrics.scrollHeight) * vInnerTrack)),
      )
    : vInnerTrack;
  const maxVThumbTop = Math.max(0, vInnerTrack - vThumbHeight);
  const vThumbTop =
    hasVerticalOverflow && maxVThumbTop > 0
      ? Math.min(maxVThumbTop, (metrics.scrollTop / maxScrollTop) * maxVThumbTop)
      : 0;

  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  const hasHorizontalOverflow = maxScrollLeft > 1;
  const hInnerTrack = Math.max(0, metrics.hTrackWidth - 4);
  const hThumbWidth = hasHorizontalOverflow
    ? Math.max(
        MIN_THUMB_SIZE,
        Math.min(hInnerTrack, Math.round((metrics.clientWidth / metrics.scrollWidth) * hInnerTrack)),
      )
    : hInnerTrack;
  const maxHThumbLeft = Math.max(0, hInnerTrack - hThumbWidth);
  const hThumbLeft =
    hasHorizontalOverflow && maxHThumbLeft > 0
      ? Math.min(maxHThumbLeft, (metrics.scrollLeft / maxScrollLeft) * maxHThumbLeft)
      : 0;

  const handleViewportWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const vp = viewportRef.current;
    if (!vp) return;
    if (e.shiftKey) {
      e.preventDefault();
      vp.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
      syncMetrics();
      return;
    }
    if (!hasVerticalOverflow && hasHorizontalOverflow && e.deltaX === 0 && e.deltaY !== 0) {
      e.preventDefault();
      vp.scrollLeft += e.deltaY;
      syncMetrics();
    }
  };

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_14px] grid-rows-[minmax(0,1fr)_14px] overflow-hidden">
      {/* 主表格视口 */}
      <div
        ref={assignViewportRef}
        data-stage-table-viewport
        onScroll={syncMetrics}
        onWheel={handleViewportWheel}
        className="scrollbar-hide min-h-0 min-w-0 overflow-scroll"
      >
        <div ref={contentRef} className="inline-block min-w-full pr-6 pb-8">
          {children}
        </div>
      </div>

      {/* 右侧垂直滑块 */}
      <div
        ref={vTrackRef}
        data-stage-table-v-scrollbar
        onWheel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const vp = viewportRef.current;
          if (!vp || !hasVerticalOverflow) return;
          vp.scrollTop += e.deltaY !== 0 ? e.deltaY : e.deltaX;
          syncMetrics();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !hasVerticalOverflow || e.target !== e.currentTarget) return;
          e.preventDefault();
          e.stopPropagation();
          const vp = viewportRef.current;
          const track = vTrackRef.current;
          if (!vp || !track || maxVThumbTop <= 0) return;
          const rect = track.getBoundingClientRect();
          const clickY = e.clientY - rect.top - 2;
          const ratio = Math.max(0, Math.min(1, (clickY - vThumbHeight / 2) / maxVThumbTop));
          vp.scrollTop = ratio * maxScrollTop;
          syncMetrics();
        }}
        className="border-border/60 bg-muted/25 relative h-full w-3.5 touch-none border-l select-none"
      >
        <div
          data-stage-table-v-thumb
          style={{
            top: `${2 + vThumbTop}px`,
            height: `${Math.max(0, vThumbHeight)}px`,
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !hasVerticalOverflow) return;
            e.preventDefault();
            e.stopPropagation();
            const vp = viewportRef.current;
            if (!vp) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            vDragRef.current = {
              pointerId: e.pointerId,
              startY: e.clientY,
              startScrollTop: vp.scrollTop,
              maxScrollTop,
              maxThumbTop: maxVThumbTop,
            };
          }}
          onPointerMove={(e) => {
            const drag = vDragRef.current;
            const vp = viewportRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !vp || drag.maxThumbTop <= 0) return;
            const deltaY = e.clientY - drag.startY;
            vp.scrollTop = drag.startScrollTop + (deltaY / drag.maxThumbTop) * drag.maxScrollTop;
            syncMetrics();
          }}
          onPointerUp={(e) => {
            if (vDragRef.current?.pointerId === e.pointerId) {
              vDragRef.current = null;
            }
          }}
          onLostPointerCapture={(e) => {
            if (vDragRef.current?.pointerId === e.pointerId) {
              vDragRef.current = null;
            }
          }}
          className={cn(
            "absolute right-[2px] left-[2px] rounded-full transition-colors",
            hasVerticalOverflow
              ? "bg-muted-foreground/45 hover:bg-muted-foreground/70 active:bg-primary cursor-grab active:cursor-grabbing"
              : "bg-muted-foreground/15 cursor-default",
          )}
        />
      </div>

      {/* 底部水平滑块 */}
      <div
        ref={hTrackRef}
        data-stage-table-h-scrollbar
        onWheel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const vp = viewportRef.current;
          if (!vp || !hasHorizontalOverflow) return;
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          vp.scrollLeft += delta;
          syncMetrics();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !hasHorizontalOverflow || e.target !== e.currentTarget) return;
          e.preventDefault();
          e.stopPropagation();
          const vp = viewportRef.current;
          const track = hTrackRef.current;
          if (!vp || !track || maxHThumbLeft <= 0) return;
          const rect = track.getBoundingClientRect();
          const clickX = e.clientX - rect.left - 2;
          const ratio = Math.max(0, Math.min(1, (clickX - hThumbWidth / 2) / maxHThumbLeft));
          vp.scrollLeft = ratio * maxScrollLeft;
          syncMetrics();
        }}
        className="border-border/60 bg-muted/25 relative h-3.5 w-full touch-none border-t select-none"
      >
        <div
          data-stage-table-h-thumb
          style={{
            left: `${2 + hThumbLeft}px`,
            width: `${Math.max(0, hThumbWidth)}px`,
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !hasHorizontalOverflow) return;
            e.preventDefault();
            e.stopPropagation();
            const vp = viewportRef.current;
            if (!vp) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            hDragRef.current = {
              pointerId: e.pointerId,
              startX: e.clientX,
              startScrollLeft: vp.scrollLeft,
              maxScrollLeft,
              maxThumbLeft: maxHThumbLeft,
            };
          }}
          onPointerMove={(e) => {
            const drag = hDragRef.current;
            const vp = viewportRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !vp || drag.maxThumbLeft <= 0) return;
            const deltaX = e.clientX - drag.startX;
            vp.scrollLeft = drag.startScrollLeft + (deltaX / drag.maxThumbLeft) * drag.maxScrollLeft;
            syncMetrics();
          }}
          onPointerUp={(e) => {
            if (hDragRef.current?.pointerId === e.pointerId) {
              hDragRef.current = null;
            }
          }}
          onLostPointerCapture={(e) => {
            if (hDragRef.current?.pointerId === e.pointerId) {
              hDragRef.current = null;
            }
          }}
          className={cn(
            "absolute top-[2px] bottom-[2px] rounded-full transition-colors",
            hasHorizontalOverflow
              ? "bg-muted-foreground/45 hover:bg-muted-foreground/70 active:bg-primary cursor-grab active:cursor-grabbing"
              : "bg-muted-foreground/15 cursor-default",
          )}
        />
      </div>

      {/* 右下角滑块交汇角 */}
      <div className="border-border/60 bg-muted/35 border-t border-l" />
    </div>
  );
}
