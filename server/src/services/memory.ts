import { asc, desc, eq, like, or } from "drizzle-orm";
import type { ProjectMemory, ProjectMemoryInput } from "@claude-station/shared";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";

type Row = typeof schema.projectMemories.$inferSelect;

function toMemory(row: Row): ProjectMemory {
  let tags: string[] | null = null;
  if (row.tags) {
    try {
      const parsed = JSON.parse(row.tags) as unknown;
      tags = Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      tags = null;
    }
  }
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    tags,
    pinned: row.pinned,
    source: row.source === "imported" ? "imported" : row.source === "claude" ? "claude" : "manual",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listMemories(projectId: string): ProjectMemory[] {
  return db
    .select()
    .from(schema.projectMemories)
    .where(eq(schema.projectMemories.projectId, projectId))
    .orderBy(desc(schema.projectMemories.pinned), asc(schema.projectMemories.title))
    .all()
    .map(toMemory);
}

export function getMemory(id: string): ProjectMemory | null {
  const row = db
    .select()
    .from(schema.projectMemories)
    .where(eq(schema.projectMemories.id, id))
    .get();
  return row ? toMemory(row) : null;
}

export function createMemory(
  projectId: string,
  input: ProjectMemoryInput,
  source: "manual" | "imported" | "claude" = "manual",
): ProjectMemory {
  const now = nowIso();
  const id = newId();
  db.insert(schema.projectMemories)
    .values({
      id,
      projectId,
      title: input.title.trim(),
      body: input.body.trim(),
      tags: input.tags?.length ? JSON.stringify(input.tags) : null,
      pinned: input.pinned,
      source,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.workHistory)
    .values({
      id: newId(),
      projectId,
      kind: "memory_added",
      refId: id,
      summary: `${source === "claude" ? "Claude remembered" : "Added memory"}: ${input.title}`,
      createdAt: now,
    })
    .run();
  return getMemory(id)!;
}

export function updateMemory(id: string, patch: Partial<ProjectMemoryInput>): ProjectMemory {
  const existing = db
    .select()
    .from(schema.projectMemories)
    .where(eq(schema.projectMemories.id, id))
    .get();
  if (!existing) throw badRequest("Memory not found");
  db.update(schema.projectMemories)
    .set({
      title: patch.title?.trim() ?? existing.title,
      body: patch.body?.trim() ?? existing.body,
      tags:
        patch.tags === undefined
          ? existing.tags
          : patch.tags?.length
            ? JSON.stringify(patch.tags)
            : null,
      pinned: patch.pinned ?? existing.pinned,
      updatedAt: nowIso(),
    })
    .where(eq(schema.projectMemories.id, id))
    .run();
  return getMemory(id)!;
}

export function deleteMemory(id: string): void {
  const existing = getMemory(id);
  db.delete(schema.projectMemories).where(eq(schema.projectMemories.id, id)).run();
  if (existing) {
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: existing.projectId,
        kind: "memory_deleted",
        refId: id,
        summary: `Deleted memory: ${existing.title}`,
        createdAt: nowIso(),
      })
      .run();
  }
}

export function searchMemories(projectId: string, query: string, limit = 20): ProjectMemory[] {
  const term = `%${query.trim()}%`;
  if (!query.trim()) return [];
  return db
    .select()
    .from(schema.projectMemories)
    .where(
      or(like(schema.projectMemories.title, term), like(schema.projectMemories.body, term)),
    )
    .limit(limit)
    .all()
    .filter((r) => r.projectId === projectId)
    .map(toMemory);
}

/**
 * Import a markdown file as one memory. The first `# heading` becomes the title
 * so exported notes round-trip; otherwise the filename is used.
 */
export function importMemoryMarkdown(
  projectId: string,
  filename: string,
  contents: string,
): ProjectMemory {
  const lines = contents.split("\n");
  const headingIndex = lines.findIndex((l) => /^#\s+\S/.test(l));
  const title =
    headingIndex >= 0
      ? lines[headingIndex]!.replace(/^#\s+/, "").trim()
      : filename.replace(/\.(md|markdown|txt)$/i, "").trim();
  const body =
    headingIndex >= 0 ? lines.slice(headingIndex + 1).join("\n").trim() : contents.trim();
  if (!body) throw badRequest("The file has no content below its heading");
  return createMemory(projectId, { title, body, tags: null, pinned: false }, "imported");
}

/**
 * The memory block appended to a session's system prompt. Pinned memories go in
 * whole; the rest are titles only, so a big memory bank can't crowd out the
 * conversation — Claude pulls those with memory_get when it needs them.
 */
export function memoryPromptSection(projectId: string, capBytes: number): string {
  const memories = listMemories(projectId);
  if (memories.length === 0) return "";

  const pinned = memories.filter((m) => m.pinned);
  const rest = memories.filter((m) => !m.pinned);
  const parts: string[] = ["## Project memory"];

  let used = 0;
  for (const m of pinned) {
    const block = `\n### ${m.title}\n${m.body}`;
    if (used + block.length > capBytes) {
      parts.push(`\n### ${m.title}\n(too long to inline — read it with memory_get)`);
      continue;
    }
    used += block.length;
    parts.push(block);
  }

  if (rest.length > 0) {
    parts.push(
      "",
      "Also available (read with the memory_get tool when relevant):",
      ...rest.map((m) => `- ${m.title}${m.tags?.length ? ` [${m.tags.join(", ")}]` : ""}`),
    );
  }
  return parts.join("\n");
}
