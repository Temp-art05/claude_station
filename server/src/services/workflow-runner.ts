import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import type {
  Workflow,
  WorkflowArtifact,
  WorkflowQuestion,
  WorkflowRun,
  WorkflowRunStep,
  WorkflowRunStepStatus,
  WorkflowStep,
} from "@claude-station/shared";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { DATA_DIR } from "../lib/data-dir";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { dependentsOf as dependentsOfKey, readySteps as readyStepsOf } from "../lib/workflow-graph";
import { agentDefinition } from "./agents";
import { interrupt, isRunning } from "./claude-session";
import { runTurnInTerminal, terminalForStep } from "./workflow-step-terminal";
import { startRun as startCommandRun } from "./commands";
import { normalizeMentions, resolveMentions } from "./mentions";
import { evaluateCondition, ConditionError } from "./workflow-condition";
import { getWorkflow } from "./workflows";
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
    loops: row.loops,
    sessionId: row.sessionId,
    terminalId: row.terminalId,
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
    autoMode: row.autoMode,
    askPolicy: row.askPolicy === "assume" ? "assume" : "stop",
    inputs: parseInputs(row.inputs),
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

function parseInputs(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  } catch {
    return {};
  }
}

/**
 * Check what was filled in, and turn the typed values into tags the run's goal
 * carries.
 *
 * Making the inputs part of the goal rather than a private side-channel does
 * three things at once: every step sees them, the run view shows what this run
 * was actually pointed at, and a `docs` link goes down exactly the same path as
 * a link somebody tagged by hand — so there is one way documents get read, not two.
 */
