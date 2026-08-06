import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { WORKTREES_DIR } from "../lib/data-dir";
import { badRequest } from "../lib/path-safety";

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
}

/** A file as it is on disk (rev=worktree) or as HEAD knows it (rev=head). */
export function readTreeFile(cwd: string, file: string, rev: "worktree" | "head"): FileRead {
  let buf: Buffer;
  if (rev === "head") {
    try {
      buf = execFileSync("git", ["show", `HEAD:${file}`], { cwd, maxBuffer: 32 * 1024 * 1024 });
    } catch {
      return { content: "", truncated: false, binary: false }; // new file — no HEAD version
    }
  } else {
    const abs = join(cwd, file);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw badRequest(`Not a file: ${file}`);
    }
    buf = readFileSync(abs);
  }
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return { content: "", truncated: false, binary: true };
  const truncated = buf.byteLength > FILE_CAP;
  return {
    content: buf.subarray(0, FILE_CAP).toString("utf8"),
    truncated,
    binary: false,
  };
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

/** Switch branches; a remote name (origin/x) checks out a tracking local x. */
export function checkout(cwd: string, branch: string, create = false): string {
  if (create) return gitOr400(cwd, ["switch", "-c", branch], "create branch");
  const remoteMatch = /^[^/]+\/(.+)$/.exec(branch);
  if (remoteMatch) {
    const local = remoteMatch[1]!;
    const hasLocal = git(cwd, ["branch", "--list", local]).trim() !== "";
    return hasLocal
      ? gitOr400(cwd, ["switch", local], "checkout")
      : gitOr400(cwd, ["switch", "-c", local, "--track", branch], "checkout");
  }
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
