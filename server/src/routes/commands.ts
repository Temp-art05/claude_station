import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { pathCommandInputSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { newId } from "../lib/id";
import { parsePatch } from "../lib/patch";
import { badRequest } from "../lib/path-safety";
import { isRunActive, killRun, readLogSlice, startRun } from "../services/commands";

const idParam = z.object({ id: z.string() });
const pathIdParam = z.object({ pathId: z.string() });
const cmdIdParam = z.object({ pathId: z.string(), commandId: z.string() });

export function commandRoutes(app: FastifyInstance): void {
  app.get<{ Params: { pathId: string } }>("/api/paths/:pathId/commands", async (req) => {
    const { pathId } = pathIdParam.parse(req.params);
    return db
      .select()
      .from(schema.pathCommands)
      .where(eq(schema.pathCommands.projectPathId, pathId))
      .orderBy(asc(schema.pathCommands.sortOrder))
      .all();
  });

  app.post<{ Params: { pathId: string } }>("/api/paths/:pathId/commands", async (req, reply) => {
    const { pathId } = pathIdParam.parse(req.params);
    const input = pathCommandInputSchema.parse(req.body);
    const path = db
      .select()
      .from(schema.projectPaths)
      .where(eq(schema.projectPaths.id, pathId))
      .get();
    if (!path) return reply.code(404).send({ error: "Path not found" });
    const count = db
      .select()
      .from(schema.pathCommands)
      .where(eq(schema.pathCommands.projectPathId, pathId))
      .all().length;
    const row = {
      id: newId(),
      projectPathId: pathId,
      name: input.name,
      kind: input.kind,
      command: input.command,
      cwdOverride: input.cwdOverride,
      timeoutSec: input.timeoutSec,
      sortOrder: count,
    };
    db.insert(schema.pathCommands).values(row).run();
    reply.code(201);
    return row;
  });

  app.patch<{ Params: { pathId: string; commandId: string } }>(
    "/api/paths/:pathId/commands/:commandId",
    async (req, reply) => {
      const { pathId, commandId } = cmdIdParam.parse(req.params);
      const input = parsePatch(pathCommandInputSchema, req.body);
      const existing = db
        .select()
        .from(schema.pathCommands)
        .where(
          and(eq(schema.pathCommands.id, commandId), eq(schema.pathCommands.projectPathId, pathId)),
        )
        .get();
      if (!existing) return reply.code(404).send({ error: "Command not found" });
      const merged = { ...existing, ...input };
      db.update(schema.pathCommands)
        .set({
          name: merged.name,
          kind: merged.kind,
          command: merged.command,
          cwdOverride: merged.cwdOverride ?? null,
          timeoutSec: merged.timeoutSec,
        })
        .where(eq(schema.pathCommands.id, commandId))
        .run();
      return merged;
    },
  );

  app.delete<{ Params: { pathId: string; commandId: string } }>(
    "/api/paths/:pathId/commands/:commandId",
    async (req, reply) => {
      const { pathId, commandId } = cmdIdParam.parse(req.params);
      db.delete(schema.pathCommands)
        .where(
          and(eq(schema.pathCommands.id, commandId), eq(schema.pathCommands.projectPathId, pathId)),
        )
        .run();
      reply.code(204);
    },
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/commands/run", async (req, reply) => {
    const { id: projectId } = idParam.parse(req.params);
    const body = z
      .object({
        commandId: z.string(),
        extraArgs: z.string().max(500).optional(),
        envSetId: z.string().nullable().optional(),
      })
      .parse(req.body);
    const { runId } = startRun({
      projectId,
      pathCommandId: body.commandId,
      origin: "ui",
      extraArgs: body.extraArgs,
      envSetId: body.envSetId ?? null,
    });
    reply.code(201);
    return { runId };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/command-runs", async (req) => {
    const { id } = idParam.parse(req.params);
    const { limit } = z.object({ limit: z.coerce.number().int().max(200).default(50) }).parse(
      req.query ?? {},
    );
    const rows = db
      .select()
      .from(schema.commandRuns)
      .where(eq(schema.commandRuns.projectId, id))
      .orderBy(desc(schema.commandRuns.startedAt))
      .limit(limit)
      .all();
    return rows.map((r) => ({ ...r, active: isRunActive(r.id) }));
  });

  app.get<{ Params: { id: string } }>("/api/command-runs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = db.select().from(schema.commandRuns).where(eq(schema.commandRuns.id, id)).get();
    if (!row) return reply.code(404).send({ error: "Run not found" });
    return { ...row, active: isRunActive(id) };
  });

  app.get<{ Params: { id: string } }>("/api/command-runs/:id/log", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { offset } = z.object({ offset: z.coerce.number().int().min(0).default(0) }).parse(
      req.query ?? {},
    );
    const row = db.select().from(schema.commandRuns).where(eq(schema.commandRuns.id, id)).get();
    if (!row) return reply.code(404).send({ error: "Run not found" });
    const { data, next } = readLogSlice(row.logPath, offset);
    return { data, next, active: isRunActive(id), exitCode: row.exitCode };
  });

  app.post<{ Params: { id: string } }>("/api/command-runs/:id/kill", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    if (!killRun(id)) throw badRequest("Run is not active");
    reply.code(202);
    return { ok: true };
  });

  /** Remove a run from history — an active one is stopped first (UI confirms). */
  app.delete<{ Params: { id: string } }>("/api/command-runs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = db.select().from(schema.commandRuns).where(eq(schema.commandRuns.id, id)).get();
    if (!row) return reply.code(404).send({ error: "Run not found" });
    if (isRunActive(id)) killRun(id);
    rmSync(row.logPath, { force: true });
    db.delete(schema.commandRuns).where(eq(schema.commandRuns.id, id)).run();
    reply.code(204);
  });
}
