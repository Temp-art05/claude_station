import { createReadStream, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  knowledgeFolderSchema,
  workflowInputSchema,
  workflowRunInputSchema,
  type FolderImportResult,
} from "@claude-station/shared";
import { TOKEN } from "../lib/auth";
import { env } from "../lib/config";
import { readSinglePart, readUploadParts } from "../lib/multipart";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { contentDisposition } from "../lib/zip";
import {
  createWorkflow,
  deleteWorkflow,
  exportWorkflowYaml,
  getWorkflow,
  importWorkflowsToProject,
  importWorkflowYaml,
  importWorkflowYamlDetailed,
  listProjectWorkflows,
  listWorkflowFolders,
  listWorkflows,
  removeWorkflowFromProject,
  renderWorkflowRunbook,
  setWorkflowFolder,
  updateWorkflow,
} from "../services/workflows";
import { createTerminal } from "../services/terminals";
import {
  advanceRun,
  answerQuestions,
  cancelRun,
  createRun,
  deleteRun,
  getRun,
  listRuns,
  reportTerminalProgress,
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
    const upload = await readSinglePart(req, 2 * 1024 * 1024);
    reply.code(201);
    return importWorkflowYaml(upload.data.toString("utf8"), upload.filename);
  });

  /** Batch import: every .yaml/.yml/.json in a dropped folder, one workflow each. */
  app.post("/api/workflows/import-folder", async (req, reply) => {
    const { files } = await readUploadParts(req, { maxFileSize: 2 * 1024 * 1024 });
    const results: FolderImportResult[] = [];
    for (const file of files) {
      if (!/\.(ya?ml|json)$/i.test(file.relPath)) {
        results.push({ file: file.relPath, status: "skipped" });
        continue;
      }
      try {
        const { workflow, renamedFrom } = importWorkflowYamlDetailed(
          file.data.toString("utf8"),
          basename(file.relPath),
        );
        results.push({
          file: file.relPath,
          status: renamedFrom ? "renamed" : "imported",
          name: workflow.name,
          id: workflow.id,
        });
      } catch (err) {
        results.push({
          file: file.relPath,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Always 201: the per-file statuses carry the outcome (incl. all-errors),
    // and the client renders them — a 400 would drop the detail on the floor.
    reply.code(201);
    return { results };
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/export", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const workflow = getWorkflow(id);
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });
    reply.header("Content-Type", "text/yaml; charset=utf-8");
    reply.header("Content-Disposition", contentDisposition(workflow.name, ".workflow.yaml"));
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

  /**
   * Dynamic mode: run the workflow INSIDE an interactive claude terminal that
   * sits under the run's stepper. The runbook is typed into the CLI (never
   * auto-sent); the session drives the steps and curls transitions back so the
   * stepper follows along.
   */
  app.post<{ Params: { id: string; workflowId: string } }>(
    "/api/projects/:id/workflows/:workflowId/terminal-run",
    async (req, reply) => {
      const { id, workflowId } = z.object({ id: z.string(), workflowId: z.string() }).parse(req.params);
      const { goal, cwdPathId, envSetId, useWorktree } = z
        .object({
          goal: z.string().max(4000).optional(),
          cwdPathId: z.string().optional(),
          envSetId: z.string().nullable().optional(),
          useWorktree: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      const workflow = getWorkflow(workflowId);
      if (!workflow) return reply.code(404).send({ error: "Workflow not found" });

      const terminal = createTerminal(id, {
        kind: "claude",
        title: `wf:${workflow.name}`,
        cwdPathId,
        envSetId: envSetId ?? null,
        useWorktree,
        // Lets the session report step transitions back to the stepper.
        extraEnv: {
          CLAUDE_STATION_URL: `http://127.0.0.1:${env.port}`,
          CLAUDE_STATION_TOKEN: TOKEN,
        },
      });
      const run = createRun(id, {
        workflowId,
        goal,
        cwdPathId,
        envSetId: envSetId ?? null,
        mode: "terminal",
        terminalId: terminal.id,
      });
      const seed = renderWorkflowRunbook(workflow, goal, { runId: run.id });
      reply.code(201);
      return { run, terminalId: terminal.id, seed };
    },
  );

  /** Terminal-mode runs report step transitions here (curl from the PTY). */
  app.post<{ Params: { id: string } }>(
    "/api/workflow-runs/:id/terminal-progress",
    async (req) => {
      const { id } = idParam.parse(req.params);
      const input = z
        .object({
          step: z.string().min(1),
          status: z.enum(["running", "done", "failed", "skipped"]),
          note: z.string().optional(),
        })
        .parse(req.body);
      return reportTerminalProgress(id, input);
    },
  );

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
