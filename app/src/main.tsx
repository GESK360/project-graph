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
import { loadAllServicesAfterInit, loadAllServicesBeforeInit } from "@/core/loadAllServices";
import { Project } from "@/core/Project";
import { TabWorkspace } from "@/core/TabWorkspace";
import {
  activeResourceTabAtom,
  activeTabAtom,
  type AuthUser,
  currentUserAtom,
  isAuthLoadingAtom,
  store,
  tabsAtom,
} from "@/state";
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
import { closeEmptyDrafts, onNewDraft, onOpenFile } from "./core/service/GlobalMenu";
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

const isStandbyBoot =
  typeof window !== "undefined" && Boolean((window as unknown as { __PG_STANDBY__?: boolean }).__PG_STANDBY__);

const localeLoaders: Record<string, () => Promise<{ default: Record<string, Record<string, unknown>> }>> = {
  en: () => import("./locales/en.yml"),
  zh_CN: () => import("./locales/zh_CN.yml"),
  zh_TW: () => import("./locales/zh_TW.yml"),
  zh_TWC: () => import("./locales/zh_TWC.yml"),
  id: () => import("./locales/id.yml"),
};

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

async function ensureLocaleBundleLoaded(lng: string) {
  const loader = localeLoaders[lng] ?? localeLoaders.zh_CN;
  const bundle = (await loader()).default;
  for (const [ns, data] of Object.entries(bundle)) {
    if (!i18next.hasResourceBundle(lng, ns)) {
      i18next.addResourceBundle(lng, ns, data, true, true);
    }
  }
}

/** 仅加载当前激活语言包（其余语言按需懒加载），大幅缩短新窗口启动耗时 */
async function loadLanguageFiles() {
  const activeLng = Settings.language in localeLoaders ? Settings.language : "zh_CN";
  const activeBundle = (await localeLoaders[activeLng]()).default;
  await i18next.use(initReactI18next).init({
    lng: activeLng,
    debug: false,
    defaultNS: "",
    fallbackLng: false,
    saveMissing: false,
    resources: {
      [activeLng]: activeBundle,
    },
  });
  Settings.watch("language", (nextLng: string) => {
    if (!nextLng || i18next.language === nextLng) return;
    void ensureLocaleBundleLoaded(nextLng).then(() => i18next.changeLanguage(nextLng));
  });
}

/** 渲染应用 */
async function renderApp(cli: boolean = false, cliDesktopAcceptance: boolean = false, initialStandby: boolean = false) {
  const root = createRoot(el);
  if (cli) {
    await getCurrentWindow().hide();
    await getCurrentWindow().setSkipTaskbar(true);
    root.render(<></>);
  } else if (cliDesktopAcceptance) {
    root.render(<></>);
  } else {
    root.render(
      <Provider store={store}>
        <Toaster richColors visibleToasts={5} expand />
        <ErrorBoundary FallbackComponent={Fallback}>
          <App initialStandby={initialStandby} />
        </ErrorBoundary>
      </Provider>,
    );
  }
}

/**
 * 隐藏预热窗口生命周期：
 * - 在后台完成 React/Canvas 空草稿挂载后保持暂停（0% CPU、不建临时 SQLite、不显示任务栏）；
 * - 收到 Rust `pg-standby-activate` 时毫秒级激活、按需打开目标文件或恢复草稿与工作空间侧栏。
 */
