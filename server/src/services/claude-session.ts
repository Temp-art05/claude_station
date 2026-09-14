import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  query,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { asc, desc, eq } from "drizzle-orm";
import type { ChatServerMsg, PermissionMode } from "@claude-station/shared";
import { db, schema } from "../db";
import { stationMcpServer } from "../mcp/server";
import { setting } from "../lib/config";
import { ATTACHMENTS_DIR, projectKnowledgeDir } from "../lib/data-dir";
import { childBaseEnv } from "../lib/child-env";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { agentBundleDirs, agentDefinition, agentsForProject } from "./agents";
import { envVarsFor } from "./env-sets";
import { attachedAssetDirs } from "./library";
import { notify } from "./notify";
import { filesFromToolUse, toolLabel } from "../lib/tool-files";
import * as ledger from "./session-ledger";
import { snapshotTree, touchesBetween, type TreeSnapshot } from "./tree-snapshot";
import { buildWorkspaceContext } from "./workspace-context";

type Listener = (msg: ChatServerMsg) => void;

interface PendingPermission {
  resolve(result: PermissionResult): void;
  timer: NodeJS.Timeout;
}

interface Live {
  listeners: Set<Listener>;
  abort: AbortController | null;
  running: boolean;
  seq: number;
  pending: Map<string, PendingPermission>;
  activeQuery: Query | null;
  /**
   * The ledger turn this session currently has open, or null when nothing is
   * being captured. Held here rather than passed down `runTurn` because a failed
   * resume retries the same user prompt (see `runTurn`'s `isRetry`), and that
   * must stay ONE turn — token totals and A2's candidate window both go wrong if
   * one prompt becomes two.
   */
  turnId: string | null;
  /**
   * The working tree as it was when the turn started. Compared against the tree at
   * the end, this is the only way to see an edit made through `Bash` — a tool call
   * names its file, a shell command does not.
   */
  treeBefore: TreeSnapshot | null;
}

const live = new Map<string, Live>();
/** One turn per repo at a time — two agents editing the same tree corrupt each other. */
const repoLocks = new Set<string>();

function state(sessionId: string): Live {
  let s = live.get(sessionId);
  if (!s) {
    const last = db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, sessionId))
      .orderBy(desc(schema.chatMessages.seq))
      .limit(1)
      .get();
    s = {
      listeners: new Set(),
      abort: null,
      running: false,
      seq: last?.seq ?? 0,
      pending: new Map(),
      activeQuery: null,
      turnId: null,
      treeBefore: null,
    };
    live.set(sessionId, s);
  }
  return s;
}

export function subscribe(sessionId: string, listener: Listener): () => void {
  const s = state(sessionId);
  s.listeners.add(listener);
  if (s.running) listener({ t: "status", value: "running" });
  return () => {
    s.listeners.delete(listener);
    // Nobody is watching: a pending approval can never be answered, so deny it
    // rather than leaving the turn hanging forever.
    if (s.listeners.size === 0) {
      for (const [id, p] of s.pending) {
        clearTimeout(p.timer);
        p.resolve({ behavior: "deny", message: "No UI attached to approve this tool call." });
        s.pending.delete(id);
      }
    }
  };
}

function broadcast(sessionId: string, msg: ChatServerMsg): void {
  for (const l of state(sessionId).listeners) l(msg);
}

function persist(sessionId: string, message: SDKMessage): number {
  const s = state(sessionId);
  s.seq += 1;
  const raw = message as unknown as Record<string, unknown>;
  db.insert(schema.chatMessages)
    .values({
      id: newId(),
      sessionId,
      seq: s.seq,
      role: typeof raw.role === "string" ? raw.role : inferRole(message.type),
      type: message.type,
      content: JSON.stringify(message),
      textPreview: previewOf(message).slice(0, 2000),
      createdAt: nowIso(),
    })
    .run();
  return s.seq;
}

function inferRole(type: string): string {
  if (type === "assistant") return "assistant";
  if (type === "user" || type === "user_replay") return "user";
  if (type === "result") return "result";
  return "system";
}

