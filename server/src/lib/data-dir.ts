import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { REPO_ROOT } from "./repo-root";

/**
 * Runtime data lives inside the repo (`<repo>/data`) so the install is
 * self-contained: delete the repo, nothing is left behind. Override with
 * CLAUDE_STATION_DATA when you want it elsewhere.
 */
function resolveDataDir(): string {
  const override = process.env.CLAUDE_STATION_DATA?.trim();
  if (!override) return join(REPO_ROOT, "data");
  const expanded = override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
  return isAbsolute(expanded) ? expanded : resolve(REPO_ROOT, expanded);
}

export const DATA_DIR = resolveDataDir();

export const DB_PATH = join(DATA_DIR, "claude-station.db");
export const TOKEN_PATH = join(DATA_DIR, ".token");
export const KNOWLEDGE_DIR = join(DATA_DIR, "knowledge");
export const GLOBAL_KNOWLEDGE_DIR = join(KNOWLEDGE_DIR, "global");
export const SKILLS_DIR = join(DATA_DIR, "skills");
export const AGENTS_DIR = join(DATA_DIR, "agents");
export const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");
export const LOGS_DIR = join(DATA_DIR, "logs");
export const WORKTREES_DIR = join(DATA_DIR, "worktrees");
/** Workspace-context files a `claude` terminal reads via --append-system-prompt-file. */
export const TERMINAL_CONTEXT_DIR = join(DATA_DIR, "terminal-context");
/** Config for the station's own tmux server — rewritten on every boot. */
export const TMUX_CONF = join(DATA_DIR, "tmux.conf");
/** Throwaway `.command` scripts macOS Terminal opens to attach a session. */
export const LAUNCHERS_DIR = join(DATA_DIR, "launchers");

/** Where skills get symlinked so Claude Code picks them up at user level. */
export const CLAUDE_SKILLS_LINK_DIR = (() => {
  const override = process.env.CLAUDE_SKILLS_DIR?.trim();
  if (!override) return join(homedir(), ".claude", "skills");
  return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
})();

export function projectKnowledgeDir(projectId: string): string {
  return join(KNOWLEDGE_DIR, projectId);
}

export function ensureDataDirs(): void {
  for (const dir of [
    DATA_DIR,
    KNOWLEDGE_DIR,
    GLOBAL_KNOWLEDGE_DIR,
    SKILLS_DIR,
    AGENTS_DIR,
    ATTACHMENTS_DIR,
    LOGS_DIR,
    WORKTREES_DIR,
    TERMINAL_CONTEXT_DIR,
    LAUNCHERS_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