function prepareInputs(
  workflow: Workflow,
  given: Record<string, string>,
  userGoal?: string,
): { values: Record<string, string>; goal: string | null } {
  const values: Record<string, string> = {};
  const lines: string[] = [];

  for (const def of workflow.inputs) {
    const value = (given[def.key] ?? def.defaultValue ?? "").trim();
    if (!value) {
      if (def.required) throw badRequest(`"${def.label}" is required to start this workflow`);
      continue;
    }
    if (def.type === "choice" && def.options.length > 0 && !def.options.includes(value)) {
      throw badRequest(`"${def.label}" must be one of: ${def.options.join(", ")}`);
    }
    values[def.key] = value;

    switch (def.type) {
      case "docs":
        lines.push(`- ${def.label}: ${normalizeMentions(value)}`);
        break;
      case "jira-ticket":
        lines.push(`- ${def.label}: @ticket:${value.toUpperCase()}`);
        break;
      case "jira-project":
        lines.push(`- ${def.label}: @jira:${value.toUpperCase()}`);
        break;
      case "jira-sprint":
        // Deliberately not a tag: the sprint may not exist yet, and the agent is
        // the one that decides between reusing a name and creating it.
        lines.push(`- ${def.label}: sprint "${value}" (dùng lại nếu đã có, chưa có thì tạo)`);
        break;
      case "repo":
        lines.push(`- ${def.label}: @repo:${value}`);
        break;
      default:
        lines.push(`- ${def.label}: ${value}`);
    }
  }

  const goalText = (userGoal ?? "").trim();
  const parts = [goalText, lines.length > 0 ? ["## Inputs for this run", ...lines].join("\n") : ""]
    .filter(Boolean)
    .join("\n\n");
  return { values, goal: parts || null };
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

function setRunStatus(
  runId: string,
  status: WorkflowRun["status"],
  currentStepKey?: string | null,
) {
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
    autoMode?: boolean;
    askPolicy?: "stop" | "assume";
    triggerId?: string | null;
    inputs?: Record<string, string>;
  },
): WorkflowRun {
  const workflow = getWorkflow(input.workflowId);
  if (!workflow) throw badRequest("Workflow not found");
  if (workflow.steps.length === 0) throw badRequest("This workflow has no steps");

  // Every agent a step names has to exist before anything starts. Checked here
  // rather than at import, because importing a workflow before its agent is a
  // normal order to do things in — but discovering the gap at step four, after
  // three steps have already edited files, is not.
  const missing = [
    ...new Set(
      workflow.steps
        .filter((s) => s.type === "agent" && s.agentName)
        .map((s) => s.agentName!)
        .filter((name) => agentDefinition(name) === null),
    ),
  ];
  if (missing.length > 0) {
    throw badRequest(
      `This workflow needs ${missing.length > 1 ? "agents" : "an agent"} that isn't installed: ` +
        `${missing.join(", ")}. Import ${missing.length > 1 ? "them" : "it"} on the Agents page first.`,
    );
  }

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

  const { values, goal } = prepareInputs(workflow, input.inputs ?? {}, input.goal);

  const id = newId();
  const now = nowIso();
  db.insert(schema.workflowRuns)
    .values({
      id,
      projectId,
      workflowId: workflow.id,
      title: input.title ?? `${workflow.name} · ${new Date().toLocaleString()}`,
      goal,
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
      autoMode: input.autoMode ?? false,
      askPolicy: input.askPolicy ?? "stop",
      // Only an unattended run gets a clock: a run somebody is watching ends when
      // they say so, and killing it on a timer would be the surprise.
      deadlineAt: input.autoMode
        ? new Date(Date.now() + setting("workflows.runBudgetMinutes") * 60_000).toISOString()
        : null,
      assumptions: null,
      inputs: Object.keys(values).length > 0 ? JSON.stringify(values) : null,
      triggerId: input.triggerId ?? null,
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
    throw badRequest(
      `Unknown step "${input.step}" — keys: ${run.steps.map((s) => s.key).join(", ")}`,
    );
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
/**
 * Fill `{{key}}` from what was entered at Start.
 *
 * An unknown key is left standing rather than blanked: a step told to read
 * "{{docs}}" and handed an empty string would go looking for something else,
 * while the literal braces say plainly that nothing was supplied.
 */
export function interpolate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g, (whole, key: string) => {
    const value = values[key];
    return value === undefined || value === "" ? whole : value;
  });
}

async function stepContext(run: WorkflowRun, step: WorkflowStep, index: number): Promise<string> {
  const lines: string[] = [
    `## Workflow: ${run.title}`,
    `Step ${index + 1}/${run.steps.length} — ${step.title} (key: ${step.key})`,
  ];

  const goal = run.goal ? interpolate(run.goal, run.inputs) : "";
  const instruction = step.instruction ? interpolate(step.instruction, run.inputs) : "";

  // The user's own words for what this run is about — every step sees them.
  if (goal) lines.push("", "## Goal of this run (from the user)", goal);

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

  if (instruction) lines.push("", "## Your task for this step", instruction);

  // Anything tagged with @ is read here, not by the agent: a step that has to go
  // and fetch its own spec spends a turn doing it, and a run's turns are the one
  // thing it has a budget of.
  const { blocks, problems } = await resolveMentions(`${goal}\n${instruction}`);
  if (blocks.length > 0) {
    lines.push("", "## Tagged sources — already fetched for you", ...blocks);
  }
  if (problems.length > 0) {
    lines.push(
      "",
      "## Tagged sources that could NOT be read — do not guess at what they said",
      ...problems.map((p) => `- ${p}`),
    );
  }
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
  questions: {
    key: string;
    question: string;
    kind: WorkflowQuestion["kind"];
    options?: string[];
  }[],
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

/**
 * Answer an unattended run's own questions, when it was started with
 * `askPolicy: "assume"`.
 *
 * Returns null for every other run, which is what makes `stop` the honest
 * default: a question then really does stop the run, and nothing here has
 * quietly decided on the user's behalf.
 *
 * The answer is deliberately not a decision — it tells the agent to choose and
 * to write down what it chose. A machine-invented "yes" to "should I change the
 * API contract?" would be far worse than a wait.
 */
export function assumeAnswers(
  runId: string,
  questions: { key: string; question: string }[],
): Record<string, string> | null {
  const run = getRun(runId);
  if (!run || !run.autoMode || run.askPolicy !== "assume") return null;

  const instruction =
    "Nobody is watching this run. Choose the most reasonable option, keep the change " +
    "reversible, and write the assumption into your summary so it reaches the PR. " +
    "If the question is about money, auth, user data, permissions, deleting data, a " +
    "schema or an API contract, do NOT choose — stop and say you need a person.";

  const answers: Record<string, string> = {};
  for (const q of questions) answers[q.key] = instruction;

  const now = nowIso();
  for (const q of getRun(runId)!.questions) {
    if (q.answer === null && q.key in answers) {
      db.update(schema.workflowQuestions)
        .set({ answer: answers[q.key]!, answeredAt: now })
        .where(eq(schema.workflowQuestions.id, q.id))
        .run();
    }
  }

  const row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
  const log = [
    row?.assumptions ?? "",
    ...questions.map((q) => `- ${now} · ${q.key}: ${q.question}`),
  ]
    .filter(Boolean)
    .join("\n");
  db.update(schema.workflowRuns)
    .set({ assumptions: log })
    .where(eq(schema.workflowRuns.id, runId))
    .run();

  return answers;
}

/**
 * Where a step runs. A step may name a project path by label, which is how one
 * branch of a run works on the iOS app while another works on the backend —
 * without it every step inherits the run's single cwd and "parallel" would mean
 * two agents in one working tree.
 */
function resolveStepPath(
  run: WorkflowRun,
  step: WorkflowStep,
): { id: string | null; path: string } {
  // Interpolated: a workflow can take "which repo" as an input instead of
  // hardcoding one label and being useless in the next project. A placeholder
  // nobody filled in falls back to the run's own directory.
  const label = step.cwdLabel ? interpolate(step.cwdLabel, run.inputs).trim() : "";
  if (!label || label.includes("{{")) return { id: null, path: run.cwd };
  const match = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, run.projectId))
    .all()
    .find((p) => p.label.toLowerCase() === label.toLowerCase());
  return match ? { id: match.id, path: match.path } : { id: null, path: run.cwd };
}

