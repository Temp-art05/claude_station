import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { projectMemoryInputSchema } from "@claude-station/shared";
import { badRequest } from "../lib/path-safety";
import { parsePatch } from "../lib/patch";
import {
  createMemory,
  deleteMemory,
  getMemory,
  importMemoryMarkdown,
  listMemories,
  updateMemory,
} from "../services/memory";

const idParam = z.object({ id: z.string() });

export function memoryRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/memory", async (req) => {
    const { id } = idParam.parse(req.params);
    return listMemories(id);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/memory", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = projectMemoryInputSchema.parse(req.body);
    reply.code(201);
    return createMemory(id, input);
  });

  /** Import a markdown note; the first `# heading` becomes the title. */
  app.post<{ Params: { id: string } }>("/api/projects/:id/memory/import", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const part = await (
      req as unknown as {
        file: (o?: { limits?: { fileSize?: number } }) => Promise<
          { filename: string; toBuffer(): Promise<Buffer> } | undefined
        >;
      }
    ).file({ limits: { fileSize: 4 * 1024 * 1024 } });
    if (!part) throw badRequest("No file in request");
    const memory = importMemoryMarkdown(id, part.filename, (await part.toBuffer()).toString("utf8"));
    reply.code(201);
    return memory;
  });

  app.patch<{ Params: { id: string } }>("/api/memory/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    return updateMemory(id, parsePatch(projectMemoryInputSchema, req.body));
  });

  app.delete<{ Params: { id: string } }>("/api/memory/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    deleteMemory(id);
    reply.code(204);
  });

  /** Plain-text export so notes can live in a repo too. */
  app.get<{ Params: { id: string } }>("/api/memory/:id/export", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const memory = getMemory(id);
    if (!memory) return reply.code(404).send({ error: "Memory not found" });
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${memory.title.replace(/[^\w.-]+/g, "-").slice(0, 60)}.md"`,
    );
    return `# ${memory.title}\n\n${memory.body}\n`;
  });
}
