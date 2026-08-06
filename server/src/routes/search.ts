import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reindexAllKnowledge, search } from "../services/search";

export function searchRoutes(app: FastifyInstance): void {
  app.get("/api/search", async (req) => {
    const { q, scope, limit } = z
      .object({
        q: z.string().min(1),
        scope: z.enum(["all", "chat", "knowledge"]).default("all"),
        limit: z.coerce.number().int().min(1).max(100).default(40),
      })
      .parse(req.query ?? {});
    return search(q, scope, limit);
  });

  app.post("/api/search/reindex", async () => ({ indexed: reindexAllKnowledge() }));
}
