/**
 * Packs: a repo's worth of skills, agents and workflows, installed as a set.
 *
 * Importing assets one file at a time already works, and that is exactly the
 * problem — a set of twelve skills that belong together arrives as twelve
 * uploads, and nothing afterwards remembers they were a set, so nothing can
 * update or remove them as one.
 *
 * # Security is the feature, not a footnote
 *
 * A pack is text that ends up inside a prompt, and a pack that carries scripts or
 * hooks is remote code execution with a friendly name. So, in order:
 *
 *   - **Preview before install.** Nothing is registered until the exact list of
 *     assets has been shown and chosen from.
 *   - **Pinned to a commit sha, never a branch.** Following a branch means the
 *     author can change what runs here after you agreed to it. Update is an
 *     action with a diff, not something that happens quietly.
 *   - **Scripts are found and reported, never wired up.** They stay as files in
 *     the pack directory; nothing symlinks them anywhere Claude Code auto-loads,
 *     and `scriptsEnabled` exists to be looked at rather than to be flipped.
 *   - **Only the repo is cloned.** No install step, no package manager, no
 *     `postinstall`. `git clone --depth 1` and a read of the tree.
 *
 * # What an install actually does
 *
 * Registers each asset through the same path a manual import uses — a skill
 * becomes a linked skill tree, an agent an `agents` row, a workflow a library
 * workflow — and records which row it became, so uninstall takes back exactly
 * what the pack added and nothing a person wrote themselves.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { basename, extname, join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { PACKS_DIR } from "../lib/data-dir";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { importAgentMarkdown, deleteAgent } from "./agents";
import { deleteKnowledge, importFolder } from "./knowledge";
import { removeSkillTree } from "./skills";
import { deleteWorkflow, importWorkflowYaml, setWorkflowFolder } from "./workflows";

export type PackAssetKind = "skill" | "agent" | "workflow" | "script";

export interface ScannedAsset {
  kind: PackAssetKind;
  /** Path inside the pack. */
  relPath: string;
  /** The name it would take here. */
  name: string;
  /** For a skill: the whole directory, because a skill is a tree. */
  files?: string[];
  /** Why it is worth a second look — a script, a hook, an unexpected shape. */
  warning?: string;
}

export interface PackPreview {
  name: string;
  repoUrl: string;
  ref: string;
  sha: string;
  assets: ScannedAsset[];
  /** Where the clone is parked until install or discard. */
  stagedPath: string;
  readme: string;
}

export type Pack = typeof schema.packs.$inferSelect;
export type PackAsset = typeof schema.packAssets.$inferSelect;

const CLONE_TIMEOUT_MS = 120_000;
/** A pack is documents; anything this big is not one. */
const MAX_FILE_BYTES = 512 * 1024;

const execFileAsync = promisify(execFile);

/**
 * Quick git calls — `rev-parse`, `diff`, `checkout`. Milliseconds, so blocking
 * is fine and the call sites stay readable.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: CLONE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The clone, which is the one git call here that is not quick.
 *
 * `anthropics/skills` is 419 files and `wshobson/agents` is far more; a
 * synchronous clone holds the event loop for as long as the network takes, which
 * stops every terminal, every websocket and every other request in the app. The
 * same mistake the boot sequence already learned not to make.
 */
async function gitCloneAsync(args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd: PACKS_DIR,
    timeout: CLONE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** How long an abandoned staging clone is kept before it is swept. */
const STAGING_TTL_MS = 60 * 60 * 1000;

/**
 * Throw away staging clones nobody installed or discarded.
 *
 * Preview clones into `.staging-*` and waits for a decision. Close the tab
 * without deciding — which is the normal way to say no — and the clone stayed
 * for ever. Run at boot, and again before each preview, so a machine that is
 * never restarted still does not accumulate repos.
 */
export function sweepStaging(now = Date.now()): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(PACKS_DIR);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(".staging-")) continue;
    const full = join(PACKS_DIR, entry);
    try {
      if (now - statSync(full).mtimeMs < STAGING_TTL_MS) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* being swept is best effort — a locked directory gets the next pass */
    }
  }
  return removed;
}

