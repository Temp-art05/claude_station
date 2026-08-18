import { Brain } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { MemoryTab } from "@/features/memory/MemoryTab";

/**
 * The global memory store. Notes here are added to every session in every
 * project, ahead of that project's own — this is where working rules live, as
 * opposed to facts about one repo.
 */
export function MemoryPage() {
  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-0 py-6">
      <div className="px-6">
        <PageHeader title="Memory" icon={Brain} className="mb-4" />
      </div>
      <MemoryTab projectId={null} />
    </div>
  );
}
