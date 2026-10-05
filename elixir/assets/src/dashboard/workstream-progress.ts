import type { ActiveBlockingEdge, WorkRequestPackage, WorkPackageCard, WorkRequestDetail } from "@/types/dashboard";
import { terminalWorkPackageIds, workRequestIsTerminal } from "./workstream-row-state";

export type ActiveBlockerEntityCounts = {
  requests: Map<string, number>;
  slices: Map<string, number>;
  packages: Map<string, number>;
  sliceBlockerKeys: Map<string, Set<string>>;
};

type BlockerRequestCache = {
  edges: ActiveBlockingEdge[];
  result: ActiveBlockingEdge[];
};

const blockerRequestCache = new WeakMap<WorkRequestDetail, BlockerRequestCache>();

export function productTreeCounts(detail: WorkRequestDetail, activeBlockerCount: number) {
  const summary = detail.product_tree?.summary;

  return {
    nodeCount: numberValue(summary?.node_count, detail.product_tree?.nodes?.length),
    sliceCount: numberValue(summary?.work_package_count, detail.work_packages?.length),
    guidanceCount: numberValue(detail.summary?.open_question_count, detail.work_request.open_question_count, openQuestionCount(detail)),
    blockerCount: activeBlockerCount,
  };
}

export function activeBlockerEntityCounts(
  edges: ActiveBlockingEdge[],
  requestDetails: WorkRequestDetail[] = [],
  packageById = new Map<string, WorkPackageCard>(),
): ActiveBlockerEntityCounts {
  const requestIndex = blockerRequestIndex(requestDetails);
  const terminalPackageIds = terminalWorkPackageIds(requestDetails, packageById);
  const terminalRequestIds = new Set(requestDetails.filter(workRequestIsTerminal).map((detail) => detail.work_request.id));
  const blockerKeys = edges.filter((edge) => !edgeTargetsTerminalPackage(edge, terminalPackageIds)).reduce<ActiveBlockerEntityKeySets>((keys, edge) => {
    const blockerKey = activeBlockerKey(edge);

    addBlockerKeys(keys.requests, [...activeBlockerRequestIds(edge, requestIndex)].filter((id) => !terminalRequestIds.has(id)), blockerKey);
    addBlockerKeys(keys.slices, [...activeBlockerSliceIds(edge, requestIndex)].filter((id) => !terminalPackageIds.has(id)), blockerKey);
    addBlockerKeys(keys.packages, [...activeBlockerPackageIds(edge)].filter((id) => !terminalPackageIds.has(id)), blockerKey);

    return keys;
  }, { requests: new Map(), slices: new Map(), packages: new Map() });

  return {
    requests: blockerKeyCounts(blockerKeys.requests),
    slices: blockerKeyCounts(blockerKeys.slices),
    packages: blockerKeyCounts(blockerKeys.packages),
    sliceBlockerKeys: blockerKeys.slices,
  };
}

function edgeTargetsTerminalPackage(edge: ActiveBlockingEdge, terminalPackageIds: Set<string>) {
  const targetId = edge.to.kind === "work_package" && edge.to.id ? edge.to.id : edge.work_package_id;
  return Boolean(targetId && terminalPackageIds.has(targetId));
}

export function activeBlockerEdgesForRequest(edges: ActiveBlockingEdge[], detail: WorkRequestDetail) {
  const cached = blockerRequestCache.get(detail);
  if (cached?.edges === edges) return cached.result;

  const requestId = detail.work_request.id;
  const requestIndex = blockerRequestIndex([detail]);
  const result = edges.filter((edge) => activeBlockerRequestIds(edge, requestIndex).has(requestId));
  blockerRequestCache.set(detail, { edges, result });
  return result;
}

type ActiveBlockerEntityKeySets = {
  requests: Map<string, Set<string>>;
  slices: Map<string, Set<string>>;
  packages: Map<string, Set<string>>;
};

type BlockerRequestIndex = {
  requestIdBySliceId: Map<string, string>;
  requestIdsByPackageId: Map<string, Set<string>>;
  sliceIdsByPackageId: Map<string, Set<string>>;
};

function blockerRequestIndex(requestDetails: WorkRequestDetail[]): BlockerRequestIndex {
  const requestIdBySliceId = new Map<string, string>();
  const requestIdsByPackageId = new Map<string, Set<string>>();
  const sliceIdsByPackageId = new Map<string, Set<string>>();

  for (const detail of requestDetails) {
    const requestId = detail.work_request.id;
    for (const slice of detail.work_packages ?? []) {
      requestIdBySliceId.set(slice.id, requestId);
      if (!slice.work_package_id) continue;

      const requestIds = requestIdsByPackageId.get(slice.work_package_id) ?? new Set<string>();
      requestIds.add(requestId);
      requestIdsByPackageId.set(slice.work_package_id, requestIds);

      const sliceIds = sliceIdsByPackageId.get(slice.work_package_id) ?? new Set<string>();
      sliceIds.add(slice.id);
      sliceIdsByPackageId.set(slice.work_package_id, sliceIds);
    }
  }

  return { requestIdBySliceId, requestIdsByPackageId, sliceIdsByPackageId };
}

