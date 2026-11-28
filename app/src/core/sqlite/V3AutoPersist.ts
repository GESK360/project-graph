import type { Project } from "@/core/Project";
import { DocClient } from "./DocClient";

/**
 * M2 附件流式直写与持久化协调控制器：
 * 文档结构化修改已全部改由 `DocCommandBus` 增量 `doc_apply_commands` 实时提交至 SQLite WAL，
 * 本控制器仅负责将新粘贴/上传的二进制附件通过 `doc_put_attachment` 直写 SQLite 并立即释放 JS 内存原图 Blob。
 */
export class V3AutoPersistController {
  private disposed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly project: Project) {}

  public enqueueAttachmentPersist(attachmentId: string, blob: Blob): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const docId = this.project.v3DocId ?? this.project.docId;
    const mimeType = blob.type || "application/octet-stream";
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.disposed || !this.project.isSqliteV3) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const meta = await DocClient.putAttachment(docId, attachmentId, mimeType, bytes);
      this.project.registerV3AttachmentMeta(meta);
      // 已安全写入 SQLite 后释放 JS 内存中的原图 Blob，交由 flux-media:// 按需直出
      this.project.attachments.delete(attachmentId);
    });
    return this.writeQueue;
  }

  public async flush(): Promise<void> {
    await this.writeQueue;
    await this.project.docCommandBus?.flush();
  }

  public async dispose(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.disposed = true;
    }
  }
}
