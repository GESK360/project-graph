import type { WorkspaceNode } from "@/core/service/workspace/WorkspaceManager";

/** 当前展开状态下的一次前序遍历结果：多选、拖拽落点、快捷键都按这个顺序算 */
export interface WorkspaceFlatRow {
  node: WorkspaceNode;
  depth: number;
  /** 这一行所在的目录路径；根层就是工作空间根目录 */
  dirPath: string;
  siblings: WorkspaceNode[];
  indexInSiblings: number;
}

export function flattenWorkspaceTree(
  nodes: WorkspaceNode[],
  collapsedDirs: ReadonlySet<string>,
  root: string,
  pending?: { dirPath: string; node: WorkspaceNode },
): WorkspaceFlatRow[] {
  const rows: WorkspaceFlatRow[] = [];
  const walk = (list: WorkspaceNode[], depth: number, dirPath: string) => {
    list.forEach((node, indexInSiblings) => {
      rows.push({ node, depth, dirPath, siblings: list, indexInSiblings });
      if (node.kind === "dir" && !collapsedDirs.has(node.path)) {
        walk(node.children, depth + 1, node.path);
      }
    });
    if (pending?.dirPath === dirPath) {
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
