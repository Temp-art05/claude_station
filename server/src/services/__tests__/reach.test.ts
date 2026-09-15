/**
 * Reach: which project a directory belongs to, and what the generated commands
 * actually tell Claude Code.
 *
 * The command text is worth testing because it is the part nobody reads again:
 * a wrong `disable-model-invocation` line silently turns a context dump into
 * something the model pulls in on every turn, and an unencoded argument turns a
 * topic containing `&` into a broken request.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-reach-"));
process.env.CLAUDE_STATION_DATA = dataDir;

const { db, schema } = await import("../../db");
const reach = await import("../reach");
const skills = await import("../reach-skills");
const { newId, nowIso } = await import("../../lib/id");

const OUTER = "/tmp/cs-reach/outer";
const INNER = "/tmp/cs-reach/outer/packages/app";

beforeAll(() => {
  db.insert(schema.projects)
    .values({
      id: "p-outer",
      name: "Outer",
      description: "",
      sortOrder: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  db.insert(schema.projects)
    .values({
      id: "p-inner",
      name: "Inner",
      description: "",
      sortOrder: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  for (const [projectId, path, label] of [
    ["p-outer", OUTER, "outer"],
    ["p-inner", INNER, "inner"],
  ] as const) {
    db.insert(schema.projectPaths)
      .values({
        id: newId(),
        projectId,
        path,
        label,
        description: "",
        isDefault: true,
        sortOrder: 0,
      })
      .run();
  }
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("projectForCwd", () => {
  it("takes the innermost repo when they nest", () => {
    // A monorepo whose subdirectory is its own project is a real shape here, and
    // the inner one is the answer — the same rule the ledger uses for files.
    expect(reach.projectForCwd(INNER)?.projectId).toBe("p-inner");
    expect(reach.projectForCwd(`${INNER}/src/deep`)?.projectId).toBe("p-inner");
    expect(reach.projectForCwd(`${OUTER}/docs`)?.projectId).toBe("p-outer");
  });

  it("answers null outside every configured path, rather than guessing the nearest", () => {
    // Guessing would answer questions about the wrong repo with full confidence,
    // which is worse than answering none.
    expect(reach.projectForCwd("/tmp/somewhere-else")).toBeNull();
  });
});

describe("resolve", () => {
  it("says so plainly when the directory belongs to no project", async () => {
    const out = await reach.resolve({ kind: "overview", cwd: "/tmp/nowhere" });
    expect(out.text).toContain("not inside any project");
    expect(out.text).toContain("/tmp/nowhere");
  });

  it("names the known kinds when asked for one that does not exist", async () => {
    const out = await reach.resolve({ kind: "nonsense", cwd: OUTER });
    expect(out.text).toContain("Unknown Reach kind");
    expect(out.text).toContain("overview");
  });

  it("caps a long answer and says it was cut", async () => {
    const out = await reach.resolve({ kind: "overview", cwd: OUTER, limit: 300 });
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("cut at 300 bytes");
  });
});

describe("the generated commands", () => {
  const byName = (name: string) => skills.REACH_COMMANDS.find((c) => c.name === name)!;

  it("lets the model call the lookups and not the context dumps", () => {
    // This split is the feature, not a detail: a lookup is a sense the agent can
    // use unprompted; a dump it pulls in by itself is just spent tokens.
    for (const name of ["reach-file", "reach-why", "reach-fail", "reach-kb", "reach-cmds"]) {
      expect(skills.skillMarkdown(byName(name))).not.toContain("disable-model-invocation");
    }
    for (const name of ["reach", "reach-plan", "reach-last", "reach-ticket", "reach-sprint"]) {
      expect(skills.skillMarkdown(byName(name))).toContain("disable-model-invocation: true");
    }
  });

  it("encodes every argument instead of pasting it into the URL", () => {
    // A topic with a space, an `&` or a quote in it would otherwise break the
    // request or run as shell — the most injection-prone line in the feature.
    const body = skills.skillMarkdown(byName("reach-why"));
    expect(body).toContain('--data-urlencode "q=$topic"');
    expect(body).not.toMatch(/resolve\?[^"]*\$/);
  });

  it("never lets a dead station abort the invocation", () => {
    // A non-zero exit from the injected shell cancels the whole skill, so the
    // station being down has to degrade to a sentence.
    for (const command of skills.REACH_COMMANDS) {
      expect(skills.skillMarkdown(command)).toContain("|| echo");
    }
  });

  it("posts the one command that writes, and gets the rest", () => {
    expect(skills.skillMarkdown(byName("reach-note"))).toContain("/api/reach/note");
    expect(skills.skillMarkdown(byName("reach-note"))).not.toContain("--get");
    expect(skills.skillMarkdown(byName("reach-why"))).toContain("--get");
  });

  it("declares the tool it needs, so no approval modal blocks it", () => {
    expect(skills.skillMarkdown(byName("reach"))).toContain("allowed-tools: Bash(curl *)");
  });

  it("gives every command a description that says when to use it", () => {
    // The description is the only thing the model sees before deciding to call a
    // skill; "returns data" teaches it nothing.
    for (const command of skills.REACH_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(40);
    }
  });
});

describe("the .station mirror", () => {
  it("links what exists on disk and copies what lives in a row", async () => {
    // Knowledge is a file already; a second copy of a spec is one too many.
    // Plans and memory are rows, and a path cannot point at a row.
    const { existsSync, lstatSync, mkdirSync, writeFileSync } = await import("node:fs");
    const repo = join(dataDir, "repo");
    mkdirSync(repo, { recursive: true });
    db.insert(schema.projects)
      .values({
        id: "p-mirror",
        name: "Mirror",
        description: "",
        sortOrder: 2,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    db.insert(schema.projectPaths)
      .values({
        id: newId(),
        projectId: "p-mirror",
        path: repo,
        label: "mirror",
        description: "",
        isDefault: true,
        sortOrder: 0,
      })
      .run();

    const docPath = join(dataDir, "a-spec.md");
    writeFileSync(docPath, "# spec", "utf8");
    db.insert(schema.knowledgeItems)
      .values({
        id: newId(),
        projectId: "p-mirror",
        kind: "doc",
        name: "A Spec",
        description: "",
        folder: "",
        originalFilename: "a-spec.md",
        storedPath: docPath,
        parsedPath: null,
        sizeBytes: 6,
        createdAt: nowIso(),
      })
      .run();
    db.insert(schema.projectMemories)
      .values({
        id: newId(),
        projectId: "p-mirror",
        title: "Quy tắc Prettier",
        body: "chỉ format file mình chạm",
        tags: null,
        pinned: false,
        source: "manual",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();

    const mirror = await import("../reach-mirror");
    const out = mirror.buildMirror("p-mirror", repo);
    expect(out.knowledge).toBe(1);
    expect(out.memory).toBeGreaterThanOrEqual(1);

    expect(lstatSync(join(repo, ".station/knowledge/a-spec.md")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(repo, ".station/memory/quy-tac-prettier.md"))).toBe(true);
    // A README, because a directory that appears in someone's repo has to say
    // what put it there.
    expect(existsSync(join(repo, ".station/README.md"))).toBe(true);
  });

  it("rebuilds rather than reconciles, so a deleted source leaves no dead link", async () => {
    const { existsSync, rmSync } = await import("node:fs");
    const mirror = await import("../reach-mirror");
    const repo = join(dataDir, "repo");

    db.delete(schema.knowledgeItems).run();
    mirror.buildMirror("p-mirror", repo);
    // A dead symlink still completes under `@` and then fails to read, which
    // reads as the app lying about what it holds.
    expect(existsSync(join(repo, ".station/knowledge/a-spec.md"))).toBe(false);
    expect(mirror.danglingLinks(repo)).toEqual([]);
    rmSync(join(repo, ".station"), { recursive: true, force: true });
  });

  it("refuses to build outside a configured project path", async () => {
    const mirror = await import("../reach-mirror");
    expect(() => mirror.buildMirror("p-mirror", "/tmp/not-a-project")).toThrow();
  });
});
