import { useState } from "react";
import { Link } from "react-router";
import { ChevronLeft, Import, Play, Trash2, Workflow as WorkflowIcon } from "@/components/ui/icons";
import type { EnvSet, Project, Workflow, WorkflowInputDef } from "@claude-station/shared";
import { useQuery } from "@tanstack/react-query";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { MentionTextarea } from "@/components/ui/mention-textarea";
import { api } from "@/lib/api";
import { projectKey, useUiState } from "@/lib/uiStore";
import { FilterChip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";
import { RunView } from "./RunView";
import { TriggersPanel } from "./TriggersPanel";
import {
  useDeleteRun,
  useImportToProject,
  useRemoveFromProject,
  useRuns,
  useStartRun,
  useWorkflowFolders,
  useWorkflows,
} from "./hooks";

interface JiraSprint {
  id: number;
  name: string;
  state: string;
}

interface Props {
  project: Project;
  envSets: EnvSet[];
}

export function WorkflowsTab({ project, envSets }: Props) {
  const confirm = useConfirm();
  const { data: workflows = [] } = useWorkflows(project.id);
  const { data: runs = [] } = useRuns(project.id);
  const deleteRun = useDeleteRun(project.id);
  // Which run is open is "where I was", so it survives; a run can also be
  // deleted while we're away, hence the check against the live list.
  const [storedOpenRun, setOpenRun] = useUiState<string | null>(
    projectKey(project.id, "workflows", "openRun"),
    null,
  );
  const openRun = runs.some((r) => r.id === storedOpenRun) ? storedOpenRun : null;
  // Terminal-mode runs: the runbook typed into the embedded CLI, once per launch.
  const [runSeed, setRunSeed] = useState<string | null>(null);
  // Dialogs stay local on purpose — a modal that reopens itself on return is
  // disorienting rather than helpful.
  const [importOpen, setImportOpen] = useState(false);
  const [startFor, setStartFor] = useState<string | null>(null);

  const imported = workflows.filter((w) => w.imported);

  if (openRun) {
    return (
      <div className="h-full overflow-y-auto px-6 py-4">
        <Button size="sm" variant="ghost" className="mb-3" onClick={() => setOpenRun(null)}>
          <ChevronLeft size={16} /> All workflows
        </Button>
        <RunView
          runId={openRun}
          projectId={project.id}
          seed={runSeed ?? undefined}
          onSeedSent={() => setRunSeed(null)}
        />
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
            <Import size={16} /> Import workflows
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
            <Import size={16} /> Import workflows
          </Button>
        </Card>
      ) : (
        <div className="mb-5 space-y-2">
          {imported.map((w) => (
            <Card key={w.id} className="flex items-start gap-3 p-3">
              <WorkflowIcon size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-sm">{w.name}</span>
                  {w.folder && <Badge tone="accent">{w.folder}</Badge>}
                  <Badge>{w.steps.length} steps</Badge>
                </div>
                {w.description && <p className="mt-0.5 text-xs text-ink-muted">{w.description}</p>}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {w.steps.map((s) => (
                    <span
                      key={s.key}
                      title={`${s.type}${s.agentName ? ` · ${s.agentName}` : ""}${s.condition ? ` · if ${s.condition}` : ""}`}
                      className={cn(
                        "rounded-pill border px-1.5 py-0.5 font-mono m3-label-sm",
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
                <Play size={16} /> Run
              </Button>
              <RemoveButton projectId={project.id} workflowId={w.id} />
            </Card>
          ))}
        </div>
      )}

      {imported.length > 0 && <TriggersPanel project={project} workflows={imported} />}

      {runs.length > 0 && (
        <>
          <p className="mb-1.5 text-xs font-bold tracking-wide text-ink-faint uppercase">Runs</p>
          <div className="space-y-1.5">
            {runs.map((r) => (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => setOpenRun(r.id)}
                onKeyDown={(e) => e.key === "Enter" && setOpenRun(r.id)}
                className="liquid liquid-interactive m3-body-sm flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left"
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
                <span className="shrink-0 font-mono m3-label-sm text-ink-faint">
                  {r.completedSteps}/{r.totalSteps}
                </span>
                {["done", "failed", "cancelled"].includes(r.status) && (
                  <button
                    title={
                      deleteRun.isError && deleteRun.variables === r.id
                        ? `Xoá hỏng: ${deleteRun.error instanceof Error ? deleteRun.error.message : "không rõ"}`
                        : "Delete run"
                    }
                    // Only the row being deleted is disabled. Sharing one pending
                    // flag across every row meant a single request that never came
                    // back — a server reload mid-click is enough — left every trash
                    // icon dead, with nothing on screen to say why.
                    disabled={deleteRun.isPending && deleteRun.variables === r.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void confirm({
                        title: `Delete run "${r.title}"?`,
                        body: "Its artifacts go too.",
                        confirmLabel: "Delete run",
                        tone: "danger",
                      }).then((ok) => ok && deleteRun.mutate(r.id));
                    }}
                    className={cn(
                      "shrink-0 text-ink-faint hover:text-err disabled:opacity-50",
                      deleteRun.isError && deleteRun.variables === r.id && "text-err",
                    )}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {importOpen && <ImportDialog projectId={project.id} onClose={() => setImportOpen(false)} />}
      {startFor && (
        <StartDialog
          project={project}
          envSets={envSets}
          workflow={imported.find((w) => w.id === startFor)!}
          onClose={() => setStartFor(null)}
          onStarted={(runId, seed) => {
            setStartFor(null);
            setRunSeed(seed ?? null);
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
      <Trash2 size={16} />
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
          <FilterChip onClick={() => setFolder(null)} selected={folder === null}>
            all
          </FilterChip>
          {folders.map((f) => (
            <FilterChip
              key={f.folder}
              onClick={() => setFolder(f.folder)}
              selected={folder === f.folder}
            >
              {f.folder || "unfiled"} · {f.count}
            </FilterChip>
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
          <span className="m3-label-sm text-ink-faint">
            {folder === null
              ? "Pick a folder to import it whole."
              : `Import all of "${folder || "unfiled"}".`}
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
  workflow,
  onClose,
  onStarted,
}: {
  project: Project;
  envSets: EnvSet[];
  workflow: Workflow;
  onClose: () => void;
  onStarted: (runId: string, seed?: string) => void;
}) {
  const workflowId = workflow.id;
  const start = useStartRun(project.id);
  const [goal, setGoal] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(workflow.inputs.map((i) => [i.key, i.defaultValue])),
  );
  const [pathId, setPathId] = useState(project.paths[0]?.id ?? "");
  const [envSetId, setEnvSetId] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [askPolicy, setAskPolicy] = useState<"stop" | "assume">("stop");

  return (
    <Dialog open onClose={onClose} title="Start workflow run">
      <div className="space-y-3">
        {workflow && workflow.inputs.length > 0 && (
          <div className="space-y-2 rounded-md border border-hairline bg-white/4 p-3">
            <p className="text-xs font-bold tracking-wide text-ink-faint uppercase">
              What this workflow needs
            </p>
            {workflow.inputs.map((def) => (
              <WorkflowInputField
                key={def.key}
                def={def}
                project={project}
                all={inputs}
                value={inputs[def.key] ?? def.defaultValue}
                onChange={(v) => setInputs((prev) => ({ ...prev, [def.key]: v }))}
              />
            ))}
          </div>
        )}
        <div>
          <Label>Goal — what should this run do?</Label>
          <MentionTextarea
            value={goal}
            onChange={setGoal}
            rows={3}
            autoFocus
            placeholder={
              'VD: "Impl theo @doc:owner/repo:docs/spec.md cho @jira:IIP707" — mọi step đều thấy goal này'
            }
          />
        </div>
        <div>
          <Label>Working directory</Label>
          <Select
            className="w-full"
            value={pathId}
            onChange={setPathId}
            options={project.paths.map((p) => ({ value: p.id, label: p.label }))}
          />
        </div>
        <div>
          <Label>Env set</Label>
          <Select
            className="w-full"
            value={envSetId}
            onChange={setEnvSetId}
            options={[
              { value: "", label: "none" },
              ...envSets.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
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
            <span className="block m3-label-sm text-ink-faint">
              Every step of the run works in its own checkout, so it can't collide with your other
              sessions.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoMode}
            onChange={(e) => setAutoMode(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Run unattended
            <span className="block m3-label-sm text-ink-faint">
              No stopping to have its own work confirmed. It still stops at a manual step, at a real
              question from the agent, and at merge — that stays yours.
            </span>
          </span>
        </label>
        {autoMode && (
          <div>
            <Label>When the agent genuinely asks something</Label>
            <Select
              className="w-full"
              value={askPolicy}
              onChange={(v) => setAskPolicy(v as "stop" | "assume")}
              options={[
                { value: "stop", label: "Stop and wait for me (you get a notification)" },
                { value: "assume", label: "Assume, carry on, and put the assumption in the PR" },
              ]}
            />
            <p className="mt-1 m3-label-sm text-ink-faint">
              Assume still refuses to decide about money, auth, user data, permissions, deleting
              data, schemas or API contracts — those stop regardless.
            </p>
          </div>
        )}
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
                  goal: goal.trim() || undefined,
                  cwdPathId: pathId || undefined,
                  envSetId: envSetId || null,
                  useWorktree,
                  autoMode,
                  askPolicy: autoMode ? askPolicy : undefined,
                  inputs,
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

/**
 * One field for one declared input.
 *
 * The type isn't decoration: a `jira-project` that is a dropdown of the keys you
 * pinned removes the most common way this goes wrong — a typo'd project key that
 * only surfaces three steps later, when the run tries to create a task.
 */
function WorkflowInputField({
  def,
  project,
  all,
  value,
  onChange,
}: {
  def: WorkflowInputDef;
  project: Project;
  /** Every value on the form — a sprint can only be listed once a project is picked. */
  all: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}) {
  const { data: projects = [] } = useQuery({
    queryKey: ["jira-projects-pinned"],
    queryFn: () => api.get<string[]>("/api/jira/projects/pinned"),
    enabled: def.type === "jira-project",
    staleTime: 5 * 60_000,
  });

  // Whatever project this form picked — sprints hang off a board, which hangs
  // off a project, so there is nothing to list until one is chosen.
  const projectKey = Object.entries(all).find(([, v]) => /^[A-Z][A-Z0-9]+$/.test(v))?.[1] ?? "";
  const { data: sprints = [], error: sprintError } = useQuery({
    queryKey: ["jira-sprints", projectKey],
    queryFn: () => api.get<JiraSprint[]>(`/api/jira/sprints?projectKey=${projectKey}`),
    enabled: def.type === "jira-sprint" && projectKey.length > 0,
    staleTime: 60_000,
  });

  const field = (() => {
    switch (def.type) {
      case "jira-project":
        return projects.length > 0 ? (
          <Select
            className="w-full"
            value={value}
            onChange={onChange}
            options={[
              { value: "", label: "choose a project…" },
              ...projects.map((p) => ({ value: p, label: p })),
            ]}
          />
        ) : (
          <Input
            className="font-mono text-xs"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="IIP707 — pin projects in Settings → Integrations for a picker"
          />
        );
      case "jira-sprint":
        return (
          <div className="space-y-1">
            {sprints.length > 0 && (
              <Select
                className="w-full"
                value={sprints.some((sp) => sp.name === value) ? value : ""}
                onChange={onChange}
                options={[
                  { value: "", label: "backlog — không đưa vào sprint nào" },
                  ...sprints.map((sp) => ({
                    value: sp.name,
                    label: `${sp.name}${sp.state === "active" ? " · đang chạy" : ""}`,
                  })),
                ]}
              />
            )}
            <Input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={
                sprints.length > 0 ? "…hoặc gõ tên sprint mới" : "tên sprint — chưa có thì sẽ tạo"
              }
            />
            {sprintError && (
              <p className="m3-label-sm text-warn">
                {sprintError instanceof Error ? sprintError.message : "Không đọc được sprint"}
              </p>
            )}
            {!projectKey && (
              <p className="m3-label-sm text-ink-faint">Chọn Jira project trước để thấy sprint.</p>
            )}
          </div>
        );
      case "path":
        return (
          <Select
            className="w-full"
            value={value}
            onChange={onChange}
            options={[
              { value: "", label: "the run's own directory" },
              ...project.paths.map((p) => ({ value: p.label, label: p.label })),
            ]}
          />
        );
      case "choice":
        return (
          <Select
            className="w-full"
            value={value}
            onChange={onChange}
            options={[
              { value: "", label: "choose…" },
              ...def.options.map((o) => ({ value: o, label: o })),
            ]}
          />
        );
      case "docs":
        return (
          <Input
            className="font-mono text-xs"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://github.com/owner/repo/blob/main/docs/spec.md"
          />
        );
      case "jira-ticket":
        return (
          <Input
            className="font-mono text-xs"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="IIP707-123"
          />
        );
      default:
        return <Input value={value} onChange={(e) => onChange(e.target.value)} />;
    }
  })();

  return (
    <div>
      <Label>
        {def.label}
        {def.required && <span className="ml-1 text-err">*</span>}
      </Label>
      {field}
      {def.help && <p className="mt-1 m3-label-sm text-ink-faint">{def.help}</p>}
    </div>
  );
}
