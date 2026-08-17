import { and, asc, desc, eq, isNull, like, or } from "drizzle-orm";
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

/**
 * Built-in global notes, so a fresh install starts with the rule that lets Claude
 * judge how much process a task needs instead of asking every time.
 */
const SEEDED_GLOBAL_MEMORIES: ProjectMemoryInput[] = [
  {
    title: "plan-scope-rules",
    body: [
      "Task lớn, bug khó, refactor to → lên plan trước khi viết code, ghi plan ra `docs/plans/<feature>.md`.",
      "Task nhỏ và rõ ràng (sửa một hai chỗ, không đổi luồng) → làm thẳng, không cần plan.",
      "",
      "- Thay đổi so với plan: sửa plan trước, rồi mới sửa code — plan là single source of truth cho phạm vi.",
      "- File plan phải được gitignore, không commit vào repo.",
      "",
      "Vì sao: plan cho task nhỏ chỉ làm chậm; task lớn không có plan thì scope trôi và phải làm lại.",
    ].join("\n"),
    tags: ["workflow"],
    pinned: true,
  },
];

/**
 * Insert the built-in global notes, once each. Runs on every boot, so the marker
 * lives in app_settings rather than being inferred from the notes themselves —
 * otherwise deleting a seeded note would just bring it back next restart.
 * The key is not part of appSettingsSchema on purpose: zod strips it, so it stays
 * invisible to the settings UI.
 */
export function seedGlobalMemories(): void {
  for (const seed of SEEDED_GLOBAL_MEMORIES) {
    const key = `memory.seeded.${seed.title}`;
    const done = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get();
    if (done) continue;
    createMemory(null, seed);
    db.insert(schema.appSettings).values({ key, value: "true" }).run();
  }
}

/** Notes with no project: rules that hold in every workspace. */
export function listGlobalMemories(): ProjectMemory[] {
  return db
    .select()
    .from(schema.projectMemories)
    .where(isNull(schema.projectMemories.projectId))
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

/** Pass a null projectId to store a global note (applies to every project). */
export function createMemory(
  projectId: string | null,
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
  // work_history hangs off a project, so global notes get no history entry.
  if (projectId) {
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
  }
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
  const updated = getMemory(id)!;
  if (existing.projectId) {
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: existing.projectId,
        kind: "memory_updated",
        refId: id,
        summary: `Updated memory: ${updated.title}`,
        createdAt: nowIso(),
      })
      .run();
  }
  return updated;
}

export function deleteMemory(id: string): void {
  const existing = getMemory(id);
  db.delete(schema.projectMemories).where(eq(schema.projectMemories.id, id)).run();
  if (existing?.projectId) {
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

/**
 * Search this project's notes plus the global ones. The project filter is part of
 * the query rather than applied afterwards, so `limit` counts matches in scope
 * instead of being spent on other projects' notes.
 */
export function searchMemories(projectId: string, query: string, limit = 20): ProjectMemory[] {
  const term = `%${query.trim()}%`;
  if (!query.trim()) return [];
  return db
    .select()
    .from(schema.projectMemories)
    .where(
      and(
        or(
          eq(schema.projectMemories.projectId, projectId),
          isNull(schema.projectMemories.projectId),
        ),
        or(like(schema.projectMemories.title, term), like(schema.projectMemories.body, term)),
      ),
    )
    .limit(limit)
    .all()
    .map(toMemory);
}

/**
 * Import a markdown file as one memory. The first `# heading` becomes the title
 * so exported notes round-trip; otherwise the filename is used.
 */
export function importMemoryMarkdown(
  projectId: string | null,
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
 * Renders one group of notes: pinned ones whole, the rest as titles. `budget`
 * is shared across groups and mutated, so a big global note can't be inlined at
 * the expense of the project's own.
 */
function renderGroup(
  heading: string,
  memories: ProjectMemory[],
  emptyLine: string,
  budget: { left: number },
): string[] {
  const parts = [heading];
  if (memories.length === 0) return [...parts, "", emptyLine];

  for (const m of memories.filter((x) => x.pinned)) {
    const block = `\n### ${m.title}\n${m.body}`;
    if (block.length > budget.left) {
      parts.push(`\n### ${m.title}\n(too long to inline — read it with memory_get)`);
      continue;
    }
    budget.left -= block.length;
    parts.push(block);
  }

  const rest = memories.filter((m) => !m.pinned);
  if (rest.length > 0) {
    parts.push(
      "",
      "Also available (read with the memory_get tool when relevant):",
      ...rest.map((m) => `- ${m.title}${m.tags?.length ? ` [${m.tags.join(", ")}]` : ""}`),
    );
  }
  return parts;
}

/**
 * When to write a note. This is the whole reason memory fills up on its own:
 * without it a session sees the notes it can read and never infers that writing
 * one is its job, so every project stays empty until the user asks by hand.
 * Static text, and deliberately outside the byte cap — a truncated policy is the
 * same as no policy.
 */
const CAPTURE_POLICY = `## Saving to memory

Keep this store current as you work — don't wait to be asked. Write a note when:

- the user corrects how you work, or rejects an approach
- an architectural or process decision gets settled
- you find a convention of this project that the code doesn't state
- a gotcha costs you real time (skip the ones you shrug off)

Don't write: logs of what you did, anything already readable from the code, git
history or CLAUDE.md, or things only true for this one session.

Before writing, memory_search for the same idea — if it exists, memory_update it
instead of adding a near-duplicate. Keep notes short and durable, and say *why*,
so a later session applies them for the right reason. Save at the moment you
learn something, not at the end of the session — sessions get closed mid-work.

Use scope "global" for a rule that holds in every project; otherwise it belongs
to this one. Pin only what every session needs.`;

/**
 * The memory block appended to a session's system prompt: global rules, this
 * project's notes, then the capture policy. Pinned memories go in whole; the
 * rest are titles only, so a big memory bank can't crowd out the conversation —
 * Claude pulls those with memory_get when it needs them.
 */
export function memoryPromptSection(projectId: string, capBytes: number): string {
  const budget = { left: capBytes };
  return [
    ...renderGroup(
      "## Global memory (every project)",
      listGlobalMemories(),
      "None yet — save one with scope \"global\" when you learn a rule that holds everywhere.",
      budget,
    ),
    "",
    ...renderGroup(
      "## Project memory",
      listMemories(projectId),
      "Nothing saved for this project yet — write the first note when this project teaches you something.",
      budget,
    ),
    "",
    CAPTURE_POLICY,
  ].join("\n");
}