/**
 * Only https and git URLs, and no local paths.
 *
 * A `file://` or bare path would let a caller point the cloner at anything on
 * this machine, and the pack directory is served back through the API.
 */
export function normaliseRepoUrl(input: string): string {
  const url = input.trim();
  if (!/^https:\/\/[\w.-]+\/[\w.\-/]+?(?:\.git)?$/.test(url)) {
    throw badRequest("A pack is installed from an https git URL");
  }
  return url;
}

/** `https://github.com/owner/name` → `name`, which is what the directory is called. */
export function packNameFrom(repoUrl: string): string {
  const last =
    repoUrl
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
      .pop() ?? "pack";
  return last.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

// -- scanning -----------------------------------------------------------------

/** Files a pack is allowed to be made of. Anything else is carried, not read. */
const TEXT_EXT = new Set([".md", ".markdown", ".yaml", ".yml", ".json", ".txt"]);
const SCRIPT_EXT = new Set([".sh", ".bash", ".zsh", ".py", ".rb", ".js", ".mjs", ".ts"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "dist", "build", "target"]);

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out;
}

/**
 * What a checkout contains, in the app's own terms.
 *
 * Layout is taken from where files sit rather than from a manifest the pack
 * wrote: a manifest is a claim, and the tree is the fact. `SKILL.md` makes its
 * directory a skill; `agents/` and `workflows/` are what they say they are.
 */
export function scanPack(root: string): ScannedAsset[] {
  const files = walk(root);
  const assets: ScannedAsset[] = [];

  // Skill directories first, in their own pass, because everything else has to
  // know whether a file belongs to one. The single-pass version listed every
  // script inside a skill as a `script` asset of its own — and then said it
  // would never be installed, next to the skill whose install copies it. Two
  // rows, opposite claims, both about the same file.
  const skillDirs = new Set<string>();
  for (const relPath of files) {
    if (basename(relPath) === "SKILL.md") skillDirs.add(relPath.split("/").slice(0, -1).join("/"));
  }
  const insideSkill = (relPath: string): boolean =>
    [...skillDirs].some((dir) => (dir === "" ? true : relPath.startsWith(`${dir}/`)));

  for (const relPath of files) {
    const name = basename(relPath);
    if (name === "SKILL.md") continue;
    const ext = extname(relPath).toLowerCase();
    const parts = relPath.split("/");

    // A skill's own files are that skill's business — the skill row carries the
    // warning about what it drags along, and listing them again here is noise.
    if (insideSkill(relPath)) continue;

    if (SCRIPT_EXT.has(ext)) {
      assets.push({
        kind: "script",
        relPath,
        name,
        warning: "a loose script — recorded, never installed or run",
      });
      continue;
    }

    if (!TEXT_EXT.has(ext)) continue;

    // `agents/` and `workflows/` at ANY depth, not only at the repo root: the
    // plugin layout Claude Code uses puts them at `plugins/<name>/agents/*.md`,
    // and anchoring at the root missed 202 agents in one real repo.
    const dir = parts.length > 1 ? parts[parts.length - 2]!.toLowerCase() : "";
    if (dir === "agents" && (ext === ".md" || ext === ".markdown")) {
      assets.push({ kind: "agent", relPath, name: name.replace(/\.(md|markdown)$/i, "") });
      continue;
    }
    if (dir === "workflows" && (ext === ".yaml" || ext === ".yml")) {
      assets.push({ kind: "workflow", relPath, name: name.replace(/\.(ya?ml)$/i, "") });
      continue;
    }
    if (parts.includes("hooks")) {
      assets.push({ kind: "script", relPath, name, warning: "a hook — recorded, never installed" });
    }
  }

  for (const dir of [...skillDirs].sort()) {
    const inside = files.filter((f) => (dir === "" ? !f.includes("/") : f.startsWith(`${dir}/`)));
    const scripts = inside.filter((f) => SCRIPT_EXT.has(extname(f).toLowerCase()));
    assets.push({
      kind: "skill",
      relPath: dir === "" ? "SKILL.md" : `${dir}/SKILL.md`,
      name: dir === "" ? basename(root) : basename(dir),
      files: inside,
      ...(scripts.length > 0
        ? { warning: `carries ${scripts.length} script file(s) — copied, never run` }
        : {}),
    });
  }

  return assets.sort((a, b) => a.kind.localeCompare(b.kind) || a.relPath.localeCompare(b.relPath));
}

