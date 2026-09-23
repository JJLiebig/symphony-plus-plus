export function topologicalEntityOrder(
  keys: string[],
  dependencies: Array<{ source: string; target: string }>,
  compareEntityKeys: (left: string, right: string) => number,
) {
  const incoming = new Map(keys.map((key) => [key, 0]));
  const predecessors = groupBy(dependencies, (dependency) => dependency.target);
  const outgoing = groupBy(dependencies, (dependency) => dependency.source);
  const placed = new Map<string, number>();
  const compareReady = (left: string, right: string) => {
    const affinity = (key: string) => (predecessors.get(key) ?? [])
      .map((dependency) => placed.get(dependency.source))
      .filter((value): value is number => value != null);
    const leftParents = affinity(left);
    const rightParents = affinity(right);
    return (Math.max(-1, ...rightParents) - Math.max(-1, ...leftParents))
      || (rightParents.length - leftParents.length)
      || compareEntityKeys(left, right);
  };
  dependencies.forEach((dependency) => incoming.set(dependency.target, (incoming.get(dependency.target) ?? 0) + 1));
  const ready = keys.filter((key) => (incoming.get(key) ?? 0) === 0).sort(compareReady);
  const insertReady = (key: string, start: number) => {
    let low = start;
    let high = ready.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareReady(ready[middle] as string, key) <= 0) low = middle + 1;
      else high = middle;
    }
    ready.splice(low, 0, key);
  };
  const order: string[] = [];
  let readyIndex = 0;
  while (readyIndex < ready.length) {
    const key = ready[readyIndex] as string;
    readyIndex += 1;
    order.push(key);
    placed.set(key, order.length - 1);
    for (const dependency of outgoing.get(key) ?? []) {
      const next = (incoming.get(dependency.target) ?? 0) - 1;
      incoming.set(dependency.target, next);
      if (next === 0) insertReady(dependency.target, readyIndex);
    }
  }
  return order.length === keys.length ? order : keys.toSorted(compareEntityKeys);
}

function groupBy<T>(items: T[], keyOf: (item: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const values = grouped.get(key);
    if (values) values.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}