/**
 * One agent step, in a real terminal.
 *
 * The step's turn is typed into a `claude` PTY and the engine waits for the
 * ledger to say that turn closed. Everything the engine does around it —
 * scheduling, gates, retries, questions — is unchanged; what changed is that the
 * work is visible while it happens instead of afterwards.
 */
async function runAgentStep(
  run: WorkflowRun,
  step: WorkflowStep,
  index: number,
  attempt: number,
): Promise<{ ok: boolean; error?: string }> {
  const existing = run.runSteps.find((s) => s.stepKey === step.key);
  const target = resolveStepPath(run, step);

  let terminalId: string;
  let claudeSessionId: string;
  try {
    ({ terminalId, claudeSessionId } = terminalForStep(run, step, target.id));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  upsertRunStep(run.id, step.key, {
    status: "running",
    attempt,
    terminalId,
    startedAt: existing?.startedAt ?? nowIso(),
    error: null,
  });

  const prompt =
    attempt > 1
      ? `${await stepContext(run, step, index)}\n\n[Retry ${attempt}: the previous attempt failed. Fix the cause and finish the step.]`
      : await stepContext(run, step, index);

  const row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, run.id)).get();
  return runTurnInTerminal({
    terminalId,
    claudeSessionId,
    prompt,
    deadlineAt: row?.deadlineAt ? Date.parse(row.deadlineAt) : undefined,
  });
}

async function runCommandStep(
  run: WorkflowRun,
  step: WorkflowStep,
  attempt: number,
): Promise<{ ok: boolean; error?: string; tail?: string }> {
  // Commands are resolved by name against this project's configured commands.
  // A step naming a path label looks there first: two repos may both have a
  // command called `test`, and running the wrong one passes for the wrong reason.
  const allPaths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, run.projectId))
    .all();
  const preferredId = resolveStepPath(run, step).id;
  const paths = preferredId
    ? [
        ...allPaths.filter((p) => p.id === preferredId),
        ...allPaths.filter((p) => p.id !== preferredId),
      ]
    : allPaths;
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

  const { exitCode, tail } = await done;
  if (exitCode === 0) return { ok: true, tail };
  return { ok: false, error: `Command exited ${exitCode ?? "by signal"}`, tail };
}

