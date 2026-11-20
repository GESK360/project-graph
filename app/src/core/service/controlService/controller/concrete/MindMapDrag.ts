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

type NodePlacement = { node: ConnectableEntity; rectangle: Rectangle };
type LandingPreview = { placements: NodePlacement[]; parentRectangle: Rectangle };

type MindMapDragPreview = {
  offset: Vector;
  contact?: MindMapContact;
  ghosts: NodePlacement[];
  landing?: LandingPreview;
};

type MindMapContact = { node: ConnectableEntity; side: MindMapSide };
type Attachment = MindMapContact & { roots: ConnectableEntity[]; children: ConnectableEntity[] };

const isHorizontal = (side: MindMapSide) => side === "left" || side === "right";
const sides = ["left", "right", "top", "bottom"] as const;
const edgeOnSide = {
  left: (edge: Edge) => edge.isRightToLeft(),
  right: (edge: Edge) => edge.isLeftToRight(),
  top: (edge: Edge) => edge.isBottomToTop(),
  bottom: (edge: Edge) => edge.isTopToBottom(),
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

export function isPersistentMindMapDragEnabled() {
  return (
    !Settings.viewerMode && (Settings.persistentDragToConnectMindMap || Settings.persistentDragToConnectMindMapAligned)
  );
}

export function getMindMapSide(delta: Vector): MindMapSide {
  if (Math.abs(delta.x) >= Math.abs(delta.y)) return delta.x < 0 ? "left" : "right";
  return delta.y < 0 ? "top" : "bottom";
}

function isMovableBranch(branch: ConnectableEntity[]) {
  return branch.every(
    (node) => node.nearestLockedAncestorSection === null && !(node instanceof Section && node.locked),
  );
}

export function reflowMindMapTree(project: Project, node: ConnectableEntity, previousCenter?: Vector) {
  const { graphMethods, autoLayoutFastTree, stageManager } = project;
  const [root] = graphMethods.getRoots(node, true);
  if (!root) return;

  const tree = graphMethods.getSuccessorSet(root, true, true);
  if (tree.length < 2 || !tree.includes(node) || !isMovableBranch(tree)) return;
  const treeNodes = new Set(tree);
  const connected = new Set<ConnectableEntity>();
  const unanchored: LineEdge[] = [];
  // The tree traversal follows LineEdges, but the layout also reads other directed edges.
  for (const edge of stageManager.getEdges()) {
    const { source, target } = edge;
    if (!treeNodes.has(source) && !treeNodes.has(target)) continue;
    if (!(edge instanceof LineEdge)) return;
    if (edge.lineType === "dashed") continue;
    if (!treeNodes.has(source) || !treeNodes.has(target) || target === root || connected.has(target)) return;
    connected.add(target);
    if (edge.isUnknownDirection()) unanchored.push(edge);
  }

  const centerOf = (member: ConnectableEntity) =>
    member === node && previousCenter ? previousCenter : member.collisionBox.getRectangle().center;
  // Resolve center-to-center edges once so densely spaced siblings keep their sides on later edits.
  for (const edge of unanchored) {
    const { source, target } = mindMapPorts[getMindMapSide(centerOf(edge.target).subtract(centerOf(edge.source)))];
    edge.sourceRectangleRate = source.clone();
    edge.targetRectangleRate = target.clone();
  }
  project.sectionMoveDepth++;
  try {
    autoLayoutFastTree.autoLayoutFastTreeMode(root);
  } finally {
    project.sectionMoveDepth--;
  }
  if (unanchored.length || tree.some((member) => member instanceof Section || member.parentSection)) {
    stageManager.updateReferences();
  }
}

function getMindMapContact(ghost: Rectangle, target: Rectangle, tolerance: number) {
  const center = ghost.center;
  const targetCenter = target.center;
  let closest: { side: MindMapSide; distance: number; crossDistance: number } | undefined;
  for (const side of sides) {
    const { source, target: facing, outward } = mindMapPorts[side];
    const normal = isHorizontal(side) ? "x" : "y";
    const cross = normal === "x" ? "y" : "x";
    if ((center[normal] - targetCenter[normal]) * outward[normal] <= 0) continue;
    const crossDistance = Math.abs(center[cross] - targetCenter[cross]);
    const overhang = Math.max(0, crossDistance - target.size[cross] / 2);
    if (overhang > tolerance / 3) continue;
    const gap = getMindMapPort(ghost, facing)[normal] - getMindMapPort(target, source)[normal];
    const distance = Math.hypot(gap, overhang);
    if (
      distance <= tolerance &&
      (!closest ||
        distance < closest.distance ||
        (distance === closest.distance && crossDistance < closest.crossDistance))
    ) {
      closest = { side, distance, crossDistance };
    }
  }
  return closest;
}

function getBodyContact(ghost: Rectangle, target: Rectangle, pointer: Vector, offset: Vector) {
  if (!target.isPointIn(pointer) || !target.isCollideWith(ghost)) return;
  const delta = ghost.center.subtract(target.center);
  const heading = delta.isZero() ? offset.multiply(-1) : delta;
  const x = heading.x / Math.max(1, target.width);
  const y = heading.y / Math.max(1, target.height);
  const side = getMindMapSide(new Vector(x, y));
  return { side, distance: 0, crossDistance: pointer.distance(target.center) };
}

function getInsertionDistance(
  ghost: Rectangle,
  parent: Rectangle,
  children: Rectangle[],
  side: MindMapSide,
  tolerance: number,
) {
  if (children.length === 0) return;
  const { source, target, outward } = mindMapPorts[side];
  const normal = isHorizontal(side) ? "x" : "y";
  const cross = normal === "x" ? "y" : "x";
  const front = getMindMapPort(ghost, target)[normal];
  const start = getMindMapPort(parent, source)[normal];
  const center = ghost.center[cross];
  const padding = 2 * tolerance;
  let low = parent.center[cross];
  let high = low;
  let nearestChild = Infinity;
  let childEntrance = Infinity;
  for (const child of children) {
    const crossStart = child.location[cross];
    const crossEnd = crossStart + child.size[cross];
    low = Math.min(low, crossStart);
    high = Math.max(high, crossEnd);
    const entrance = getMindMapPort(child, target)[normal];
    if ((entrance - start) * outward[normal] <= 0) continue;
    const crossDistance = Math.max(0, crossStart - center, center - crossEnd);
    if (crossDistance <= nearestChild) {
      const entranceDistance = Math.abs(entrance - front);
      childEntrance = crossDistance === nearestChild ? Math.min(childEntrance, entranceDistance) : entranceDistance;
      nearestChild = crossDistance;
    }
  }
  if (center < low - padding || center > high + padding || nearestChild === Infinity) return;
  // Keep insertion near actual attachment points instead of claiming the space between them.
  const distance = Math.min(Math.abs(front - start), childEntrance);
  if (distance <= tolerance) return { distance, crossDistance: nearestChild };
}

export class MindMapDrag {
  public preview: MindMapDragPreview | null = null;
  public readonly roots: ConnectableEntity[];
  private readonly blockedTargets: Set<StageObject>;
  private readonly canLayOut: boolean;
  private readonly startRectangles: Map<ConnectableEntity, Rectangle>;
  private attachment?: Attachment;

  constructor(
    private readonly project: Project,
    public readonly node: ConnectableEntity,
    private readonly startWorld: Vector,
    public readonly mode: MindMapDragMode = "preserve",
    selectedNodes: ConnectableEntity[] = [node],
  ) {
    const { graphMethods } = project;
    const candidates = [...new Set([node, ...selectedNodes])];
    const carried = new Map(
      candidates.map((candidate) => [
        candidate,
        this.getMovedEntities(graphMethods.getSuccessorSet(candidate, true, true)),
      ]),
    );
    this.roots = candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) =>
            other !== candidate &&
            carried.get(other)!.has(candidate) &&
            (!carried.get(candidate)!.has(other) || candidates.indexOf(other) < candidates.indexOf(candidate)),
        ),
    );
    this.startRectangles = new Map(candidates.map((candidate) => [candidate, candidate.collisionBox.getRectangle()]));
    this.blockedTargets = this.getBlockedTargets();
    const branches = this.roots.flatMap((root) => graphMethods.getSuccessorSet(root, true, true));
    this.canLayOut =
      isMovableBranch(branches) &&
      new Set(branches).size === branches.length &&
      this.roots.every(
        (root) =>
          graphMethods.validateTreeStructure(root, true).isValid &&
          this.canReplaceIncomingEdges(graphMethods.getIncomingEdges(root)),
      );
  }

  private getBlockedTargets(): Set<StageObject> {
    const { stageManager } = this.project;
    const children = new Map<Entity, ConnectableEntity[]>();
    for (const edge of stageManager.getEdges()) {
      const siblings = children.get(edge.source);
      if (siblings) siblings.push(edge.target);
      else children.set(edge.source, [edge.target]);
    }
    const descendants = new Set<Entity>(this.roots);
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
      if (this.roots.some((root) => associationList.includes(root))) {
        for (const neighbor of associationList) blocked.add(neighbor);
      }
    }
    return blocked;
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
    this.attachment = undefined;
    const offset = world.subtract(this.startWorld);
    const rect = this.startRectangles.get(this.node)!;
    const ghost = new Rectangle(rect.location.add(offset), rect.size);
    const preview: MindMapDragPreview = {
      offset,
      ghosts: this.roots.map((node) => {
        const rectangle = this.startRectangles.get(node)!.clone();
        rectangle.location = rectangle.location.add(offset);
        return { node, rectangle };
      }),
    };
    this.preview = preview;
    if (!this.canLayOut) return preview;

    const { stageManager } = this.project;
    const edgesByParent = new Map<ConnectableEntity, LineEdge[]>();
    const draggedRoots = new Set(this.roots);
    for (const edge of stageManager.getLineEdges()) {
      if (edge.lineType === "dashed" || draggedRoots.has(edge.target)) continue;
      const siblings = edgesByParent.get(edge.source);
      if (siblings) siblings.push(edge);
      else edgesByParent.set(edge.source, [edge]);
    }
    const tolerance = 12 / this.project.camera.currentScale;
    let direct: (MindMapContact & { priority: number; distance: number; crossDistance: number }) | undefined;
    let nearby: { contact: MindMapContact; distance: number; crossDistance: number } | undefined;
    const visible = new Map<ConnectableEntity, Rectangle>();
    const isVisible = (node: ConnectableEntity) =>
      !node.isHiddenBySectionCollapse &&
      !stageManager.isHiddenByBranchCollapse(node) &&
      !this.project.sectionMethods.isEntityHiddenByBigTitleSection(node);
    for (const node of stageManager.getConnectableEntity()) {
      if (isVisible(node)) visible.set(node, node.collisionBox.getRectangle());
    }
    for (const [node, targetRect] of visible) {
      const targetSection = node instanceof Section ? node : node.parentSection;
      if (
        this.blockedTargets.has(node) ||
        (targetSection && !this.canEnterSection(targetSection, this.blockedTargets))
      ) {
        continue;
      }
      const isSection = node instanceof Section;
      if (isSection && targetRect.isPointIn(ghost.center)) continue;
      const body = isSection ? undefined : getBodyContact(ghost, targetRect, world, offset);
      const edge = getMindMapContact(ghost, targetRect, tolerance);
      const contact = body ? { ...body, side: edge?.side ?? body.side } : edge;
      if (contact) {
        const priority = isSection ? 2 : body ? 0 : 1;
        if (
          !direct ||
          priority < direct.priority ||
          (priority === direct.priority &&
            (contact.distance < direct.distance ||
              (contact.distance === direct.distance && contact.crossDistance < direct.crossDistance)))
        ) {
          direct = { node, priority, ...contact };
        }
      }
      if (!isSection) {
        for (const side of sides) {
          const children = this.getSideChildren(edgesByParent.get(node), side).flatMap((child) => {
            const rect = visible.get(child);
            return rect ? [rect] : [];
          });
          const hit = getInsertionDistance(ghost, targetRect, children, side, tolerance);
          if (
            hit &&
            (!nearby ||
              hit.distance < nearby.distance ||
              (hit.distance === nearby.distance && hit.crossDistance < nearby.crossDistance))
          ) {
            nearby = { contact: { node, side }, ...hit };
          }
        }
      }
    }
    // A ghost in the gap between siblings may touch their perpendicular edges without targeting either sibling.
    const gapBetweenChildren =
      direct?.priority === 1 &&
      nearby &&
      isHorizontal(direct.side) !== isHorizontal(nearby.contact.side) &&
      this.getSideChildren(edgesByParent.get(nearby.contact.node), nearby.contact.side).includes(direct.node);
    if (direct && !gapBetweenChildren) preview.contact = { node: direct.node, side: direct.side };
    else if (nearby) preview.contact = nearby.contact;
    if (preview.contact) {
      this.attachment = this.getAttachment(preview.contact, ghost.center, edgesByParent.get(preview.contact.node));
      preview.landing = this.getLandingPreview(this.attachment, visible);
    }
    return preview;
  }

  private getSideChildren(outgoing: LineEdge[] = [], side: MindMapSide) {
    return outgoing.filter(edgeOnSide[side]).map((edge) => edge.target);
  }

  private getAttachment(contact: MindMapContact, anchor: Vector, outgoing: LineEdge[] | undefined): Attachment {
    const axis = isHorizontal(contact.side) ? "y" : "x";
    const roots = [...this.roots].sort(
      (a, b) => this.startRectangles.get(a)!.location[axis] - this.startRectangles.get(b)!.location[axis],
    );
    const children = this.getSideChildren(outgoing, contact.side).sort(
      (a, b) => a.collisionBox.getRectangle().location[axis] - b.collisionBox.getRectangle().location[axis],
    );
    const next = children.findIndex((child) => child.collisionBox.getRectangle().center[axis] > anchor[axis]);
    children.splice(next === -1 ? children.length : next, 0, ...roots);
    return { ...contact, roots, children };
  }

  private getLandingPreview(
    { node: parent, side, roots, children }: Attachment,
    visible: Map<ConnectableEntity, Rectangle>,
  ): LandingPreview {
    const parentRectangle = parent.collisionBox.getRectangle();
    const { source, target, outward } = mindMapPorts[side];
    const normal = isHorizontal(side) ? "x" : "y";
    const cross = normal === "x" ? "y" : "x";
    const start = getMindMapPort(parentRectangle, source);
    const fontScale = parent instanceof TextNode ? 2 ** (parent.fontScaleLevel / 2) : 1;
    const gap = 20 * fontScale;
    const slot = children.indexOf(roots[0]);
    const before = children
      .slice(0, slot)
      .reverse()
      .map((child) => visible.get(child))
      .find(Boolean);
    const after = children
      .slice(slot + roots.length)
      .map((child) => visible.get(child))
      .find(Boolean);
    const placements = roots.map((node) => ({ node, rectangle: this.startRectangles.get(node)!.clone() }));
    const span = placements.reduce((sum, { rectangle }) => sum + rectangle.size[cross], (roots.length - 1) * gap);

    // Anchor the preview to the live canvas; the tree is only laid out after the drop.
    const row = after ?? before;
    let entrance = start[normal] + outward[normal] * (normal === "x" ? 150 : 50) * fontScale;
    if (row) {
      const visibleEntrance = getMindMapPort(row, target)[normal];
      if ((visibleEntrance - start[normal]) * outward[normal] > 0) entrance = visibleEntrance;
    }

    let position = start[cross] - span / 2;
    if (before && after) position = (before.location[cross] + before.size[cross] + after.location[cross] - span) / 2;
    else if (before) position = before.location[cross] + before.size[cross] + gap;
    else if (after) position = after.location[cross] - gap - span;

    for (const { rectangle } of placements) {
      rectangle.location[normal] += entrance - getMindMapPort(rectangle, target)[normal];
      rectangle.location[cross] = position;
      position += rectangle.size[cross] + gap;
    }
    return { placements, parentRectangle };
  }

  public drop(world: Vector) {
    const { offset } = this.update(world);
    const attachment = this.attachment;
    const { stageManager, graphMethods, entityMoveManager, historyManager } = this.project;
    if (this.roots.some((root) => !stageManager.isEntityExists(root.uuid))) return;
    const branch = [...new Set(this.roots.flatMap((root) => graphMethods.getSuccessorSet(root, true, true)))];
    if (!isMovableBranch(branch)) return;
    if (!attachment) {
      if (offset.isZero()) return;
      const ghostCenter = this.node.collisionBox.getRectangle().center.add(offset);
      const targetSection = this.getDropSection(ghostCenter, branch);
      const refreshSections = targetSection || branch.some((node) => node instanceof Section || node.parentSection);
      this.moveWithoutSectionReflow(() => entityMoveManager.moveWithChildrenOf(this.roots, offset, true));
      if (targetSection || this.roots.some((root) => root.parentSection)) this.setBranchSection(branch, targetSection);
      if (refreshSections) stageManager.updateReferences();
      historyManager.recordStep();
      return;
    }

    const { node: parent } = attachment;
    const targetSection = parent.parentSection;
    const sectionToCheck = parent instanceof Section ? parent : targetSection;
    const blocked = this.getBlockedTargets();
    if (blocked.has(parent) || (sectionToCheck && !this.canEnterSection(sectionToCheck, blocked))) return;
    if (
      !this.roots.every(
        (root) =>
          graphMethods.validateTreeStructure(root, true).isValid &&
          this.canReplaceIncomingEdges(graphMethods.getIncomingEdges(root)),
      )
    )
      return;
    this.attach(attachment);
    stageManager.updateReferences();
    historyManager.recordStep();
  }

  private attach(attachment: Attachment) {
    const { node: parent, side, roots } = attachment;
    const { graphMethods, stageManager } = this.project;
    const targetSection = parent.parentSection;
    const branches = roots.map((root) => graphMethods.getSuccessorSet(root, true, true));
    const incoming = roots.flatMap((root) => graphMethods.getIncomingEdges(root));
    this.moveWithoutSectionReflow(() => {
      roots.forEach((root, index) => this.positionBranch(root, branches[index], parent, side));
    });
    this.setBranchSection(branches.flat(), targetSection);

    const { source, target } = mindMapPorts[side];
    for (const edge of incoming) stageManager.delete(edge);
    for (const root of roots) {
      stageManager.add(
        new LineEdge(this.project, {
          associationList: [parent, root],
          sourceRectangleRate: source.clone(),
          targetRectangleRate: target.clone(),
          arrowType: Settings.defaultEdgeArrowType,
        }),
        true,
      );
    }
    this.moveWithoutSectionReflow(() => {
      const laidOut = this.layoutDestinationTree(attachment);
      const excluded = new Set(roots);
      for (const [index, root] of roots.entries()) {
        this.avoidSiblingOverlap(root, branches[index], parent, side, excluded);
        if (!laidOut) excluded.delete(root);
      }
    });
  }

  private layoutDestinationTree({ node: parent, side, children }: Attachment) {
    const { graphMethods, autoLayoutFastTree } = this.project;
    const roots = graphMethods.getRoots(parent, true);
    if (roots.length !== 1) return false;

    const [root] = roots;
    const tree = graphMethods.getSuccessorSet(root, true, true);
    // The tree validator follows LineEdges, but the default layout also traverses other directed edges.
    if (tree.some((node) => graphMethods.getOutgoingEdges(node).some((edge) => !(edge instanceof LineEdge))))
      return false;
    if (!isMovableBranch(tree) || !graphMethods.validateTreeStructure(root, true).isValid) return false;

    autoLayoutFastTree.autoLayoutFastTreeMode(root, undefined, { parent, side, children });
    return true;
  }

  private positionBranch(
    root: ConnectableEntity,
    branch: ConnectableEntity[],
    parent: ConnectableEntity,
    side: MindMapSide,
  ) {
    const { stageManager, autoLayoutFastTree, entityMoveManager } = this.project;
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
    autoLayoutFastTree.autoLayoutFastTreeMode(root, side);
    const sections = branch.filter((node) => node instanceof Section).sort((a, b) => b.sectionDepth - a.sectionDepth);
    for (const section of sections) section.adjustLocationAndSize();
    const rootRect = root.collisionBox.getRectangle();
    const parentRect = parent.collisionBox.getRectangle();
    const branchBounds = Rectangle.getBoundingRectangle(branch.map((node) => node.collisionBox.getRectangle()));
    const { source, target, outward } = mindMapPorts[side];
    const horizontal = outward.x !== 0;
    const gap = (horizontal ? 150 : 50) * (parent instanceof TextNode ? 2 ** (parent.fontScaleLevel / 2) : 1);
    const rootPort = getMindMapPort(rootRect, target);
    const branchNearPort = getMindMapPort(branchBounds, target);
    const clearance = horizontal ? Math.abs(branchNearPort.x - rootPort.x) : Math.abs(branchNearPort.y - rootPort.y);
    const offset = getMindMapPort(parentRect, source)
      .subtract(rootPort)
      .add(outward.multiply(gap + clearance));
    entityMoveManager.moveWithChildren(root, offset, true);
  }

  private avoidSiblingOverlap(
    root: ConnectableEntity,
    branch: ConnectableEntity[],
    parent: ConnectableEntity,
    side: MindMapSide,
    excluded: Set<ConnectableEntity>,
  ) {
    const { graphMethods, entityMoveManager } = this.project;
    const horizontal = side === "left" || side === "right";
    const branchNodes = new Set(branch);
    const branchBounds = Rectangle.getBoundingRectangle(branch.map((node) => node.collisionBox.getRectangle()));
    // The Tab layout leaves children with unanchored or nonstandard edges in place.
    const siblings = graphMethods
      .nodeChildrenArray(parent, true)
      .filter((node) => node !== root && !excluded.has(node));
    const siblingBounds = siblings
      .flatMap((node) => graphMethods.getSuccessorSet(node, true, true))
      .filter((node) => !branchNodes.has(node) && !node.isHiddenBySectionCollapse)
      .map((node) => node.collisionBox.getRectangle())
      .sort((a, b) => (horizontal ? a.top - b.top : a.left - b.left));
    let offset = Vector.getZero();
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
    if (!offset.isZero()) entityMoveManager.moveWithChildren(root, offset, true);
  }
}
