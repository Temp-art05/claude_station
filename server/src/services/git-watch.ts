// Live "the working tree changed" signal for the Diff tab.
//
// Polling `git status` is the obvious alternative, but on a real Android/iOS repo
// one status call costs the better part of a second — running it every couple of
// seconds per open tab is pure waste. So we watch instead and only tell the client
// *that* something changed; the client re-runs the queries it actually needs.
import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

/** Directories whose churn says nothing about the working tree's git status. */
const IGNORED_DIRS = new Set([
  "node_modules",
  "build",
  ".gradle",
  ".idea",
  "dist",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".venv",
  "__pycache__",
  "DerivedData",
  "Pods",
  ".cache",
  ".turbo",
]);

/**
 * Inside `.git` almost everything is noise (objects/, logs/, lock files churn on
 * every command). These are the entries that mean the *user-visible* state moved:
 * a commit, a checkout, a staging change, a merge starting or ending.
 */
const GIT_DIR_WATCHED = ["HEAD", "index", "MERGE_HEAD", "refs", "packed-refs"];

/**
 * `git check-ignore` would be the precise filter, but it costs a process per
 * event — a build touching thousands of files would fork thousands of times.
 * Matching directory names is coarse and cheap, and being wrong only means one
 * redundant refresh.
 */
export function isNoise(relPath: string): boolean {
  const parts = relPath.split(sep).filter(Boolean);
  if (parts[0] === ".git") {
    const entry = parts[1];
    return !entry || !GIT_DIR_WATCHED.includes(entry);
  }
  return parts.some((p) => IGNORED_DIRS.has(p));
}

const DEBOUNCE_MS = 400;

interface Entry {
  watcher: FSWatcher | null;
  listeners: Set<() => void>;
  timer: NodeJS.Timeout | null;
}

// One watcher per working tree no matter how many tabs/clients are looking at it.
const entries = new Map<string, Entry>();

/**
 * Call `onChange` (debounced) whenever `cwd` changes. Returns a detach function;
 * the watcher is torn down when the last listener leaves.
 *
 * Never throws: `fs.watch` with `recursive` can fail (OS limits, odd paths, some
 * network filesystems). A dead watcher just means the client falls back to its
 * slow poll, which is a degraded refresh rate — not a broken tab.
 */
export function watchTree(cwd: string, onChange: () => void): () => void {
  let entry = entries.get(cwd);
  if (!entry) {
    entry = { watcher: null, listeners: new Set(), timer: null };
    entries.set(cwd, entry);
    const self = entry;
    try {
      self.watcher = watch(cwd, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename && isNoise(filename.toString())) return;
        if (self.timer) clearTimeout(self.timer);
        self.timer = setTimeout(() => {
          self.timer = null;
          for (const fn of self.listeners) {
            try {
              fn();
            } catch {
              /* one bad socket must not stop the others */
            }
          }
        }, DEBOUNCE_MS);
      });
      self.watcher.on("error", () => {
        self.watcher?.close();
        self.watcher = null;
      });
    } catch {
      self.watcher = null;
    }
  }

  entry.listeners.add(onChange);
  const target = entry;
  let detached = false;
  return () => {
    if (detached) return; // a socket can fire close twice
    detached = true;
    target.listeners.delete(onChange);
    if (target.listeners.size === 0) {
      if (target.timer) clearTimeout(target.timer);
      target.watcher?.close();
      entries.delete(cwd);
    }
  };
}

/** True when the tree is being watched for real (vs. the degraded poll-only path). */
export function isWatching(cwd: string): boolean {
  return entries.get(cwd)?.watcher != null;
}
