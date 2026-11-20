import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import type { Project } from "@/core/Project";
import { getSelectedHandwritingEraser, Settings, type HandwritingEraser } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import { Copy, Eraser, Pencil, Trash2, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type DrawingPen = (typeof Settings.handwritingPens)[number];

const penColors = [
  { value: "#1F2937", key: "charcoal" },
  { value: "#EF4444", key: "red" },
  { value: "#F97316", key: "orange" },
  { value: "#EAB308", key: "yellow" },
  { value: "#22C55E", key: "green" },
  { value: "#06B6D4", key: "cyan" },
  { value: "#2563EB", key: "blue" },
  { value: "#8B5CF6", key: "purple" },
  { value: "#EC4899", key: "pink" },
  { value: "#FFFFFF", key: "white" },
];
const penWidths = [1, 2, 3, 5, 8, 12, 18, 24];
const eraserSizes = [8, 12, 18, 24, 32, 48, 64];
const paletteGrid = "grid grid-cols-[2.25rem_2rem] justify-items-center gap-x-1 gap-y-0.5";
const paletteScroll = "max-h-[min(35dvh,12rem)] overflow-y-auto [scrollbar-width:thin]";

function ToolButton({
  active,
  color,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  color?: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "relative size-8",
        active && "bg-accent text-accent-foreground ring-2 ring-emerald-600/85 ring-inset dark:ring-emerald-400/85",
      )}
      onClick={onClick}
    >
      <Icon className="size-[18px]" />
      {color && (
        <span
          aria-hidden="true"
          className="ring-background absolute right-1 bottom-1 size-1.5 rounded-full ring-1"
          style={{ backgroundColor: color }}
        />
      )}
    </Button>
  );
}

