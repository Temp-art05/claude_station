import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import type {
  PermissionMode,
  WorkflowArtifact,
  WorkflowQuestion,
  WorkflowRun,
  WorkflowRunStep,
  WorkflowRunStepStatus,
  WorkflowStep,
} from "@claude-station/shared";
import { db, schema } from "../db";
import { DATA_DIR } from "../lib/data-dir";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { interrupt, isRunning, sendUserMessage } from "./claude-session";
import { startRun as startCommandRun } from "./commands";
import { evaluateCondition, ConditionError } from "./workflow-condition";
import { getWorkflow } from "./workflows";
import { createChatSession } from "./sessions";
import { notify } from "./notify";

export type RunEvent =
  | { t: "status"; status: WorkflowRun["status"]; currentStepKey: string | null }
  | { t: "step"; step: WorkflowRunStep }
  | { t: "question"; questions: WorkflowQuestion[] }
  | { t: "artifact"; artifact: WorkflowArtifact }
  | { t: "error"; message: string };

type Listener = (event: RunEvent) => void;

const listeners = new Map<string, Set<Listener>>();
/** Ask calls parked mid-turn, keyed by run step. Resolved by the answer route. */
const pendingAsks = new Map<string, (answers: Record<string, string>) => void>();
/** Runs currently being advanced, so a double POST can't run a step twice. */
const advancing = new Set<string>();

