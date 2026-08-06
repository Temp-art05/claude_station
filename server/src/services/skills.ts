import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CLAUDE_SKILLS_LINK_DIR, SKILLS_DIR } from "../lib/data-dir";
import { badRequest } from "../lib/path-safety";

/**
 * Skill sources stay in the repo's data dir; a symlink in the user-level skills
 * directory is what makes Claude Code load them (`settingSources: ['user', …]`).
 * Unlinking removes only the link, never the content.
 */
export function linkSkill(name: string, skillMd: Buffer): { dir: string; linked: string | null } {
  const safe = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw badRequest("Invalid skill name");

  const dir = join(SKILLS_DIR, safe);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd);

  const linkPath = join(CLAUDE_SKILLS_LINK_DIR, safe);
  try {
    mkdirSync(CLAUDE_SKILLS_LINK_DIR, { recursive: true });
    if (existsSync(linkPath) || isBrokenLink(linkPath)) {
      // Replace our own link; refuse to clobber a real directory the user owns.
      if (isOurLink(linkPath, dir) || isBrokenLink(linkPath)) rmSync(linkPath, { recursive: true });
      else return { dir, linked: null };
    }
    symlinkSync(dir, linkPath, "dir");
    return { dir, linked: linkPath };
  } catch {
    return { dir, linked: null };
  }
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
