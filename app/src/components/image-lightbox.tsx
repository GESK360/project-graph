import type { Project } from "@/core/Project";
import { imageLightboxAtom, store } from "@/state";
import { cn } from "@/utils/cn";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useAtom } from "jotai";
import { ChevronLeft, ChevronRight, Image as ImageIcon, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ImageLightboxItem {
  attachmentId: string;
  label?: string;
  rowUuid?: string;
  imageNodeUuid?: string;
}

function useAttachmentObjectUrl(project: Project | null, attachmentId: string | null): string | null {
  const blob = project && attachmentId ? project.attachments?.get?.(attachmentId) : undefined;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== "function") {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL?.(url);
    };
  }, [blob]);

  return objectUrl;
}

function LightboxThumbnailButton({
  project,
  item,
  index,
  isActive,
  onSelect,
}: {
  project: Project;
  item: ImageLightboxItem;
  index: number;
  isActive: boolean;
  onSelect: () => void;
}) {
  const url = useAttachmentObjectUrl(project, item.attachmentId);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isActive) {
      btnRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [isActive]);

  return (
    <button
      ref={btnRef}
      type="button"
      data-lightbox-thumb={index}
      data-lightbox-thumb-active={isActive ? "true" : undefined}
      title={item.label || `#${index + 1}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={cn(
        "relative h-14 w-20 shrink-0 cursor-pointer overflow-hidden rounded-md border-2 bg-zinc-900/90 transition-all select-none",
        isActive
          ? "z-10 scale-105 border-white opacity-100 shadow-lg ring-2 ring-white/50"
          : "border-white/15 opacity-55 hover:border-white/45 hover:opacity-95",
      )}
    >
      {url ? (
        <img src={url} alt={item.label || ""} draggable={false} className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center text-white/40">
          <ImageIcon className="size-4" />
        </div>
      )}
    </button>
  );
}

export function ImageLightbox({
  project,
  open,
  items,
  initialIndex,
  allItems,
  allInitialIndex,
  onClose,
}: {
  project: Project | null;
  open: boolean;
  items: readonly ImageLightboxItem[];
  initialIndex: number;
  allItems?: readonly ImageLightboxItem[];
  allInitialIndex?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation("stageTable");
  const [scope, setScope] = useState<"primary" | "all">("primary");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const panDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const thumbStripRef = useRef<HTMLDivElement>(null);

  const hasSeparateAllScope = Boolean(allItems && allItems.length > items.length && items.length > 0);
  const activeItems = useMemo(
    () => (scope === "all" && allItems && allItems.length > 0 ? allItems : items),
    [scope, allItems, items],
  );

  // 打开时重置作用域、索引与缩放状态
  useEffect(() => {
    if (!open) return;
    setScope("primary");
    const safeIdx = Math.max(0, Math.min(items.length - 1, initialIndex));
    setCurrentIndex(safeIdx);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [open, items, initialIndex]);

  // 切换图片时重置缩放和平移
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [currentIndex, scope]);

  const safeIndex = activeItems.length > 0 ? Math.max(0, Math.min(activeItems.length - 1, currentIndex)) : 0;
  const currentItem = activeItems[safeIndex] ?? null;
  const mainImageUrl = useAttachmentObjectUrl(project, open && currentItem ? currentItem.attachmentId : null);

  const goPrev = useCallback(() => {
    if (activeItems.length <= 1) return;
    setCurrentIndex((prev) => (prev - 1 + activeItems.length) % activeItems.length);
  }, [activeItems.length]);

  const goNext = useCallback(() => {
    if (activeItems.length <= 1) return;
    setCurrentIndex((prev) => (prev + 1) % activeItems.length);
  }, [activeItems.length]);

  const switchScope = (nextScope: "primary" | "all") => {
    if (nextScope === scope) return;
    const curAttId = currentItem?.attachmentId;
    const targetList = nextScope === "all" && allItems ? allItems : items;
    let nextIdx = nextScope === "all" ? (allInitialIndex ?? 0) : initialIndex;
    if (curAttId) {
      const matched = targetList.findIndex((it) => it.attachmentId === curAttId);
      if (matched >= 0) nextIdx = matched;
    }
    setScope(nextScope);
    setCurrentIndex(Math.max(0, Math.min(targetList.length - 1, nextIdx)));
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        goNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, goPrev, goNext, onClose]);

  const handleMainWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom((prev) => {
      const next = Math.max(0.5, Math.min(4, Number((prev * factor).toFixed(2))));
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const handleImagePointerDown = (e: React.PointerEvent) => {
    if (zoom <= 1 || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    panDragRef.current = { startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };

    const onMove = (moveEvt: PointerEvent) => {
      const st = panDragRef.current;
      if (!st) return;
      setPan({
        x: st.origX + (moveEvt.clientX - st.startX),
        y: st.origY + (moveEvt.clientY - st.startY),
      });
    };

    const onUp = () => {
      panDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!project || !open || activeItems.length === 0) {
    return null;
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-black/82 backdrop-blur-xs" />
        <DialogPrimitive.Content
          data-image-lightbox
          onWheel={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={onClose}
          className="fixed inset-0 z-[101] flex flex-col outline-none select-none"
        >
          <DialogPrimitive.Title className="sr-only">{currentItem?.label || t("columns.images")}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {currentItem?.label || t("columns.images")}
          </DialogPrimitive.Description>

          {/* 顶部信息与缩放工具栏 */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex h-12 shrink-0 items-center justify-between gap-3 px-4 text-xs text-white/90"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span data-lightbox-counter className="rounded-full bg-white/12 px-2.5 py-0.5 font-medium tabular-nums">
                {safeIndex + 1} / {activeItems.length}
              </span>
              {currentItem?.label && <span className="max-w-72 truncate text-white/85">{currentItem.label}</span>}
            </div>

            {hasSeparateAllScope && (
              <div className="flex items-center rounded-full bg-white/10 p-0.5 text-[11px]">
                <button
                  type="button"
                  data-lightbox-scope="primary"
                  onClick={() => switchScope("primary")}
                  className={cn(
                    "cursor-pointer rounded-full px-2.5 py-0.5 transition-colors",
                    scope === "primary" ? "bg-white font-medium text-black" : "text-white/75 hover:text-white",
                  )}
                >
                  {t("lightbox.currentNodeScope", { count: items.length })}
                </button>
                <button
                  type="button"
                  data-lightbox-scope="all"
                  onClick={() => switchScope("all")}
                  className={cn(
                    "cursor-pointer rounded-full px-2.5 py-0.5 transition-colors",
                    scope === "all" ? "bg-white font-medium text-black" : "text-white/75 hover:text-white",
                  )}
                >
                  {t("lightbox.allImagesScope", { count: allItems!.length })}
                </button>
              </div>
            )}

            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={t("lightbox.zoomOut")}
                onClick={() =>
                  setZoom((z) => {
                    const next = Math.max(0.5, Number((z - 0.25).toFixed(2)));
                    if (next <= 1) setPan({ x: 0, y: 0 });
                    return next;
                  })
                }
                className="flex size-8 cursor-pointer items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              >
                <ZoomOut className="size-4" />
              </button>
              <button
                type="button"
                title={t("lightbox.resetZoom")}
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                className="flex h-7 min-w-12 cursor-pointer items-center justify-center gap-1 rounded-full px-2 text-[11px] text-white/85 tabular-nums transition-colors hover:bg-white/15 hover:text-white"
              >
                <span>{Math.round(zoom * 100)}%</span>
                {zoom !== 1 && <RotateCcw className="size-3" />}
              </button>
              <button
                type="button"
                aria-label={t("lightbox.zoomIn")}
                onClick={() => setZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))))}
                className="flex size-8 cursor-pointer items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              >
                <ZoomIn className="size-4" />
              </button>
              <button
                type="button"
                data-lightbox-close
                aria-label={t("fieldDialog.cancel")}
                onClick={onClose}
                className="ml-1 flex size-8 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white/90 transition-colors hover:bg-white/20 hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* 中央大图预览 + 左右切换箭头 */}
          <div
            onWheel={handleMainWheel}
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-16"
          >
            {activeItems.length > 1 && (
              <button
                type="button"
                data-lightbox-prev
                aria-label={t("lightbox.prevImage")}
                onClick={(e) => {
                  e.stopPropagation();
                  goPrev();
                }}
                className="absolute left-4 z-20 flex size-11 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/90 shadow-lg backdrop-blur-xs transition-all hover:scale-105 hover:bg-black/75 hover:text-white"
              >
                <ChevronLeft className="size-6" />
              </button>
            )}

            <div
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setZoom((z) => {
                  if (z !== 1) {
                    setPan({ x: 0, y: 0 });
                    return 1;
                  }
                  return 2;
                });
              }}
              onPointerDown={handleImagePointerDown}
              className={cn(
                "flex max-h-full max-w-full items-center justify-center",
                zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
              )}
            >
              {mainImageUrl ? (
                <img
                  data-lightbox-main-img={currentItem?.attachmentId}
                  src={mainImageUrl}
                  alt={currentItem?.label || ""}
                  draggable={false}
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  }}
                  className="max-h-[calc(100vh-160px)] max-w-[calc(100vw-140px)] rounded-md object-contain shadow-2xl transition-transform duration-75"
                />
              ) : (
                <div className="flex h-64 w-80 flex-col items-center justify-center gap-2 rounded-lg border border-white/15 bg-zinc-900/70 text-white/50">
                  <ImageIcon className="size-10" />
                  <span className="text-xs">{t("imagesCell.emptyLabel")}</span>
                </div>
              )}
            </div>

            {activeItems.length > 1 && (
              <button
                type="button"
                data-lightbox-next
                aria-label={t("lightbox.nextImage")}
                onClick={(e) => {
                  e.stopPropagation();
                  goNext();
                }}
                className="absolute right-4 z-20 flex size-11 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/90 shadow-lg backdrop-blur-xs transition-all hover:scale-105 hover:bg-black/75 hover:text-white"
              >
                <ChevronRight className="size-6" />
              </button>
            )}
          </div>

          {/* 底部缩略图导航条（贴合图 1 效果：点击缩略图直接跳转对应图片） */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex shrink-0 items-center justify-center px-4 pt-2 pb-4"
          >
            <div
              ref={thumbStripRef}
              data-lightbox-thumbnails
              onWheel={(e) => {
                e.stopPropagation();
                if (thumbStripRef.current) {
                  thumbStripRef.current.scrollLeft += e.deltaY;
                }
              }}
              className="flex max-w-[92vw] items-center gap-2 overflow-x-auto rounded-xl border border-white/10 bg-black/55 px-3 py-2 backdrop-blur-md [scrollbar-width:thin]"
            >
              {activeItems.map((item, idx) => (
                <LightboxThumbnailButton
                  key={`${item.attachmentId}-${idx}`}
                  project={project}
                  item={item}
                  index={idx}
                  isActive={idx === safeIndex}
                  onSelect={() => setCurrentIndex(idx)}
                />
              ))}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function openGlobalImageLightbox(req: {
  project: Project;
  items: ImageLightboxItem[];
  initialIndex: number;
  allItems?: ImageLightboxItem[];
  allInitialIndex?: number;
}) {
  if (req.items.length === 0) return;
  store.set(imageLightboxAtom, {
    project: req.project,
    items: req.items,
    initialIndex: req.initialIndex,
    allItems: req.allItems,
    allInitialIndex: req.allInitialIndex,
  });
}

export function GlobalImageLightbox() {
  const [state, setState] = useAtom(imageLightboxAtom);
  if (!state) return null;
  return (
    <ImageLightbox
      project={state.project as Project}
      open={Boolean(state)}
      items={state.items}
      initialIndex={state.initialIndex}
      allItems={state.allItems}
      allInitialIndex={state.allInitialIndex}
      onClose={() => setState(null)}
    />
  );
}
