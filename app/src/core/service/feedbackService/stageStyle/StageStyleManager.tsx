import { Project, service } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { StageStyle } from "@/core/service/feedbackService/stageStyle/stageStyle";

/**
 * 舞台上的颜色风格管理器
 */
@service("stageStyleManager")
export class StageStyleManager {
  currentStyle: StageStyle;
  private readonly unwatchers: Array<() => void> = [];

  // 软件启动运行一次
  constructor(private readonly project: Project) {
    this.currentStyle = StageStyle.styleFromTheme(Settings.theme);
    let initializing = true;
    const syncStageStyle = () => {
      if (initializing) return;
      this.currentStyle = StageStyle.styleFromTheme(Settings.theme);
      // 主题或窗口背景不透明度切换（含 ViewTransition 捕获新快照）时立即重置倒计时并同步重绘画布，避免旧主题画布残留造成透明度叠加异常
      if (this.project?.renderer && this.project.canvas?.ctx && this.project.renderer.w > 0) {
        this.project.controller?.resetCountdownTimer();
        this.project.renderer.tick();
      }
    };
    this.unwatchers.push(
      Settings.watch("theme", syncStageStyle),
      Settings.watch("windowBackgroundAlpha", syncStageStyle),
    );
    initializing = false;
  }

  dispose() {
    while (this.unwatchers.length > 0) {
      this.unwatchers.pop()?.();
    }
  }
}
