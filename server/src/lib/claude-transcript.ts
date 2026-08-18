/**
 * The `claude` CLI's own transcripts, so deleting a session from the History
 * panel really deletes the conversation and not just our row.
 *
 * Files live at ~/.claude/projects/<slug-of-cwd>/<session-uuid>.jsonl. The slug
 * rule is the CLI's business and undocumented, so we never derive it — the uuid
 * is unique, so the file is found by name across the project directories.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** The CLI only ever accepts a uuid here; anything else must not reach the fs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function transcriptPath(sessionId: string | null): string | null {
  if (!sessionId || !UUID.test(sessionId)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  const name = `${sessionId}.jsonl`;
  for (const dir of dirs) {
    const file = join(PROJECTS_DIR, dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

export function hasTranscript(sessionId: string | null): boolean {
  return transcriptPath(sessionId) !== null;
}

/** Irreversible: after this, `claude --resume <id>` has nothing to resume. */
export function removeTranscript(sessionId: string | null): boolean {
  const file = transcriptPath(sessionId);
  if (!file) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
