import { Vector } from "@graphif/data-structures";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { MediaNode } from "@/core/stage/stageObject/entity/MediaNode";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { ReferenceBlockNode } from "@/core/stage/stageObject/entity/ReferenceBlockNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { Settings } from "@/core/service/Settings";
import { CursorNameEnum } from "@/types/cursors";
import { isPersistentMindMapDragEnabled, reflowMindMapTreesForEntities } from "./MindMapDrag";

type ResizableEntity = TextNode | ImageNode | SvgNode | MediaNode | ReferenceBlockNode | Section;

export class ControllerEntityResizeClass extends ControllerClass {
  private changeSizeEntity: ResizableEntity | null = null;
  private resizePreviousCenters: Map<string, Vector> | null = null;
  private isManagingResizeCursor = false;

  private canResizeInteraction(): boolean {
    return (
      !Settings.viewerMode &&
      Settings.mouseLeftMode === "selectAndMove" &&
      !this.project.controller.camera.isPreGrabbingWhenSpace &&
      !this.project.controller.pressingKeySet.has("alt")
    );
  }

  private isResizableEntity(entity: Entity): entity is ResizableEntity {
    if (entity instanceof TextNode) {
      return entity.sizeAdjust !== "auto";
    }
    if (entity instanceof Section) {
      return (
        !entity.isCollapsed && !entity.isEditingTitle && !this.project.sectionMethods.isObjectBeLockedBySection(entity)
      );
    }
    return (
      entity instanceof ImageNode ||
      entity instanceof SvgNode ||
      entity instanceof MediaNode ||
      entity instanceof ReferenceBlockNode
    );
  }

  private findHitResizeEntity(worldLocation: Vector): ResizableEntity | null {
    const selectedEntities = this.project.stageManager.getSelectedEntities();
    const candidates: ResizableEntity[] = [];
    for (const selectedEntity of selectedEntities) {
      if (!this.isResizableEntity(selectedEntity)) {
        continue;
      }
      if (selectedEntity.getResizeHandleRect().isPointIn(worldLocation)) {
        candidates.push(selectedEntity);
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    // 优先命中非 Section 实体与更深层子 Section，避免外层框手柄抢占内层手柄。
    candidates.sort((a, b) => {
      const aIsSection = a instanceof Section ? 1 : 0;
      const bIsSection = b instanceof Section ? 1 : 0;
      if (aIsSection !== bIsSection) {
        return aIsSection - bIsSection;
      }
      return b.sectionDepth - a.sectionDepth;
    });
    return candidates[0];
  }

  private getResizeCursor(entity: ResizableEntity): CursorNameEnum {
    return entity instanceof TextNode ? CursorNameEnum.EResize : CursorNameEnum.NwseResize;
  }

  private resetResizeCursor() {
    if (!this.isManagingResizeCursor) {
      return;
    }
    this.isManagingResizeCursor = false;
    this.project.controller.setCursorName(CursorNameEnum.Default);
  }

  private collectCenters(entity: Entity): Map<string, Vector> {
    const centers = new Map<string, Vector>();
    centers.set(entity.uuid, entity.collisionBox.getRectangle().center);
    for (let sec = entity.parentSection; sec; sec = sec.parentSection) {
      centers.set(sec.uuid, sec.collisionBox.getRectangle().center);
    }
    return centers;
  }

  public mousedown: (event: MouseEvent) => void = (event) => {
    if (event.button !== 0 || !this.canResizeInteraction()) {
      return;
    }
    const pressWorldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    this.lastMoveLocation = pressWorldLocation.clone();
    const hitEntity = this.findHitResizeEntity(pressWorldLocation);
    if (!hitEntity) {
      return;
    }
    this.changeSizeEntity = hitEntity;
    this.resizePreviousCenters = this.collectCenters(hitEntity);
    this.isManagingResizeCursor = true;
    this.project.controller.setCursorName(this.getResizeCursor(hitEntity));
  };

  public mousemove: (event: MouseEvent) => void = (event) => {
    const pressWorldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    if (this.changeSizeEntity !== null) {
      const diff = pressWorldLocation.subtract(this.lastMoveLocation);
      this.changeSizeEntity.resizeHandle(diff);
      this.lastMoveLocation = pressWorldLocation.clone();
      return;
    }

    if (event.buttons === 0) {
      if (this.canResizeInteraction()) {
        const hitEntity = this.findHitResizeEntity(pressWorldLocation);
        if (hitEntity) {
          this.isManagingResizeCursor = true;
          this.project.controller.setCursorName(this.getResizeCursor(hitEntity));
        } else {
          this.resetResizeCursor();
        }
      } else {
        this.isManagingResizeCursor = false;
      }
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public mouseup: (event: MouseEvent) => void = (_event) => {
    if (this.changeSizeEntity === null) {
      return;
    }
    const resizedEntity = this.changeSizeEntity;
    const prevCenters = this.resizePreviousCenters ?? undefined;
    this.changeSizeEntity = null;
    this.resizePreviousCenters = null;
    this.resetResizeCursor();
    if (resizedEntity.parentSection) {
      this.project.stageManager.updateReferences();
    }
    if (isPersistentMindMapDragEnabled()) {
      reflowMindMapTreesForEntities(this.project, [resizedEntity], prevCenters);
    }
    this.project.historyManager.recordStep();
  };

  public mouseDoubleClick: (event: MouseEvent) => void = (event) => {
    if (event.button !== 0 || !this.canResizeInteraction()) {
      return;
    }
    const worldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    const hitEntity = this.findHitResizeEntity(worldLocation);
    if (!(hitEntity instanceof Section) || hitEntity.sizeAdjust !== "manual") {
      return;
    }
    const prevCenters = this.collectCenters(hitEntity);
    hitEntity.resetAutoSize();
    if (hitEntity.parentSection) {
      this.project.stageManager.updateReferences();
    }
    if (isPersistentMindMapDragEnabled()) {
      reflowMindMapTreesForEntities(this.project, [hitEntity], prevCenters);
    }
    this.project.historyManager.recordStep();
  };

  public mouseMoveOutWindowForcedShutdown(_outsideLocation: Vector) {
    super.mouseMoveOutWindowForcedShutdown(_outsideLocation);
    this.changeSizeEntity = null;
    this.resizePreviousCenters = null;
    this.isManagingResizeCursor = false;
  }
}
