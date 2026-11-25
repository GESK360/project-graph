import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { ReferenceBlockNode } from "@/core/stage/stageObject/entity/ReferenceBlockNode";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { isMac } from "@/utils/platform";
import { Vector } from "@graphif/data-structures";
import { isPersistentMindMapDragEnabled, reflowMindMapTreesForEntities } from "./MindMapDrag";

export class ControllerImageScaleClass extends ControllerClass {
  mousewheel = (event: WheelEvent) => {
    if (
      isMac ? this.project.controller.pressingKeySet.has("meta") : this.project.controller.pressingKeySet.has("control")
    ) {
      const location = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
      const hoverEntity = this.project.stageManager.findEntityByLocation(location);
      if (hoverEntity === null) {
        return;
      }
      if (
        hoverEntity instanceof ImageNode ||
        hoverEntity instanceof SvgNode ||
        hoverEntity instanceof ReferenceBlockNode
      ) {
        // 需要注意缩放逻辑和视野缩放逻辑保持一致性
        const scaledEntities: Array<ImageNode | SvgNode | ReferenceBlockNode> = [];
        const previousCenters = new Map<string, Vector>();
        for (const entity of this.project.stageManager.getSelectedEntities()) {
          if (entity instanceof ImageNode || entity instanceof SvgNode || entity instanceof ReferenceBlockNode) {
            previousCenters.set(entity.uuid, entity.collisionBox.getRectangle().center);
            for (let sec = entity.parentSection; sec; sec = sec.parentSection) {
              previousCenters.set(sec.uuid, sec.collisionBox.getRectangle().center);
            }
            if (event.deltaY > 0) {
              // 放大图片
              entity.scaleUpdate(-0.1);
            } else if (event.deltaY < 0) {
              entity.scaleUpdate(+0.1);
            }
            scaledEntities.push(entity);
          }
        }
        if (scaledEntities.length > 0 && isPersistentMindMapDragEnabled()) {
          if (scaledEntities.some((entity) => entity.parentSection)) {
            this.project.stageManager.updateReferences();
          }
          reflowMindMapTreesForEntities(this.project, scaledEntities, previousCenters);
        }
      }
    }
  };
}
