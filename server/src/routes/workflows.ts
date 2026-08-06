import { createReadStream, existsSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  knowledgeFolderSchema,
  workflowInputSchema,
  workflowRunInputSchema,
} from "@claude-station/shared";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import {
  createWorkflow,
  deleteWorkflow,
  exportWorkflowYaml,
  getWorkflow,
  importWorkflowsToProject,
  importWorkflowYaml,
  listProjectWorkflows,
  listWorkflowFolders,
  listWorkflows,
  removeWorkflowFromProject,
  setWorkflowFolder,
  updateWorkflow,
} from "../services/workflows";
import {
  advanceRun,
  answerQuestions,
  cancelRun,
  createRun,
  deleteRun,
  getRun,
  listRuns,
  retryStep,
  skipStep,
} from "../services/workflow-runner";

const idParam = z.object({ id: z.string() });

export function workflowRoutes(app: FastifyInstance): void {
  // ── Library ───────────────────────────────────────────────────────────────
  app.get("/api/workflows", async (req) => {
    const { folder } = z.object({ folder: z.string().optional() }).parse(req.query ?? {});
    return listWorkflows(folder);
  });

  app.get("/api/workflows/folders", async () => listWorkflowFolders());

  app.post("/api/workflows", async (req, reply) => {
    const input = workflowInputSchema.parse(req.body);
    reply.code(201);
    return createWorkflow(input);
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const workflow = getWorkflow(id);
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });
    return workflow;
  });

  app.patch<{ Params: { id: string } }>("/api/workflows/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    return updateWorkflow(id, workflowInputSchema.parse(req.body));
  });

  app.delete<{ Params: { id: string } }>("/api/workflows/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    deleteWorkflow(id);
    reply.code(204);
  });

  app.put<{ Params: { id: string } }>("/api/workflows/:id/folder", async (req) => {
    const { id } = idParam.parse(req.params);
    const { folder } = z.object({ folder: knowledgeFolderSchema }).parse(req.body);
    setWorkflowFolder(id, folder);
    return { ok: true, folder };
  });

  app.post("/api/workflows/import", async (req, reply) => {
    const part = await (
      req as unknown as {
        file: (o?: { limits?: { fileSize?: number } }) => Promise<
          { filename: string; toBuffer(): Promise<Buffer> } | undefined
        >;
      }
    ).file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!part) throw badRequest("No file in request");
    reply.code(201);
    return importWorkflowYaml((await part.toBuffer()).toString("utf8"), part.filename);
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/export", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const workflow = getWorkflow(id);
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });
    reply.header("Content-Type", "text/yaml; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${workflow.name}.workflow.yaml"`);
    return exportWorkflowYaml(workflow);
  });

  // ── Per project ───────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/projects/:id/workflows", async (req) => {
    const { id } = idParam.parse(req.params);
    return listProjectWorkflows(id);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/workflows/import", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ workflowIds: z.array(z.string()).optional(), folder: z.string().optional() })
      .parse(req.body);
    if (body.folder === undefined && !body.workflowIds?.length) {
      throw badRequest("Pass workflowIds or a folder");
    }
    const imported = importWorkflowsToProject(id, body);
    return { imported, workflows: listProjectWorkflows(id) };
  });

  app.delete<{ Params: { id: string; workflowId: string } }>(
    "/api/projects/:id/workflows/:workflowId",
    async (req, reply) => {
      const { id, workflowId } = z
        .object({ id: z.string(), workflowId: z.string() })
        .parse(req.params);
      removeWorkflowFromProject(id, workflowId);
      reply.code(204);
    },
  );

  // ── Runs ──────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/projects/:id/workflow-runs", async (req) => {
    const { id } = idParam.parse(req.params);
    return listRuns(id);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/workflow-runs", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = workflowRunInputSchema.parse(req.body);
    const run = createRun(id, input);
    // Kick it off without blocking the response: progress arrives over the WS.
    void advanceRun(run.id).catch(() => {});
    reply.code(201);
    return run;
  });

  app.get<{ Params: { id: string } }>("/api/workflow-runs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const run = getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return run;
  });

  app.post<{ Params: { id: string } }>("/api/workflow-runs/:id/answer", async (req) => {
    const { id } = idParam.parse(req.params);
    const { answers } = z.object({ answers: z.record(z.string(), z.string()) }).parse(req.body);
    return answerQuestions(id, answers);
  });

  app.post<{ Params: { id: string } }>("/api/workflow-runs/:id/advance", async (req) => {
    const { id } = idParam.parse(req.params);
    return advanceRun(id);
  });

  app.post<{ Params: { id: string; key: string } }>(
    "/api/workflow-runs/:id/steps/:key/retry",
    async (req) => {
      const { id, key } = z.object({ id: z.string(), key: z.string() }).parse(req.params);
      return retryStep(id, key);
    },
  );

  app.post<{ Params: { id: string; key: string } }>(
    "/api/workflow-runs/:id/steps/:key/skip",
    async (req) => {
      const { id, key } = z.object({ id: z.string(), key: z.string() }).parse(req.params);
      return skipStep(id, key);
    },
  );

  app.post<{ Params: { id: string } }>("/api/workflow-runs/:id/cancel", async (req) => {
    const { id } = idParam.parse(req.params);
    return cancelRun(id);
  });

  app.delete<{ Params: { id: string } }>("/api/workflow-runs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    deleteRun(id);
    reply.code(204);
  });

  /** Download an artifact produced during a run. */
  app.get<{ Params: { id: string; artifactId: string } }>(
    "/api/workflow-runs/:id/artifacts/:artifactId",
    async (req, reply) => {
      const { id, artifactId } = z
        .object({ id: z.string(), artifactId: z.string() })
        .parse(req.params);
      const run = getRun(id);
      const artifact = run?.artifacts.find((a) => a.id === artifactId);
      if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
      const safe = assertPathAllowed(artifact.path, run!.projectId);
      if (!existsSync(safe) || statSync(safe).isDirectory()) {
        return reply.code(404).send({ error: "Artifact file missing on disk" });
      }
      reply.header("Content-Type", "text/plain; charset=utf-8");
      return reply.send(createReadStream(safe));
    },
  );
}
