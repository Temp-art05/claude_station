/**
 * The session ledger: what each agent turn did, for both surfaces.
 *
 * A turn is one user prompt and everything the agent did answering it. Nothing
 * here parses transcripts or hooks the SDK — this is the write and read API those
 * callers use (see `docs/plans/session-ledger.md`), kept in one place so the two
 * surfaces can't drift into recording different things.
 *
 * Two rules the callers rely on:
 *   - Never throw at a caller. Failing to record a turn must not fail the turn
 *     itself; capture degrades and says so, the way `git-watch` degrades to polling.
 *   - The transcript stays the source of truth. Everything here is rebuildable, so
 *     a parser bug is a reindex, not a migration.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { newId, nowIso } from "../lib/id";
import { pathUnder, pathUnderAny, realish, relativeUnder } from "../lib/path-compare";
import { redactVerbose } from "../lib/redact";
import { estimateCost } from "./model-pricing";

export type TurnSource = "sdk" | "cli";
export type TurnStatus = "running" | "done" | "error" | "interrupted";
export type FileOp = "read" | "write" | "delete";
/** `tree` is ground truth (the working tree moved); `tool` is a hint. */
export type FileSource = "tree" | "tool";

export interface OpenTurnInput {
  projectId: string;
  sourceKind: TurnSource;
  cwd: string;
  chatSessionId?: string | null;
  claudeSessionId?: string | null;
  terminalId?: string | null;
  workflowRunId?: string | null;
  gitBranch?: string | null;
  model?: string | null;
  prompt?: string;
  /** Transcript timestamps are historical, so backfill must be able to set this. */
  startedAt?: string;
  /** Backfill knows the turn number already; live capture lets us derive it. */
  seq?: number;
}

export interface CloseTurnInput {
  status?: TurnStatus;
  /**
   * The model that answered, when the caller only learns it mid-turn. The CLI
   * does: the prompt record names no model, the assistant records that follow it
   * do — and without it the turn cannot be priced.
   */
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  /** SDK only — CLI transcripts carry no cost, so leave it unset there. */
  costUsd?: number | null;
  durationMs?: number | null;
  toolCallCount?: number;
  endedAt?: string;
}

export interface FileTouch {
  absPath: string;
  op: FileOp;
  source: FileSource;
  toolName?: string | null;
}

export type Turn = typeof schema.sessionTurns.$inferSelect;
export type TurnFile = typeof schema.sessionFiles.$inferSelect;

/** Off means no rows are written at all — the feature has to switch off cleanly. */
export function ledgerEnabled(): boolean {
  return setting("ledger.enabled");
}

const PREVIEW_CHARS = 200;

// -- secrets ------------------------------------------------------------------

interface SecretCache {
  at: number;
  values: string[];
}
let secretCache: SecretCache | null = null;
const SECRET_TTL_MS = 30_000;

/**
 * Plaintext values of every env var marked secret, across all sets. Cached
 * briefly: a turn can record many files, and this must not become one query per
 * write. The TTL is what makes a var marked secret mid-session take effect
 * without a restart.
 */
export function secretValues(): string[] {
  const now = Date.now();
  if (secretCache && now - secretCache.at < SECRET_TTL_MS) return secretCache.values;
  let values: string[];
  try {
    values = db
      .select({ value: schema.envVars.value })
      .from(schema.envVars)
      .where(eq(schema.envVars.isSecret, true))
      .all()
      .map((r) => r.value);
  } catch {
    // A read failure must not mean "write the prompt unredacted": fall back to
    // the previous list, and to patterns alone if there was none.
    values = secretCache?.values ?? [];
  }
  secretCache = { at: now, values };
  return values;
}

/** Drop the cache — for tests, and for the env editor after a save. */
export function forgetSecrets(): void {
  secretCache = null;
}

// -- paths --------------------------------------------------------------------

