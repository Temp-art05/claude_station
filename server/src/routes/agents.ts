import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentInputSchema } from "@claude-station/shared";
import { DATA_DIR } from "../lib/data-dir";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import {
  createAgent,
  deleteAgent,
  exportAgentMarkdown,
  getAgent,
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
    return updateAgent(id, agentInputSchema.partial().parse(req.body));
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
    const part = await (
      req as unknown as {
        file: (o?: { limits?: { fileSize?: number } }) => Promise<
          { filename: string; toBuffer(): Promise<Buffer> } | undefined
        >;
      }
    ).file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!part) throw badRequest("No file in request");
    const agent = importAgentMarkdown(part.filename, (await part.toBuffer()).toString("utf8"));
    reply.code(201);
    return agent;
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
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${agent.name}.agent.md"`);
    return exportAgentMarkdown(agent);
  });
}
