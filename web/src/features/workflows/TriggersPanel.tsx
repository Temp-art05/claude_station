/**
 * Standing orders — the difference between a workflow you run and a workflow
 * that runs.
 *
 * Kept deliberately blunt: what it watches, whether it is armed, when it last
 * looked, and what it saw. A trigger that quietly errors every two minutes is
 * the failure that costs the most trust, so the last result is always on screen
 * rather than behind a click.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, Workflow, WorkflowTrigger } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { Play, Trash2 } from "@/components/ui/icons";

export function TriggersPanel({ project, workflows }: { project: Project; workflows: Workflow[] }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);

  const key = ["workflow-triggers", project.id];
  const { data: triggers = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<WorkflowTrigger[]>(`/api/projects/${project.id}/workflow-triggers`),
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: key });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<WorkflowTrigger>(`/api/projects/${project.id}/workflow-triggers`, body),
    onSuccess: () => {
      setAdding(false);
      invalidate();
    },
  });
  const toggle = useMutation({
    mutationFn: (t: WorkflowTrigger) =>
      api.put<WorkflowTrigger>(`/api/workflow-triggers/${t.id}`, { ...t, enabled: !t.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/workflow-triggers/${id}`),
    onSuccess: invalidate,
  });
  const poll = useMutation({
    mutationFn: (id: string) =>
      api.post<{ found: number; started: string | null }>(`/api/workflow-triggers/${id}/poll`, {}),
    onSuccess: invalidate,
  });

  if (workflows.length === 0) return null;

  return (
    <div className="mb-5">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-xs font-bold tracking-wide text-ink-faint uppercase">
          Triggers — work that starts itself
        </p>
        <Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Add trigger"}
        </Button>
      </div>

      {triggers.length === 0 && !adding && (
        <p className="text-xs text-ink-muted">
          Nothing armed. A trigger watches a GitHub label or a Jira search and starts a run when
          matching work shows up — the master switch lives in Settings.
        </p>
      )}

      <div className="space-y-1.5">
        {triggers.map((t) => (
          <Card key={t.id} className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={t.enabled ? "accent" : "default"}>{t.enabled ? "armed" : "off"}</Badge>
                <Badge>{t.source}</Badge>
                <span className="font-mono text-sm">{t.query}</span>
                {t.repo && <span className="m3-label-sm text-ink-faint">{t.repo}</span>}
                <span className="m3-label-sm text-ink-faint">
                  → {workflows.find((w) => w.id === t.workflowId)?.name ?? "(missing workflow)"}
                </span>
                {t.autoMode && <Badge tone="accent">unattended</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-ink-muted">
                Every {t.pollSeconds}s
                {t.lastPolledAt
                  ? ` · last looked ${new Date(t.lastPolledAt).toLocaleString()}`
                  : ""}
                {t.detail ? ` · ${t.detail}` : ""}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={poll.isPending}
              title="Look now, instead of finding out in two minutes that the query matches nothing"
              onClick={() => poll.mutate(t.id)}
            >
              <Play size={16} /> Check now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => toggle.mutate(t)}>
              {t.enabled ? "Disarm" : "Arm"}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Delete trigger"
              onClick={() =>
                void confirm({
                  title: "Delete this trigger?",
                  body: "Runs it already started stay; it just stops watching.",
                  confirmLabel: "Delete",
                }).then((ok) => ok && remove.mutate(t.id))
              }
            >
              <Trash2 size={16} />
            </Button>
          </Card>
        ))}
      </div>

      {adding && (
        <TriggerForm
          project={project}
          workflows={workflows}
          pending={save.isPending}
          error={save.error instanceof Error ? save.error.message : null}
          onSubmit={(body) => save.mutate(body)}
        />
      )}
    </div>
  );
}

function TriggerForm({
  project,
  workflows,
  pending,
  error,
  onSubmit,
}: {
  project: Project;
  workflows: Workflow[];
  pending: boolean;
  error: string | null;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id ?? "");
  const [source, setSource] = useState<"github" | "jira">("github");
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState("");
  const [pathId, setPathId] = useState(project.paths[0]?.id ?? "");
  const [pollSeconds, setPollSeconds] = useState(120);

  return (
    <Card className="mt-2 space-y-2.5 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Start this workflow</Label>
          <Select
            className="w-full"
            value={workflowId}
            onChange={setWorkflowId}
            options={workflows.map((w) => ({ value: w.id, label: w.name }))}
          />
        </div>
        <div>
          <Label>Watch</Label>
          <Select
            className="w-full"
            value={source}
            onChange={(v) => setSource(v as "github" | "jira")}
            options={[
              { value: "github", label: "GitHub issues with a label" },
              { value: "jira", label: "Jira — a JQL search" },
            ]}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>{source === "github" ? "Label" : "JQL"}</Label>
          <Input
            className="font-mono text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              source === "github" ? "ai-feature" : 'labels = "AI-Feature" AND status = "To Do"'
            }
          />
          <p className="mt-1 m3-label-sm text-ink-faint">
            Keep it broad enough to actually match. A query that never fires looks exactly like a
            quiet week.
          </p>
        </div>
        <div>
          <Label>
            {source === "github" ? "Repo (blank = all configured)" : "Working directory"}
          </Label>
          {source === "github" ? (
            <Input
              className="font-mono text-xs"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo"
            />
          ) : (
            <Select
              className="w-full"
              value={pathId}
              onChange={setPathId}
              options={project.paths.map((p) => ({ value: p.id, label: p.label }))}
            />
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {source === "github" && (
          <div>
            <Label>Working directory</Label>
            <Select
              className="w-full"
              value={pathId}
              onChange={setPathId}
              options={project.paths.map((p) => ({ value: p.id, label: p.label }))}
            />
          </div>
        )}
        <div>
          <Label>Check every (seconds)</Label>
          <Input
            type="number"
            value={pollSeconds}
            onChange={(e) => setPollSeconds(Math.max(30, Number(e.target.value) || 120))}
          />
        </div>
      </div>
      {error && <p className="text-xs text-err">{error}</p>}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={pending || !workflowId || !query.trim()}
          onClick={() =>
            onSubmit({
              workflowId,
              source,
              query: query.trim(),
              repo: source === "github" ? repo.trim() || null : null,
              enabled: false,
              autoMode: true,
              askPolicy: "stop",
              pollSeconds,
              cwdPathId: pathId || null,
              envSetId: null,
            })
          }
        >
          {pending ? "Saving…" : "Add — disarmed"}
        </Button>
      </div>
      <p className="m3-label-sm text-ink-faint">
        It is created disarmed on purpose. Arm it when you have read what it would start.
      </p>
    </Card>
  );
}
