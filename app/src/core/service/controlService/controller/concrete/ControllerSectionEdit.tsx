import { Dialog } from "@/components/ui/dialog";
import { Project } from "@/core/Project";

import { ControllerClass } from "@/core/service/controlService/controller/ControllerClass";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { Vector } from "@graphif/data-structures";
import { toast } from "sonner";
import { isPersistentMindMapDragEnabled, reflowMindMapTreesForEntities } from "./MindMapDrag";

/**
 * 包含编辑节点文字，编辑详细信息等功能的控制器
 *
 * 当有节点编辑时，会把摄像机锁定住
 */
export class ControllerSectionEditClass extends ControllerClass {
  constructor(protected readonly project: Project) {
    super(project);
  }

  mouseDoubleClick = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }
    if (this.project.controller.camera.isPreGrabbingWhenSpace) {
      return;
    }
    const worldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    if (this.project.controllerUtils.isClickedResizeRect(worldLocation)) {
      return;
    }
    const clickedEntity = this.project.stageManager.findEntityByLocation(worldLocation);
    // 双击分组框内的图片用于打开大图灯箱，不触发分组框重命名
    if (clickedEntity instanceof ImageNode && !clickedEntity.isBackground) {
      return;
    }
    if (clickedEntity instanceof Section && this.project.sectionMethods.isSectionBigTitleActive(clickedEntity)) {
      this.editSectionTitle(clickedEntity);
      return;
    }
    const firstHoverSection = this.project.mouseInteraction.firstHoverSection;
    if (!firstHoverSection) {
      return;
    }

    // 编辑文字
    this.editSectionTitle(firstHoverSection);
    return;
  };

  mousemove = (event: MouseEvent) => {
    const worldLocation = this.project.renderer.transformView2World(new Vector(event.clientX, event.clientY));
    this.project.mouseInteraction.updateByMouseMove(worldLocation);
  };

  keydown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      const selectedSections = this.project.stageManager.getSections().filter((section) => section.isSelected);
      if (selectedSections.length === 0) {
        return;
      }
      // 检查是否有选中的section被锁定（包括祖先section的锁定状态）
      const lockedSections = selectedSections.filter((section) =>
        this.project.sectionMethods.isObjectBeLockedBySection(section),
      );
      if (lockedSections.length > 0) {
        toast.error("无法编辑已锁定的section");
        return;
      }
      Dialog.input("重命名 Section").then((value) => {
        if (value) {
          const prevCenters = new Map<string, Vector>();
          const affected: Section[] = [];
          for (const section of selectedSections) {
            prevCenters.set(section.uuid, section.rectangle.center);
            affected.push(section);
            for (let p = section.parentSection; p; p = p.parentSection) {
              if (!prevCenters.has(p.uuid)) {
                prevCenters.set(p.uuid, p.rectangle.center);
                affected.push(p);
              }
            }
            section.rename(value);
          }
          for (const section of selectedSections) {
            for (let p = section.parentSection; p; p = p.parentSection) {
              p.adjustLocationAndSize();
            }
          }
          if (isPersistentMindMapDragEnabled()) {
            reflowMindMapTreesForEntities(this.project, affected, prevCenters);
          }
          this.project.historyManager.recordStep();
        }
      });
    }
  };

  private editSectionTitle(section: Section) {
    this.project.controllerUtils.editSectionTitle(section);
  }
}
