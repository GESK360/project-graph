import { ProjectTabs } from "@/ProjectTabs";
import { Project, ProjectState } from "@/core/Project";
import { Tab } from "@/core/Tab";
import { FIXED_SIDE_GROUP_IDS, TabGroupNode } from "@/core/TabGroup";
import { TabWorkspace } from "@/core/TabWorkspace";
import {
  activeDockedTabAtom,
  activeGroupIdAtom,
  activeResourceTabAtom,
  activeTabAtom,
  stageTableOpenAtom,
  store,
  tabDropTargetAtom,
  tabGroupRootAtom,
  tabsAtom,
} from "@/state";
import { cn } from "@/utils/cn";
import { useAtom, useAtomValue } from "jotai";
import { ChevronLeft, ChevronRight } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import StageTablePanel from "./stage-table-panel";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const WORKSPACE_WIDTH_KEY = "workspace:sidebar-width";
const DEFAULT_WORKSPACE_WIDTH = 260;
const MIN_WORKSPACE_WIDTH = 160;
const MAX_WORKSPACE_WIDTH = 480;

const STAGE_TABLE_WIDTH_KEY = "stage-table:sidebar-width";
const DEFAULT_STAGE_TABLE_WIDTH = 480;
const MIN_STAGE_TABLE_WIDTH = 320;
const MAX_STAGE_TABLE_WIDTH = 960;

function clampWorkspaceWidth(width: number) {
  return Math.max(MIN_WORKSPACE_WIDTH, Math.min(MAX_WORKSPACE_WIDTH, Math.round(width)));
}

function clampStageTableWidth(width: number, hostWidth?: number) {
  const dynamicMax =
    hostWidth && hostWidth > 0 ? Math.max(MIN_STAGE_TABLE_WIDTH, Math.round(hostWidth * 0.75)) : MAX_STAGE_TABLE_WIDTH;
  return Math.max(MIN_STAGE_TABLE_WIDTH, Math.min(MAX_STAGE_TABLE_WIDTH, dynamicMax, Math.round(width)));
}

function ProjectStatus({ project, isClassroomMode }: { project: Project; isClassroomMode: boolean }) {
  const { t } = useTranslation("projectStatus");
  const [text, setText] = useState("");
  const [viewHint, setViewHint] = useState("");

  useEffect(() => {
    const update = () => {
      const manager = project.stageManager;
      const entities = manager.getEntities();
      const view = project.renderer.getCoverWorldRectangle();
      const hasVisibleNode = entities.some((entity) => {
        if (entity.isHiddenBySectionCollapse) return false;
        const rect = entity.collisionBox.getRectangle();
        return view.isCollideWith(rect) && Math.max(rect.width, rect.height) * project.camera.currentScale >= 1;
      });
      setViewHint(entities.length === 0 ? t("emptyCanvas") : hasVisibleNode ? "" : t("noVisibleNodes"));
      const state = {
        [ProjectState.Saved]: "saved",
        [ProjectState.Stashed]: "stashed",
        [ProjectState.Unsaved]: "unsaved",
      }[project.projectState];
      setText(
        `${t("nodes", { count: manager.getEntities().length })} · ${t("edges", { count: manager.getAssociations().length })} · ${t("selected", { count: manager.getSelectedStageObjects().length })}  |  ${Math.round(project.camera.currentScale * 100)}%  |  ${t(state)}`,
      );
    };
    update();
    const interval = window.setInterval(update, 250);
    return () => window.clearInterval(interval);
  }, [project, t]);

  return (
    <div
      className={cn(
        "bg-background text-muted-foreground absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full px-3 py-1.5 text-xs shadow-xs transition-opacity hover:opacity-100",
        isClassroomMode && "opacity-0",
      )}
    >
      <span className="truncate">{viewHint || text}</span>
      <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => project.camera.reset()}>
        {t("fitView")}
      </Button>
    </div>
  );
}

