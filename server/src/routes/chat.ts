import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { chatSessionInputSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { nowIso } from "../lib/id";
import { isRunning } from "../services/claude-session";
import { removeWorktree } from "../services/git";
import { createChatSession } from "../services/sessions";

const idParam = z.object({ id: z.string() });

export function chatRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/sessions", async (req) => {
    const { id } = idParam.parse(req.params);
    const rows = db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.projectId, id))
      .orderBy(desc(schema.chatSessions.updatedAt))
      .all();
    return rows.map((r) => ({ ...r, live: isRunning(r.id) }));
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/sessions", async (req, reply) => {
    const { id: projectId } = idParam.parse(req.params);
    const input = chatSessionInputSchema.parse(req.body ?? {});
    const row = createChatSession(projectId, input);
    reply.code(201);
    return { ...row, seedPrompt: input.seedPrompt ?? null };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, id)).get();
    if (!row) return reply.code(404).send({ error: "Session not found" });
    return { ...row, live: isRunning(id) };
  });

  app.patch<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const patch = z
      .object({
        title: z.string().min(1).optional(),
        archived: z.boolean().optional(),
        permissionMode: chatSessionInputSchema.shape.permissionMode.optional(),
        model: z.string().nullable().optional(),
      })
      .parse(req.body);
    const existing = db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, id))
      .get();
    if (!existing) return reply.code(404).send({ error: "Session not found" });

    // Archiving frees the worktree — it's a checkout, not history.
    if (patch.archived && existing.worktreePath) removeWorktree(existing.cwd, existing.worktreePath);

    db.update(schema.chatSessions)
      .set({
        title: patch.title ?? existing.title,
        archived: patch.archived ?? existing.archived,
        permissionMode: patch.permissionMode ?? existing.permissionMode,
        model: patch.model === undefined ? existing.model : patch.model,
        worktreePath: patch.archived ? null : existing.worktreePath,
        updatedAt: nowIso(),
      })
      .where(eq(schema.chatSessions.id, id))
      .run();
    return db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, id)).get();
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, id))
      .get();
    if (existing?.worktreePath) removeWorktree(existing.cwd, existing.worktreePath);
    db.delete(schema.chatSessions).where(eq(schema.chatSessions.id, id)).run();
    reply.code(204);
  });

  /** History is rendered from our own rows, so reconnects just ask for the tail. */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/messages", async (req) => {
    const { id } = idParam.parse(req.params);
    const { afterSeq, limit } = z
      .object({
        afterSeq: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().max(1000).default(400),
      })
      .parse(req.query ?? {});
    return db
      .select()
      .from(schema.chatMessages)
      .where(and(eq(schema.chatMessages.sessionId, id), gt(schema.chatMessages.seq, afterSeq)))
      .orderBy(asc(schema.chatMessages.seq))
      .limit(limit)
      .all();
  });
}
