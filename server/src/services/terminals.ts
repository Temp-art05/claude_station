import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TerminalInput, TerminalKind } from "@claude-station/shared";
import { db, schema } from "../db";
import { buildClaudeCommand } from "../lib/claude-cli";
import { TERMINAL_CONTEXT_DIR, projectKnowledgeDir } from "../lib/data-dir";
import { newId, nowIso } from "../lib/id";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { envVarsFor } from "./env-sets";
import { createWorktree } from "./git";
import { attachedAssetDirs } from "./library";
import * as pty from "./pty-manager";
import { buildWorkspaceContext } from "./workspace-context";

function terminalContextPath(terminalId: string): string {
  return join(TERMINAL_CONTEXT_DIR, `${terminalId}.md`);
}

/**
 * The CLI has no `systemPrompt.append`, so the workspace context an Agent-SDK chat
 * session gets inline goes to a file instead and is passed by path. A file also
 * dodges escaping a multi-line markdown blob through `zsh -c`.
 * Returns "" when there is nothing to say, so the caller drops the flag.
 */
function writeTerminalContext(projectId: string, terminalId: string): string {
  const context = buildWorkspaceContext(projectId).trim();
  if (!context) return "";
  const file = terminalContextPath(terminalId);
  mkdirSync(TERMINAL_CONTEXT_DIR, { recursive: true });
  writeFileSync(file, `${context}\n`, "utf8");
  return file;
}

export function removeTerminalContext(terminalId: string): void {
  rmSync(terminalContextPath(terminalId), { force: true });
}

/**
 * What a claude-kind terminal runs; restart tries to pick the conversation back up.
 * With `opts` the CLI also learns what the workspace is — which repo is which, plus
 * Read access to the paths it is not started in. Called without them it stays the
 * bare CLI.
 */
export function claudeCommand(
  restart: boolean,
  opts?: { projectId: string; terminalId: string; cwd: string; sessionId?: string | null },
): string {
  if (!opts) return buildClaudeCommand(restart);

  // Mirror the chat session's additionalDirectories (claude-session.ts): the other
  // repos in this project, the knowledge store, and assets attached from the library.
  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, opts.projectId))
    .orderBy(asc(schema.projectPaths.sortOrder))
    .all();

  return buildClaudeCommand(restart, {
    sessionId: opts.sessionId ?? undefined,
    contextFile: writeTerminalContext(opts.projectId, opts.terminalId) || undefined,
    extraDirs: [
      ...paths.map((p) => p.path).filter((p) => p !== opts.cwd),
      projectKnowledgeDir(opts.projectId),
      ...attachedAssetDirs(opts.projectId),
    ],
  });
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
export function createTerminal(
  projectId: string,
  input: TerminalInput & {
    useWorktree?: boolean;
    command?: string;
    /** Extra env for this PTY only (e.g. workflow progress-report credentials). */
    extraEnv?: Record<string, string>;
  },
) {
  const kind: TerminalKind = input.kind ?? "shell";
  const id = newId();
  // Pinning the CLI to an id of our own is what makes "continue this one" exact
  // later on, and what makes its transcript findable when the row is deleted.
  const claudeSessionId = kind === "claude" ? randomUUID() : null;
  const base = resolveCwd(projectId, input);
  // A worktree cwd lives in data/worktrees/<terminalId>, which path-safety allows.
  const cwd = input.useWorktree ? createWorktree(base, id) : base;
  const env = { ...(input.envSetId ? envVarsFor(input.envSetId) : {}), ...input.extraEnv };
  const { pid } = pty.start({
    id,
    cwd,
    env,
    // App agents pass their start command; a claude tab runs the CLI; else plain shell.
    command:
      input.command ??
      (kind === "claude"
        ? claudeCommand(false, { projectId, terminalId: id, cwd, sessionId: claudeSessionId })
        : undefined),
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
    command: input.command ?? null,
    claudeSessionId,
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
