import type { Project } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import type { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import type { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import type { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { Edge } from "@/core/stage/stageObject/association/Edge";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { Direction } from "@/types/directions";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";

export type MindMapSide = "left" | "right" | "top" | "bottom";
export type MindMapDragMode = "preserve" | "align";

type MindMapDragPreview = {
  offset: Vector;
  contact?: { node: ConnectableEntity; side: MindMapSide };
};

export const mindMapPorts = {
  left: { source: new Vector(0.01, 0.5), target: new Vector(0.99, 0.5), outward: new Vector(-1, 0) },
  right: { source: new Vector(0.99, 0.5), target: new Vector(0.01, 0.5), outward: new Vector(1, 0) },
  top: { source: new Vector(0.5, 0.01), target: new Vector(0.5, 0.99), outward: new Vector(0, -1) },
  bottom: { source: new Vector(0.5, 0.99), target: new Vector(0.5, 0.01), outward: new Vector(0, 1) },
};

const edgeDirections = {
  left: [Direction.Left, Direction.Right],
  right: [Direction.Right, Direction.Left],
  top: [Direction.Up, Direction.Down],
  bottom: [Direction.Down, Direction.Up],
} as const;

export function getMindMapPort(rect: Rectangle, rate: Vector): Vector {
  return Edge.getExactEdgePositionByRate(rect, rate) ?? rect.getInnerLocationByRateVector(rate);
}

export function getMindMapContact(ghost: Rectangle, target: Rectangle, tolerance: number) {
  const delta = ghost.center.subtract(target.center);
  const candidates: { side: MindMapSide; distance: number }[] = [];
  if (ghost.top < target.bottom && ghost.bottom > target.top && delta.x !== 0) {
    candidates.push(
      delta.x < 0
        ? { side: "left", distance: Math.abs(target.left - ghost.right) }
        : { side: "right", distance: Math.abs(ghost.left - target.right) },
    );
  }
  if (ghost.left < target.right && ghost.right > target.left && delta.y !== 0) {
    candidates.push(
      delta.y < 0
        ? { side: "top", distance: Math.abs(target.top - ghost.bottom) }
        : { side: "bottom", distance: Math.abs(ghost.top - target.bottom) },
    );
  }
  return candidates.filter(({ distance }) => distance <= tolerance).sort((a, b) => a.distance - b.distance)[0];
}

export class MindMapDrag {
  public preview: MindMapDragPreview | null = null;
  private readonly blockedTargets: Set<StageObject>;
  private readonly canLayOut: boolean;

  constructor(
    private readonly project: Project,
    public readonly node: ConnectableEntity,
    private readonly startWorld: Vector,
    public readonly mode: MindMapDragMode = "preserve",
  ) {
    const { graphMethods } = project;
    this.blockedTargets = this.getBlockedTargets();
    const branch = graphMethods.getSuccessorSet(node, true, true);
    this.canLayOut =
      this.isMovableBranch(branch) &&
      graphMethods.validateTreeStructure(node, true).isValid &&
      this.canReplaceIncomingEdges(graphMethods.getIncomingEdges(node));
  }

  private getBlockedTargets(): Set<StageObject> {
    const { stageManager } = this.project;
    const children = new Map<Entity, ConnectableEntity[]>();
    for (const edge of stageManager.getEdges()) {
      const siblings = children.get(edge.source);
      if (siblings) siblings.push(edge.target);
      else children.set(edge.source, [edge.target]);
    }
    const descendants = new Set<Entity>([this.node]);
    for (const node of descendants) {
      for (const child of children.get(node) ?? []) descendants.add(child);
      if (node instanceof Section) {
        for (const member of node.children) descendants.add(member);
      }
    }

    const blocked = new Set<StageObject>(descendants);
    for (const association of stageManager.getAssociations()) {
      if (association instanceof Edge) continue;
      const { associationList } = association;
      if (associationList.includes(this.node)) {
        for (const neighbor of associationList) blocked.add(neighbor);
      }
    }
    return blocked;
  }

  private isMovableBranch(branch: ConnectableEntity[]) {
    return branch.every(
      (node) => node.nearestLockedAncestorSection === null && !(node instanceof Section && node.locked),
    );
  }

  private canEnterSection(section: Section, blocked: Set<StageObject>) {
    return !section.locked && section.nearestLockedAncestorSection === null && !blocked.has(section);
  }

  private setBranchSection(branch: ConnectableEntity[], section: Section | null) {
    const branchNodes = new Set(branch);
    const members = branch.filter((node) => {
      // A moved Section takes its own members along without changing their direct parent.
      for (let parent = node.parentSection; parent; parent = parent.parentSection) {
        if (branchNodes.has(parent)) return false;
      }
      return node.parentSection !== section;
    });
    const { sectionInOutManager } = this.project;
    for (const member of members) {
      if (section) sectionInOutManager.attachEntityToSection(member, section);
      else sectionInOutManager.entityDropParent(member);
    }
  }

  private getDropSection(ghostCenter: Vector, branch: ConnectableEntity[]): Section | null {
    const { sectionMethods, stageManager } = this.project;
    const movedEntities = this.getMovedEntities(branch);
    return (
      sectionMethods
        .getSectionsByInnerLocation(ghostCenter, movedEntities)
        .find(
          (section) =>
            this.canEnterSection(section, movedEntities) &&
            !stageManager.isHiddenByBranchCollapse(section) &&
            !sectionMethods.isEntityHiddenByBigTitleSection(section),
        ) ?? null
    );
  }

  private getMovedEntities(branch: ConnectableEntity[]): Set<Entity> {
    const moved = new Set<Entity>(branch);
    for (const node of moved) {
      if (node instanceof Section) {
        for (const member of node.children) moved.add(member);
      }
    }
    return moved;
  }

  private canReplaceIncomingEdges(edges: Edge[]) {
    return edges.every((edge) => !this.project.sectionMethods.isObjectBeLockedBySection(edge));
  }

  private moveWithoutSectionReflow(move: () => void) {
    // Intermediate layout positions must not resize old sections or push neighboring nodes around.
    this.project.sectionMoveDepth++;
    try {
      move();
    } finally {
      this.project.sectionMoveDepth--;
    }
  }

  public update(world: Vector) {
    const offset = world.subtract(this.startWorld);
    const rect = this.node.collisionBox.getRectangle();
    const ghost = new Rectangle(rect.location.add(offset), rect.size);
    const preview: MindMapDragPreview = { offset };
    this.preview = preview;
    if (!this.canLayOut) return preview;

    const tolerance = 12 / this.project.camera.currentScale;
    let closest = Infinity;
    for (const node of this.project.stageManager.getConnectableEntity()) {
      const targetSection = node instanceof Section ? node : node.parentSection;
      if (
        this.blockedTargets.has(node) ||
        node.isHiddenBySectionCollapse ||
        this.project.stageManager.isHiddenByBranchCollapse(node) ||
        this.project.sectionMethods.isEntityHiddenByBigTitleSection(node) ||
        (targetSection && !this.canEnterSection(targetSection, this.blockedTargets))
      ) {
        continue;
      }
      const targetRect = node.collisionBox.getRectangle();
      if (node instanceof Section && targetRect.isPointIn(ghost.center)) continue;
      const contact = getMindMapContact(ghost, targetRect, tolerance);
      const current = preview.contact?.node;
      const isSection = node instanceof Section;
      const isCurrentSection = current instanceof Section;
      if (contact && (!current || (isSection === isCurrentSection ? contact.distance < closest : !isSection))) {
        preview.contact = { node, side: contact.side };
        closest = contact.distance;
      }
    }
    return preview;
  }

  public drop(world: Vector) {
    const { contact, offset } = this.update(world);
    const { stageManager, graphMethods, entityMoveManager, historyManager } = this.project;
    if (!stageManager.isEntityExists(this.node.uuid)) return;
    const branch = graphMethods.getSuccessorSet(this.node, true, true);
    if (!this.isMovableBranch(branch)) return;
    if (!contact) {
      if (offset.isZero()) return;
      const ghostCenter = this.node.collisionBox.getRectangle().center.add(offset);
      const targetSection = this.getDropSection(ghostCenter, branch);
      const refreshSections = targetSection || branch.some((node) => node instanceof Section || node.parentSection);
      this.moveWithoutSectionReflow(() => entityMoveManager.moveWithChildren(this.node, offset, true));
      if (targetSection || this.node.parentSection) this.setBranchSection(branch, targetSection);
      if (refreshSections) stageManager.updateReferences();
      historyManager.recordStep();
      return;
    }

    const { node: parent, side } = contact;
    const targetSection = parent.parentSection;
    const sectionToCheck = parent instanceof Section ? parent : targetSection;
    const blocked = this.getBlockedTargets();
    if (blocked.has(parent) || (sectionToCheck && !this.canEnterSection(sectionToCheck, blocked))) return;
    const oldIncomingEdges = graphMethods.getIncomingEdges(this.node);
    if (!graphMethods.validateTreeStructure(this.node, true).isValid) return;
    if (!this.canReplaceIncomingEdges(oldIncomingEdges)) return;

    this.moveWithoutSectionReflow(() => this.positionBranch(branch, parent, side));
    this.setBranchSection(branch, targetSection);

    const { source, target } = mindMapPorts[side];
    const newEdge = new LineEdge(this.project, {
      associationList: [parent, this.node],
      sourceRectangleRate: source.clone(),
      targetRectangleRate: target.clone(),
      arrowType: Settings.defaultEdgeArrowType,
    });
    for (const edge of oldIncomingEdges) stageManager.delete(edge);
    stageManager.add(newEdge);
    historyManager.recordStep();
  }

  private positionBranch(branch: ConnectableEntity[], parent: ConnectableEntity, side: MindMapSide) {
    const { stageManager, graphMethods, autoLayoutFastTree, entityMoveManager } = this.project;
    const branchNodes = new Set(branch);
    if (this.mode === "align") {
      const treeEdges = stageManager
        .getLineEdges()
        .filter((edge) => edge.lineType !== "dashed" && branchNodes.has(edge.source) && branchNodes.has(edge.target));
      if (treeEdges.length > 0) {
        const [sourceDirection, targetDirection] = edgeDirections[side];
        stageManager.changeEdgesConnectLocation(treeEdges, sourceDirection, true);
        stageManager.changeEdgesConnectLocation(treeEdges, targetDirection);
      }
    }
    autoLayoutFastTree.autoLayoutFastTreeMode(this.node, side);
    const sections = branch.filter((node) => node instanceof Section).sort((a, b) => b.sectionDepth - a.sectionDepth);
    for (const section of sections) section.adjustLocationAndSize();
    const rootRect = this.node.collisionBox.getRectangle();
    const parentRect = parent.collisionBox.getRectangle();
    const branchBounds = Rectangle.getBoundingRectangle(branch.map((node) => node.collisionBox.getRectangle()));
    const { source, target, outward } = mindMapPorts[side];
    const horizontal = outward.x !== 0;
    const gap = (horizontal ? 150 : 50) * (parent instanceof TextNode ? 2 ** (parent.fontScaleLevel / 2) : 1);
    const rootPort = getMindMapPort(rootRect, target);
    const branchNearPort = getMindMapPort(branchBounds, target);
    const clearance = horizontal ? Math.abs(branchNearPort.x - rootPort.x) : Math.abs(branchNearPort.y - rootPort.y);
    let offset = getMindMapPort(parentRect, source)
      .subtract(rootPort)
      .add(outward.multiply(gap + clearance));
    const siblings = graphMethods.getOutgoingEdges(parent).map((edge) => edge.target);
    const siblingBounds = siblings
      .flatMap((node) => graphMethods.getSuccessorSet(node, true, true))
      .filter((node) => !branchNodes.has(node) && !node.isHiddenBySectionCollapse)
      .map((node) => node.collisionBox.getRectangle())
      .sort((a, b) => (horizontal ? a.top - b.top : a.left - b.left));
    for (const sibling of siblingBounds) {
      const placed = new Rectangle(branchBounds.location.add(offset), branchBounds.size);
      if (placed.isCollideWith(sibling)) {
        offset = offset.add(
          horizontal
            ? new Vector(0, sibling.bottom + 20 - placed.top)
            : new Vector(sibling.right + 20 - placed.left, 0),
        );
      }
    }
    entityMoveManager.moveWithChildren(this.node, offset, true);
  }
}
