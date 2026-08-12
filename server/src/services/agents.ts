import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { and, asc, eq } from "drizzle-orm";
import matter from "gray-matter";
import type { Agent, AgentInput } from "@claude-station/shared";
import { db, schema } from "../db";
import { AGENTS_DIR } from "../lib/data-dir";
import { newId, nowIso } from "../lib/id";
import type { UploadedFile } from "../lib/multipart";
import { badRequest } from "../lib/path-safety";
import { dirEntries, zipEntries } from "../lib/zip";

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
    viewUrl: row.viewUrl,
    startCommand: row.startCommand,
    bundleDir: row.bundleDir,
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

export function createAgent(
  input: AgentInput,
  source: "manual" | "imported" = "manual",
  bundleDir: string | null = null,
): Agent {
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
      viewUrl: input.viewUrl,
      startCommand: input.startCommand,
      bundleDir,
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
      viewUrl: patch.viewUrl === undefined ? existing.viewUrl : patch.viewUrl,
      startCommand:
        patch.startCommand === undefined ? existing.startCommand : patch.startCommand,
      enabledGlobally: patch.enabledGlobally ?? existing.enabledGlobally,
      updatedAt: nowIso(),
    })
    .where(eq(schema.agents.id, id))
    .run();
  return getAgent(id)!;
}

export function deleteAgent(id: string): void {
  const row = db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
  // Companion files belong to the agent — but only remove what lives in our store.
  if (row?.bundleDir && isInsideAgentsDir(row.bundleDir)) {
    rmSync(row.bundleDir, { recursive: true, force: true });
  }
  db.delete(schema.agents).where(eq(schema.agents.id, id)).run();
}

function isInsideAgentsDir(path: string): boolean {
  const rel = relative(AGENTS_DIR, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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

/** Parse a Claude Code style agent file (frontmatter + prompt body) — pure. */
export function parseAgentMarkdown(filename: string, contents: string): AgentInput {
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

  return {
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
    viewUrl: typeof data.viewUrl === "string" && data.viewUrl.trim() ? data.viewUrl.trim() : null,
    startCommand:
      typeof data.startCommand === "string" && data.startCommand.trim()
        ? data.startCommand.trim()
        : null,
    enabledGlobally: false,
  };
}

/** Imports never fail on a name clash — they get a -2/-3 suffix instead. */
export function uniqueAgentName(base: string): string {
  const taken = new Set(db.select().from(schema.agents).all().map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Import a Claude Code style agent file: frontmatter + prompt body. */
export function importAgentMarkdown(filename: string, contents: string): Agent {
  const input = parseAgentMarkdown(filename, contents);
  return createAgent({ ...input, name: uniqueAgentName(input.name) }, "imported");
}

/**
 * A packaged agent: one definition .md at the folder root plus companion files
 * (templates, references, scripts). The companions land in data/agents/<name>
 * and the agent's sessions get Read access to that directory.
 */
export function importAgentFolder(rootName: string, files: UploadedFile[]): Agent {
  const isDefinition = (f: UploadedFile): boolean => {
    if (f.relPath.includes("/") || !/\.md$/i.test(f.relPath)) return false;
    try {
      const parsed = matter(f.data.toString("utf8"));
      const data = parsed.data as Record<string, unknown>;
      return (
        parsed.content.trim().length > 0 &&
        (typeof data.name === "string" || typeof data.description === "string")
      );
    } catch {
      return false;
    }
  };

  const candidates = files.filter(isDefinition);
  const preferred =
    candidates.find((f) => f.relPath.toLowerCase() === "agent.md") ??
    candidates.find((f) => f.relPath.toLowerCase() === `${rootName.toLowerCase()}.md`) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!preferred) {
    throw badRequest(
      candidates.length === 0
        ? "No agent definition found — the folder root needs a .md with frontmatter (name/description) and a prompt body"
        : "Multiple agent definition .md files at the folder root — keep exactly one, or name the right one agent.md",
    );
  }

  const input = parseAgentMarkdown(preferred.relPath, preferred.data.toString("utf8"));
  const name = uniqueAgentName(input.name);
  const companions = files.filter((f) => f !== preferred);

  let bundleDir: string | null = null;
  let prompt = input.prompt;
  if (companions.length > 0) {
    bundleDir = join(AGENTS_DIR, name);
    rmSync(bundleDir, { recursive: true, force: true }); // name is unique; dir is ours
    for (const file of companions) {
      const target = join(bundleDir, file.relPath);
      mkdirSync(dirname(target), { recursive: true });
      // Multipart drops file modes — scripts must stay runnable (start.sh & co).
      writeFileSync(target, file.data, { mode: /\.(sh|command)$/i.test(file.relPath) ? 0o755 : 0o644 });
    }
    // Read access alone isn't enough — the agent has to know where to look.
    prompt += `\n\n## Companion files\nThis agent's companion files are at: ${bundleDir}`;
  }

  return createAgent({ ...input, name, prompt }, "imported", bundleDir);
}

/** Bundle directories for the agents present in a session's options.agents. */
export function agentBundleDirs(names: string[]): string[] {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  return db
    .select()
    .from(schema.agents)
    .all()
    .filter((r) => wanted.has(r.name) && r.bundleDir && existsSync(r.bundleDir))
    .map((r) => r.bundleDir!);
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
  if (agent.viewUrl) front.push(`viewUrl: ${agent.viewUrl}`);
  if (agent.startCommand) front.push(`startCommand: ${JSON.stringify(agent.startCommand)}`);
  return `---\n${front.join("\n")}\n---\n\n${agent.prompt}\n`;
}

/**
 * The whole packaged agent, laid out exactly the way `importAgentFolder` expects
 * to read it back: the definition as `<name>.md` at the archive root, companions
 * beside it. Returns null when there are no companions — a lone definition is
 * better served as the plain .md it already was.
 */
export async function exportAgentBundle(agent: Agent): Promise<Buffer | null> {
  if (!agent.bundleDir || !existsSync(agent.bundleDir)) return null;
  const companions = dirEntries(agent.bundleDir);
  if (companions.length === 0) return null;
  return zipEntries([{ path: `${agent.name}.md`, data: exportAgentMarkdown(agent) }, ...companions]);
}
