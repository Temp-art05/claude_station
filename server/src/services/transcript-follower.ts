/**
 * Following the `claude` CLI's transcripts, so a terminal tab records turns the
 * same way an Agent SDK session does.
 *
 * The CLI owns its transcript and we only read it. That is the whole reason this
 * works at all in the cases that matter: a tab detached in tmux, carried on inside
 * Terminal.app while the server was down, still appends to the same file, so the
 * next drain picks the conversation up mid-thought from the stored byte offset
 * rather than losing it or reparsing 29MB.
 *
 * Two mechanisms on purpose. `fs.watch` gives immediacy; a slow sweep gives
 * correctness when the watcher never came up (OS limits, odd filesystem), when the
 * transcript did not exist yet at the moment the tab opened, or when a write
 * happened while this process was not running. A drain with nothing appended costs
 * one `statSync`, so the sweep is close to free.
 */
import { watch, type FSWatcher } from "node:fs";
import { transcriptPath } from "../lib/claude-transcript";
import { filesFromToolUse, toolLabel } from "../lib/tool-files";
import {
  addUsage,
  emptyUsage,
  parseRecords,
  readAppended,
  type TranscriptEvent,
  type TranscriptUsage,
} from "../lib/transcript-parse";
import * as ledger from "./session-ledger";
import { snapshotTree, touchesBetween, type TreeSnapshot } from "./tree-snapshot";

interface Follower {
  claudeSessionId: string;
  projectId: string;
  terminalId: string | null;
  /** Where the turn ran, used when a record carries no `cwd` of its own. */
  cwd: string;
  file: string | null;
  /**
   * Bytes consumed, ending at a record boundary. A half-written trailing line is
   * deliberately left BEHIND the offset rather than buffered in memory, so the
   * next read gets it back from disk complete. Buffering it as well would feed it
   * to the parser twice.
   */
  offset: number;
  /** The turn currently being filled, and its running totals. */
  turnId: string | null;
  usage: TranscriptUsage;
  toolCalls: number;
  lastAt: string | null;
  watcher: FSWatcher | null;
  debounce: NodeJS.Timeout | null;
  badLines: number;
  /**
   * The tree as of the last drain that saw activity. A terminal turn has no
   * boundary we control, so the comparison runs drain to drain instead — which is
   * also the only way an edit made through `Bash` gets recorded at all.
   */
  tree: TreeSnapshot | null;
}

const followers = new Map<string, Follower>();
let sweepTimer: NodeJS.Timeout | null = null;

const SWEEP_MS = 3_000;
const DEBOUNCE_MS = 250;

// -- lifecycle ----------------------------------------------------------------

export interface FollowInput {
  claudeSessionId: string;
  projectId: string;
  cwd: string;
  terminalId?: string | null;
  /**
   * The transcript to read. Normally left out and found by id; the backfill
   * already has the path from its directory scan, and passing it skips a rescan.
   */
  transcriptFile?: string | null;
}

/**
 * Start following a conversation. Safe to call again for one already followed —
 * a terminal can be reattached, and the second call must not restart the offset.
 */
export function follow(input: FollowInput): void {
  if (!ledger.ledgerEnabled()) return;
  const existing = followers.get(input.claudeSessionId);
  if (existing) {
    // Reattach: the tab may be new even though the conversation is not.
    existing.terminalId = input.terminalId ?? existing.terminalId;
    drainFollower(existing);
    return;
  }

  const follower = newFollower(input);
  followers.set(input.claudeSessionId, follower);
  drainFollower(follower);
  startSweep();
}

function newFollower(input: FollowInput, offset?: number): Follower {
  const saved = ledger.getCapture(input.claudeSessionId);
  return {
    claudeSessionId: input.claudeSessionId,
    projectId: input.projectId,
    terminalId: input.terminalId ?? null,
    cwd: input.cwd,
    file: input.transcriptFile ?? saved?.transcriptPath ?? null,
    offset: offset ?? saved?.byteOffset ?? 0,
    turnId: null,
    usage: emptyUsage(),
    toolCalls: 0,
    lastAt: null,
    watcher: null,
    debounce: null,
    badLines: 0,
    tree: null,
  };
}

/**
 * Read a transcript once, from the beginning, without watching it.
 *
 * This is how history that predates capture gets in — including conversations run
 * outside the app entirely, which the History panel already lists.
 *
 * Whatever was previously derived from this transcript is dropped first, so a
 * second pass replaces rather than appends: turn numbers are handed out in
 * sequence, and without the delete a reindex would leave two sets of the same
 * conversation. That is what makes fixing the parser a reindex and not a
 * migration.
 */
