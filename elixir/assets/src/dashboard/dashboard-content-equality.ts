import type { DashboardPayload } from "@/types/dashboard";

export function dashboardContentEqual(left: DashboardPayload | null, right: DashboardPayload | null) {
  if (left === null || right === null) return left === right;
  return jsonRecordEqual(left, right, true);
}

export function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!sameJsonType(left, right)) return false;
  return Array.isArray(left) ? jsonArrayEqual(left, right as unknown[]) : jsonRecordEqual(left as Record<string, unknown>, right as Record<string, unknown>);
}

function sameJsonType(left: unknown, right: unknown) {
  if (left == null || right == null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right);
  return typeof left === typeof right && isJsonRecord(left) && isJsonRecord(right);
}

function jsonArrayEqual(left: unknown[], right: unknown[]) {
  return left.length === right.length && left.every((value, index) => jsonValueEqual(value, right[index]));
}

function jsonRecordEqual(left: Record<string, unknown>, right: Record<string, unknown>, ignoreGeneratedAt = false): boolean {
  const leftKeys = comparableKeys(left, ignoreGeneratedAt);
  const rightKeys = comparableKeys(right, ignoreGeneratedAt);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every((key) => Object.hasOwn(right, key) && jsonValueEqual(left[key], right[key]));
}

function comparableKeys(value: Record<string, unknown>, ignoreGeneratedAt: boolean) {
  return Object.keys(value).filter((key) => !(ignoreGeneratedAt && key === "generated_at"));
}

export function reconciledValue<T>(current: T, next: T): T {
  return jsonValueEqual(current, next) ? current : next;
}

export function reconciledArrayById<T>(current: T[] | undefined, next: T[] | undefined, idOf: (item: T) => string): T[] | undefined {
  if (!next) return current;
  if (!current) return next;

  const currentById = new Map(current.map((item) => [idOf(item), item]));
  let changed = current.length !== next.length;
  const reconciled = next.map((item) => {
    const previous = currentById.get(idOf(item));
    const value = previous && jsonValueEqual(previous, item) ? previous : item;
    if (value !== previous) changed = true;
    return value;
  });

  return changed ? reconciled : current;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