// ── Scheduling ────────────────────────────────────────────────────────────────

function statusOf(run: WorkflowRun, key: string): WorkflowRunStepStatus {
  return run.runSteps.find((r) => r.stepKey === key)?.status ?? "pending";
}

function readySteps(run: WorkflowRun): WorkflowStep[] {
  return readyStepsOf(run.steps, (key) => statusOf(run, key));
}

function dependentsOf(run: WorkflowRun, key: string): string[] {
  return dependentsOfKey(run.steps, key);
}

/**
 * What a step holds while it runs. Two steps of one run never claim the same
 * working tree at the same moment: the repo lock would refuse the second, and a
 * refusal surfaces as a failed step instead of as a scheduling decision.
 */
function claimOf(run: WorkflowRun, step: WorkflowStep): string {
  return step.isolate ? `worktree:${step.key}` : resolveStepPath(run, step).path;
}

function isExpired(run: WorkflowRun): boolean {
  const row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, run.id)).get();
  if (!row?.deadlineAt) return false;
  return Date.parse(row.deadlineAt) < Date.now();
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
      if (run.status === "cancelled" || run.status === "done" || run.status === "failed")
        return run;

      // An unattended run has nobody to notice it hanging, so it carries a clock.
      if (isExpired(run)) {
        for (const rs of run.runSteps) {
          if (rs.status === "running") {
            if (rs.sessionId && isRunning(rs.sessionId)) await interrupt(rs.sessionId);
            upsertRunStep(runId, rs.stepKey, {
              status: "interrupted",
              note: "run out of time",
              finishedAt: nowIso(),
            });
          }
        }
        setRunStatus(runId, "failed", run.currentStepKey);
        notify("Workflow out of time", `${run.title} hit its budget and stopped`);
        return getRun(runId)!;
      }

      // A step waiting on a person keeps the whole run waiting: a parallel branch
      // may still be running, but nothing new is dispatched under an open question.
      const parked = run.runSteps.find(
        (r) => r.status === "awaiting_input" || r.status === "interrupted",
      );
      if (parked) {
        setRunStatus(runId, "awaiting_input", parked.stepKey);
        return getRun(runId)!;
      }
      if (run.questions.some((q) => q.answer === null)) {
        setRunStatus(runId, "awaiting_input", run.currentStepKey);
        return getRun(runId)!;
      }

      const ready = readySteps(run);
      if (ready.length === 0) {
        const stuck = run.steps.filter((s) => statusOf(run, s.key) === "pending");
        if (stuck.length === 0) {
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
        // Nothing can run and something is still pending: every remaining step is
        // behind a dependency that failed. Say that, rather than sit there.
        const blocked = stuck.map((s) => s.key).join(", ");
        setRunStatus(runId, "failed", stuck[0]!.key);
        emit(runId, { t: "error", message: `Blocked by a failed dependency: ${blocked}` });
        notify("Workflow blocked", `${run.title}: ${blocked}`);
        return getRun(runId)!;
      }

      // Conditions are evaluated before anything is dispatched, because a skip
      // changes what else becomes ready.
      let skipped = false;
      for (const step of ready) {
        let shouldRun: boolean;
        try {
          shouldRun = evaluateCondition(step.condition, conditionContext(run));
        } catch (err) {
          const message = err instanceof ConditionError ? err.message : String(err);
          upsertRunStep(runId, step.key, {
            status: "failed",
            error: message,
            finishedAt: nowIso(),
          });
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
          skipped = true;
        }
      }
      if (skipped) continue;

      // Steps that exist to make a human act. In an unattended run a `confirm`
      // is the gate being removed — but `manual` still stops, because it is work
      // only a person can do and walking past it would be a lie.
      const human = ready.find((s) => s.type === "confirm" || s.type === "manual");
      if (human) {
        if (run.autoMode && human.type === "confirm") {
          upsertRunStep(runId, human.key, {
            status: "done",
            note: "auto-approved (unattended run)",
            startedAt: nowIso(),
            finishedAt: nowIso(),
          });
          continue;
        }
        const stepRow = upsertRunStep(runId, human.key, {
          status: "awaiting_input",
          startedAt: nowIso(),
        });
        if (human.type === "confirm" && run.questions.length === 0) {
          recordQuestions(runId, stepRow.id, [
            {
              key: `${human.key}-ok`,
              question: human.instruction ?? "Reviewed and good to continue?",
              kind: "bool",
            },
          ]);
        }
        setRunStatus(runId, "awaiting_input", human.key);
        return getRun(runId)!;
      }

      // What can actually run now. Two steps never claim the same working tree:
      // the repo lock would refuse the second one, and a refusal looks like a
      // failed step rather than a scheduling decision.
      const limit = Math.max(1, setting("workflows.maxParallel"));
      const batch: WorkflowStep[] = [];
      const claimed = new Set<string>();
      for (const step of ready) {
        if (batch.length >= limit) break;
        const claim = claimOf(run, step);
        if (claimed.has(claim)) continue;
        claimed.add(claim);
        batch.push(step);
      }

      setRunStatus(runId, "running", batch[0]!.key);
      const outcomes = await Promise.all(
        batch.map(async (step) => {
          const rs = run.runSteps.find((r) => r.stepKey === step.key);
          const attempt = rs?.attempt ?? 1;
          const index = run.steps.findIndex((s) => s.key === step.key);
          const result =
            step.type === "agent"
              ? await runAgentStep(run, step, index, attempt)
              : await runCommandStep(run, step, attempt);
          return { step, attempt, result };
        }),
      );

      const after = getRun(runId)!;
      if (after.status === "cancelled") return after;

      let stop = false;
      for (const { step, attempt, result } of outcomes) {
        if (settleStep(after, step, attempt, result)) stop = true;
      }
      if (stop) return getRun(runId)!;
    }
  } finally {
    advancing.delete(runId);
  }
}