export function indexTranscript(input: FollowInput & { transcriptFile: string }): number {
  if (!ledger.ledgerEnabled()) return 0;
  ledger.deleteTurnsOf(input.claudeSessionId);
  const follower = newFollower(input, 0);
  drainFollower(follower);
  closeOpenTurn(follower);
  return ledger.turnsOf({ claudeSessionId: input.claudeSessionId }).length;
}

/**
 * Read on from where capture last left off, once, without watching.
 *
 * For a conversation nobody has a tab open on but which grew anyway — continued in
 * a real terminal, most often. Cheaper than `indexTranscript` by the whole size of
 * the file: only the appended part is parsed.
 */
export function catchUpTranscript(input: FollowInput & { transcriptFile: string }): void {
  if (!ledger.ledgerEnabled()) return;
  const follower = newFollower(input);
  drainFollower(follower);
  closeOpenTurn(follower);
}

/**
 * Stop following. The open turn is closed with what is known — a conversation
 * that ends is not an interrupted one, so it keeps whatever end time its last
 * activity had.
 */
export function unfollow(claudeSessionId: string, detail?: string): void {
  const follower = followers.get(claudeSessionId);
  if (!follower) return;
  drain(claudeSessionId);
  closeOpenTurn(follower);
  detachWatcher(follower);
  followers.delete(claudeSessionId);
  if (detail) {
    ledger.saveCapture({
      claudeSessionId,
      projectId: follower.projectId,
      terminalId: follower.terminalId,
      transcriptPath: follower.file,
      byteOffset: follower.offset,
      status: "stopped",
      detail,
    });
  }
  if (followers.size === 0) stopSweep();
}

/** For shutdown: let every open turn be closed with what was captured. */
export function unfollowAll(): void {
  for (const id of [...followers.keys()]) unfollow(id);
}

export function isFollowing(claudeSessionId: string): boolean {
  return followers.has(claudeSessionId);
}

function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    for (const id of [...followers.keys()]) drain(id);
  }, SWEEP_MS);
  // Must not hold the process open on its own.
  sweepTimer.unref?.();
}

function stopSweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

function attachWatcher(follower: Follower): void {
  if (follower.watcher || !follower.file) return;
  try {
    follower.watcher = watch(follower.file, { persistent: false }, () => {
      if (follower.debounce) clearTimeout(follower.debounce);
      follower.debounce = setTimeout(() => {
        follower.debounce = null;
        drain(follower.claudeSessionId);
      }, DEBOUNCE_MS);
    });
    follower.watcher.on("error", () => detachWatcher(follower));
  } catch {
    // The sweep is the fallback, so a dead watcher is slower capture, not none.
    follower.watcher = null;
  }
}

function detachWatcher(follower: Follower): void {
  if (follower.debounce) clearTimeout(follower.debounce);
  follower.debounce = null;
  try {
    follower.watcher?.close();
  } catch {
    /* already gone */
  }
  follower.watcher = null;
}

// -- draining -----------------------------------------------------------------

/** Read and record whatever was appended since the last pass. */
export function drain(claudeSessionId: string): void {
  const follower = followers.get(claudeSessionId);
  if (follower) drainFollower(follower);
}

function drainFollower(follower: Follower): void {
  const claudeSessionId = follower.claudeSessionId;

  // The CLI creates the transcript on the conversation's first message, which can
  // be well after the tab opened.
  if (!follower.file) {
    follower.file = transcriptPath(claudeSessionId);
    if (!follower.file) return;
  }

  const read = readAppended(follower.file, follower.offset);
  if (!read) {
    // Deleted from the History panel, or pruned by the CLI. Keep what was already
    // recorded and say why capture ended.
    closeOpenTurn(follower);
    detachWatcher(follower);
    ledger.saveCapture({
      claudeSessionId,
      projectId: follower.projectId,
      terminalId: follower.terminalId,
      transcriptPath: follower.file,
      byteOffset: follower.offset,
      status: "stopped",
      detail: "transcript is gone (deleted or pruned)",
    });
    follower.file = null;
    return;
  }

  attachWatcher(follower);

  if (read.rewound) {
    // Shorter than our offset: a different conversation now owns this id, or the
    // CLI truncated. Reading on from the middle of it would invent turns.
    follower.offset = 0;
    follower.turnId = null;
  }

  if (!read.text) {
    saveState(follower, read.size, read.mtimeMs);
    return;
  }

  const parsed = parseRecords(read.text);
  follower.badLines += parsed.badLines;
  // Stop short of the incomplete tail; the next read starts there and sees it whole.
  follower.offset = read.size - Buffer.byteLength(parsed.leftover, "utf8");

  for (const event of parsed.events) apply(follower, event);

  // Only when the agent actually did something: a quiet sweep must stay as cheap
  // as one statSync, and a tree that moved with no activity behind it was the
  // person editing, not this turn.
  if (parsed.events.some((e) => e.kind === "activity")) recordTreeChanges(follower);

  // Refine the open turn on every pass rather than waiting for an end marker the
  // CLI does not write: a turn is always stored with its best-known totals, and
  // a later append just updates the same row.
  closeOpenTurn(follower, { keepOpen: true });
  saveState(follower, read.size, read.mtimeMs);
}

