import { Vector } from "@graphif/data-structures";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { MediaNode } from "@/core/stage/stageObject/entity/MediaNode";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { ReferenceBlockNode } from "@/core/stage/stageObject/entity/ReferenceBlockNode";
import { isPersistentMindMapDragEnabled, reflowMindMapTreesForEntities } from "./MindMapDrag";

export class ControllerEntityResizeClass extends ControllerClass {
  private changeSizeEntity: Entity | null = null;
  private resizePreviousCenters: Map<string, Vector> | null = null;
  public mousedown: (event: MouseEvent) => void = (event) => {
    if (!(event.button == 0)) {
      return;
    }
    // 检查是否有选中的物体
    const selectedEntities = this.project.stageManager.getSelectedEntities();
    if (selectedEntities.length === 0) {
      return;
    }
    const pressWorldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    this.lastMoveLocation = pressWorldLocation.clone();
    for (const selectedEntity of selectedEntities) {
      // 检查是否是支持缩放的实体类型
      if (
        selectedEntity instanceof TextNode ||
        selectedEntity instanceof ImageNode ||
        selectedEntity instanceof SvgNode ||
        selectedEntity instanceof MediaNode ||
        selectedEntity instanceof ReferenceBlockNode
      ) {
        // 对TextNode进行特殊处理，只在手动模式下允许缩放
        if (selectedEntity instanceof TextNode && selectedEntity.sizeAdjust === "auto") {
          continue;
        }

        // 检查是否点击了缩放控制点
        const resizeRect = selectedEntity.getResizeHandleRect();
        if (resizeRect.isPointIn(pressWorldLocation)) {
          // 点中了扩大缩小的东西
          this.changeSizeEntity = selectedEntity;
          const centers = new Map<string, Vector>();
          centers.set(selectedEntity.uuid, selectedEntity.collisionBox.getRectangle().center);
          for (let sec = selectedEntity.parentSection; sec; sec = sec.parentSection) {
            centers.set(sec.uuid, sec.collisionBox.getRectangle().center);
          }
          this.resizePreviousCenters = centers;
          break;
        }
      }
    }
  };

  public mousemove: (event: MouseEvent) => void = (event) => {
    if (this.changeSizeEntity === null) {
      return;
    }
    const pressWorldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    const diff = pressWorldLocation.subtract(this.lastMoveLocation);

    // 对所有支持缩放的实体类型调用resizeHandle方法
    if (
      this.changeSizeEntity instanceof TextNode ||
      this.changeSizeEntity instanceof ImageNode ||
      this.changeSizeEntity instanceof SvgNode ||
      this.changeSizeEntity instanceof MediaNode ||
      this.changeSizeEntity instanceof ReferenceBlockNode
    ) {
      this.changeSizeEntity.resizeHandle(diff);
    }

    this.lastMoveLocation = pressWorldLocation.clone();
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
    if (resizedEntity.parentSection) {
      this.project.stageManager.updateReferences();
    }
    if (isPersistentMindMapDragEnabled()) {
      reflowMindMapTreesForEntities(this.project, [resizedEntity], prevCenters);
    }
    this.project.historyManager.recordStep();
  };

  public mouseMoveOutWindowForcedShutdown(_outsideLocation: Vector) {
    super.mouseMoveOutWindowForcedShutdown(_outsideLocation);
    this.changeSizeEntity = null;
    this.resizePreviousCenters = null;
  }
}
