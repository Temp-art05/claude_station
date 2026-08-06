import type { FastifyInstance } from "fastify";
import { chatClientMsgSchema, type ChatServerMsg } from "@claude-station/shared";
import { assertWsAuthorized } from "../lib/auth";
import {
  interrupt,
  resolvePermission,
  sendUserMessage,
  subscribe,
} from "../services/claude-session";

export function chatWs(app: FastifyInstance): void {
  app.get<{ Params: { sessionId: string } }>(
    "/ws/chat/:sessionId",
    { websocket: true },
    (socket, req) => {
      assertWsAuthorized(req);
      const { sessionId } = req.params;

      const send = (msg: ChatServerMsg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const unsubscribe = subscribe(sessionId, send);

      socket.on("message", async (raw: Buffer) => {
        let parsed;
        try {
          parsed = chatClientMsgSchema.safeParse(JSON.parse(raw.toString("utf8") || "{}"));
        } catch {
          send({ t: "error", message: "Malformed message" });
          return;
        }
        if (!parsed.success) {
          send({ t: "error", message: "Unknown message shape" });
          return;
        }
        const msg = parsed.data;

        try {
          if (msg.t === "user_message") {
            // Fire and forget: progress arrives through the subscription.
            void sendUserMessage(sessionId, msg.text, msg.attachmentIds ?? []).catch((err: unknown) =>
              send({ t: "error", message: err instanceof Error ? err.message : String(err) }),
            );
          } else if (msg.t === "interrupt") {
            await interrupt(sessionId);
          } else if (msg.t === "permission_response") {
            const ok = resolvePermission(
              sessionId,
              msg.requestId,
              msg.behavior === "allow"
                ? { behavior: "allow", updatedInput: msg.updatedInput }
                : { behavior: "deny", message: msg.message ?? "Denied by the user." },
            );
            if (!ok) send({ t: "error", message: "That approval request already expired." });
          }
        } catch (err) {
          send({ t: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });

      socket.on("close", unsubscribe);
    },
  );
}