// -- preview ------------------------------------------------------------------

/**
 * Clone into a staging directory and report what is inside.
 *
 * Staged rather than installed: the clone is what makes the preview honest (a
 * GitHub API listing would not show what the files say), and it is thrown away
 * unless install follows.
 */
export async function previewPack(repoUrlInput: string, ref = "HEAD"): Promise<PackPreview> {
  const repoUrl = normaliseRepoUrl(repoUrlInput);
  const name = packNameFrom(repoUrl);
  const stagedPath = join(PACKS_DIR, `.staging-${name}-${Date.now()}`);
  sweepStaging();

  try {
    await gitCloneAsync([
      "clone",
      "--depth",
      "1",
      ...(ref && ref !== "HEAD" ? ["--branch", ref] : []),
      repoUrl,
      stagedPath,
    ]);
  } catch (err) {
    rmSync(stagedPath, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : String(err);
    throw badRequest(`Could not clone ${repoUrl}: ${message.split("\n").slice(-2).join(" ")}`);
  }

  const sha = git(stagedPath, ["rev-parse", "HEAD"]).trim();
  const readmePath = ["README.md", "readme.md", "Readme.md"]
    .map((f) => join(stagedPath, f))
    .find((f) => existsSync(f) && statSync(f).size < MAX_FILE_BYTES);

  return {
    name,
    repoUrl,
    ref,
    sha,
    assets: scanPack(stagedPath),
    stagedPath,
    readme: readmePath ? readFileSync(readmePath, "utf8").slice(0, 4000) : "",
  };
}

/** Throw a staged clone away — the user looked and said no. */
export function discardStaged(stagedPath: string): void {
  if (!stagedPath.startsWith(join(PACKS_DIR, ".staging-"))) {
    throw badRequest("That is not a staged pack");
  }
  rmSync(stagedPath, { recursive: true, force: true });
}

// -- install ------------------------------------------------------------------

export interface InstallResult {
  pack: Pack;
  installed: PackAsset[];
}

/**
 * Register the chosen assets and keep the clone.
 *
 * `relPaths` is the user's selection from the preview, so installing is never
 * "everything the repo happened to contain".
 */
export function installPack(
  preview: Pick<PackPreview, "name" | "repoUrl" | "ref" | "sha" | "stagedPath">,
  relPaths: readonly string[],
): InstallResult {
  const existing = db.select().from(schema.packs).where(eq(schema.packs.name, preview.name)).get();
  if (existing) throw badRequest(`A pack called ${preview.name} is already installed`);

  const target = join(PACKS_DIR, preview.name);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  // A rename rather than a copy: the staged clone is already the right bytes,
  // and a second clone would be a second chance for the remote to differ.
  execFileSync("mv", [preview.stagedPath, target], { timeout: CLONE_TIMEOUT_MS });

  const packId = newId();
  const now = nowIso();
  db.insert(schema.packs)
    .values({
      id: packId,
      name: preview.name,
      repoUrl: preview.repoUrl,
      ref: preview.ref,
      sha: preview.sha,
      installedPath: target,
      scriptsEnabled: false,
      installedAt: now,
      updatedAt: now,
    })
    .run();

  const chosen = new Set(relPaths);
  const installed: PackAsset[] = [];
  for (const asset of scanPack(target)) {
    if (!chosen.has(asset.relPath)) continue;
    installed.push(register(packId, target, asset, preview.name));
  }

  return {
    pack: db.select().from(schema.packs).where(eq(schema.packs.id, packId)).get()!,
    installed,
  };
}

/**
 * Turn one scanned asset into a row of this app's own.
 *
 * Every branch goes through the same function a manual import uses, so a pack
 * asset is indistinguishable afterwards from one somebody uploaded — including
 * the de-duplication rules that give a clashing name a suffix instead of
 * overwriting what was there.
 */
function register(packId: string, root: string, asset: ScannedAsset, packName: string): PackAsset {
  const row = {
    id: newId(),
    packId,
    kind: asset.kind,
    relPath: asset.relPath,
    name: asset.name,
    refId: null as string | null,
    status: "installed",
    createdAt: nowIso(),
  };

  try {
    if (asset.kind === "script") {
      // Deliberately inert: recorded so it is visible in the pack's asset list
      // and so uninstall knows it was there. Nothing links it anywhere.
      row.status = "skipped";
    } else if (asset.kind === "skill") {
      const files = (asset.files ?? [asset.relPath])
        .filter((f) => statSync(join(root, f)).size <= MAX_FILE_BYTES)
        .map((f) => ({
          relPath: asset.relPath === "SKILL.md" ? f : f.slice(asset.relPath.lastIndexOf("/") + 1),
          data: readFileSync(join(root, f)),
        }));
      // Through the library's own importer, not straight to `linkSkillTree`.
      // Going direct symlinked the skill but wrote no `knowledge_items` row, so
      // the same skill appeared in the Knowledge tab when someone uploaded it
      // and nowhere when a pack installed it. One skill, one place, however it
      // arrived — the pack only adds where it came from.
      const item = importFolder({
        projectId: null,
        rootName: asset.name,
        files,
        folder: `packs/${packName}`,
      });
      row.name = item.name;
      row.refId = item.id;
    } else if (asset.kind === "agent") {
      const agent = importAgentMarkdown(
        basename(asset.relPath),
        readFileSync(join(root, asset.relPath), "utf8"),
      );
      row.name = agent.name;
      row.refId = agent.id;
    } else if (asset.kind === "workflow") {
      const workflow = importWorkflowYaml(
        readFileSync(join(root, asset.relPath), "utf8"),
        basename(asset.relPath),
      );
      // Same folder as the pack's skills, so the library groups a pack together
      // instead of scattering it through an alphabetical list.
      setWorkflowFolder(workflow.id, `packs/${packName}`);
      row.name = workflow.name;
      row.refId = workflow.id;
    }
  } catch (err) {
    // One bad file must not abort the set: the row says what happened, and the
    // rest of the pack still installs.
    row.status = "conflict";
    row.name = `${asset.name} — ${err instanceof Error ? err.message.slice(0, 80) : "failed"}`;
  }

  db.insert(schema.packAssets).values(row).run();
  return row as PackAsset;
}

// -- reading, updating, removing ----------------------------------------------

export function listPacks(): (Pack & { assets: PackAsset[] })[] {
  const rows = db.select().from(schema.packs).all();
  return rows.map((pack) => ({
    ...pack,
    assets: db.select().from(schema.packAssets).where(eq(schema.packAssets.packId, pack.id)).all(),
  }));
}

export function getPack(id: string): Pack | null {
  return db.select().from(schema.packs).where(eq(schema.packs.id, id)).get() ?? null;
}

/**
 * What changed upstream since this pack was installed.
 *
 * Fetches, compares, and returns the difference — it does not apply it. Applying
 * is `updatePack`, which is a separate decision because it changes what runs on
 * this machine.
 */
export function packDiff(id: string): {
  sha: string;
  behind: boolean;
  added: string[];
  removed: string[];
  changed: string[];
} | null {
  const pack = getPack(id);
  if (!pack || !existsSync(pack.installedPath)) return null;
  try {
    git(pack.installedPath, ["fetch", "--depth", "1", "origin", pack.ref]);
    const head = git(pack.installedPath, ["rev-parse", "FETCH_HEAD"]).trim();
    if (head === pack.sha) return { sha: head, behind: false, added: [], removed: [], changed: [] };

    const out = git(pack.installedPath, ["diff", "--name-status", pack.sha, head]);
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const line of out.split("\n")) {
      const [status, path] = line.split("\t");
      if (!path) continue;
      if (status?.startsWith("A")) added.push(path);
      else if (status?.startsWith("D")) removed.push(path);
      else changed.push(path);
    }
    return { sha: head, behind: true, added, removed, changed };
  } catch {
    return null;
  }
}

