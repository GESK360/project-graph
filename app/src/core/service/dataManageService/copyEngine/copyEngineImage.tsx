import { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { RectangleNoteEffect } from "@/core/service/feedbackService/effectEngine/concrete/RectangleNoteEffect";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { isMac } from "@/utils/platform";
import { Color, ProgressNumber } from "@graphif/data-structures";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { MouseLocation } from "../../controlService/MouseLocation";
import { createImageNodeFromBlob } from "../imageNodeFactory";
import { applyBlackAndWhite, prepareImageBlobForImport } from "../imageUtils";

export class CopyEngineImage {
  constructor(private project: Project) {}

  public resolveTargetNodeForImagePaste(preferMouseHover = false): TextNode | Section | null {
    const selectedEntities = this.project.stageManager.getSelectedEntities();
    if (selectedEntities.length === 1) {
      const only = selectedEntities[0];
      if (only instanceof TextNode || only instanceof Section) {
        return only;
      }
      if (only instanceof ImageNode && only.parentSection) {
        return only.parentSection;
      }
    }
    if (preferMouseHover) {
      const worldLocation = this.project.renderer.transformView2World(MouseLocation.vector());
      const hovered = this.project.stageManager.findEntityByLocation(worldLocation);
      if (hovered instanceof TextNode || hovered instanceof Section) {
        return hovered;
      }
      if (hovered instanceof ImageNode && hovered.parentSection) {
        return hovered.parentSection;
      }
      const containingSections = this.project.sectionMethods.getSectionsByInnerLocation(worldLocation);
      if (containingSections.length > 0) {
        return containingSections[0];
      }
    }
    return null;
  }

  public async readImageBlobFromTauriClipboard(): Promise<Blob | null> {
    const image = await readImage();
    const { width: origW, height: origH } = await image.size();

    if (origW <= 0 || origH <= 0) return null;

    const rgba = await image.rgba();
    const expectedLength = origW * origH * 4;
    const clamped = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
    const data =
      clamped.length === expectedLength
        ? clamped
        : (() => {
            const fixed = new Uint8ClampedArray(expectedLength);
            fixed.set(clamped.slice(0, Math.min(clamped.length, expectedLength)));
            return fixed;
          })();

    const origCanvas = document.createElement("canvas");
    origCanvas.width = origW;
    origCanvas.height = origH;
    const origCtx = origCanvas.getContext("2d")!;
    origCtx.putImageData(new ImageData(data, origW, origH), 0, 0);

    let w = origW;
    let h = origH;
    if (Settings.resizePastedImages) {
      const maxSize = Settings.maxPastedImageSize;
      const maxDim = Math.max(w, h);
      if (maxDim > maxSize) {
        const scale = maxSize / maxDim;
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(origCanvas, 0, 0, w, h);

    if (Settings.compressImageToBlackAndWhite) {
      applyBlackAndWhite(canvas);
    }

    const outputType = Settings.compressImageToBlackAndWhite
      ? "image/png"
      : Settings.compressImageToWebp
        ? "image/webp"
        : "image/png";
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (b) {
            if (outputType === "image/webp" && !b.type.includes("webp")) {
              toast.warning("当前系统 webview 不支持 WebP 编码，已回退为 PNG");
            }
            resolve(b);
          } else reject(new Error("canvas.toBlob returned null"));
        },
        outputType,
        Settings.compressImageToBlackAndWhite
          ? undefined
          : Settings.compressImageToWebp
            ? Settings.webpQuality
            : undefined,
      );
    });
  }

  public async readImageBlobsFromWebClipboard(): Promise<Blob[]> {
    const clipboard = navigator.clipboard as any;
    if (!clipboard || typeof clipboard.read !== "function") return [];

    const items = (await clipboard.read()) as Array<{
      types: readonly string[];
      getType: (type: string) => Promise<Blob>;
    }>;

    const result: Blob[] = [];
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith("image/"));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      const prepared = await prepareImageBlobForImport(blob);
      result.push(prepared.blob);
    }
    return result;
  }

  public async readImageBlobsFromSystemClipboard(): Promise<Blob[]> {
    const mode = Settings.clipboardPasteMode;
    const preferWeb = mode === "webview" || (mode !== "tauri" && isMac);
    if (preferWeb) {
      try {
        const webBlobs = await this.readImageBlobsFromWebClipboard();
        if (webBlobs.length > 0) return webBlobs;
      } catch {
        // 回退尝试 Tauri 剪贴板
      }
      try {
        const tauriBlob = await this.readImageBlobFromTauriClipboard();
        return tauriBlob ? [tauriBlob] : [];
      } catch {
        return [];
      }
    }

    try {
      const tauriBlob = await this.readImageBlobFromTauriClipboard();
      if (tauriBlob) return [tauriBlob];
    } catch {
      // 回退尝试 Web 剪贴板
    }
    try {
      return await this.readImageBlobsFromWebClipboard();
    } catch {
      return [];
    }
  }

  public async pasteImageFromTauriClipboard() {
    const blob = await this.readImageBlobFromTauriClipboard();
    if (!blob) return;
    await this.pasteImageBlob(blob);
  }

  public async pasteImageBlobsIntoNode(target: TextNode | Section, blobs: Blob[]): Promise<boolean> {
    if (blobs.length === 0) return false;
    if (!this.project.getService?.("stageTable")) return false;
    const ok = await this.project.stageTable.addRowImages(target.uuid, blobs);
    if (ok) {
      const liveContainer = this.project.stageManager.get(target.uuid);
      if (liveContainer) {
        this.project.effects.addEffect(
          new RectangleNoteEffect(new ProgressNumber(0, 50), liveContainer.collisionBox.getRectangle(), Color.Green),
        );
      }
      toast.success("已将图片粘贴到节点");
    }
    return ok;
  }

  private async pasteImageBlob(blob: Blob, explicitTarget?: TextNode | Section | null) {
    const target = explicitTarget !== undefined ? explicitTarget : this.resolveTargetNodeForImagePaste(false);
    if (target) {
      const ok = await this.pasteImageBlobsIntoNode(target, [blob]);
      if (ok) return;
    }
    const location = this.project.renderer.transformView2World(MouseLocation.vector());
    await createImageNodeFromBlob(this.project, blob, {
      location,
    });
  }

  public async pasteImageFromWebClipboard() {
    const blobs = await this.readImageBlobsFromWebClipboard();
    if (blobs.length === 0) return false;
    const target = this.resolveTargetNodeForImagePaste(false);
    if (target) {
      const ok = await this.pasteImageBlobsIntoNode(target, blobs);
      if (ok) return true;
    }
    for (const blob of blobs) {
      await this.pasteImageBlob(blob, null);
    }
    return true;
  }
}
