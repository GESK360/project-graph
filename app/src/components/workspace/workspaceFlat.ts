import type { WorkspaceCreatePlacement, WorkspaceNode } from "@/core/service/workspace/WorkspaceManager";

/** 当前展开状态下的一次前序遍历结果：多选、拖拽落点、快捷键都按这个顺序算 */
export interface WorkspaceFlatRow {
  node: WorkspaceNode;
  depth: number;
  /** 这一行所在的目录路径；根层就是工作空间根目录 */
  dirPath: string;
  siblings: WorkspaceNode[];
  indexInSiblings: number;
}

export interface WorkspacePendingRow {
  dirPath: string;
  node: WorkspaceNode;
  placement?: WorkspaceCreatePlacement;
}

export function flattenWorkspaceTree(
  nodes: WorkspaceNode[],
  collapsedDirs: ReadonlySet<string>,
  root: string,
  pending?: WorkspacePendingRow,
): WorkspaceFlatRow[] {
  const rows: WorkspaceFlatRow[] = [];
  const walk = (list: WorkspaceNode[], depth: number, dirPath: string) => {
    const hasPendingHere = pending?.dirPath === dirPath;
    let inserted = false;
    if (hasPendingHere && pending.placement?.type === "start") {
      rows.push({ node: pending.node, depth, dirPath, siblings: list, indexInSiblings: 0 });
      inserted = true;
    }
    list.forEach((node, indexInSiblings) => {
      rows.push({ node, depth, dirPath, siblings: list, indexInSiblings });
      if (node.kind === "dir" && !collapsedDirs.has(node.path)) {
        walk(node.children, depth + 1, node.path);
      }
      if (
        hasPendingHere &&
        !inserted &&
        pending.placement?.type === "after" &&
        fileNameOf(node).toLowerCase() === pending.placement.fileName.toLowerCase()
      ) {
        rows.push({ node: pending.node, depth, dirPath, siblings: list, indexInSiblings: indexInSiblings + 1 });
        inserted = true;
      }
    });
    if (hasPendingHere && !inserted) {
      rows.push({ node: pending.node, depth, dirPath, siblings: list, indexInSiblings: list.length });
    }
  };
  walk(nodes, 0, root);
  return rows;
}

/** order.json 里存的是磁盘名：页面带 .prg，目录就是目录名 */
export function fileNameOf(node: WorkspaceNode): string {
  return node.kind === "page" ? `${node.name}.prg` : node.name;
}
