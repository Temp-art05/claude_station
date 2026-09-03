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

      // tmux sends its client setup once, when `tmux attach` starts — which is
      // when the *terminal* is created, with no tab connected yet. Nothing
      // replays it (a tmux-backed PTY deliberately keeps no byte log), so a tab
      // would spend its life on the normal buffer while tmux draws for the
      // alternate screen it believes the client entered. Absolute cursor moves
      // and erases then land against different semantics: cells that never
      // clear, rows a screenful behind, and no way back, because tmux only ever
      // sends the difference against the screen it thinks it painted.
      //
      // The alternate screen is the one piece of that setup a client cannot
      // recover on its own. The rest — scroll region, mouse and paste modes —
      // tmux re-sends with every redraw.
      if (pty.isTmuxBacked(id) && socket.readyState === socket.OPEN) {
        socket.send(Buffer.from("\x1b[?1049h", "ascii"));
      }

      // A tmux session starts drawing before any tab exists, at a size no tab
      // will ever have, and a frame drawn for 200x50 lands on rows a 215x32
      // emulator does not have. So those bytes are held back — but *held*, never
      // dropped: they can carry setup the program inside sent once. They go out
      // the moment the geometry is known, just ahead of the repaint that
      // corrects whatever they drew.
      let sized = !pty.isTmuxBacked(id);
      let held: Buffer[] = [];
      let heldBytes = 0;
      /** A tab that never reports a size must not grow this without bound. */
      const HELD_CAP = 1_000_000;
      const flushHeld = () => {
        const queued = held;
        held = [];
        heldBytes = 0;
        if (socket.readyState !== socket.OPEN) return;
        for (const chunk of queued) socket.send(chunk);
      };

      const detach = pty.attach(id, {
        // Raw PTY bytes go out as binary frames; JSON is reserved for control.
        onData: (chunk) => {
          if (!sized) {
            if (heldBytes + chunk.byteLength <= HELD_CAP) {
              held.push(chunk);
              heldBytes += chunk.byteLength;
            }
            return;
          }
          if (socket.readyState === socket.OPEN) socket.send(chunk);
        },
        onExit: (code) => {
          // A tmux-backed PTY is only a client of the session. If the session is
          // still there the process didn't die — we were detached (handoff to a
          // real terminal, `prefix d`, or another client stealing it), so the row
          // goes back to orphaned and Reattach brings it home.
          const detached = pty.sessionAlive(id);
          db.update(schema.terminals)
            .set(
              detached
                ? { status: "orphaned", pid: null }
                : { status: "exited", closedAt: nowIso(), pid: null },
            )
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
        else if (msg.t === "resize") {
          // *Every* size ends in a guaranteed frame, not just the first. "A real
          // size change redraws on its own" does not hold: a tab that reports
          // 90x29 while its panel is still animating, then 215x32 a moment
          // later, got nothing for the second one and stayed blank for good.
          if (!sized) {
            sized = true;
            flushHeld();
          }
          pty.resizeAndPaint(id, msg.cols, msg.rows);
        } else if (msg.t === "repaint") pty.repaint(id);
        else if (msg.t === "kill") pty.kill(id);
      });

      socket.on("close", detach);
    },
  );
}
