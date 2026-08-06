import { spawn, type IPty } from "node-pty";
import { childBaseEnv } from "../lib/child-env";
import { setting } from "../lib/config";

export interface PtyListener {
  onData(chunk: Buffer): void;
  onExit(code: number | null): void;
}

interface Managed {
  pty: IPty;
  /** Ring buffer of recent output so a reconnecting tab sees its scrollback. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  listeners: Set<PtyListener>;
  exited: boolean;
  exitCode: number | null;
}

const sessions = new Map<string, Managed>();

function trimScrollback(m: Managed): void {
  const cap = setting("terminal.scrollbackBytes");
  while (m.scrollbackBytes > cap && m.scrollback.length > 1) {
    const dropped = m.scrollback.shift();
    if (dropped) m.scrollbackBytes -= dropped.byteLength;
  }
}

export interface StartOptions {
  id: string;
  cwd: string;
  env?: Record<string, string>;
  shell?: string;
  /** Run this instead of an interactive shell; the PTY exits when it does. */
  command?: string;
  cols?: number;
  rows?: number;
}

export function start(opts: StartOptions): { pid: number } {
  if (sessions.has(opts.id)) throw new Error(`Terminal ${opts.id} already running`);

  const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
  // Station-internal vars are stripped; node-pty needs a plain string map.
  const baseEnv = childBaseEnv();

  // Login + interactive so PATH shims (nvm/asdf/…) resolve the command.
  const args = opts.command ? ["-l", "-i", "-c", opts.command] : ["-l"];
  const pty = spawn(shell, args, {
    name: "xterm-256color",
    cwd: opts.cwd,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    env: { ...baseEnv, ...opts.env, TERM: "xterm-256color" },
  });

  const managed: Managed = {
    pty,
    scrollback: [],
    scrollbackBytes: 0,
    listeners: new Set(),
    exited: false,
    exitCode: null,
  };
  sessions.set(opts.id, managed);

  pty.onData((data) => {
    const chunk = Buffer.from(data, "utf8");
    managed.scrollback.push(chunk);
    managed.scrollbackBytes += chunk.byteLength;
    trimScrollback(managed);
    for (const l of managed.listeners) l.onData(chunk);
  });

  pty.onExit(({ exitCode }) => {
    managed.exited = true;
    managed.exitCode = exitCode;
    for (const l of managed.listeners) l.onExit(exitCode);
    sessions.delete(opts.id);
  });

  return { pid: pty.pid };
}

export function attach(id: string, listener: PtyListener): () => void {
  const m = sessions.get(id);
  if (!m) return () => {};
  // Replay scrollback so the tab looks the same after a reload.
  for (const chunk of m.scrollback) listener.onData(chunk);
  m.listeners.add(listener);
  return () => m.listeners.delete(listener);
}

export function write(id: string, data: string): boolean {
  const m = sessions.get(id);
  if (!m || m.exited) return false;
  m.pty.write(data);
  return true;
}

export function resize(id: string, cols: number, rows: number): void {
  const m = sessions.get(id);
  if (!m || m.exited) return;
  try {
    m.pty.resize(cols, rows);
  } catch {
    /* pty may have died between checks */
  }
}

export function kill(id: string): void {
  const m = sessions.get(id);
  if (!m) return;
  try {
    m.pty.kill();
  } catch {
    /* already gone */
  }
}

export function isRunning(id: string): boolean {
  return sessions.has(id);
}

export function runningIds(): string[] {
  return [...sessions.keys()];
}

/** Called on SIGINT/SIGTERM — never leave orphaned shells behind. */
export function killAll(): void {
  for (const id of [...sessions.keys()]) kill(id);
}
