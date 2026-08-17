import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKTREES_DIR } from "../lib/data-dir";
import { badRequest, conflict, tooLarge } from "../lib/path-safety";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * A session can get its own checkout so two agents never write the same tree.
 * Lives in data/worktrees/<sessionId> and is removed when the session is archived.
 */
export function createWorktree(repoPath: string, sessionId: string): string {
  if (!isGitRepo(repoPath)) throw badRequest(`Not a git repo: ${repoPath}`);
  const target = join(WORKTREES_DIR, sessionId);
  const branch = `claude-station/${sessionId.slice(0, 12)}`;
  git(repoPath, ["worktree", "add", "-b", branch, target]);
  return target;
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  try {
    git(repoPath, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    // Worktree metadata may already be gone; make sure the directory is too.
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    try {
      git(repoPath, ["worktree", "prune"]);
    } catch {
      /* best effort */
    }
  }
}

export interface GitFileChange {
  path: string;
  status: string;
  staged: boolean;
}

export function status(cwd: string): GitFileChange[] {
  if (!isGitRepo(cwd)) return [];
  // -uall: expand untracked directories into individual files — a bare
  // `?? dir/` entry can't be diffed (diff --no-index rejects directories).
  const out = git(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
  const entries = out.split("\0").filter(Boolean);
  const changes: GitFileChange[] = [];
  for (const entry of entries) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    changes.push({
      path,
      status: code.trim() || "?",
      staged: code[0] !== " " && code[0] !== "?",
    });
  }
  return changes;
}

export function diff(cwd: string, file?: string): string {
  if (!isGitRepo(cwd)) return "";
  const args = ["diff", "--no-color", "HEAD"];
  if (file) args.push("--", file);
  try {
    const patch = git(cwd, args);
    if (patch.trim() || !file) return patch;
    // `diff HEAD` is blind to untracked files — synthesize an all-added patch.
    return untrackedPatch(cwd, file);
  } catch {
    return "";
  }
}

/** git diff --no-index exits 1 when files differ — the patch is still on stdout. */
function untrackedPatch(cwd: string, file: string): string {
  if (!existsSync(join(cwd, file))) return "";
  try {
    return git(cwd, ["diff", "--no-color", "--no-index", "--", "/dev/null", file]);
  } catch (err) {
    const out = (err as { stdout?: string }).stdout;
    return typeof out === "string" ? out : "";
  }
}

/**
 * Stage untracked files ("Add to VCS" in the Unversioned Files group).
 *
 * Note this is a convenience, not a precondition: `commit()` below already does
 * `git add -A` on whatever was ticked, so an untracked file commits fine without
 * ever being added here. Adding just moves it into the tracked group.
 */
export function addFiles(cwd: string, files: string[]): void {
  if (files.length === 0) return;
  try {
    git(cwd, ["add", "--", ...files]);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    // Most common cause by far: the path is covered by .gitignore. git says so
    // clearly, so pass its own words through instead of inventing a message.
    throw badRequest(`git add failed: ${(stderr || stdout).trim().slice(0, 500)}`);
  }
}

/**
 * Delete unversioned files from disk — the Unversioned Files group's counterpart
 * to Rollback. An untracked file has no committed version to restore, so removing
 * it is the only "undo" there is.
 *
 * Every path is re-checked against `git status` here rather than trusting the
 * caller: this deletes real files with no way back, and a stale UI or a wrong
 * pathId must not be able to wipe something git is tracking.
 */
export function deleteUntracked(cwd: string, files: string[]): number {
  if (files.length === 0) return 0;
  const untracked = new Set(
    status(cwd)
      .filter((f) => f.status === "??")
      .map((f) => f.path),
  );
  for (const file of files) {
    if (!untracked.has(file)) {
      throw badRequest(
        `Refusing to delete "${file}": it is not an unversioned file. Use Rollback to discard changes to tracked files.`,
      );
    }
  }
  for (const file of files) rmSync(join(cwd, file), { recursive: true, force: true });
  return files.length;
}

/** Discard local changes to specific files — always confirmed in the UI first. */
export function revertFiles(cwd: string, files: string[]): void {
  if (files.length === 0) return;
  git(cwd, ["checkout", "--", ...files]);
}

/** Tracked + untracked-but-not-ignored paths — what the project tree shows. */
export function listFiles(cwd: string, cap = 30_000): { files: string[]; truncated: boolean } {
  if (!isGitRepo(cwd)) return { files: [], truncated: false };
  const out = git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const files = out.split("\0").filter(Boolean).sort();
  return { files: files.slice(0, cap), truncated: files.length > cap };
}

export interface BranchInfo {
  branch: string;
  ahead: number;
  behind: number;
}

/** First line of `git status -sb`: "## main...origin/main [ahead 1, behind 2]". */
export function branchInfo(cwd: string): BranchInfo | null {
  if (!isGitRepo(cwd)) return null;
  try {
    const line = git(cwd, ["status", "-sb"]).split("\n")[0] ?? "";
    const branch = line.replace(/^## /, "").split("...")[0]?.trim() || "(detached)";
    const ahead = Number(/ahead (\d+)/.exec(line)?.[1] ?? 0);
    const behind = Number(/behind (\d+)/.exec(line)?.[1] ?? 0);
    return { branch, ahead, behind };
  } catch {
    return null;
  }
}

const FILE_CAP = 1_000_000;

export interface FileRead {
  content: string;
  truncated: boolean;
  binary: boolean;
  /**
   * sha256 of the bytes on disk, or "" when there is nothing editable (binary, or
   * a file with no HEAD version). The editor sends it back on save so a write can
   * be refused when something else — an agent, an IDE — got there first.
   */
  hash: string;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** A file as it is on disk (rev=worktree) or as HEAD knows it (rev=head). */
export function readTreeFile(cwd: string, file: string, rev: "worktree" | "head"): FileRead {
  let buf: Buffer;
  if (rev === "head") {
    try {
      buf = execFileSync("git", ["show", `HEAD:${file}`], { cwd, maxBuffer: 32 * 1024 * 1024 });
    } catch {
      // new file — no HEAD version
      return { content: "", truncated: false, binary: false, hash: "" };
    }
  } else {
    const abs = join(cwd, file);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw badRequest(`Not a file: ${file}`);
    }
    buf = readFileSync(abs);
  }
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return { content: "", truncated: false, binary: true, hash: "" };
  const truncated = buf.byteLength > FILE_CAP;
  return {
    content: buf.subarray(0, FILE_CAP).toString("utf8"),
    truncated,
    binary: false,
    // Hash of the WHOLE file, not the truncated slice — otherwise a >1MB file
    // would look unchanged to the guard below while its tail differs.
    hash: sha256(buf),
  };
}

/**
 * Save an edit made in the Diff tab.
 *
 * `baseHash` is what the editor loaded. Anything else on disk means someone wrote
 * the file in the meantime — most likely one of this very app's agents — so the
 * write is refused instead of silently burying their work.
 */
export function writeTreeFile(
  cwd: string,
  file: string,
  content: string,
  baseHash: string,
): { hash: string } {
  const abs = join(cwd, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw badRequest(`Not a file: ${file}`);
  const current = readFileSync(abs);
  if (current.subarray(0, 8192).includes(0)) throw badRequest("Refusing to edit a binary file");
  if (current.byteLength > FILE_CAP) {
    throw badRequest("File is larger than 1 MB — edit it in a real editor");
  }
  const next = Buffer.from(content, "utf8");
  if (next.byteLength > FILE_CAP) throw tooLarge("Content exceeds the 1 MB limit");
  const currentHash = sha256(current);
  if (currentHash !== baseHash) {
    throw conflict("File changed on disk since it was opened — reload before saving");
  }
  // Write beside the target then rename: a crash mid-write leaves the original
  // intact rather than half a source file. Same directory so rename stays atomic
  // (across filesystems it would degrade to a copy).
  const tmp = `${abs}.station-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, next);
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { hash: sha256(next) };
}

/** Stage exactly the picked files and commit them. */
export function commit(
  cwd: string,
  files: string[],
  message: string,
  amend: boolean,
): { summary: string } {
  if (!isGitRepo(cwd)) throw badRequest(`Not a git repo: ${cwd}`);
  if (files.length === 0) throw badRequest("Pick at least one file to commit");
  git(cwd, ["add", "-A", "--", ...files]);
  const args = ["commit"];
  if (amend) {
    args.push("--amend");
    if (message.trim()) args.push("-m", message);
    else args.push("--no-edit");
  } else {
    if (!message.trim()) throw badRequest("Commit message is required");
    args.push("-m", message);
  }
  try {
    git(cwd, args);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    throw badRequest(`git commit failed: ${(stderr || stdout).trim().slice(0, 500)}`);
  }
  return { summary: git(cwd, ["log", "-1", "--oneline"]).trim() };
}

/** Push the current branch; first push sets the upstream automatically. */
export function push(cwd: string): string {
  try {
    return git(cwd, ["push"]);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (/no upstream|set-upstream/i.test(stderr)) {
      return git(cwd, ["push", "-u", "origin", "HEAD"]);
    }
    throw badRequest(`git push failed: ${stderr.trim().slice(0, 500)}`);
  }
}

// ── Branch management (Android Studio-style menu) ─────────────────────────────

function gitOr400(cwd: string, args: string[], label: string): string {
  try {
    return git(cwd, args);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    throw badRequest(`${label} failed: ${(stderr || stdout).trim().slice(0, 600)}`);
  }
}

export interface Branches {
  current: string;
  local: { name: string; upstream: string | null }[];
  remote: string[];
  /** A merge/rebase/cherry-pick left half-done — offer Abort instead of actions. */
  inProgress: "merge" | "rebase" | null;
}

export function branches(cwd: string): Branches {
  const current = branchInfo(cwd)?.branch ?? "(detached)";
  const local = git(cwd, [
    "for-each-ref",
    "refs/heads",
    "--format=%(refname:short)\x1f%(upstream:short)",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, upstream] = line.split("\x1f");
      return { name: name!, upstream: upstream || null };
    });
  const remote = git(cwd, ["for-each-ref", "refs/remotes", "--format=%(refname:short)"])
    .split("\n")
    .filter((r) => r && !r.endsWith("/HEAD"));
  const gitDir = git(cwd, ["rev-parse", "--git-dir"]).trim();
  const inProgress = existsSync(join(cwd, gitDir, "rebase-merge")) ||
    existsSync(join(cwd, gitDir, "rebase-apply"))
    ? ("rebase" as const)
    : existsSync(join(cwd, gitDir, "MERGE_HEAD"))
      ? ("merge" as const)
      : null;
  return { current, local, remote, inProgress };
}

function refExists(cwd: string, fullRef: string): boolean {
  try {
    git(cwd, ["show-ref", "--verify", "--quiet", fullRef]);
    return true;
  } catch {
    return false;
  }
}

function remoteNames(cwd: string): string[] {
  try {
    return git(cwd, ["remote"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Switch branches. A remote name (origin/x) checks out a tracking local x; a local
 * branch is switched to as-is. Which one it is comes from looking the ref up, never
 * from the shape of the name: `version/4.0.0` is a perfectly ordinary local branch,
 * and guessing "anything with a slash is remote" used to turn a click on it into
 * `switch -c 4.0.0 --track version/4.0.0` — a brand new branch instead of a checkout.
 */
export function checkout(cwd: string, branch: string, create = false): string {
  if (create) return gitOr400(cwd, ["switch", "-c", branch], "create branch");
  // Local wins over a same-named remote shorthand, matching plain `git switch`.
  if (refExists(cwd, `refs/heads/${branch}`)) return gitOr400(cwd, ["switch", branch], "checkout");
  if (refExists(cwd, `refs/remotes/${branch}`)) {
    // Strip the actual remote name, not the first path segment — the rest of the
    // ref is the local branch name (origin/feature/x → feature/x).
    const remote = remoteNames(cwd).find((r) => branch.startsWith(`${r}/`));
    const local = remote ? branch.slice(remote.length + 1) : branch;
    return refExists(cwd, `refs/heads/${local}`)
      ? gitOr400(cwd, ["switch", local], "checkout")
      : gitOr400(cwd, ["switch", "-c", local, "--track", branch], "checkout");
  }
  // Neither — let git produce the error message for whatever this is.
  return gitOr400(cwd, ["switch", branch], "checkout");
}

export function deleteBranch(cwd: string, name: string, force = false): string {
  return gitOr400(cwd, ["branch", force ? "-D" : "-d", name], "delete branch");
}

export function fetchAll(cwd: string): string {
  return gitOr400(cwd, ["fetch", "--all", "--prune"], "fetch");
}

export function pull(cwd: string, rebase = false): string {
  return gitOr400(cwd, rebase ? ["pull", "--rebase"] : ["pull"], "pull");
}

export function merge(cwd: string, branch: string, squash = false): string {
  return gitOr400(
    cwd,
    squash ? ["merge", "--squash", branch] : ["merge", "--no-edit", branch],
    "merge",
  );
}

export function rebase(cwd: string, onto: string): string {
  return gitOr400(cwd, ["rebase", onto], "rebase");
}

/** Bail out of a half-done merge/rebase — the UI's escape hatch. */
export function abortInProgress(cwd: string): string {
  const state = branches(cwd).inProgress;
  if (state === "rebase") return gitOr400(cwd, ["rebase", "--abort"], "rebase --abort");
  if (state === "merge") return gitOr400(cwd, ["merge", "--abort"], "merge --abort");
  throw badRequest("No merge/rebase in progress");
}

// ── History ───────────────────────────────────────────────────────────────────

export interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  /** Decorations: branch/tag names pointing at this commit. */
  refs: string[];
}

export function log(cwd: string, limit = 100, branch?: string): LogEntry[] {
  if (!isGitRepo(cwd)) return [];
  const args = [
    "log",
    `-n${limit}`,
    "--date=relative",
    "--pretty=format:%H\x1f%h\x1f%an\x1f%ad\x1f%s\x1f%D",
  ];
  if (branch) args.push(branch);
  let out: string;
  try {
    out = git(cwd, args);
  } catch {
    return []; // empty repo
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, date, subject, refs] = line.split("\x1f");
      return {
        hash: hash!,
        shortHash: shortHash!,
        author: author ?? "",
        date: date ?? "",
        subject: subject ?? "",
        refs: (refs ?? "")
          .split(",")
          .map((r) => r.trim().replace(/^HEAD -> /, ""))
          .filter(Boolean),
      };
    });
}

export function commitFiles(cwd: string, hash: string): { path: string; status: string }[] {
  const out = gitOr400(
    cwd,
    ["show", "--name-status", "--pretty=format:", "--no-color", hash],
    "show",
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status?.[0] ?? "?", path: rest[rest.length - 1] ?? "" };
    })
    .filter((f) => f.path);
}

/** One file's patch inside one commit — feeds the side-by-side viewer. */
export function commitPatch(cwd: string, hash: string, file?: string): string {
  const args = ["show", "--no-color", "--pretty=format:", hash];
  if (file) args.push("--", file);
  return gitOr400(cwd, args, "show");
}

/** Undo exactly one hunk in the working tree: apply the hunk's patch reversed. */
export function revertHunk(cwd: string, patch: string): void {
  try {
    execFileSync("git", ["apply", "-R", "--whitespace=nowarn", "-"], {
      cwd,
      input: patch.endsWith("\n") ? patch : `${patch}\n`,
      encoding: "utf8",
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    throw badRequest(
      `Rollback failed — the file may have changed since this diff was loaded: ${stderr
        .trim()
        .slice(0, 300)}`,
    );
  }
}
