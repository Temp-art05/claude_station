/**
 * What a turn actually changed in the working tree.
 *
 * Tool calls name the files they edit, so `Edit` and `Write` are recorded exactly
 * — but an edit made through `Bash` (`sed -i`, a heredoc, `tee`) names nothing.
 * That was measured, not assumed: across 224 transcripts, no path appeared in the
 * CLI's own file-history records that did not also appear in an Edit/Write call,
 * and a session that writes only through Bash leaves no trace of the file at all.
 * Auto mode does exactly that, all day.
 *
 * So the ground truth comes from git: take the tree's state at both ends of a
 * turn, and whatever moved was written by it, whichever tool did the writing.
 *
 * The cost was the open question, and it is settled: `git status --porcelain -uall`
 * runs in 23-54ms on the real iOS repos here, one of them 6.3GB. Two calls per
 * turn is nothing next to a turn that lasts tens of seconds, which is why
 * `ledger.treeSnapshot` defaults to on.
 *
 * What this cannot know: whether the person edited a file by hand while the agent
 * was working. Anything that moves inside the window is attributed to the turn, so
 * a `tree` claim means "changed while this turn was running" — strong evidence,
 * not proof. Commit attribution scores it rather than trusting it outright.
 */
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { setting } from "../lib/config";
import type { FileTouch } from "./session-ledger";

export interface TreeSnapshot {
  cwd: string;
  /** HEAD sha, or null in a repo with no commits yet. */
  head: string | null;
  /** Path inside the repo -> its two-letter porcelain status. */
  entries: Map<string, string>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * NUL-separated because a path can contain spaces or a newline, and the non-`-z`
 * output quotes those in a shell-ish way that then has to be unquoted. Rename and
 * copy entries carry two paths — the new one, then the old one — so they consume
 * an extra field.
 */
export function parseStatusZ(out: string): Map<string, string> {
  const entries = new Map<string, string>();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    entries.set(path, status);
    if (status[0] === "R" || status[0] === "C") {
      // The next field is where it came from; that path is gone from the tree.
      const from = fields[i + 1];
      i += 1;
      if (from) entries.set(from, status[0] === "R" ? " D" : status);
    }
  }
  return entries;
}

/** The tree's current state, or null when this is not a repo (or git failed). */
export function snapshotTree(cwd: string): TreeSnapshot | null {
  if (!setting("ledger.treeSnapshot")) return null;
  let head: string | null;
  try {
    head = git(cwd, ["rev-parse", "HEAD"]).trim() || null;
  } catch {
    // A repo with no commits yet still has a working tree worth watching.
    head = null;
  }
  try {
    const out = git(cwd, ["status", "--porcelain=v1", "-uall", "-z"]);
    return { cwd, head, entries: parseStatusZ(out) };
  } catch {
    // Not a repo, git missing, or an index.lock held by another command.
    return null;
  }
}

/**
 * Files whose state differs between two snapshots of the same tree.
 *
 * A path that was modified and is now clean counts too: that is what a commit
 * made mid-turn looks like, and the turn still wrote the file.
 */
export function diffTrees(
  before: TreeSnapshot | null,
  after: TreeSnapshot | null,
): { relPath: string; op: "write" | "delete" }[] {
  if (!before || !after) return [];
  const touched: { relPath: string; op: "write" | "delete" }[] = [];
  for (const path of new Set([...before.entries.keys(), ...after.entries.keys()])) {
    const from = before.entries.get(path) ?? "";
    const to = after.entries.get(path) ?? "";
    if (from === to) continue;
    touched.push({ relPath: path, op: to.includes("D") ? "delete" : "write" });
  }
  return touched.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** git's name for "nothing", so the first commit can be diffed against it. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Parse `git diff --name-status -z`: STATUS, then path — except a rename or copy,
 * which is STATUS, old path, new path.
 */
export function parseNameStatusZ(out: string): { relPath: string; op: "write" | "delete" }[] {
  const fields = out.split("\0");
  const touched: { relPath: string; op: "write" | "delete" }[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i];
    if (!status) continue;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 2;
      if (from) touched.push({ relPath: from, op: kind === "R" ? "delete" : "write" });
      if (to) touched.push({ relPath: to, op: "write" });
      continue;
    }
    const path = fields[i + 1];
    i += 1;
    if (!path) continue;
    touched.push({ relPath: path, op: kind === "D" ? "delete" : "write" });
  }
  return touched;
}

/**
 * Files the commits between two HEADs changed.
 *
 * Without this, a turn that commits its own work leaves no trace at all: the tree
 * is clean at both ends, so the status comparison sees nothing, and the turn that
 * did the most finished work would look like the one that did none.
 */
export function committedBetween(
  cwd: string,
  fromHead: string | null,
  toHead: string | null,
): { relPath: string; op: "write" | "delete" }[] {
  if (!toHead || fromHead === toHead) return [];
  try {
    const out = git(cwd, ["diff", "--name-status", "-z", fromHead ?? EMPTY_TREE, toHead]);
    return parseNameStatusZ(out);
  } catch {
    // A rewritten history can leave `fromHead` unreachable; the status comparison
    // still stands on its own.
    return [];
  }
}

/**
 * Ledger rows for everything the turn changed: what is still visible in the tree,
 * plus what it committed along the way.
 */
export function touchesBetween(
  before: TreeSnapshot | null,
  after: TreeSnapshot | null,
): FileTouch[] {
  if (!after) return [];
  const seen = new Map<string, "write" | "delete">();
  for (const { relPath, op } of diffTrees(before, after)) seen.set(relPath, op);
  if (before) {
    for (const { relPath, op } of committedBetween(after.cwd, before.head, after.head)) {
      // A path both committed and still dirty is one fact; the tree's own verdict
      // is the later one, so it wins.
      if (!seen.has(relPath)) seen.set(relPath, op);
    }
  }
  return [...seen]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([relPath, op]) => ({
      absPath: isAbsolute(relPath) ? relPath : join(after.cwd, relPath),
      op,
      source: "tree" as const,
      toolName: null,
    }));
}
