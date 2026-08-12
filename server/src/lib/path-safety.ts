import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { DATA_DIR } from "./data-dir";
import { REPO_ROOT } from "./repo-root";

export function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function forbidden(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 403 });
}

export function tooLarge(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 413 });
}

/** Expand `~`, resolve relative input against the repo, then canonicalise. */
export function expandPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw badRequest("Path is empty");
  const expanded = trimmed.startsWith("~")
    ? join(homedir(), trimmed.slice(1))
    : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(REPO_ROOT, expanded);
}

/** A project path must exist and be a directory — catch typos at save time. */
export function resolveDirectory(input: string): string {
  const abs = expandPath(input);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw badRequest(`Path is not an existing directory: ${abs}`);
  }
  return realpathSync(abs);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Every path the app is allowed to touch: the data dir + registered project paths. */
export function allowedRoots(projectId?: string): string[] {
  const rows = projectId
    ? db
        .select()
        .from(schema.projectPaths)
        .where(eq(schema.projectPaths.projectId, projectId))
        .all()
    : db.select().from(schema.projectPaths).all();
  const roots = [DATA_DIR, ...rows.map((r) => r.path)];
  return roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return resolve(r);
    }
  });
}

/**
 * Guard for any filesystem path that came from the client (or from Claude):
 * canonicalise first, then require it to sit under an allowed root. Resolving
 * before comparing is what defeats `..` and symlink escapes.
 */
export function assertPathAllowed(input: string, projectId?: string): string {
  const abs = expandPath(input);
  let canonical = abs;
  try {
    canonical = realpathSync(abs);
  } catch {
    // Target may not exist yet (a file about to be written) — check its parent.
    const parent = abs.slice(0, abs.lastIndexOf(sep)) || sep;
    try {
      canonical = join(realpathSync(parent), abs.slice(abs.lastIndexOf(sep) + 1));
    } catch {
      throw badRequest(`Path does not resolve: ${input}`);
    }
  }
  const roots = allowedRoots(projectId);
  if (!roots.some((root) => isInside(canonical, root))) {
    throw forbidden(`Path outside allowed roots: ${canonical}`);
  }
  return canonical;
}

/** Display form — collapse the home prefix so the UI stays readable. */
export function prettyPath(abs: string): string {
  const home = homedir();
  return isInside(abs, home) ? `~${abs.slice(home.length)}` : abs;
}
