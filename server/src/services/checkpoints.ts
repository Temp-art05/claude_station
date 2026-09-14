/**
 * Linking a commit back to the turn that produced it.
 *
 * Three things make this work, and each is a decision worth keeping:
 *
 * 1. **Observed, not intercepted.** No git hook is installed in the user's repo.
 *    Refs are watched instead, so a commit made from a real terminal, from Xcode,
 *    or while this server was not running still gets a row — which is most of them.
 *    The price is that attribution outside the app is inference, hence (2).
 *
 * 2. **Confidence is part of the record.** `exact` when the app itself made the
 *    commit or exactly one session was working in that tree; `inferred` when the
 *    files line up but something else could explain it; `orphan` when they don't.
 *    An attribution that cannot be made says so. A badge that is wrong is worse
 *    than no badge, because it will be believed.
 *
 * 3. **`patch-id`, not sha, is the identity.** `--amend` and rebase both mint a
 *    new sha and keep the patch-id, so a checkpoint re-points instead of breaking.
 *    A cherry-pick keeps the patch-id too — what tells the two apart is whether
 *    the old sha is still *reachable*, which is why `shaReachable` checks refs
 *    rather than object existence.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { newId, nowIso } from "../lib/id";
import { pathEq, pathUnder, realish, relativeUnder } from "../lib/path-compare";
import {
  commitFiles,
  commitsSince,
  isGitRepo,
  listWorktrees,
  mainRepoOf,
  patchId,
  reachableSet,
  shaReachable,
} from "./git";
import { watchGitDir, watchedGitDirs } from "./git-watch";
import { filesOf, ledgerEnabled, turnsRunningAt, type Turn } from "./session-ledger";

export type Confidence = "exact" | "inferred" | "orphan";
export type Checkpoint = typeof schema.checkpoints.$inferSelect;

/**
 * Thresholds for attribution. Deliberately not settings: tuning them is a job for
 * whoever is reading the numbers, not for a user staring at a form, and a wrong
 * value here produces confident nonsense rather than a visible error.
 */
const ASSIGN_MIN = 0.5;
/** How far ahead the best candidate must be before it wins outright. */
const LEAD_MIN = 0.2;
const EXACT_MIN = 0.9;
/** A tool-only file list is known to be incomplete, so it never scores full. */
const TOOL_ONLY_PENALTY = 0.7;
/** A session working in its own worktree is a strong signal on its own. */
const WORKTREE_BONUS = 0.15;
/** How many commits to read the first time a repo is seen. */
const INITIAL_DEPTH = 200;

// -- ingest -------------------------------------------------------------------

function cursorOf(repoPath: string) {
  return (
    db.select().from(schema.repoCursors).where(eq(schema.repoCursors.repoPath, repoPath)).get() ??
    null
  );
}

function saveCursor(repoPath: string, lastSeenSha: string | null, detail?: string): void {
  const row = {
    repoPath,
    lastSeenSha,
    lastScanAt: nowIso(),
    status: detail ? ("degraded" as const) : ("ok" as const),
    detail: detail ?? null,
  };
  db.insert(schema.repoCursors)
    .values(row)
    .onConflictDoUpdate({ target: schema.repoCursors.repoPath, set: row })
    .run();
}

/**
 * Which project (and which of its paths) owns this repo.
 *
 * Both sides are symlink-resolved: a project path may be configured through a
 * symlink while git always reports the real one.
 */
function ownerOf(repoPath: string): { projectId: string; projectPathId: string | null } | null {
  const rows = db.select().from(schema.projectPaths).all();
  let best: (typeof rows)[number] | null = null;
  for (const row of rows) {
    // Either the path IS the repo, or it is a directory inside it (a monorepo
    // package). Longest match wins, same rule the ledger uses for files.
    if (!pathUnder(realish(row.path), repoPath)) continue;
    if (!best || row.path.length > best.path.length) best = row;
  }
  if (!best) return null;
  return { projectId: best.projectId, projectPathId: best.id };
}

/**
 * The identity a checkpoint is stored under. Every entry point goes through this,
 * so a repo reached through a worktree or a symlink is still one repo.
 */