export function HandwritingTools({ project }: { project: Project }) {
  const { t } = useTranslation("handwritingTools");
  const [pens, setPens] = useState<DrawingPen[]>(Settings.handwritingPens);
  const [activeTool, setActiveTool] = useState(Settings.handwritingActiveTool);
  const [erasers, setErasers] = useState(Settings.handwritingErasers);
  const [eraserId, setEraserId] = useState(getSelectedHandwritingEraser().id);
  const refreshPens = (value: DrawingPen[]) => setPens(value);
  const refreshActiveTool = (value: string) => setActiveTool(value);

  useEffect(() => {
    const unwatchPens = Settings.watch("handwritingPens", refreshPens);
    const unwatchTool = Settings.watch("handwritingActiveTool", refreshActiveTool);
    const unwatchErasers = Settings.watch("handwritingErasers", (value: HandwritingEraser[]) => {
      setErasers(value);
      setEraserId(getSelectedHandwritingEraser().id);
    });
    const unwatchEraserId = Settings.watch("handwritingEraserId", () => setEraserId(getSelectedHandwritingEraser().id));
    return () => {
      unwatchPens();
      unwatchTool();
      unwatchErasers();
      unwatchEraserId();
    };
  }, []);

  useEffect(() => {
    if (activeTool !== "eraser" && !pens.some((pen) => pen.id === activeTool) && pens[0]) {
      Settings.handwritingActiveTool = pens[0].id;
    }
  }, [activeTool, pens]);

  const updatePen = (penId: string, patch: Partial<DrawingPen>) => {
    Settings.handwritingPens = Settings.handwritingPens.map((pen) => (pen.id === penId ? { ...pen, ...patch } : pen));
  };

  const selectTool = (id: string) => {
    Settings.handwritingActiveTool = id;
    project.controller.setHandwritingMode(true);
  };

  const clonePen = (pen: DrawingPen) => {
    const clone = { ...pen, id: crypto.randomUUID() };
    Settings.handwritingPens = [...Settings.handwritingPens, clone];
    selectTool(clone.id);
  };

  const deletePen = (penId: string) => {
    if (Settings.handwritingPens.length <= 1) return;
    const remaining = Settings.handwritingPens.filter((pen) => pen.id !== penId);
    Settings.handwritingPens = remaining;
    if (Settings.handwritingActiveTool === penId) Settings.handwritingActiveTool = remaining[0].id;
  };

  const selectEraser = (id: string) => {
    Settings.handwritingEraserId = id;
    selectTool("eraser");
  };

  const updateEraser = (id: string, patch: Partial<Omit<HandwritingEraser, "id">>) => {
    Settings.handwritingErasers = Settings.handwritingErasers.map((eraser) =>
      eraser.id === id ? { ...eraser, ...patch } : eraser,
    );
  };

  const cloneEraser = (eraser: HandwritingEraser) => {
    const clone = { ...eraser, id: crypto.randomUUID() };
    Settings.handwritingErasers = [...Settings.handwritingErasers, clone];
    selectEraser(clone.id);
  };

  const deleteEraser = (id: string) => {
    if (Settings.handwritingErasers.length <= 1) return;
    const wasSelected = getSelectedHandwritingEraser().id === id;
    const remaining = Settings.handwritingErasers.filter((eraser) => eraser.id !== id);
    Settings.handwritingErasers = remaining;
    if (wasSelected) Settings.handwritingEraserId = remaining[0].id;
  };

  const clearAllStrokes = async () => {
    const confirmed = await Dialog.confirm(t("clearStrokesConfirmTitle"), t("clearStrokesConfirmBody"), {
      destructive: true,
    });
    if (!confirmed) return;
    const strokes = project.stageManager.getPenStrokes();
    if (strokes.length > 0) project.stageManager.deleteEntities(strokes);
  };

  return (
    <div className="shrink-0">
      <div role="group" aria-label={t("penSettings")} className={cn(paletteGrid, paletteScroll)}>
        {pens.map((pen, index) => (
          <ContextMenu key={pen.id}>
            <ContextMenuTrigger asChild>
              <div>
                <ToolButton
                  active={activeTool === pen.id}
                  color={pen.color}
                  icon={Pencil}
                  label={t("penLabel", { index: index + 1 })}
                  onClick={() => selectTool(pen.id)}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-48">
              <ContextMenuLabel>{t("penSettings")}</ContextMenuLabel>
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <span className="border-border size-3 rounded-full border" style={{ backgroundColor: pen.color }} />
                  {t("color")}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-48">
                  <ContextMenuLabel>{t("color")}</ContextMenuLabel>
                  <ContextMenuRadioGroup value={pen.color} onValueChange={(color) => updatePen(pen.id, { color })}>
                    {penColors.map(({ value, key }) => (
                      <ContextMenuRadioItem key={value} value={value}>
                        <span className="border-border size-3 rounded-full border" style={{ backgroundColor: value }} />
                        {t(`colors.${key}`)}
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                  <ContextMenuSeparator />
                  <label className="hover:bg-accent flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm">
                    <span>{t("customColor")}</span>
                    <input
                      aria-label={t("customColor")}
                      className="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
                      type="color"
                      value={pen.color.slice(0, 7)}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updatePen(pen.id, { color: event.target.value.toUpperCase() })}
                    />
                  </label>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSub>
                <ContextMenuSubTrigger>{t("width")}</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuLabel>{t("width")}</ContextMenuLabel>
                  <ContextMenuRadioGroup
                    value={String(pen.width)}
                    onValueChange={(width) => updatePen(pen.id, { width: Number(width) })}
                  >
                    {penWidths.map((width) => (
                      <ContextMenuRadioItem key={width} value={String(width)}>
                        {t("widthPixels", { width })}
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                  <ContextMenuSeparator />
                  <label className="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm">
                    <span>{t("customWidth")}</span>
                    <Input
                      aria-label={t("customWidth")}
                      className="h-7 w-20 text-right tabular-nums"
                      type="number"
                      min={1}
                      max={50}
                      step={0.5}
                      value={pen.width}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        const width = event.target.valueAsNumber;
                        if (Number.isFinite(width)) updatePen(pen.id, { width: Math.max(1, Math.min(width, 50)) });
                      }}
                    />
                  </label>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => clonePen(pen)}>
                <Copy className="size-4" />
                {t("clonePen")}
              </ContextMenuItem>
              <ContextMenuItem disabled={pens.length <= 1} variant="destructive" onSelect={() => deletePen(pen.id)}>
                <Trash2 className="size-4" />
                {pens.length <= 1 ? t("keepOnePen") : t("deletePen")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>

      <div
        role="group"
        aria-label={t("eraserSettings")}
        className={cn(paletteGrid, paletteScroll, "border-border mt-0.5 border-t pt-0.5")}
      >
        {erasers.map((eraser, index) => (
          <ContextMenu key={eraser.id}>
            <ContextMenuTrigger asChild>
              <div>
                <ToolButton
                  active={activeTool === "eraser" && eraserId === eraser.id}
                  icon={Eraser}
                  label={erasers.length === 1 ? t("eraser") : t("eraserLabel", { index: index + 1 })}
                  onClick={() => selectEraser(eraser.id)}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-48">
              <ContextMenuLabel>{t("eraserSettings")}</ContextMenuLabel>
              <ContextMenuSub>
                <ContextMenuSubTrigger>{t("width")}</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuLabel>{t("width")}</ContextMenuLabel>
                  <ContextMenuRadioGroup
                    value={String(eraser.size)}
                    onValueChange={(size) => updateEraser(eraser.id, { size: Number(size) })}
                  >
                    {eraserSizes.map((size) => (
                      <ContextMenuRadioItem key={size} value={String(size)}>
                        {t("widthPixels", { width: size })}
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSub>
                <ContextMenuSubTrigger>{t("eraserType")}</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuLabel>{t("eraserType")}</ContextMenuLabel>
                  <ContextMenuRadioGroup
                    value={eraser.type}
                    onValueChange={(type) => {
                      if (type === "stroke" || type === "point") updateEraser(eraser.id, { type });
                    }}
                  >
                    <ContextMenuRadioItem value="stroke">{t("strokeEraser")}</ContextMenuRadioItem>
                    <ContextMenuRadioItem value="point">{t("pointEraser")}</ContextMenuRadioItem>
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSub>
                <ContextMenuSubTrigger>{t("shape")}</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuLabel>{t("shape")}</ContextMenuLabel>
                  <ContextMenuRadioGroup
                    value={eraser.shape}
                    onValueChange={(shape) => {
                      if (shape === "circle" || shape === "square") updateEraser(eraser.id, { shape });
                    }}
                  >
                    <ContextMenuRadioItem value="circle">{t("circle")}</ContextMenuRadioItem>
                    <ContextMenuRadioItem value="square">{t("square")}</ContextMenuRadioItem>
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => cloneEraser(eraser)}>
                <Copy className="size-4" />
                {t("cloneEraser")}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={erasers.length <= 1}
                variant="destructive"
                onSelect={() => deleteEraser(eraser.id)}
              >
                <Trash2 className="size-4" />
                {erasers.length <= 1 ? t("keepOneEraser") : t("deleteEraser")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => void clearAllStrokes()}>
                <Trash2 className="size-4" />
                {t("clearStrokes")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
    </div>
  );
}
