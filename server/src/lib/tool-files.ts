/**
 * Which files a tool call touched, from the call itself.
 *
 * Both capture surfaces need exactly this mapping — the Agent SDK reads it off a
 * live `tool_use` block, the transcript follower off the same block replayed from
 * JSONL — so it lives here rather than being written twice and drifting.
 *
 * What this can and cannot see, measured on 224 transcripts (see
 * `docs/plans/session-ledger.md`): a tool call names its file, so `Edit` and
 * `Write` are exact. An edit made through `Bash` (`sed -i`, a heredoc, `tee`)
 * names nothing and is invisible here — the CLI's own `file-history-delta`
 * records miss it too. That gap is closed by the working-tree snapshot at the
 * turn boundary, not by adding guesswork to this file: a path mentioned in a
 * shell command is not evidence the command wrote it.
 */
import { isAbsolute, resolve } from "node:path";

export type ToolFileOp = "read" | "write" | "delete";

export interface ToolFileTouch {
  absPath: string;
  op: ToolFileOp;
  toolName: string;
}

/** Tools that name the file they act on, and what acting means for each. */
const FILE_TOOLS: Record<string, { op: ToolFileOp; keys: string[] }> = {
  Read: { op: "read", keys: ["file_path", "notebook_path"] },
  Edit: { op: "write", keys: ["file_path"] },
  MultiEdit: { op: "write", keys: ["file_path"] },
  Write: { op: "write", keys: ["file_path"] },
  NotebookEdit: { op: "write", keys: ["notebook_path", "file_path"] },
};

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Files named by one tool call. `cwd` is the turn's working directory, used only
 * to absolutise a relative path — tools normally pass absolute ones.
 *
 * Returns an empty list for every tool that doesn't name a file, `Bash` included.
 */
export function filesFromToolUse(toolName: string, input: unknown, cwd: string): ToolFileTouch[] {
  const spec = FILE_TOOLS[toolName];
  if (!spec || typeof input !== "object" || input === null) return [];
  const path = firstString(input as Record<string, unknown>, spec.keys);
  if (!path) return [];
  return [{ absPath: isAbsolute(path) ? path : resolve(cwd, path), op: spec.op, toolName }];
}

/**
 * How a tool call should be labelled in the ledger.
 *
 * A `Task` is a subagent, and its own edits never appear in the parent's tool
 * calls. It is still worth naming which subagent ran: the working-tree snapshot
 * will attribute the files to this turn, and the label is the only thing that
 * says who did the work inside it.
 */
export function toolLabel(toolName: string, input: unknown): string {
  if (toolName !== "Task" || typeof input !== "object" || input === null) return toolName;
  const agent = (input as Record<string, unknown>).subagent_type;
  return typeof agent === "string" && agent.trim() ? `Task:${agent.trim()}` : "Task";
}
