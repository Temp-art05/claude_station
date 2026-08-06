import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useDeleteProject } from "./hooks";

/**
 * Deleting a project is the one action here that reaches outside the database —
 * it kills running shells and removes files. The dialog spells that out rather
 * than asking "are you sure?", because that is the part a user cannot undo.
 */
export function DeleteProjectDialog({
  project,
  open,
  onClose,
  onDeleted,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const del = useDeleteProject();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    del.mutate(project.id, {
      onSuccess: () => {
        onClose();
        onDeleted?.();
      },
      onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Delete project" className="max-w-md">
      <div className="flex gap-3">
        <TriangleAlert size={18} className="mt-0.5 shrink-0 text-err" />
        <div className="space-y-3">
          <p className="text-sm">
            Delete <span className="font-medium">{project.name}</span> and everything it holds?
            This cannot be undone.
          </p>
          <ul className="list-disc space-y-1 pl-4 text-xs text-ink-muted">
            <li>Running terminals and commands are killed</li>
            <li>Chat sessions, workflow runs and their artifacts are removed</li>
            <li>Knowledge uploaded into this project is deleted from disk</li>
            <li>Session worktrees are removed from your repos</li>
          </ul>
          <p className="text-xs text-ink-muted">
            <span className="text-ok">Kept:</span> env sets owned by this project become global, so
            other projects can keep using them. Knowledge attached from the library stays in the
            library, and your repositories are never touched — only the{" "}
            {project.paths.length === 1 ? "path" : "paths"} registered here.
          </p>
          {error && <p className="text-xs text-err">{error}</p>}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={del.isPending}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" onClick={submit} disabled={del.isPending}>
          {del.isPending ? "Deleting…" : "Delete project"}
        </Button>
      </div>
    </Dialog>
  );
}
