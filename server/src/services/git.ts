import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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
  const out = git(cwd, ["status", "--porcelain=v1", "-z"]);
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
    return git(cwd, args);
  } catch {
    return "";
  }
}

/** Discard local changes to specific files — always confirmed in the UI first. */
export function revertFiles(cwd: string, files: string[]): void {
  if (files.length === 0) return;
  git(cwd, ["checkout", "--", ...files]);
}
