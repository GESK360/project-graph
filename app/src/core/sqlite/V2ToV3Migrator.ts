import { Project } from "@/core/Project";
import { parseProjectFile } from "@/core/ProjectFile";
import { ProjectUpgrader } from "@/core/stage/ProjectUpgrader";
import { convertLatexNodes } from "@/core/stage/stageObject/tools/convertLatexNodes";
import { deserialize } from "@graphif/serializer";
import { Decoder } from "@msgpack/msgpack";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { URI } from "vscode-uri";
import { DocClient, type LegacyScanReport, type V3MigrationMeta } from "./DocClient";
import { serializeProjectToV3Payload } from "./V3Serializer";

export interface SingleFileMigrationResult {
  targetPath: string;
  backupPath: string;
  meta: V3MigrationMeta;
}

export interface WorkspaceMigrationProgress {
  phase: "backing_up" | "migrating";
  completed: number;
  total: number;
  currentFile?: string;
}

export interface WorkspaceMigrationResult {
  backupDir: string;
  succeeded: Array<{ path: string; relPath: string; meta: V3MigrationMeta }>;
  failed: Array<{ path: string; relPath: string; error: string }>;
}

/**
 * 将磁盘上的单个旧版 v2.x ZIP `.prg` 转换为 `.prg v3.0.0`（SQLite）并原子替换。
 * 复用既有 `parseProjectFile` + `ProjectUpgrader.upgradeNAnyToNLatest` + `@graphif/serializer`，
 * 附件通过 raw 二进制逐个写入临时 SQLite，不经巨型 JSON。
 */
export async function convertLegacyPrgFileInPlace(targetPath: string): Promise<V3MigrationMeta> {
  const fileBytes = await readFile(targetPath);
  let fileCreatedAt: number | undefined;
  let fileModifiedAt: number | undefined;
  try {
    const info = await stat(targetPath);
    fileCreatedAt = info.birthtime ? info.birthtime.getTime() : undefined;
    fileModifiedAt = info.mtime ? info.mtime.getTime() : undefined;
  } catch {
    // 某些文件系统不提供 birthtime，保留 undefined 由 ProjectUpgrader 兜底
  }

  const attachments = new Map<string, Blob>();
  const decoder = new Decoder();
  const parsed = await parseProjectFile(fileBytes, decoder, attachments);

  const [upgradedStageObjects, upgradedMetadata] = ProjectUpgrader.upgradeNAnyToNLatest(
    parsed.serializedStageObjects,
    parsed.metadata,
    {
      defaultCreatedAt: fileCreatedAt,
      defaultUpdatedAt: fileModifiedAt,
    },
  );
  if (!upgradedMetadata.docId) {
    upgradedMetadata.docId = crypto.randomUUID();
  }

  // 使用隔离的离屏临时 Project 实例反序列化并标准化对象树（含 LatexNode 兼容转换），
  // 禁用 rAF 渲染循环、全局键盘监听与图片位图解码，避免批量迁移时弹窗报错或阻塞主线程。
  const { loadAllServicesBeforeInit } = await import("@/core/loadAllServices");
  const tempProject = new Project(URI.file(targetPath));
  tempProject.isOffscreen = true;
  loadAllServicesBeforeInit(tempProject);
  tempProject.attachments = attachments;
  tempProject.metadata = upgradedMetadata;
  tempProject.tags = parsed.tags;
  tempProject.references = parsed.references;
  tempProject.table = parsed.table;
  tempProject.readme = parsed.readme;
  try {
    tempProject.stage = deserialize(upgradedStageObjects, tempProject);
    convertLatexNodes(tempProject);
    tempProject.stageManager.updateReferences();

    const payload = serializeProjectToV3Payload(tempProject);
    const session = await DocClient.migrationBegin(targetPath);
    try {
      for (const [attId, blob] of attachments.entries()) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await DocClient.migrationPutAttachment(
          session.sessionId,
          attId,
          blob.type || "application/octet-stream",
          bytes,
        );
      }
      return await DocClient.migrationCommit(session.sessionId, payload, {
        entities: payload.entities.length,
        edges: payload.edges.length,
        associations: payload.associations.length,
        attachments: attachments.size,
      });
    } catch (error) {
      await DocClient.migrationAbort(session.sessionId);
      throw error;
    }
  } finally {
    await tempProject.dispose();
    attachments.clear();
  }
}

