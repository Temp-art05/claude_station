import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { assertWsAuthorized } from "../lib/auth";
import { setting } from "../lib/config";
import { attachRun, tailLog } from "../services/commands";

/** Live build log: binary frames are raw output, JSON frames are control. */
export function commandWs(app: FastifyInstance): void {
  app.get<{ Params: { runId: string } }>(
    "/ws/command/:runId",
    { websocket: true },
    (socket, req) => {
      assertWsAuthorized(req);
      const { runId } = req.params;

      const detach = attachRun(runId, {
        onChunk: (chunk) => {
          if (socket.readyState === socket.OPEN) socket.send(chunk);
        },
        onExit: (code) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ t: "exit", code }));
          }
          socket.close();
        },
      });

      if (!detach) {
        // Already finished — replay the tail from disk, then close.
        const row = db
          .select()
          .from(schema.commandRuns)
          .where(eq(schema.commandRuns.id, runId))
          .get();
        if (row) {
          socket.send(Buffer.from(tailLog(row.logPath, setting("log.streamTailBytes")), "utf8"));
          socket.send(JSON.stringify({ t: "exit", code: row.exitCode }));
        } else {
          socket.send(JSON.stringify({ t: "error", message: "Run not found" }));
        }
        socket.close();
        return;
      }

      socket.on("close", detach);
    },
  );
}
