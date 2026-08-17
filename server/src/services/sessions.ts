import { asc, eq } from "drizzle-orm";
import type { ChatSessionInput } from "@claude-station/shared";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { agentDefinition } from "./agents";
import {
  createWorktree,
  isGitRepo,
  listWorktrees,
  pruneOrphanWorktrees,
  removeWorktree,
  worktreeHoldsWork,
} from "./git";

/**
 * Give up every worktree the sessions in the current database own. Called just
 * before an import replaces that database: afterwards no row remembers these
 * paths, so git would keep their branches checked out with nothing left to
 * release them. Worktrees holding work are left in place and reported.
 */
export function releaseAllWorktrees(): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  const owned = db
    .select({ cwd: schema.chatSessions.cwd, worktreePath: schema.chatSessions.worktreePath })
    .from(schema.chatSessions)
    .all()
    .filter((s): s is { cwd: string; worktreePath: string } => !!s.worktreePath);

  for (const { cwd, worktreePath } of owned) {
    try {
      if (!isGitRepo(cwd)) continue;
      const tree = listWorktrees(cwd).find((t) => t.path === worktreePath);
      if (!tree) continue; // already gone from git's point of view
      if (worktreeHoldsWork(cwd, tree)) {
        kept.push(worktreePath);
        continue;
      }
      removeWorktree(cwd, worktreePath);
      removed.push(worktreePath);
    } catch {
      /* repo unreadable — leave it for the boot reconcile to retry */
    }
  }
  return { removed, kept };
}

/**
 * Clear out worktrees left behind by sessions that no longer exist. Runs at boot
 * because the leak is silent: git keeps the orphan's branch checked out, so that
 * branch can't be switched to or deleted, and nothing in the UI hints at why.
 *
 * Returns what it removed and what it deliberately left alone.
 */
export function reconcileWorktreesOnBoot(): { removed: string[]; kept: string[] } {
  const live = new Set(db.select({ id: schema.chatSessions.id }).from(schema.chatSessions).all().map((s) => s.id));
  const isLive = (sessionId: string) => live.has(sessionId);

  const removed: string[] = [];
  const kept: string[] = [];
  // Several projects can point at one repo; each repo only needs looking at once.
  const repos = new Set(
    db.select({ path: schema.projectPaths.path }).from(schema.projectPaths).all().map((p) => p.path),
  );
  for (const repo of repos) {
    // A path that moved or was deleted must not take the whole boot down with it.
    try {
      if (!isGitRepo(repo)) continue;
      const result = pruneOrphanWorktrees(repo, isLive);
      removed.push(...result.removed);
      kept.push(...result.kept);
    } catch {
      /* unreadable repo — nothing to reconcile */
    }
  }
  return { removed, kept };
}

/** Shared by the chat routes and the "Work with Claude" entry points. */
export function createChatSession(projectId: string, input: ChatSessionInput) {
  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, projectId))
    .orderBy(asc(schema.projectPaths.sortOrder))
    .all();
  if (paths.length === 0) throw badRequest("Project has no paths configured");

  const chosen = input.cwdPathId
    ? paths.find((p) => p.id === input.cwdPathId)
    : (paths.find((p) => p.isDefault) ?? paths[0]);
  if (!chosen) throw badRequest("cwdPathId not found in this project");

  // An agent workspace must name an agent that exists, or the session would
  // silently fall back to a plain chat.
  const agentName = input.agentName?.trim() || null;
  if (agentName && !agentDefinition(agentName)) {
    throw badRequest(`No agent named "${agentName}"`);
  }

  const id = newId();
  const useWorktree = input.useWorktree ?? setting("git.useWorktreeDefault");
  const worktreePath = useWorktree ? createWorktree(chosen.path, id) : null;

  const now = nowIso();
  const row = {
    id,
    projectId,
    title:
      input.title ??
      (agentName ? agentName : `Session ${new Date().toLocaleString()}`),
    sdkSessionId: null,
    cwd: chosen.path,
    envSetId: input.envSetId ?? null,
    permissionMode: input.permissionMode,
    model: input.model ?? null,
    origin: input.origin,
    status: "idle" as const,
    worktreePath,
    kind: input.kind ?? (agentName ? ("agent" as const) : ("chat" as const)),
    agentName,
    workflowRunStepId: input.workflowRunStepId ?? null,
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  db.insert(schema.chatSessions).values(row).run();
  db.insert(schema.workHistory)
    .values({
      id: newId(),
      projectId,
      kind: "session_created",
      refId: id,
      summary: `${agentName ? `Started ${agentName} workspace` : "Started session"} in ${
        chosen.label
      }${worktreePath ? " (worktree)" : ""}${
        input.origin !== "manual" ? ` from ${input.origin}` : ""
      }`,
      createdAt: now,
    })
    .run();
  return row;
}
