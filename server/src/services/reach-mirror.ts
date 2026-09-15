/**
 * `.station/` — the workspace's own stores, reachable with the CLI's `@`.
 *
 * # Why a directory of files
 *
 * `/reach-*` answers questions. This answers a different one: how do you *point*
 * at something. In a terminal `@` completes file paths, so the shortest route to
 * "let `@` reach the knowledge base" is not to intercept `@` at all — it is to
 * put the knowledge base where a path can find it.
 *
 * Before this, `@` already worked; it just meant typing
 * `@/Users/…/data/knowledge/<project-id>/spec.md`. After it, `@.station/kn` and
 * the CLI completes the rest.
 *
 * # What is a link and what is a copy
 *
 * Knowledge is a **symlink**: the file already exists on disk and two copies of a
 * spec is one copy too many. Plans and memory are **materialised**, because they
 * live in SQLite and a path cannot point at a row. Tickets are materialised too,
 * by `/reach-ticket`, and are a cache rather than a source.
 *
 * Every one of them is a pointer rather than a paste: `@`-ing a file hands the
 * agent a path it reads if it needs to, so one mention does not occupy the
 * context window for the rest of the session.
 *
 * # Two rules about writing into someone's repo
 *
 * This is the app writing inside a working tree, so:
 *
 *   - **The ignore goes in `.git/info/exclude`, not `.gitignore`.** Same effect,
 *     and it does not dirty a tracked file that the person may be about to
 *     commit — or worse, conflict with on their next pull.
 *   - **Only ever `<repo>/.station`, and only under a configured project path.**
 *     The rebuild removes and recreates the directories it owns, and a delete
 *     inside a user's repo has to be bounded by something stronger than a string
 *     comparison.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { assertPathAllowed } from "../lib/path-safety";
import { listGlobalMemories, listMemories } from "./memory";
import { plansOf, planDocument, planSlug } from "./plans";
import { listProjectKnowledge } from "./library";
import { exportAgentMarkdown, listAgents } from "./agents";
import { listProjectWorkflows, renderWorkflowRunbook } from "./workflows";

/** The directories this owns and will rebuild wholesale. */
const OWNED = ["knowledge", "plans", "memory", "tickets", "agents", "workflows"] as const;

export interface MirrorResult {
  root: string;
  knowledge: number;
  plans: number;
  memory: number;
  agents: number;
  workflows: number;
  /** True when the ignore rule had to be added; false when it was already there. */
  excluded: boolean;
}

/** A filename that is safe, readable, and still recognisable as its source. */
function slug(name: string, fallback: string): string {
  const out = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return out || fallback;
}

/**
 * Make `.station/` match the stores as they are now.
 *
 * Rebuilds rather than reconciles: the directories are small, and a rebuild is
 * the only version with no way to leave a link pointing at something deleted —
 * which matters because a dead symlink still completes under `@` and then fails
 * when read, which reads as the app lying about what it has.
 */
export function buildMirror(projectId: string, repoPath: string): MirrorResult {
  // Bounded by the same guard every other filesystem write goes through: this
  // has to be a path under a configured project path, canonicalised first.
  const root = assertPathAllowed(join(repoPath, ".station"), projectId);
  mkdirSync(root, { recursive: true });

  for (const dir of OWNED) {
    rmSync(join(root, dir), { recursive: true, force: true });
    mkdirSync(join(root, dir), { recursive: true });
  }

  const result: MirrorResult = {
    root,
    knowledge: 0,
    plans: 0,
    memory: 0,
    agents: 0,
    workflows: 0,
    excluded: ensureExcluded(repoPath),
  };

  // -- knowledge: links, because the files are already somewhere real ----------
  const taken = new Set<string>();
  for (const item of listProjectKnowledge(projectId)) {
    if (!item.storedPath || !existsSync(item.storedPath)) continue;
    const ext = extname(item.originalFilename || item.storedPath) || "";
    let name = `${slug(item.name, item.id)}${ext}`;
    for (let n = 2; taken.has(name); n += 1) name = `${slug(item.name, item.id)}-${n}${ext}`;
    taken.add(name);
    try {
      symlinkSync(item.storedPath, join(root, "knowledge", name));
      result.knowledge += 1;
    } catch {
      /* a link we cannot make is one entry missing, not a failed rebuild */
    }
  }

  // -- plans and memory: copies, because a path cannot point at a row ---------
  for (const plan of plansOf(projectId, 50)) {
    try {
      writeFileSync(join(root, "plans", `${planSlug(plan)}.md`), planDocument(plan), "utf8");
      result.plans += 1;
    } catch {
      /* skip */
    }
  }

  const notes = [...listMemories(projectId), ...listGlobalMemories()];
  for (const note of notes) {
    try {
      writeFileSync(
        join(root, "memory", `${slug(note.title, note.id)}.md`),
        `# ${note.title}\n\n${note.body}\n`,
        "utf8",
      );
      result.memory += 1;
    } catch {
      /* skip */
    }
  }

  // -- agents and workflows: definitions, so a session can be pointed at how a
  // job is supposed to be done rather than told to re-derive it ---------------
  for (const agent of listAgents(projectId)) {
    try {
      writeFileSync(
        join(root, "agents", `${slug(agent.name, agent.id)}.md`),
        exportAgentMarkdown(agent),
        "utf8",
      );
      result.agents += 1;
    } catch {
      /* skip */
    }
  }

  for (const workflow of listProjectWorkflows(projectId)) {
    try {
      writeFileSync(
        join(root, "workflows", `${slug(workflow.name, workflow.id)}.md`),
        renderWorkflowRunbook(workflow),
        "utf8",
      );
      result.workflows += 1;
    } catch {
      /* skip */
    }
  }

  writeFileSync(join(root, "README.md"), readme(result), "utf8");
  return result;
}