export function subscribeRun(runId: string, listener: Listener): () => void {
  const set = listeners.get(runId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(runId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(runId);
  };
}

function emit(runId: string, event: RunEvent): void {
  for (const l of listeners.get(runId) ?? []) l(event);
}

export function artifactDir(runId: string): string {
  const dir = join(DATA_DIR, "workflows", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

function parseSteps(definition: string): WorkflowStep[] {
  try {
    const parsed = JSON.parse(definition) as unknown;
    return Array.isArray(parsed) ? (parsed as WorkflowStep[]) : [];
  } catch {
    return [];
  }
}

function toRunStep(row: typeof schema.workflowRunSteps.$inferSelect): WorkflowRunStep {
  return {
    id: row.id,
    runId: row.runId,
    stepKey: row.stepKey,
    status: row.status as WorkflowRunStepStatus,
    attempt: row.attempt,
    sessionId: row.sessionId,
    commandRunId: row.commandRunId,
    note: row.note,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function toQuestion(row: typeof schema.workflowQuestions.$inferSelect): WorkflowQuestion {
  let options: string[] | null = null;
  if (row.options) {
    try {
      const parsed = JSON.parse(row.options) as unknown;
      options = Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      options = null;
    }
  }
  return {
    id: row.id,
    runId: row.runId,
    runStepId: row.runStepId,
    key: row.key,
    question: row.question,
    kind: row.kind as WorkflowQuestion["kind"],
    options,
    answer: row.answer,
    answeredAt: row.answeredAt,
  };
}

export function getRun(runId: string): WorkflowRun | null {
  const row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
  if (!row) return null;

  const steps = parseSteps(row.definition);
  const source = getWorkflow(row.workflowId);
  const definitionStale =
    source !== null && JSON.stringify(stripIds(source.steps)) !== JSON.stringify(stripIds(steps));

  return {
    id: row.id,
    projectId: row.projectId,
    workflowId: row.workflowId,
    title: row.title,
    goal: row.goal,
    mode: (row.mode === "terminal" ? "terminal" : "engine") as WorkflowRun["mode"],
    terminalId: row.terminalId,
    status: row.status as WorkflowRun["status"],
    currentStepKey: row.currentStepKey,
    cwd: row.cwd,
    envSetId: row.envSetId,
    useWorktree: row.useWorktree,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    steps,
    runSteps: db
      .select()
      .from(schema.workflowRunSteps)
      .where(eq(schema.workflowRunSteps.runId, runId))
      .all()
      .map(toRunStep),
    questions: db
      .select()
      .from(schema.workflowQuestions)
      .where(eq(schema.workflowQuestions.runId, runId))
      .orderBy(asc(schema.workflowQuestions.createdAt))
      .all()
      .map(toQuestion),
    artifacts: db
      .select()
      .from(schema.workflowArtifacts)
      .where(eq(schema.workflowArtifacts.runId, runId))
      .orderBy(asc(schema.workflowArtifacts.createdAt))
      .all()
      .map((a) => ({
        id: a.id,
        runId: a.runId,
        runStepId: a.runStepId,
        kind: a.kind as WorkflowArtifact["kind"],
        title: a.title,
        path: a.path,
        createdAt: a.createdAt,
      })),
    definitionStale,
  };
}

/** Comparing snapshots ignores row ids, which differ after any step rewrite. */
function stripIds(steps: WorkflowStep[]): unknown[] {
  return steps.map(({ id: _id, workflowId: _wf, ...rest }) => rest);
}

export function listRuns(projectId: string, limit = 50) {
  return db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.projectId, projectId))
    .orderBy(desc(schema.workflowRuns.startedAt))
    .limit(limit)
    .all()
    .map((r) => {
      const steps = parseSteps(r.definition);
      const done = db
        .select()
        .from(schema.workflowRunSteps)
        .where(eq(schema.workflowRunSteps.runId, r.id))
        .all()
        .filter((s) => s.status === "done" || s.status === "skipped").length;
      return {
        id: r.id,
        workflowId: r.workflowId,
        title: r.title,
        status: r.status,
        currentStepKey: r.currentStepKey,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        totalSteps: steps.length,
        completedSteps: done,
      };
    });
}

// ── Writes ────────────────────────────────────────────────────────────────────

function setRunStatus(runId: string, status: WorkflowRun["status"], currentStepKey?: string | null) {
  db.update(schema.workflowRuns)
    .set({
      status,
      ...(currentStepKey === undefined ? {} : { currentStepKey }),
      ...(status === "done" || status === "failed" || status === "cancelled"
        ? { finishedAt: nowIso() }
        : {}),
    })
    .where(eq(schema.workflowRuns.id, runId))
    .run();
  const row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
  emit(runId, { t: "status", status, currentStepKey: row?.currentStepKey ?? null });
}

function upsertRunStep(
  runId: string,
  stepKey: string,
  patch: Partial<typeof schema.workflowRunSteps.$inferInsert>,
): WorkflowRunStep {
  const existing = db
    .select()
    .from(schema.workflowRunSteps)
    .where(
      and(eq(schema.workflowRunSteps.runId, runId), eq(schema.workflowRunSteps.stepKey, stepKey)),
    )
    .get();

  if (existing) {
    db.update(schema.workflowRunSteps)
      .set(patch)
      .where(eq(schema.workflowRunSteps.id, existing.id))
      .run();
  } else {
    db.insert(schema.workflowRunSteps)
      .values({
        id: newId(),
        runId,
        stepKey,
        status: "pending",
        attempt: 1,
        sessionId: null,
        commandRunId: null,
        note: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        ...patch,
      })
      .run();
  }

  const row = db
    .select()
    .from(schema.workflowRunSteps)
    .where(
      and(eq(schema.workflowRunSteps.runId, runId), eq(schema.workflowRunSteps.stepKey, stepKey)),
    )
    .get()!;
  const runStep = toRunStep(row);
  emit(runId, { t: "step", step: runStep });
  return runStep;
}

export function createRun(
  projectId: string,
  input: {
    workflowId: string;
    title?: string;
    goal?: string;
    cwdPathId?: string;
    envSetId?: string | null;
    useWorktree?: boolean;
    mode?: "engine" | "terminal";
    terminalId?: string;
  },
): WorkflowRun {
  const workflow = getWorkflow(input.workflowId);
  if (!workflow) throw badRequest("Workflow not found");
  if (workflow.steps.length === 0) throw badRequest("This workflow has no steps");

  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, projectId))
    .orderBy(asc(schema.projectPaths.sortOrder))
    .all();
  if (paths.length === 0) throw badRequest("Project has no paths configured");
  const chosen = input.cwdPathId
    ? paths.find((p) => p.id === input.cwdPathId)
    : (paths.find((p) => p.isDefault) ?? paths[0]);
  if (!chosen) throw badRequest("cwdPathId not found in this project");

  const id = newId();
  const now = nowIso();
  db.insert(schema.workflowRuns)
    .values({
      id,
      projectId,
      workflowId: workflow.id,
      title: input.title ?? `${workflow.name} · ${new Date().toLocaleString()}`,
      goal: input.goal?.trim() || null,
      mode: input.mode ?? "engine",
      terminalId: input.terminalId ?? null,
      // Snapshot: later edits to the workflow must not rewrite this run.
      definition: JSON.stringify(workflow.steps),
      // A terminal run is live the moment its PTY exists — the engine never drives it.
      status: input.mode === "terminal" ? "running" : "pending",
      currentStepKey: null,
      cwd: chosen.path,
      envSetId: input.envSetId ?? null,
      useWorktree: input.useWorktree ?? false,
      startedAt: now,
      finishedAt: null,
    })
    .run();

  for (const step of workflow.steps) upsertRunStep(id, step.key, { status: "pending" });

  db.insert(schema.workHistory)
    .values({
      id: newId(),
      projectId,
      kind: "workflow_started",
      refId: id,
      summary: `Started workflow ${workflow.name} (${workflow.steps.length} steps)`,
      createdAt: now,
    })
    .run();

  return getRun(id)!;
}

/**
 * Terminal-mode runs: the claude PTY drives and reports transitions here
 * (curl from inside the session). The stepper UI updates over the run's WS.
 */
export function reportTerminalProgress(
  runId: string,
  input: { step: string; status: "running" | "done" | "failed" | "skipped"; note?: string },
): WorkflowRun {
  const run = getRun(runId);
  if (!run) throw badRequest("Run not found");
  if (run.mode !== "terminal") throw badRequest("Not a terminal-mode run");
  if (run.status === "cancelled") throw badRequest("Run was cancelled");
  if (!run.steps.some((s) => s.key === input.step)) {
    throw badRequest(`Unknown step "${input.step}" — keys: ${run.steps.map((s) => s.key).join(", ")}`);
  }

  const now = nowIso();
  upsertRunStep(runId, input.step, {
    status: input.status,
    ...(input.note ? { note: input.note.slice(0, 500) } : {}),
    ...(input.status === "running" ? { startedAt: now } : { finishedAt: now }),
  });

  const after = getRun(runId)!;
  const allSettled = after.runSteps.every((s) => s.status === "done" || s.status === "skipped");
  if (input.status === "running") setRunStatus(runId, "running", input.step);
  else if (allSettled) setRunStatus(runId, "done", null);
  return getRun(runId)!;
}

// ── Engine ────────────────────────────────────────────────────────────────────

function conditionContext(run: WorkflowRun) {
  const answers: Record<string, string | null> = {};
  for (const q of run.questions) answers[q.key] = q.answer;
  const stepStatus: Record<string, string> = {};
  for (const s of run.runSteps) stepStatus[s.stepKey] = s.status;
  return { answers, stepStatus };
}

/**
 * The context block a step's agent gets: what already happened, where the
 * artifacts are, and what the user answered. Paths, not contents — pasting every
 * previous step's output would exhaust the context window by step four.
 */
function stepContext(run: WorkflowRun, step: WorkflowStep, index: number): string {
  const lines: string[] = [
    `## Workflow: ${run.title}`,
    `Step ${index + 1}/${run.steps.length} — ${step.title} (key: ${step.key})`,
  ];

  // The user's own words for what this run is about — every step sees them.
  if (run.goal) lines.push("", "## Goal of this run (from the user)", run.goal);

  const finished = run.runSteps.filter((s) => s.status === "done" || s.status === "skipped");
  if (finished.length > 0) {
    lines.push(
      "",
      "Already finished:",
      ...finished.map((s) => {
        const def = run.steps.find((d) => d.key === s.stepKey);
        return `- ${s.stepKey}${def ? ` (${def.title})` : ""}: ${s.status}${s.note ? ` — ${s.note}` : ""}`;
      }),
    );
  }

  if (run.artifacts.length > 0) {
    lines.push(
      "",
      "Artifacts from earlier steps — read these files rather than asking for their contents:",
      ...run.artifacts.map((a) => `- ${a.kind}: "${a.title}" → \`${a.path}\``),
    );
  }

  const answered = run.questions.filter((q) => q.answer !== null);
  if (answered.length > 0) {
    lines.push(
      "",
      "Decisions the user confirmed:",
      ...answered.map((q) => `- ${q.key}: ${q.answer} (asked: ${q.question})`),
    );
  }

  const failedCommands = run.runSteps.filter((s) => s.status === "failed" && s.commandRunId);
  if (failedCommands.length > 0) {
    lines.push(
      "",
      "Failed command runs (read with read_command_log):",
      ...failedCommands.map((s) => `- ${s.stepKey} → run id ${s.commandRunId}`),
    );
  }

  if (step.instruction) lines.push("", "## Your task for this step", step.instruction);
  return lines.join("\n");
}

/** Parked by workflow_ask while the user answers. */
export function registerAsk(
  runStepId: string,
  resolve: (answers: Record<string, string>) => void,
): void {
  pendingAsks.set(runStepId, resolve);
}

export function hasPendingAsk(runStepId: string): boolean {
  return pendingAsks.has(runStepId);
}

export function emitArtifactRecord(
  runId: string,
  runStepId: string,
  artifact: { kind: WorkflowArtifact["kind"]; title: string; path: string },
): WorkflowArtifact {
  const row = {
    id: newId(),
    runId,
    runStepId,
    kind: artifact.kind,
    title: artifact.title,
    path: artifact.path,
    createdAt: nowIso(),
  };
  db.insert(schema.workflowArtifacts).values(row).run();
  emit(runId, { t: "artifact", artifact: row });
  return row;
}

export function recordQuestions(
  runId: string,
  runStepId: string,
  questions: { key: string; question: string; kind: WorkflowQuestion["kind"]; options?: string[] }[],
): WorkflowQuestion[] {
  const now = nowIso();
  for (const q of questions) {
    db.insert(schema.workflowQuestions)
      .values({
        id: newId(),
        runId,
        runStepId,
        key: q.key,
        question: q.question,
        kind: q.kind,
        options: q.options?.length ? JSON.stringify(q.options) : null,
        answer: null,
        answeredAt: null,
        createdAt: now,
      })
      .run();
  }
  const all = db
    .select()
    .from(schema.workflowQuestions)
    .where(eq(schema.workflowQuestions.runId, runId))
    .all()
    .map(toQuestion);
  emit(runId, { t: "question", questions: all.filter((q) => q.answer === null) });
  return all;
}

export function setStepNote(runId: string, stepKey: string, note: string): void {
  upsertRunStep(runId, stepKey, { note: note.slice(0, 500) });
}

/** Marks the run as waiting on the human, without touching step bookkeeping. */
export function markAwaitingInput(runId: string): void {
  setRunStatus(runId, "awaiting_input");
}

async function runAgentStep(
  run: WorkflowRun,
  step: WorkflowStep,
  index: number,
  attempt: number,
): Promise<{ ok: boolean; error?: string }> {
  const existing = run.runSteps.find((s) => s.stepKey === step.key);
  let sessionId = existing?.sessionId ?? null;

  // Retries reuse the same session so the agent keeps its context.
  if (!sessionId) {
    const session = createChatSession(run.projectId, {
      title: `${run.title} · ${step.title}`,
      cwdPathId: undefined,
      permissionMode: (step.permissionMode ?? "default") as PermissionMode,
      origin: `workflow:${run.id}`,
      envSetId: run.envSetId,
      useWorktree: run.useWorktree,
      agentName: step.agentName,
      kind: "workflow",
      workflowRunStepId: existing?.id ?? null,
    });
    sessionId = session.id;
  }

  upsertRunStep(run.id, step.key, {
    status: "running",
    attempt,
    sessionId,
    startedAt: existing?.startedAt ?? nowIso(),
    error: null,
  });

  const prompt =
    attempt > 1
      ? `${stepContext(run, step, index)}\n\n[Retry ${attempt}: the previous attempt failed. Fix the cause and finish the step.]`
      : stepContext(run, step, index);

  try {
    await sendUserMessage(sessionId, prompt);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const session = db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId))
    .get();
  if (session?.status === "error") return { ok: false, error: "The agent turn ended in an error" };
  return { ok: true };
}

