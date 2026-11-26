import { runCli } from "@/cli";
import { Toaster } from "@/components/ui/sonner";
import { authClient } from "@/core/service/AuthClient";
import { MouseLocation } from "@/core/service/controlService/MouseLocation";
import { AutoSaveOnSwitch } from "@/core/service/workspace/AutoSaveOnSwitch";
import { RecentFileManager } from "@/core/service/dataFileService/RecentFileManager";
import { StartFilesManager } from "@/core/service/dataFileService/StartFilesManager";
import { ColorManager } from "@/core/service/feedbackService/ColorManager";
import { QuickSettingsManager } from "@/core/service/QuickSettingsManager";
import { Settings } from "@/core/service/Settings";
import { Tutorials } from "@/core/service/Tutorials";
import { UserState } from "@/core/service/UserState";
import { EdgeCollisionBoxGetter } from "@/core/stage/stageObject/association/EdgeCollisionBoxGetter";
import { type AuthUser, currentUserAtom, isAuthLoadingAtom, store, tabsAtom } from "@/state";
import { exit, writeStderr } from "@/utils/otherApi";
import { isDesktop, isMobile, isWeb } from "@/utils/platform";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { getCurrent } from "@tauri-apps/plugin-deep-link";
import { exists } from "@tauri-apps/plugin-fs";
import "driver.js/dist/driver.css";
import i18next from "i18next";
import { Provider } from "jotai";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "react-error-boundary";
import { initReactI18next } from "react-i18next";
import { toast } from "sonner";
import VConsole from "vconsole";
import { URI } from "vscode-uri";
import App from "./App";
import { ExtensionManager } from "./core/extension/ExtensionManager";
import { handleDeepLink, isProjectGraphDeepLink } from "./core/service/dataFileService/DeepLinkHandler";
import { LocalDocumentSync } from "./core/service/dataFileService/LocalDocumentSync";
import { onNewDraft, onOpenFile } from "./core/service/GlobalMenu";
import { installWorkspaceCrossWindowListeners } from "./core/service/workspace/WorkspacePageOps";
import WelcomeWindow from "./sub/WelcomeWindow";
import "./css/index.css";
import Fallback from "./Fallback";

if (import.meta.env.DEV && isMobile) {
  new VConsole();
}

const el = document.getElementById("root")!;

let cliMode = false;
let appRendered = false;

// 建议挂载根节点前的一系列操作统一写成函数，
// 在这里看着清爽一些，像一个列表清单一样。也方便调整顺序

(async () => {
  const isCliDesktopAcceptance =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has("cli-desktop-acceptance");
  try {
    if (isCliDesktopAcceptance) {
      await invoke("write_cli_desktop_acceptance_state", {
        state: { phase: "initializing", step: "application" },
      });
    }
    const currentWindowLabel = !isWeb && isDesktop && isTauri() ? getCurrentWindow().label : "main";
    const isMainWindow = currentWindowLabel === "main";
    const matches = isMainWindow && !isCliDesktopAcceptance && !isWeb && isDesktop ? await getMatches() : null;
    const isCliMode = isMainWindow && isDesktop && matches?.args.output?.occurrences === 1;
    cliMode = isCliMode || isCliDesktopAcceptance;
    await Promise.all([
      RecentFileManager.init(),
      StartFilesManager.init(),
      ColorManager.init(),
      Tutorials.init(),
      UserState.init(),
      QuickSettingsManager.init(),
      // 扩展加载失败不应阻断主程序启动（否则 renderApp 不会执行，窗口为空白）
      ExtensionManager.init().catch((e) => {
        console.error("[ExtensionManager] 扩展初始化失败，已跳过：", e);
      }),
    ]);
    if (isCliDesktopAcceptance) {
      await invoke("write_cli_desktop_acceptance_state", {
        state: { phase: "initializing", step: "application-services" },
      });
    }
    // 这些东西依赖上面的东西，所以单独一个Promise.all
    await Promise.all([loadLanguageFiles(), loadSyncModules(), ...(isCliDesktopAcceptance ? [] : [initAuth()])]);
    AutoSaveOnSwitch.install();
    if (!isWeb && isDesktop && isTauri()) {
      await Promise.all([LocalDocumentSync.ensureListeners(), installWorkspaceCrossWindowListeners()]);
    }
    await renderApp(isCliMode, isCliDesktopAcceptance);
    appRendered = true;
    if (isCliDesktopAcceptance) {
      await invoke("write_cli_desktop_acceptance_state", {
        state: { phase: "initializing", step: "application-rendered" },
      });
      const { runProjectGraphCliDesktopAcceptanceHost } = await import("./cli/ProjectGraphCliDesktopAcceptanceHost");
      await runProjectGraphCliDesktopAcceptanceHost();
      return;
    }
    await loadStartFile(isMainWindow);
    if (!isCliMode) {
      await ensureStartupDraftAndWelcome(isMainWindow);
      await reopenWorkspacePanel();
    }
    if (isCliMode) {
      try {
        await runCli(matches);
        exit();
      } catch (e) {
        writeStderr(String(e));
        exit(1);
      }
    }
  } catch (error) {
    if (isCliDesktopAcceptance) {
      await invoke("write_cli_desktop_acceptance_state", {
        state: { phase: "error", message: error instanceof Error ? (error.stack ?? error.message) : String(error) },
      });
    }
    if (!appRendered && !cliMode && !isCliDesktopAcceptance) {
      await renderStartupError(error);
      return;
    }
    throw error;
  }
})();

