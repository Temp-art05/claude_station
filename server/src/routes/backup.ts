import { createReadStream, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { badRequest } from "../lib/path-safety";
import { exportArchive, exportFilename, importArchive } from "../services/backup";

/** Whole-app export/import — migrate the station between machines. */
export function backupRoutes(app: FastifyInstance): void {
  app.get("/api/export", async (_req, reply) => {
    const { archivePath, cleanup } = await exportArchive();
    const size = statSync(archivePath).size;
    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Length", size);
    reply.header("Content-Disposition", `attachment; filename="${exportFilename()}"`);
    const stream = createReadStream(archivePath);
    stream.on("close", cleanup);
    return reply.send(stream);
  });

  app.post("/api/import", async (req) => {
    const part = await (
      req as unknown as {
        file: (o?: { limits?: { fileSize?: number } }) => Promise<
          { filename: string; toBuffer(): Promise<Buffer> } | undefined
        >;
      }
    ).file({ limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
    if (!part) throw badRequest("No file in request");
    const result = importArchive(await part.toBuffer());
    return { ok: true, ...result };
  });
}
