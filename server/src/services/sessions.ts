import { asc, eq } from "drizzle-orm";
import type { ChatSessionInput } from "@claude-station/shared";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { agentDefinition } from "./agents";
import { createWorktree } from "./git";

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