async function runCommandStep(
  run: WorkflowRun,
  step: WorkflowStep,
  attempt: number,
): Promise<{ ok: boolean; error?: string }> {
  // Commands are resolved by name against this project's configured commands.
  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, run.projectId))
    .all();
  let commandId: string | null = null;
  for (const path of paths) {
    const match = db
      .select()
      .from(schema.pathCommands)
      .where(eq(schema.pathCommands.projectPathId, path.id))
      .all()
      .find((c) => c.name.toLowerCase() === (step.commandName ?? "").toLowerCase());
    if (match) {
      commandId = match.id;
      break;
    }
  }
  if (!commandId) {
    return {
      ok: false,
      error: `No command named "${step.commandName}" in this project — add it in the Commands tab`,
    };
  }

  const { runId: commandRunId, done } = startCommandRun({
    projectId: run.projectId,
    pathCommandId: commandId,
    origin: "ui",
    envSetId: run.envSetId,
  });
  upsertRunStep(run.id, step.key, {
    status: "running",
    attempt,
    commandRunId,
    startedAt: nowIso(),
    error: null,
  });

  const { exitCode } = await done;
  if (exitCode === 0) return { ok: true };
  return { ok: false, error: `Command exited ${exitCode ?? "by signal"}` };
}

/**
 * Advance the run until it finishes or needs the human. Safe to call twice: the
 * second call returns while the first is still working.
 */
