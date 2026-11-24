import { getSelectedHandwritingPen, Settings } from "@/core/service/Settings";
import { Button } from "./ui/button";
import { Toolbar } from "./ui/toolbar";
import { MousePointer, Pencil, Waypoints } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { cn } from "@/utils/cn";
import { ColorManager } from "@/core/service/feedbackService/ColorManager";
import { Color } from "@graphif/data-structures";
import { useAtom } from "jotai";
import { isClassroomModeAtom } from "@/state";

/**
 * 底部工具栏
 * @returns
 */
export default function ToolbarContent() {
  const { t } = useTranslation("keyBinds");
  const [isClassroomMode] = useAtom(isClassroomModeAtom);

  const [leftMouseMode, setLeftMouseMode] = useState(Settings.mouseLeftMode);
  useEffect(() => {
    setLeftMouseMode(Settings.mouseLeftMode);
  }, [Settings.mouseLeftMode]);

  return (
    <div
      className={cn(
        "absolute bottom-0 left-1/2 flex -translate-x-1/2 transform flex-col items-center justify-center transition-all hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
    >
      <Toolbar className="bg-popover/95 supports-backdrop-blur:bg-popover/80 border-border/50 rounded-t-lg border-t px-2 py-1.5 shadow-xl backdrop-blur-md">
        <Tooltip>
          <TooltipTrigger>
            <Button
              className={cn("opacity-50", leftMouseMode === "selectAndMove" && "opacity-100")}
              variant="ghost"
              size="icon"
              onClick={() => {
                setLeftMouseMode("connectAndCut");
                Settings.mouseLeftMode = "selectAndMove";
              }}
            >
              <MousePointer />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("checkoutLeftMouseToSelectAndMove.title")}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger>
            <Button
              className={cn("opacity-50", leftMouseMode === "draw" && "opacity-100")}
              variant="ghost"
              size="icon"
              onClick={() => {
                setLeftMouseMode("draw");
                Settings.mouseLeftMode = "draw";
              }}
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("checkoutLeftMouseToDrawing.title")}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger>
            <Button
              className={cn("opacity-50", leftMouseMode === "connectAndCut" && "opacity-100")}
              variant="ghost"
              size="icon"
              onClick={() => {
                setLeftMouseMode("connectAndCut");
                Settings.mouseLeftMode = "connectAndCut";
              }}
            >
              <Waypoints />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("checkoutLeftMouseToConnectAndCutting.title")}</TooltipContent>
        </Tooltip>
      </Toolbar>
      {leftMouseMode === "draw" && (
        <div>
          <DrawingColorLine />
        </div>
      )}
    </div>
  );
}

const DrawingColorLine: React.FC = () => {
  const [userColorList, setUserColorList] = useState<Color[]>([]);
  const [currentDrawColor, setCurrentDrawColor] = useState<Color>(Color.Transparent);

  useEffect(() => {
    const refreshCurrentColor = () => {
      const activePen =
        Settings.handwritingPens.find((pen) => pen.id === Settings.handwritingActiveTool) ??
        getSelectedHandwritingPen();
      setCurrentDrawColor(activePen ? Color.fromCss(activePen.color) : new Color(...Settings.autoFillPenStrokeColor));
    };
    ColorManager.getUserEntityFillColors().then(setUserColorList);
    const unwatchPens = Settings.watch("handwritingPens", refreshCurrentColor);
    const unwatchTool = Settings.watch("handwritingActiveTool", refreshCurrentColor);
    const unwatchPenId = Settings.watch("handwritingPenId", refreshCurrentColor);
    refreshCurrentColor();
    return () => {
      unwatchPens();
      unwatchTool();
      unwatchPenId();
    };
  }, []);

  const handleChangeColor = (color: Color) => {
    Settings.autoFillPenStrokeColor = color.toArray();
    Settings.autoFillPenStrokeColorEnable = true;
    const activeTool = Settings.handwritingActiveTool;
    const activePenId = activeTool === "eraser" ? getSelectedHandwritingPen().id : activeTool;
    if (activePenId) {
      Settings.handwritingPens = Settings.handwritingPens.map((pen) =>
        pen.id === activePenId ? { ...pen, color: color.toHexStringWithoutAlpha().toUpperCase() } : pen,
      );
    }
    setCurrentDrawColor(color.clone());
  };

  return (
    <div className="flex max-w-64 overflow-x-auto">
      {userColorList.map((color) => (
        <div
          className={cn(
            "outline-accent-foreground size-4 cursor-pointer hover:outline-3 hover:-outline-offset-3",
            currentDrawColor.equals(color) && "outline-2 -outline-offset-2",
          )}
          key={color.toString()}
          style={{ backgroundColor: `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})` }}
          onClick={() => handleChangeColor(color)}
        />
      ))}
    </div>
  );
};
