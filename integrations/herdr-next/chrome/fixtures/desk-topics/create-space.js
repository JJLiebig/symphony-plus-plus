import { exec, spaces, shared, setShared, notify } from "herdr";
import { assign, orderRows } from "./model.js";

export async function createSpace(topic, machine) {
  let made;
  try {
    const result = await exec("herdr-app", ["do", "space.new", JSON.stringify(machine ? { machine } : {})]);
    made = JSON.parse(result.stdout);
    if (result.code !== 0 || !made.space) throw new Error(made.error || "No space was returned.");
  } catch (error) {
    // The command can time out after creating a space, so never retry or guess its ID.
    notify({ title: "Space creation not confirmed", body: `${error.message} Check Other spaces before trying again.`, level: "error" });
    return null;
  }
  const data = shared("desk.topics") ?? { groups: [], unsorted: [] };
  const group = data.groups.find((g) => g.id === topic);
  if (topic && !group) {
    notify({ title: "Topic was removed", body: "The new space is in Other spaces." });
    return made;
  }
  const assigned = new Set(data.groups.flatMap((g) => g.spaces));
  const rows = spaces().filter((s) => group ? group.spaces.includes(s.id) : !assigned.has(s.id)).map((w) => ({ w }));
  const visible = orderRows(rows, group?.spaces ?? data.unsorted ?? []).map((r) => r.w.id);
  const next = assign(data, made.space, topic, null, visible);
  if (group) next.groups.find((g) => g.id === topic).folded = false;
  setShared("desk.topics", next);
  return made;
}
