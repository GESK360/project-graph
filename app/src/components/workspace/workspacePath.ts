import { WorkspacePaths } from "@/core/service/workspace/WorkspaceManager";
import { toast } from "sonner";

/** 工作空间路径一律走 WorkspaceManager 的归一化：正斜杠 + 小写盘符，否则 Windows 上比对永远失败 */
export function normalizeWorkspacePath(path: string) {
  return WorkspacePaths.normalize(path);
}

export function workspaceDirOf(path: string) {
  return WorkspacePaths.dirname(path);
}

export function isSameWorkspacePath(a: string, b: string) {
  if (!a || !b) return false;
  return WorkspacePaths.normalize(a).toLowerCase() === WorkspacePaths.normalize(b).toLowerCase();
}

/** 文件操作失败要让人看见，用户不看控制台 */
export function reportWorkspaceError(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error));
}