export function canonicalRepo(cwd: string): string | null {
  if (!isGitRepo(cwd)) return null;
  return mainRepoOf(cwd) ?? realish(cwd);
}

/**
 * Read every commit this repo gained since the last pass, and attribute each one.
 *
 * Safe to call repeatedly and from several triggers at once — the unique index on
 * (repo, sha) is what makes a double ingest a no-op rather than a duplicate.
 */
export function ingest(input: string): { added: number; repointed: number } {
  const result = { added: 0, repointed: 0 };
  const repoPath = canonicalRepo(input);
  if (!repoPath) return result;

  const owner = ownerOf(repoPath);
  if (!owner) {
    saveCursor(repoPath, cursorOf(repoPath)?.lastSeenSha ?? null, "no project path owns this repo");
    return result;
  }

  const cursor = cursorOf(repoPath);
  const commits = commitsSince(repoPath, cursor?.lastSeenSha ?? null, INITIAL_DEPTH);
  if (commits.length === 0) {
    saveCursor(repoPath, cursor?.lastSeenSha ?? null);
    return result;
  }

  // Once for the whole batch rather than once per commit.
  const worktrees = worktreesOf(repoPath);
  // Rewrite detection only has something to preserve when this repo already holds
  // attributions. On a first read of 200 historic commits there is nothing to
  // re-point, and patch-id costs ~9ms each.
  const mayHaveRewrites =
    db
      .select({ id: schema.checkpoints.id })
      .from(schema.checkpoints)
      .where(eq(schema.checkpoints.repoPath, repoPath))
      .limit(1)
      .all().length > 0;

  for (const commit of commits) {
    const existing = db
      .select()
      .from(schema.checkpoints)
      .where(
        and(
          eq(schema.checkpoints.repoPath, repoPath),
          eq(schema.checkpoints.commitSha, commit.sha),
        ),
      )
      .get();
    if (existing) continue;

    // A merge has no single patch, so no patch-id and nothing to attribute.
    const isMerge = commit.parents.length > 1;
    const patch = isMerge || !mayHaveRewrites ? null : patchId(repoPath, commit.sha);

    const rewritten = patch ? findRewritten(repoPath, patch) : null;
    if (rewritten) {
      db.update(schema.checkpoints)
        .set({
          commitSha: commit.sha,
          supersededSha: rewritten.commitSha,
          committedAt: commit.committedAt,
          subject: commit.subject,
          author: commit.author,
          detectedAt: nowIso(),
        })
        .where(eq(schema.checkpoints.id, rewritten.id))
        .run();
      result.repointed += 1;
      continue;
    }

    const id = newId();
    db.insert(schema.checkpoints)
      .values({
        id,
        projectId: owner.projectId,
        projectPathId: owner.projectPathId,
        repoPath,
        commitSha: commit.sha,
        patchId: patch,
        committedAt: commit.committedAt,
        subject: commit.subject,
        author: commit.author,
        confidence: "orphan",
        reason: isMerge ? "merge commit — no single patch to attribute" : "not attributed yet",
        detectedAt: nowIso(),
      })
      .run();
    result.added += 1;
    if (isMerge) continue;

    const confidence = attribute(id, worktrees);
    // A commit with a session behind it is worth being able to follow through a
    // rebase, so it gets its patch-id even when the batch skipped them.
    if (confidence !== "orphan" && !patch) {
      const late = patchId(repoPath, commit.sha);
      if (late) {
        db.update(schema.checkpoints)
          .set({ patchId: late })
          .where(eq(schema.checkpoints.id, id))
          .run();
      }
    }
  }

  saveCursor(repoPath, commits[commits.length - 1]!.sha);
  return result;
}

/**
 * A checkpoint whose commit was rewritten into this one.
 *
 * Same patch-id AND the old sha no longer reachable. Both halves matter: after a
 * rebase the old commit is unreachable, so re-pointing is right; after a
 * cherry-pick the original is still on its branch, so the pick is a new commit
 * that merely shares a patch-id and must get its own row.
 */
