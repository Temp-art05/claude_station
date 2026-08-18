/**
 * Building the `claude` command line for a PTY terminal. Pure string work — the
 * DB/filesystem lookups that feed it live in services/terminals.ts, so this stays
 * testable on its own.
 */

/** Quote for `zsh -c`: paths and file names are interpolated into that command. */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ClaudeCliContext {
  /** Passed as --append-system-prompt-file; omit when there is no context to give. */
  contextFile?: string;
  /** Passed as one --add-dir each; the CLI may Read outside its cwd only here. */
  extraDirs?: string[];
  /**
   * The conversation this terminal owns. Given one, the CLI is pinned to it
   * (--session-id) and resumed by id (--resume) — `--continue` picks whichever
   * conversation in the directory is newest, which is the wrong one as soon as
   * two Claude tabs share a repo.
   */
  sessionId?: string;
}

/**
 * `restart` resumes the previous conversation, falling back to a fresh one. The
 * flags are repeated on the fallback branch on purpose: without them a failed
 * resume would silently drop the workspace context.
 */
export function buildClaudeCommand(restart: boolean, ctx: ClaudeCliContext = {}): string {
  const parts = [
    ...(ctx.contextFile ? [`--append-system-prompt-file ${shq(ctx.contextFile)}`] : []),
    ...(ctx.extraDirs ?? []).map((d) => `--add-dir ${shq(d)}`),
  ];
  const flags = parts.length > 0 ? ` ${parts.join(" ")}` : "";

  if (!ctx.sessionId) {
    // Rows from before session ids existed: the old, best-effort behaviour.
    return restart ? `claude --continue${flags} || claude${flags}` : `claude${flags}`;
  }

  const pin = `claude --session-id ${shq(ctx.sessionId)}${flags}`;
  // The fallback only fires when the transcript is gone (the CLI prunes its own),
  // and then the id is free again — so it reopens the same id, fresh.
  return restart ? `claude --resume ${shq(ctx.sessionId)}${flags} || ${pin}` : pin;
}
