/**
 * Everything the Reach picker can put into a prompt, in one list.
 *
 * # One rule decides each entry's shape
 *
 * **A thing that exists on this machine is tagged with a path; a thing that does
 * not is tagged with the command that fetches it.** A knowledge file is already
 * on disk, so it becomes `@.station/knowledge/spec.md` and the agent reads it
 * only if it needs to. A Jira issue is somebody else's row in somebody else's
 * database, so it becomes `/reach-ticket ABC-123`, and the fetch happens when
 * the message is sent — at which point that command writes the issue into
 * `.station/tickets/`, so the *second* mention of it is a path after all.
 *
 * # Why the label and the insert are different strings
 *
 * The picker shows `spec.md` and types `@.station/knowledge/spec.md`. The path
 * has to be real — the CLI is what resolves it, and it resolves paths, not
 * nicknames — but nobody should have to read it in a list. Short label, real
 * insert.
 *
 * # What never appears here
 *
 * Env **values**. The names are worth offering (they are what a person refers to
 * when writing a command) and the values are exactly the thing the whole capture
 * path has been careful not to let into a prompt.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { CLAUDE_SKILLS_LINK_DIR } from "../lib/data-dir";
import { branches } from "./git";
import { mirrorAssets } from "./reach-mirror";
import type { ProjectRepo } from "./reach";

export interface ReachAsset {
  /** What the picker shows. Short on purpose. */
  label: string;
  /** Which chip it belongs to. */
  kind: string;
  /** What gets typed into the terminal. A path, a command, or a bare word. */
  insert: string;
  /** Secondary text: a status, a repo, a branch's upstream. */
  hint?: string;
}

/** How many of each kind is worth offering before a list stops being a list. */
const LIMIT = 40;

export function localAssets(repo: ProjectRepo): ReachAsset[] {
  return [
    ...mirrored(repo),
    ...recentFiles(repo),
    ...repoCommands(repo),
    ...envNames(repo),
    ...skills(),
    ...gitBranches(repo),
    ...recentCommits(repo),
  ];
}

/** Knowledge, plans, memory, agents, workflows, cached tickets — all files. */
function mirrored(repo: ProjectRepo): ReachAsset[] {
  return mirrorAssets(repo.path).map((asset) => ({
    label: asset.label,
    kind: asset.kind,
    insert: `@${asset.relPath}`,
  }));
}

/**
 * Files this project's sessions have actually been touching.
 *
 * The most useful entries in the whole picker, and the ones needing no mirror at
 * all: they are ordinary repo paths, already short, and they are what somebody
 * means when they say "that file we were just in".
 */
function recentFiles(repo: ProjectRepo): ReachAsset[] {
  try {
    const rows = db
      .select({ relPath: schema.sessionFiles.relPath, at: schema.sessionTurns.startedAt })
      .from(schema.sessionFiles)
      .innerJoin(schema.sessionTurns, eq(schema.sessionTurns.id, schema.sessionFiles.turnId))
      .where(
        and(
          eq(schema.sessionFiles.projectId, repo.projectId),
          eq(schema.sessionFiles.projectPathId, repo.projectPathId),
        ),
      )
      .orderBy(desc(schema.sessionTurns.startedAt))
      .limit(400)
      .all();

    const seen = new Set<string>();
    const out: ReachAsset[] = [];
    for (const row of rows) {
      if (!row.relPath || seen.has(row.relPath)) continue;
      seen.add(row.relPath);
      out.push({
        label: row.relPath,
        kind: "file",
        insert: `@${row.relPath}`,
        hint: row.at.slice(0, 10),
      });
      if (out.length >= LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The repo's configured commands — inserted as the command line itself.
 *
 * Picking "test" types what this project's tests actually are, which is the
 * cheapest possible fix for an agent guessing `npm test` in a repo that uses
 * something else.
 */
function repoCommands(repo: ProjectRepo): ReachAsset[] {
  try {
    return db
      .select()
      .from(schema.pathCommands)
      .where(eq(schema.pathCommands.projectPathId, repo.projectPathId))
      .orderBy(schema.pathCommands.sortOrder)
      .all()
      .map((c) => ({
        label: c.name,
        kind: "cmd",
        insert: c.command,
        hint: c.kind,
      }));
  } catch {
    return [];
  }
}

/**
 * Env variable **names** available to this project's commands.
 *
 * Names only, and that is the whole design of this entry: a value belongs in the
 * process that runs the command, never in the text of a prompt.
 */
function envNames(repo: ProjectRepo): ReachAsset[] {
  try {
    const set = db
      .select({ id: schema.envSets.id, name: schema.envSets.name })
      .from(schema.projectEnvSets)
      .innerJoin(schema.envSets, eq(schema.envSets.id, schema.projectEnvSets.envSetId))
      .where(eq(schema.projectEnvSets.projectId, repo.projectId))
      .get();
    if (!set) return [];

    return db
      .select({ key: schema.envVars.key, secret: schema.envVars.isSecret })
      .from(schema.envVars)
      .where(eq(schema.envVars.envSetId, set.id))
      .all()
      .map((v) => ({
        label: v.key,
        kind: "env",
        insert: `$${v.key}`,
        hint: v.secret ? `${set.name} · bí mật, không bao giờ chèn giá trị` : set.name,
      }));
  } catch {
    return [];
  }
}

/** Skills Claude Code loads, pointed at by their own `SKILL.md`. */
function skills(): ReachAsset[] {
  try {
    return readdirSync(CLAUDE_SKILLS_LINK_DIR)
      .filter((name) => existsSync(join(CLAUDE_SKILLS_LINK_DIR, name, "SKILL.md")))
      .sort()
      .slice(0, LIMIT)
      .map((name) => ({
        label: name,
        kind: "skill",
        insert: `@${join(CLAUDE_SKILLS_LINK_DIR, name, "SKILL.md")}`,
      }));
  } catch {
    return [];
  }
}

function gitBranches(repo: ProjectRepo): ReachAsset[] {
  try {
    const info = branches(repo.path);
    return info.local.slice(0, LIMIT).map((b) => ({
      label: b.name,
      kind: "branch",
      insert: b.name,
      hint: b.name === info.current ? "đang ở đây" : (b.upstream ?? ""),
    }));
  } catch {
    return [];
  }
}

/** Recent commits, as the argument `/reach-commit` wants. */
function recentCommits(repo: ProjectRepo): ReachAsset[] {
  try {
    return db
      .select({ sha: schema.checkpoints.commitSha, subject: schema.checkpoints.subject })
      .from(schema.checkpoints)
      .where(eq(schema.checkpoints.projectId, repo.projectId))
      .orderBy(desc(schema.checkpoints.committedAt))
      .limit(20)
      .all()
      .map((c) => ({
        label: `${c.sha.slice(0, 8)} ${c.subject}`,
        kind: "commit",
        insert: `/reach-commit ${c.sha.slice(0, 12)}`,
      }));
  } catch {
    return [];
  }
}
