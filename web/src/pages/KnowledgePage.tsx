import { KnowledgePanel } from "@/features/knowledge/KnowledgePanel";

export function KnowledgePage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="mb-1 text-lg font-semibold">Knowledge</h1>
      <p className="mb-5 text-sm text-ink-muted">
        Global store — available to every project. Skills are symlinked into your user-level Claude
        skills directory, so they load in every session. Per-project docs live in the project's own
        Knowledge tab.
      </p>
      <KnowledgePanel />
    </div>
  );
}
