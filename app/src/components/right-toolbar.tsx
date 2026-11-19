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
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { Fragment } from "react";
import { useAtom } from "jotai";
import { isClassroomModeAtom } from "@/state";
import { HandwritingTools } from "./handwriting-tools";
import { Pencil } from "lucide-react";

const toggleIconClass = "opacity-50 transition-opacity hover:opacity-100 focus-visible:opacity-100";

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

/**
 * Boolean 类型的快捷设置项
 */
function BooleanQuickSettingControl({ settingKey }: { settingKey: keyof typeof settingsSchema.shape }) {
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

  return <Switch checked={value} onCheckedChange={handleToggle} />;
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
        <Button className={iconOpacityClass} variant="ghost" size="icon" onClick={() => setShowDialog(true)}>
          <Icon />
        </Button>
        {settingType === "boolean" && <BooleanQuickSettingControl settingKey={settingKey} />}
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

/**
 * 右侧工具栏
 * 显示用户自定义的快捷设置项（支持开关、下拉菜单、数值调整）
 */
export default function RightToolbar({
  project,
  showQuickSettingsToolbar,
}: {
  project: Project;
  showQuickSettingsToolbar: boolean;
}) {
  const [quickSettings, setQuickSettings] = useState<QuickSettingsManager.QuickSettingItem[]>([]);
  const [isClassroomMode] = useAtom(isClassroomModeAtom);
  const [isHandwritingEnabled, setIsHandwritingEnabled] = useState(Settings.mouseLeftMode === "draw");
  const { t } = useTranslation("handwritingTools");
  const drawingLabel = t("title");
  const setDrawingMode = (enabled: boolean) => project.controller.setHandwritingMode(enabled);

  useEffect(() => Settings.watch("mouseLeftMode", (mode) => setIsHandwritingEnabled(mode === "draw")), []);

  const loadQuickSettings = async () => {
    const items = await QuickSettingsManager.getQuickSettings();
    setQuickSettings(items);
  };

  useEffect(() => {
    loadQuickSettings();
    const interval = setInterval(() => {
      loadQuickSettings();
    }, 5000);
    const handleFocus = () => {
      loadQuickSettings();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  return (
    <div
      className={cn(
        "absolute top-[4.75rem] right-2 z-20 flex flex-col items-center transition-all hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
    >
      <Toolbar
        orientation="vertical"
        className="bg-popover/95 supports-backdrop-blur:bg-popover/80 border-border/50 max-h-[calc(100dvh-5.25rem)] flex-col items-stretch gap-0 overflow-y-auto rounded-lg border px-1 py-1.5 shadow-xl backdrop-blur-md [scrollbar-width:thin]"
      >
        <QuickSettingRow label={drawingLabel}>
          <Button
            variant="ghost"
            size="icon"
            className={cn(toggleIconClass, isHandwritingEnabled && "opacity-100")}
            aria-label={drawingLabel}
            aria-pressed={isHandwritingEnabled}
            onClick={() => setDrawingMode(!isHandwritingEnabled)}
          >
            <Pencil />
          </Button>
          <Switch aria-label={drawingLabel} checked={isHandwritingEnabled} onCheckedChange={setDrawingMode} />
        </QuickSettingRow>
        {isHandwritingEnabled && (
          <div className="shrink-0 self-center">
            <HandwritingTools project={project} />
          </div>
        )}
        {showQuickSettingsToolbar && quickSettings.length > 0 && (
          <>
            <div className="bg-border my-1 h-px w-full shrink-0" />
            {quickSettings.map((item) => (
              <QuickSettingButton key={item.settingKey} settingKey={item.settingKey} />
            ))}
          </>
        )}
      </Toolbar>
    </div>
  );
}
