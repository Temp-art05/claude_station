import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { terminalInputSchema, terminalKindSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { TOKEN } from "../lib/auth";
import { shq } from "../lib/claude-cli";
import { hasTranscript, removeTranscript } from "../lib/claude-transcript";
import { env as config, setting } from "../lib/config";
import { newId, nowIso } from "../lib/id";
import { openWith, writeLauncher } from "../lib/open-terminal";
import { assertPathAllowed } from "../lib/path-safety";
import * as tmux from "../lib/tmux";
import { envVarsFor } from "../services/env-sets";
import * as pty from "../services/pty-manager";
import { claudeCommand, createTerminal, removeTerminalContext } from "../services/terminals";

const idParam = z.object({ id: z.string() });

export function terminalRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/terminals", async (req) => {
    const { id } = idParam.parse(req.params);
    const { kind } = z
      .object({ kind: terminalKindSchema.optional() })
      .parse(req.query ?? {});
    const rows = db
      .select()
      .from(schema.terminals)
      .where(
        kind
          ? and(eq(schema.terminals.projectId, id), eq(schema.terminals.kind, kind))
          : eq(schema.terminals.projectId, id),
      )
      .orderBy(asc(schema.terminals.createdAt))
      .all();
    // Reconcile with reality: a row marked running whose PTY is gone is orphaned.
    // `tmuxAlive` splits the two flavours of orphaned: the work is still running
    // in tmux (Reattach gets it back) versus the output is genuinely gone.
    const alive = pty.tmuxEnabled() ? pty.sessionAliveIds() : new Set<string>();
    return rows.map((t) => {
      const status = t.status === "running" && !pty.isRunning(t.id) ? ("orphaned" as const) : t.status;
      return { ...t, status, tmuxAlive: alive.has(t.id) };
    });
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/terminals", async (req, reply) => {
    const { id: projectId } = idParam.parse(req.params);
    const input = terminalInputSchema.parse(req.body ?? {});
    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get();
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const row = createTerminal(projectId, input);
    reply.code(201);
    return row;
  });

  app.patch<{ Params: { id: string } }>("/api/terminals/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { title } = z.object({ title: z.string().min(1) }).parse(req.body);
    const existing = db.select().from(schema.terminals).where(eq(schema.terminals.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Terminal not found" });
    db.update(schema.terminals).set({ title }).where(eq(schema.terminals.id, id)).run();
    return { ...existing, title };
  });

  app.delete<{ Params: { id: string } }>("/api/terminals/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = db.select().from(schema.terminals).where(eq(schema.terminals.id, id)).get();
    // Closing a tab means the work is over — tear the tmux session down too, or a
    // detached `claude` would keep running with nothing pointing at it.
    pty.killSession(id);
    removeTerminalContext(id);
    db.update(schema.terminals)
      .set({ status: "exited", closedAt: nowIso(), pid: null })
      .where(eq(schema.terminals.id, id))
      .run();
    if (existing) {
      db.insert(schema.workHistory)
        .values({
          id: newId(),
          projectId: existing.projectId,
          kind: "terminal_killed",
          refId: id,
          summary: `Killed ${existing.title}`,
          createdAt: nowIso(),
        })
        .run();
    }
    reply.code(204);
  });

  /** Restart an orphaned terminal row in-place (same tab, fresh shell). */
  app.post<{ Params: { id: string } }>("/api/terminals/:id/restart", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = db.select().from(schema.terminals).where(eq(schema.terminals.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Terminal not found" });
    if (pty.isRunning(id)) return existing;
    const env: Record<string, string> = existing.envSetId ? envVarsFor(existing.envSetId) : {};
    // Terminal-mode workflow runs curl step progress back with these two vars.
    // extraEnv is never persisted — and shouldn't be, port/token can change
    // across boots — so re-derive it when this terminal drives a run.
    const drivesRun = db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.terminalId, id))
      .get();
    if (drivesRun) {
      env.CLAUDE_STATION_URL = `http://127.0.0.1:${config.port}`;
      env.CLAUDE_STATION_TOKEN = TOKEN;
    }
    const cwd = assertPathAllowed(existing.cwd, existing.projectId);
    const { pid } = pty.start({
      id,
      cwd,
      env,
      // App-agent terminals re-run their start command; claude tabs resume the CLI.
      // The workspace context is rebuilt here, not reused: paths may have been added
      // or relabelled since this tab was first opened.
      // With tmux this command is only used when the session is really gone —
      // pty.start reattaches a live session instead and ignores it. Resuming goes
      // by session id, so continuing one closed tab never lands in another's
      // conversation the way `claude --continue` would.
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
    return { ...existing, status: "running" as const, pid, closedAt: null };
  });

  /**
   * Hand this terminal to a real terminal window: the launcher attaches to the very
   * same tmux session (`-d`, so it steals the client), which is why the `claude`
   * conversation carries on instead of starting over.
   */
  app.post<{ Params: { id: string } }>("/api/terminals/:id/export", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = db.select().from(schema.terminals).where(eq(schema.terminals.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Terminal not found" });
    if (!pty.tmuxEnabled()) {
      return reply.code(400).send({
        error: tmux.available()
          ? "Handing a terminal over needs tmux (Settings → Run terminals inside tmux)"
          : `tmux is not installed — ${tmux.probe().detail}`,
      });
    }
    if (!pty.sessionAlive(id)) {
      return reply.code(409).send({
        error:
          "This terminal has no tmux session — it was opened before tmux was on. Restart it, then hand it over.",
      });
    }

    const cwd = assertPathAllowed(existing.cwd, existing.projectId);
    const app_ = setting("terminal.app");
    const file = writeLauncher(`${existing.title}-${id.slice(0, 8)}`, [
      `cd ${shq(cwd)}`,
      tmux.launcherLine(id),
    ]);
    await openWith(app_, file);
    // `attach -d` already steals the client; killing ours makes the moment the tab
    // goes orphaned deterministic instead of racing the new window.
    pty.kill(id);
    db.update(schema.terminals)
      .set({ status: "orphaned", pid: null })
      .where(eq(schema.terminals.id, id))
      .run();
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: existing.projectId,
        kind: "terminal_exported",
        refId: id,
        summary: `Handed ${existing.title} to ${app_}`,
        createdAt: nowIso(),
      })
      .run();
    return { opened: file, session: tmux.sessionName(id), app: app_ };
  });

  /**
   * Closed sessions, newest first. Separate from the live list on purpose: that one
   * is polled while terminals run, and a long-lived project accumulates hundreds of
   * closed rows.
   */
  app.get<{ Params: { id: string } }>("/api/projects/:id/terminal-history", async (req) => {
    const { id } = idParam.parse(req.params);
    const { kind, limit } = z
      .object({
        kind: terminalKindSchema.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});
    const rows = db
      .select()
      .from(schema.terminals)
      .where(
        kind
          ? and(
              eq(schema.terminals.projectId, id),
              eq(schema.terminals.status, "exited"),
              eq(schema.terminals.kind, kind),
            )
          : and(eq(schema.terminals.projectId, id), eq(schema.terminals.status, "exited")),
      )
      .orderBy(desc(schema.terminals.closedAt))
      .limit(limit)
      .all();
    // Whether continuing will really resume, or just reopen in the same directory.
    return rows.map((t) => ({ ...t, transcript: hasTranscript(t.claudeSessionId) }));
  });

  /**
   * Forget a closed session for good: the row, its workspace-context file, and the
   * CLI's own transcript. No confirmation anywhere in the stack — the UI asks for
   * none either, so this is deliberately irreversible.
   */
  app.delete<{ Params: { id: string } }>("/api/terminals/:id/record", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = db.select().from(schema.terminals).where(eq(schema.terminals.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Terminal not found" });
    if (pty.isRunning(id) || pty.sessionAlive(id)) {
      return reply
        .code(409)
        .send({ error: "This session is still running — close it before deleting its history" });
    }
    removeTerminalContext(id);
    const transcript = removeTranscript(existing.claudeSessionId);
    db.delete(schema.terminals).where(eq(schema.terminals.id, id)).run();
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: existing.projectId,
        kind: "terminal_record_deleted",
        refId: id,
        summary: `Deleted ${existing.title} from history${transcript ? " (with its transcript)" : ""}`,
        createdAt: nowIso(),
      })
      .run();
    reply.code(204);
  });

  /** Boot reconciliation: rows left "running" from a previous process are orphaned. */
  app.addHook("onReady", async () => {
    const stale = db
      .select()
      .from(schema.terminals)
      .where(and(eq(schema.terminals.status, "running")))
      .all();
    for (const t of stale) {
      if (!pty.isRunning(t.id)) {
        db.update(schema.terminals)
          .set({ status: "orphaned", pid: null })
          .where(eq(schema.terminals.id, t.id))
          .run();
      }
    }
  });
}