function findRewritten(repoPath: string, patch: string): Checkpoint | null {
  const candidates = db
    .select()
    .from(schema.checkpoints)
    .where(and(eq(schema.checkpoints.repoPath, repoPath), eq(schema.checkpoints.patchId, patch)))
    .all();
  for (const candidate of candidates) {
    if (!shaReachable(repoPath, candidate.commitSha)) return candidate;
  }
  return null;
}

// -- attribution --------------------------------------------------------------

interface Scored {
  turn: Turn;
  score: number;
  overlap: number;
  treeBacked: boolean;
  worktree: boolean;
}

/**
 * Worktrees of a repo, as plain paths. `git worktree list` costs ~7ms, which is
 * nothing once per ingest and 15 seconds once per commit.
 */
function worktreesOf(repoPath: string): string[] {
  return listWorktrees(repoPath).map((w) => w.path);
}

/** Files a turn wrote, as paths relative to the repo the commit is in. */
function turnWrites(turn: Turn, repoPath: string): { paths: Set<string>; treeBacked: boolean } {
  const paths = new Set<string>();
  let treeBacked = false;
  for (const file of filesOf(turn.id)) {
    if (file.op === "read") continue;
    // A turn's cwd is either the repo or a worktree of it; either way the path
    // inside it lines up with what the commit reports.
    const base = pathUnder(file.absPath, turn.cwd) ? turn.cwd : repoPath;
    const rel = relativeUnder(file.absPath, base);
    if (!rel) continue;
    paths.add(rel);
    if (file.source === "tree") treeBacked = true;
  }
  return { paths, treeBacked };
}

/**
 * Score every session that could have produced this commit, and record the verdict.
 *
 * Returns the confidence it settled on, so a caller can log it.
 */
