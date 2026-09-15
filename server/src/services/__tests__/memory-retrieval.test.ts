/**
 * A5a: finding a note by what it says, not by whether someone pinned it.
 *
 * The behaviour under test is the one the old prompt could not do — an unpinned
 * note reaching the prompt because it matches the message.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-retrieval-"));
process.env.CLAUDE_STATION_DATA = dataDir;

const { db, schema } = await import("../../db");
const search = await import("../search");
const memory = await import("../memory");
const { nowIso, newId } = await import("../../lib/id");

const PROJECT = "p-retrieval";

function note(title: string, body: string, opts: { pinned?: boolean; global?: boolean } = {}) {
  const id = newId();
  db.insert(schema.projectMemories)
    .values({
      id,
      projectId: opts.global ? null : PROJECT,
      title,
      body,
      tags: null,
      pinned: opts.pinned ?? false,
      source: "manual",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  return id;
}

beforeAll(() => {
  db.insert(schema.projects)
    .values({
      id: PROJECT,
      name: "Retrieval test",
      description: "",
      sortOrder: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  search.ensureSearchTables();
});

beforeEach(() => {
  db.delete(schema.projectMemories).run();
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("ftsQueryFrom", () => {
  it("quotes every term, so prose cannot be a syntax error", () => {
    // `-` and `"` are operators to FTS5; passing a sentence through unquoted is
    // an error on roughly every real message.
    // "fix" and "now" are stopwords here; what survives is quoted and OR-ed.
    expect(search.ftsQueryFrom('fix the git-watch "bug" today')).toBe(
      '"git" OR "watch" OR "bug" OR "today"',
    );
  });

  it("drops stopwords in both languages this repo is worked in", () => {
    expect(search.ftsQueryFrom("không được dùng cái này")).toBe('"dùng" OR "cái"');
  });

  it("is empty for a message with nothing to match on", () => {
    expect(search.ftsQueryFrom("ok?")).toBe("");
  });
});

describe("searchMemories", () => {
  it("finds an unpinned note by its words", () => {
    const id = note(
      "Worktree cho step song song",
      "Hai branch của cùng một run không dùng chung repo",
    );
    const hits = search.searchMemories(PROJECT, "step song song có dùng chung repo không");
    expect(hits.map((h) => h.id)).toContain(id);
  });

  it("leaves pinned notes out — the prompt already carries them whole", () => {
    note("Prettier", "chỉ format file mình chạm", { pinned: true });
    expect(search.searchMemories(PROJECT, "prettier format")).toHaveLength(0);
    expect(
      search.searchMemories(PROJECT, "prettier format", 4, { includePinned: true }).length,
    ).toBeGreaterThan(0);
  });

  it("finds a global note as readily as a project one", () => {
    const id = note("Plan trước, impl sau", "task lớn thì viết plan ra file", { global: true });
    expect(
      search.searchMemories(PROJECT, "có cần viết plan trước không").map((h) => h.id),
    ).toContain(id);
  });

  it("keeps another project's notes out", () => {
    const id = note("Chỉ của project này", "nội dung riêng của repo này");
    expect(
      search.searchMemories("another-project", "nội dung riêng của repo").map((h) => h.id),
    ).not.toContain(id);
  });

  it("follows an edit, because the index is trigger-kept", () => {
    const id = note("Ghi chú cũ", "chạy trên simulator");
    memory.updateMemory(id, { title: "Ghi chú mới", body: "chạy trên thiết bị thật" });
    expect(search.searchMemories(PROJECT, "simulator")).toHaveLength(0);
    expect(search.searchMemories(PROJECT, "thiết bị thật").map((h) => h.id)).toContain(id);
  });

  it("forgets a deleted note", () => {
    const id = note("Sẽ bị xoá", "một nội dung rất đặc biệt để tìm");
    memory.deleteMemory(id);
    expect(search.searchMemories(PROJECT, "nội dung rất đặc biệt")).toHaveLength(0);
  });
});

describe("the prompt section", () => {
  it("inlines a matching note that nobody pinned", () => {
    note("Bẫy của polling", "JQL không được siết, và phải có guard chống lặp");
    const withQuery = memory.memoryPromptSection(PROJECT, 8192, "polling bị lặp thì xử lý sao");
    expect(withQuery).toContain("Relevant to what you were just asked");
    expect(withQuery).toContain("guard chống lặp");
  });

  it("says nothing extra when there is no message to match against", () => {
    note("Bẫy của polling", "JQL không được siết");
    expect(memory.memoryPromptSection(PROJECT, 8192)).not.toContain("Relevant to what");
  });

  it("says nothing extra when nothing matches", () => {
    note("Bẫy của polling", "JQL không được siết");
    expect(memory.memoryPromptSection(PROJECT, 8192, "màu nút bấm trên iOS")).not.toContain(
      "Relevant to what",
    );
  });
});
