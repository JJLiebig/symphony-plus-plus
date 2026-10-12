// Areas are how the operator thinks about the portfolio; repositories are only how work is filed.
// The mapping is operator-owned configuration and is never part of this code. Up to three levels are supported.
export type AreaRule = [pattern: string, area: string[]];

let rules: Array<[RegExp, string[]]> = [];

export function setAreas(next: AreaRule[]) {
  rules = next.map(([pattern, area]) => [new RegExp(pattern, "i"), area]);
}

export function areaFor(repo: string): string[] {
  return rules.find(([pattern]) => pattern.test(repo))?.[1] ?? ["Unfiled", repo.split("/").pop() || "Unknown"];
}

export function areaLabel(area: string[]) {
  return area.join(" › ");
}
