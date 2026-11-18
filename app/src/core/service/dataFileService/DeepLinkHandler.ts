import { RecentFileManager } from "./RecentFileManager";
import { onOpenFile } from "../GlobalMenu";
import { URI } from "vscode-uri";
import { exists } from "@tauri-apps/plugin-fs";
import { Decoder } from "@msgpack/msgpack";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";

interface DeepLinkParams {
  path: string;
  location?: { x: number; y: number };
  zoom?: number;
  target?: string;
  /** 文档身份，用于文件被移动/改名后重新定位 */
  doc?: string;
  /** 文档的显示名（不含扩展名），仅在按 doc 反查时用作提示 */
  name?: string;
}

export type EntityLinkMode = "absolute" | "relative";

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
  if (params.doc) {
    queryEntries.push(`doc=${encodeReadableQueryValue(params.doc)}`);
  }
  if (params.name) {
    queryEntries.push(`name=${encodeReadableQueryValue(params.name)}`);
  }
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

/**
 * 复制节点绝对路径链接：path 写死当前文件的绝对路径。
 * 文件一旦被移动或改名，链接就会指向不存在的位置。
 */
export function createSelectedEntityDeepLink(project: Project) {
  const selectedEntities = project.stageManager.getSelectedEntities();
  if (selectedEntities.length !== 1) return null;
  return buildProjectGraphUrl({
    path: project.uri.fsPath,
    target: selectedEntities[0].uuid,
  });
}

/**
 * 复制节点相对路径链接。
 *
 * 单纯写相对路径只能扛住"整个文件夹一起搬"，扛不住文件改名——改名后相对路径里的
 * 文件名也变了。所以这里同时写出 doc（文档身份）和 name（当前文件名）：
 * 解析时先用 path 相对定位，定位不到就按 doc 在附近目录里反查同名/同身份的 .prg。
 *
 * @param baseDir 相对路径的基准目录。工作空间内传工作空间根目录，
 *   这样同一个工作空间内的链接在任意子目录之间都成立。
 */
export function createSelectedEntityRelativeLink(project: Project, baseDir: string) {
  const selectedEntities = project.stageManager.getSelectedEntities();
  if (selectedEntities.length !== 1) return null;
  const absolutePath = project.uri.fsPath;
  const relative = relativePathFromDir(baseDir, absolutePath);
  if (!relative) return null;
  return buildProjectGraphUrl({
    path: relative,
    doc: project.docId,
    name: baseNameWithoutPrg(absolutePath),
    target: selectedEntities[0].uuid,
  });
}

/** 把路径拆成「盘符 + 各级目录」，Windows 盘符统一小写，方便跨盘判断 */
function splitPathParts(path: string): { drive: string; parts: string[] } {
  const normalized = path.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([a-zA-Z]:)\//);
  const drive = driveMatch ? driveMatch[1].toLowerCase() : "";
  const rest = driveMatch ? normalized.slice(driveMatch[0].length) : normalized;
  return { drive, parts: rest.split("/").filter((part) => part !== "" && part !== ".") };
}

function baseNameWithoutPrg(path: string) {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.prg$/i, "");
}

/**
 * 目录 → 文件的相对路径，统一用正斜杠。
 * PathString.getRelativePath 是按「文件 → 文件」写的（会砍掉最后一段当文件名），
 * 基准是目录时不能直接用，所以这里单独实现。
 * 跨盘符无法表达相对路径，返回 null。
 */
export function relativePathFromDir(baseDir: string, targetPath: string): string | null {
  const base = splitPathParts(baseDir);
  const target = splitPathParts(targetPath);
  if (base.drive !== target.drive) return null;

  let common = 0;
  while (common < base.parts.length && common < target.parts.length && base.parts[common] === target.parts[common]) {
    common++;
  }

  const up = new Array(base.parts.length - common).fill("..") as string[];
  const down = target.parts.slice(common);
  const segments = [...up, ...down];
  if (segments.length === 0) return null;
  // 同一目录下的文件也要带 ./ 前缀，避免被当成相对「当前目录」的模糊名
  return segments[0] === ".." ? segments.join("/") : "./" + segments.join("/");
}

/**
 * 读取一个 .prg 的 docId。
 * 走 Rust 侧的 read_prg_metadata：只按 zip 中央目录定位到 metadata.msgpack 那一段，
 * 不把整个文件读进内存、也不解压其余内容。含大图附件的 .prg 用整文件读取会明显卡顿。
 */
export async function readPrgDocId(fsPath: string): Promise<string | undefined> {
  try {
    const base64Content = await invoke<string>("read_prg_metadata", { path: fsPath });
    return docIdFromMetadataBytes(base64ToBytes(base64Content));
  } catch {
    return undefined;
  }
}