/** Human-readable one-liner used for history lists, search and resume recaps. */
export function previewOf(message: SDKMessage): string {
  const raw = message as unknown as {
    message?: { content?: unknown };
    result?: unknown;
    subtype?: string;
  };
  const content = raw.message?.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "tool_use" && typeof block.name === "string") {
        parts.push(`[tool: ${block.name}]`);
      } else if (block.type === "thinking") parts.push("[thinking]");
    }
    if (parts.length) return parts.join("\n");
  }
  if (typeof content === "string") return content;
  if (typeof raw.result === "string") return raw.result;
  return raw.subtype ? `${message.type}:${raw.subtype}` : message.type;
}

function loadSession(sessionId: string) {
  const session = db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId))
    .get();
  if (!session) throw badRequest("Session not found");
  return session;
}

function runningTurns(): number {
  let n = 0;
  for (const s of live.values()) if (s.running) n += 1;
  return n;
}

function buildOptions(session: ReturnType<typeof loadSession>): Options {
  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, session.projectId))
    .orderBy(asc(schema.projectPaths.sortOrder))
    .all();

  const cwd = session.worktreePath ?? session.cwd;
  const extraDirs = [
    ...paths.map((p) => p.path).filter((p) => p !== cwd),
    projectKnowledgeDir(session.projectId),
    // Assets attached from the global library live outside the project store.
    ...attachedAssetDirs(session.projectId),
    // Pasted screenshots live here; Read handles images, so a path is enough.
    join(ATTACHMENTS_DIR, session.id),
  ];

  const baseEnv = childBaseEnv();

  const abort = new AbortController();
  state(session.id).abort = abort;

  // Globally enabled agents + this project's opt-ins.
  const agents = agentsForProject(session.projectId);

  // An agent workspace runs that agent as the main thread (options.agent), so it
  // has to be in the map even when it isn't enabled for the project — the user
  // started it explicitly from this project's Agents tab.
  const mainAgent = session.agentName ?? null;
  if (mainAgent && !agents[mainAgent]) {
    const definition = agentDefinition(mainAgent);
    if (definition) agents[mainAgent] = definition;
  }

  // Folder-imported agents carry companion files the session must be able to Read.
  extraDirs.push(...agentBundleDirs(Object.keys(agents)));

  return {
    cwd,
    resume: session.sdkSessionId ?? undefined,
    permissionMode: session.permissionMode as PermissionMode,
    model: session.model ?? undefined,
    ...(mainAgent && agents[mainAgent] ? { agent: mainAgent } : {}),
    // Load the user's skills and the repo's CLAUDE.md — same as the CLI would.
    settingSources: ["user", "project"],
    additionalDirectories: extraDirs,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildWorkspaceContext(session.projectId),
    },
    // Jira / spreadsheet / knowledge / build-command tools, in-process.
    mcpServers: {
      station: stationMcpServer(session.projectId, session.id, session.workflowRunStepId),
    },
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    env: { ...baseEnv, ...envVarsFor(session.envSetId) },
    includePartialMessages: true,
    abortController: abort,
    canUseTool: (toolName, input) => requestPermission(session.id, toolName, input),
  };
}

/** Memory tools that run without an approval modal — everything but delete. */
const MEMORY_TOOLS_NO_PROMPT = new Set(
  ["list", "get", "search", "write", "update"].map((op) => `mcp__station__memory_${op}`),
);

/** Bridge the SDK's approval callback to the browser modal (or a policy denial). */
function requestPermission(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const s = state(sessionId);

  // The workflow tools are the consent channel itself: workflow_ask is how a run
  // asks the user anything, and its questions surface on the run view rather than
  // in this session's tab. Gating them behind a per-session approval modal would
  // deadlock exactly the case they exist for — a step running with nobody
  // watching the session. They touch no files and no external service.
  if (toolName.startsWith("mcp__station__workflow_")) {
    return Promise.resolve({ behavior: "allow" });
  }

  // Memory writes go to this app's own database — no file, no repo, no external
  // service — and the Memory tab is there to review or undo them. Prompting for
  // each one is what kept the store empty: a session with nobody watching gets a
  // flat deny below, so notes were only ever saved when the user was looking.
  // Deleting is the exception: it destroys something the user may have written.
  if (MEMORY_TOOLS_NO_PROMPT.has(toolName)) {
    return Promise.resolve({ behavior: "allow" });
  }

  if (s.listeners.size === 0) {
    const session = db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, sessionId))
      .get();
    return Promise.resolve({
      behavior: "deny",
      message:
        session?.kind === "workflow"
          ? `Nothing is attached to approve ${toolName}, and this workflow step runs at permissionMode "${session.permissionMode}". Set the step to acceptEdits if it should run unattended.`
          : "No UI attached to approve this tool call.",
    });
  }

  const requestId = randomUUID();
  const timeoutSec = setting("permission.timeoutSec");

  return new Promise<PermissionResult>((resolve) => {
    const timer = setTimeout(() => {
      s.pending.delete(requestId);
      broadcast(sessionId, { t: "permission_timeout", requestId });
      resolve({ behavior: "deny", message: `Approval timed out after ${timeoutSec}s.` });
    }, timeoutSec * 1000);

    s.pending.set(requestId, { resolve, timer });
    broadcast(sessionId, { t: "permission_request", requestId, toolName, input, timeoutSec });
  });
}

