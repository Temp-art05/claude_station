/**
 * Comparing two filesystem paths for "the same place".
 *
 * macOS is case-insensitive by default, so one directory legitimately has several
 * spellings and both reach the same files. That is not a hypothetical: the project
 * path configured here can read `~/iOS/IIP555-ReelMe` while the `claude` CLI
 * recorded `cwd: /Users/…/IOS/IIP555-ReelMe` for the same repo, because that is
 * how the shell's cwd happened to be spelled. A case-sensitive prefix match then
 * silently fails to place the file in any repo, and commit attribution quietly
 * gets weaker with no error anywhere.
 *
 * The comparisons here are string-only, on purpose: resolving symlinks costs a
 * syscall per call and returns nothing for a path that has since been deleted —
 * and a deleted file is exactly the case a record of past work must keep
 * answering for. Where a path is an *identity* rather than something to open,
 * `realish` below is the explicit opt-in to resolving it.
 */
import { realpathSync } from "node:fs";
import { sep } from "node:path";

/** Filesystems that ignore case for lookups. Linux is left strict on purpose. */
const IGNORE_CASE = process.platform === "darwin" || process.platform === "win32";

function key(path: string): string {
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  return IGNORE_CASE ? trimmed.toLowerCase() : trimmed;
}

/** The same directory or file, however it is spelled. */
export function pathEq(a: string, b: string): boolean {
  return key(a) === key(b);
}

/** `child` is `parent` itself, or somewhere inside it. */
export function pathUnder(child: string, parent: string): boolean {
  const c = key(child);
  const p = key(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * `child` relative to `parent`, in the child's own spelling — the caller wants a
 * path it can show and use, not a lowercased one.
 */
export function relativeUnder(child: string, parent: string): string {
  if (!pathUnder(child, parent) || pathEq(child, parent)) return "";
  const cut = (parent.endsWith(sep) ? parent : parent + sep).length;
  return child.slice(cut);
}

/** True when any of `parents` contains `child`. */
export function pathUnderAny(child: string, parents: readonly string[]): boolean {
  return parents.some((parent) => pathUnder(child, parent));
}

/**
 * The path with symlinks resolved, or the path itself when it cannot be resolved.
 *
 * Needed wherever a path becomes an *identity* rather than just something to open.
 * On macOS `/var` is a symlink to `/private/var`, and `/tmp` to `/private/tmp`, so
 * the same repo reached two ways produces two spellings — and a table keyed on the
 * path then holds it twice, with lookups finding neither reliably.
 *
 * Falls back to the input rather than throwing: a path that no longer exists still
 * has to be comparable, which is exactly the case a record of past work is for.
 */
export function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
