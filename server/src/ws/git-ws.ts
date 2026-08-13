import type { FastifyInstance } from "fastify";
import { assertWsAuthorized } from "../lib/auth";
import { resolveTree } from "../services/git-paths";
import { isWatching, watchTree } from "../services/git-watch";

/**
 * "Something in this working tree moved" — nothing more. The client decides which
 * queries to refetch, so this stays cheap no matter how big the repo is.
 *
 * The first frame reports whether a real watcher came up: when it didn't (OS
 * limits, odd filesystem) the client keeps leaning on its slow poll instead of
 * silently going stale.
 */
export function gitWs(app: FastifyInstance): void {
  app.get<{ Params: { projectId: string }; Querystring: { pathId?: string; sessionId?: string } }>(
    "/ws/git/:projectId",
    { websocket: true },
    (socket, req) => {
      assertWsAuthorized(req);
      let cwd: string;
      try {
        cwd = resolveTree(req.params.projectId, req.query ?? {});
      } catch (err) {
        socket.send(
          JSON.stringify({ t: "error", message: err instanceof Error ? err.message : "bad path" }),
        );
        socket.close();
        return;
      }

      const detach = watchTree(cwd, () => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ t: "changed" }));
      });
      socket.send(JSON.stringify({ t: "ready", watching: isWatching(cwd) }));
      socket.on("close", detach);
      socket.on("error", detach);
    },
  );
}