async function setupStandbyWindowLifecycle() {
  const currentWindow = getCurrentWindow();

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

  // 预建一个内存态空草稿并暂停渲染循环，使窗口被弹出时首帧即为完整可用的工作台
  const standbyDraft = Project.newDraft();
  loadAllServicesBeforeInit(standbyDraft);
  loadAllServicesAfterInit(standbyDraft);
  standbyDraft.pause();
  store.set(tabsAtom, [standbyDraft]);
  TabWorkspace.synchronizeGroups();
  store.set(activeTabAtom, standbyDraft);
  store.set(activeResourceTabAtom, standbyDraft);

  let activated = false;
  await currentWindow.listen<WindowInitPayload>("pg-standby-activate", async ({ payload }) => {
    if (activated) return;
    activated = true;
    (window as unknown as { __PG_STANDBY__?: boolean }).__PG_STANDBY__ = false;
    window.dispatchEvent(new Event("pg-standby-activated"));

    if (payload?.deepLinkUrl) {
      try {
        await handleDeepLink([payload.deepLinkUrl]);
        void closeEmptyDrafts();
      } catch (error) {
        toast.error("处理 Deep Link 失败: " + String(error));
      }
    } else if (payload?.filePath) {
      try {
        const isExists = await exists(payload.filePath);
        if (isExists) {
          const opened = await onOpenFile(URI.file(payload.filePath), "新窗口打开");
          if (opened) {
            void closeEmptyDrafts(opened);
          }
        } else {
          toast.error("文件不存在");
        }
      } catch (error) {
        toast.error("打开文件失败: " + String(error));
      }
    } else {
      standbyDraft.loop();
      void standbyDraft.init().catch(() => {});
    }

    void reopenWorkspacePanel();
    const pendingWindowEvents = await invoke<PendingWindowEvents>("activate_window_routing");
    await consumePendingWindowEvents(pendingWindowEvents);
  });

  // 后台预加载 WorkspaceWindow 模块，激活新窗口时零动态导入延迟
  if (Settings.activeWorkspaceRoot) {
    void import("./sub/WorkspaceWindow").catch(() => {});
  }

  await invoke("mark_standby_window_ready");
}

async function renderStartupError(error: unknown) {
  if (isStandbyBoot) {
    console.error("[StandbyWindow] 后台预热窗口初始化失败，已静默回收：", error);
    if (!isWeb) {
      await getCurrentWindow()
        .destroy()
        .catch(() => {});
    }
    return;
  }
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

// 必须在全部顶层常量（如 localeLoaders）完成初始化后再启动引导流程，
// 避免副窗口/预热窗口因无前置 await 而在 TDZ 内访问顶层 const 触发 ReferenceError。
async function bootstrap() {
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
    const matches =
      isMainWindow && !isStandbyBoot && !isCliDesktopAcceptance && !isWeb && isDesktop ? await getMatches() : null;
    const isCliMode = isMainWindow && isDesktop && matches?.args.output?.occurrences === 1;
    cliMode = isCliMode || isCliDesktopAcceptance;

    // 关键路径仅并发初始化轻量 Store 与当前语言包；网络认证与扩展目录扫描后台异步执行不阻塞首帧
    await Promise.all([
      RecentFileManager.init(),
      StartFilesManager.init(),
      ColorManager.init(),
      Tutorials.init(),
      QuickSettingsManager.init(),
      loadLanguageFiles(),
      loadSyncModules(),
      ...(!isWeb && isDesktop && isTauri()
        ? [LocalDocumentSync.ensureListeners(), installWorkspaceCrossWindowListeners()]
        : []),
    ]);

    void Promise.allSettled([
      UserState.init().then(() => (isCliDesktopAcceptance ? undefined : initAuth())),
      ExtensionManager.init().catch((e) => {
        console.error("[ExtensionManager] 扩展初始化失败，已跳过：", e);
      }),
    ]);

    if (isCliDesktopAcceptance) {
      await invoke("write_cli_desktop_acceptance_state", {
        state: { phase: "initializing", step: "application-services" },
      });
    }
    AutoSaveOnSwitch.install();
    await renderApp(isCliMode, isCliDesktopAcceptance, isStandbyBoot && !isCliMode && !isCliDesktopAcceptance);
    appRendered = true;
    if (isCliDesktopAcceptance) {
      await invoke("write_cli_desktop_acceptance_state", {
        state: { phase: "initializing", step: "application-rendered" },
      });
      const { runProjectGraphCliDesktopAcceptanceHost } = await import("./cli/ProjectGraphCliDesktopAcceptanceHost");
      await runProjectGraphCliDesktopAcceptanceHost();
      return;
    }

    if (isStandbyBoot && !isCliMode && !isWeb && isDesktop && isTauri()) {
      await setupStandbyWindowLifecycle();
      return;
    }

    await loadStartFile(isMainWindow);
    if (!isCliMode) {
      await ensureStartupDraftAndWelcome(isMainWindow);
      await reopenWorkspacePanel();
      // 主窗口空闲后在后台静默预热 1 个隐藏窗口，使后续「新窗口」点击耗时 < 20ms
      if (isMainWindow && !isWeb && isDesktop && isTauri()) {
        setTimeout(() => {
          void invoke("ensure_standby_window").catch(() => {});
        }, 1200);
      }
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
}

void bootstrap();