function normalizeFsPath(path: string): string {
  let result = path.replace(/\\/g, "/");
  while (result.length > 1 && result.endsWith("/") && !/^[a-zA-Z]:\/$/.test(result)) {
    result = result.slice(0, -1);
  }
  if (/^[a-zA-Z]:\//.test(result)) {
    result = result[0].toLowerCase() + result.slice(1);
  }
  return result;
}

function isPathInside(path: string, parent: string): boolean {
  const target = normalizeFsPath(path);
  const base = normalizeFsPath(parent);
  return target === base || target.startsWith(base.endsWith("/") ? base : `${base}/`);
}

/**
 * 单文件「一键备份并升级至 v3.0.0」：
 * - 若文件位于当前工作空间内，备份到 `<workspaceRoot>/.flux-graph/backup-v2/<timestamp>/<relPath>`；
 * - 否则在原文件旁自动留存 `<name>.prg.v2.bak`。
 */
export async function migrateSingleLegacyFile(
  targetPath: string,
  options?: { workspaceRoot?: string },
): Promise<SingleFileMigrationResult> {
  const normalizedTarget = normalizeFsPath(targetPath);
  const workspaceRoot = options?.workspaceRoot ? normalizeFsPath(options.workspaceRoot) : undefined;
  let backupPath: string;
  if (workspaceRoot && isPathInside(normalizedTarget, workspaceRoot)) {
    const res = await DocClient.backupLegacyFiles(workspaceRoot, [targetPath]);
    backupPath = res.backupDir;
  } else {
    const res = await DocClient.backupSingleLegacyFile(targetPath);
    backupPath = res.backupPath;
  }

  const meta = await convertLegacyPrgFileInPlace(targetPath);
  return { targetPath, backupPath, meta };
}

/**
 * 工作空间批量「一键备份并升级至 v3.0.0」：
 * 先保留完整目录结构统一备份至 `.flux-graph/backup-v2/<timestamp>/`，再逐文件转换与校验，
 * 单文件失败不会中止其他文件升级，最终返回完整汇总报告。
 */
export async function migrateWorkspaceLegacyPrg(
  report: LegacyScanReport,
  onProgress?: (progress: WorkspaceMigrationProgress) => void,
): Promise<WorkspaceMigrationResult> {
  const total = report.files.length;
  onProgress?.({ phase: "backing_up", completed: 0, total });

  const backup = await DocClient.backupLegacyFiles(
    report.root,
    report.files.map((item) => item.path),
  );

  const succeeded: WorkspaceMigrationResult["succeeded"] = [];
  const failed: WorkspaceMigrationResult["failed"] = [];

  for (let i = 0; i < report.files.length; i++) {
    const item = report.files[i];
    onProgress?.({
      phase: "migrating",
      completed: i,
      total,
      currentFile: item.relPath,
    });
    // 让出一帧给 React 渲染进度条，避免大批量升级时界面假死
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      const meta = await convertLegacyPrgFileInPlace(item.path);
      succeeded.push({ path: item.path, relPath: item.relPath, meta });
    } catch (error) {
      failed.push({
        path: item.path,
        relPath: item.relPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onProgress?.({ phase: "migrating", completed: total, total });
  return {
    backupDir: backup.backupDir,
    succeeded,
    failed,
  };
}

/** 将一个内存中的 `Project` 原子写出为全新的 `.prg v3.0.0`（用于新建页面、另存为与草稿落盘）。 */
export async function writeProjectAsV3Atomic(
  project: Project,
  targetPath: string,
  options?: { copyAttachmentsFromDocId?: string },
): Promise<V3MigrationMeta> {
  await project.docCommandBus?.flush();
  void project.docId;
  const payload = serializeProjectToV3Payload(project);
  const session = await DocClient.migrationBegin(targetPath);
  try {
    let copiedCount = 0;
    const copiedIds = new Set<string>();
    if (options?.copyAttachmentsFromDocId) {
      copiedCount = await DocClient.migrationCopyAttachments(session.sessionId, options.copyAttachmentsFromDocId);
      for (const id of project.v3AttachmentMetas.keys()) {
        copiedIds.add(id);
      }
    }
    let addedCount = 0;
    for (const [attId, blob] of project.attachments.entries()) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await DocClient.migrationPutAttachment(session.sessionId, attId, blob.type || "application/octet-stream", bytes);
      if (!copiedIds.has(attId)) {
        addedCount++;
      }
    }
    return await DocClient.migrationCommit(session.sessionId, payload, {
      entities: payload.entities.length,
      edges: payload.edges.length,
      associations: payload.associations.length,
      attachments: copiedCount + addedCount,
    });
  } catch (error) {
    await DocClient.migrationAbort(session.sessionId);
    throw error;
  }
}
