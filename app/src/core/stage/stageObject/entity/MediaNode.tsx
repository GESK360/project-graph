import { Project } from "@/core/Project";
import { MediaPlaybackManager } from "@/core/service/mediaPlaybackService/MediaPlaybackManager";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { ResizeAble } from "@/core/stage/stageObject/abstract/StageObjectInterface";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { Vector } from "@graphif/data-structures";
import { id, passExtraAtArg1, passObject, serializable } from "@graphif/serializer";
import { Rectangle } from "@graphif/shapes";
import type { Value } from "platejs";

export const MEDIA_NODE_PLACEHOLDER_SIZE = { width: 320, height: 180 };
export const MEDIA_NODE_AUDIO_PLACEHOLDER_SIZE = { width: 640, height: 160 };

export type MediaKind = "audio" | "video";

type MediaNodeOptions = {
  uuid?: string;
  collisionBox?: CollisionBox;
  details?: Value;
  attachmentId?: string;
  mediaKind?: MediaKind;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  tableFields?: Record<string, unknown>;
};

@passExtraAtArg1
@passObject
export class MediaNode extends ConnectableEntity implements ResizeAble {
  isHiddenBySectionCollapse: boolean = false;
  @id
  @serializable
  public uuid: string;
  @serializable
  public collisionBox: CollisionBox;
  @serializable
  public attachmentId: string;
  @serializable
  public mediaKind: MediaKind;
  @serializable
  public title: string;

  _isSelected: boolean = false;
  public get isSelected() {
    return this._isSelected;
  }
  public set isSelected(value: boolean) {
    super.isSelected = value;
  }

