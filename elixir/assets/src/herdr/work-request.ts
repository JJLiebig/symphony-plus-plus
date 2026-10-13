import type { ProductTreeProjection } from "./product-tree";
import type { WorkPackageActivitySignal, WorkPackageDependencySignal, WorkPackageMergeEligibility, WorkPackagePrSignal, WorkPackageReviewSignal, WorkPackageWorkerSignal } from "./delivery-signals";
export type * from "./delivery-signals";

export type PackageOperationalAttention = {
  key?: string;
  label?: string;
  tone?: string;
  reason?: string;
  blocker_ids?: string[];
  missing?: string[];
  successor_work_package_ids?: string[];
  original_work_package_ids?: string[];
  error?: string;
};

export type PackageOperationalState = {
  activity_signal?: WorkPackageActivitySignal | null;
  key?: string | null;
  label?: string | null;
  tone?: string | null;
  reason?: string | null;
  raw_status?: string | null;
  delivery_outcome?: string | null;
  work_package_status?: string | null;
  merge_required?: boolean | null;
  pr_required?: boolean | null;
  attention_reason_codes?: string[];
  has_started?: boolean;
  has_active_worker?: boolean;
  last_activity_at?: string | null;
  is_stale?: boolean;
  attention_items?: PackageOperationalAttention[];
};

export type WorkRequestPackage = {
  id: string;
  work_request_id: string;
  product_tree_node_id?: string | null;
  sequence?: number;
  title?: string | null;
  repo?: string | null;
  status?: string | null;
  work_package_status?: string | null;
  base_branch?: string | null;
  operational_state?: PackageOperationalState | null;
  worker_signal?: WorkPackageWorkerSignal | null;
  pr_signal?: WorkPackagePrSignal | null;
  review_signal?: WorkPackageReviewSignal | null;
  dependency_signal?: WorkPackageDependencySignal | null;
  activity_signal?: WorkPackageActivitySignal | null;
  merge_eligibility?: WorkPackageMergeEligibility | null;
  delivery?: { outcome?: string | null } | null;
};

export type WorkRequestDetail = {
  work_request: {
    id: string;
    title?: string | null;
    repo?: string | null;
    repo_key?: string | null;
    base_branch?: string | null;
  };
  work_packages?: WorkRequestPackage[];
  product_tree?: ProductTreeProjection | null;
};
