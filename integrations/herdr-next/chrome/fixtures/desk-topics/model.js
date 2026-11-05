export function assign(state, space, topic, before = null, visibleOrder = []) {
  const next = JSON.parse(JSON.stringify(state));
  const destination = topic ? next.groups.find((g) => g.id === topic).spaces : (next.unsorted ??= []);
  for (const id of visibleOrder) if (!destination.includes(id)) destination.push(id);
  next.unsorted = (next.unsorted ?? []).filter((id) => id !== space);
  for (const group of next.groups) group.spaces = group.spaces.filter((id) => id !== space);
  const target = topic ? next.groups.find((g) => g.id === topic).spaces : next.unsorted;
  const at = before ? target.indexOf(before) : -1;
  target.splice(at < 0 ? target.length : at, 0, space);
  return next;
}

export function orderRows(rows, ids) {
  const positions = new Map(ids.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (positions.get(a.w.id) ?? Infinity) - (positions.get(b.w.id) ?? Infinity));
}