/**
 * Book one finished step and say whether the run must stop here.
 *
 * Split out of the loop because with a parallel batch every outcome has to be
 * recorded — returning at the first one that needs a human would leave its
 * siblings marked `running` for ever.
 */
function settleStep(
  run: WorkflowRun,
  step: WorkflowStep,
  attempt: number,
  result: { ok: boolean; error?: string; tail?: string },
): boolean {
  const runId = run.id;
  const stepRow = db
    .select()
    .from(schema.workflowRunSteps)
    .where(
      and(eq(schema.workflowRunSteps.runId, runId), eq(schema.workflowRunSteps.stepKey, step.key)),
    )
    .get()!;

  // The agent may have parked on a workflow_ask during its turn.
  const openQuestion = run.questions.some((q) => q.answer === null && q.runStepId === stepRow.id);
  if (openQuestion) {
    upsertRunStep(runId, step.key, { status: "awaiting_input" });
    setRunStatus(runId, "awaiting_input", step.key);
    if (run.autoMode) {
      notify("Workflow needs an answer", `${run.title}: ${step.title}`);
    }
    return true;
  }

  if (step.type === "gate") return settleGate(run, step, stepRow, result);

  if (result.ok) {
    upsertRunStep(runId, step.key, { status: "done", finishedAt: nowIso(), error: null });
    // A step that asked for confirmation but never called workflow_ask still needs
    // a human gate — unless this run was started with nobody watching.
    if (step.requiresConfirm && !run.autoMode) {
      const asked = run.questions.some((q) => q.runStepId === stepRow.id);
      if (!asked) {
        recordQuestions(runId, stepRow.id, [
          {
            key: `${step.key}-confirm`,
            question: `"${step.title}" finished. Review it and confirm, or say what to change.`,
            kind: "text",
          },
        ]);
        setRunStatus(runId, "awaiting_input", step.key);
        return true;
      }
    }
    return false;
  }

  if (attempt <= step.maxRetries) {
    upsertRunStep(runId, step.key, {
      status: "pending",
      attempt: attempt + 1,
      error: result.error ?? null,
    });
    return false;
  }

  upsertRunStep(runId, step.key, {
    status: "failed",
    error: result.error ?? "Step failed",
    finishedAt: nowIso(),
  });
  // A failed step doesn't necessarily kill the run: another step may be
  // conditioned on this failure (test → fix-tests), so let the scheduler decide.
  const hasRecovery = run.steps.some(
    (s) => s.key !== step.key && s.condition?.includes(`steps.${step.key}.failed`),
  );
  if (!hasRecovery) {
    setRunStatus(runId, "failed", step.key);
    notify("Workflow failed", `${run.title}: ${step.title}`);
    return true;
  }
  return false;
}

