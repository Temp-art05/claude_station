import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { and, asc, eq } from "drizzle-orm";
import matter from "gray-matter";
import type { Agent, AgentInput } from "@claude-station/shared";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";

type Row = typeof schema.agents.$inferSelect;

function parseList(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

function toAgent(row: Row): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    tools: parseList(row.tools),
    disallowedTools: parseList(row.disallowedTools),
    skills: parseList(row.skills),
    model: row.model,
    maxTurns: row.maxTurns,
    background: row.background,
    viewPath: row.viewPath,
    enabledGlobally: row.enabledGlobally,
    source: row.source === "imported" ? "imported" : "manual",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const encode = (list: string[] | null) => (list && list.length > 0 ? JSON.stringify(list) : null);

export function listAgents(projectId?: string): Agent[] {
  const rows = db.select().from(schema.agents).orderBy(asc(schema.agents.name)).all();
  if (!projectId) return rows.map(toAgent);

  const enabled = new Set(
    db
      .select()
      .from(schema.projectAgents)
      .where(eq(schema.projectAgents.projectId, projectId))
      .all()
      .map((r) => r.agentId),
  );
  return rows.map((row) => ({
    ...toAgent(row),
    enabledForProject: row.enabledGlobally || enabled.has(row.id),
  }));
}

export function getAgent(id: string): Agent | null {
  const row = db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
  return row ? toAgent(row) : null;
}

export function createAgent(input: AgentInput, source: "manual" | "imported" = "manual"): Agent {
  const clash = db.select().from(schema.agents).where(eq(schema.agents.name, input.name)).get();
  if (clash) throw badRequest(`An agent named "${input.name}" already exists`);

  const now = nowIso();
  const id = newId();
  db.insert(schema.agents)
    .values({
      id,
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      tools: encode(input.tools),
      disallowedTools: encode(input.disallowedTools),
      skills: encode(input.skills),
      model: input.model === "inherit" ? null : input.model,
      maxTurns: input.maxTurns,
      background: input.background,
      viewPath: input.viewPath,
      enabledGlobally: input.enabledGlobally,
      source,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getAgent(id)!;
}

export function updateAgent(id: string, patch: Partial<AgentInput>): Agent {
  const existing = db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
  if (!existing) throw badRequest("Agent not found");

  if (patch.name && patch.name !== existing.name) {
    const clash = db.select().from(schema.agents).where(eq(schema.agents.name, patch.name)).get();
    if (clash) throw badRequest(`An agent named "${patch.name}" already exists`);
  }

  db.update(schema.agents)
    .set({
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      prompt: patch.prompt ?? existing.prompt,
      tools: patch.tools === undefined ? existing.tools : encode(patch.tools),
      disallowedTools:
        patch.disallowedTools === undefined
          ? existing.disallowedTools
          : encode(patch.disallowedTools),
      skills: patch.skills === undefined ? existing.skills : encode(patch.skills),
      model:
        patch.model === undefined
          ? existing.model
          : patch.model === "inherit"
            ? null
            : patch.model,
      maxTurns: patch.maxTurns === undefined ? existing.maxTurns : patch.maxTurns,
      background: patch.background ?? existing.background,
      viewPath: patch.viewPath === undefined ? existing.viewPath : patch.viewPath,
      enabledGlobally: patch.enabledGlobally ?? existing.enabledGlobally,
      updatedAt: nowIso(),
    })
    .where(eq(schema.agents.id, id))
    .run();
  return getAgent(id)!;
}

export function deleteAgent(id: string): void {
  db.delete(schema.agents).where(eq(schema.agents.id, id)).run();
}

export function setProjectAgent(projectId: string, agentId: string, enabled: boolean): void {
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!agent) throw badRequest("Agent not found");
  if (agent.enabledGlobally) {
    throw badRequest(
      "This agent is enabled globally — turn that off first if you want per-project control",
    );
  }

  const existing = db
    .select()
    .from(schema.projectAgents)
    .where(
      and(eq(schema.projectAgents.projectId, projectId), eq(schema.projectAgents.agentId, agentId)),
    )
    .get();

  if (enabled && !existing) {
    db.insert(schema.projectAgents).values({ id: newId(), projectId, agentId }).run();
  } else if (!enabled && existing) {
    db.delete(schema.projectAgents).where(eq(schema.projectAgents.id, existing.id)).run();
  }
}

/** One agent by name, regardless of enablement — used for agent workspaces. */
export function agentDefinition(name: string): AgentDefinition | null {
  const row = db.select().from(schema.agents).where(eq(schema.agents.name, name)).get();
  if (!row) return null;
  return toDefinition(toAgent(row));
}

function toDefinition(agent: Agent): AgentDefinition {
  return {
    description: agent.description,
    prompt: agent.prompt,
    ...(agent.tools?.length ? { tools: agent.tools } : {}),
    ...(agent.disallowedTools?.length ? { disallowedTools: agent.disallowedTools } : {}),
    ...(agent.skills?.length ? { skills: agent.skills } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
    ...(agent.background ? { background: true } : {}),
  };
}

/**
 * What actually reaches `options.agents` for a session: globally enabled agents
 * plus this project's opt-ins, keyed by the name Claude delegates to.
 */
export function agentsForProject(projectId: string): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  for (const agent of listAgents(projectId)) {
    if (!agent.enabledForProject) continue;
    out[agent.name] = toDefinition(agent);
  }
  return out;
}

/** Import a Claude Code style agent file: frontmatter + prompt body. */
export function importAgentMarkdown(filename: string, contents: string): Agent {
  const parsed = matter(contents);
  const data = parsed.data as Record<string, unknown>;

  const fallbackName = filename
    .replace(/\.(agent\.)?md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : fallbackName;

  const asList = (value: unknown): string[] | null => {
    if (typeof value === "string") {
      const items = value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      return items.length ? items : null;
    }
    if (Array.isArray(value)) return value.map(String);
    return null;
  };

  if (!parsed.content.trim()) throw badRequest("The file has no prompt body below the frontmatter");

  return createAgent(
    {
      name,
      description:
        typeof data.description === "string" && data.description.trim()
          ? data.description.trim()
          : `Imported from ${filename}`,
      prompt: parsed.content.trim(),
      tools: asList(data.tools),
      disallowedTools: asList(data.disallowedTools ?? data["disallowed-tools"]),
      skills: asList(data.skills),
      model: typeof data.model === "string" ? data.model : null,
      maxTurns: typeof data.maxTurns === "number" ? data.maxTurns : null,
      background: data.background === true,
      viewPath: typeof data.viewPath === "string" ? data.viewPath : null,
      enabledGlobally: false,
    },
    "imported",
  );
}

/** Round-trips back to the same format, so agents stay portable. */
export function exportAgentMarkdown(agent: Agent): string {
  const front: string[] = [`name: ${agent.name}`, `description: ${JSON.stringify(agent.description)}`];
  if (agent.tools?.length) front.push(`tools: ${agent.tools.join(", ")}`);
  if (agent.disallowedTools?.length) front.push(`disallowedTools: ${agent.disallowedTools.join(", ")}`);
  if (agent.skills?.length) front.push(`skills: ${agent.skills.join(", ")}`);
  if (agent.model) front.push(`model: ${agent.model}`);
  if (agent.maxTurns) front.push(`maxTurns: ${agent.maxTurns}`);
  if (agent.background) front.push("background: true");
  return `---\n${front.join("\n")}\n---\n\n${agent.prompt}\n`;
}
