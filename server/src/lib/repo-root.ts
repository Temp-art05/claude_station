import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this file to the workspace root (the package.json that declares
 * `workspaces`). Deliberately not process.cwd() — that changes depending on
 * where the command was typed, and every data path is relative to the repo.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);
  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
        if (pkg.workspaces) return dir;
      } catch {
        /* malformed package.json — keep walking */
      }
    }
    if (dir === root) {
      throw new Error("Could not locate repo root (no package.json with `workspaces` above this file)");
    }
    dir = dirname(dir);
  }
}

export const REPO_ROOT = findRepoRoot();
