import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, SKILLS_DIR } from "../lib/data-dir";
import { newId } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { sqlite } from "../db";
import { reindexKnowledge } from "./search";
import { linkSkillDir } from "./skills";

/**
 * v1 carried the whole data dir — projects included — and replaced the target's
 * data on import. A project points at repos on the machine it came from, so on
 * any other machine it arrived broken; v2 carries only the library, which works
 * anywhere. Add still reads v1 archives, taking just their library rows.
 */
const EXPORT_VERSION = 2;
const READABLE_VERSIONS = new Set([1, 2]);

/**
 * Tables that travel. A whitelist on purpose: a table added later stays home
 * until someone decides it is portable, instead of leaking out by default.
 */
const LIBRARY_TABLES = new Set([
  "knowledge_items",
  "agents",
  "workflows",
  "workflow_steps",
  "workflow_inputs",
  "project_memories",
  "env_sets",
  "env_vars",
  "integrations",
]);

export interface Manifest {
  version: number;
  kind?: "library";
  exportedAt: string;
  dataDir: string;
}

/**
 * Build a portable archive of the library: global knowledge and skills, agents
 * and their bundles, workflows, global memories, global env sets, integrations.
 * The DB goes in as a `backup()` snapshot (safe under WAL) pruned down to those
 * rows, plus exactly the files they point at.
 */
