import { Project, ProjectState } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { activeResourceTabAtom, store } from "@/state";
import i18next from "i18next";
import { toast } from "sonner";
import { WorkspaceManager } from "./WorkspaceManager";

let installed = false;
/** 保存任务串行执行：切换很快时不能并发写同一个工程 */
let queue: Promise<void> = Promise.resolve();

async function persistBeforeSwitchingAway(project: Project): Promise<void> {
  if (!Settings.autoSaveOnSwitch) return;
  if (project.isDraft || project.isCollab || project.closing) return;
  if (project.projectState !== ProjectState.Unsaved) return;
  try {
    await project.save({ includeThumbnail: false });
  } catch (error) {
    toast.error(i18next.t("workspace.autoSaveFailed", { defaultValue: String(error) }));
    return;
  }
  if (!Settings.workspaceVersionHistory) return;
  try {
    await WorkspaceManager.snapshotPage(project.uri.fsPath);
  } catch (error) {
    toast.error(i18next.t("workspace.versionSnapshotFailed", { defaultValue: String(error) }));
  }
}

function enqueue(project: Project): void {
  queue = queue.then(() => persistBeforeSwitchingAway(project));
}

export const AutoSaveOnSwitch = {
  /** 幂等；在 main.tsx 启动阶段调用一次 */
  install(): void {
    if (installed) return;
    installed = true;
    let previous = store.get(activeResourceTabAtom);
    store.sub(activeResourceTabAtom, () => {
      const next = store.get(activeResourceTabAtom);
      if (next === previous) return;
      const switchedAwayFrom = previous;
      previous = next;
      if (!(switchedAwayFrom instanceof Project)) return;
      enqueue(switchedAwayFrom);
    });
  },
};
