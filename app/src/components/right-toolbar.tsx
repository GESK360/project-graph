import { Settings, settingsSchema } from "@/core/service/Settings";
import type { Project } from "@/core/Project";
import { QuickSettingsManager } from "@/core/service/QuickSettingsManager";
import { settingsIcons } from "@/core/service/SettingsIcons";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Toolbar } from "./ui/toolbar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Slider } from "./ui/slider";
import { Input } from "./ui/input";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { Fragment } from "react";
import { useAtom } from "jotai";
import { isClassroomModeAtom } from "@/state";
import { HandwritingTools } from "./handwriting-tools";
import { GitBranch, Hand, MouseLeft, MousePointer, MouseRight, Network, Pencil, Scissors } from "lucide-react";

const toggleIconClass = "opacity-50 transition-opacity hover:opacity-100 focus-visible:opacity-100";
const dragHandleClass = "touch-none cursor-grab active:cursor-grabbing";

function QuickSettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <div className="flex w-fit shrink-0 items-center gap-1">{children}</div>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

function PersistentBranchDragControl({
  settingKey,
  Icon,
}: {
  settingKey: "persistentDragToConnectMindMap" | "persistentDragToConnectMindMapAligned";
  Icon: typeof GitBranch;
}) {
  const { t } = useTranslation("settings");
  const [enabled] = Settings.use(settingKey);
  const title = t(`${settingKey}.title`);

  const toggle = () => {
    Settings[settingKey] = !Settings[settingKey];
  };

  return (
    <QuickSettingRow label={title}>
      <Button
        data-sidebar-drag-handle
        aria-label={title}
        aria-pressed={enabled}
        className={cn(toggleIconClass, dragHandleClass, enabled && "opacity-100")}
        variant="ghost"
        size="icon"
        onClick={toggle}
      >
        <Icon />
      </Button>
      <Switch aria-label={title} checked={enabled} onCheckedChange={toggle} />
    </QuickSettingRow>
  );
}

/**
 * Boolean 类型的快捷设置项
 */
function BooleanQuickSettingControl({
  settingKey,
  label,
}: {
  settingKey: keyof typeof settingsSchema.shape;
  label: string;
}) {
  const [value, setValue] = useState<boolean>(Settings[settingKey] as boolean);

  useEffect(() => {
    const unwatch = Settings.watch(settingKey, (newValue) => {
      if (typeof newValue === "boolean") setValue(newValue);
    });
    return unwatch;
  }, [settingKey]);

  const handleToggle = () => {
    const currentValue = Settings[settingKey];
    if (typeof currentValue === "boolean") {
      // @ts-expect-error 设置值
      Settings[settingKey] = !currentValue;
    }
  };

  return <Switch aria-label={label} checked={value} onCheckedChange={handleToggle} />;
}

/**
 * Enum 类型的快捷设置项（下拉菜单）
 */