export function resolvePermission(
  sessionId: string,
  requestId: string,
  result: PermissionResult,
): boolean {
  const s = state(sessionId);
  const pending = s.pending.get(requestId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  s.pending.delete(requestId);
  pending.resolve(result);
  if (result.behavior === "deny") {
    const session = loadSession(sessionId);
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: session.projectId,
        kind: "permission_denied",
        refId: sessionId,
        summary: `Denied a tool call: ${result.message}`,
        createdAt: nowIso(),
      })
      .run();
  }
  return true;
}

/** Attachment paths are appended to the prompt; Claude reads them with Read. */
function attachmentNote(sessionId: string, attachmentIds: string[]): string {
  if (attachmentIds.length === 0) return "";
  const rows = db
    .select()
    .from(schema.chatAttachments)
    .where(eq(schema.chatAttachments.sessionId, sessionId))
    .all()
    .filter((a) => attachmentIds.includes(a.id));
  if (rows.length === 0) return "";
  const lines = rows.map((a) => `- \`${a.storedPath}\` (${a.mime}, ${a.originalFilename})`);
  return `\n\n[Attached by the user — read these files:]\n${lines.join("\n")}`;
}

export async function sendUserMessage(
  sessionId: string,
  text: string,
  attachmentIds: string[] = [],
): Promise<void> {
  const s = state(sessionId);
  if (s.running) throw badRequest("This session already has a turn running");
  if (runningTurns() >= setting("concurrency.maxTurns")) {
    throw badRequest("Too many Claude turns running — wait for one to finish");
  }

  const session = loadSession(sessionId);
  const repoKey = session.worktreePath ?? session.cwd;
  const lockRepo = setting("concurrency.repoLock");
  if (lockRepo && repoLocks.has(repoKey)) {
    throw badRequest(
      "Another session is already working in this repo. Wait, or create the session with its own git worktree.",
    );
  }

  s.running = true;
  if (lockRepo) repoLocks.add(repoKey);
  db.update(schema.chatSessions)
    .set({ status: "running", updatedAt: nowIso() })
    .where(eq(schema.chatSessions.id, sessionId))
    .run();
  broadcast(sessionId, { t: "status", value: "running" });

  // Record the user's turn ourselves — the SDK only echoes what it sends on.
  const userSeq = (() => {
    s.seq += 1;
    db.insert(schema.chatMessages)
      .values({
        id: newId(),
        sessionId,
        seq: s.seq,
        role: "user",
        type: "user_input",
        content: JSON.stringify({ type: "user_input", text }),
        textPreview: text.slice(0, 2000),
        createdAt: nowIso(),
      })
      .run();
    return s.seq;
  })();
  broadcast(sessionId, {
    t: "message",
    seq: userSeq,
    message: { type: "user_input", text },
  });

  // Before the turn touches anything. Cheap even on a 6.3GB repo (measured at
  // 23-54ms), and without it every Bash-driven edit is invisible.
  s.treeBefore = snapshotTree(repoKey);
  // The user's own text, not the prompt we assemble: attachment notes and resume
  // recaps are our additions and would only pad the record.
  s.turnId = ledger.openTurn({
    projectId: session.projectId,
    sourceKind: "sdk",
    cwd: repoKey,
    chatSessionId: sessionId,
    workflowRunId: workflowRunIdOf(session.workflowRunStepId),
    model: session.model,
    prompt: text,
  });

  try {
    await runTurn(sessionId, session, `${text}${attachmentNote(sessionId, attachmentIds)}`);
  } finally {
    // The result branch normally closes the turn. Reaching here still open means
    // the stream ended without one — an abort, or a throw the catch already
    // reported — so close it rather than leave a row stuck on `running`.
    if (s.turnId) {
      // A turn that died still changed files; record them before closing it.
      recordTreeChanges(sessionId, repoKey);
      ledger.closeTurn(s.turnId, { status: s.abort?.signal.aborted ? "interrupted" : "error" });
      s.turnId = null;
    }
    s.treeBefore = null;
    s.running = false;
    s.abort = null;
    s.activeQuery = null;
    if (lockRepo) repoLocks.delete(repoKey);
    broadcast(sessionId, { t: "status", value: "idle" });
  }
}

