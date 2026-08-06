import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { knowledgeFolderSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { readSinglePart, readUploadParts, splitFolderRoot } from "../lib/multipart";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { deleteKnowledge, importFile, importFolder, importSkill } from "../services/knowledge";
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
    const upload = await readSinglePart(req, MAX_UPLOAD);
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

  /**
   * A whole dropped directory as one knowledge item. Each part's filename is
   * the file's path relative to the folder root. A global folder with a root
   * SKILL.md imports as a packaged skill instead.
   */
  app.post("/api/knowledge/folder", async (req, reply) => {
    const { projectId, folder } = z
      .object({ projectId: z.string().optional(), folder: knowledgeFolderSchema.optional() })
      .parse(req.query ?? {});
    const { files, fields } = await readUploadParts(req, { maxFileSize: MAX_UPLOAD });
    const split = splitFolderRoot(files);
    const rootName = fields.rootName || split.rootName;
    const row = importFolder({
      projectId: projectId ?? null,
      rootName,
      files: split.files,
      description: fields.description,
      folder,
    });
    reindexKnowledge(row.id);
    reply.code(201);
    return row.kind === "skill" ? { ...row, linkState: skillLinkState(row.name) } : row;
  });

  app.post("/api/knowledge/skills/import", async (req, reply) => {
    const { folder } = z.object({ folder: knowledgeFolderSchema.optional() }).parse(req.query ?? {});
    const upload = await readSinglePart(req, MAX_UPLOAD);
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
    if (!existsSync(safe)) {
      return reply.code(404).send({ error: "File missing on disk" });
    }
    if (statSync(safe).isDirectory()) {
      return reply
        .code(400)
        .send({ error: "This item is a folder — browse it in the data directory" });
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
