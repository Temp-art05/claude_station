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
  /**
   * Ring buffer of recent output so a reconnecting tab sees its scrollback.
   * Only filled for non-tmux PTYs — tmux keeps the real screen and repaints it,
   * so buffering bytes for it would cost memory to replay garbage.
   */
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
    // A size the session already draws at costs nothing; anything else squeezes
    // the window (`window-size latest`), makes the program inside redraw, and —
    // on the way down to 80 columns — truncates the lines it already wrote. So
    // reattaching adopts the session's size and only a *new* session picks one.
    const existing = tmux.windowSize(opts.id);
    const startCols = existing?.cols ?? Math.max(cols, 200);
    const startRows = existing?.rows ?? Math.max(rows, 50);
    tmux.ensureSession({
      id: opts.id,
      cwd: opts.cwd,
      env: opts.env,
      command: opts.command,
      shell,
      // Wide enough that the first frame isn't drawn at 80x24; the tab's first
      // resize sets the real geometry once, and once only.
      cols: startCols,
      rows: startRows,
    });
    pty = spawn("tmux", tmux.attachArgs(opts.id), {
      name: "xterm-256color",
      cwd: opts.cwd,
      cols: startCols,
      rows: startRows,
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
    if (!managed.tmuxBacked) {
      managed.scrollback.push(chunk);
      managed.scrollbackBytes += chunk.byteLength;
      trimScrollback(managed);
    }
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
  // A tmux-backed terminal gets no replay at all: tmux holds the real screen and
  // `resizeAndPaint` asks it for a correct frame. Replaying the byte log into a
  // fresh emulator is what put text in the wrong columns — a full-screen program
  // draws with absolute cursor positioning, and the log is both size-specific and
  // cut mid-escape-sequence by `trimScrollback`.
  if (!m.tmuxBacked && m.scrollback.length) {
    // No tmux to repaint, so the byte log is all there is. RIS first, so the
    // emulator starts from a state we know instead of inheriting the tail of a
    // half-read sequence. It does not undo the mid-sequence cut itself — that
    // needs a headless terminal kept server-side.
    listener.onData(Buffer.from("\x1bc", "ascii"));
    for (const chunk of m.scrollback) listener.onData(chunk);
  }
  m.listeners.add(listener);
  return () => m.listeners.delete(listener);
}

/**
 * The geometry a freshly attached tab sends, plus a guarantee that it ends up with
 * one full frame — measured against tmux 3.7a:
 *
 * - a size tmux has to adopt already redraws every client, so asking for a repaint
 *   on top of it paints a *third* frame, and the one we ask for goes out before the
 *   client has even seen SIGWINCH — drawn at the old geometry, landing in the wrong
 *   rows. That stale frame is what left fragments of a half-updated line on screen.
 * - a size that matches draws nothing at all. That is the reconnect case, and the
 *   only one that needs `refreshClients`.
 */
export function resizeAndPaint(id: string, cols: number, rows: number): void {
  const m = sessions.get(id);
  if (!m || m.exited) return;
  const clients = m.tmuxBacked ? tmux.sessionClients(id) : [];
  const unchanged =
    clients.length > 0 && clients.every((c) => c.cols === cols && c.rows === rows);
  resize(id, cols, rows);
  if (unchanged) tmux.refreshClients(clients);
  // A changed size normally repaints on its own, but "normally" is not a
  // guarantee — the frame can be dropped, and a tab that lost it has no way to
  // ask again. Waiting for tmux to *report* the new geometry is what keeps this
  // from being the stale frame described above: by then the client has seen
  // SIGWINCH and its own redraw is already out.
  else repaintWhenResized(id, cols, rows);
}

/**
 * Repaints every client of a session. The cure for a client whose display was
 * thrown away while tmux still believed it painted — a pane re-shown after
 * `display:none` dropped its canvas, a terminal window that cleared itself as it
 * finished opening. tmux only ever sends the *difference* against the screen it
 * thinks the client has, so without this such a client shows nothing but the
 * cells that happen to change afterwards.
 */
export function repaint(id: string): void {
  const m = sessions.get(id);
  if (!m || m.exited || !m.tmuxBacked) return;
  tmux.refreshClients(tmux.sessionClients(id));
}

/** Polls until tmux reports the size it was asked for, then forces one frame. */
function repaintWhenResized(id: string, cols: number, rows: number, tries = 10): void {
  setTimeout(() => {
    const m = sessions.get(id);
    if (!m || m.exited || !m.tmuxBacked) return;
    const clients = tmux.sessionClients(id);
    if (clients.some((c) => c.cols === cols && c.rows === rows)) tmux.refreshClients(clients);
    else if (tries > 1) repaintWhenResized(id, cols, rows, tries - 1);
  }, 60).unref?.();
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