export async function advanceRun(runId: string): Promise<WorkflowRun> {
  if (advancing.has(runId)) return getRun(runId)!;
  advancing.add(runId);
  try {
    for (;;) {
      const run = getRun(runId);
      if (!run) throw badRequest("Run not found");
      // Terminal-mode runs are driven by their claude PTY, never by the engine.
      if (run.mode === "terminal") return run;
      if (run.status === "cancelled" || run.status === "done" || run.status === "failed") return run;

      const index = run.steps.findIndex((step) => {
        const rs = run.runSteps.find((r) => r.stepKey === step.key);
        // `interrupted` counts as unfinished: a restart-killed step needs an
        // explicit Retry, and must never be silently stepped over.
        return (
          !rs ||
          rs.status === "pending" ||
          rs.status === "awaiting_input" ||
          rs.status === "interrupted"
        );
      });
      if (index === -1) {
        setRunStatus(runId, "done", null);
        notify("Workflow finished", run.title);
        db.insert(schema.workHistory)
          .values({
            id: newId(),
            projectId: run.projectId,
            kind: "workflow_finished",
            refId: runId,
            summary: `Workflow ${run.title} finished`,
            createdAt: nowIso(),
          })
          .run();
        return getRun(runId)!;
      }

      const step = run.steps[index]!;
      const runStep = run.runSteps.find((r) => r.stepKey === step.key);

      // A confirm/manual step that's already waiting stays waiting; an
      // interrupted one waits for the user to retry or skip it.
      if (runStep?.status === "awaiting_input" || runStep?.status === "interrupted") {
        setRunStatus(runId, "awaiting_input", step.key);
        return getRun(runId)!;
      }

      // Unanswered questions block everything, whoever raised them.
      if (run.questions.some((q) => q.answer === null)) {
        setRunStatus(runId, "awaiting_input", step.key);
        return getRun(runId)!;
      }

      let shouldRun: boolean;
      try {
        shouldRun = evaluateCondition(step.condition, conditionContext(run));
      } catch (err) {
        const message = err instanceof ConditionError ? err.message : String(err);
        upsertRunStep(runId, step.key, { status: "failed", error: message, finishedAt: nowIso() });
        setRunStatus(runId, "failed", step.key);
        emit(runId, { t: "error", message });
        return getRun(runId)!;
      }

      if (!shouldRun) {
        upsertRunStep(runId, step.key, {
          status: "skipped",
          note: `condition not met: ${step.condition}`,
          finishedAt: nowIso(),
        });
        continue;
      }

      setRunStatus(runId, "running", step.key);
      const attempt = (runStep?.attempt ?? 1) === 1 ? 1 : runStep!.attempt;

      if (step.type === "confirm" || step.type === "manual") {
        // Nothing to execute: the step exists to make the human act.
        const stepRow = upsertRunStep(runId, step.key, {
          status: "awaiting_input",
          startedAt: nowIso(),
        });
        if (step.type === "confirm" && run.questions.length === 0) {
          recordQuestions(runId, stepRow.id, [
            {
              key: `${step.key}-ok`,
              question: step.instruction ?? "Reviewed and good to continue?",
              kind: "bool",
            },
          ]);
        }
        setRunStatus(runId, "awaiting_input", step.key);
        return getRun(runId)!;
      }

      const result =
        step.type === "agent"
          ? await runAgentStep(run, step, index, attempt)
          : await runCommandStep(run, step, attempt);

      // The agent may have parked on a workflow_ask during the turn.
      const after = getRun(runId)!;
      if (after.status === "cancelled") return after;
      if (after.questions.some((q) => q.answer === null)) {
        upsertRunStep(runId, step.key, { status: "awaiting_input" });
        setRunStatus(runId, "awaiting_input", step.key);
        return getRun(runId)!;
      }

      if (result.ok) {
        upsertRunStep(runId, step.key, { status: "done", finishedAt: nowIso(), error: null });
        // A step that asked for confirmation but never called workflow_ask still
        // needs a human gate, so synthesise one instead of sailing past it.
        if (step.requiresConfirm && after.questions.every((q) => q.answer !== null)) {
          const stepRow = db
            .select()
            .from(schema.workflowRunSteps)
            .where(
              and(
                eq(schema.workflowRunSteps.runId, runId),
                eq(schema.workflowRunSteps.stepKey, step.key),
              ),
            )
            .get()!;
          const asked = after.questions.some((q) => q.runStepId === stepRow.id);
          if (!asked) {
            recordQuestions(runId, stepRow.id, [
              {
                key: `${step.key}-confirm`,
                question: `"${step.title}" finished. Review it and confirm, or say what to change.`,
                kind: "text",
              },
            ]);
            setRunStatus(runId, "awaiting_input", step.key);
            return getRun(runId)!;
          }
        }
        continue;
      }

      if (attempt <= step.maxRetries) {
        upsertRunStep(runId, step.key, {
          status: "pending",
          attempt: attempt + 1,
          error: result.error ?? null,
        });
        continue;
      }

      upsertRunStep(runId, step.key, {
        status: "failed",
        error: result.error ?? "Step failed",
        finishedAt: nowIso(),
      });
      // A failed step doesn't necessarily kill the run: a later step may be
      // conditioned on this failure (test → fix-tests), so keep going.
      const hasRecovery = run.steps
        .slice(index + 1)
        .some((s) => s.condition?.includes(`steps.${step.key}.failed`));
      if (!hasRecovery) {
        setRunStatus(runId, "failed", step.key);
        notify("Workflow failed", `${run.title}: ${step.title}`);
        return getRun(runId)!;
      }
    }
  } finally {
    advancing.delete(runId);
  }
}

