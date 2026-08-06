import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { terminalInputSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { envVarsFor } from "../services/env-sets";
import * as pty from "../services/pty-manager";

const idParam = z.object({ id: z.string() });

function resolveCwd(projectId: string, input: { cwdPathId?: string; cwd?: string }): string {
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

export function terminalRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/terminals", async (req) => {
    const { id } = idParam.parse(req.params);
    const rows = db
      .select()
      .from(schema.terminals)
      .where(eq(schema.terminals.projectId, id))
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

    const cwd = resolveCwd(projectId, input);
    const id = newId();
    const env = input.envSetId ? envVarsFor(input.envSetId) : {};
    const { pid } = pty.start({ id, cwd, env });

    const count = db
      .select()
      .from(schema.terminals)
      .where(eq(schema.terminals.projectId, projectId))
      .all().length;

    const row = {
      id,
      projectId,
      title: input.title ?? `Terminal ${count + 1}`,
      cwd,
      envSetId: input.envSetId ?? null,
      pid,
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
    const env = existing.envSetId ? envVarsFor(existing.envSetId) : {};
    const cwd = assertPathAllowed(existing.cwd, existing.projectId);
    const { pid } = pty.start({ id, cwd, env });
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