/** 加载同步初始化的模块 */
async function loadSyncModules() {
  EdgeCollisionBoxGetter.init();
  // SoundService.init();
  MouseLocation.init();
}

/** 初始化认证状态：从持久化存储中恢复 session */
async function initAuth() {
  if (!authClient) {
    store.set(isAuthLoadingAtom, false);
    return;
  }
  try {
    const session = await UserState.getSession();
    if (session?.token) {
      // 验证 session 是否仍然有效
      const { data } = await authClient.getSession();
      if (data?.user) {
        store.set(currentUserAtom, data.user as AuthUser);
      } else {
        // token 失效，清理本地存储
        await UserState.clearSession();
      }
    }
  } catch {
    // 网络错误等不影响启动，清理本地 session 即可
    await UserState.clearSession();
  } finally {
    store.set(isAuthLoadingAtom, false);
  }
}

/** 加载语言文件 */
async function loadLanguageFiles() {
  await i18next.use(initReactI18next).init({
    lng: Settings.language,
    // debug会影响性能，并且没什么用，所以关掉
    // debug: import.meta.env.DEV,
    debug: false,
    defaultNS: "",
    fallbackLng: false,
    saveMissing: false,
    resources: {
      en: await import("./locales/en.yml").then((m) => m.default),
      zh_CN: await import("./locales/zh_CN.yml").then((m) => m.default),
      zh_TW: await import("./locales/zh_TW.yml").then((m) => m.default),
      zh_TWC: await import("./locales/zh_TWC.yml").then((m) => m.default),
      id: await import("./locales/id.yml").then((m) => m.default),
    },
  });
}

/** 渲染应用 */
async function renderApp(cli: boolean = false, cliDesktopAcceptance: boolean = false) {
  const root = createRoot(el);
  if (cli) {
    await getCurrentWindow().hide();
    await getCurrentWindow().setSkipTaskbar(true);
    root.render(<></>);
  } else if (cliDesktopAcceptance) {
    root.render(<></>);
  } else {
    // if (isMobile) {
    //   document.querySelector<HTMLMetaElement>("meta[name=viewport]")!.content =
    //     "width=device-width, initial-scale=0.5, maximum-scale=0.5, user-scalable=yes, interactive-widget=overlays-content";
    //   document.documentElement.style.transform = "scale(0.5)";
    //   document.documentElement.style.transformOrigin = "top left";
    //   document.documentElement.style.overflow = "hidden";
    // }
    root.render(
      <Provider store={store}>
        <Toaster richColors visibleToasts={5} expand />
        <ErrorBoundary FallbackComponent={Fallback}>
          <App />
        </ErrorBoundary>
      </Provider>,
    );
  }
}

async function renderStartupError(error: unknown) {
  flushSync(() => createRoot(el).render(<Fallback error={error} resetErrorBoundary={() => location.reload()} />));
  if (!isWeb) await getCurrentWindow().show();
}