export function answerQuestions(runId: string, answers: Record<string, string>): WorkflowRun {
  const run = getRun(runId);
  if (!run) throw badRequest("Run not found");

  const now = nowIso();
  for (const [key, value] of Object.entries(answers)) {
    const question = run.questions.find((q) => q.key === key);
    if (!question) continue;
    db.update(schema.workflowQuestions)
      .set({ answer: value, answeredAt: now })
      .where(eq(schema.workflowQuestions.id, question.id))
      .run();
  }

  const updated = getRun(runId)!;
  const unanswered = updated.questions.filter((q) => q.answer === null);
  if (unanswered.length > 0) {
    emit(runId, { t: "question", questions: unanswered });
    return updated;
  }

  // Hand the answers back to whoever asked. If an agent is parked inside
  // workflow_ask, its tool call resolves and the turn continues; otherwise the
  // waiting step was a confirm/manual gate and we just move on.
  const grouped = new Map<string, Record<string, string>>();
  for (const q of updated.questions) {
    const bucket = grouped.get(q.runStepId) ?? {};
    bucket[q.key] = q.answer ?? "";
    grouped.set(q.runStepId, bucket);
  }
  let resolvedAsk = false;
  for (const [runStepId, bucket] of grouped) {
    const resolve = pendingAsks.get(runStepId);
    if (resolve) {
      pendingAsks.delete(runStepId);
      resolve(bucket);
      resolvedAsk = true;
    }
  }

  for (const rs of updated.runSteps) {
    if (rs.status === "awaiting_input") {
      const def = updated.steps.find((s) => s.key === rs.stepKey);
      // A parked agent finishes its own step; gates are done the moment they're answered.
      if (!resolvedAsk || def?.type === "confirm" || def?.type === "manual") {
        upsertRunStep(runId, rs.stepKey, { status: "done", finishedAt: now });
      } else {
        upsertRunStep(runId, rs.stepKey, { status: "running" });
      }
    }
  }

  setRunStatus(runId, "running");
  if (!resolvedAsk) void advanceRun(runId);
  return getRun(runId)!;
}

