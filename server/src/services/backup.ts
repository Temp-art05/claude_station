import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { CLAUDE_SKILLS_LINK_DIR, DATA_DIR, DB_PATH, SKILLS_DIR } from "../lib/data-dir";
import { REPO_ROOT } from "../lib/repo-root";
import { badRequest } from "../lib/path-safety";
import { sqlite } from "../db";

const EXPORT_VERSION = 1;
/** Directories that travel with an export. worktrees/logs/.token stay home. */
const PORTABLE_DIRS = ["knowledge", "skills", "agents", "attachments"];

export interface Manifest {
  version: number;
  exportedAt: string;
  dataDir: string;
}

/**
 * Build a portable archive of everything the app owns. The DB goes in as a
 * `backup()` snapshot (safe under WAL — never copy the live file), plus the
 * portable data dirs and a manifest recording the old data dir so import can
 * rewrite absolute paths.
 */
export async function exportArchive(): Promise<{ archivePath: string; cleanup: () => void }> {
  const staging = join(DATA_DIR, `.export-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true });

  // Consistent snapshot of the live DB — safe under WAL, unlike copying files.
  await sqlite.backup(join(staging, "claude-station.db"));

  const manifest: Manifest = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    dataDir: DATA_DIR,
  };
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Station config for reference on the new machine — never auto-applied.
  const envFile = join(REPO_ROOT, ".env");
  if (existsSync(envFile)) writeFileSync(join(staging, "station.env"), readFileSync(envFile));

  const archivePath = join(staging, "export.tar.gz");
  const args = ["-czf", archivePath, "-C", staging, "claude-station.db", "manifest.json"];
  if (existsSync(join(staging, "station.env"))) args.push("station.env");
  for (const dir of PORTABLE_DIRS) {
    if (existsSync(join(DATA_DIR, dir))) args.push("-C", DATA_DIR, dir);
  }
  execFileSync("tar", args);

  return { archivePath, cleanup: () => rmSync(staging, { recursive: true, force: true }) };
}

/**
 * Restore an export on this machine. The current data is moved aside (never
 * deleted), absolute path columns are rewritten from the old data dir to this
 * one, and skills get relinked. The caller must restart the server afterwards:
 * the live DB connection still points at the old file's inode.
 */
export function importArchive(archive: Buffer): { backupDir: string; note: string } {
  const staging = join(DATA_DIR, `.import-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", "-", "-C", staging], { input: archive });

    const manifestPath = join(staging, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw badRequest("Not a claude-station export: manifest.json missing");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (manifest.version !== EXPORT_VERSION) {
      throw badRequest(`Unsupported export version ${manifest.version}`);
    }
    const dbFile = join(staging, "claude-station.db");
    if (!existsSync(dbFile)) throw badRequest("Export has no claude-station.db");

    // Rewrite absolute paths recorded under the OLD data dir to this machine's.
    rewritePaths(dbFile, manifest.dataDir, DATA_DIR);

    // Move current data aside — reversible by hand if anything goes wrong.
    const backupDir = join(dirname(DATA_DIR), `data-backup-${Date.now().toString(36)}`);
    mkdirSync(backupDir, { recursive: true });
    for (const name of ["claude-station.db", ...PORTABLE_DIRS]) {
      const src = join(DATA_DIR, name);
      if (existsSync(src)) renameSync(src, join(backupDir, name));
    }
    // Stale WAL/SHM of the old DB must not be replayed into the imported one.
    for (const suffix of ["-wal", "-shm"]) {
      const p = `${DB_PATH}${suffix}`;
      if (existsSync(p)) renameSync(p, join(backupDir, `claude-station.db${suffix}`));
    }

    renameSync(dbFile, DB_PATH);
    for (const dir of PORTABLE_DIRS) {
      const src = join(staging, dir);
      if (existsSync(src)) renameSync(src, join(DATA_DIR, dir));
      else mkdirSync(join(DATA_DIR, dir), { recursive: true });
    }
    if (existsSync(join(staging, "station.env"))) {
      cpSync(join(staging, "station.env"), join(DATA_DIR, "imported-station.env"));
    }

    relinkSkills();

    return {
      backupDir,
      note: "Restart the server now — the running instance still holds the previous database.",
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function rewritePaths(dbFile: string, oldPrefix: string, newPrefix: string): void {
  if (oldPrefix === newPrefix) return;
  const db = new Database(dbFile);
  try {
    const rewrite = (table: string, column: string) =>
      db
        .prepare(
          `UPDATE ${table} SET ${column} = replace(${column}, ?, ?) WHERE ${column} LIKE ? || '%'`,
        )
        .run(oldPrefix, newPrefix, oldPrefix);
    rewrite("knowledge_items", "stored_path");
    rewrite("knowledge_items", "parsed_path");
    rewrite("agents", "bundle_dir");
    rewrite("agents", "view_path");
    rewrite("command_runs", "log_path");
    rewrite("terminals", "cwd");
    // Worktrees don't travel — sessions must not point at ghosts.
    db.prepare("UPDATE chat_sessions SET worktree_path = NULL").run();
  } finally {
    db.close();
  }
}

/** Recreate ~/.claude/skills symlinks for every imported skill directory. */
function relinkSkills(): { linked: number; skipped: number } {
  let linked = 0;
  let skipped = 0;
  if (!existsSync(SKILLS_DIR)) return { linked, skipped };
  mkdirSync(CLAUDE_SKILLS_LINK_DIR, { recursive: true });
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const linkPath = join(CLAUDE_SKILLS_LINK_DIR, entry.name);
    try {
      if (lstatSync(linkPath)) {
        skipped += 1; // something already there (theirs or ours) — never clobber
        continue;
      }
    } catch {
      /* no entry — free to link */
    }
    try {
      symlinkSync(join(SKILLS_DIR, entry.name), linkPath, "dir");
      linked += 1;
    } catch {
      skipped += 1;
    }
  }
  return { linked, skipped };
}

/** Used by the export route to name the download. */
export function exportFilename(): string {
  return `claude-station-export-${new Date().toISOString().slice(0, 10)}.tar.gz`;
}
