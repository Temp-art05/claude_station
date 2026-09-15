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
import { TOKEN } from "../lib/auth";
import { env as env_, setting } from "../lib/config";
import { envVarsFor } from "./env-sets";
import { createWorktree } from "./git";
import { attachedAssetDirs } from "./library";
import * as pty from "./pty-manager";
import * as follower from "./transcript-follower";
import { buildWorkspaceContext } from "./workspace-context";
import { reachEnv } from "./reach-skills";
import { refreshMirrors } from "./reach-mirror";
import { presetById, presetCommand } from "../lib/agent-cli";

function terminalContextPath(terminalId: string): string {
  return join(TERMINAL_CONTEXT_DIR, `${terminalId}.md`);
}

/**
 * The CLI has no `systemPrompt.append`, so the workspace context an Agent-SDK chat
 * session gets inline goes to a file instead and is passed by path. A file also
 * dodges escaping a multi-line markdown blob through `zsh -c`.
 * Returns "" when there is nothing to say, so the caller drops the flag.
 */
function writeTerminalContext(
  projectId: string,
  terminalId: string,
  sessionKey: string | null,
): string {
  const context = buildWorkspaceContext(projectId, sessionKey).trim();
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
  opts?: {
    projectId: string;
    terminalId: string;
    cwd: string;
    sessionId?: string | null;
    /** Set for a workflow step: the station's tools, and the step's own mode. */
    mcpConfigFile?: string;
    permissionMode?: string;
  },
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
    mcpConfigFile: opts.mcpConfigFile,
    permissionMode: opts.permissionMode,
    // The conversation id doubles as the bus cursor key. A terminal is written
    // once, at spawn, so what it gets is the state — the deltas that arrive while
    // it runs are what the Memory tab's "new since" count is for: there is no way
    // to inject into a PTY mid-conversation without typing for the user.
    contextFile:
      writeTerminalContext(opts.projectId, opts.terminalId, opts.sessionId ?? null) || undefined,
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
    /**
     * Adopt an existing `claude` conversation instead of starting one: the row
     * takes this session id as its own and the CLI resumes it. How a conversation
     * that ran outside the app becomes a session of the app.
     */
    resumeSessionId?: string;
    /** Workflow steps only: the bridge config and the step's permission mode. */
    mcpConfigFile?: string;
    permissionMode?: string;
    /**
     * Start an agent CLI that is not Claude Code (`codex`, `opencode`, …).
     *
     * Stays a `shell` terminal on purpose: the transcript follower, the ledger
     * and the MCP bridge are all Claude-shaped, and pretending otherwise would
     * produce a History tab full of sessions with no turns in them.
     */
    agentCli?: string;
  },
) {
  const preset = input.agentCli ? presetById(input.agentCli) : null;
  if (input.agentCli && !preset) throw badRequest(`Unknown agent CLI: ${input.agentCli}`);
  const kind: TerminalKind = preset ? "shell" : (input.kind ?? "shell");
  const id = newId();
  // Pinning the CLI to an id of our own is what makes "continue this one" exact
  // later on, and what makes its transcript findable when the row is deleted.
  const claudeSessionId = kind === "claude" ? (input.resumeSessionId ?? randomUUID()) : null;
  const base = resolveCwd(projectId, input);
  // A worktree cwd lives in data/worktrees/<terminalId>, which path-safety allows.
  const cwd = input.useWorktree ? createWorktree(base, id) : base;
  // Reach needs to know where to call back and with what. Deliberately named
  // `CS_*` rather than reusing `CLAUDE_STATION_TOKEN`, which `childBaseEnv()`
  // strips on purpose — this is a grant, not a leak through inheritance.
  const env = {
    ...(kind === "claude" && setting("reach.enabled") ? reachEnv(TOKEN) : {}),
    ...(input.envSetId ? envVarsFor(input.envSetId) : {}),
    ...input.extraEnv,
  };
  const { pid } = pty.start({
    id,
    cwd,
    env,
    // App agents pass their start command; a claude tab runs the CLI; else plain shell.
    command:
      input.command ??
      (preset ? presetCommand(preset) : undefined) ??
      (kind === "claude"
        ? claudeCommand(Boolean(input.resumeSessionId), {
            projectId,
            terminalId: id,
            cwd,
            sessionId: claudeSessionId,
            mcpConfigFile: input.mcpConfigFile,
            permissionMode: input.permissionMode,
          })
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
    title:
      input.title ??
      `${preset ? preset.label : kind === "claude" ? "Claude" : "Terminal"} ${count + 1}`,
    cwd,
    envSetId: input.envSetId ?? null,
    pid,
    kind,
    command: input.command ?? (preset ? presetCommand(preset) : null),
    claudeSessionId,
    status: "running" as const,
    createdAt: nowIso(),
    closedAt: null,
  };
  db.insert(schema.terminals).values(row).run();
  // The CLI writes the transcript itself; following it is how a terminal tab gets
  // the same turn record an Agent SDK session gets. The file usually does not
  // exist yet at this point — the follower waits for it.
  // The `@`-reachable pointers, rebuilt as the terminal opens so what completes
  // matches what the stores hold right now.
  if (kind === "claude" && setting("reach.enabled") && setting("reach.mirror")) {
    try {
      refreshMirrors(projectId);
    } catch {
      /* a repo we cannot write to simply has no mirror */
    }
  }

  if (claudeSessionId) {
    follower.follow({ claudeSessionId, projectId, cwd, terminalId: id });
  }
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

/**
 * Start following every `claude` tab that is still running, after a restart.
 *
 * This is the case the byte offset exists for: while the server was down the tab
 * stayed alive in tmux and the CLI kept appending, so the conversation is picked
 * up where capture left off instead of from zero.
 */
/**
 * Attach this process to a terminal whose PTY it no longer has.
 *
 * tmux keeps the work running across a server restart, so a row can be perfectly
 * alive — the `claude` session still sitting at its prompt — while this process
 * holds nothing it can read or write. `pty.start` reattaches a live tmux session
 * and ignores the command; only when the session is really gone does the command
 * start something new.
 *
 * Returns false when there is nothing to revive. Used by the Restart button and
 * by the workflow runner, which otherwise hands a step a terminal it cannot type
 * into — the step then waits out its timeout looking at an empty string.
 */
export function reviveTerminal(id: string): boolean {
  if (pty.isRunning(id)) return true;
  const existing = db.select().from(schema.terminals).where(eq(schema.terminals.id, id)).get();
  if (!existing) return false;

  const env: Record<string, string> = existing.envSetId ? envVarsFor(existing.envSetId) : {};
  // Terminal-mode workflow runs curl step progress back with these two vars.
  // extraEnv is never persisted — and shouldn't be, port/token can change across
  // boots — so re-derive it when this terminal drives a run.
  const drivesRun = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.terminalId, id))
    .get();
  if (drivesRun) {
    env.CLAUDE_STATION_URL = `http://127.0.0.1:${env_.port}`;
    env.CLAUDE_STATION_TOKEN = TOKEN;
  }

  const cwd = assertPathAllowed(existing.cwd, existing.projectId);
  try {
    const { pid } = pty.start({
      id,
      cwd,
      env,
      // App-agent terminals re-run their start command; claude tabs resume the CLI
      // by session id, so reopening one never lands in another's conversation.
      command:
        existing.command ??
        (existing.kind === "claude"
          ? claudeCommand(true, {
              projectId: existing.projectId,
              terminalId: id,
              cwd,
              sessionId: existing.claudeSessionId,
            })
          : undefined),
    });
    db.update(schema.terminals)
      .set({ status: "running", pid, closedAt: null })
      .where(eq(schema.terminals.id, id))
      .run();
    return true;
  } catch {
    return false;
  }
}

export function followOpenClaudeTerminals(): number {
  const rows = db
    .select()
    .from(schema.terminals)
    .where(eq(schema.terminals.kind, "claude"))
    .all()
    .filter((t) => t.claudeSessionId && t.status !== "exited");
  for (const row of rows) {
    follower.follow({
      claudeSessionId: row.claudeSessionId!,
      projectId: row.projectId,
      cwd: row.cwd,
      terminalId: row.id,
    });
  }
  return rows.length;
}

/** Closing a tab ends capture for it; a final drain keeps the last turn complete. */
export function stopFollowing(claudeSessionId: string | null, detail?: string): void {
  if (claudeSessionId) follower.unfollow(claudeSessionId, detail);
}
