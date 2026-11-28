import { Project, ProjectState, service } from "@/core/Project";
import { DocClient } from "@/core/sqlite/DocClient";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, remove, stat } from "@tauri-apps/plugin-fs";
import { Settings } from "@/core/service/Settings";
import { toast } from "sonner";
import { PathString } from "@/utils/pathString";

/**
 * 自动保存与 SQLite Online Backup 定时快照服务（M2 精简版）：
 * 彻底删除全量 `stageHash` 与 `getFileContent` 整包 ZIP 序列化，
 * 直接基于 `v3Revision` 检测变更并调用 Rust `doc_checkpoint_and_snapshot` 无阻塞留存快照。
 */
@service("autoSaveBackup")
export class AutoSaveBackupService {
  private lastBackupTime = 0;
  private lastBackupRevision = -1;
  private lastSaveTime = 0;
  private isBackingUp = false;

  constructor(private readonly project: Project) {
    this.lastBackupTime = Date.now();
  }

  tick() {
    const now = Date.now();

    if (Settings.autoBackup && !this.isBackingUp && !this.project.isSaving) {
      if (now - this.lastBackupTime >= Settings.autoBackupInterval * 1000) {
        this.lastBackupTime = now;
        void this.runAutoBackup();
      }
    }
    if (Settings.autoSave && !this.isBackingUp && !this.project.isSaving) {
      if (now - this.lastSaveTime >= Settings.autoSaveInterval * 1000) {
        this.lastSaveTime = now;
        void this.autoSave();
      }
    }
  }

  private async autoSave() {
    if (!this.project.uri || this.project.isDraft || this.project.isCollab || this.project.isSaving) {
      return;
    }
    if (this.project.isSqliteV3) {
      await this.project.flushV3Persist();
      return;
    }
    if (this.project.projectState === ProjectState.Unsaved) {
      await this.project.save({ includeThumbnail: false });
    }
  }

  private async runAutoBackup() {
    this.isBackingUp = true;
    try {
      await this.autoBackup();
    } finally {
      this.isBackingUp = false;
    }
  }

  private async autoBackup() {
    if (!this.project.isSqliteV3 || !this.project.v3DocId || !DocClient.isAvailable()) {
      return;
    }
    const currentRev = this.project.v3Revision;
    if (currentRev === this.lastBackupRevision) {
      return;
    }

    const strategy = Settings.autoBackupStrategy;

    if (strategy === "sideBySide" || strategy === "subfolder") {
      const ok = await this.localAutoBackup(strategy);
      if (ok) {
        this.lastBackupRevision = currentRev;
      }
      return;
    }

    const primaryCustomPath = Settings.autoBackupCustomPath?.trim() ?? "";
    const secondaryCustomPath = Settings.autoBackupCustomPath2?.trim() ?? "";

    const candidates: Array<{ kind: "custom"; path: string } | { kind: "default" }> = [];
    if (primaryCustomPath) {
      candidates.push({ kind: "custom", path: primaryCustomPath });
    }
    if (secondaryCustomPath && secondaryCustomPath !== primaryCustomPath) {
      candidates.push({ kind: "custom", path: secondaryCustomPath });
    }
    candidates.push({ kind: "default" });

    for (const candidate of candidates) {
      const backupDir = await this.resolveAutoBackupDir(candidate);
      if (!backupDir) {
        continue;
      }
      const ok = await this.tryBackupToDir(backupDir);
      if (ok) {
        this.lastBackupRevision = currentRev;
        await this.manageBackupFiles(backupDir);
        return;
      }
    }

    toast.error("自动备份失败：所有备份路径均不可用");
  }

  private async localAutoBackup(strategy: "sideBySide" | "subfolder"): Promise<boolean> {
    if (!this.project.uri || this.project.isDraft) {
      return false;
    }

    const filePath = this.project.uri.fsPath || decodeURI(this.project.uri.toString());
    const dir = PathString.dirPath(filePath);
    const fileName = PathString.getFileNameFromPath(filePath);

    let backupDir: string;
    let backupFileName: string;

    if (strategy === "sideBySide") {
      backupDir = dir;
      backupFileName = `${fileName}_backup_${this.generateTimestamp()}.prg`;
    } else {
      backupDir = await join(dir, `${fileName}_backup`);
      backupFileName = `${this.generateTimestamp()}.prg`;
    }

    if (strategy === "subfolder" && !(await exists(backupDir))) {
      try {
        await mkdir(backupDir, { recursive: true });
      } catch (err) {
        toast.error(`创建备份子目录失败: ${err}`);
        return false;
      }
    }

    const backupFilePath = await join(backupDir, backupFileName);

    try {
      await this.project.flushV3Persist();
      await DocClient.checkpointAndSnapshot(this.project.v3DocId!, backupFilePath);
      toast.success(`备份成功：${backupFilePath}`);
    } catch (err) {
      toast.error(`备份失败: ${err}`);
      return false;
    }

    if (strategy === "sideBySide") {
      await this.manageBackupFiles(backupDir, `${fileName}_backup_`);
    } else {
      await this.manageBackupFiles(backupDir);
    }
    return true;
  }

