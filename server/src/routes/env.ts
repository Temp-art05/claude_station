import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { envSetInputSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { parsePatch } from "../lib/patch";
import { listEnvSets, loadEnvSet } from "../services/env-sets";

const idParam = z.object({ id: z.string() });

export function envRoutes(app: FastifyInstance): void {
  app.get("/api/env-sets", async (req) => {
    const { projectId } = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    return listEnvSets(projectId);
  });

  app.post("/api/env-sets", async (req, reply) => {
    const input = envSetInputSchema.parse(req.body);
    const id = newId();
    db.insert(schema.envSets)
      .values({
        id,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        createdAt: nowIso(),
      })
      .run();
    for (const v of input.vars) {
      db.insert(schema.envVars)
        .values({ id: newId(), envSetId: id, key: v.key, value: v.value, isSecret: v.isSecret })
        .run();
    }
    reply.code(201);
    return loadEnvSet(id);
  });

  app.patch<{ Params: { id: string } }>("/api/env-sets/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = parsePatch(envSetInputSchema, req.body);
    const existing = loadEnvSet(id);
    if (!existing) return reply.code(404).send({ error: "Env set not found" });
    db.update(schema.envSets)
      .set({
        name: input.name ?? existing.name,
        description: input.description ?? existing.description,
        projectId: input.projectId === undefined ? existing.projectId : input.projectId,
      })
      .where(eq(schema.envSets.id, id))
      .run();
    // Vars are edited as one list — replace wholesale when provided.
    if (input.vars) {
      db.delete(schema.envVars).where(eq(schema.envVars.envSetId, id)).run();
      for (const v of input.vars) {
        db.insert(schema.envVars)
          .values({ id: newId(), envSetId: id, key: v.key, value: v.value, isSecret: v.isSecret })
          .run();
      }
    }
    return loadEnvSet(id);
  });

  app.delete<{ Params: { id: string } }>("/api/env-sets/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    db.delete(schema.envSets).where(eq(schema.envSets.id, id)).run();
    reply.code(204);
  });
}
