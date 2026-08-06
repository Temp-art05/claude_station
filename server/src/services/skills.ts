import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { CLAUDE_SKILLS_LINK_DIR, SKILLS_DIR } from "../lib/data-dir";
import { badRequest } from "../lib/path-safety";

/**
 * Skill sources stay in the repo's data dir; a symlink in the user-level skills
 * directory is what makes Claude Code load them (`settingSources: ['user', …]`).
 * Unlinking removes only the link, never the content.
 */
export function linkSkill(name: string, skillMd: Buffer): { dir: string; linked: string | null } {
  // Single SKILL.md re-import overwrites in place, so updating a skill stays easy.
  const { dir, linked } = writeSkillTree(name, [{ relPath: "SKILL.md", data: skillMd }], {
    overwrite: true,
  });
  return { dir, linked };
}

/**
 * A folder-shaped skill: SKILL.md plus references/scripts/assets. Never
 * overwrites an existing skill — clashes get a -2/-3 suffix, and the SKILL.md
 * frontmatter `name:` is rewritten to match so Claude Code sees a unique name.
 */
export function linkSkillTree(
  name: string,
  files: { relPath: string; data: Buffer }[],
): { dir: string; linked: string | null; finalName: string } {
  return writeSkillTree(name, files, { overwrite: false });
}

function writeSkillTree(
  name: string,
  files: { relPath: string; data: Buffer }[],
  opts: { overwrite: boolean },
): { dir: string; linked: string | null; finalName: string } {
  let safe = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw badRequest("Invalid skill name");

  if (!opts.overwrite) {
    const base = safe;
    for (let n = 2; existsSync(join(SKILLS_DIR, safe)); n += 1) safe = `${base}-${n}`;
    if (safe !== base) files = renameInFrontmatter(files, safe);
  }

  const dir = join(SKILLS_DIR, safe);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const target = join(dir, file.relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.data);
  }

  const linkPath = join(CLAUDE_SKILLS_LINK_DIR, safe);
  try {
    mkdirSync(CLAUDE_SKILLS_LINK_DIR, { recursive: true });
    if (existsSync(linkPath) || isBrokenLink(linkPath)) {
      // Replace our own link; refuse to clobber a real directory the user owns.
      if (isOurLink(linkPath, dir) || isBrokenLink(linkPath)) rmSync(linkPath, { recursive: true });
      else return { dir, linked: null, finalName: safe };
    }
    symlinkSync(dir, linkPath, "dir");
    return { dir, linked: linkPath, finalName: safe };
  } catch {
    return { dir, linked: null, finalName: safe };
  }
}

/** On a de-conflict rename, keep the frontmatter name in sync with the dir. */
function renameInFrontmatter(
  files: { relPath: string; data: Buffer }[],
  finalName: string,
): { relPath: string; data: Buffer }[] {
  return files.map((file) => {
    if (file.relPath !== "SKILL.md") return file;
    try {
      const parsed = matter(file.data.toString("utf8"));
      parsed.data.name = finalName;
      return { relPath: file.relPath, data: Buffer.from(matter.stringify(parsed.content, parsed.data)) };
    } catch {
      return file;
    }
  });
}

function isBrokenLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
}

function isOurLink(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

export function unlinkSkill(name: string): void {
  const safe = name.replace(/[^\w.-]+/g, "-");
  const linkPath = join(CLAUDE_SKILLS_LINK_DIR, safe);
  if (isOurLink(linkPath, join(SKILLS_DIR, safe)) || isBrokenLink(linkPath)) {
    rmSync(linkPath, { recursive: true, force: true });
  }
}

export function skillLinkState(name: string): "linked" | "unlinked" | "conflict" {
  const safe = name.replace(/[^\w.-]+/g, "-");
  const linkPath = join(CLAUDE_SKILLS_LINK_DIR, safe);
  if (!existsSync(linkPath) && !isBrokenLink(linkPath)) return "unlinked";
  return isOurLink(linkPath, join(SKILLS_DIR, safe)) ? "linked" : "conflict";
}
