/**
 * Opening a real terminal window. We hand macOS a `.command` script instead of
 * scripting Terminal.app over AppleScript: no command string has to survive two
 * layers of quoting, and `open -a` works the same for iTerm2/Ghostty.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { badRequest } from "./path-safety";
import { LAUNCHERS_DIR } from "./data-dir";

const exec = promisify(execFile);

/** A launcher is read once, right after it is opened. Anything older is litter. */
const LAUNCHER_TTL_MS = 60 * 60 * 1000;

function pruneLaunchers(): void {
  let names: string[];
  try {
    names = readdirSync(LAUNCHERS_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - LAUNCHER_TTL_MS;
  for (const name of names) {
    const file = join(LAUNCHERS_DIR, name);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch {
      /* raced with another prune */
    }
  }
}

export function launcherFileName(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || "session"}.command`;
}

/**
 * Writes an executable launcher. Mode 0700 because a command launcher carries the
 * env set's values, secrets included, in plain text.
 */
export function writeLauncher(label: string, body: string[]): string {
  mkdirSync(LAUNCHERS_DIR, { recursive: true });
  pruneLaunchers();
  const file = join(LAUNCHERS_DIR, launcherFileName(label));
  writeFileSync(
    file,
    ["#!/bin/zsh", "# claude-station launcher — safe to delete.", ...body, ""].join("\n"),
    "utf8",
  );
  chmodSync(file, 0o700);
  return file;
}

export async function openWith(app: string, file: string): Promise<void> {
  const name = app.trim();
  if (!name) throw badRequest("No terminal app configured (Settings → Open terminals with)");
  try {
    await exec("open", ["-a", name, file], { timeout: 15000 });
  } catch (err) {
    throw badRequest(
      `Could not open ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
