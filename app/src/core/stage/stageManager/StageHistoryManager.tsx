import { Project, ProjectState, service } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { toast } from "sonner";

/**
 * 行级增量历史管理器（M2 重构版）：
 * 彻底移除全图 `serialize(project.stage)` 与双模式快照栈，
 * 统一委托给 `project.docCommandBus`（桌面 SQLite 写入 `history_ops`，非 Tauri 单测走同步行级日志）。
 */
@service("historyManager")
export class HistoryManager {
  constructor(private readonly project: Project) {
    if (!this.project.isSqliteV3 || this.project.docCommandBus?.hasPendingDirty()) {
      this.project.docCommandBus?.resetBaseline();
    }
  }

  public dispose(): void {
    // 生命周期由 Project.dispose 统一释放 docCommandBus
  }

  /**
   * 将当前脏追踪集编译为最小 `DocCommand` 批处理并记入行级历史。
   */
  public recordStep(label = ""): void {
    const committed = this.project.docCommandBus?.commitDirtyStep({ label }) ?? false;
    if (!committed && (!this.project.isSqliteV3 || this.project.isDraft)) {
      this.project.projectState = ProjectState.Unsaved;
    }
    if (this.project.getService?.("stageTable")) {
      this.project.stageTable.notifyChange({ emitSync: false });
    }
    this.project.emit("stage-commit");
  }

  /**
   * 撤销一步（SQLite 文档走 Rust `doc_undo` 事务回滚；非 Tauri 单测走同步行级补丁）。
   */
  public undo(): void {
    if (!this.project.docCommandBus) return;
    void this.project.docCommandBus.undo();
    if (Settings.showDebug) {
      const state = this.project.docCommandBus.getHistoryState();
      toast(`已撤销（位置 ${state.undoCursor} / 长度 ${state.totalEntries}）`);
    }
  }

  /**
   * 重做一步（SQLite 文档走 Rust `doc_redo` 事务前进；非 Tauri 单测走同步行级补丁）。
   */
  public redo(): void {
    if (!this.project.docCommandBus) return;
    void this.project.docCommandBus.redo();
    if (Settings.showDebug) {
      const state = this.project.docCommandBus.getHistoryState();
      toast(`已重做（位置 ${state.undoCursor} / 长度 ${state.totalEntries}）`);
    }
  }

  /**
   * 清空历史并重建增量基线。
   */
  public clearHistory(): void {
    this.project.docCommandBus?.resetBaseline({ clearRemoteHistory: true });
    this.project.projectState = ProjectState.Saved;
    if (Settings.showDebug) {
      toast("历史记录已清空");
    }
  }

  public getHistoryState() {
    return (
      this.project.docCommandBus?.getHistoryState() ?? {
        canUndo: false,
        canRedo: false,
        undoCursor: 0,
        totalEntries: 0,
      }
    );
  }
}
