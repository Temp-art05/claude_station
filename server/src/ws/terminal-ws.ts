import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { terminalClientMsgSchema, type TerminalServerMsg } from "@claude-station/shared";
import { db, schema } from "../db";
import { assertWsAuthorized } from "../lib/auth";
import { nowIso } from "../lib/id";
import * as pty from "../services/pty-manager";

export function terminalWs(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    "/ws/terminal/:id",
    { websocket: true },
    (socket, req) => {
      assertWsAuthorized(req);
      const { id } = req.params;

      const send = (msg: TerminalServerMsg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };

      if (!pty.isRunning(id)) {
        send({ t: "error", message: "Terminal is not running (restart the terminal)" });
        socket.close();
        return;
      }

      const detach = pty.attach(id, {
        // Raw PTY bytes go out as binary frames; JSON is reserved for control.
        onData: (chunk) => {
          if (socket.readyState === socket.OPEN) socket.send(chunk);
        },
        onExit: (code) => {
          db.update(schema.terminals)
            .set({ status: "exited", closedAt: nowIso(), pid: null })
            .where(eq(schema.terminals.id, id))
            .run();
          send({ t: "exit", code });
          socket.close();
        },
      });

      socket.on("message", (raw: Buffer) => {
        const parsed = terminalClientMsgSchema.safeParse(
          JSON.parse(raw.toString("utf8") || "{}"),
        );
        if (!parsed.success) {
          send({ t: "error", message: "Malformed message" });
          return;
        }
        const msg = parsed.data;
        if (msg.t === "input") pty.write(id, msg.data);
        else if (msg.t === "resize") pty.resize(id, msg.cols, msg.rows);
        else if (msg.t === "kill") pty.kill(id);
      });

      socket.on("close", detach);
    },
  );
}
