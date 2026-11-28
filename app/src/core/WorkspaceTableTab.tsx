import StageTablePanel from "@/components/stage-table-panel";
import { Tab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import {
  createWorkspaceTableSource,
  type WorkspaceTableSource,
} from "@/core/service/dataManageService/stageTableService/WorkspaceTableSource";
import { store, tabsAtom } from "@/state";
import type { TableViewType } from "@/types/table";
import i18next from "i18next";
import { Table2 } from "lucide-react";
import React from "react";

/**
 * 入口 2：工作空间全屏多维表格 Tab（像 `.prg` 画布一样停靠在主编辑区）。
 *
 * 直接复用 `StageTablePanel` + `WorkspaceTableSource`，支持全部 6 种视图
 * （表格 / 看板 / 甘特 / 画册 / 日历 / 全局间隔重复）及视图级范围持久化。
 */
export class WorkspaceTableTab extends Tab {
  public readonly isWorkspaceTableTab = true;
  public readonly dataSource: WorkspaceTableSource;
  private readonly component: React.ComponentType;

  constructor(options?: { initialViewType?: TableViewType | null }) {
    super({});
    this.layout = "docked";
    this.canDock = true;
    this.closable = true;
    this.dataSource = createWorkspaceTableSource({
      initialViewType: options?.initialViewType ?? null,
    });
    const source = this.dataSource;
    this.component = function WorkspaceTableTabView() {
      return <StageTablePanel dataSource={source} />;
    };
  }

  override get title(): string {
    return i18next.t("workspaceTab.title", {
      ns: "stageTable",
      defaultValue: "工作空间多维表格",
    });
  }

  override get icon() {
    return Table2;
  }

  getComponent(): React.ComponentType {
    return this.component;
  }

  public focusOrCreateViewType(viewType: TableViewType): void {
    const existing = this.dataSource.getViews().find((v) => v.type === viewType);
    if (existing) {
      this.dataSource.setActiveView(existing.id);
    } else {
      const defaultName = i18next.t(`views.defaultName_${viewType}`, {
        ns: "stageTable",
        defaultValue: viewType === "spaced_repetition" ? "全局间隔重复" : "新视图",
      });
      this.dataSource.createView({ type: viewType, name: defaultName });
    }
  }

  override async dispose(): Promise<void> {
    this.dataSource.dispose();
    await super.dispose();
  }
}

/**
 * 打开或聚焦全局工作空间多维表格 Tab；
 * 若传入 `initialViewType`（例如 `"spaced_repetition"`），自动定位或新建对应视图。
 */
export function openWorkspaceTableTab(options?: { initialViewType?: TableViewType }): WorkspaceTableTab {
  const existing = store
    .get(tabsAtom)
    .find((tab): tab is WorkspaceTableTab => tab instanceof WorkspaceTableTab && !tab.closing);

  if (existing) {
    TabWorkspace.focus(existing.id);
    if (options?.initialViewType) {
      existing.focusOrCreateViewType(options.initialViewType);
    }
    return existing;
  }

  const tab = new WorkspaceTableTab({ initialViewType: options?.initialViewType ?? null });
  TabWorkspace.open(tab);
  return tab;
}