function activeBlockerRequestIds(edge: ActiveBlockingEdge, requestIndex: BlockerRequestIndex) {
  const derivedRequestIds = new Set<string>();
  if (edge.work_request_id) derivedRequestIds.add(edge.work_request_id);
  if (edge.work_package_id) {
    const requestId = requestIndex.requestIdBySliceId.get(edge.work_package_id);
    if (requestId) derivedRequestIds.add(requestId);
  }
  if (edge.work_package_id) {
    for (const requestId of requestIndex.requestIdsByPackageId.get(edge.work_package_id) ?? []) {
      derivedRequestIds.add(requestId);
    }
  }
  addEndpointRequestIds(derivedRequestIds, requestIndex, edge.to);
  return derivedRequestIds;
}

function activeBlockerSliceIds(edge: ActiveBlockingEdge, requestIndex: BlockerRequestIndex) {
  const sliceIds = new Set<string>();
  if (edge.work_package_id) sliceIds.add(edge.work_package_id);
  if (edge.work_package_id) {
    for (const sliceId of requestIndex.sliceIdsByPackageId.get(edge.work_package_id) ?? []) {
      sliceIds.add(sliceId);
    }
  }
  addEndpointSliceIds(sliceIds, requestIndex, edge.to);
  return sliceIds;
}

function activeBlockerPackageIds(edge: ActiveBlockingEdge) {
  const packageIds = new Set<string>();
  if (edge.work_package_id) packageIds.add(edge.work_package_id);
  addEndpointPackageIds(packageIds, edge.to);
  return packageIds;
}

function addEndpointRequestIds(
  requestIds: Set<string>,
  requestIndex: BlockerRequestIndex,
  endpoint?: ActiveBlockingEdge["from"],
) {
  if (!endpoint) return;

  if (endpoint.kind === "work_package") {
    for (const requestId of requestIndex.requestIdsByPackageId.get(endpoint.id) ?? []) {
      requestIds.add(requestId);
    }
  }
}

function addEndpointSliceIds(
  sliceIds: Set<string>,
  requestIndex: BlockerRequestIndex,
  endpoint?: ActiveBlockingEdge["from"],
) {
  if (!endpoint) return;

  if (endpoint.kind === "work_package") {
    for (const sliceId of requestIndex.sliceIdsByPackageId.get(endpoint.id) ?? []) {
      sliceIds.add(sliceId);
    }
  }
}

function addEndpointPackageIds(packageIds: Set<string>, endpoint?: ActiveBlockingEdge["from"]) {
  if (endpoint?.kind === "work_package") packageIds.add(endpoint.id);
}

function activeBlockerKey(edge: ActiveBlockingEdge) {
  return edge.blocker_id || edge.id;
}

function addBlockerKeys(blockerKeysByEntityId: Map<string, Set<string>>, ids: Iterable<string>, blockerKey: string) {
  for (const id of ids) {
    const blockerKeys = blockerKeysByEntityId.get(id) ?? new Set<string>();
    blockerKeys.add(blockerKey);
    blockerKeysByEntityId.set(id, blockerKeys);
  }
}

function blockerKeyCounts(blockerKeysByEntityId: Map<string, Set<string>>) {
  return new Map([...blockerKeysByEntityId].map(([id, blockerKeys]) => [id, blockerKeys.size]));
}

export function rootProductSliceIds(detail: WorkRequestDetail, slices: WorkRequestPackage[]) {
  const productTree = detail.product_tree;
  if (!productTree) return slices.map((slice) => slice.id);

  const explicitRootSliceIds = productTree.root_work_package_ids ?? [];
  if (explicitRootSliceIds.length > 0) return explicitRootSliceIds;

  const nestedSliceIds = new Set((productTree.nodes ?? []).flatMap((node) => node.work_package_ids ?? []));
  const rootSliceIds: string[] = [];

  for (const slice of slices) {
    if (!nestedSliceIds.has(slice.id)) rootSliceIds.push(slice.id);
  }

  return rootSliceIds;
}

function openQuestionCount(detail: WorkRequestDetail) {
  return (detail.clarification_questions ?? []).filter((question) => question.status === "open").length;
}

function numberValue(...values: Array<number | null | undefined>) {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value)) ?? 0;
}
