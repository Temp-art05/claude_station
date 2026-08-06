import { useState } from "react";
import { Link } from "react-router";
import { ChevronLeft, Import, Play, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import type { EnvSet, Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { RunView } from "./RunView";
import {
  useImportToProject,
  useRemoveFromProject,
  useRuns,
  useStartRun,
  useWorkflowFolders,
  useWorkflows,
} from "./hooks";

interface Props {
  project: Project;
  envSets: EnvSet[];
}

export function WorkflowsTab({ project, envSets }: Props) {
  const { data: workflows = [] } = useWorkflows(project.id);
  const { data: runs = [] } = useRuns(project.id);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [startFor, setStartFor] = useState<string | null>(null);

  const imported = workflows.filter((w) => w.imported);

  if (openRun) {
    return (
      <div className="h-full overflow-y-auto px-6 py-4">
        <Button size="sm" variant="ghost" className="mb-3" onClick={() => setOpenRun(null)}>
          <ChevronLeft size={14} /> All workflows
        </Button>
        <RunView runId={openRun} projectId={project.id} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="text-sm text-ink-muted">
          A workflow runs your usual sequence — read docs, plan, confirm, implement, test — with a
          stop for your decisions wherever it needs them.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={() => setImportOpen(true)}>
            <Import size={14} /> Import workflows
          </Button>
          <Link to="/workflows">
            <Button variant="ghost">Manage library →</Button>
          </Link>
        </div>
      </div>

      {imported.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <WorkflowIcon size={26} className="text-ink-faint" />
          <p className="text-sm font-medium">No workflows imported</p>
          <p className="max-w-md text-xs text-ink-muted">
            Import one from the library — there are presets for an iOS/mobile feature, a frontend
            feature, and a bugfix driven from a Jira issue.
          </p>
          <Button variant="primary" onClick={() => setImportOpen(true)}>
            <Import size={14} /> Import workflows
          </Button>
        </Card>
      ) : (
        <div className="mb-5 space-y-2">
          {imported.map((w) => (
            <Card key={w.id} className="flex items-start gap-3 p-3">
              <WorkflowIcon size={15} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-sm">{w.name}</span>
                  {w.folder && <Badge tone="accent">{w.folder}</Badge>}
                  <Badge>{w.steps.length} steps</Badge>
                </div>
                {w.description && (
                  <p className="mt-0.5 text-xs text-ink-muted">{w.description}</p>
                )}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {w.steps.map((s) => (
                    <span
                      key={s.key}
                      title={`${s.type}${s.agentName ? ` · ${s.agentName}` : ""}${s.condition ? ` · if ${s.condition}` : ""}`}
                      className={cn(
                        "rounded-pill border px-1.5 py-0.5 font-mono text-[10px]",
                        s.type === "agent"
                          ? "border-accent/30 bg-accent/10 text-accent"
                          : s.type === "command"
                            ? "border-hairline bg-white/6 text-ink-muted"
                            : "border-warn/30 bg-warn/10 text-warn",
                      )}
                    >
                      {s.key}
                    </span>
                  ))}
                </div>
              </div>
              <Button size="sm" variant="primary" onClick={() => setStartFor(w.id)}>
                <Play size={12} /> Run
              </Button>
              <RemoveButton projectId={project.id} workflowId={w.id} />
            </Card>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <>
          <p className="mb-1.5 text-xs font-bold tracking-wide text-ink-faint uppercase">Runs</p>
          <div className="space-y-1.5">
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setOpenRun(r.id)}
                className="glass flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:border-hairline-strong"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    r.status === "running" || r.status === "pending"
                      ? "bg-warn animate-status"
                      : r.status === "awaiting_input"
                        ? "bg-warn"
                        : r.status === "done"
                          ? "bg-ok"
                          : "bg-err",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
                <Badge
                  tone={
                    r.status === "done"
                      ? "ok"
                      : r.status === "failed" || r.status === "cancelled"
                        ? "err"
                        : "accent"
                  }
                >
                  {r.status === "awaiting_input" ? "needs you" : r.status}
                </Badge>
                <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">
                  {r.completedSteps}/{r.totalSteps}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {importOpen && (
        <ImportDialog projectId={project.id} onClose={() => setImportOpen(false)} />
      )}
      {startFor && (
        <StartDialog
          project={project}
          envSets={envSets}
          workflowId={startFor}
          onClose={() => setStartFor(null)}
          onStarted={(runId) => {
            setStartFor(null);
            setOpenRun(runId);
          }}
        />
      )}
    </div>
  );
}

function RemoveButton({ projectId, workflowId }: { projectId: string; workflowId: string }) {
  const remove = useRemoveFromProject(projectId);
  return (
    <Button
      size="icon"
      variant="ghost"
      title="Remove from this project (keeps it in the library)"
      onClick={() => remove.mutate(workflowId)}
      aria-label="Remove workflow"
    >
      <Trash2 size={14} />
    </Button>
  );
}

function ImportDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { data: workflows = [] } = useWorkflows();
  const { data: folders = [] } = useWorkflowFolders();
  const { data: projectWorkflows = [] } = useWorkflows(projectId);
  const importer = useImportToProject(projectId);
  const [folder, setFolder] = useState<string | null>(null);

  const alreadyIn = new Set(projectWorkflows.filter((w) => w.imported).map((w) => w.id));
  const visible = workflows.filter((w) => folder === null || w.folder === folder);

  return (
    <Dialog open onClose={onClose} title="Import workflows" className="max-w-2xl">
      <div className="space-y-3">
        <p className="text-xs text-ink-muted">
          Workflows stay in the library — importing makes them runnable in this project.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setFolder(null)}
            className={cn(
              "cursor-pointer rounded-pill border px-2.5 py-1 text-xs",
              folder === null
                ? "border-accent/40 bg-accent/12 text-accent"
                : "border-hairline text-ink-muted hover:text-ink",
            )}
          >
            all
          </button>
          {folders.map((f) => (
            <button
              key={f.folder}
              onClick={() => setFolder(f.folder)}
              className={cn(
                "cursor-pointer rounded-pill border px-2.5 py-1 text-xs",
                folder === f.folder
                  ? "border-accent/40 bg-accent/12 text-accent"
                  : "border-hairline text-ink-muted hover:text-ink",
              )}
            >
              {f.folder || "unfiled"} · {f.count}
            </button>
          ))}
        </div>

        <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-hairline p-2">
          {visible.length === 0 && (
            <p className="px-1 py-2 text-xs text-ink-faint">Nothing here yet.</p>
          )}
          {visible.map((w) => (
            <div key={w.id} className="flex items-center gap-2 rounded-md px-1.5 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{w.name}</span>
              <Badge>{w.steps.length} steps</Badge>
              {alreadyIn.has(w.id) ? (
                <Badge tone="ok">imported</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => importer.mutate({ workflowIds: [w.id] })}
                  disabled={importer.isPending}
                >
                  import
                </Button>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-faint">
            {folder === null ? "Pick a folder to import it whole." : `Import all of "${folder || "unfiled"}".`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              disabled={folder === null || importer.isPending}
              onClick={() => folder !== null && importer.mutate({ folder }, { onSuccess: onClose })}
            >
              Import folder
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function StartDialog({
  project,
  envSets,
  workflowId,
  onClose,
  onStarted,
}: {
  project: Project;
  envSets: EnvSet[];
  workflowId: string;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const start = useStartRun(project.id);
  const [pathId, setPathId] = useState(project.paths[0]?.id ?? "");
  const [envSetId, setEnvSetId] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);

  return (
    <Dialog open onClose={onClose} title="Start workflow run">
      <div className="space-y-3">
        <div>
          <Label>Working directory</Label>
          <select
            value={pathId}
            onChange={(e) => setPathId(e.target.value)}
            className="h-9 w-full px-2 text-sm"
          >
            {project.paths.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Env set</Label>
          <select
            value={envSetId}
            onChange={(e) => setEnvSetId(e.target.value)}
            className="h-9 w-full px-2 text-sm"
          >
            <option value="">none</option>
            {envSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={useWorktree}
            onChange={(e) => setUseWorktree(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Own git worktree
            <span className="block text-[10.5px] text-ink-faint">
              Every step of the run works in its own checkout, so it can't collide with your other
              sessions.
            </span>
          </span>
        </label>
        {start.isError && (
          <p className="text-xs text-err">
            {start.error instanceof Error ? start.error.message : "Could not start"}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(
                {
                  workflowId,
                  cwdPathId: pathId || undefined,
                  envSetId: envSetId || null,
                  useWorktree,
                },
                { onSuccess: (run) => onStarted(run.id) },
              )
            }
          >
            {start.isPending ? "Starting…" : "Start run"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
