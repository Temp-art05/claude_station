import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { pathCommandInputSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { shq } from "../lib/claude-cli";
import { setting } from "../lib/config";
import { newId } from "../lib/id";
import { openWith, writeLauncher } from "../lib/open-terminal";
import { parsePatch } from "../lib/patch";
import { badRequest } from "../lib/path-safety";
import { envVarsFor } from "../services/env-sets";
import {
  isRunActive,
  killRun,
  readLogSlice,
  resolveCommandTarget,
  startRun,
} from "../services/commands";

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

  /**
   * Hand a command to a real terminal window instead of running it here. Nothing
   * about this run is ours: no log, no timeout, no kill — that is the trade the
   * UI warns about, and the reason it stays a separate button from Run.
   */
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/commands/open-in-terminal",
    async (req) => {
      const { id: projectId } = idParam.parse(req.params);
      const body = z
        .object({
          commandId: z.string(),
          extraArgs: z.string().max(500).optional(),
          envSetId: z.string().nullable().optional(),
        })
        .parse(req.body ?? {});
      const { cmd, path, cwd } = resolveCommandTarget(body.commandId, projectId);
      const fullCommand = body.extraArgs ? `${cmd.command} ${body.extraArgs}` : cmd.command;

      // Same env resolution as startRun, CI=1 included: the point of this button is
      // reproducing the app's run by hand, not running something subtly different.
      const env = { ...envVarsFor(body.envSetId ?? path.envSetId), CI: "1" };
      const exports = Object.entries(env)
        .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .map(([k, v]) => `export ${k}=${shq(v)}`);

      const app_ = setting("terminal.app");
      const file = writeLauncher(`${cmd.name}-${cmd.id.slice(0, 8)}`, [
        `cd ${shq(cwd)}`,
        ...exports,
        `printf '$ %s\\n\\n' ${shq(fullCommand)}`,
        fullCommand,
        `printf '\\n[claude-station] exit %s — dropping into a shell\\n' "$?"`,
        // Keep the window: a build's output is worth reading after it finishes.
        'exec "${SHELL:-/bin/zsh}" -l',
      ]);
      await openWith(app_, file);
      return { opened: file, app: app_, command: fullCommand, cwd };
    },
  );

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