/**
 * Move the pack to the fetched commit and re-register its assets.
 *
 * Assets the user edited here are not protected — and that is why this is behind
 * a diff. Re-registering goes through the same de-duplicating import as the
 * first install, so an edited skill gets a new name rather than being silently
 * replaced.
 */
/**
 * What an update attempt ended as.
 *
 * `current` is not a failure and must not be reported as one — it is what
 * pressing the button usually means, and the first version answered it with a
 * 409 the UI swallowed, so the button looked broken every time it worked.
 */
export type UpdateOutcome =
  | { status: "missing" }
  | { status: "unreachable" }
  | { status: "current"; sha: string }
  | { status: "updated"; sha: string; from: string; installed: PackAsset[] };

export function updatePack(id: string): UpdateOutcome {
  const pack = getPack(id);
  if (!pack || !existsSync(pack.installedPath)) return { status: "missing" };
  const diff = packDiff(id);
  if (!diff) return { status: "unreachable" };
  if (!diff.behind) return { status: "current", sha: diff.sha };
  const from = pack.sha;

  git(pack.installedPath, ["checkout", "--force", diff.sha]);
  const previous = db
    .select()
    .from(schema.packAssets)
    .where(eq(schema.packAssets.packId, id))
    .all();
  for (const asset of previous) unregister(asset);
  db.delete(schema.packAssets).where(eq(schema.packAssets.packId, id)).run();

  const wanted = new Set(previous.map((asset) => asset.relPath));
  const installed: PackAsset[] = [];
  for (const asset of scanPack(pack.installedPath)) {
    if (!wanted.has(asset.relPath)) continue;
    installed.push(register(id, pack.installedPath, asset, pack.name));
  }

  db.update(schema.packs)
    .set({ sha: diff.sha, updatedAt: nowIso() })
    .where(eq(schema.packs.id, id))
    .run();
  return { status: "updated", sha: diff.sha, from, installed };
}