/** 把刚读到 / 刚写出的 metadata 字节解成 docId，供 Rust 命令不可用时兜底 */
export function docIdFromMetadataBytes(raw: Uint8Array): string | undefined {
  try {
    const metadata = new Decoder().decode(raw) as { docId?: string } | undefined;
    return metadata?.docId;
  } catch {
    return undefined;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 在若干根目录里递归找 .prg，返回全部路径。
 * 跳过工作空间的历史快照目录：那里存的是同一文档的旧副本，
 * docId 与正本相同，命中会把人带到过期的版本上。
 */
async function listPrgFilesUnder(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  let files: string[];
  try {
    files = await invoke<string[]>("read_folder_recursive", { path: root, fileExts: [".prg"] });
  } catch {
    return [];
  }
  return files.filter((file) => !file.replace(/\\/g, "/").includes("/.flux-graph/history/"));
}

/**
 * 按文档身份反查文件。用于链接里的相对路径已失效（文件被移动或改名）的情况。
 *
 * 只在工作空间/最近文件所在目录这些「附近」范围里找，不扫全盘。
 * 先试文件名与链接里 name 一致的候选（改名后这个提示会失效，属正常退化），
 * 再逐个读 metadata。name 只是加速用的提示，最终以 docId 为准，
 * 所以两个文件同名也不会认错。
 */
export async function findFileByDocId(docId: string, searchRoots: string[], nameHint?: string): Promise<string | null> {
  const candidates: string[] = [];
  for (const root of searchRoots) {
    for (const file of await listPrgFilesUnder(root)) {
      if (!candidates.includes(file)) candidates.push(file);
    }
  }

  const hinted = nameHint ? candidates.filter((file) => baseNameWithoutPrg(file) === nameHint) : [];

  // 先按文件名提示并发探测，命中即返回，避免为了一次查找把所有文件都读一遍
  for (const candidate of hinted) {
    if ((await readPrgDocId(candidate)) === docId) {
      return candidate;
    }
  }

  // 全部候选并发读，按原顺序取第一个命中，保证结果稳定
  const results = await Promise.all(candidates.map((file) => readPrgDocId(file)));
  const hitIndex = results.findIndex((doc) => doc === docId);
  return hitIndex >= 0 ? candidates[hitIndex] : null;
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

  const doc = params.get("doc");
  if (doc) {
    result.doc = doc;
  }

  const name = params.get("name");
  if (name) {
    result.name = name;
  }

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
  // 链接已经指定了要看哪里，就别让"打开文件自动重置视野"再抢一次镜头
  project.camera.skipResetOnOpen();

  if (params.target) {
    // 按 uuid 定位，与节点的文本内容、位置、类型变化无关
    const entity = project.stageManager.get(params.target);
    if (entity) {
      const rect = entity.collisionBox.getRectangle();
      project.camera.resetByRectangle(rect);
      return;
    }
    toast.warning("未找到 UUID 为 " + params.target + " 的实体，可能该节点已被删除");
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

/**
 * 解析链接里指向的 .prg。
 *
 * 顺序很重要：
 * 1. 绝对路径存在 → 直接用（老的绝对链接、以及相对链接里基准目录恰好对上的情况）
 * 2. 相对路径 → 按候选基准目录逐个换算成绝对路径
 * 3. 都不行 → 用 doc 身份在附近目录里反查（扛住文件被移动/改名）
 */
async function resolvePrgPath(params: DeepLinkParams): Promise<string | null> {
  const isRelative = !params.path.startsWith("/") && !/^[A-Za-z]:/.test(params.path);

  if (!isRelative) {
    // 绝对路径（老链接）：存在就用，不存在时仍有 doc 可救
    const direct = await normalizeFilePath(params.path);
    if (direct) return direct;
    return params.doc ? await findFileByDocId(params.doc, await candidateRoots(), params.name) : null;
  }

  const roots = await candidateRoots();

  // 相对路径按每个候选基准目录换算，命中即用。
  // 这一步能扛住「整个文件夹搬走」——只要相对位置没变就还能对上。
  for (const root of roots) {
    const candidate = resolveAgainstDir(root, params.path);
    if (candidate && (await exists(candidate))) return candidate;
  }

  // 相对路径失效（文件被移动或改名）→ 按文档身份反查，这是改名后仍可用的关键
  if (params.doc) {
    const byDoc = await findFileByDocId(params.doc, roots, params.name);
    if (byDoc) return byDoc;
  }

  return null;
}

/**
 * 候选基准目录：当前工作空间 → 历史工作空间 → 最近文件的所在目录。
 * 最后一项让没用过工作空间的人也能打开相对链接。
 */
async function candidateRoots(): Promise<string[]> {
  const roots = [Settings.activeWorkspaceRoot, ...Settings.workspaceRoots].filter((it) => Boolean(it)).map(joinPath);

  const recentFiles = await RecentFileManager.getRecentFiles();
  for (const file of recentFiles) {
    const dir = joinPath(file.uri.fsPath.replace(/[\\/][^\\/]*$/, ""));
    if (dir && !roots.includes(dir)) roots.push(dir);
  }
  return roots;
}

function joinPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/** 目录 + 相对路径 → 绝对路径；跨盘符等无法解析时返回 null */
export function resolveAgainstDir(baseDir: string, relativePath: string): string | null {
  const base = splitPathParts(baseDir);
  const segments = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  const merged = [...base.parts];
  for (const segment of segments) {
    if (segment === "..") {
      if (merged.length === 0) return null;
      merged.pop();
    } else {
      merged.push(segment);
    }
  }
  if (merged.length === 0) return null;
  const drivePrefix = base.drive ? base.drive + "/" : "/";
  return drivePrefix + merged.join("/");
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

    const resolvedPath = await resolvePrgPath(params);
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