/**
 * A gate is the only step whose failure is a decision rather than an accident:
 * it sends the run back to the step that has to fix the problem and lets it try
 * again, which is the implement → test → fix loop people actually run by hand.
 *
 * Two brakes, both from the team's own rule: at most three rounds, and stop the
 * moment two rounds produce identical output — at that point it is not making
 * progress, it is turning on the spot.
 */
function settleGate(
  run: WorkflowRun,
  step: WorkflowStep,
  stepRow: typeof schema.workflowRunSteps.$inferSelect,
  result: { ok: boolean; error?: string; tail?: string },
): boolean {
  const runId = run.id;
  if (result.ok) {
    upsertRunStep(runId, step.key, {
      status: "done",
      finishedAt: nowIso(),
      error: null,
      note: `check passed${stepRow.loops > 0 ? ` after ${stepRow.loops} loop(s)` : ""}`,
    });
    return false;
  }

  const target = step.onFail ?? step.key;
  const cap = step.maxLoops || 3;
  const loops = stepRow.loops + 1;
  const fingerprint = (result.tail ?? "").trim().slice(-2000);
  const repeated = fingerprint.length > 0 && fingerprint === stepRow.note;
  // A command this project never declared is not a failing check — it is a gate
  // pointed at nothing, and sending the run back to "fix it" three times fixes
  // nothing while burning three agent turns.
  const noSuchCommand = (result.error ?? "").startsWith("No command named");

  const giveUp = noSuchCommand || loops > cap || repeated || target === step.key;
  if (giveUp) {
    upsertRunStep(runId, step.key, {
      status: "failed",
      loops,
      error: noSuchCommand
        ? result.error
        : repeated
          ? `${result.error} — and the same output twice in a row, so it is not getting anywhere`
          : `${result.error} after ${loops - 1} loop(s) back to "${target}"`,
      finishedAt: nowIso(),
    });
    setRunStatus(runId, "failed", step.key);
    notify("Workflow gate failed", `${run.title}: ${step.title}`);
    return true;
  }

  // Back to the step that has to fix it, and everything downstream of that one,
  // this gate included. The fixing step keeps its session, so it starts the next
  // attempt knowing what it already tried.
  const chain = new Set([target, ...dependentsOf(run, target)]);
  for (const key of chain) {
    if (key === step.key) continue;
    upsertRunStep(runId, key, { status: "pending", finishedAt: null, error: null });
  }
  upsertRunStep(runId, step.key, {
    status: "pending",
    loops,
    // The fingerprint of this round, so the next one can tell it apart.
    note: fingerprint,
    error: result.error ?? null,
    finishedAt: null,
  });
  return false;
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
  // Everything downstream must re-run too, or the run would resume past the
  // retried step with results computed from what it used to produce. Only
  // downstream: a branch that ran beside this one is untouched by the retry.
  for (const later of dependentsOf(run, stepKey)) {
    const laterRs = run.runSteps.find((s) => s.stepKey === later);
    if (laterRs && laterRs.status !== "pending") {
      upsertRunStep(runId, later, { status: "pending", finishedAt: null, error: null });
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