  public async manualBackup() {
    if (!this.project.isSqliteV3 || !this.project.v3DocId || !DocClient.isAvailable()) {
      toast.error("当前工程不支持 SQLite 在线快照备份");
      return;
    }
    try {
      const backupDir = await join(await appCacheDir(), "manual-backup-v2");
      await this.backupCurrentProject(backupDir);
    } catch (err) {
      toast.error("备份过程中发生错误:" + err);
    }
  }

  private async resolveAutoBackupDir(
    candidate: { kind: "custom"; path: string } | { kind: "default" },
  ): Promise<string | null> {
    try {
      if (candidate.kind === "custom") {
        return await join(candidate.path, PathString.fileNameSafity(this.getOriginalFileName()));
      }
      return await join(await appCacheDir(), "auto-backup-v2", PathString.fileNameSafity(this.getOriginalFileName()));
    } catch (err) {
      toast.error(`生成备份路径失败: ${err}`);
      return null;
    }
  }

  private async tryBackupToDir(backupDir: string): Promise<boolean> {
    try {
      return await this.backupCurrentProject(backupDir);
    } catch {
      return false;
    }
  }

  private async backupCurrentProject(backupDir: string): Promise<boolean> {
    if (!(await exists(backupDir))) {
      try {
        await mkdir(backupDir, { recursive: true });
      } catch (err) {
        toast.error(`创建备份目录失败: ${err}`);
        return false;
      }
    }

    const fileName = this.generateBackupFileName();
    const backupFilePath = await join(backupDir, fileName);

    await this.createBackupFile(backupFilePath);
    return true;
  }

  private generateBackupFileName(): string {
    const originalFileName = this.getOriginalFileName();
    return `${originalFileName}-${this.generateTimestamp()}.prg`;
  }

  private generateTimestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
  }

  private getOriginalFileName(): string {
    if (!this.project.uri || this.project.isDraft) {
      return "Draft";
    }
    try {
      const uriStr = decodeURI(this.project.uri.toString());
      const nameWithoutExt = PathString.getFileNameFromPath(uriStr);
      return nameWithoutExt || "unnamed";
    } catch {
      return "unnamed";
    }
  }

  private async createBackupFile(backupFilePath: string): Promise<void> {
    try {
      await this.project.flushV3Persist();
      await DocClient.checkpointAndSnapshot(this.project.v3DocId!, backupFilePath);
      toast.success(`备份成功：${backupFilePath}`);
    } catch (err) {
      toast.error("创建备份文件失败:" + err);
      throw err;
    }
  }

  private async manageBackupFiles(backupDir: string, prefix?: string): Promise<void> {
    try {
      const files = await readDir(backupDir);
      const prgFiles = [];
      for (const file of files) {
        if (file.name.endsWith(".prg") && (!prefix || file.name.startsWith(prefix))) {
          try {
            const fileStat = await stat(await join(backupDir, file.name));
            prgFiles.push({
              name: file.name,
              mtime: fileStat.mtime,
            });
          } catch {
            // 忽略无法获取状态的文件
          }
        }
      }

      prgFiles.sort((a, b) => {
        const dateA = a.mtime ? new Date(a.mtime).getTime() : 0;
        const dateB = b.mtime ? new Date(b.mtime).getTime() : 0;
        return dateB - dateA;
      });

      const maxBackupCount = Settings.autoBackupLimitCount;
      if (prgFiles.length > maxBackupCount) {
        const filesToDelete = prgFiles.slice(maxBackupCount);
        for (const fileToDelete of filesToDelete) {
          try {
            await remove(await join(backupDir, fileToDelete.name));
          } catch (err) {
            toast.error(`删除旧备份文件 ${fileToDelete.name} 失败: ${err}`);
          }
        }
      }
    } catch (err) {
      toast.error(`管理备份文件失败: ${err}`);
    }
  }
}
