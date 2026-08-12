import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentInputSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { DATA_DIR } from "../lib/data-dir";
import { parsePatch } from "../lib/patch";
import { readSinglePart, readUploadParts, splitFolderRoot } from "../lib/multipart";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { contentDisposition } from "../lib/zip";
import * as pty from "../services/pty-manager";
import { createTerminal } from "../services/terminals";
import {
  createAgent,
  deleteAgent,
  exportAgentBundle,
  exportAgentMarkdown,
  getAgent,
  importAgentFolder,
  importAgentMarkdown,
  listAgents,
  setProjectAgent,
  updateAgent,
} from "../services/agents";

const idParam = z.object({ id: z.string() });

export function agentRoutes(app: FastifyInstance): void {
  app.get("/api/agents", async (req) => {
    const { projectId } = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    return listAgents(projectId);
  });

  app.post("/api/agents", async (req, reply) => {
    const input = agentInputSchema.parse(req.body);
    reply.code(201);
    return createAgent(input);
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const agent = getAgent(id);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    return agent;
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    return updateAgent(id, parsePatch(agentInputSchema, req.body));
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    deleteAgent(id);
    reply.code(204);
  });

  /** Per-project opt-in for agents that aren't global. */
  app.put<{ Params: { id: string } }>("/api/projects/:id/agents", async (req) => {
    const { id: projectId } = idParam.parse(req.params);
    const { agentId, enabled } = z
      .object({ agentId: z.string(), enabled: z.boolean() })
      .parse(req.body);
    setProjectAgent(projectId, agentId, enabled);
    return listAgents(projectId);
  });

  /** Import a Claude Code style `.md` (frontmatter + prompt). */
  app.post("/api/agents/import", async (req, reply) => {
    const upload = await readSinglePart(req, 2 * 1024 * 1024);
    const agent = importAgentMarkdown(upload.filename, upload.data.toString("utf8"));
    reply.code(201);
    return agent;
  });

  /**
   * Import a packaged agent: a folder with one definition .md at its root plus
   * companion files, which land in data/agents/<name> and are readable by the
   * agent's sessions.
   */
  app.post("/api/agents/import-folder", async (req, reply) => {
    const { files, fields } = await readUploadParts(req, { maxFileSize: 16 * 1024 * 1024 });
    const split = splitFolderRoot(files);
    const agent = importAgentFolder(fields.rootName || split.rootName, split.files);
    reply.code(201);
    return agent;
  });

  /**
   * Start an app agent: run its startCommand in a Station terminal at the
   * bundle dir (a real PTY, so stdin confirm prompts keep working). Idempotent —
   * an already-running terminal for this agent is returned instead of a second
   * copy of the app.
   */
  app.post<{ Params: { id: string } }>("/api/agents/:id/start", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { projectId, envSetId } = z
      .object({ projectId: z.string(), envSetId: z.string().nullable().optional() })
      .parse(req.body ?? {});
    const agent = getAgent(id);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    if (!agent.bundleDir || !agent.startCommand) {
      throw badRequest("This agent has no bundleDir/startCommand — import it as a folder first");
    }
    if (!existsSync(agent.bundleDir)) {
      throw badRequest(`Bundle dir missing on disk: ${agent.bundleDir}`);
    }

    const title = `agent:${agent.name}`;
    const existing = db
      .select()
      .from(schema.terminals)
      .where(
        and(eq(schema.terminals.projectId, projectId), eq(schema.terminals.title, title)),
      )
      .all()
      .find((t) => t.status === "running" && pty.isRunning(t.id));
    if (existing) return existing;

    const row = createTerminal(projectId, {
      title,
      cwd: agent.bundleDir,
      envSetId: envSetId ?? null,
      kind: "shell",
      command: agent.startCommand,
    });
    reply.code(201);
    return row;
  });

  /**
   * Custom UI for a "big" agent's workspace tab: an .html file under the data
   * dir, served here so the tab can iframe it. Path-guarded like any other file.
   */
  app.get<{ Params: { id: string } }>("/api/agents/:id/view", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const agent = getAgent(id);
    if (!agent?.viewPath) return reply.code(404).send({ error: "This agent has no custom view" });
    const target = isAbsolute(agent.viewPath)
      ? agent.viewPath
      : join(DATA_DIR, agent.viewPath);
    const safe = assertPathAllowed(target);
    if (!existsSync(safe)) return reply.code(404).send({ error: `View file missing: ${safe}` });
    reply.header("Content-Type", "text/html; charset=utf-8");
    return readFileSync(safe, "utf8");
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/export", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const agent = getAgent(id);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    // A packaged agent is its companions too — exporting only the definition
    // would silently drop the templates and scripts the prompt refers to.
    const bundle = await exportAgentBundle(agent);
    if (bundle) {
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", contentDisposition(agent.name, ".zip"));
      return reply.send(bundle);
    }
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", contentDisposition(agent.name, ".agent.md"));
    return exportAgentMarkdown(agent);
  });
}
