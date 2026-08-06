import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Sparkles } from "lucide-react";
import type { Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/input";
import { api } from "@/lib/api";

interface Props {
  /** Endpoint that creates a seeded claude terminal, e.g. /api/jira/issues/ABC-1/work-with-claude */
  endpoint: string;
  label?: string;
}

/**
 * Creates a claude terminal server-side (so the seed context is built there) and
 * drops the user into it with the prompt typed into the CLI — never auto-sent.
 */
export function WorkWithClaude({ endpoint, label = "Work on this with Claude" }: Props) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [pathId, setPathId] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/api/projects"),
    enabled: open,
  });
  const project = projects.find((p) => p.id === projectId);

  const start = useMutation({
    mutationFn: () =>
      api.post<{ terminalId: string; seed: string }>(endpoint, {
        projectId,
        cwdPathId: pathId || undefined,
        useWorktree,
      }),
    onSuccess: ({ terminalId, seed }) => {
      setOpen(false);
      navigate(
        `/projects/${projectId}?tab=chat&terminal=${terminalId}&seed=${encodeURIComponent(seed)}`,
      );
    },
  });

  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        <Sparkles size={13} /> {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Open a Claude terminal">
        <div className="space-y-3">
          <div>
            <Label>Project</Label>
            <select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setPathId("");
              }}
              className="h-9 w-full rounded-md border border-edge bg-surface px-2 text-sm text-ink"
            >
              <option value="">Choose a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {project && (
            <div>
              <Label>Working directory</Label>
              <select
                value={pathId}
                onChange={(e) => setPathId(e.target.value)}
                className="h-9 w-full rounded-md border border-edge bg-surface px-2 text-sm text-ink"
              >
                <option value="">Default path</option>
                {project.paths.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
              className="accent-(--color-accent)"
            />
            Own git worktree (safe to run in parallel)
          </label>
          {start.isError && (
            <p className="text-xs text-err">
              {start.error instanceof Error ? start.error.message : "Failed"}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!projectId || start.isPending}
              onClick={() => start.mutate()}
            >
              {start.isPending ? "Creating…" : "Open terminal"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