  state: "loading" | "ready" | "notFound" | "unsupported" = "loading";
  poster: ImageBitmap | undefined;
  duration: number | undefined;
  naturalWidth: number | undefined;
  naturalHeight: number | undefined;
  aspectRatio: number;
  _lastPlaybackTime: number = 0;
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }
  private readonly pendingTasks = new Set<Promise<void>>();
  private _cachedMediaUrl: string | undefined;

  constructor(
    protected readonly project: Project,
    {
      uuid = crypto.randomUUID() as string,
      collisionBox = new CollisionBox([new Rectangle(Vector.getZero(), Vector.getZero())]),
      details = [] as Value,
      attachmentId = "",
      mediaKind = "video" as MediaKind,
      title = "",
      createdAt,
      updatedAt,
      tableFields,
    }: MediaNodeOptions,
    public unknown = false,
    public onReady?: () => void,
  ) {
    super();
    this.uuid = uuid;
    this.collisionBox = collisionBox;
    this.details = details;
    this.restoreEntityTableMetadata({ createdAt, updatedAt, tableFields });
    this.attachmentId = attachmentId;
    this.mediaKind = mediaKind;
    this.title = title;
    this.aspectRatio = mediaKind === "audio" ? 640 / 160 : 16 / 9;

    const blob = project.attachments?.get?.(attachmentId);
    const mediaUrl = !blob ? project.getAttachmentMediaUrl?.(attachmentId) : null;
    if (!blob && !mediaUrl) {
      this.state = "notFound";
      return;
    }
    if (project.isOffscreen) {
      this.state = "loading";
      return;
    }
    this.loadMedia();
  }

  async loadMedia(): Promise<void> {
    if (this.project.isOffscreen) return;
    const blob = this.project.attachments?.get?.(this.attachmentId);
    const mediaUrl = !blob ? this.project.getAttachmentMediaUrl?.(this.attachmentId) : null;
    if (!blob && !mediaUrl) {
      this.state = "notFound";
      return;
    }

    this.state = "loading";

    if (typeof document === "undefined") {
      this.state = "loading";
      return;
    }

    try {
      if (this.mediaKind === "video") {
        await this.loadVideo(blob ? { blob } : { url: mediaUrl! });
      } else {
        await this.loadAudio(blob ? { blob } : { url: mediaUrl! });
      }
    } catch {
      this.state = "unsupported";
    }
  }

  private loadVideo(source: { blob: Blob } | { url: string }): Promise<void> {
    return new Promise<void>((resolve) => {
      const shouldRevoke = "blob" in source;
      const url = "blob" in source ? URL.createObjectURL(source.blob) : source.url;
      const el = document.createElement("video");
      if (!shouldRevoke) {
        el.crossOrigin = "anonymous";
      }
      el.muted = true;
      el.preload = "auto";
      el.playsInline = true;
      el.style.display = "none";
      document.body.appendChild(el);

      let finished = false;
      let posterStarted = false;
      const timer = window.setTimeout(() => {
        if (!finished) {
          finish(this.naturalWidth !== undefined || this.duration !== undefined ? "ready" : "unsupported");
        }
      }, 15000);

      const finish = (nextState: "ready" | "unsupported") => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (shouldRevoke) {
          URL.revokeObjectURL(url);
        }
        el.remove();
        if (this.disposed) {
          resolve();
          return;
        }
        this.state = nextState;
        if (nextState === "ready") {
          this.onReady?.();
        }
        resolve();
      };

      const tryPoster = () => {
        if (posterStarted) return;
        posterStarted = true;
        this.generatePoster(el, 1280)
          .catch(() => {})
          .then(() => finish("ready"));
      };

      el.addEventListener("loadedmetadata", () => {
        this.duration = Number.isFinite(el.duration) ? el.duration : undefined;
        this.naturalWidth = el.videoWidth;
        this.naturalHeight = el.videoHeight;
        if (el.videoWidth > 0 && el.videoHeight > 0) {
          this.aspectRatio = el.videoWidth / el.videoHeight;
          const currentRect = this.rectangle;
          const isPlaceholder =
            Math.abs(currentRect.size.x - MEDIA_NODE_PLACEHOLDER_SIZE.width) < 0.5 &&
            Math.abs(currentRect.size.y - MEDIA_NODE_PLACEHOLDER_SIZE.height) < 0.5;
          if (isPlaceholder) {
            this.collisionBox = new CollisionBox([
              new Rectangle(currentRect.location, new Vector(el.videoWidth, el.videoHeight)),
            ]);
            this.updateFatherSectionByMove();
          }
        }
        try {
          el.currentTime = this.duration ? Math.min(this.duration * 0.15, 2) : 0;
        } catch {
          tryPoster();
        }
      });

      el.addEventListener("seeked", () => {
        tryPoster();
      });

      el.addEventListener("loadeddata", () => {
        tryPoster();
      });

      el.addEventListener("error", () => {
        finish("unsupported");
      });

      el.src = url;
      el.load();
    });
  }

  private loadAudio(source: { blob: Blob } | { url: string }): Promise<void> {
    return new Promise<void>((resolve) => {
      const shouldRevoke = "blob" in source;
      const url = "blob" in source ? URL.createObjectURL(source.blob) : source.url;
      const el = document.createElement("audio");
      if (!shouldRevoke) {
        el.crossOrigin = "anonymous";
      }
      el.preload = "auto";
      el.style.display = "none";
      document.body.appendChild(el);

      let finished = false;
      const timer = window.setTimeout(() => {
        if (!finished) {
          finish("unsupported");
        }
      }, 15000);

      const finish = (nextState: "ready" | "unsupported") => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (shouldRevoke) {
          URL.revokeObjectURL(url);
        }
        el.remove();
        if (this.disposed) {
          resolve();
          return;
        }
        this.state = nextState;
        if (nextState === "ready") {
          this.duration = Number.isFinite(el.duration) ? el.duration : undefined;
          this.onReady?.();
        }
        resolve();
      };

      el.addEventListener("loadedmetadata", () => {
        finish("ready");
      });

      el.addEventListener("error", () => {
        finish("unsupported");
      });

      el.src = url;
      el.load();
    });
  }

  private async generatePoster(videoEl: HTMLVideoElement, maxWidth: number): Promise<void> {
    const w = videoEl.videoWidth;
    const h = videoEl.videoHeight;
    if (w <= 0 || h <= 0) return;

    const scale = Math.min(1, maxWidth / w);
    const canvasW = Math.round(w * scale);
    const canvasH = Math.round(h * scale);

    const canvas = new OffscreenCanvas(canvasW, canvasH);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(videoEl, 0, 0, canvasW, canvasH);
    const bitmap = await createImageBitmap(canvas);
    if (this.disposed) {
      bitmap.close();
      return;
    }
    this.poster?.close();
    this.poster = bitmap;
  }

  async reload(): Promise<void> {
    if (this.disposed) return;
    MediaPlaybackManager.stop(this);
    this.poster?.close();
    this.poster = undefined;
    this.duration = undefined;
    this.naturalWidth = undefined;
    this.naturalHeight = undefined;
    await this.loadMedia();
  }

  getMediaUrl(): string {
    if (this._cachedMediaUrl) return this._cachedMediaUrl;
    const blob = this.project.attachments?.get?.(this.attachmentId);
    if (blob) {
      this._cachedMediaUrl = URL.createObjectURL(blob);
      return this._cachedMediaUrl;
    }
    const mediaUrl = this.project.getAttachmentMediaUrl?.(this.attachmentId);
    return mediaUrl ?? "";
  }

  async dispose(): Promise<void> {
    MediaPlaybackManager.stop(this);
    this.disposed = true;
    const results = await Promise.allSettled(this.pendingTasks);
    this.poster?.close();
    this.poster = undefined;
    if (this._cachedMediaUrl) {
      URL.revokeObjectURL(this._cachedMediaUrl);
      this._cachedMediaUrl = undefined;
    }
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(({ reason }) => reason);
    if (errors.length > 0) throw new AggregateError(errors, "MediaNode cleanup failed");
  }

  public get rectangle(): Rectangle {
    return this.collisionBox.shapes[0] as Rectangle;
  }

  public get geometryCenter() {
    return this.rectangle.location.clone().add(this.rectangle.size.clone().multiply(0.5));
  }

  move(delta: Vector): void {
    const newRectangle = this.rectangle.clone();
    newRectangle.location = newRectangle.location.add(delta);
    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
  }

  moveTo(location: Vector): void {
    const newRectangle = this.rectangle.clone();
    newRectangle.location = location.clone();
    this.collisionBox.shapes[0] = newRectangle;
    this.updateFatherSectionByMove();
  }

  resizeHandle(delta: Vector) {
    const rect = this.rectangle;
    const currentWidth = rect.size.x;
    const newWidth = Math.max(currentWidth + delta.x, 50);
    const newHeight = newWidth / this.aspectRatio;

    this.collisionBox = new CollisionBox([new Rectangle(rect.location, new Vector(newWidth, newHeight))]);
    this.updateFatherSectionByMove();
  }

  getResizeHandleRect(): Rectangle {
    const rect = this.collisionBox.getRectangle();
    return new Rectangle(new Vector(rect.right - 25, rect.bottom - 25), new Vector(25, 25));
  }

  isInProgressBar(worldPoint: Vector): boolean {
    if (this.mediaKind !== "audio") return false;
    const rect = this.rectangle;
    const w = rect.size.x;
    const h = rect.size.y;
    const barLeft = rect.left + w * 0.08;
    const barRight = rect.right - w * 0.08;
    const barY = rect.bottom - Math.max(12, h * 0.16);
    const barHeight = Math.max(6, h * 0.08);
    return (
      worldPoint.x >= barLeft && worldPoint.x <= barRight && worldPoint.y >= barY && worldPoint.y <= barY + barHeight
    );
  }

  getProgressRatio(worldPoint: Vector): number {
    const rect = this.rectangle;
    const w = rect.size.x;
    const barLeft = rect.left + w * 0.08;
    const barRight = rect.right - w * 0.08;
    const barWidth = barRight - barLeft;
    if (barWidth <= 0) return 0;
    return Math.max(0, Math.min(1, (worldPoint.x - barLeft) / barWidth));
  }
}
