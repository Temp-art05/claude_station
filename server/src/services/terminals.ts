import { asc, eq } from "drizzle-orm";
import type { TerminalInput, TerminalKind } from "@claude-station/shared";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { envVarsFor } from "./env-sets";
import { createWorktree } from "./git";
import * as pty from "./pty-manager";

/** What a claude-kind terminal runs; restart tries to pick the conversation back up. */
export function claudeCommand(restart: boolean): string {
  return restart ? "claude --continue || claude" : "claude";
}

export function resolveCwd(projectId: string, input: { cwdPathId?: string; cwd?: string }): string {
  if (input.cwd) return assertPathAllowed(input.cwd, projectId);
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
  return chosen.path;
}

/** Shared by the terminal routes and the "Work with Claude" entry points. */
export function createTerminal(projectId: string, input: TerminalInput & { useWorktree?: boolean }) {
  const kind: TerminalKind = input.kind ?? "shell";
  const id = newId();
  const base = resolveCwd(projectId, input);
  // A worktree cwd lives in data/worktrees/<terminalId>, which path-safety allows.
  const cwd = input.useWorktree ? createWorktree(base, id) : base;
  const env = input.envSetId ? envVarsFor(input.envSetId) : {};
  const { pid } = pty.start({
    id,
    cwd,
    env,
    command: kind === "claude" ? claudeCommand(false) : undefined,
  });

  const count = db
    .select()
    .from(schema.terminals)
    .where(eq(schema.terminals.projectId, projectId))
    .all()
    .filter((t) => t.kind === kind).length;

  const row = {
    id,
    projectId,
    title: input.title ?? `${kind === "claude" ? "Claude" : "Terminal"} ${count + 1}`,
    cwd,
    envSetId: input.envSetId ?? null,
    pid,
    kind,
    status: "running" as const,
    createdAt: nowIso(),
    closedAt: null,
  };
  db.insert(schema.terminals).values(row).run();
  db.insert(schema.workHistory)
    .values({
      id: newId(),
      projectId,
      kind: "terminal_opened",
      refId: id,
      summary: `Opened ${row.title} in ${cwd}`,
      createdAt: row.createdAt,
    })
    .run();
  return row;
}
