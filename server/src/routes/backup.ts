import { createReadStream, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { badRequest } from "../lib/path-safety";
import { addArchive, exportArchive, exportFilename } from "../services/backup";

/** Library export/add — carry skills, agents, workflows… to another station. */
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

  app.post("/api/library/add", async (req) => {
    const part = await (
      req as unknown as {
        file: (o?: {
          limits?: { fileSize?: number };
        }) => Promise<{ filename: string; toBuffer(): Promise<Buffer> } | undefined>;
      }
    ).file({ limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
    if (!part) throw badRequest("No file in request");
    return addArchive(await part.toBuffer());
  });
}
