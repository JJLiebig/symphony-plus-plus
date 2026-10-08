import { DetailFacts, DetailSection } from "@/components/dashboard/detail-layout";
import { workActivityFacts, workActivityFields } from "@/lib/operational-state-activity";
import type { WorkPackageActivitySignal, WorkPackageMergeEligibility, WorkPackageReviewSignal } from "@/types/dashboard";

type WorkActivityProps = { activity?: WorkPackageActivitySignal | null; review?: WorkPackageReviewSignal | null; eligibility?: WorkPackageMergeEligibility | null };

export function WorkActivity(props: WorkActivityProps) {
  return <DetailSection title="Current activity"><WorkActivityFacts {...props} /></DetailSection>;
}

export function WorkActivityFacts({ activity, review, eligibility }: WorkActivityProps) {
  return <DetailFacts facts={workActivityFacts(activity, review, eligibility).map(({ label, value }) => [label, value])} />;
}

// Phrasing-only markup so the same labeled facts can sit inside row buttons.
export function WorkActivityFields({ activity, review, eligibility }: WorkActivityProps) {
  return (
    <span className="work-activity-fields">
      {workActivityFields(activity, review, eligibility).map((field) => (
        <span key={field.key} className="work-activity-field" data-field={field.key} data-human={field.human ? "true" : undefined} data-unknown={field.unknown ? "true" : undefined}>
          <span className="work-activity-field__label">{field.label}</span>
          <span className="work-activity-field__value">{field.value}</span>
        </span>
      ))}
    </span>
  );
}