export async function exportArchive(): Promise<{ archivePath: string; cleanup: () => void }> {
  const staging = join(DATA_DIR, `.export-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true });

  await sqlite.backup(join(staging, "claude-station.db"));
  const files = pruneToLibrary(join(staging, "claude-station.db"));

  const manifest: Manifest = {
    version: EXPORT_VERSION,
    kind: "library",
    exportedAt: new Date().toISOString(),
    dataDir: DATA_DIR,
  };
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  const archivePath = join(staging, "export.tar.gz");
  const args = ["-czf", archivePath, "-C", staging, "claude-station.db", "manifest.json"];
  if (files.length > 0) args.push("-C", DATA_DIR, ...files);
  execFileSync("tar", args);

  return { archivePath, cleanup: () => rmSync(staging, { recursive: true, force: true }) };
}

/**
 * Strip a DB snapshot down to the library. Returns the data-dir-relative paths
 * the remaining rows reference, which is what the archive carries.
 */
export function pruneToLibrary(dbFile: string): string[] {
  const db = new Database(dbFile);
  try {
    const objects = db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'trigger')")
      .all() as { type: string; name: string; sql: string | null }[];
    // Triggers first: they write into the search tables dropped next.
    for (const o of objects.filter((o) => o.type === "trigger")) {
      db.exec(`DROP TRIGGER IF EXISTS "${o.name}"`);
    }
    // Search indexes are rebuilt on the receiving side; dropping a virtual
    // table takes its shadow tables with it.
    for (const o of objects.filter((o) => o.sql?.startsWith("CREATE VIRTUAL TABLE"))) {
      db.exec(`DROP TABLE IF EXISTS "${o.name}"`);
    }
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    for (const table of tables) {
      if (!LIBRARY_TABLES.has(table)) db.exec(`DELETE FROM "${table}"`);
    }
    // Project-scoped rows belong to projects that don't travel.
    db.exec(`
      DELETE FROM knowledge_items WHERE project_id IS NOT NULL;
      DELETE FROM project_memories WHERE project_id IS NOT NULL;
      DELETE FROM env_vars WHERE env_set_id IN (SELECT id FROM env_sets WHERE project_id IS NOT NULL);
      DELETE FROM env_sets WHERE project_id IS NOT NULL;
    `);

    const paths = [
      ...(db.prepare("SELECT stored_path AS p FROM knowledge_items").all() as { p: string }[]),
      ...(db.prepare("SELECT parsed_path AS p FROM knowledge_items").all() as { p: string }[]),
      ...(db.prepare("SELECT bundle_dir AS p FROM agents").all() as { p: string }[]),
      ...(db.prepare("SELECT view_path AS p FROM agents").all() as { p: string }[]),
    ].map((r) => r.p);
    db.exec("VACUUM");

    const files = new Set<string>();
    for (const p of paths) {
      const rel = underDataDir(p, DATA_DIR);
      if (rel && existsSync(p)) files.add(rel);
    }
    return [...files];
  } finally {
    db.close();
  }
}

function underDataDir(p: string | null, dataDir: string): string | null {
  if (!p || !p.startsWith(dataDir + sep)) return null;
  return relative(dataDir, p);
}

export interface AddResult {
  added: { kind: string; name: string }[];
  skipped: { kind: string; name: string; reason: string }[];
  /** Projects in a v1 archive, left out because their repos stay on the old machine. */
  projectsLeftOut: number;
}

type Row = Record<string, unknown>;

/**
 * Merge another station's library into this one. Never replaces anything: a
 * row whose id or name already exists here is skipped and reported. Runs
 * against the live database, so no restart is needed.
 */
export function addArchive(archive: Buffer): AddResult {
  const staging = join(DATA_DIR, `.add-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", "-", "-C", staging], { input: archive });

    const manifestPath = join(staging, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw badRequest("Not a claude-station export: manifest.json missing");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (!READABLE_VERSIONS.has(manifest.version)) {
      throw badRequest(`Unsupported export version ${manifest.version}`);
    }
    const dbFile = join(staging, "claude-station.db");
    if (!existsSync(dbFile)) throw badRequest("Export has no claude-station.db");

    const src = new Database(dbFile, { readonly: true });
    try {
      return mergeLibrary(src, staging, manifest.dataDir);
    } finally {
      src.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function mergeLibrary(src: Database.Database, staging: string, oldDataDir: string): AddResult {
  const result: AddResult = { added: [], skipped: [], projectsLeftOut: 0 };
  const skip = (kind: string, name: string, reason: string) =>
    result.skipped.push({ kind, name, reason });

  const all = (sql: string, ...args: unknown[]): Row[] =>
    hasTable(src, sql) ? (src.prepare(sql).all(...args) as Row[]) : [];
  const exists = (sql: string, ...args: unknown[]) => !!sqlite.prepare(sql).get(...args);

  /** Where an archived path lands here, and where its bytes sit in the staging dir. */
  const relocate = (p: unknown) => {
    const rel = underDataDir(typeof p === "string" ? p : null, oldDataDir);
    return rel ? { local: join(DATA_DIR, rel), staged: join(staging, rel) } : null;
  };

  if (hasTable(src, "SELECT 1 FROM projects")) {
    result.projectsLeftOut = (
      src.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }
    ).n;
  }

  const reindex: string[] = [];
  sqlite.transaction(() => {
    // ── Knowledge & skills ───────────────────────────────────────────────────
    for (const k of all("SELECT * FROM knowledge_items WHERE project_id IS NULL")) {
      const name = String(k.name);
      const kind = k.kind === "skill" ? "skill" : "knowledge";
      if (exists("SELECT 1 FROM knowledge_items WHERE id = ?", k.id)) {
        skip(kind, name, "already here");
        continue;
      }
      const stored = relocate(k.stored_path);
      if (!stored || !existsSync(stored.staged)) {
        skip(kind, name, "its files are not in the archive");
        continue;
      }
      if (existsSync(stored.local)) {
        skip(kind, name, "a file with that name is already here");
        continue;
      }
      cpSync(stored.staged, stored.local, { recursive: true });
      let parsedPath: unknown = null;
      if (k.kind === "skill") {
        // The old path was a link on the other machine; this one makes its own.
        parsedPath = stored.local.startsWith(SKILLS_DIR + sep)
          ? linkSkillDir(basename(stored.local))
          : null;
      } else {
        const parsed = relocate(k.parsed_path);
        if (parsed && existsSync(parsed.staged)) {
          if (!existsSync(parsed.local)) cpSync(parsed.staged, parsed.local, { recursive: true });
          parsedPath = parsed.local;
        }
      }
      insertRow("knowledge_items", { ...k, stored_path: stored.local, parsed_path: parsedPath });
      reindex.push(String(k.id));
      result.added.push({ kind, name });
    }

    // ── Agents ───────────────────────────────────────────────────────────────
    for (const a of all("SELECT * FROM agents")) {
      const name = String(a.name);
      if (exists("SELECT 1 FROM agents WHERE name = ?", name)) {
        skip("agent", name, "an agent with that name is already here");
        continue;
      }
      const paths: Row = {};
      for (const col of ["bundle_dir", "view_path"]) {
        const moved = relocate(a[col]);
        if (moved && existsSync(moved.staged)) {
          if (!existsSync(moved.local)) cpSync(moved.staged, moved.local, { recursive: true });
          paths[col] = moved.local;
        } else {
          paths[col] = null;
        }
      }
      const id = exists("SELECT 1 FROM agents WHERE id = ?", a.id) ? newId() : a.id;
      insertRow("agents", { ...a, ...paths, id });
      result.added.push({ kind: "agent", name });
    }

    // ── Workflows ────────────────────────────────────────────────────────────
    for (const w of all("SELECT * FROM workflows")) {
      const name = String(w.name);
      if (exists("SELECT 1 FROM workflows WHERE name = ?", name)) {
        skip("workflow", name, "a workflow with that name is already here");
        continue;
      }
      const id = exists("SELECT 1 FROM workflows WHERE id = ?", w.id) ? newId() : String(w.id);
      insertRow("workflows", { ...w, id });
      for (const table of ["workflow_steps", "workflow_inputs"]) {
        for (const child of all(`SELECT * FROM ${table} WHERE workflow_id = ?`, w.id)) {
          insertRow(table, { ...child, id: newId(), workflow_id: id });
        }
      }
      result.added.push({ kind: "workflow", name });
    }

    // ── Global memories ──────────────────────────────────────────────────────
    for (const m of all("SELECT * FROM project_memories WHERE project_id IS NULL")) {
      const title = String(m.title);
      if (
        exists("SELECT 1 FROM project_memories WHERE id = ?", m.id) ||
        exists("SELECT 1 FROM project_memories WHERE project_id IS NULL AND title = ?", title)
      ) {
        skip("memory", title, "already here");
        continue;
      }
      insertRow("project_memories", m);
      result.added.push({ kind: "memory", name: title });
    }

    // ── Global env sets ──────────────────────────────────────────────────────
    for (const s of all("SELECT * FROM env_sets WHERE project_id IS NULL")) {
      const name = String(s.name);
      if (
        exists("SELECT 1 FROM env_sets WHERE id = ?", s.id) ||
        exists("SELECT 1 FROM env_sets WHERE project_id IS NULL AND name = ?", name)
      ) {
        skip("env set", name, "already here");
        continue;
      }
      insertRow("env_sets", s);
      for (const v of all("SELECT * FROM env_vars WHERE env_set_id = ?", s.id)) {
        insertRow("env_vars", { ...v, id: newId() });
      }
      result.added.push({ kind: "env set", name });
    }

    // ── Integrations ─────────────────────────────────────────────────────────
    for (const i of all("SELECT * FROM integrations")) {
      const kind = String(i.kind);
      if (exists("SELECT 1 FROM integrations WHERE kind = ?", kind)) {
        skip("integration", kind, "already configured here");
        continue;
      }
      const id = exists("SELECT 1 FROM integrations WHERE id = ?", i.id) ? newId() : i.id;
      insertRow("integrations", { ...i, id });
      result.added.push({ kind: "integration", name: kind });
    }
  })();

  for (const id of reindex) reindexKnowledge(id);
  return result;
}

/** An archive from an older version can lack a table; reading it must not throw. */
function hasTable(db: Database.Database, sql: string): boolean {
  const table = /FROM\s+(\w+)/i.exec(sql)?.[1];
  if (!table) return false;
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

const columnCache = new Map<string, Set<string>>();

/**
 * Insert keeping only the columns this schema has: the archive may come from an
 * older or newer version, and a stray or missing column is not a reason to fail.
 */
function insertRow(table: string, row: Row): void {
  let cols = columnCache.get(table);
  if (!cols) {
    cols = new Set(
      (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    columnCache.set(table, cols);
  }
  const keys = Object.keys(row).filter((k) => cols.has(k));
  sqlite
    .prepare(
      `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    )
    .run(...keys.map((k) => row[k]));
}

/** Used by the export route to name the download. */
export function exportFilename(): string {
  return `claude-station-library-${new Date().toISOString().slice(0, 10)}.tar.gz`;
}
