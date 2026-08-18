import { BookOpen } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { KnowledgePanel } from "@/features/knowledge/KnowledgePanel";

export function KnowledgePage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <PageHeader
        title="Knowledge"
        icon={BookOpen}
        supporting="Global store — available to every project. Skills are symlinked into your user-level Claude skills directory, so they load in every session. Per-project docs live in the project's own Knowledge tab."
      />
      <KnowledgePanel />
    </div>
  );
}
