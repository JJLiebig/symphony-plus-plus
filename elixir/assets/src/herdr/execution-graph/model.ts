import type { PackageOperationalState, WorkPackageActivitySignal, WorkPackageDependencySignal, WorkPackageMergeEligibility, WorkPackagePrSignal, WorkPackageReviewSignal, WorkPackageWorkerSignal } from "../work-request";
import { isFinishedBoardStatus } from "../operational-state";
export type GraphEntityKind = "group" | "work_package";
export type ExecutionGraphGroup = {
  id: string;
  parent_group_id?: string | null;
  title?: string | null;
  description?: string | null;
  position?: number;
  work_package_ids?: string[];
};

export type ExecutionGraphWorkPackageRef = {
  id: string;
  group_id?: string | null;
  sequence?: number;
  title?: string | null;
  repo?: string | null;
  base_branch?: string | null;
  status?: string | null;
  raw_status?: string | null;
  operational_state?: PackageOperationalState | null;
};
export type ExecutionGraphEffectiveEdge = {
  prerequisite_work_package_id: string;
  dependent_work_package_id: string;
  dependency_ids?: string[];
};
export type ExecutionGraphDependencyEndpoint = {
  kind: GraphEntityKind;
  id: string;
};
export type ExecutionGraphDependencyIntent = {
  id: string;
  prerequisite: ExecutionGraphDependencyEndpoint;
  dependent: ExecutionGraphDependencyEndpoint;
};
export type WorkRequestExecutionGraphModel = {
  available?: boolean;
  base_repo?: string | null;
  base_branch?: string | null;
  groups?: ExecutionGraphGroup[];
  work_packages: Array<ExecutionGraphWorkPackageRef & ExecutionGraphWorkPackageSignals>;
  dependency_intents?: ExecutionGraphDependencyIntent[];
  effective_edges?: ExecutionGraphEffectiveEdge[];
  topological_order?: string[];
  cycles?: string[][];
};
export type ExecutionGraphWorkPackageSignals = {
  id: string;
  raw_status?: string | null;
  operational_state?: ExecutionGraphWorkPackageRef["operational_state"];
  worker_signal?: WorkPackageWorkerSignal | null;
  pr_signal?: WorkPackagePrSignal | null;
  review_signal?: WorkPackageReviewSignal | null;
  dependency_signal?: WorkPackageDependencySignal | null;
  activity_signal?: WorkPackageActivitySignal | null;
  merge_eligibility?: WorkPackageMergeEligibility | null;
};

export function workPackageIsFinished(ref?: ExecutionGraphWorkPackageRef, signal?: ExecutionGraphWorkPackageSignals) {
  const operational = signal?.operational_state ?? ref?.operational_state;
  return [signal?.raw_status, ref?.raw_status, ref?.status, operational?.key].some(isFinishedBoardStatus);
}

export function operationalStateIsBlocked(operational?: ExecutionGraphWorkPackageRef["operational_state"]) { const source = [operational?.key, operational?.label].filter(Boolean).join(" ").toLowerCase(); return /block/.test(source) && !/depend/.test(source); }
