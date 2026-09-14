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
  RotateCw,
  SkipForward,
  Terminal,
} from "@/components/ui/icons";
import type { WorkflowRun, WorkflowRunStepStatus } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { fileUrl } from "@/lib/upload";
import { wsUrl } from "@/lib/token";
import { cn } from "@/lib/utils";
import { TerminalPane } from "@/features/terminals/TerminalPane";
import { LogPane } from "@/features/commands/LogPane";
import { useConfirm } from "@/components/ui/confirm";
import { useRestartTerminal } from "@/features/terminals/hooks";

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
export function RunView({
  runId,
  projectId,
  seed,
  onSeedSent,
}: {
  runId: string;
  projectId: string;
  /** Terminal-mode runs: runbook typed into the embedded CLI on first open. */
  seed?: string;
  onSeedSent?: () => void;
}) {
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Bumped on restart: TerminalPane stops reconnecting once the PTY dies, so a
  // fresh mount is the only way to re-attach.
  const [terminalEpoch, setTerminalEpoch] = useState(0);
  // Set when the runbook is (re)sent by hand — the pane types whatever lands here.
  const [resent, setResent] = useState<string | null>(null);
  const confirm = useConfirm();
  const restartTerminal = useRestartTerminal(projectId);

  const { data: run } = useQuery({
    queryKey: ["workflow-run", runId],
    queryFn: () => api.get<WorkflowRun>(`/api/workflow-runs/${runId}`),
  });

  /**
   * The runbook, fetched rather than remembered.
   *
   * A terminal-mode run is driven by the text typed into its CLI, and that text
   * used to live only in the tab that started the run. Reload, and the run sat
   * there with every step pending next to an empty prompt. Asked for again here
   * whenever the run hasn't started a single step, so a reopened run seeds itself.
   */
  const untouched =
    run?.mode === "terminal" && run.runSteps.every((s) => s.status === "pending") && !seed;
  const { data: runbook } = useQuery({
    queryKey: ["workflow-runbook", runId],
    queryFn: () => api.get<{ seed: string }>(`/api/workflow-runs/${runId}/runbook`),
    enabled: untouched === true,
    staleTime: Infinity,
  });

  /**
   * What can be watched: a terminal per agent step, a log per gate that ran, and
   * the run's own terminal for runs started before steps had their own.
   */
  const watchable = [
    ...(run?.runSteps ?? [])
      .filter((s) => s.terminalId || s.commandRunId)
      .map((s) => ({
        key: s.stepKey,
        kind: s.terminalId ? ("terminal" as const) : ("log" as const),
        terminalId: s.terminalId,
        commandRunId: s.commandRunId,
        status: s.status,
      })),
    ...(run?.terminalId && !(run?.runSteps ?? []).some((s) => s.terminalId === run.terminalId)
      ? [
          {
            key: "runbook",
            kind: "terminal" as const,
            terminalId: run.terminalId,
            commandRunId: null,
            status: run.status,
          },
        ]
      : []),
  ];
  // Follow the run unless the user picked a step to look at.
  const [watchKey, setWatchKey] = useState<string | null>(null);
  const watching =
    watchable.find((w) => w.key === watchKey) ??
    watchable.find((w) => w.status === "running") ??
    watchable.find((w) => w.status === "awaiting_input") ??
    watchable[watchable.length - 1];

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
  const restart = useMutation({
    mutationFn: (mode: "resume" | "fresh") =>
      api.post(`/api/workflow-runs/${runId}/restart`, { mode }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["workflow-run", runId] }),
  });

  const cancel = useMutation({
    mutationFn: () => api.post(`/api/workflow-runs/${runId}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-run", runId] }),
  });

  if (!run) return <p className="p-6 text-sm text-ink-muted">Loading run…</p>;

  const open = run.questions.filter((q) => q.answer === null);
  // What a resume would keep. Shown on the button because "chạy lại" is two very
  // different actions depending on how much of the run was actually fine.
  const doneCount = run.runSteps.filter(
    (s) => s.status === "done" || s.status === "skipped",
  ).length;
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
        <span className="m3-label-sm text-ink-faint">
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
            <Ban size={16} /> Cancel run
          </Button>
        )}
        {finished && (
          <div className="ml-auto flex items-center gap-2">
            {doneCount > 0 && (
              <Button
                size="sm"
                variant="primary"
                disabled={restart.isPending}
                title={`Giữ ${doneCount} step đã xong, chỉ chạy lại phần còn lại`}
                onClick={() => restart.mutate("resume")}
              >
                <RotateCw size={16} /> Chạy tiếp ({doneCount} step giữ nguyên)
              </Button>
            )}
            <Button
              size="sm"
              variant={doneCount > 0 ? "ghost" : "primary"}
              disabled={restart.isPending}
              title="Mọi step về lại từ đầu, mỗi step một terminal mới"
              onClick={() =>
                void confirm({
                  title: "Chạy lại từ đầu?",
                  body:
                    doneCount > 0
                      ? `${doneCount} step đã xong sẽ được làm lại từ đầu — kể cả những step đã tạo ticket hoặc đã sửa code.`
                      : "Mọi step chạy lại từ đầu, mỗi step mở terminal mới.",
                  confirmLabel: "Chạy lại từ đầu",
                }).then((ok) => ok && restart.mutate("fresh"))
              }
            >
              <RotateCw size={16} /> Chạy lại từ đầu
            </Button>
          </div>
        )}
      </div>
      {run.goal && (
        <p className="m3-body-sm liquid rounded-lg px-3.5 py-2.5 text-ink-muted">
          <span className="font-medium text-ink">Goal:</span> {run.goal}
        </p>
      )}

      {open.length > 0 && (
        <Card className="border-warn/40 bg-warn/5">
          <div className="mb-2 flex items-center gap-2">
            <CirclePause size={16} className="text-warn" />
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
                  <span className="font-mono m3-label-sm text-ink-faint">{i + 1}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold">{step.title}</span>
                    <span className="font-mono m3-label-sm text-ink-faint">{step.key}</span>
                    <Badge tone={step.type === "agent" ? "accent" : "default"}>{step.type}</Badge>
                    {status === "done" && <CircleCheck size={16} className="text-ok" />}
                    {(status === "failed" || status === "interrupted") && (
                      <CircleAlert size={16} className="text-err" />
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
                        className="inline-flex items-center gap-1 rounded-pill border border-hairline px-2 py-0.5 m3-label-sm text-ink-muted hover:text-ink"
                      >
                        <Terminal size={16} /> open session
                      </Link>
                    )}
                    {rs?.commandRunId && (
                      <Link
                        to={`/projects/${projectId}?tab=commands`}
                        className="inline-flex items-center gap-1 rounded-pill border border-hairline px-2 py-0.5 m3-label-sm text-ink-muted hover:text-ink"
                      >
                        <Terminal size={16} /> command log
                      </Link>
                    )}
                    {artifacts.map((a) => (
                      <a
                        key={a.id}
                        href={fileUrl(`/api/workflow-runs/${runId}/artifacts/${a.id}`)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-pill border border-accent/30 bg-accent/10 px-2 py-0.5 m3-label-sm text-accent"
                      >
                        <FileText size={16} /> {a.title}
                        <Download size={16} />
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
                      <RotateCcw size={16} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Skip this step"
                      onClick={() => skip.mutate(step.key)}
                      aria-label="Skip step"
                    >
                      <SkipForward size={16} />
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/*
        Every agent step runs in a real `claude` terminal, and a gate's command log
        is shown in the same frame — so "what is it doing right now" is one place
        rather than a hunt across tabs.
      */}
      {watchable.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <p className="mr-auto text-xs font-bold tracking-wide text-ink-faint uppercase">
              Đang chạy ở đâu — bấm để xem từng step
            </p>
            {run.terminalId && watching?.terminalId === run.terminalId && (
              <Button
                size="sm"
                variant="ghost"
                title="Gõ lại runbook vào terminal — dùng khi terminal trống hoặc bạn đã xoá nó đi"
                onClick={async () => {
                  const { seed: text } = await api.get<{ seed: string }>(
                    `/api/workflow-runs/${runId}/runbook`,
                  );
                  setResent(`${text}\n`);
                  setTerminalEpoch((e) => e + 1);
                }}
              >
                Gửi lại runbook
              </Button>
            )}
            {watching?.terminalId && (
              <Button
                size="sm"
                variant="ghost"
                title="Restart the terminal (claude --continue resumes the conversation)"
                disabled={restartTerminal.isPending}
                onClick={() =>
                  restartTerminal.mutate(watching.terminalId!, {
                    onSuccess: () => setTerminalEpoch((e) => e + 1),
                  })
                }
              >
                <RotateCw size={16} /> Restart
              </Button>
            )}
          </div>

          <div className="mb-1.5 flex flex-wrap gap-1">
            {watchable.map((w) => (
              <button
                key={w.key}
                type="button"
                onClick={() => setWatchKey(w.key)}
                className={cn(
                  "rounded-pill border px-2 py-0.5 font-mono m3-label-sm",
                  w.key === watching?.key
                    ? "border-accent/40 bg-accent/15 text-accent"
                    : "border-hairline bg-white/5 text-ink-muted hover:bg-white/10",
                )}
              >
                {w.key}
                {w.kind === "log" ? " · log" : ""}
              </button>
            ))}
          </div>

          <div className="h-[46vh] min-h-[300px] overflow-hidden rounded-lg border border-edge">
            {watching?.kind === "log" && watching.commandRunId ? (
              <LogPane runId={watching.commandRunId} />
            ) : watching?.terminalId ? (
              <TerminalPane
                key={`${watching.terminalId}:${terminalEpoch}`}
                terminalId={watching.terminalId}
                seedText={
                  watching.terminalId === run.terminalId
                    ? (seed ?? resent ?? (untouched ? runbook?.seed : undefined))
                    : undefined
                }
                onSeedSent={onSeedSent}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