/** Drop one fetched ticket in, so `@.station/tickets/KEY.md` exists to point at. */
export function cacheTicket(
  projectId: string,
  repoPath: string,
  key: string,
  body: string,
): string {
  const root = assertPathAllowed(join(repoPath, ".station"), projectId);
  const dir = join(root, "tickets");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug(key, "ticket")}.md`);
  writeFileSync(file, body, "utf8");
  return file;
}

/**
 * Keep `.station/` out of git without touching a tracked file.
 *
 * `.gitignore` is the obvious place and the wrong one: it is committed, so
 * writing to it makes the repo dirty on the app's initiative and can conflict on
 * the next pull. `.git/info/exclude` is per-clone, untracked, and means exactly
 * the same thing to git.
 */
function ensureExcluded(repoPath: string): boolean {
  let gitDir: string;
  try {
    gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return false; // not a repo, or no git — nothing to exclude from
  }
  const dir = gitDir.startsWith("/") ? gitDir : join(repoPath, gitDir);
  const file = join(dir, "info", "exclude");

  try {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (/^\.station\/?$/m.test(current)) return false;
    mkdirSync(join(dir, "info"), { recursive: true });
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(
      file,
      `${current}${prefix}\n# claude-station: generated pointers for @ mentions\n.station/\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

function readme(result: MirrorResult): string {
  return [
    "# .station",
    "",
    "Generated by claude-station so `@` can reach this workspace's stores.",
    "Rebuilt whenever a Claude terminal opens — edits here are overwritten.",
    "",
    `- \`knowledge/\` — ${result.knowledge} symlink(s) into the knowledge store`,
    `- \`plans/\` — ${result.plans} plan(s) proposed in this project`,
    `- \`memory/\` — ${result.memory} note(s), project and global`,
    `- \`agents/\` — ${result.agents} agent definition(s)`,
    `- \`workflows/\` — ${result.workflows} workflow runbook(s)`,
    "- `tickets/` — issues fetched by `/reach-ticket`, cached for `@`",
    "",
    "Ignored through `.git/info/exclude`, so no tracked file was touched.",
    "",
  ].join("\n");
}

/** Remove the whole mirror — the toggle going off should leave no trace. */
export function removeMirror(projectId: string, repoPath: string): boolean {
  try {
    const root = assertPathAllowed(join(repoPath, ".station"), projectId);
    if (!existsSync(root)) return false;
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Rebuild for every repo of a project. Called when a `claude` terminal opens. */
export function refreshMirrors(projectId: string): MirrorResult[] {
  const out: MirrorResult[] = [];
  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, projectId))
    .all();
  for (const path of paths) {
    try {
      out.push(buildMirror(projectId, path.path));
    } catch {
      /* a repo we cannot write to simply has no mirror */
    }
  }
  return out;
}

export interface MirrorAsset {
  /** What to show in a picker. */
  label: string;
  kind: (typeof OWNED)[number];
  /** Relative to the repo, which is exactly what goes after `@`. */
  relPath: string;
}

/**
 * Everything under `.station/`, as paths an `@` can take.
 *
 * Exists because the CLI's own suggestion menu is a closed interactive surface —
 * it did not list this directory for one user and there is no way to test it
 * from outside. Rather than keep guessing at its filter, the picker this app
 * owns lists the files itself and types the path in. The mirror is what makes
 * the path short; this is what makes it discoverable.
 */
export function mirrorAssets(repoPath: string): MirrorAsset[] {
  const out: MirrorAsset[] = [];
  for (const kind of OWNED) {
    const dir = join(repoPath, ".station", kind);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      // A dead link still completes and then fails to read, so it is left out
      // rather than offered.
      if (!existsSync(join(dir, entry))) continue;
      out.push({
        label: entry.replace(/\.md$/, ""),
        kind,
        relPath: `.station/${kind}/${entry}`,
      });
    }
  }
  return out;
}

/** Dead links, for the health check — a path that completes and then fails to read. */
export function danglingLinks(repoPath: string): string[] {
  const dir = join(repoPath, ".station", "knowledge");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      lstatSync(full);
      if (!existsSync(full)) out.push(basename(full));
    } catch {
      out.push(basename(full));
    }
  }
  return out;
}