/**
 * Which repo of the project a file belongs to, by longest matching prefix.
 *
 * Longest wins because a monorepo can have several `project_paths` nested inside
 * one another, and the innermost one is the answer. A session's own worktree
 * (`data/worktrees/<id>`) matches none of them on purpose — A2 maps a worktree
 * back to its repo, and pretending it is the repo here would put two different
 * trees under one path id.
 */
export function resolveProjectPath(
  projectId: string,
  absPath: string,
): { projectPathId: string | null; relPath: string } {
  let rows: { id: string; path: string }[];
  try {
    rows = db
      .select({ id: schema.projectPaths.id, path: schema.projectPaths.path })
      .from(schema.projectPaths)
      .where(eq(schema.projectPaths.projectId, projectId))
      .all();
  } catch {
    return { projectPathId: null, relPath: "" };
  }
  let best: { id: string; path: string } | null = null;
  for (const row of rows) {
    // Case-aware: on macOS the CLI can record a different spelling of the very
    // same directory than the one configured here (see lib/path-compare.ts).
    if (!pathUnder(absPath, row.path)) continue;
    if (!best || row.path.length > best.path.length) best = row;
  }
  if (!best) return { projectPathId: null, relPath: "" };
  return { projectPathId: best.id, relPath: relativeUnder(absPath, best.path) };
}

// -- write --------------------------------------------------------------------

/** Next turn number for whichever session key this turn belongs to. */
function nextSeq(input: OpenTurnInput): number {
  const key = input.chatSessionId
    ? eq(schema.sessionTurns.chatSessionId, input.chatSessionId)
    : input.claudeSessionId
      ? eq(schema.sessionTurns.claudeSessionId, input.claudeSessionId)
      : null;
  if (!key) return 1;
  const last = db
    .select({ seq: schema.sessionTurns.seq })
    .from(schema.sessionTurns)
    .where(key)
    .orderBy(desc(schema.sessionTurns.seq))
    .limit(1)
    .get();
  return (last?.seq ?? 0) + 1;
}

/**
 * Start a turn. Returns its id, or null when nothing was recorded — callers pass
 * that id back to `recordFiles`/`closeTurn`, and must treat null as "not capturing"
 * rather than as an error.
 */
export function openTurn(input: OpenTurnInput): string | null {
  if (!ledgerEnabled()) return null;
  try {
    const prompt = redactVerbose(input.prompt ?? "", secretValues(), {
      entropy: setting("ledger.redactEntropy"),
    }).text;
    const id = newId();
    db.insert(schema.sessionTurns)
      .values({
        id,
        projectId: input.projectId,
        sourceKind: input.sourceKind,
        chatSessionId: input.chatSessionId ?? null,
        claudeSessionId: input.claudeSessionId ?? null,
        terminalId: input.terminalId ?? null,
        workflowRunId: input.workflowRunId ?? null,
        seq: input.seq ?? nextSeq(input),
        cwd: input.cwd,
        gitBranch: input.gitBranch ?? null,
        model: input.model ?? null,
        promptText: prompt,
        promptPreview: preview(prompt),
        status: "running",
        startedAt: input.startedAt ?? nowIso(),
      })
      .run();
    return id;
  } catch {
    return null;
  }
}

/** Collapsed to one line — enough for a list row without loading the whole prompt. */
function preview(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

/**
 * Who is waiting for a turn to finish, keyed by the CLI conversation.
 *
 * The workflow engine drives steps by typing into a real `claude` terminal, so it
 * needs to know when a turn ended — and the transcript follower already knows,
 * because closing the turn is what it does. Handing that fact over here costs
 * nothing and saves the engine from polling a table.
 */
const turnWaiters = new Map<string, Set<(turnId: string, status: TurnStatus) => void>>();

/** Call back once the next turn of this CLI conversation closes. Returns an unsubscribe. */
export function onTurnClosed(
  claudeSessionId: string,
  listener: (turnId: string, status: TurnStatus) => void,
): () => void {
  const set = turnWaiters.get(claudeSessionId) ?? new Set();
  set.add(listener);
  turnWaiters.set(claudeSessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) turnWaiters.delete(claudeSessionId);
  };
}