export function attribute(checkpointId: string, worktrees?: readonly string[]): Confidence {
  const checkpoint = db
    .select()
    .from(schema.checkpoints)
    .where(eq(schema.checkpoints.id, checkpointId))
    .get();
  if (!checkpoint) return "orphan";

  // Already known for certain — the app made this commit itself.
  if (checkpoint.confidence === "exact" && checkpoint.turnId) return "exact";

  if (!ledgerEnabled()) {
    return settle(checkpoint.id, "orphan", null, null, "session ledger is switched off");
  }

  // Candidates first, because that answer comes from the database alone. Most
  // commits in a repo's history predate the ledger entirely, and asking git what
  // they changed before knowing whether anyone could have made them is what turned
  // the initial backfill into a minute of blocked startup.
  const trees = [checkpoint.repoPath, ...(worktrees ?? worktreesOf(checkpoint.repoPath))];
  const window = setting("ledger.windowHours");
  const candidates = turnsRunningAt(trees, checkpoint.committedAt, window);
  if (candidates.length === 0) {
    return settle(
      checkpoint.id,
      "orphan",
      null,
      null,
      `no session was working in this repo in the ${window}h before the commit`,
    );
  }

  const changed = commitFiles(checkpoint.repoPath, checkpoint.commitSha).map((f) => f.path);
  if (changed.length === 0) {
    return settle(checkpoint.id, "orphan", null, null, "commit changes no files");
  }
  const changedSet = new Set(changed);

  const scored: Scored[] = [];
  for (const turn of candidates) {
    const { paths, treeBacked } = turnWrites(turn, checkpoint.repoPath);
    if (paths.size === 0) continue;
    let hits = 0;
    for (const path of changedSet) if (paths.has(path)) hits += 1;
    const overlap = hits / changedSet.size;
    if (overlap === 0) continue;

    // A turn that ran in its own worktree rather than the shared checkout: this
    // app creates those per session, so nothing else could have written there.
    // Resolved on both sides — the same directory reached two ways is not two.
    const worktree = !pathEq(realish(turn.cwd), checkpoint.repoPath);
    const score = Math.min(
      1,
      overlap * (treeBacked ? 1 : TOOL_ONLY_PENALTY) + (worktree ? WORKTREE_BONUS : 0),
    );
    scored.push({ turn, score, overlap, treeBacked, worktree });
  }

  if (scored.length === 0) {
    return settle(
      checkpoint.id,
      "orphan",
      null,
      null,
      `${candidates.length} session(s) were active but none of them touched these files`,
    );
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const runnerUp = scored[1];

  if (best.score < ASSIGN_MIN) {
    return settle(
      checkpoint.id,
      "orphan",
      best.turn,
      best.score,
      `best match covers only ${pct(best.overlap)} of the commit's files`,
    );
  }
  if (runnerUp && best.score - runnerUp.score < LEAD_MIN) {
    return settle(
      checkpoint.id,
      "orphan",
      null,
      best.score,
      `two sessions match about equally (${pct(best.overlap)} vs ${pct(runnerUp.overlap)}) — not guessing`,
    );
  }

  // Several turns of the same session often each match; the commit belongs to the
  // session, and the best-scoring turn is the one worth pointing at.
  const sameSession = scored.filter((s) => isSameSession(s.turn, best.turn));
  const exact = best.score >= EXACT_MIN && best.treeBacked && !runnerUp;
  const reason = exact
    ? `only session working here; ${pct(best.overlap)} of the commit's files match what it wrote`
    : `${pct(best.overlap)} of the commit's files match${
        best.treeBacked ? "" : " (from tool calls only, which miss shell edits)"
      }${sameSession.length > 1 ? `; ${sameSession.length} turns of this session matched` : ""}`;

  return settle(checkpoint.id, exact ? "exact" : "inferred", best.turn, best.score, reason);
}

function isSameSession(a: Turn, b: Turn): boolean {
  if (a.chatSessionId && b.chatSessionId) return a.chatSessionId === b.chatSessionId;
  if (a.claudeSessionId && b.claudeSessionId) return a.claudeSessionId === b.claudeSessionId;
  return false;
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;

function settle(
  checkpointId: string,
  confidence: Confidence,
  turn: Turn | null,
  score: number | null,
  reason: string,
): Confidence {
  db.update(schema.checkpoints)
    .set({
      confidence,
      // An orphan keeps no session: a half-attribution is what a badge would
      // then show, and it would be read as an answer.
      turnId: confidence === "orphan" ? null : (turn?.id ?? null),
      chatSessionId: confidence === "orphan" ? null : (turn?.chatSessionId ?? null),
      claudeSessionId: confidence === "orphan" ? null : (turn?.claudeSessionId ?? null),
      score,
      reason,
    })
    .where(eq(schema.checkpoints.id, checkpointId))
    .run();
  return confidence;
}

/**
 * The app committed this itself, from a session — the one case with no guesswork.
 *
 * Called by the commit route rather than waiting for the watcher, so the strongest
 * evidence there is never degrades into inference.
 */
export function recordAppCommit(input: {
  repoPath: string;
  commitSha: string;
  projectId: string;
  turnId?: string | null;
  chatSessionId?: string | null;
  claudeSessionId?: string | null;
}): void {
  try {
    const repo = canonicalRepo(input.repoPath) ?? realish(input.repoPath);
    const owner = ownerOf(repo);
    const meta = commitsSince(repo, null, 1)[0];
    const row = {
      id: newId(),
      projectId: input.projectId,
      projectPathId: owner?.projectPathId ?? null,
      repoPath: repo,
      commitSha: input.commitSha,
      patchId: patchId(repo, input.commitSha),
      committedAt: meta?.committedAt ?? nowIso(),
      subject: meta?.subject ?? "",
      author: meta?.author ?? "",
      turnId: input.turnId ?? null,
      chatSessionId: input.chatSessionId ?? null,
      claudeSessionId: input.claudeSessionId ?? null,
      confidence: (input.turnId ? "exact" : "orphan") as Confidence,
      score: input.turnId ? 1 : null,
      reason: input.turnId
        ? "committed by this app, from that session"
        : "committed by this app, outside any session",
      detectedAt: nowIso(),
    };
    db.insert(schema.checkpoints)
      .values(row)
      .onConflictDoUpdate({
        target: [schema.checkpoints.repoPath, schema.checkpoints.commitSha],
        set: {
          turnId: row.turnId,
          chatSessionId: row.chatSessionId,
          claudeSessionId: row.claudeSessionId,
          confidence: row.confidence,
          score: row.score,
          reason: row.reason,
        },
      })
      .run();
    saveCursor(repo, input.commitSha);
  } catch {
    // The watcher will pick the commit up and infer it; never fail a commit for
    // the sake of its bookkeeping.
  }
}

// -- reconcile ----------------------------------------------------------------

/**
 * Checkpoints whose commit no longer exists anywhere.
 *
 * A squash changes the patch-id, so there is nothing to re-point to: the row is
 * kept and marked orphan rather than deleted, because it is still the evidence
 * that the work happened.
 */
export function reconcileGoneCommits(input: string): number {
  const repoPath = canonicalRepo(input) ?? realish(input);
  const rows = db
    .select()
    .from(schema.checkpoints)
    .where(eq(schema.checkpoints.repoPath, repoPath))
    .all();
  if (rows.length === 0) return 0;

  // One `git rev-list --all` for the repo, then set membership. Asking git per
  // row costs ~21ms each, which on a few thousand checkpoints is a minute of
  // boot — and it would be paid again on every restart.
  const reachable = reachableSet(repoPath);
  if (!reachable) return 0; // cannot tell: leave every row as it is

  let orphaned = 0;
  for (const row of rows) {
    if (row.confidence === "orphan" && row.reason.startsWith("commit is gone")) continue;
    if (reachable.has(row.commitSha)) continue;
    db.update(schema.checkpoints)
      .set({
        confidence: "orphan",
        score: null,
        reason: "commit is gone — squashed, reset, or on a deleted branch",
      })
      .where(eq(schema.checkpoints.id, row.id))
      .run();
    orphaned += 1;
  }
  return orphaned;
}

// -- read ---------------------------------------------------------------------

export interface CheckpointView {
  id: string;
  commitSha: string;
  confidence: Confidence;
  score: number | null;
  reason: string;
  turnId: string | null;
  sessionKind: "sdk" | "cli" | null;
  promptPreview: string | null;
  supersededSha: string | null;
}

function toView(row: Checkpoint, turn: Turn | null): CheckpointView {
  return {
    id: row.id,
    commitSha: row.commitSha,
    confidence: row.confidence as Confidence,
    score: row.score,
    reason: row.reason,
    turnId: row.turnId,
    sessionKind: turn ? (turn.sourceKind as "sdk" | "cli") : null,
    promptPreview: turn?.promptPreview ?? null,
    supersededSha: row.supersededSha,
  };
}

/** Checkpoints for a set of commits, keyed by sha — what enriches a commit list. */
export function checkpointsForShas(
  input: string,
  shas: readonly string[],
): Record<string, CheckpointView> {
  if (shas.length === 0) return {};
  const repoPath = canonicalRepo(input) ?? realish(input);
  const rows = db
    .select()
    .from(schema.checkpoints)
    .where(
      and(
        eq(schema.checkpoints.repoPath, repoPath),
        inArray(schema.checkpoints.commitSha, [...shas]),
      ),
    )
    .all();
  const turnIds = rows.map((r) => r.turnId).filter((id): id is string => !!id);
  const turns = turnIds.length
    ? db.select().from(schema.sessionTurns).where(inArray(schema.sessionTurns.id, turnIds)).all()
    : [];
  const byId = new Map(turns.map((t) => [t.id, t]));

  const out: Record<string, CheckpointView> = {};
  for (const row of rows) {
    out[row.commitSha] = toView(row, row.turnId ? (byId.get(row.turnId) ?? null) : null);
  }
  return out;
}

/** One checkpoint in full, with the turn behind it. */
export function checkpointDetail(checkpointId: string) {
  const row = db
    .select()
    .from(schema.checkpoints)
    .where(eq(schema.checkpoints.id, checkpointId))
    .get();
  if (!row) return null;
  const turn = row.turnId
    ? (db.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.id, row.turnId)).get() ??
      null)
    : null;
  return {
    ...toView(row, turn),
    projectId: row.projectId,
    projectPathId: row.projectPathId,
    repoPath: row.repoPath,
    subject: row.subject,
    author: row.author,
    committedAt: row.committedAt,
    patchId: row.patchId,
    turn: turn
      ? {
          id: turn.id,
          promptText: turn.promptText,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          model: turn.model,
          outputTokens: turn.outputTokens,
          costUsd: turn.costUsd,
          toolCallCount: turn.toolCallCount,
          chatSessionId: turn.chatSessionId,
          claudeSessionId: turn.claudeSessionId,
          cwd: turn.cwd,
          files: filesOf(turn.id).map((f) => ({
            relPath: f.relPath || f.absPath,
            op: f.op,
            source: f.source,
            toolName: f.toolName,
          })),
        }
      : null,
    /** What the commit itself changed — next to the turn's files, the gap is the point. */
    commitFiles: commitFiles(row.repoPath, row.commitSha),
  };
}