/** Take back what the pack added, then remove the clone. */
export function uninstallPack(id: string): boolean {
  const pack = getPack(id);
  if (!pack) return false;
  for (const asset of db
    .select()
    .from(schema.packAssets)
    .where(eq(schema.packAssets.packId, id))
    .all()) {
    unregister(asset);
  }
  db.delete(schema.packs).where(eq(schema.packs.id, id)).run();
  rmSync(pack.installedPath, { recursive: true, force: true });
  return true;
}

/** Does this id name a row in the library, or is it a pre-Knowledge skill name? */
function knowledgeItemExists(id: string): boolean {
  try {
    return !!db
      .select({ id: schema.knowledgeItems.id })
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, id))
      .get();
  } catch {
    return false;
  }
}

function unregister(asset: PackAsset): void {
  if (!asset.refId || asset.status !== "installed") return;
  try {
    // `deleteKnowledge` unlinks the symlink and removes the stored tree, which
    // is the same thing the Knowledge tab's own delete does — so uninstalling a
    // pack and deleting its skills by hand leave the machine in one state.
    //
    // A pack installed before skills were filed in Knowledge stored the skill's
    // *name* here instead of a row id. Unlinking by name is what that version
    // did, and without this branch those packs would uninstall while leaving
    // every symlink behind.
    if (asset.kind === "skill") {
      if (knowledgeItemExists(asset.refId)) deleteKnowledge(asset.refId);
      // The tree as well as the link: leaving it behind is what made a
      // reinstall come back as `docx-2`.
      else removeSkillTree(asset.name || asset.refId);
    } else if (asset.kind === "agent") deleteAgent(asset.refId);
    else if (asset.kind === "workflow") deleteWorkflow(asset.refId);
  } catch {
    // Already gone by hand — the point was that it should not be here.
  }
}
