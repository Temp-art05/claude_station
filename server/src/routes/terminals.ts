import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { terminalInputSchema, terminalKindSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { TOKEN } from "../lib/auth";
import { env as config } from "../lib/config";
import { newId, nowIso } from "../lib/id";
import { assertPathAllowed } from "../lib/path-safety";
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
    return rows.map((t) =>
      t.status === "running" && !pty.isRunning(t.id) ? { ...t, status: "orphaned" as const } : t,
    );
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
    pty.kill(id);
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
      command:
        existing.command ??
        (existing.kind === "claude"
          ? claudeCommand(true, { projectId: existing.projectId, terminalId: id, cwd })
          : undefined),
    });
    db.update(schema.terminals)
      .set({ status: "running", pid, closedAt: null })
      .where(eq(schema.terminals.id, id))
      .run();
    return { ...existing, status: "running" as const, pid, closedAt: null };
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
