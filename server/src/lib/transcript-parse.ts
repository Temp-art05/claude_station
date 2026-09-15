/**
 * Reading a `claude` CLI transcript incrementally, into ledger-shaped events.
 *
 * Locating and listing transcripts is `claude-transcript.ts`'s job; this is the
 * record-level parse, kept separate because it is pure string work and carries
 * the two facts that make it non-obvious:
 *
 *   1. A record of `type: "user"` is usually NOT a user prompt. Tool results come
 *      back as `user` records too — measured on the largest transcript here, 285
 *      of 336 were tool results and only 51 were prompts. Counting them all makes
 *      turn totals wrong by ~6.6x while every number still looks plausible.
 *   2. Never read the whole file. One transcript on this machine is 29MB, and the
 *      follower is called on every append, so reads start from a stored offset and
 *      a half-written last line is carried over rather than parsed.
 *
 * No cost is available here: CLI transcripts carry no `costUSD`/`total_cost_usd`
 * field at all (grepped across 224 files), only token usage. The ledger therefore
 * leaves `costUsd` NULL for this surface instead of inventing it from a price
 * table that would silently rot.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface TranscriptToolUse {
  name: string;
  input: unknown;
  /** True when the call came from a subagent rather than the main thread. */
  sidechain: boolean;
}

/** A real user prompt: the start of a turn. */
export interface PromptEvent {
  kind: "prompt";
  at: string | null;
  text: string;
  cwd: string | null;
  gitBranch: string | null;
}

/** Anything the agent did inside the current turn. */
export interface ActivityEvent {
  kind: "activity";
  at: string | null;
  model: string | null;
  /**
   * The assistant's own prose for this record, tool calls excluded.
   *
   * Carried so the shared-memory bus can pick up the lines the agent explicitly
   * marked to be remembered. Not stored anywhere: the follower scans it and
   * drops it, which is why this is a field and not another table.
   */
  text: string;
  usage: TranscriptUsage;
  tools: TranscriptToolUse[];
  cwd: string | null;
  gitBranch: string | null;
  sidechain: boolean;
}

export type TranscriptEvent = PromptEvent | ActivityEvent;

const EMPTY_USAGE: TranscriptUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
};

export function addUsage(a: TranscriptUsage, b: TranscriptUsage): TranscriptUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreateTokens: a.cacheCreateTokens + b.cacheCreateTokens,
  };
}

export const emptyUsage = (): TranscriptUsage => ({ ...EMPTY_USAGE });

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Whether a `user` record is a prompt the person typed, rather than a tool result
 * being handed back. See fact (1) in the file header.
 */
export function isRealPrompt(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  let hasText = false;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const type = (block as { type?: unknown }).type;
    if (type === "tool_result") return false;
    if (type === "text" && str((block as { text?: unknown }).text)) hasText = true;
  }
  return hasText;
}

/** The prompt's text, from either content shape. */
export function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function usageOf(message: Record<string, unknown> | undefined): TranscriptUsage {
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage) return emptyUsage();
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreateTokens: num(usage.cache_creation_input_tokens),
  };
}

function toolsOf(
  message: Record<string, unknown> | undefined,
  sidechain: boolean,
): TranscriptToolUse[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const out: TranscriptToolUse[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type !== "tool_use" || typeof b.name !== "string") continue;
    out.push({ name: b.name, input: b.input, sidechain });
  }
  return out;
}

/** Text blocks of an assistant message, joined. Empty for a tool-only record. */
function assistantText(message: Record<string, unknown> | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

export interface ParseResult {
  events: TranscriptEvent[];
  /**
   * The trailing text that did not end in a newline. The CLI appends record by
   * record, so the last line of a read is regularly half-written; it must be
   * carried into the next read and NOT counted towards the stored offset.
   */
  leftover: string;
  /** Lines that were complete but did not parse — a capture-health signal. */
  badLines: number;
}

/** Turn a chunk of JSONL into events. Complete lines only. */
export function parseRecords(text: string): ParseResult {
  const lines = text.split("\n");
  const leftover = lines.pop() ?? "";
  const events: TranscriptEvent[] = [];
  let badLines = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      badLines += 1;
      continue;
    }

    const type = record.type;
    // Records the CLI keeps for itself: titles, mode changes, queued prompts (the
    // real `user` record follows), its own file-history bookkeeping.
    if (type !== "user" && type !== "assistant") continue;

    const message = record.message as Record<string, unknown> | undefined;
    const sidechain = record.isSidechain === true;
    const at = str(record.timestamp);
    const cwd = str(record.cwd);
    const gitBranch = str(record.gitBranch);

    if (type === "user") {
      // A subagent's own prompt is not the user's, and a tool result is not a
      // prompt at all: both would start a turn that never happened.
      if (sidechain || !isRealPrompt(message?.content)) continue;
      events.push({ kind: "prompt", at, text: promptText(message?.content), cwd, gitBranch });
      continue;
    }

    events.push({
      kind: "activity",
      at,
      model: str(message?.model),
      text: assistantText(message),
      usage: usageOf(message),
      tools: toolsOf(message, sidechain),
      cwd,
      gitBranch,
      sidechain,
    });
  }

  return { events, leftover, badLines };
}

export interface ReadResult {
  text: string;
  /** Size at the moment of reading — the caller's next offset base. */
  size: number;
  mtimeMs: number;
  /**
   * True when the file is shorter than the offset asked for, which means it was
   * replaced or truncated. The caller has to restart from zero: continuing would
   * read from the middle of a different conversation.
   */
  rewound: boolean;
}

const CHUNK = 1 << 20; // 1MB per read; a 29MB transcript parses in ~55ms end to end

/** Read everything appended after `fromOffset`. Never loads the whole file. */
export function readAppended(file: string, fromOffset: number): ReadResult | null {
  let size: number;
  let mtimeMs: number;
  try {
    const stat = statSync(file);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    return null;
  }

  const rewound = fromOffset > size;
  const start = rewound ? 0 : fromOffset;
  if (start === size) return { text: "", size, mtimeMs, rewound };

  const fd = openSync(file, "r");
  try {
    const parts: Buffer[] = [];
    let pos = start;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      parts.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    return { text: Buffer.concat(parts).toString("utf8"), size, mtimeMs, rewound };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
