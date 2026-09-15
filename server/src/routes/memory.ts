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
  listGlobalMemories,
  listMemories,
  updateMemory,
} from "../services/memory";
import { clearProject, cursorOf, eventsOf, lastSeqOf, stateOf } from "../services/shared-memory";

const idParam = z.object({ id: z.string() });

/** Pulls the uploaded file out of a multipart request, or fails loudly. */
async function uploadedFile(req: unknown): Promise<{ filename: string; body: string }> {
  const part = await (
    req as {
      file: (o?: {
        limits?: { fileSize?: number };
      }) => Promise<{ filename: string; toBuffer(): Promise<Buffer> } | undefined>;
    }
  ).file({ limits: { fileSize: 4 * 1024 * 1024 } });
  if (!part) throw badRequest("No file in request");
  return { filename: part.filename, body: (await part.toBuffer()).toString("utf8") };
}

export function memoryRoutes(app: FastifyInstance): void {
  // ── Global notes (no project) ──────────────────────────────────────────────
  // Registered before /api/memory/:id so "global" isn't parsed as an id.
  app.get("/api/memory/global", async () => listGlobalMemories());

  app.post("/api/memory/global", async (req, reply) => {
    const input = projectMemoryInputSchema.parse(req.body);
    reply.code(201);
    return createMemory(null, input);
  });

  app.post("/api/memory/global/import", async (req, reply) => {
    const { filename, body } = await uploadedFile(req);
    reply.code(201);
    return importMemoryMarkdown(null, filename, body);
  });

  /**
   * The shared-memory bus for one project: the folded state, and the log behind it.
   *
   * Reading here never advances a cursor — only building a turn's prompt block
   * does. A tab that moved someone's cursor by being open would quietly cost that
   * session the context it had not been shown yet.
   */
  app.get<{ Params: { id: string } }>("/api/projects/:id/memory/bus", async (req) => {
    const { id } = idParam.parse(req.params);
    const query = z.object({ sessionKey: z.string().optional() }).parse(req.query ?? {});
    const head = lastSeqOf(id);
    return {
      state: stateOf(id),
      events: eventsOf(id),
      lastSeq: head,
      // For a terminal, which cannot be injected into mid-conversation: how far
      // behind it is, so the UI can offer to hand it the difference.
      pending: query.sessionKey ? Math.max(head - cursorOf(query.sessionKey), 0) : 0,
    };
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id/memory/bus", async (req) => {
    const { id } = idParam.parse(req.params);
    return { removed: clearProject(id) };
  });

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
    const { filename, body } = await uploadedFile(req);
    reply.code(201);
    return importMemoryMarkdown(id, filename, body);
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
