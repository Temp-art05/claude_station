import { spawn, type IPty } from "node-pty";
import { childBaseEnv } from "../lib/child-env";
import { setting } from "../lib/config";
import * as tmux from "../lib/tmux";

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
  /** The PTY is a `tmux attach` client, so killing it only detaches. */
  tmuxBacked: boolean;
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

/** tmux backs the PTYs only when it is both wanted and installed. */
export function tmuxEnabled(): boolean {
  return setting("terminal.tmux") && tmux.available();
}

export function start(opts: StartOptions): { pid: number } {
  if (sessions.has(opts.id)) throw new Error(`Terminal ${opts.id} already running`);

  const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
  // Station-internal vars are stripped; node-pty needs a plain string map.
  const baseEnv = childBaseEnv();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const useTmux = tmuxEnabled();

  let pty: IPty;
  if (useTmux) {
    // The work runs inside a tmux session and this PTY is only a client of it, so
    // the same session can be attached from a real terminal window later. An
    // existing session is reattached as-is and `command` is ignored — whatever is
    // running in there survived, which is the point.
    tmux.ensureSession({
      id: opts.id,
      cwd: opts.cwd,
      env: opts.env,
      command: opts.command,
      shell,
      // The client resizes the window the moment it attaches (window-size latest);
      // this is just so the first frame isn't drawn at 80x24.
      cols: Math.max(cols, 200),
      rows: Math.max(rows, 50),
    });
    pty = spawn("tmux", tmux.attachArgs(opts.id), {
      name: "xterm-256color",
      cwd: opts.cwd,
      cols,
      rows,
      // No env set here: the session carries it, and the attach client's env
      // would otherwise leak into panes tmux opens later.
      env: { ...baseEnv, TERM: "xterm-256color" },
    });
  } else {
    // Login + interactive so PATH shims (nvm/asdf/…) resolve the command.
    const args = opts.command ? ["-l", "-i", "-c", opts.command] : ["-l"];
    pty = spawn(shell, args, {
      name: "xterm-256color",
      cwd: opts.cwd,
      cols,
      rows,
      env: { ...baseEnv, ...opts.env, TERM: "xterm-256color" },
    });
  }

  const managed: Managed = {
    pty,
    scrollback: [],
    scrollbackBytes: 0,
    listeners: new Set(),
    exited: false,
    exitCode: null,
    tmuxBacked: useTmux,
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

/**
 * Drops this process's PTY. For a tmux-backed terminal that is a *detach*: the
 * shell inside keeps running, which is what makes a handoff — and surviving a
 * server restart — possible. Use `killSession` to actually end the work.
 */
export function kill(id: string): void {
  const m = sessions.get(id);
  if (!m) return;
  try {
    m.pty.kill();
  } catch {
    /* already gone */
  }
}

/** Ends the work for real: detach, then tear the tmux session down. */
export function killSession(id: string): void {
  kill(id);
  if (tmuxEnabled() || tmux.hasSession(id)) tmux.killSession(id);
}

/** True when a tmux session still holds this terminal's process, attached or not. */
export function sessionAlive(id: string): boolean {
  return tmux.hasSession(id);
}

/** One tmux call for a whole list of rows — `sessionAlive` per row would fork per row. */
export function sessionAliveIds(): Set<string> {
  return new Set(tmux.liveTerminalIds());
}

/** Whether this process's PTY for `id` is a tmux client (false once detached). */
export function isTmuxBacked(id: string): boolean {
  return sessions.get(id)?.tmuxBacked ?? false;
}

export function isRunning(id: string): boolean {
  return sessions.has(id);
}

export function runningIds(): string[] {
  return [...sessions.keys()];
}

/**
 * Called on SIGINT/SIGTERM. Non-tmux PTYs die with us, as before — never leave
 * orphaned shells behind. tmux-backed ones only get detached, so a `tsx watch`
 * reload no longer kills the claude session you were in the middle of.
 */
export function killAll(): void {
  for (const id of [...sessions.keys()]) kill(id);
}
