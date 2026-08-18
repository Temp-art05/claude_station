/**
 * The `claude` CLI's own transcripts, so deleting a session from the History
 * panel really deletes the conversation and not just our row.
 *
 * Files live at ~/.claude/projects/<slug-of-cwd>/<session-uuid>.jsonl. The slug
 * rule is the CLI's business and undocumented, so we never derive it — the uuid
 * is unique, so the file is found by name across the project directories.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * The CLI only ever accepts a uuid here; anything else must not reach the fs.
 * Deliberately layout-only, not RFC-strict on the version/variant nibbles: what
 * matters is that it can't escape the transcript directory, and the id is the
 * CLI's to choose. (`z.string().uuid()` rejects anything that isn't v1–v8, which
 * would turn a perfectly good file name into a 400.)
 */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = SESSION_ID;

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

/** One `claude` conversation on disk, as the History panel lists it. */
export interface CliTranscript {
  sessionId: string;
  cwd: string;
  gitBranch: string | null;
  title: string;
  sizeBytes: number;
  /** Last write — the CLI appends per message, so this is when it was last used. */
  modifiedAt: string;
}

/**
 * Head is usually enough for `cwd` (it sits in the fourth record), but a first
 * message with a pasted image can push it past any sane head size — measured on
 * this machine, 94 of 184 files. Every `user`/`assistant` record carries `cwd`
 * too, so the tail closes the gap: 184/184 in 15ms. Never read a whole file; one
 * of them is 16MB.
 */
const HEAD_BYTES = 8192;
const TAIL_BYTES = 65536;

function readEnds(file: string, size: number): { head: string; tail: string } {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    readSync(fd, head, 0, head.byteLength, 0);
    if (size <= HEAD_BYTES) return { head: head.toString("utf8"), tail: "" };
    const tailLen = Math.min(TAIL_BYTES, size - HEAD_BYTES);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    return { head: head.toString("utf8"), tail: tail.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** Scans JSONL text for a key, from either end. Truncated lines just don't parse. */
function pick(text: string, key: string, fromEnd = false): string | null {
  const lines = text.split("\n");
  if (fromEnd) lines.reverse();
  for (const line of lines) {
    if (!line.includes(`"${key}"`)) continue;
    try {
      const value = (JSON.parse(line) as Record<string, unknown>)[key];
      if (typeof value === "string" && value) return value;
    } catch {
      /* first/last line of a window is usually cut in half */
    }
  }
  return null;
}

/** First user text, for a conversation the CLI never got round to titling. */
function firstUserText(head: string): string | null {
  for (const line of head.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content.find(
                (b): b is { type: string; text: string } =>
                  typeof b === "object" &&
                  b !== null &&
                  (b as { type?: unknown }).type === "text" &&
                  typeof (b as { text?: unknown }).text === "string",
              )?.text ?? null)
            : null;
      if (text) return text.replace(/\s+/g, " ").trim().slice(0, 80);
    } catch {
      /* unparseable line */
    }
  }
  return null;
}

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: CliTranscript;
}
const cache = new Map<string, CacheEntry>();

function parseTranscript(file: string, sessionId: string): CliTranscript | null {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed;

  const { head, tail } = readEnds(file, stat.size);
  const cwd = pick(head, "cwd") ?? pick(tail, "cwd", true);
  if (!cwd) return null;
  const parsed: CliTranscript = {
    sessionId,
    cwd,
    // Both change mid-conversation; the last value is the current one.
    gitBranch: pick(tail, "gitBranch", true) ?? pick(head, "gitBranch", true),
    title: pick(tail, "aiTitle", true) ?? pick(head, "aiTitle", true) ?? firstUserText(head) ?? "(untitled)",
    sizeBytes: stat.size,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
  };
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return parsed;
}

/**
 * Every conversation the CLI has kept, newest first. Only one level down: a
 * `<uuid>/subagents/*.jsonl` is part of a conversation, not one of its own, and
 * the CLI's own resume picker doesn't list them either.
 */
export function listTranscripts(root: string = PROJECTS_DIR): CliTranscript[] {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const out: CliTranscript[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const uuid = UUID_FILE.exec(name)?.[1];
      if (!uuid) continue;
      const parsed = parseTranscript(join(root, dir, name), uuid);
      if (parsed) out.push(parsed);
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Conversations that ran in one of these directories, or below one of them. */
export function transcriptsUnder(paths: string[], root: string = PROJECTS_DIR): CliTranscript[] {
  const roots = paths.filter(Boolean);
  return listTranscripts(root).filter((t) =>
    roots.some((p) => t.cwd === p || t.cwd.startsWith(p.endsWith(sep) ? p : p + sep)),
  );
}
