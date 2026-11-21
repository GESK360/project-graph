import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import { AppWindowMac, Columns2, Dock, PanelLeftClose, PanelRightClose, Pin, PinOff, Rows2, X } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

const bulkCloseActions = [
  { direction: "left", label: "closeLeft", Icon: PanelLeftClose },
  { direction: "others", label: "closeOthers", Icon: X },
  { direction: "right", label: "closeRight", Icon: PanelRightClose },
] as const;

export default function TabContextMenu({
  tab,
  children,
  onClose,
}: {
  tab: Tab;
  children: React.ReactElement;
  onClose?: (tab: Tab) => void | boolean | Promise<void | boolean>;
}) {
  const { t } = useTranslation("tabMenu");
  const close = (target: Tab) => (onClose ? onClose(target) : TabWorkspace.close(target.id));
  const closeTabs = async (direction: (typeof bulkCloseActions)[number]["direction"]) => {
    for (const target of TabWorkspace.getTabsToClose(tab.id, direction)) {
      if (TabWorkspace.canCloseInBulk(target) && (await close(target)) === false) break;
    }
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {tab.layout === "docked" ? (
          <>
            <ContextMenuItem onSelect={() => TabWorkspace.togglePinned(tab.id)}>
              {tab.pinned ? <PinOff /> : <Pin />}
              {t(tab.pinned ? "unpin" : "pin")}
            </ContextMenuItem>
            <div className="grid grid-cols-3" role="group" aria-label={t("bulkClose")}>
              {bulkCloseActions.map(({ direction, label, Icon }) => (
                <Tooltip key={direction}>
                  <TooltipTrigger>
                    <ContextMenuItem
                      className="justify-center"
                      aria-label={t(label)}
                      onSelect={() => void closeTabs(direction)}
                    >
                      <Icon />
                    </ContextMenuItem>
                  </TooltipTrigger>
                  <TooltipContent>{t(label)}</TooltipContent>
                </Tooltip>
              ))}
            </div>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => TabWorkspace.split(tab.id, "right")}>
              <Columns2 />
              向右拆分
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => TabWorkspace.split(tab.id, "bottom")}>
              <Rows2 />
              向下拆分
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => TabWorkspace.float(tab.id)}>
              <AppWindowMac />
              浮动
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem disabled={!tab.canDock} onSelect={() => TabWorkspace.dock(tab.id)}>
            <Dock />
            停靠
          </ContextMenuItem>
        )}
        {tab.closable && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={tab.closing}
              onSelect={() => void close(tab)}
            >
              <X />
              关闭
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