/** Every commit attributed to one session. */
export function checkpointsOfSession(key: {
  chatSessionId?: string;
  claudeSessionId?: string;
}): Checkpoint[] {
  const where = key.chatSessionId
    ? eq(schema.checkpoints.chatSessionId, key.chatSessionId)
    : key.claudeSessionId
      ? eq(schema.checkpoints.claudeSessionId, key.claudeSessionId)
      : null;
  if (!where) return [];
  return db
    .select()
    .from(schema.checkpoints)
    .where(where)
    .orderBy(desc(schema.checkpoints.committedAt))
    .all();
}

/** Commits nothing could be attributed to — the honest measure of the blind spots. */
export function orphanCount(projectId: string): number {
  return db
    .select()
    .from(schema.checkpoints)
    .where(and(eq(schema.checkpoints.projectId, projectId), isNull(schema.checkpoints.turnId)))
    .all().length;
}

export function cursorHealth(): { repoPath: string; status: string; detail: string | null }[] {
  return db
    .select()
    .from(schema.repoCursors)
    .all()
    .filter((row) => row.status !== "ok")
    .map((row) => ({ repoPath: row.repoPath, status: row.status, detail: row.detail }));
}

// -- bootstrap ----------------------------------------------------------------

/** Every repo the configured project paths resolve to. */
function projectRepos(): string[] {
  const paths = db.select({ path: schema.projectPaths.path }).from(schema.projectPaths).all();
  const repos = new Set<string>();
  for (const row of paths) {
    const repo = canonicalRepo(row.path);
    if (repo) repos.add(repo);
  }
  return [...repos];
}

