import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { knowledgeFolderSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { deleteKnowledge, importFile, importSkill } from "../services/knowledge";
import {
  attachFolder,
  attachItems,
  detachItem,
  listFolders,
  listLibrary,
  listProjectKnowledge,
  setFolder,
} from "../services/library";
import { reindexKnowledge } from "../services/search";
import { skillLinkState } from "../services/skills";

const idParam = z.object({ id: z.string() });
const MAX_UPLOAD = 64 * 1024 * 1024;

/** Read a multipart upload into memory — imports are documents, not videos. */
async function readUpload(req: {
  file: (opts?: { limits?: { fileSize?: number } }) => Promise<
    { filename: string; toBuffer(): Promise<Buffer>; fields: Record<string, unknown> } | undefined
  >;
}) {
  const part = await req.file({ limits: { fileSize: MAX_UPLOAD } });
  if (!part) throw badRequest("No file in request");
  const data = await part.toBuffer();
  const field = part.fields.description as { value?: unknown } | undefined;
  const description = typeof field?.value === "string" ? field.value : "";
  return { filename: part.filename, data, description };
}

export function knowledgeRoutes(app: FastifyInstance): void {
  app.get("/api/knowledge", async (req) => {
    const { projectId, folder } = z
      .object({ projectId: z.string().optional(), folder: z.string().optional() })
      .parse(req.query ?? {});
    // With a project: its own uploads + attached library assets. Without: the library.
    return projectId ? listProjectKnowledge(projectId) : listLibrary(folder);
  });

  /** Folder list with counts — drives the library sidebar and the attach dialog. */
  app.get("/api/knowledge/folders", async () => listFolders());

  app.put<{ Params: { id: string } }>("/api/knowledge/:id/folder", async (req) => {
    const { id } = idParam.parse(req.params);
    const { folder } = z.object({ folder: knowledgeFolderSchema }).parse(req.body);
    setFolder(id, folder);
    return { ok: true, folder };
  });

  /** Attach library assets to a project — by folder, or a hand-picked list. */
  app.post<{ Params: { id: string } }>("/api/projects/:id/knowledge/attach", async (req) => {
    const { id: projectId } = idParam.parse(req.params);
    const body = z
      .object({ folder: z.string().optional(), itemIds: z.array(z.string()).optional() })
      .parse(req.body);
    if (body.folder === undefined && !body.itemIds?.length) {
      throw badRequest("Pass a folder or itemIds");
    }
    const attached =
      body.folder !== undefined
        ? attachFolder(projectId, body.folder)
        : attachItems(projectId, body.itemIds ?? []);
    return { attached, items: listProjectKnowledge(projectId) };
  });

  app.delete<{ Params: { id: string; itemId: string } }>(
    "/api/projects/:id/knowledge/:itemId",
    async (req, reply) => {
      const { id, itemId } = z.object({ id: z.string(), itemId: z.string() }).parse(req.params);
      detachItem(id, itemId);
      reply.code(204);
    },
  );

  app.post("/api/knowledge", async (req, reply) => {
    const { projectId, kind, folder } = z
      .object({
        projectId: z.string().optional(),
        kind: z.enum(["doc", "excel"]).optional(),
        folder: knowledgeFolderSchema.optional(),
      })
      .parse(req.query ?? {});
    const upload = await readUpload(req as never);
    const row = importFile({
      projectId: projectId ?? null,
      filename: upload.filename,
      description: upload.description,
      data: upload.data,
      folder,
      kind,
    });
    reindexKnowledge(row.id);
    reply.code(201);
    return row;
  });

  app.post("/api/knowledge/skills/import", async (req, reply) => {
    const { folder } = z.object({ folder: knowledgeFolderSchema.optional() }).parse(req.query ?? {});
    const upload = await readUpload(req as never);
    if (extname(upload.filename).toLowerCase() !== ".md") {
      throw badRequest("A skill is a SKILL.md markdown file");
    }
    const row = importSkill({
      filename: upload.filename,
      data: upload.data,
      description: upload.description,
      folder,
    });
    reindexKnowledge(row.id);
    reply.code(201);
    return { ...row, linkState: skillLinkState(row.name) };
  });

  app.delete<{ Params: { id: string } }>("/api/knowledge/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    deleteKnowledge(id);
    reply.code(204);
  });

  /** Raw file download — used by the UI preview and to grab generated reports. */
  app.get<{ Params: { id: string } }>("/api/knowledge/:id/file", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { sheet } = z.object({ sheet: z.string().optional() }).parse(req.query ?? {});
    const row = db
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, id))
      .get();
    if (!row) return reply.code(404).send({ error: "Not found" });

    // A parsed sheet is served from the .parsed dir next to the original.
    const target = sheet && row.parsedPath ? join(row.parsedPath, `${sheet}.csv`) : row.storedPath;
    const safe = assertPathAllowed(target);
    if (!existsSync(safe) || statSync(safe).isDirectory()) {
      return reply.code(404).send({ error: "File missing on disk" });
    }
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `inline; filename="${row.originalFilename}"`);
    return reply.send(createReadStream(safe));
  });

  /** Sheet index for the xlsx preview. */
  app.get<{ Params: { id: string } }>("/api/knowledge/:id/sheets", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = db
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, id))
      .get();
    if (!row?.parsedPath) return reply.code(404).send({ error: "No parsed copy" });
    const metaPath = join(row.parsedPath, "meta.json");
    if (!existsSync(metaPath)) return reply.code(404).send({ error: "No parsed copy" });
    return JSON.parse(readFileSync(metaPath, "utf8"));
  });
}
