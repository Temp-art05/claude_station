import { Gauge } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { InsightsTab } from "@/features/insights/InsightsTab";

/**
 * Consumption across every project, from the session ledger.
 *
 * A project's own History tab answers "what did this session do"; this answers
 * "where did the month go" — and, next to it, whether capture is still whole
 * enough for the answer to mean anything.
 */
export function InsightsPage() {
  return (
    <div className="mx-auto h-full max-w-6xl overflow-y-auto py-6">
      <div className="px-6">
        <PageHeader
          title="Mission control"
          supporting="What the agents consumed, and whether the record can be trusted."
          icon={Gauge}
        />
      </div>
      <InsightsTab />
    </div>
  );
}