export function retryStep(runId: string, stepKey: string): WorkflowRun {
  const run = getRun(runId);
  if (!run) throw badRequest("Run not found");
  const rs = run.runSteps.find((s) => s.stepKey === stepKey);
  if (!rs) throw badRequest("Step not found in this run");

  // Drop this step's unanswered questions: they belong to a turn that is gone,
  // and leaving them would block the retry before it starts.
  for (const q of run.questions) {
    if (q.runStepId === rs.id && q.answer === null) {
      db.delete(schema.workflowQuestions).where(eq(schema.workflowQuestions.id, q.id)).run();
    }
  }
  pendingAsks.delete(rs.id);
  // A restart-killed session can't be resumed, so the retry starts a fresh one.
  const startFresh = rs.status === "interrupted";

  upsertRunStep(runId, stepKey, {
    status: "pending",
    attempt: rs.attempt + 1,
    error: null,
    finishedAt: null,
    ...(startFresh ? { sessionId: null } : {}),
  });
  // Later steps must re-run too, or the run would resume past the retried step.
  const index = run.steps.findIndex((s) => s.key === stepKey);
  for (const later of run.steps.slice(index + 1)) {
    const laterRs = run.runSteps.find((s) => s.stepKey === later.key);
    if (laterRs && laterRs.status !== "pending") {
      upsertRunStep(runId, later.key, { status: "pending", finishedAt: null, error: null });
    }
  }
  setRunStatus(runId, "running", stepKey);
  void advanceRun(runId);
  return getRun(runId)!;
}