function announceClosed(turnId: string, status: TurnStatus): void {
  const row = db.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.id, turnId)).get();
  const key = row?.claudeSessionId;
  if (!key) return;
  for (const listener of turnWaiters.get(key) ?? []) {
    try {
      listener(turnId, status);
    } catch {
      /* a waiter that throws must not break capture */
    }
  }
}

export function closeTurn(turnId: string | null, input: CloseTurnInput = {}): void {
  if (!turnId) return;
  try {
    db.update(schema.sessionTurns)
      .set({
        status: input.status ?? "done",
        ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
        ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
        ...(input.cacheReadTokens === undefined ? {} : { cacheReadTokens: input.cacheReadTokens }),
        ...(input.cacheCreateTokens === undefined
          ? {}
          : { cacheCreateTokens: input.cacheCreateTokens }),
        ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
        ...(input.model === undefined || input.model === null ? {} : { model: input.model }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.toolCallCount === undefined ? {} : { toolCallCount: input.toolCallCount }),
        endedAt: input.endedAt ?? nowIso(),
      })
      .where(eq(schema.sessionTurns.id, turnId))
      .run();
    priceTurn(turnId, input);
    announceClosed(turnId, input.status ?? "done");
  } catch {
    /* capture is best effort - see the header */
  }
}

/**
 * Settle what the turn cost, and say where the number came from.
 *
 * Called on every close, including the repeated closes a live CLI turn gets as
 * more of its transcript arrives — so it has to be idempotent, and it has to
 * refuse to downgrade: once the SDK has reported a real cost, no later estimate
 * may overwrite it.
 */
function priceTurn(turnId: string, input: CloseTurnInput): void {
  try {
    if (typeof input.costUsd === "number") {
      db.update(schema.sessionTurns)
        .set({ costSource: "reported" })
        .where(eq(schema.sessionTurns.id, turnId))
        .run();
      return;
    }

    // The toggle governs new estimates too, not just the fetch: turning pricing
    // off and still watching derived numbers appear would make it a lie.
    if (!setting("pricing.enabled")) return;

    const row = db
      .select({
        model: schema.sessionTurns.model,
        costSource: schema.sessionTurns.costSource,
        inputTokens: schema.sessionTurns.inputTokens,
        outputTokens: schema.sessionTurns.outputTokens,
        cacheReadTokens: schema.sessionTurns.cacheReadTokens,
        cacheCreateTokens: schema.sessionTurns.cacheCreateTokens,
      })
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.id, turnId))
      .get();
    if (!row || row.costSource === "reported") return;

    const usd = estimateCost(input.model ?? row.model, row);
    // No price for this model: leave the turn `unknown` and let the UI show
    // tokens. A zero here would read as "this was free".
    if (usd === null) return;

    db.update(schema.sessionTurns)
      .set({ costUsd: usd, costSource: "estimated" })
      .where(eq(schema.sessionTurns.id, turnId))
      .run();
  } catch {
    /* pricing is the least important thing a turn does */
  }
}

/**
 * Price every turn that was recorded before there was a price table.
 *
 * A turn is only priced at the moment it closes, so the rows already in the
 * ledger when pricing arrives would stay blank for ever. Run after a refresh
 * succeeds. Turns whose model was never recorded — every CLI turn captured before
 * the follower learned to carry one — cannot be priced here; a full reindex from
 * Settings rebuilds those from the transcript.
 */
export function repriceUnpriced(limit = 20_000): number {
  try {
    const rows = db
      .select({
        id: schema.sessionTurns.id,
        model: schema.sessionTurns.model,
        inputTokens: schema.sessionTurns.inputTokens,
        outputTokens: schema.sessionTurns.outputTokens,
        cacheReadTokens: schema.sessionTurns.cacheReadTokens,
        cacheCreateTokens: schema.sessionTurns.cacheCreateTokens,
      })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.costSource, "unknown"),
          isNull(schema.sessionTurns.costUsd),
          sql`${schema.sessionTurns.model} is not null`,
        ),
      )
      .limit(limit)
      .all();

    let priced = 0;
    for (const row of rows) {
      const usd = estimateCost(row.model, row);
      if (usd === null) continue;
      db.update(schema.sessionTurns)
        .set({ costUsd: usd, costSource: "estimated" })
        .where(eq(schema.sessionTurns.id, row.id))
        .run();
      priced += 1;
    }
    return priced;
  } catch {
    return 0;
  }
}

