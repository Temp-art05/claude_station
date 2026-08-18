import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { LOGS_DIR } from "../lib/data-dir";
import { childBaseEnv } from "../lib/child-env";
import { newId, nowIso } from "../lib/id";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { envVarsFor } from "./env-sets";

export interface RunListener {
  onChunk(chunk: Buffer): void;
  onExit(code: number | null): void;
}

interface ActiveRun {
  runId: string;
  pid: number | undefined;
  listeners: Set<RunListener>;
  tail: Buffer[];
  tailBytes: number;
  timer: NodeJS.Timeout;
}

const active = new Map<string, ActiveRun>();

function pushTail(run: ActiveRun, chunk: Buffer): void {
  run.tail.push(chunk);
  run.tailBytes += chunk.byteLength;
  const cap = setting("log.streamTailBytes");
  while (run.tailBytes > cap && run.tail.length > 1) {
    const dropped = run.tail.shift();
    if (dropped) run.tailBytes -= dropped.byteLength;
  }
}

export interface StartRunInput {
  projectId: string;
  pathCommandId: string;
  origin: "ui" | "claude";
  sessionId?: string | null;
  /** Appended to the stored command — never replaces it. */
  extraArgs?: string;
  envSetId?: string | null;
}

export interface StartRunResult {
  runId: string;
  /** Resolves when the process exits — used by the Claude tool, not by the UI. */
  done: Promise<{ exitCode: number | null; tail: string }>;
}

/**
 * Only commands already stored on a project path can run: the client (and
 * Claude) pass an id, never a shell string, so there is nothing to inject.
 * Shared with the "run this in my own terminal" handoff, which must resolve the
 * command exactly the same way.
 */
export function resolveCommandTarget(pathCommandId: string, projectId: string) {
  const cmd = db
    .select()
    .from(schema.pathCommands)
    .where(eq(schema.pathCommands.id, pathCommandId))
    .get();
  if (!cmd) throw badRequest("Command not found");

  const path = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.id, cmd.projectPathId))
    .get();
  if (!path) throw badRequest("Command's path no longer exists");
  if (path.projectId !== projectId) throw badRequest("Command belongs to another project");

  return { cmd, path, cwd: assertPathAllowed(cmd.cwdOverride ?? path.path, projectId) };
}

export function startRun(input: StartRunInput): StartRunResult {
  const { cmd, path, cwd } = resolveCommandTarget(input.pathCommandId, input.projectId);
  const fullCommand = input.extraArgs ? `${cmd.command} ${input.extraArgs}` : cmd.command;

  const runId = newId();
  const logPath = join(LOGS_DIR, `${runId}.log`);
  const startedAt = nowIso();

  db.insert(schema.commandRuns)
    .values({
      id: runId,
      projectId: input.projectId,
      pathCommandId: cmd.id,
      name: cmd.name,
      command: fullCommand,
      cwd,
      exitCode: null,
      logPath,
      origin: input.origin,
      sessionId: input.sessionId ?? null,
      startedAt,
      finishedAt: null,
    })
    .run();

  // No explicit set → the repo's own default, so Claude's runs get it too.
  const env = { ...childBaseEnv(), ...envVarsFor(input.envSetId ?? path.envSetId), CI: "1" };

  const logStream = createWriteStream(logPath, { flags: "a" });
  logStream.write(`$ ${fullCommand}\n(cwd: ${cwd})\n\n`);

  // detached → own process group, so killing takes gradle/xcodebuild children too.
  const child = spawn(fullCommand, {
    shell: true,
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const run: ActiveRun = {
    runId,
    pid: child.pid,
    listeners: new Set(),
    tail: [],
    tailBytes: 0,
    timer: setTimeout(() => {
      logStream.write(`\n[claude-station] timeout after ${cmd.timeoutSec}s — killing\n`);
      killRun(runId);
    }, cmd.timeoutSec * 1000),
  };
  active.set(runId, run);

  const onData = (chunk: Buffer) => {
    logStream.write(chunk);
    pushTail(run, chunk);
    for (const l of run.listeners) l.onChunk(chunk);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const done = new Promise<{ exitCode: number | null; tail: string }>((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(run.timer);
      const exitCode = code ?? (signal ? 128 : null);
      logStream.write(`\n[claude-station] exit ${exitCode ?? "signal:" + signal}\n`);
      logStream.end();
      db.update(schema.commandRuns)
        .set({ exitCode, finishedAt: nowIso() })
        .where(eq(schema.commandRuns.id, runId))
        .run();
      db.insert(schema.workHistory)
        .values({
          id: newId(),
          projectId: input.projectId,
          kind: "command_run",
          refId: runId,
          summary: `${cmd.name} → exit ${exitCode ?? "?"} (${input.origin})`,
          createdAt: nowIso(),
        })
        .run();
      for (const l of run.listeners) l.onExit(exitCode);
      active.delete(runId);
      resolve({ exitCode, tail: tailLog(logPath, setting("log.toolTailBytes")) });
    });
    child.on("error", (err) => {
      logStream.write(`\n[claude-station] spawn error: ${err.message}\n`);
    });
  });

  return { runId, done };
}

export function attachRun(runId: string, listener: RunListener): (() => void) | null {
  const run = active.get(runId);
  if (!run) return null;
  for (const chunk of run.tail) listener.onChunk(chunk);
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

export function killRun(runId: string): boolean {
  const run = active.get(runId);
  if (!run?.pid) return false;
  try {
    process.kill(-run.pid, "SIGTERM"); // negative pid = whole process group
  } catch {
    try {
      process.kill(run.pid, "SIGTERM");
    } catch {
      return false;
    }
  }
  return true;
}

export function isRunActive(runId: string): boolean {
  return active.has(runId);
}

/** Read the last N bytes of a log without loading a 200MB xcodebuild log. */
export function tailLog(logPath: string, bytes: number): string {
  if (!existsSync(logPath)) return "";
  const size = statSync(logPath).size;
  const start = Math.max(0, size - bytes);
  const length = size - start;
  if (length <= 0) return "";
  const fd = openSync(logPath, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    const text = buf.toString("utf8");
    return start > 0 ? `…(truncated ${start} bytes)…\n${text}` : text;
  } finally {
    closeSync(fd);
  }
}

export function readLogSlice(logPath: string, offset: number): { data: string; next: number } {
  if (!existsSync(logPath)) return { data: "", next: offset };
  const full = readFileSync(logPath);
  const slice = full.subarray(Math.min(offset, full.byteLength));
  return { data: slice.toString("utf8"), next: full.byteLength };
}

export function killAllRuns(): void {
  for (const id of [...active.keys()]) killRun(id);
}