/**
 * The run a workflow step belongs to. The step id is what the session carries;
 * the ledger wants the run, so that "which commits did this run produce" is one
 * query later on.
 */
function workflowRunIdOf(runStepId: string | null): string | null {
  if (!runStepId) return null;
  const step = db
    .select({ runId: schema.workflowRunSteps.runId })
    .from(schema.workflowRunSteps)
    .where(eq(schema.workflowRunSteps.id, runStepId))
    .get();
  return step?.runId ?? null;
}

async function runTurn(
  sessionId: string,
  session: ReturnType<typeof loadSession>,
  text: string,
  isRetry = false,
): Promise<void> {
  const s = state(sessionId);
  const options = buildOptions(session);
  const q = query({ prompt: text, options });
  s.activeQuery = q;

  try {
    for await (const message of q) {
      const raw = message as unknown as Record<string, unknown>;

      // Partial assistant text: stream it, don't persist (only finals are stored).
      if (message.type === "stream_event") {
        const delta = extractDelta(raw);
        if (delta) broadcast(sessionId, { t: "delta", text: delta });
        continue;
      }

      const seq = persist(sessionId, message);
      broadcast(sessionId, { t: "message", seq, message });

      // Written as they happen, not batched at the end: a turn killed by a crash
      // still leaves behind what it had already touched, which is exactly what
      // commit attribution needs.
      recordToolUse(sessionId, session, message);

      if (typeof raw.session_id === "string" && raw.session_id !== session.sdkSessionId) {
        // Resume can mint a new id — always keep the newest.
        session.sdkSessionId = raw.session_id;
        db.update(schema.chatSessions)
          .set({ sdkSessionId: raw.session_id, updatedAt: nowIso() })
          .where(eq(schema.chatSessions.id, sessionId))
          .run();
        broadcast(sessionId, {
          t: "session",
          sdkSessionId: raw.session_id,
          cwd: session.worktreePath ?? session.cwd,
          model: session.model,
        });
      }

      if (message.type === "result") {
        const result = raw as { is_error?: boolean; duration_ms?: number; total_cost_usd?: number };
        db.update(schema.chatSessions)
          .set({ status: result.is_error ? "error" : "idle", updatedAt: nowIso() })
          .where(eq(schema.chatSessions.id, sessionId))
          .run();
        // The tab may be in the background — surface it at the OS level too.
        notify(
          result.is_error ? "Claude session failed" : "Claude finished",
          `${session.title}: ${previewOf(message).slice(0, 120)}`,
        );
        broadcast(sessionId, {
          t: "result",
          costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
          durationMs: typeof result.duration_ms === "number" ? result.duration_ms : null,
          isError: result.is_error === true,
        });

        // Whatever moved in the tree during the turn, whichever tool moved it.
        recordTreeChanges(sessionId, session.worktreePath ?? session.cwd);

        // `usage` on the result is the whole turn's, so no accumulating needed.
        // This is also the only surface that reports a cost at all: CLI
        // transcripts carry none (measured), so the ledger leaves theirs NULL.
        const usage = (raw.usage ?? {}) as Record<string, unknown>;
        ledger.closeTurn(s.turnId, {
          status: result.is_error ? "error" : "done",
          inputTokens: num(usage.input_tokens),
          outputTokens: num(usage.output_tokens),
          cacheReadTokens: num(usage.cache_read_input_tokens),
          cacheCreateTokens: num(usage.cache_creation_input_tokens),
          costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
          durationMs: typeof result.duration_ms === "number" ? result.duration_ms : null,
        });
        s.turnId = null;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // The CLI prunes its own transcripts; a dead `resume` id shouldn't kill the
    // thread. Drop the id, replay a recap of our own history, and carry on.
    const resumeFailed =
      !isRetry &&
      session.sdkSessionId !== null &&
      /resume|session.*not found|no conversation/i.test(message);

    if (resumeFailed) {
      db.update(schema.chatSessions)
        .set({ sdkSessionId: null, updatedAt: nowIso() })
        .where(eq(schema.chatSessions.id, sessionId))
        .run();
      session.sdkSessionId = null;
      broadcast(sessionId, {
        t: "error",
        message: "Previous transcript was gone — rebuilt context from local history.",
      });
      await runTurn(sessionId, session, `${recapFor(sessionId)}\n\n---\n\n${text}`, true);
      return;
    }

    db.update(schema.chatSessions)
      .set({ status: "error", updatedAt: nowIso() })
      .where(eq(schema.chatSessions.id, sessionId))
      .run();
    broadcast(sessionId, { t: "error", message });
  }
}

/**
 * Compare the tree against the snapshot taken at the start of the turn and record
 * the difference as ground truth (`source: "tree"`).
 *
 * Includes what the turn committed as it went: with a clean tree at both ends, the
 * status comparison alone would say a turn that committed its work changed nothing.
 */
function recordTreeChanges(sessionId: string, cwd: string): void {
  const s = state(sessionId);
  if (!s.turnId || !s.treeBefore) return;
  const touches = touchesBetween(s.treeBefore, snapshotTree(cwd));
  if (touches.length > 0) ledger.recordFiles(s.turnId, touches);
}

/** Usage numbers arrive as unknown from the raw message; missing means zero. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Ledger the tool calls in one assistant message: how many, and which files they
 * named.
 *
 * Files land with `source: "tool"` — a hint, deliberately not treated as the
 * whole truth. A tool call names its file, but an edit made through `Bash` names
 * nothing, so this list is always a lower bound; the working-tree snapshot at the
 * turn boundary is what closes the gap.
 */
function recordToolUse(
  sessionId: string,
  session: ReturnType<typeof loadSession>,
  message: SDKMessage,
): void {
  const turnId = state(sessionId).turnId;
  if (!turnId) return;
  const content = (message as unknown as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return;

  const cwd = session.worktreePath ?? session.cwd;
  const touches: ledger.FileTouch[] = [];
  let calls = 0;

  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type !== "tool_use" || typeof block.name !== "string") continue;
    calls += 1;
    const label = toolLabel(block.name, block.input);
    for (const touch of filesFromToolUse(block.name, block.input, cwd)) {
      touches.push({ ...touch, source: "tool", toolName: label });
    }
  }

  if (calls > 0) ledger.bumpToolCalls(turnId, calls);
  if (touches.length > 0) ledger.recordFiles(turnId, touches);
}

function extractDelta(raw: Record<string, unknown>): string | null {
  const event = raw.event as
    { type?: string; delta?: { type?: string; text?: string } } | undefined;
  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return event.delta.text ?? null;
  }
  return null;
}