export function skipStep(runId: string, stepKey: string): WorkflowRun {
  const run = getRun(runId);
  if (!run) throw badRequest("Run not found");
  upsertRunStep(runId, stepKey, {
    status: "skipped",
    note: "skipped by the user",
    finishedAt: nowIso(),
  });
  void advanceRun(runId);
  return getRun(runId)!;
}

export async function cancelRun(runId: string): Promise<WorkflowRun> {
  const run = getRun(runId);
  if (!run) throw badRequest("Run not found");
  for (const rs of run.runSteps) {
    if (rs.status === "running" || rs.status === "awaiting_input") {
      if (rs.sessionId && isRunning(rs.sessionId)) await interrupt(rs.sessionId);
      pendingAsks.delete(rs.id);
      upsertRunStep(runId, rs.stepKey, {
        status: "interrupted",
        note: "run cancelled",
        finishedAt: nowIso(),
      });
    }
  }
  setRunStatus(runId, "cancelled", null);
  return getRun(runId)!;
}

export function deleteRun(runId: string): void {
  const dir = join(DATA_DIR, "workflows", runId);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort — the DB rows go regardless */
  }
  db.delete(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).run();
}

/**
 * Boot reconciliation. A step that was mid-flight when the process died is NOT
 * resumed automatically: it may already have edited files or commented on a
 * ticket, and re-running it blind is worse than asking.
 */
export function reconcileRunsOnBoot(): number {
  // Any run that isn't finished, not just the ones marked running: a run parked
  // on a workflow_ask is `awaiting_input`, and its parked promise died with the
  // old process — answering it now would resolve nothing.
  const stale = db
    .select()
    .from(schema.workflowRuns)
    .all()
    // Terminal-mode runs have no engine state to reconcile — their PTY either
    // survived (pty-manager restores it) or the user restarts it by hand.
    .filter(
      (r) =>
        r.mode !== "terminal" &&
        r.status !== "done" &&
        r.status !== "failed" &&
        r.status !== "cancelled",
    );

  let touched = 0;
  for (const run of stale) {
    const steps = db
      .select()
      .from(schema.workflowRunSteps)
      .where(eq(schema.workflowRunSteps.runId, run.id))
      .all();

    for (const step of steps) {
      // A step with a session was executing (or parked inside a tool call).
      // Gates without a session — confirm/manual — are still legitimately waiting.
      const wasLive =
        step.status === "running" || (step.status === "awaiting_input" && step.sessionId !== null);
      if (!wasLive) continue;
      db.update(schema.workflowRunSteps)
        .set({
          status: "interrupted",
          error: "The server restarted while this step was running — retry it to pick up again",
          finishedAt: nowIso(),
        })
        .where(eq(schema.workflowRunSteps.id, step.id))
        .run();
      touched += 1;
    }

    if (touched > 0) {
      db.update(schema.workflowRuns)
        .set({ status: "awaiting_input" })
        .where(eq(schema.workflowRuns.id, run.id))
        .run();
    }
  }
  return touched;
}
