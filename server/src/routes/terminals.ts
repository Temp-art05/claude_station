import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { terminalInputSchema, terminalKindSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { presetStatuses } from "../lib/agent-cli";
import { shq } from "../lib/claude-cli";
import {
  hasTranscript,
  removeTranscript,
  SESSION_ID,
  transcriptPath,
  transcriptsUnder,
} from "../lib/claude-transcript";
import { setting } from "../lib/config";
import { newId, nowIso } from "../lib/id";
import { openWith, writeLauncher } from "../lib/open-terminal";
import { assertPathAllowed } from "../lib/path-safety";
import * as tmux from "../lib/tmux";
import * as pty from "../services/pty-manager";
import {
  reviveTerminal,
  createTerminal,
  removeTerminalContext,
  stopFollowing,
} from "../services/terminals";

const idParam = z.object({ id: z.string() });

export function terminalRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/terminals", async (req) => {
    const { id } = idParam.parse(req.params);
    const { kind } = z.object({ kind: terminalKindSchema.optional() }).parse(req.query ?? {});
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
    // Keyed on tmux being *installed*, not on the setting: turning tmux off is
    // for new terminals, and reading the setting here would tell every session
    // created while it was on that its work is gone.
    const alive = pty.tmuxInstalled() ? pty.sessionAliveIds() : new Set<string>();
    return rows.map((t) => {
      const status =
        t.status === "running" && !pty.isRunning(t.id) ? ("orphaned" as const) : t.status;
      return { ...t, status, tmuxAlive: alive.has(t.id) };
    });
  });

  /** Which agent CLIs are on this machine, for the "new terminal" menu. */
  app.get("/api/agents/cli", async () => presetStatuses());

  /**
   * Everything anyone needs to say why a terminal did not start.
   *
   * The reports that arrive without this are all the same: "the agent tab is
   * just sitting there". A binary that is not on the server's PATH, an env set
   * with a wrong key, a CLI that printed its complaint and exited — all look
   * identical from the outside, and all are obvious in this blob.
   *
   * Nothing here is conversation content: the tail is the terminal's own output,
   * which the person is already looking at, and env values are named, never read.
   */
  app.get<{ Params: { id: string } }>("/api/terminals/:id/diagnostics", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = db.select().from(schema.terminals).where(eq(schema.terminals.id, id)).get();
    if (!row) return reply.code(404).send({ error: "No such terminal" });

    const envKeys = row.envSetId
      ? db
          .select({ key: schema.envVars.key, secret: schema.envVars.isSecret })
          .from(schema.envVars)
          .where(eq(schema.envVars.envSetId, row.envSetId))
          .all()
          .map((v) => `${v.key}${v.secret ? " (secret)" : ""}`)
      : [];

    const transcript = transcriptPath(row.claudeSessionId);

    const blob = [
      `terminal   ${row.id}  (${row.kind})`,
      `title      ${row.title}`,
      `status     ${row.status}${pty.isRunning(row.id) ? " — pty alive" : " — no pty"}`,
      `cwd        ${row.cwd}`,
      `command    ${row.command ?? "(login shell)"}`,
      `pid        ${row.pid ?? "none"}`,
      `tmux       ${pty.tmuxEnabled() ? (pty.tmuxInstalled() ? "on" : "on, but tmux is missing") : "off"}`,
      `env set    ${row.envSetId ?? "none"}${envKeys.length ? ` — ${envKeys.join(", ")}` : ""}`,
      `session    ${row.claudeSessionId ?? "n/a"}`,
      `transcript ${transcript ? `${transcript} ${existsSync(transcript) ? "(exists)" : "(not written yet)"}` : "n/a"}`,
      `created    ${row.createdAt}`,
      "",
      "--- last output ---",
      pty.recentOutput(row.id, 4000) || "(nothing captured)",
    ].join("\n");

    return { text: blob };
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
    // Drain once more before letting go, so the turn that was in flight is stored
    // with what it actually did.
    stopFollowing(existing?.claudeSessionId ?? null);
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
    // Same path the workflow runner takes before it types into a step's terminal:
    // one implementation, so a terminal revived by a run and one revived by this
    // button end up in the same state.
    if (!reviveTerminal(id)) {
      return reply.code(500).send({ error: "Could not restart this terminal" });
    }
    return db.select().from(schema.terminals).where(eq(schema.terminals.id, id)).get();
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
    // Size the window to the session *before* attaching — see windowSizeLine.
    const size = tmux.windowSize(id);
    const file = writeLauncher(`${existing.title}-${id.slice(0, 8)}`, [
      `cd ${shq(cwd)}`,
      ...(size ? [tmux.windowSizeLine(size)] : []),
      tmux.launcherLine(id),
    ]);
    await openWith(app_, file);
    // The new window's own attach paint is not reliable — see repaintOnAttach.
    tmux.repaintOnAttach(id);
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
   *
   * "Closed" covers orphaned rows too, as long as nothing is holding them: a row
   * left over from an earlier server process is finished work you may want to pick
   * up, not a live tab. The exception is an orphaned row whose tmux session is
   * still alive — that one is merely detached, and the tab bar owns it.
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
        and(
          eq(schema.terminals.projectId, id),
          inArray(schema.terminals.status, ["exited", "orphaned"]),
          ...(kind ? [eq(schema.terminals.kind, kind)] : []),
        ),
      )
      // An orphaned row never got a closedAt — it stopped being watched rather than
      // being closed — so order by whichever timestamp it does have.
      .orderBy(desc(sql`coalesce(${schema.terminals.closedAt}, ${schema.terminals.createdAt})`))
      .all();

    // Detached-but-alive rows belong to the tab bar, not here. Filtering happens
    // after the query and the limit after that, so dropping them can't make the
    // page come back short.
    const alive = pty.tmuxEnabled() ? pty.sessionAliveIds() : new Set<string>();
    return (
      rows
        .filter((t) => t.status === "exited" || !alive.has(t.id))
        .slice(0, limit)
        // Whether continuing will really resume, or just reopen in the same directory.
        .map((t) => ({ ...t, transcript: hasTranscript(t.claudeSessionId) }))
    );
  });

  /**
   * Conversations the `claude` CLI itself remembers for this project's directories —
   * including every session run from a real terminal, which the app has no row for.
   * Read straight off disk rather than from our DB; that is the whole point.
   */
  app.get<{ Params: { id: string } }>("/api/projects/:id/cli-sessions", async (req) => {
    const { id } = idParam.parse(req.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query ?? {});
    const paths = db
      .select()
      .from(schema.projectPaths)
      .where(eq(schema.projectPaths.projectId, id))
      .all()
      .map((p) => p.path);
    const found = transcriptsUnder(paths).slice(0, limit);
    // Which of them this app already owns, so the UI can say so instead of looking
    // like a duplicate of the section above it.
    const owned = new Set(
      db
        .select()
        .from(schema.terminals)
        .where(eq(schema.terminals.projectId, id))
        .all()
        .map((t) => t.claudeSessionId)
        .filter((sid): sid is string => sid !== null),
    );
    return found.map((t) => ({ ...t, adopted: owned.has(t.sessionId) }));
  });

  /**
   * Pick a CLI conversation up in the app: a new Claude tab takes that session id as
   * its own (`--resume`), so from here on it is an ordinary session of this app —
   * it shows in the list above and its transcript follows it when deleted.
   */
  app.post<{ Params: { id: string; sessionId: string } }>(
    "/api/projects/:id/cli-sessions/:sessionId/continue",
    async (req, reply) => {
      const { id: projectId, sessionId } = z
        .object({ id: z.string(), sessionId: z.string().regex(SESSION_ID) })
        .parse(req.params);
      const transcript = transcriptsUnder(
        db
          .select()
          .from(schema.projectPaths)
          .where(eq(schema.projectPaths.projectId, projectId))
          .all()
          .map((p) => p.path),
      ).find((t) => t.sessionId === sessionId);
      if (!transcript) {
        return reply
          .code(404)
          .send({ error: "No transcript for that session in this project's directories" });
      }
      const row = createTerminal(projectId, {
        kind: "claude",
        cwd: transcript.cwd,
        title: transcript.title.slice(0, 40),
        resumeSessionId: sessionId,
      });
      reply.code(201);
      return row;
    },
  );

  /**
   * Delete a CLI conversation from disk. No guard of any kind, by request: a session
   * still running in some other terminal loses its history mid-flight, which is why
   * the row shows when it was last written to.
   */
  app.delete<{ Params: { id: string; sessionId: string } }>(
    "/api/projects/:id/cli-sessions/:sessionId",
    async (req, reply) => {
      // Project-scoped like the two routes above: a transcript belongs to no project
      // on disk, but the work-history entry has to name the one you deleted it from.
      const { id: projectId, sessionId } = z
        .object({ id: z.string(), sessionId: z.string().regex(SESSION_ID) })
        .parse(req.params);
      if (!transcriptPath(sessionId)) {
        return reply.code(404).send({ error: "Transcript not found" });
      }
      removeTranscript(sessionId);
      db.insert(schema.workHistory)
        .values({
          id: newId(),
          projectId,
          kind: "cli_session_deleted",
          refId: sessionId,
          summary: `Deleted the CLI transcript ${sessionId}`,
          createdAt: nowIso(),
        })
        .run();
      reply.code(204);
    },
  );

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
    stopFollowing(existing.claudeSessionId, "history row and transcript deleted by the user");
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
