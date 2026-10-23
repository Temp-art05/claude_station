/**
 * Export carries the library and nothing that only works on this machine; Add
 * merges an archive in without replacing anything already here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-library-"));
const skillsLinkDir = mkdtempSync(join(tmpdir(), "cs-library-links-"));
process.env.CLAUDE_STATION_DATA = dataDir;
process.env.CLAUDE_SKILLS_DIR = skillsLinkDir;

const backup = await import("../backup");
const { sqlite } = await import("../../db");
(await import("../search")).ensureSearchTables(); // boot does this

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(skillsLinkDir, { recursive: true, force: true });
});

const now = new Date().toISOString();

function seedStation(): void {
  sqlite
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("p1", "App", now, now);
  sqlite
    .prepare("INSERT INTO project_paths (id, project_id, path, label) VALUES (?, ?, ?, ?)")
    .run("pp1", "p1", "/Users/someone/repo", "repo");

  const skillDir = join(dataDir, "skills", "shared-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: shared-skill\n---\nbody");
  sqlite
    .prepare(
      `INSERT INTO knowledge_items (id, project_id, kind, name, original_filename, stored_path, parsed_path, created_at)
       VALUES (?, NULL, 'skill', 'shared-skill', 'shared-skill/', ?, '/elsewhere/link', ?)`,
    )
    .run("k-skill", skillDir, now);

  const projectDoc = join(dataDir, "knowledge", "p1", "notes.md");
  mkdirSync(join(dataDir, "knowledge", "p1"), { recursive: true });
  writeFileSync(projectDoc, "project only");
  sqlite
    .prepare(
      `INSERT INTO knowledge_items (id, project_id, kind, name, original_filename, stored_path, created_at)
       VALUES (?, 'p1', 'doc', 'notes', 'notes.md', ?, ?)`,
    )
    .run("k-project", projectDoc, now);

  const bundle = join(dataDir, "agents", "helper");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "run.sh"), "echo hi");
  sqlite
    .prepare(
      `INSERT INTO agents (id, name, description, prompt, bundle_dir, created_at, updated_at)
       VALUES ('a1', 'helper', 'd', 'p', ?, ?, ?)`,
    )
    .run(bundle, now, now);

  sqlite
    .prepare("INSERT INTO workflows (id, name, created_at, updated_at) VALUES ('w1', 'ship', ?, ?)")
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO workflow_steps (id, workflow_id, key, type, title, created_at)
       VALUES ('ws1', 'w1', 'plan', 'agent', 'Plan', ?)`,
    )
    .run(now);

  sqlite
    .prepare(
      `INSERT INTO project_memories (id, project_id, title, body, created_at, updated_at)
       VALUES ('m-global', NULL, 'Global rule', 'b', ?, ?), ('m-project', 'p1', 'Project rule', 'b', ?, ?)`,
    )
    .run(now, now, now, now);
}

function extract(archivePath: string): string {
  const out = mkdtempSync(join(tmpdir(), "cs-library-out-"));
  execFileSync("tar", ["-xzf", archivePath, "-C", out]);
  return out;
}

describe("library export", () => {
  it("carries the library and leaves projects and their rows behind", async () => {
    seedStation();
    const { archivePath, cleanup } = await backup.exportArchive();
    const out = extract(archivePath);
    cleanup();

    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 2, kind: "library" });

    const db = new Database(join(out, "claude-station.db"), { readonly: true });
    const ids = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map((r) => r.id);
    expect(ids("SELECT id FROM projects")).toEqual([]);
    expect(ids("SELECT id FROM project_paths")).toEqual([]);
    expect(ids("SELECT id FROM knowledge_items")).toEqual(["k-skill"]);
    expect(ids("SELECT id FROM agents")).toEqual(["a1"]);
    expect(ids("SELECT id FROM workflow_steps")).toEqual(["ws1"]);
    expect(ids("SELECT id FROM project_memories")).toEqual(["m-global"]);
    db.close();

    expect(existsSync(join(out, "skills", "shared-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(out, "agents", "helper", "run.sh"))).toBe(true);
    expect(existsSync(join(out, "knowledge", "p1"))).toBe(false);
    rmSync(out, { recursive: true, force: true });
  });
});

describe("add from another station", () => {
  /** An archive as another machine would produce it: its own data dir, its own rows. */
  function foreignArchive(): Buffer {
    const root = mkdtempSync(join(tmpdir(), "cs-library-foreign-"));
    const oldDataDir = "/Users/other/station/data";
    const db = new Database(join(root, "claude-station.db"));
    // Same schema as here: copy it from the live database.
    for (const { sql } of sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE '%_search_%'",
      )
      .all() as { sql: string }[]) {
      db.exec(sql);
    }
    db.prepare(
      `INSERT INTO knowledge_items (id, project_id, kind, name, original_filename, stored_path, created_at)
       VALUES ('k-new', NULL, 'skill', 'new-skill', 'new-skill/', ?, ?),
              ('k-skill', NULL, 'skill', 'shared-skill', 'shared-skill/', ?, ?)`,
    ).run(`${oldDataDir}/skills/new-skill`, now, `${oldDataDir}/skills/shared-skill`, now);
    db.prepare(
      `INSERT INTO agents (id, name, description, prompt, created_at, updated_at)
       VALUES ('a-other', 'helper', 'd', 'p', ?, ?), ('a2', 'reviewer', 'd', 'p', ?, ?)`,
    ).run(now, now, now, now);
    db.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p-old', 'Old', ?, ?)",
    ).run(now, now);
    db.close();

    mkdirSync(join(root, "skills", "new-skill"), { recursive: true });
    writeFileSync(join(root, "skills", "new-skill", "SKILL.md"), "---\nname: new-skill\n---\n");
    mkdirSync(join(root, "skills", "shared-skill"), { recursive: true });
    writeFileSync(join(root, "skills", "shared-skill", "SKILL.md"), "theirs");
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({ version: 1, exportedAt: now, dataDir: oldDataDir }),
    );
    const archive = join(root, "a.tar.gz");
    execFileSync("tar", [
      "-czf",
      archive,
      "-C",
      root,
      "claude-station.db",
      "manifest.json",
      "skills",
    ]);
    const buf = readFileSync(archive);
    rmSync(root, { recursive: true, force: true });
    return buf;
  }

  it("adds what is new, keeps what is here, and leaves projects out", () => {
    const result = backup.addArchive(foreignArchive());

    expect(result.added).toEqual(
      expect.arrayContaining([
        { kind: "skill", name: "new-skill" },
        { kind: "agent", name: "reviewer" },
      ]),
    );
    expect(result.skipped.map((s) => s.name)).toEqual(
      expect.arrayContaining(["shared-skill", "helper"]),
    );
    expect(result.projectsLeftOut).toBe(1);

    // Existing content untouched; the new skill lives under this data dir and is linked.
    expect(readFileSync(join(dataDir, "skills", "shared-skill", "SKILL.md"), "utf8")).toContain(
      "body",
    );
    const added = sqlite
      .prepare("SELECT stored_path, parsed_path FROM knowledge_items WHERE id = 'k-new'")
      .get() as { stored_path: string; parsed_path: string };
    expect(added.stored_path).toBe(join(dataDir, "skills", "new-skill"));
    expect(added.parsed_path).toBe(join(skillsLinkDir, "new-skill"));
    expect(sqlite.prepare("SELECT 1 FROM projects WHERE id = 'p-old'").get()).toBeUndefined();
  });

  it("is idempotent: adding the same archive again adds nothing", () => {
    const result = backup.addArchive(foreignArchive());
    expect(result.added).toEqual([]);
  });
});
