import type { FastifyInstance } from "fastify";
import { assertWsAuthorized } from "../lib/auth";
import { getRun, subscribeRun, type RunEvent } from "../services/workflow-runner";

/** Live run progress: step transitions, new questions, artifacts. */
export function workflowWs(app: FastifyInstance): void {
  app.get<{ Params: { runId: string } }>(
    "/ws/workflow-run/:runId",
    { websocket: true },
    (socket, req) => {
      assertWsAuthorized(req);
      const { runId } = req.params;

      const send = (event: RunEvent) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      };

      const run = getRun(runId);
      if (!run) {
        send({ t: "error", message: "Run not found" });
        socket.close();
        return;
      }

      // Replay current state so a reconnect doesn't need a separate fetch.
      send({ t: "status", status: run.status, currentStepKey: run.currentStepKey });
      for (const step of run.runSteps) send({ t: "step", step });
      const open = run.questions.filter((q) => q.answer === null);
      if (open.length > 0) send({ t: "question", questions: open });

      const unsubscribe = subscribeRun(runId, send);
      socket.on("close", unsubscribe);
    },
  );
}