function SplitView({
  node,
  renderNode,
  workspaceWidth,
  resizeWorkspace,
}: {
  node: Extract<TabGroupNode, { type: "split" }>;
  renderNode: (node: TabGroupNode) => React.ReactNode;
  workspaceWidth: number;
  resizeWorkspace: (width: number) => void;
}) {
  const { t } = useTranslation("workspace");
  const horizontal = node.direction === "horizontal";
  const workspaceIndex = horizontal
    ? node.children.findIndex((child) => child.id === FIXED_SIDE_GROUP_IDS.workspace)
    : -1;
  const drag = useRef<{ id: number; startX: number; width: number; rect: DOMRect } | null>(null);

  function renderPanel(index: 0 | 1) {
    let flex = "1 1 0%";
    if (workspaceIndex === index) flex = `0 0 ${workspaceWidth}px`;
    else if (workspaceIndex < 0 && index === 0) flex = `0 1 ${node.sizes[0]}%`;
    return (
      <div className="min-h-0 min-w-0" style={{ flex }}>
        {renderNode(node.children[index])}
      </div>
    );
  }

  return (
    <div className={cn("flex size-full min-h-0 min-w-0", horizontal ? "flex-row" : "flex-col")}>
      {renderPanel(0)}
      <div
        className={cn(
          "bg-background z-20 shrink-0 touch-none",
          horizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
        )}
        role={workspaceIndex >= 0 ? "separator" : undefined}
        tabIndex={workspaceIndex >= 0 ? 0 : undefined}
        aria-label={workspaceIndex >= 0 ? t("title") : undefined}
        aria-orientation={workspaceIndex >= 0 ? "vertical" : undefined}
        aria-valuemin={workspaceIndex >= 0 ? MIN_WORKSPACE_WIDTH : undefined}
        aria-valuemax={workspaceIndex >= 0 ? MAX_WORKSPACE_WIDTH : undefined}
        aria-valuenow={workspaceIndex >= 0 ? workspaceWidth : undefined}
        onKeyDown={(event) => {
          if (workspaceIndex < 0 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          event.stopPropagation();
          const delta = event.key === "ArrowLeft" ? -10 : 10;
          resizeWorkspace(workspaceWidth + (workspaceIndex === 0 ? delta : -delta));
        }}
        onPointerDown={(event) => {
          const handle = event.currentTarget;
          if (event.button !== 0 || drag.current || !handle.parentElement) return;
          handle.setPointerCapture(event.pointerId);
          drag.current = {
            id: event.pointerId,
            startX: event.clientX,
            width: workspaceWidth,
            rect: handle.parentElement.getBoundingClientRect(),
          };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          if (workspaceIndex >= 0) {
            const delta = event.clientX - start.startX;
            resizeWorkspace(start.width + (workspaceIndex === 0 ? delta : -delta));
            return;
          }
          const total = horizontal ? start.rect.width : start.rect.height;
          if (total <= 0) return;
          const position = horizontal ? event.clientX - start.rect.left : event.clientY - start.rect.top;
          const first = Math.max(10, Math.min(90, (position / total) * 100));
          TabWorkspace.resizeSplit(node.id, [first, 100 - first]);
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.id === event.pointerId) drag.current = null;
        }}
      >
        <div className="bg-border hover:bg-primary size-full cursor-[inherit] transition-colors" />
      </div>
      {renderPanel(1)}
    </div>
  );
}

function DropPreview({ groupId }: { groupId: string }) {
  const target = useAtomValue(tabDropTargetAtom);
  if (target?.groupId !== groupId) return null;
  if (target.edge) {
    const edgeClass = {
      left: "top-0 bottom-0 left-0 w-1/2",
      right: "top-0 right-0 bottom-0 w-1/2",
      top: "top-0 right-0 left-0 h-1/2",
      bottom: "right-0 bottom-0 left-0 h-1/2",
    }[target.edge];
    return <div className={cn("bg-primary/25 border-primary pointer-events-none absolute z-30 border-2", edgeClass)} />;
  }

  const group = Array.from(document.querySelectorAll<HTMLElement>("[data-pg-tab-group-id]")).find(
    (candidate) => candidate.dataset.pgTabGroupId === groupId,
  );
  const tabBar = group?.querySelector<HTMLElement>("[data-pg-tab-bar]");
  if (!group || !tabBar) return null;
  const tabs = Array.from(tabBar.querySelectorAll<HTMLElement>("[data-pg-docked-tab-id]"));
  const groupRect = group.getBoundingClientRect();
  const tabBarRect = tabBar.getBoundingClientRect();
  const nextTab = tabs[target.index ?? tabs.length];
  const previousTab = tabs[Math.min((target.index ?? tabs.length) - 1, tabs.length - 1)];
  const left = nextTab
    ? nextTab.getBoundingClientRect().left - groupRect.left
    : previousTab
      ? previousTab.getBoundingClientRect().right - groupRect.left
      : tabBarRect.left - groupRect.left;

  return (
    <div
      className="bg-primary pointer-events-none absolute z-30 w-0.5"
      style={{ left, top: tabBarRect.top - groupRect.top, height: tabBarRect.height }}
    />
  );
}