interface WindowInitPayload {
  filePath?: string | null;
  deepLinkUrl?: string | null;
  workspaceRoot?: string | null;
}

interface PendingWindowEvents {
  filePaths: string[];
  deepLinkUrls: string[];
}

async function consumePendingWindowEvents(events: PendingWindowEvents): Promise<void> {
  for (const path of events.filePaths) {
    try {
      if (await exists(path)) {
        await onOpenFile(URI.file(path), "系统打开文件");
      } else {
        toast.error("文件不存在");
      }
    } catch (error) {
      toast.error("打开文件失败: " + String(error));
    }
  }
  if (events.deepLinkUrls.length > 0) {
    try {
      await handleDeepLink(events.deepLinkUrls);
    } catch (error) {
      toast.error("处理 Deep Link 失败: " + String(error));
    }
  }
}

async function loadStartFile(isMainWindow: boolean) {
  if (isWeb || !isDesktop) return;

  const currentWindow = getCurrentWindow();

  // 所有窗口只监听定向投递给「本窗口」的文件打开与深链接事件（由 Rust 侧按最后焦点窗口精准路由）
  await currentWindow.listen<string>("open-file-from-os", async (event) => {
    const path = event.payload;
    const isExists = await exists(path);
    if (isExists) {
      await onOpenFile(URI.file(path), "系统打开文件");
    } else {
      toast.error("文件不存在");
    }
  });

  await currentWindow.listen<string[]>("targeted-deep-link", (event) => {
    if (Array.isArray(event.payload) && event.payload.length > 0) {
      void handleDeepLink(event.payload);
    }
  });

  if (!isMainWindow) {
    // 副窗口只消费创建时注入的初始化载荷，不重复读取进程级冷启动命令行参数和 getCurrent()
    const initPayload = await invoke<WindowInitPayload | null>("take_window_init_payload");
    if (initPayload?.deepLinkUrl) {
      await handleDeepLink([initPayload.deepLinkUrl]);
    } else if (initPayload?.filePath) {
      const isExists = await exists(initPayload.filePath);
      if (isExists) {
        await onOpenFile(URI.file(initPayload.filePath), "新窗口打开");
      } else {
        toast.error("文件不存在");
      }
    }
    const pendingWindowEvents = await invoke<PendingWindowEvents>("activate_window_routing");
    await consumePendingWindowEvents(pendingWindowEvents);
    return;
  }

  const cliMatches = await getMatches();
  const argPath = cliMatches.args.path.value as string | undefined;
  if (argPath) {
    if (isProjectGraphDeepLink(argPath)) {
      try {
        await handleDeepLink([argPath]);
      } catch (e) {
        toast.error("处理 Deep Link 失败: " + String(e));
      }
    } else {
      try {
        const isExists = await exists(argPath);
        if (isExists) {
          await onOpenFile(URI.file(argPath), "CLI或双击文件");
        } else {
          toast.error("文件不存在");
        }
      } catch (e) {
        toast.error("打开文件失败: " + String(e));
      }
    }
  }

  // Deep link: 仅主窗口读取冷启动 URL（热启动已由 Rust 侧单实例回调定向发 targeted-deep-link）
  try {
    const urls = await getCurrent();
    if (urls && urls.length > 0) {
      await handleDeepLink(urls);
    }
  } catch (e) {
    toast.error("处理 Deep Link 失败: " + String(e));
  }

  const pendingWindowEvents = await invoke<PendingWindowEvents>("activate_window_routing");
  await consumePendingWindowEvents(pendingWindowEvents);
}

/** 上次退出时开着工作空间的话，这次启动把文件树面板重新停靠到左侧 */
async function reopenWorkspacePanel() {
  if (!Settings.activeWorkspaceRoot) return;
  const { default: WorkspaceWindow } = await import("./sub/WorkspaceWindow");
  WorkspaceWindow.open();
}

/** 无外部文件时创建空草稿（主窗口弹欢迎窗，新开副窗口保持干净草稿） */
async function ensureStartupDraftAndWelcome(isMainWindow: boolean) {
  if (store.get(tabsAtom).length > 0) return;
  await onNewDraft();
  if (isMainWindow) {
    WelcomeWindow.open();
  }
}
