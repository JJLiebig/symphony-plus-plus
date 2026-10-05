import { DetailFacts, DetailSection } from "@/components/dashboard/detail-layout";
import { workActivityFacts } from "@/lib/operational-state-activity";
import type { WorkPackageActivitySignal, WorkPackageReviewSignal } from "@/types/dashboard";

export function WorkActivity({ activity, review }: { activity?: WorkPackageActivitySignal | null; review?: WorkPackageReviewSignal | null }) {
  return <DetailSection title="Current activity"><WorkActivityFacts activity={activity} review={review} /></DetailSection>;
}

export function WorkActivityFacts({ activity, review }: { activity?: WorkPackageActivitySignal | null; review?: WorkPackageReviewSignal | null }) {
  return <DetailFacts facts={workActivityFacts(activity, review).map(({ label, value }) => [label, value])} />;
}