/** Compact recap used when the SDK transcript is gone but ours isn't. */
function recapFor(sessionId: string, turns = 12): string {
  const rows = db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(desc(schema.chatMessages.seq))
    .limit(turns)
    .all()
    .reverse();
  const lines = rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => `${r.role}: ${r.textPreview.slice(0, 400)}`);
  return [
    "[Context rebuilt by claude-station — the previous transcript was pruned.]",
    "Recent history:",
    ...lines,
  ].join("\n");
}

export async function interrupt(sessionId: string): Promise<void> {
  const s = state(sessionId);
  // Say it plainly here: the turn ends because the user stopped it, not because
  // it failed. The finally in sendUserMessage would infer this from the abort
  // signal, but only for a turn that is still open by then.
  if (s.turnId) {
    ledger.closeTurn(s.turnId, { status: "interrupted" });
    s.turnId = null;
  }
  for (const [id, p] of s.pending) {
    clearTimeout(p.timer);
    p.resolve({ behavior: "deny", message: "Interrupted by the user." });
    s.pending.delete(id);
  }
  try {
    await s.activeQuery?.interrupt();
  } catch {
    /* fall through to abort */
  }
  s.abort?.abort();
}

export function isRunning(sessionId: string): boolean {
  return live.get(sessionId)?.running ?? false;
}
