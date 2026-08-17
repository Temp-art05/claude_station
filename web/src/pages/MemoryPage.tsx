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
        <h1 className="mb-1 text-lg font-semibold">Memory</h1>
      </div>
      <MemoryTab projectId={null} />
    </div>
  );
}