export default function DockedArea({
  onTabClick,
  onTabClose,
  onTitleBarMouseDown,
  isClassroomMode,
}: {
  onTabClick: (tab: Tab) => void;
  onTabClose: (tab: Tab) => void | boolean | Promise<void | boolean>;
  onTitleBarMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isClassroomMode: boolean;
}) {
  const { t: tTable } = useTranslation("stageTable");
  const root = useAtomValue(tabGroupRootAtom);
  const tabs = useAtomValue(tabsAtom);
  const activeGroupId = useAtomValue(activeGroupIdAtom);
  const activeResourceTab = useAtomValue(activeResourceTabAtom);
  const activeDockedTab = useAtomValue(activeDockedTabAtom);
  const [stageTableOpen, setStageTableOpen] = useAtom(stageTableOpenAtom);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageTableDragRef = useRef<{ id: number; startX: number; width: number; hostWidth: number } | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WORKSPACE_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampWorkspaceWidth(saved) : DEFAULT_WORKSPACE_WIDTH;
  });
  const [stageTableWidth, setStageTableWidth] = useState(() => {
    const saved = Number(localStorage.getItem(STAGE_TABLE_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampStageTableWidth(saved) : DEFAULT_STAGE_TABLE_WIDTH;
  });

  const activeProject = activeResourceTab instanceof Project ? activeResourceTab : undefined;
  const isWorkspaceTableFocused = Boolean(activeDockedTab && "isWorkspaceTableTab" in activeDockedTab);
  const showStageTable = Boolean(activeProject && stageTableOpen && !isClassroomMode && !isWorkspaceTableFocused);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_WIDTH_KEY, String(workspaceWidth));
  }, [workspaceWidth]);

  useEffect(() => {
    localStorage.setItem(STAGE_TABLE_WIDTH_KEY, String(stageTableWidth));
  }, [stageTableWidth]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const tabSpace = document.querySelector<HTMLElement>("[data-pg-titlebar-tab-space]");
    if (!container || !tabSpace) return;
    const topBars = container.querySelectorAll<HTMLElement>("[data-pg-window-top-tabs]");
    const update = () => {
      const space = tabSpace.getBoundingClientRect();
      const minimumWidth = 96 * (Number(getComputedStyle(container).getPropertyValue("--pg-ui-scale")) || 1);
      for (const bar of topBars) {
        const rect = bar.getBoundingClientRect();
        const left = Math.min(rect.right, Math.max(rect.left, space.left));
        const right = Math.max(left, Math.min(rect.right, space.right));
        const separateRow = right - left < Math.min(rect.width, minimumWidth);
        bar.toggleAttribute("data-pg-tabs-separate-row", separateRow);
        bar.style.paddingLeft = separateRow ? "" : `${left - rect.left}px`;
        bar.style.paddingRight = separateRow ? "" : `${rect.right - right}px`;
      }
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(tabSpace);
    update();
    return () => observer.disconnect();
  }, [root, showStageTable, stageTableWidth]);

  const renderNode = (node: TabGroupNode, atWindowTop = true): React.ReactNode => {
    if (node.type === "split") {
      return (
        <SplitView
          key={node.id}
          node={node}
          workspaceWidth={workspaceWidth}
          resizeWorkspace={(width) => setWorkspaceWidth(clampWorkspaceWidth(width))}
          renderNode={(child) =>
            renderNode(child, atWindowTop && (node.direction === "horizontal" || child === node.children[0]))
          }
        />
      );
    }
    const groupTabs = node.tabIds.flatMap((id) => {
      const tab = tabs.find((candidate) => candidate.id === id && candidate.layout === "docked");
      return tab ? [tab] : [];
    });
    const activeTab = groupTabs.find((tab) => tab.id === node.activeTabId) ?? groupTabs.at(-1);
    return (
      <section
        key={node.id}
        data-pg-tab-group-id={node.id}
        className={cn(
          "group/docked-panel relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden",
          activeTab &&
            !(activeTab instanceof Project) &&
            "bg-background has-[[data-pg-settings-view]]:bg-transparent has-[[data-pg-workspace-view]]:bg-transparent",
          root?.type === "split" && "border-background outline-border border outline-1 -outline-offset-1",
          root?.type === "split" && activeGroupId === node.id && "outline-primary/60",
        )}
        onPointerDownCapture={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          if (activeTab && store.get(activeTabAtom) !== activeTab) TabWorkspace.focus(activeTab.id);
        }}
      >
        <div
          data-pg-window-top-tabs={atWindowTop ? "" : undefined}
          className={cn(
            "group-has-[[data-pg-workspace-view]]/docked-panel:bg-background pointer-events-none relative z-10 flex shrink-0 flex-col",
            atWindowTop &&
              "group [&_[data-pg-tab-bar]]:cursor-inherit pointer-events-auto h-[var(--pg-titlebar-band-h)] cursor-grab active:cursor-grabbing data-[pg-tabs-separate-row]:h-auto",
          )}
          onMouseDown={(event) => {
            // React portals bubble here even when the menu is outside the title bar in the DOM.
            if (!event.currentTarget.contains(event.target as Node)) return;
            if (atWindowTop && !(event.target as Element).closest("[data-pg-docked-tab-id]")) {
              onTitleBarMouseDown(event);
            }
          }}
        >
          {atWindowTop && (
            <div
              aria-hidden="true"
              className="h-[var(--pg-titlebar-offset-h)] shrink-0 group-data-[pg-tabs-separate-row]:h-[var(--pg-titlebar-band-h)]"
            />
          )}
          <div className={cn("flex min-w-0 items-center", atWindowTop && "h-[var(--pg-titlebar-tab-row-h)] shrink-0")}>
            <div
              data-pg-tab-bar-drop-zone
              className="cursor-inherit min-w-0 flex-1"
              style={{ zoom: "var(--pg-ui-scale, 1)" }}
            >
              <ProjectTabs
                groupId={node.id}
                tabs={groupTabs}
                activeTab={activeTab}
                onTabClick={onTabClick}
                onTabClose={onTabClose}
                isClassroomMode={isClassroomMode}
              />
            </div>
          </div>
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-hidden",
            activeTab instanceof Project ? "absolute inset-0" : "relative flex-1",
          )}
        >
          {activeTab && React.createElement(activeTab.getComponent())}
          {activeTab instanceof Project && (
            <ProjectStatus key={activeTab.id} project={activeTab} isClassroomMode={isClassroomMode} />
          )}
        </div>
        <DropPreview groupId={node.id} />
      </section>
    );
  };

  return (
    <div ref={containerRef} className="absolute inset-0 flex min-h-0 min-w-0 flex-row overflow-hidden">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {root && renderNode(root)}
        {activeProject && !isClassroomMode && !isWorkspaceTableFocused && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-stage-table-toggle
                aria-label={stageTableOpen ? tTable("collapsePanel") : tTable("expandPanel")}
                onClick={() => setStageTableOpen((prev) => !prev)}
                className="bg-popover/95 hover:bg-accent text-foreground border-border/70 absolute top-1/2 right-0 z-30 flex h-14 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-l-xl border border-r-0 shadow-md transition-colors"
              >
                {stageTableOpen ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {stageTableOpen ? tTable("collapsePanel") : tTable("expandPanel")}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {showStageTable && activeProject && (
        <>
          <div
            className="bg-background z-20 w-1 shrink-0 cursor-col-resize touch-none"
            role="separator"
            tabIndex={0}
            aria-label={tTable("expandPanel")}
            aria-orientation="vertical"
            aria-valuemin={MIN_STAGE_TABLE_WIDTH}
            aria-valuemax={MAX_STAGE_TABLE_WIDTH}
            aria-valuenow={stageTableWidth}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              const delta = event.key === "ArrowLeft" ? 16 : -16;
              setStageTableWidth((prev) => clampStageTableWidth(prev + delta, containerRef.current?.clientWidth));
            }}
            onPointerDown={(event) => {
              const handle = event.currentTarget;
              if (event.button !== 0 || stageTableDragRef.current) return;
              handle.setPointerCapture(event.pointerId);
              stageTableDragRef.current = {
                id: event.pointerId,
                startX: event.clientX,
                width: stageTableWidth,
                hostWidth: containerRef.current?.clientWidth ?? window.innerWidth,
              };
            }}
            onPointerMove={(event) => {
              const start = stageTableDragRef.current;
              if (!start || start.id !== event.pointerId) return;
              const delta = start.startX - event.clientX;
              setStageTableWidth(clampStageTableWidth(start.width + delta, start.hostWidth));
            }}
            onLostPointerCapture={(event) => {
              if (stageTableDragRef.current?.id === event.pointerId) {
                stageTableDragRef.current = null;
              }
            }}
          >
            <div className="bg-border hover:bg-primary size-full cursor-[inherit] transition-colors" />
          </div>

          <aside
            data-stage-table-docked-pane
            style={{ flex: `0 0 ${stageTableWidth}px` }}
            className="bg-background border-background outline-border relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden border outline-1 -outline-offset-1"
          >
            <div
              aria-hidden="true"
              className="border-border/60 bg-background h-[var(--pg-titlebar-band-h)] shrink-0 cursor-grab border-b active:cursor-grabbing"
              onMouseDown={onTitleBarMouseDown}
            />
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
              <StageTablePanel project={activeProject} />
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
