import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CircleCheck,
  CircleAlert,
  CirclePause,
  Download,
  FileText,
  RotateCcw,
  SkipForward,
  Terminal,
} from "lucide-react";
import type { WorkflowRun, WorkflowRunStepStatus } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { fileUrl } from "@/lib/upload";
import { wsUrl } from "@/lib/token";
import { cn } from "@/lib/utils";

const DOT: Record<WorkflowRunStepStatus, string> = {
  pending: "bg-ink-faint",
  running: "bg-warn animate-status",
  awaiting_input: "bg-warn",
  done: "bg-ok",
  skipped: "bg-ink-faint",
  failed: "bg-err",
  interrupted: "bg-err",
};

/**
 * Vertical stepper for one run. The run advances server-side; this listens on
 * the WS and re-fetches, so the view is correct even if the tab was closed for
 * the whole run.
 */
export function RunView({ runId, projectId }: { runId: string; projectId: string }) {
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const { data: run } = useQuery({
    queryKey: ["workflow-run", runId],
    queryFn: () => api.get<WorkflowRun>(`/api/workflow-runs/${runId}`),
  });

  // Any WS event just invalidates: one source of truth (the GET), no local merge.
  useEffect(() => {
    const socket = new WebSocket(wsUrl(`/ws/workflow-run/${runId}`));
    socket.onmessage = () => {
      void qc.invalidateQueries({ queryKey: ["workflow-run", runId] });
      void qc.invalidateQueries({ queryKey: ["workflow-runs", projectId] });
    };
    return () => socket.close();
  }, [runId, projectId, qc]);

  const submitAnswers = useMutation({
    mutationFn: () => api.post<WorkflowRun>(`/api/workflow-runs/${runId}/answer`, { answers }),
    onSuccess: () => {
      setAnswers({});
      void qc.invalidateQueries({ queryKey: ["workflow-run", runId] });
    },
  });
  const retry = useMutation({
    mutationFn: (key: string) => api.post(`/api/workflow-runs/${runId}/steps/${key}/retry`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-run", runId] }),
  });
  const skip = useMutation({
    mutationFn: (key: string) => api.post(`/api/workflow-runs/${runId}/steps/${key}/skip`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-run", runId] }),
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/api/workflow-runs/${runId}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-run", runId] }),
  });

  if (!run) return <p className="p-6 text-sm text-ink-muted">Loading run…</p>;

  const open = run.questions.filter((q) => q.answer === null);
  const finished = run.status === "done" || run.status === "failed" || run.status === "cancelled";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={
            run.status === "done"
              ? "ok"
              : run.status === "failed" || run.status === "cancelled"
                ? "err"
                : "accent"
          }
        >
          {run.status}
        </Badge>
        <span className="text-sm font-semibold">{run.title}</span>
        <span className="text-[11px] text-ink-faint">
          {run.runSteps.filter((s) => s.status === "done" || s.status === "skipped").length}/
          {run.steps.length} steps
        </span>
        {run.definitionStale && (
          <Badge title="The workflow was edited after this run started; the run keeps its snapshot.">
            snapshot
          </Badge>
        )}
        {!finished && (
          <Button size="sm" variant="danger" className="ml-auto" onClick={() => cancel.mutate()}>
            <Ban size={13} /> Cancel run
          </Button>
        )}
      </div>
      {run.goal && (
        <p className="rounded-md border border-edge bg-surface px-3 py-2 text-xs text-ink-muted">
          <span className="font-medium text-ink">Goal:</span> {run.goal}
        </p>
      )}

      {open.length > 0 && (
        <Card className="border-warn/40 bg-warn/5">
          <div className="mb-2 flex items-center gap-2">
            <CirclePause size={14} className="text-warn" />
            <span className="text-sm font-semibold">Waiting on you</span>
          </div>
          <div className="space-y-3">
            {open.map((q) => (
              <div key={q.id}>
                <Label>{q.question}</Label>
                {q.kind === "bool" ? (
                  <div className="flex gap-1.5">
                    {["yes", "no"].map((v) => (
                      <Button
                        key={v}
                        size="sm"
                        variant={answers[q.key] === v ? "primary" : "secondary"}
                        onClick={() => setAnswers((prev) => ({ ...prev, [q.key]: v }))}
                      >
                        {v}
                      </Button>
                    ))}
                  </div>
                ) : q.kind === "choice" && q.options?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((opt) => (
                      <Button
                        key={opt}
                        size="sm"
                        variant={answers[q.key] === opt ? "primary" : "secondary"}
                        onClick={() => setAnswers((prev) => ({ ...prev, [q.key]: opt }))}
                      >
                        {opt}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Input
                    value={answers[q.key] ?? ""}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [q.key]: e.target.value }))}
                    placeholder="Your answer"
                  />
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              disabled={open.some((q) => !answers[q.key]) || submitAnswers.isPending}
              onClick={() => submitAnswers.mutate()}
            >
              {submitAnswers.isPending ? "Sending…" : "Submit and continue"}
            </Button>
          </div>
        </Card>
      )}

      <div className="space-y-1.5">
        {run.steps.map((step, i) => {
          const rs = run.runSteps.find((r) => r.stepKey === step.key);
          const status = rs?.status ?? "pending";
          const artifacts = run.artifacts.filter((a) => a.runStepId === rs?.id);
          return (
            <Card key={step.key} className="p-3">
              <div className="flex items-start gap-3">
                <div className="mt-1 flex w-6 shrink-0 flex-col items-center gap-1">
                  <span className={cn("h-2 w-2 rounded-full", DOT[status])} />
                  <span className="font-mono text-[10px] text-ink-faint">{i + 1}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold">{step.title}</span>
                    <span className="font-mono text-[10.5px] text-ink-faint">{step.key}</span>
                    <Badge tone={step.type === "agent" ? "accent" : "default"}>{step.type}</Badge>
                    {status === "done" && <CircleCheck size={12} className="text-ok" />}
                    {(status === "failed" || status === "interrupted") && (
                      <CircleAlert size={12} className="text-err" />
                    )}
                    {rs && rs.attempt > 1 && <Badge>attempt {rs.attempt}</Badge>}
                    {step.permissionMode && step.permissionMode !== "default" && (
                      <Badge>{step.permissionMode}</Badge>
                    )}
                  </div>
                  {rs?.note && <p className="mt-0.5 text-xs text-ink-muted">{rs.note}</p>}
                  {rs?.error && <p className="mt-0.5 text-xs text-err">{rs.error}</p>}

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {rs?.sessionId && (
                      <Link
                        to={`/projects/${projectId}?tab=agent:${rs.sessionId}`}
                        className="inline-flex items-center gap-1 rounded-pill border border-hairline px-2 py-0.5 text-[10.5px] text-ink-muted hover:text-ink"
                      >
                        <Terminal size={10} /> open session
                      </Link>
                    )}
                    {rs?.commandRunId && (
                      <Link
                        to={`/projects/${projectId}?tab=commands`}
                        className="inline-flex items-center gap-1 rounded-pill border border-hairline px-2 py-0.5 text-[10.5px] text-ink-muted hover:text-ink"
                      >
                        <Terminal size={10} /> command log
                      </Link>
                    )}
                    {artifacts.map((a) => (
                      <a
                        key={a.id}
                        href={fileUrl(`/api/workflow-runs/${runId}/artifacts/${a.id}`)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-pill border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10.5px] text-accent"
                      >
                        <FileText size={10} /> {a.title}
                        <Download size={9} />
                      </a>
                    ))}
                  </div>
                </div>

                {!finished && (
                  <div className="flex shrink-0 gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Run this step again (later steps reset to pending)"
                      onClick={() => retry.mutate(step.key)}
                      aria-label="Retry step"
                    >
                      <RotateCcw size={13} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Skip this step"
                      onClick={() => skip.mutate(step.key)}
                      aria-label="Skip step"
                    >
                      <SkipForward size={13} />
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