function EnumQuickSettingControl({ settingKey }: { settingKey: keyof typeof settingsSchema.shape }) {
  const { t } = useTranslation("settings");
  const [value, setValue] = useState<string>(Settings[settingKey] as string);
  const options = QuickSettingsManager.getEnumOptions(settingKey as string);

  useEffect(() => {
    const unwatch = Settings.watch(settingKey, (newValue) => {
      if (typeof newValue === "string") setValue(newValue);
    });
    return unwatch;
  }, [settingKey]);

  const handleChange = (newValue: string) => {
    setValue(newValue);
    // @ts-expect-error 设置值
    Settings[settingKey] = newValue;
  };

  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger size="sm" className="h-7 w-28 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt} className="text-xs">
            {t(`${settingKey as string}.options.${opt}`, { defaultValue: opt })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Number 类型的快捷设置项（滑块 或 数字输入框）
 */
function NumberQuickSettingControl({ settingKey }: { settingKey: keyof typeof settingsSchema.shape }) {
  const [value, setValue] = useState<number>(Settings[settingKey] as number);
  const { min, max, step, hasRange } = QuickSettingsManager.getNumberRange(settingKey as string);

  useEffect(() => {
    const unwatch = Settings.watch(settingKey, (newValue) => {
      if (typeof newValue === "number") setValue(newValue);
    });
    return unwatch;
  }, [settingKey]);

  const handleChange = (newValue: number) => {
    setValue(newValue);
    // @ts-expect-error 设置值
    Settings[settingKey] = newValue;
  };

  if (hasRange && min !== null && max !== null) {
    // 有范围：展示 Slider + 数值 badge
    const displayValue = step >= 1 ? String(value) : value.toFixed(2);
    return (
      <div className="flex min-w-36 items-center gap-1.5 py-1 pr-1">
        <Slider
          value={[value]}
          onValueChange={([v]) => handleChange(v)}
          min={min}
          max={max}
          step={step}
          className="w-24 shrink-0"
        />
        <span className="text-muted-foreground flex-1 text-right text-xs tabular-nums">{displayValue}</span>
      </div>
    );
  }

  // 无范围：展示数字输入框
  return (
    <Input
      type="number"
      value={value}
      onChange={(e) => {
        const parsed = e.target.valueAsNumber;
        if (!Number.isNaN(parsed)) handleChange(parsed);
      }}
      className="h-7 w-20 text-xs"
    />
  );
}

/**
 * 单个快捷设置项按钮
 */
function QuickSettingButton({ settingKey }: { settingKey: keyof typeof settingsSchema.shape }) {
  const { t } = useTranslation("settings");
  const [showDialog, setShowDialog] = useState(false);
  const settingType = QuickSettingsManager.getSettingType(settingKey as string);

  // Boolean 类型用于图标 opacity 动态显示
  const [boolValue, setBoolValue] = useState<boolean>(
    settingType === "boolean" ? (Settings[settingKey] as boolean) : false,
  );

  useEffect(() => {
    if (settingType !== "boolean") return;
    const unwatch = Settings.watch(settingKey, (newValue) => {
      if (typeof newValue === "boolean") setBoolValue(newValue);
    });
    return unwatch;
  }, [settingKey, settingType]);

  const Icon = settingsIcons[settingKey as keyof typeof settingsIcons] ?? Fragment;
  const title = t(`${settingKey as string}.title` as string);
  const description = t(`${settingKey as string}.description` as string);

  if (Icon === Fragment) return null;

  // 图标 opacity：boolean 用 on/off 状态；enum/number 始终半透明
  const iconOpacityClass =
    settingType === "boolean"
      ? cn(toggleIconClass, boolValue && "opacity-100")
      : "opacity-70 transition-opacity hover:opacity-100";

  return (
    <>
      <QuickSettingRow label={title}>
        <Button
          data-sidebar-drag-handle
          aria-label={title}
          className={cn(iconOpacityClass, dragHandleClass)}
          variant="ghost"
          size="icon"
          onClick={() => setShowDialog(true)}
        >
          <Icon />
        </Button>
        {settingType === "boolean" && <BooleanQuickSettingControl settingKey={settingKey} label={title} />}
        {settingType === "enum" && <EnumQuickSettingControl settingKey={settingKey} />}
        {settingType === "number" && <NumberQuickSettingControl settingKey={settingKey} />}
      </QuickSettingRow>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className="h-5 w-5" />
              {title}
            </DialogTitle>
            <DialogDescription className="pt-2">{description}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MouseModeControls({ project }: { project: Project }) {
  const { t } = useTranslation("settings");
  const [leftMode] = Settings.use("mouseLeftMode");
  const [rightMode] = Settings.use("mouseRightDragBackground");
  const leftActions = [
    { value: "selectAndMove", Icon: MousePointer },
    { value: "draw", Icon: Pencil },
  ] as const;
  const rightActions = [
    { value: "cut", Icon: Scissors },
    { value: "moveCamera", Icon: Hand },
  ] as const;

  return (
    <div className="grid shrink-0 grid-cols-[2.25rem_2rem] gap-x-1">
      <div role="group" aria-label={t("mouseLeftMode.title")} className="flex flex-col">
        <Tooltip>
          <TooltipTrigger>
            <span className="text-muted-foreground flex h-6 items-center justify-center">
              <MouseLeft aria-hidden="true" className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">{t("mouseLeftMode.title")}</TooltipContent>
        </Tooltip>
        {leftActions.map(({ value, Icon }) => (
          <MouseModeButton
            key={value}
            label={t(`mouseLeftMode.options.${value}`)}
            active={leftMode === value}
            onClick={() => project.controller.setHandwritingMode(value === "draw")}
          >
            <Icon />
          </MouseModeButton>
        ))}
      </div>
      <div role="group" aria-label={t("mouseRightDragBackground.title")} className="flex flex-col">
        <Tooltip>
          <TooltipTrigger>
            <span className="text-muted-foreground flex h-6 items-center justify-center">
              <MouseRight aria-hidden="true" className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">{t("mouseRightDragBackground.title")}</TooltipContent>
        </Tooltip>
        {rightActions.map(({ value, Icon }) => (
          <MouseModeButton
            key={value}
            label={t(`mouseRightDragBackground.options.${value}`)}
            active={rightMode === value}
            onClick={() => {
              Settings.mouseRightDragBackground = value;
            }}
          >
            <Icon />
          </MouseModeButton>
        ))}
      </div>
    </div>
  );
}

function MouseModeButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={active}
          className={cn("h-8 w-full", active ? "bg-accent text-accent-foreground" : toggleIconClass)}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

type SidebarKey = QuickSettingsManager.QuickSettingItem["settingKey"];
type SidebarDrop = { key: SidebarKey; after: boolean };
type SidebarDrag = { key: SidebarKey; pointerId: number; startX: number; startY: number; moved: boolean };

export default function RightToolbar({
  project,
  showQuickSettingsToolbar,
}: {
  project: Project;
  showQuickSettingsToolbar: boolean;
}) {
  const [sidebarItems, setSidebarItems] = useState<QuickSettingsManager.QuickSettingItem[]>([]);
  const [isClassroomMode] = useAtom(isClassroomModeAtom);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [draggedKey, setDraggedKey] = useState<SidebarKey | null>(null);
  const [drop, setDrop] = useState<SidebarDrop | null>(null);
  const drag = useRef<SidebarDrag | null>(null);
  const suppressDragClick = useRef(false);
  const { t } = useTranslation("handwritingTools");
  const paletteLabel = t("palette", { defaultValue: "Drawing palette" });
  const items = sidebarItems.filter(
    ({ settingKey }) => showQuickSettingsToolbar || QuickSettingsManager.isBranchControl(settingKey),
  );

  useEffect(() => {
    const load = async () => setSidebarItems(await QuickSettingsManager.getSidebarItems());
    void load();
    const interval = setInterval(load, 5000);
    window.addEventListener("focus", load);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", load);
    };
  }, []);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current) return;
    suppressDragClick.current = false;
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const handle = event.target.closest("[data-sidebar-drag-handle]");
    const key = handle?.closest<HTMLElement>("[data-sidebar-item]")?.dataset.sidebarItem;
    const item = items.find(({ settingKey }) => settingKey === key);
    if (!handle || !item) return;
    handle.setPointerCapture(event.pointerId);
    drag.current = {
      key: item.settingKey,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
  }

  function findDrop(event: PointerEvent<HTMLDivElement>, source: SidebarKey): SidebarDrop | null {
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-sidebar-item]");
    if (!row || !event.currentTarget.contains(row)) return null;
    const item = items.find(({ settingKey }) => settingKey === row.dataset.sidebarItem);
    if (!item || item.settingKey === source) return null;
    const { top, height } = row.getBoundingClientRect();
    return { key: item.settingKey, after: event.clientY >= top + height / 2 };
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!active.moved) {
      if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) < 5) return;
      active.moved = true;
      setDraggedKey(active.key);
    }
    setDrop(findDrop(event, active.key));
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    setDraggedKey(null);
    setDrop(null);
    suppressDragClick.current = active.moved;
    if (!commit || !active.moved) return;
    const target = findDrop(event, active.key);
    if (target) void QuickSettingsManager.moveSidebarItem(active.key, target.key, target.after).then(setSidebarItems);
  }

  return (
    <div
      className={cn(
        "absolute top-[4.75rem] right-2 z-20 flex flex-col items-center transition-all hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
    >
      <Toolbar
        orientation="vertical"
        className="bg-popover/95 supports-backdrop-blur:bg-popover/80 border-border/50 max-h-[calc(100dvh-5.25rem)] flex-col items-stretch gap-0 rounded-lg border px-1 py-1.5 shadow-xl backdrop-blur-md"
      >
        <MouseModeControls project={project} />
        <div className="bg-border my-1 h-px shrink-0" />
        <QuickSettingRow label={paletteLabel}>
          <Button
            variant="ghost"
            size="icon"
            className={cn(toggleIconClass, paletteOpen && "opacity-100")}
            aria-label={paletteLabel}
            aria-expanded={paletteOpen}
            onClick={() => setPaletteOpen((open) => !open)}
          >
            <Pencil />
          </Button>
          <Switch aria-label={paletteLabel} checked={paletteOpen} onCheckedChange={setPaletteOpen} />
        </QuickSettingRow>
        {paletteOpen && <HandwritingTools project={project} />}
        <div className="bg-border my-1 h-px shrink-0" />
        <div
          className="min-h-0 overflow-y-auto [scrollbar-width:thin]"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={(event) => finishDrag(event, true)}
          onPointerCancel={(event) => finishDrag(event, false)}
          onLostPointerCapture={(event) => finishDrag(event, false)}
          onClickCapture={(event) => {
            if (!suppressDragClick.current || event.detail === 0) return;
            suppressDragClick.current = false;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {items.map(({ settingKey }) => (
            <div
              key={settingKey}
              data-sidebar-item={settingKey}
              className={cn("relative", draggedKey === settingKey && "opacity-40")}
            >
              {drop?.key === settingKey && (
                <div
                  className={cn(
                    "bg-primary pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full",
                    drop.after ? "bottom-0" : "top-0",
                  )}
                />
              )}
              {QuickSettingsManager.isBranchControl(settingKey) ? (
                <PersistentBranchDragControl
                  settingKey={settingKey}
                  Icon={settingKey === "persistentDragToConnectMindMap" ? GitBranch : Network}
                />
              ) : (
                <QuickSettingButton settingKey={settingKey} />
              )}
            </div>
          ))}
        </div>
      </Toolbar>
    </div>
  );
}
