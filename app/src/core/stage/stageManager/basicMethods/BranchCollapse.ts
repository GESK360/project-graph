export interface BranchLink<T> {
  source: T;
  target: T;
  isBranchCollapsed: boolean;
}

function visit<T>(
  outgoing: ReadonlyMap<T, readonly BranchLink<T>[]>,
  pending: T[],
  visited: Set<T>,
  respectFolds = false,
) {
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const link of outgoing.get(node) ?? []) {
      if (!respectFolds || !link.isBranchCollapsed) pending.push(link.target);
    }
  }
}

export function getBranchSize<T>(outgoing: ReadonlyMap<T, readonly BranchLink<T>[]>, source: T, targets: T[]) {
  const visited = new Set([source]);
  visit(outgoing, [...targets], visited);
  return visited.size - 1;
}

export function findHiddenBranchNodes<T>(
  outgoing: ReadonlyMap<T, readonly BranchLink<T>[]>,
  collapsed: readonly BranchLink<T>[],
) {
  const hidden = new Set<T>();
  if (collapsed.length === 0) return hidden;

  visit(
    outgoing,
    collapsed.map((link) => link.target),
    hidden,
  );
  const visibleRoots = [...outgoing.keys()].filter((node) => !hidden.has(node));
  const reachable = new Set<T>();
  visit(outgoing, [...visibleRoots], reachable);
  // A component made solely of cycles still needs a visible control to reopen it.
  for (const link of collapsed) {
    if (reachable.has(link.source)) continue;
    visibleRoots.push(link.source);
    visit(outgoing, [link.source], reachable);
  }

  const visible = new Set<T>();
  visit(outgoing, visibleRoots, visible, true);
  for (const node of visible) hidden.delete(node);
  return hidden;
}