/**
 * Put a watcher on every repo. Cheap — two git calls per path — and safe to call
 * again whenever the project paths change.
 *
 * Deliberately does NOT read commits: reading them is `catchUpRepos`, which the
 * server starts only once it is already listening. Doing both here is how the
 * first version blocked startup for a minute and a half, which looks exactly like
 * lost data from the browser.
 */
export function watchProjectRepos(): { watched: number; degraded: string[] } {
  const out = { watched: 0, degraded: [] as string[] };
  for (const repo of projectRepos()) {
    if (watchGitDir(repo, () => ingest(repo))) out.watched += 1;
    else {
      // No watcher: commits are still picked up by the next scan. Say so rather
      // than looking healthy while going blind.
      out.degraded.push(repo);
      saveCursor(repo, cursorOf(repo)?.lastSeenSha ?? null, "no filesystem watcher on .git");
    }
  }
  return out;
}

/**
 * Read the commits every repo gained while nothing was watching, and re-point
 * anything a rewrite moved.
 *
 * Async and yielding between repos on purpose: this is the expensive half, and it
 * must never hold the event loop while the UI is waiting for its first request.
 */
export async function catchUpRepos(): Promise<{ added: number; orphaned: number }> {
  const out = { added: 0, orphaned: 0 };
  for (const repo of projectRepos()) {
    // Let the server answer requests between repos.
    await new Promise((resolve) => setImmediate(resolve));
    try {
      out.added += ingest(repo).added;
      out.orphaned += reconcileGoneCommits(repo);
    } catch {
      // One unreadable repo must not stop the rest.
      saveCursor(repo, cursorOf(repo)?.lastSeenSha ?? null, "catch-up failed");
    }
  }
  return out;
}

/** Repos currently watched — for the Doctor panel. */
export function watchedRepos(): string[] {
  return watchedGitDirs();
}
