import type { Project } from "@/core/Project";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DocChangeSet } from "@/core/sqlite/DocClient";
import { applyDocChangeSet } from "@/core/sqlite/V3PatchApplier";

const PROJECT_STATE_SAVED = 0;

function hasTauriWindow(): boolean {
  return isTauri() && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function normalizeDocumentPathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export interface IncomingSavedEvent {
  canonicalPath: string;
  sourceWindow: string;
  revision: number;
  docId: string | null;
}

interface AttachedDocumentEntry {
  project: Project;
  canonicalPath: string;
  pathKey: string;
  docId: string | null;
}

/**
 * 将单条来自 Rust `pg-doc-changeset` 的增量变更集热应用到目标 `Project`：
 * - 跳过来自本窗口或已落地的过期 revision；
 * - O(dirty) 局部补丁更新画布与表格，保留选中状态、编辑中文本与未变动 `ImageNode` 位图；
 * - 立即强制重绘一帧，确保非聚焦窗口 `< 5 ms` 同步可见。
 */
export function applyIncomingDocChangeSet(project: Project, event: DocChangeSet, currentWindowLabel: string): boolean {
  if (project.closing) return false;
  if (event.originWindow && event.originWindow === currentWindowLabel) {
    if (event.revision > project.v3Revision) {
      project.v3Revision = event.revision;
    }
    return false;
  }
  if (event.revision <= project.v3Revision) {
    return false;
  }

  applyDocChangeSet(project, event, {
    preserveEditingNode: true,
    notifyTable: true,
  });

  if (project.getService?.("renderer")) {
    project.renderer.tick(true);
  }
  project.loop?.();
  return true;
}

/**
 * M2 原生多窗口同步器：
 * 彻底移除 Shadow-Doc 全图序列化 Diff 与 Peer Snapshot 拷贝，
 * 直接监听 Rust `DocumentActorPool` 广播的百字节级 `pg-doc-changeset` 事件并执行局部热补丁。
 */
class LocalDocumentSyncManager {
  private readonly entriesByPath = new Map<string, AttachedDocumentEntry>();
  private readonly entriesByDocId = new Map<string, AttachedDocumentEntry>();
  private readonly entriesByProject = new WeakMap<Project, AttachedDocumentEntry>();
  private listenersReady: Promise<void> | null = null;
  private currentWindowLabel = "main";

  public async ensureListeners(): Promise<void> {
    if (!hasTauriWindow()) return;
    if (this.listenersReady) return this.listenersReady;
    this.listenersReady = (async () => {
      const currentWindow = getCurrentWindow();
      this.currentWindowLabel = currentWindow.label;
      await currentWindow.listen<DocChangeSet>("pg-doc-changeset", ({ payload }) => {
        this.handleIncomingChangeSet(payload);
      });
      await currentWindow.listen<IncomingSavedEvent>("pg-doc-saved", ({ payload }) => {
        this.handleIncomingSaved(payload);
      });
    })();
    return this.listenersReady;
  }

  public attach(project: Project, canonicalPath: string): void {
    if (!canonicalPath) return;
    if (hasTauriWindow()) {
      void this.ensureListeners();
    }
    this.detach(project);

    const pathKey = normalizeDocumentPathKey(canonicalPath);
    const docId = project.v3DocId ?? project.metadata?.docId ?? null;
    const entry: AttachedDocumentEntry = {
      project,
      canonicalPath,
      pathKey,
      docId,
    };

    this.entriesByPath.set(pathKey, entry);
    if (docId) {
      this.entriesByDocId.set(docId, entry);
    }
    this.entriesByProject.set(project, entry);
  }

  public rebind(project: Project, nextCanonicalPath: string): void {
    const entry = this.entriesByProject.get(project);
    if (!entry) {
      this.attach(project, nextCanonicalPath);
      return;
    }
    const nextKey = normalizeDocumentPathKey(nextCanonicalPath);
    const nextDocId = project.v3DocId ?? project.metadata?.docId ?? null;
    if (entry.pathKey !== nextKey) {
      if (this.entriesByPath.get(entry.pathKey) === entry) {
        this.entriesByPath.delete(entry.pathKey);
      }
      entry.canonicalPath = nextCanonicalPath;
      entry.pathKey = nextKey;
      this.entriesByPath.set(nextKey, entry);
    }
    if (entry.docId !== nextDocId) {
      if (entry.docId && this.entriesByDocId.get(entry.docId) === entry) {
        this.entriesByDocId.delete(entry.docId);
      }
      entry.docId = nextDocId;
      if (nextDocId) {
        this.entriesByDocId.set(nextDocId, entry);
      }
    }
  }

  public async flushAndDetach(project: Project): Promise<void> {
    await project.docCommandBus?.flush();
    this.detach(project);
  }

  public detach(project: Project): void {
    const entry = this.entriesByProject.get(project);
    if (!entry) return;
    if (this.entriesByPath.get(entry.pathKey) === entry) {
      this.entriesByPath.delete(entry.pathKey);
    }
    if (entry.docId && this.entriesByDocId.get(entry.docId) === entry) {
      this.entriesByDocId.delete(entry.docId);
    }
    this.entriesByProject.delete(project);
  }

  public async notifySaved(project: Project): Promise<void> {
    if (!hasTauriWindow()) return;
    const entry = this.entriesByProject.get(project);
    if (!entry) return;
    await project.docCommandBus?.flush();
    await invoke<number>("broadcast_document_saved", {
      canonicalPath: entry.canonicalPath,
      docId: project.metadata?.docId ?? null,
    });
  }

  public handleIncomingChangeSet(event: DocChangeSet, windowLabelOverride?: string): boolean {
    const entry =
      (event.docId ? this.entriesByDocId.get(event.docId) : undefined) ??
      (event.canonicalPath ? this.entriesByPath.get(normalizeDocumentPathKey(event.canonicalPath)) : undefined);
    if (!entry) return false;
    return applyIncomingDocChangeSet(entry.project, event, windowLabelOverride ?? this.currentWindowLabel);
  }

  private handleIncomingSaved(event: IncomingSavedEvent): void {
    const entry = this.entriesByPath.get(normalizeDocumentPathKey(event.canonicalPath));
    if (!entry || entry.project.closing) return;
    if (event.docId && !entry.project.metadata.docId) {
      entry.project.metadata = { ...entry.project.metadata, docId: event.docId };
    }
    entry.project.docIdNeedsSave = false;
    entry.project.projectState = PROJECT_STATE_SAVED;
  }
}

export const LocalDocumentSync = new LocalDocumentSyncManager();
