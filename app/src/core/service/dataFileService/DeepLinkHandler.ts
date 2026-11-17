import { RecentFileManager } from "./RecentFileManager";
import { onOpenFile } from "../GlobalMenu";
import { URI } from "vscode-uri";
import { exists } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { Project } from "@/core/Project";

interface DeepLinkParams {
  path: string;
  location?: { x: number; y: number };
  zoom?: number;
  target?: string;
}

/**
 * 同一条链接可能被投递两次：热启动时 deep-link 插件既会触发 deep-link://new-url 事件，
 * 也会把 URL 写进 getCurrent() 的结果里。这里只在一个很短的时间窗内去重，
 * 使同一条链接在稍后再次点击时仍然能重新定位（长期去重会让第二次点击失效）。
 */
const handledUrls = new Map<string, number>();
const DEDUPE_WINDOW_MS = 2000;

function shouldHandleUrl(url: string) {
  const now = Date.now();
  for (const [handledUrl, handledAt] of handledUrls) {
    if (now - handledAt > DEDUPE_WINDOW_MS) handledUrls.delete(handledUrl);
  }
  const lastHandledAt = handledUrls.get(url);
  if (lastHandledAt !== undefined && now - lastHandledAt <= DEDUPE_WINDOW_MS) return false;
  handledUrls.set(url, now);
  return true;
}

export function isProjectGraphDeepLink(input: string) {
  return /^(prg|flux):(\/\/)?/i.test(input);
}

function buildProjectGraphUrl(params: DeepLinkParams) {
  const queryEntries: string[] = [];
  queryEntries.push(`path=${encodeReadableQueryValue(params.path)}`);
  if (params.target) {
    queryEntries.push(`target=${encodeReadableQueryValue(params.target)}`);
  }
  if (params.location) {
    queryEntries.push(`location=${encodeReadableQueryValue(`${params.location.x},${params.location.y}`)}`);
  }
  if (params.zoom !== undefined) {
    queryEntries.push(`zoom=${encodeReadableQueryValue(String(params.zoom))}`);
  }
  return `prg://open?${queryEntries.join("&")}`;
}

function encodeReadableQueryValue(value: string) {
  let result = "";
  for (const char of value) {
    if (shouldEncodeQueryChar(char)) {
      result += encodeURIComponent(char);
    } else {
      result += char;
    }
  }
  return result;
}

function shouldEncodeQueryChar(char: string) {
  const charCode = char.charCodeAt(0);
  if (charCode <= 0x1f || charCode === 0x7f) return true;
  return /\s|[%&=+#?]/.test(char);
}

export function createCurrentFileDeepLink(project: Project) {
  return buildProjectGraphUrl({ path: project.uri.fsPath });
}

/** 生成指向某个 .prg 文件本身的链接（工作空间文件树“复制指向页面的链接”用） */
export function createPageDeepLink(fsPath: string) {
  return buildProjectGraphUrl({ path: fsPath });
}

export function createCurrentViewDeepLink(project: Project) {
  return buildProjectGraphUrl({
    path: project.uri.fsPath,
    location: {
      x: project.camera.location.x,
      y: project.camera.location.y,
    },
    zoom: project.camera.currentScale,
  });
}

export function createSelectedEntityDeepLink(project: Project) {
  const selectedEntities = project.stageManager.getSelectedEntities();
  if (selectedEntities.length !== 1) return null;
  return buildProjectGraphUrl({
    path: project.uri.fsPath,
    target: selectedEntities[0].uuid,
  });
}

async function normalizeFilePath(rawPath: string): Promise<string | null> {
  let path = rawPath;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw
  }

  path = path.replace(/[\\/]+$/, "");

  // Windows: /D:/path → D:/path
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1);
  }
  // Windows: missing colon D/path → D:/path
  const missingColon = /^([A-Za-z])\/(.*)$/;
  if (missingColon.test(path)) {
    const match = path.match(missingColon)!;
    path = match[1] + ":" + "/" + match[2];
  }

  if (!path) return null;

  // Absolute path: check existence
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    if (await exists(path)) {
      return path;
    }
    return null;
  }

  // Relative/filename: search recent files
  const recentFiles = await RecentFileManager.getRecentFiles();
  const fileName = path.toLowerCase().endsWith(".prg") ? path : path + ".prg";
  for (const file of recentFiles) {
    const normalizedFsPath = file.uri.fsPath.toLowerCase().replaceAll("\\", "/");
    if (normalizedFsPath.endsWith("/" + fileName.toLowerCase())) {
      return file.uri.fsPath;
    }
  }
  return null;
}

function parseProjectGraphUrl(url: string): DeepLinkParams | null {
  if (!isProjectGraphDeepLink(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const normalized = url.replace(/^(prg|flux):(?!\/\/)/i, "$1://");
    parsed = new URL(normalized);
  }

  const params = new URLSearchParams(parsed.search);
  const queryPath = params.get("path");
  const rawPath =
    queryPath ??
    (parsed.host
      ? parsed.pathname === "/" || parsed.pathname === ""
        ? parsed.host
        : parsed.host + parsed.pathname
      : parsed.pathname);
  const result: DeepLinkParams = { path: rawPath };

  const target = params.get("target");
  if (target) {
    result.target = target;
  }

  const locationStr = params.get("location");
  if (locationStr) {
    const parts = locationStr.split(",");
    if (parts.length === 2) {
      const x = parseFloat(parts[0]);
      const y = parseFloat(parts[1]);
      if (!isNaN(x) && !isNaN(y)) {
        result.location = { x, y };
      }
    }
  }

  const zoomStr = params.get("zoom");
  if (zoomStr) {
    const z = parseFloat(zoomStr);
    if (!isNaN(z)) {
      result.zoom = z;
    }
  }

  return result;
}

function applyCameraParams(project: Project, params: DeepLinkParams) {
  if (params.target) {
    const entity = project.stageManager.getEntities().find((e) => e.uuid === params.target);
    if (entity) {
      const rect = entity.collisionBox.getRectangle();
      project.camera.resetByRectangle(rect);
      return;
    }
    toast.warning("未找到 UUID 为 " + params.target + " 的实体");
    return;
  }

  if (params.location) {
    project.camera.location.x = params.location.x;
    project.camera.location.y = params.location.y;
    project.camera.targetLocationByScale.x = params.location.x;
    project.camera.targetLocationByScale.y = params.location.y;
  }

  if (params.zoom !== undefined) {
    project.camera.currentScale = params.zoom;
    project.camera.targetScale = params.zoom;
  } else if (params.location && params.zoom === undefined) {
    project.camera.currentScale = 1;
    project.camera.targetScale = 1;
  }
}

export async function handleDeepLink(urls: string[]) {
  for (const url of urls) {
    if (!isProjectGraphDeepLink(url)) continue;
    if (!shouldHandleUrl(url)) continue;

    const params = parseProjectGraphUrl(url);
    if (!params) continue;

    if (!params.path) {
      // Just launch the app, no file to open
      continue;
    }

    const resolvedPath = await normalizeFilePath(params.path);
    if (!resolvedPath) {
      toast.error("文件不存在: " + params.path);
      continue;
    }

    const project = await onOpenFile(URI.file(resolvedPath), "DeepLink");
    if (project) {
      applyCameraParams(project, params);
    }
  }
}