function saveState(follower: Follower, size: number, mtimeMs: number): void {
  ledger.saveCapture({
    claudeSessionId: follower.claudeSessionId,
    projectId: follower.projectId,
    terminalId: follower.terminalId,
    transcriptPath: follower.file,
    byteOffset: follower.offset,
    mtimeMs,
    sizeBytes: size,
    lastEventAt: follower.lastAt,
    status: follower.badLines > 0 ? "degraded" : "ok",
    detail: follower.badLines > 0 ? `${follower.badLines} unreadable record(s)` : null,
  });
}

function apply(follower: Follower, event: TranscriptEvent): void {
  if (event.kind === "prompt") {
    closeOpenTurn(follower);
    follower.usage = emptyUsage();
    follower.toolCalls = 0;
    follower.lastAt = event.at;
    follower.turnId = ledger.openTurn({
      projectId: follower.projectId,
      sourceKind: "cli",
      cwd: event.cwd ?? follower.cwd,
      claudeSessionId: follower.claudeSessionId,
      terminalId: follower.terminalId,
      gitBranch: event.gitBranch,
      prompt: event.text,
      startedAt: event.at ?? undefined,
    });
    return;
  }

  // Activity with no turn open: a restart resumed mid-conversation. Adopt the last
  // turn of this conversation rather than inventing a promptless one.
  if (!follower.turnId) {
    const turns = ledger.turnsOf({ claudeSessionId: follower.claudeSessionId });
    const last = turns[turns.length - 1];
    if (last) {
      follower.turnId = last.id;
      follower.usage = {
        inputTokens: last.inputTokens,
        outputTokens: last.outputTokens,
        cacheReadTokens: last.cacheReadTokens,
        cacheCreateTokens: last.cacheCreateTokens,
      };
      follower.toolCalls = last.toolCallCount;
    } else {
      // Following a conversation already in progress and no prompt has been seen
      // yet. Record the spend against a turn with no prompt rather than drop it.
      follower.turnId = ledger.openTurn({
        projectId: follower.projectId,
        sourceKind: "cli",
        cwd: event.cwd ?? follower.cwd,
        claudeSessionId: follower.claudeSessionId,
        terminalId: follower.terminalId,
        gitBranch: event.gitBranch,
        startedAt: event.at ?? undefined,
      });
    }
  }
  if (!follower.turnId) return;

  follower.usage = addUsage(follower.usage, event.usage);
  if (event.at) follower.lastAt = event.at;

  const cwd = event.cwd ?? follower.cwd;
  const touches: ledger.FileTouch[] = [];
  for (const call of event.tools) {
    follower.toolCalls += 1;
    const label = toolLabel(call.name, call.input);
    for (const touch of filesFromToolUse(call.name, call.input, cwd)) {
      // A subagent's edits are the parent turn's edits — the plan keeps one turn
      // per user prompt — but the label says who actually made them.
      touches.push({
        ...touch,
        source: "tool",
        toolName: call.sidechain ? `Task/${label}` : label,
      });
    }
  }
  if (touches.length > 0) ledger.recordFiles(follower.turnId, touches);
}

/**
 * Record what moved in the tree since the previous drain that saw activity.
 *
 * The first pass only takes the baseline: with nothing to compare against, every
 * file that happens to be dirty would otherwise be claimed by this turn.
 */
function recordTreeChanges(follower: Follower): void {
  const after = snapshotTree(follower.cwd);
  if (!after) return;
  if (follower.tree && follower.turnId) {
    const touches = touchesBetween(follower.tree, after);
    if (touches.length > 0) ledger.recordFiles(follower.turnId, touches);
  }
  follower.tree = after;
}

/**
 * Write the accumulated totals onto the open turn.
 *
 * `keepOpen` is what makes a live conversation work: the row is stored complete
 * after every drain, and the same row keeps being refined as more arrives.
 */
function closeOpenTurn(follower: Follower, opts: { keepOpen?: boolean } = {}): void {
  if (!follower.turnId) return;
  ledger.closeTurn(follower.turnId, {
    status: "done",
    inputTokens: follower.usage.inputTokens,
    outputTokens: follower.usage.outputTokens,
    cacheReadTokens: follower.usage.cacheReadTokens,
    cacheCreateTokens: follower.usage.cacheCreateTokens,
    toolCallCount: follower.toolCalls,
    ...(follower.lastAt ? { endedAt: follower.lastAt } : {}),
  });
  if (!opts.keepOpen) {
    follower.turnId = null;
    follower.usage = emptyUsage();
    follower.toolCalls = 0;
  }
}