/**
 * Add to the turn's line counts.
 *
 * Accumulated rather than set, because both surfaces see tool calls arrive in
 * batches — a drain at a time for the CLI, a message at a time for the SDK.
 */
export function bumpLines(turnId: string | null, added: number, removed: number): void {
  if (!turnId || (added === 0 && removed === 0)) return;
  try {
    db.update(schema.sessionTurns)
      .set({
        linesAdded: sql`${schema.sessionTurns.linesAdded} + ${added}`,
        linesRemoved: sql`${schema.sessionTurns.linesRemoved} + ${removed}`,
      })
      .where(eq(schema.sessionTurns.id, turnId))
      .run();
  } catch {
    /* best effort */
  }
}

/**
 * Record files a turn touched.
 *
 * Deduplicated on (source, op, path): a turn reading the same file eight times is
 * one fact. A `tree` claim is never collapsed into a `tool` one — that distinction
 * is exactly what A2's confidence scoring reads.
 */
export function recordFiles(turnId: string | null, files: readonly FileTouch[]): number {
  if (!turnId || files.length === 0) return 0;
  try {
    const turn = db
      .select({ projectId: schema.sessionTurns.projectId })
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.id, turnId))
      .get();
    if (!turn) return 0;

    const seen = new Set(
      db
        .select({
          absPath: schema.sessionFiles.absPath,
          op: schema.sessionFiles.op,
          source: schema.sessionFiles.source,
        })
        .from(schema.sessionFiles)
        .where(eq(schema.sessionFiles.turnId, turnId))
        .all()
        .map((r) => `${r.source} ${r.op} ${r.absPath}`),
    );

    const rows: (typeof schema.sessionFiles.$inferInsert)[] = [];
    for (const file of files) {
      if (!file.absPath) continue;
      const key = `${file.source} ${file.op} ${file.absPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { projectPathId, relPath } = resolveProjectPath(turn.projectId, file.absPath);
      rows.push({
        id: newId(),
        turnId,
        projectId: turn.projectId,
        projectPathId,
        absPath: file.absPath,
        relPath,
        op: file.op,
        source: file.source,
        toolName: file.toolName ?? null,
      });
    }
    if (rows.length === 0) return 0;
    db.insert(schema.sessionFiles).values(rows).run();
    return rows.length;
  } catch {
    return 0;
  }
}

export function bumpToolCalls(turnId: string | null, by = 1): void {
  if (!turnId) return;
  try {
    db.update(schema.sessionTurns)
      .set({ toolCallCount: sql`${schema.sessionTurns.toolCallCount} + ${by}` })
      .where(eq(schema.sessionTurns.id, turnId))
      .run();
  } catch {
    /* best effort */
  }
}

/**
 * Turns left `running` by a crash or a restart are marked interrupted — never
 * resumed blind, never left hanging. Same contract as `reconcileRunsOnBoot`.
 * Returns how many were closed, for the boot log.
 */
export function markInterrupted(turnIds?: readonly string[]): number {
  try {
    const where = turnIds
      ? and(
          eq(schema.sessionTurns.status, "running"),
          inArray(schema.sessionTurns.id, [...turnIds]),
        )
      : eq(schema.sessionTurns.status, "running");
    const open = db
      .select({ id: schema.sessionTurns.id })
      .from(schema.sessionTurns)
      .where(where)
      .all();
    if (open.length === 0) return 0;
    db.update(schema.sessionTurns)
      .set({ status: "interrupted", endedAt: nowIso() })
      .where(where)
      .run();
    return open.length;
  } catch {
    return 0;
  }
}

/**
 * Drop every turn of one conversation, files included (they cascade).
 *
 * What a full reindex is: the transcript is the source of truth, so replacing what
 * was derived from it is correct — and necessary, because turn numbers are
 * assigned in sequence and a second pass would otherwise append a duplicate set
 * rather than overwrite the first.
 */
export function deleteTurnsOf(claudeSessionId: string): number {
  try {
    const rows = db
      .select({ id: schema.sessionTurns.id })
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.claudeSessionId, claudeSessionId))
      .all();
    if (rows.length === 0) return 0;
    db.delete(schema.sessionTurns)
      .where(eq(schema.sessionTurns.claudeSessionId, claudeSessionId))
      .run();
    return rows.length;
  } catch {
    return 0;
  }
}

// -- read ---------------------------------------------------------------------

export function turnsOf(
  key: { chatSessionId: string } | { claudeSessionId: string },
  limit = 200,
): Turn[] {
  try {
    const where =
      "chatSessionId" in key
        ? eq(schema.sessionTurns.chatSessionId, key.chatSessionId)
        : eq(schema.sessionTurns.claudeSessionId, key.claudeSessionId);
    return db
      .select()
      .from(schema.sessionTurns)
      .where(where)
      .orderBy(asc(schema.sessionTurns.seq))
      .limit(limit)
      .all();
  } catch {
    return [];
  }
}

/**
 * The newest turn of a session — what a commit made from that session belongs to.
 *
 * The turn that asked for the work is normally the one that just finished, which
 * is why this looks at the latest rather than at whatever is still open.
 */
export function lastTurnOfSession(chatSessionId: string): string | null {
  try {
    const row = db
      .select({ id: schema.sessionTurns.id })
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.chatSessionId, chatSessionId))
      .orderBy(desc(schema.sessionTurns.seq))
      .limit(1)
      .get();
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export function filesOf(turnId: string): TurnFile[] {
  try {
    return db
      .select()
      .from(schema.sessionFiles)
      .where(eq(schema.sessionFiles.turnId, turnId))
      .orderBy(asc(schema.sessionFiles.absPath))
      .all();
  } catch {
    return [];
  }
}

/**
 * Every turn that wrote this file, newest first.
 *
 * Matched on (repo, path-within-repo) when the file belongs to one of the
 * project's repos, and only on the absolute path otherwise. The reason is the
 * caller: the Diff tab asks with the path spelled the way `project_paths` spells
 * it, while the record was written the way the tool call spelled it, and on macOS
 * those can differ in case for the same directory. The part inside the repo is
 * the half both sides agree on.
 */
export function turnsTouching(projectId: string, absPath: string, limit = 20): Turn[] {
  try {
    const { projectPathId, relPath } = resolveProjectPath(projectId, absPath);
    const location =
      projectPathId && relPath
        ? and(
            eq(schema.sessionFiles.projectPathId, projectPathId),
            eq(schema.sessionFiles.relPath, relPath),
          )
        : eq(schema.sessionFiles.absPath, absPath);
    return db
      .select({ turn: schema.sessionTurns })
      .from(schema.sessionFiles)
      .innerJoin(schema.sessionTurns, eq(schema.sessionFiles.turnId, schema.sessionTurns.id))
      .where(
        and(
          eq(schema.sessionFiles.projectId, projectId),
          location,
          inArray(schema.sessionFiles.op, ["write", "delete"]),
        ),
      )
      .orderBy(desc(schema.sessionTurns.startedAt))
      .limit(limit)
      .all()
      .map((r) => r.turn);
  } catch {
    return [];
  }
}

/**
 * Candidate turns for a commit made in one of `cwds` at `at`: turns in that tree
 * (or a worktree of it) that were running or finished within the window before it.
 *
 * A turn that started before the commit and has not ended yet counts — it may well
 * have written the files. A turn that started *after* never does: it cannot have
 * produced a commit that already exists. The window comes from settings, 24h by
 * default, and the caller is expected to rank what comes back rather than trust
 * the list to hold one answer.
 */
export function turnsRunningAt(cwds: readonly string[], at: string, windowHours?: number): Turn[] {
  if (cwds.length === 0) return [];
  const hours = windowHours ?? setting("ledger.windowHours");
  const from = new Date(new Date(at).getTime() - hours * 3600_000).toISOString();
  const resolved = cwds.map(realish);
  try {
    return (
      db
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            lte(schema.sessionTurns.startedAt, at),
            or(
              isNull(schema.sessionTurns.endedAt),
              and(gte(schema.sessionTurns.endedAt, from), lte(schema.sessionTurns.endedAt, at)),
            ),
          ),
        )
        .orderBy(desc(schema.sessionTurns.startedAt))
        .all()
        // The tree match happens here, not in SQL, because "the same directory"
        // is more than string equality: SQLite compares text case-sensitively,
        // and the same repo can be spelled differently (case on macOS) or reached
        // through a symlink (`/var` vs `/private/var`). A turn recorded under any
        // of those spellings is still a candidate. The time window keeps the list
        // short enough for a realpath per row.
        .filter((turn) => pathUnderAny(turn.cwd, cwds) || pathUnderAny(realish(turn.cwd), resolved))
    );
  } catch {
    return [];
  }
}

// -- capture health -----------------------------------------------------------

export type CaptureStatus = "ok" | "degraded" | "stopped";

export interface CaptureState {
  claudeSessionId: string;
  projectId?: string | null;
  terminalId?: string | null;
  transcriptPath?: string | null;
  byteOffset?: number;
  mtimeMs?: number;
  sizeBytes?: number;
  lastEventAt?: string | null;
  status?: CaptureStatus;
  detail?: string | null;
}

/**
 * Upsert follower bookkeeping. The offset is what survives a restart — and what
 * lets a tmux session the user carried on with in Terminal.app be picked up
 * mid-conversation instead of reparsed from byte zero.
 */
export function saveCapture(state: CaptureState): void {
  try {
    const row = {
      claudeSessionId: state.claudeSessionId,
      projectId: state.projectId ?? null,
      terminalId: state.terminalId ?? null,
      transcriptPath: state.transcriptPath ?? null,
      byteOffset: state.byteOffset ?? 0,
      // Rounded on the way in: `statSync` reports sub-millisecond precision as a
      // float, SQLite keeps the float in an INTEGER column, and the "nothing was
      // appended, skip this file" check then never matches its own stored value.
      mtimeMs: Math.round(state.mtimeMs ?? 0),
      sizeBytes: state.sizeBytes ?? 0,
      lastEventAt: state.lastEventAt ?? null,
      updatedAt: nowIso(),
      status: state.status ?? "ok",
      detail: state.detail ?? null,
    };
    db.insert(schema.sessionCapture)
      .values(row)
      .onConflictDoUpdate({ target: schema.sessionCapture.claudeSessionId, set: row })
      .run();
  } catch {
    /* best effort */
  }
}

export function getCapture(claudeSessionId: string) {
  try {
    return (
      db
        .select()
        .from(schema.sessionCapture)
        .where(eq(schema.sessionCapture.claudeSessionId, claudeSessionId))
        .get() ?? null
    );
  } catch {
    return null;
  }
}

/** One group per unhealthy status, for Settings -> Doctor. */
export function captureHealth(): { status: CaptureStatus; count: number; details: string[] }[] {
  try {
    const rows = db.select().from(schema.sessionCapture).all();
    const groups = new Map<CaptureStatus, string[]>();
    for (const row of rows) {
      const status = (row.status as CaptureStatus) ?? "ok";
      if (status === "ok") continue;
      const list = groups.get(status) ?? [];
      if (row.detail) list.push(row.detail);
      groups.set(status, list);
    }
    return [...groups].map(([status, details]) => ({
      status,
      count: details.length,
      details: [...new Set(details)].slice(0, 5),
    }));
  } catch {
    return [];
  }
}
