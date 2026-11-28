export const DEFAULT_IMAGE_BITMAP_CACHE_MAX_BYTES = 256 * 1024 * 1024; // 256 MB 估算显存上限

export interface ImageBitmapConsumer {
  onBitmapEvicted(attachmentId: string): void;
}

interface CachedBitmapEntry {
  attachmentId: string;
  bitmap: ImageBitmap;
  bytes: number;
  lastTouchedFrame: number;
  consumers: Set<ImageBitmapConsumer>;
}

export interface ImageBitmapCacheStats {
  entryCount: number;
  totalBytes: number;
  maxBytes: number;
  inFlightCount: number;
}

/**
 * 项目级 `ImageBitmap` 视口驱动 LRU 显存缓存：
 * - 仅对视口（含 1 屏缓冲）内的 `ImageNode` 按需解码；
 * - 同一 `attachmentId` 在多个节点间共享单个 `ImageBitmap`；
 * - 超预算时仅回收远离当前视口的最久未使用项并调用 `bitmap.close()`；
 * - 局部 Undo/Redo 与多窗口补丁不会销毁未变动图片。
 */
export class ImageBitmapLruCache {
  private readonly entries = new Map<string, CachedBitmapEntry>();
  private readonly inFlight = new Map<string, Promise<ImageBitmap>>();
  private readonly pendingConsumers = new Map<string, Set<ImageBitmapConsumer>>();
  private totalBytes = 0;
  private disposed = false;

  constructor(private readonly maxBytes: number = DEFAULT_IMAGE_BITMAP_CACHE_MAX_BYTES) {}

  public get(attachmentId: string, frameId?: number): ImageBitmap | undefined {
    const entry = this.entries.get(attachmentId);
    if (!entry) return undefined;
    this.touchEntry(entry, frameId);
    return entry.bitmap;
  }

  public has(attachmentId: string): boolean {
    return this.entries.has(attachmentId);
  }

  public markVisible(attachmentId: string, frameId: number): void {
    const entry = this.entries.get(attachmentId);
    if (entry) {
      this.touchEntry(entry, frameId);
    }
  }

  public registerConsumer(
    attachmentId: string,
    consumer: ImageBitmapConsumer,
    frameId?: number,
  ): ImageBitmap | undefined {
    const entry = this.entries.get(attachmentId);
    if (entry) {
      entry.consumers.add(consumer);
      this.touchEntry(entry, frameId);
      return entry.bitmap;
    }
    let set = this.pendingConsumers.get(attachmentId);
    if (!set) {
      set = new Set();
      this.pendingConsumers.set(attachmentId, set);
    }
    set.add(consumer);
    return undefined;
  }

  public unregisterConsumer(attachmentId: string, consumer: ImageBitmapConsumer): void {
    this.entries.get(attachmentId)?.consumers.delete(consumer);
    const pending = this.pendingConsumers.get(attachmentId);
    if (pending) {
      pending.delete(consumer);
      if (pending.size === 0) {
        this.pendingConsumers.delete(attachmentId);
      }
    }
  }

  public acquire(
    attachmentId: string,
    loader: () => Promise<ImageBitmap>,
    consumer: ImageBitmapConsumer,
    frameId = 0,
  ): Promise<ImageBitmap> {
    if (this.disposed) {
      return Promise.reject(new Error("ImageBitmapLruCache已释放"));
    }
    const existing = this.registerConsumer(attachmentId, consumer, frameId);
    if (existing) {
      return Promise.resolve(existing);
    }
    const inflight = this.inFlight.get(attachmentId);
    if (inflight) {
      return inflight;
    }

    const task = loader()
      .then((bitmap) => {
        this.inFlight.delete(attachmentId);
        if (this.disposed) {
          bitmap.close();
          throw new Error("ImageBitmapLruCache已释放");
        }
        const prev = this.entries.get(attachmentId);
        if (prev) {
          this.totalBytes -= prev.bytes;
          prev.bitmap.close();
          this.entries.delete(attachmentId);
        }
        const consumers = this.pendingConsumers.get(attachmentId) ?? new Set<ImageBitmapConsumer>();
        this.pendingConsumers.delete(attachmentId);
        consumers.add(consumer);

        const bytes = Math.max(1, bitmap.width) * Math.max(1, bitmap.height) * 4;
        const entry: CachedBitmapEntry = {
          attachmentId,
          bitmap,
          bytes,
          lastTouchedFrame: frameId,
          consumers,
        };
        this.entries.set(attachmentId, entry);
        this.totalBytes += bytes;
        this.evictIfOverBudget(frameId);
        return bitmap;
      })
      .catch((err) => {
        this.inFlight.delete(attachmentId);
        this.pendingConsumers.delete(attachmentId);
        throw err;
      });

    this.inFlight.set(attachmentId, task);
    return task;
  }

  /**
   * 仅淘汰不在当前活跃帧（视口 + 1 屏缓冲）内的最久未用项，直至估算显存回到预算内。
   */
  public evictIfOverBudget(activeFrameId: number): number {
    if (this.totalBytes <= this.maxBytes) {
      return 0;
    }
    let evicted = 0;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (this.totalBytes <= this.maxBytes) {
        break;
      }
      if (entry.lastTouchedFrame === activeFrameId) {
        continue;
      }
      this.entries.delete(key);
      this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
      for (const consumer of entry.consumers) {
        consumer.onBitmapEvicted(key);
      }
      entry.consumers.clear();
      entry.bitmap.close();
      evicted++;
    }
    return evicted;
  }

  /** 替换某附件对应的缓存位图（例如反色/压缩生成新附件前清理旧项）。 */
  public invalidate(attachmentId: string): void {
    const entry = this.entries.get(attachmentId);
    if (!entry) return;
    this.entries.delete(attachmentId);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    for (const consumer of entry.consumers) {
      consumer.onBitmapEvicted(attachmentId);
    }
    entry.consumers.clear();
    entry.bitmap.close();
  }

  public getStats(): ImageBitmapCacheStats {
    return {
      entryCount: this.entries.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
      inFlightCount: this.inFlight.size,
    };
  }

  public dispose(): void {
    this.disposed = true;
    for (const [key, entry] of this.entries) {
      for (const consumer of entry.consumers) {
        consumer.onBitmapEvicted(key);
      }
      entry.consumers.clear();
      entry.bitmap.close();
    }
    this.entries.clear();
    this.pendingConsumers.clear();
    this.inFlight.clear();
    this.totalBytes = 0;
  }

  private touchEntry(entry: CachedBitmapEntry, frameId?: number): void {
    if (frameId !== undefined) {
      entry.lastTouchedFrame = Math.max(entry.lastTouchedFrame, frameId);
    }
    // Map 删除再重插可 O(1) 移至 MRU 尾部
    this.entries.delete(entry.attachmentId);
    this.entries.set(entry.attachmentId, entry);
  }
}
