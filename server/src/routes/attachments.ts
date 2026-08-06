import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { ATTACHMENTS_DIR } from "../lib/data-dir";
import { newId, nowIso } from "../lib/id";
import { assertPathAllowed, badRequest } from "../lib/path-safety";

const idParam = z.object({ id: z.string() });
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ATTACHMENT = 12 * 1024 * 1024;

export function attachmentRoutes(app: FastifyInstance): void {
  /** Screenshots and design mocks pasted into the composer. */
  app.post<{ Params: { id: string } }>("/api/sessions/:id/attachments", async (req, reply) => {
    const { id: sessionId } = idParam.parse(req.params);
    const session = db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, sessionId))
      .get();
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const part = await (
      req as unknown as {
        file: (o?: { limits?: { fileSize?: number } }) => Promise<
          { filename: string; mimetype: string; toBuffer(): Promise<Buffer> } | undefined
        >;
      }
    ).file({ limits: { fileSize: MAX_ATTACHMENT } });
    if (!part) throw badRequest("No file in request");

    const data = await part.toBuffer();
    const kind = IMAGE_MIME.has(part.mimetype) ? "image" : "file";
    const dir = join(ATTACHMENTS_DIR, sessionId);
    mkdirSync(dir, { recursive: true });
    const id = newId();
    const ext = extname(part.filename) || (kind === "image" ? ".png" : "");
    const storedPath = join(dir, `${id}${ext}`);
    writeFileSync(storedPath, data);

    const row = {
      id,
      sessionId,
      kind,
      mime: part.mimetype,
      storedPath,
      originalFilename: part.filename || `pasted${ext}`,
      createdAt: nowIso(),
    };
    db.insert(schema.chatAttachments).values(row).run();
    reply.code(201);
    return row;
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/attachments", async (req) => {
    const { id } = idParam.parse(req.params);
    return db
      .select()
      .from(schema.chatAttachments)
      .where(eq(schema.chatAttachments.sessionId, id))
      .orderBy(asc(schema.chatAttachments.createdAt))
      .all();
  });

  /** Open a file from a project path in the configured editor. */
  app.post("/api/open-in-ide", async (req) => {
    const { path, projectId } = z
      .object({ path: z.string().min(1), projectId: z.string().optional() })
      .parse(req.body);
    const safe = assertPathAllowed(path, projectId);
    const command = setting("ide.command").trim();
    if (!command) throw badRequest("No IDE command configured (Settings)");
    // Split so the setting can carry flags, e.g. `code -g`.
    const [bin, ...flags] = command.split(/\s+/);
    if (!bin) throw badRequest("Invalid IDE command");
    await new Promise<void>((resolve, reject) => {
      execFile(bin, [...flags, safe], (err) => (err ? reject(err) : resolve()));
    });
    return { opened: safe };
  });
}
