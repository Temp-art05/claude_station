import { asc, eq } from "drizzle-orm";
import type { ChatSessionInput } from "@claude-station/shared";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { agentDefinition } from "./agents";
import { createWorktree, isGitRepo, pruneOrphanWorktrees } from "./git";

/**
 * Clear out worktrees left behind by sessions that no longer exist. Runs at boot
 * because the leak is silent: git keeps the orphan's branch checked out, so that
 * branch can't be switched to or deleted, and nothing in the UI hints at why.
 *
 * Returns what it removed and what it deliberately left alone.
 */
export function reconcileWorktreesOnBoot(): { removed: string[]; kept: string[] } {
  // A worktree is named after whatever owns it, and two things do: a chat session
  // and — since workflow steps started running in real terminals — a terminal.
  // Counting only sessions reaped every step terminal's checkout on the next
  // boot, and the step then failed on a cwd that no longer existed, which reads
  // as the terminal being broken rather than deleted.
  const live = new Set([
    ...db
      .select({ id: schema.chatSessions.id })
      .from(schema.chatSessions)
      .all()
      .map((s) => s.id),
    ...db
      .select({ id: schema.terminals.id, closedAt: schema.terminals.closedAt })
      .from(schema.terminals)
      .all()
      .filter((t) => t.closedAt === null)
      .map((t) => t.id),
  ]);
  const isLive = (ownerId: string) => live.has(ownerId);

  const removed: string[] = [];
  const kept: string[] = [];
  // Several projects can point at one repo; each repo only needs looking at once.
  const repos = new Set(
    db
      .select({ path: schema.projectPaths.path })
      .from(schema.projectPaths)
      .all()
      .map((p) => p.path),
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
    title: input.title ?? (agentName ? agentName : `Session ${new Date().toLocaleString()}`),
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
