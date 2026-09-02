/**
 * The station's own tmux server: every PTY runs inside a tmux session, so the
 * same process can be attached from the app *and* from a real terminal window.
 * Without it "open this in Terminal.app" is impossible — a PTY belongs to the
 * process that spawned it and cannot be handed over.
 *
 * Argument building is pure and exported so it stays testable (same split as
 * lib/claude-cli.ts); the few side-effecting wrappers below shell out to tmux.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { childBaseEnv } from "./child-env";
import { shq } from "./claude-cli";
import { TMUX_CONF } from "./data-dir";

/** Our own socket: never touch the tmux server the user runs by hand. */
export const TMUX_SOCKET = "claude-station";

/** `-e` on new-session (per-session env) landed in tmux 3.2. */
const ENV_FLAG_MIN = 3.2;

export function sessionName(terminalId: string): string {
  return `cs-${terminalId}`;
}

/** "cs-<id>" → "<id>"; anything else is not ours. */
export function terminalIdOf(session: string): string | null {
  return session.startsWith("cs-") ? session.slice(3) : null;
}

export interface TmuxProbe {
  ok: boolean;
  /** Numeric major.minor, 0 when unknown. */
  version: number;
  /** Raw `tmux -V` output, or the error that explains why there is none. */
  detail: string;
}

/** "tmux 3.4" / "tmux 3.2a" / "tmux next-3.5" → 3.4 / 3.2 / 3.5 */
export function parseVersion(output: string): number {
  const m = /(\d+)\.(\d+)/.exec(output);
  if (!m) return 0;
  return Number(`${m[1]}.${m[2]}`);
}

let cached: TmuxProbe | null = null;

/** Probed once per process — an install/uninstall mid-session is not worth a stat per PTY. */
export function probe(force = false): TmuxProbe {
  if (cached && !force) return cached;
  try {
    const out = execFileSync("tmux", ["-V"], { encoding: "utf8", timeout: 5000 }).trim();
    cached = { ok: true, version: parseVersion(out), detail: out };
  } catch (err) {
    cached = {
      ok: false,
      version: 0,
      detail: `${err instanceof Error ? err.message : String(err)} — try: brew install tmux`,
    };
  }
  return cached;
}

export function available(): boolean {
  return probe().ok;
}

function supportsEnvFlag(): boolean {
  return probe().version >= ENV_FLAG_MIN;
}

/**
 * Config for our socket only. Written from TS rather than using tmux's own `%if`
 * so an old tmux never has to parse an option it doesn't know.
 *
 * `mouse on` is deliberate: tmux takes the alternate screen, which freezes the
 * xterm scrollback in the app, so the wheel has to scroll tmux's history instead.
 * The cost is that the claude TUI no longer sees mouse events and selecting text
 * needs Option/Shift — documented in the README.
 */
export function configFor(version: number): string {
  const lines = [
    "# Managed by claude-station — rewritten on every boot, edits are lost.",
    // C-b is readline's backward-char; C-] is used by nothing in the claude TUI.
    "set -g prefix C-]",
    "unbind C-b",
    "bind C-] send-prefix",
    "set -g status off",
    "set -g mouse on",
    "set -g history-limit 100000",
    "set -g escape-time 10",
    "set -g focus-events on",
    'set -g default-terminal "screen-256color"',
    "set -g set-titles off",
    "set -g bell-action none",
    // A detached session must survive: that is the whole point of the handoff.
    "set -g destroy-unattached off",
    // `claude` exiting has to end the session, so the terminal row goes exited.
    "set -g remain-on-exit off",
    "setw -g aggressive-resize on",
  ];
  // Size follows the newest client, not the smallest: the app creates the session
  // detached at a default size and the real client resizes it right after.
  if (version >= 3.1) lines.push("set -g window-size latest");
  if (version >= 3.2) lines.push('set -as terminal-features ",*:RGB"');
  else lines.push('set -ga terminal-overrides ",*:Tc"');
  if (version >= 3.3) lines.push("set -g allow-passthrough on");
  // The safety net under repaintOnAttach: a client that lost the screen it was
  // sent gets a fresh one the moment someone looks at it. tmux sends only the
  // difference against the screen it believes a client has, so a dropped frame
  // otherwise survives until the next resize — and clicking the window is the
  // first thing anyone does with a blank one.
  if (version >= 3.2) lines.push("set-hook -g client-focus-in refresh-client");
  return `${lines.join("\n")}\n`;
}

export function writeConfig(): void {
  writeFileSync(TMUX_CONF, configFor(probe().version), "utf8");
}

export interface NewSessionInput {
  id: string;
  cwd: string;
  env?: Record<string, string>;
  /** Run this instead of a bare login shell; the session ends when it exits. */
  command?: string;
  shell: string;
  cols: number;
  rows: number;
  /** Pass false to build the pre-3.2 form (env applied separately). */
  envFlag?: boolean;
}

export function newSessionArgs(input: NewSessionInput): string[] {
  const env = input.env ?? {};
  const envFlags =
    input.envFlag === false
      ? []
      : Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // Login + interactive, same as pty-manager's direct spawn: PATH shims
  // (nvm/asdf/…) only resolve in a login shell. tmux runs this through `sh -c`,
  // hence the quoting.
  const shellCommand = input.command
    ? `${shq(input.shell)} -l -i -c ${shq(input.command)}`
    : `${shq(input.shell)} -l`;
  return [
    "-L",
    TMUX_SOCKET,
    "-f",
    TMUX_CONF,
    "new-session",
    "-d",
    "-s",
    sessionName(input.id),
    "-c",
    input.cwd,
    "-x",
    String(input.cols),
    "-y",
    String(input.rows),
    ...envFlags,
    shellCommand,
  ];
}

/** `steal` detaches whoever else is attached — how the handoff takes over. */
export function attachArgs(terminalId: string, opts: { steal?: boolean } = {}): string[] {
  return [
    "-L",
    TMUX_SOCKET,
    "attach-session",
    ...(opts.steal ? ["-d"] : []),
    "-t",
    sessionName(terminalId),
  ];
}

/**
 * `CSI 8 ; rows ; cols t` — asks the terminal app to size its own window to the
 * session before attaching to it. Without this the new window attaches at its
 * profile default (80x24 for Terminal.app) and `window-size latest` drags the
 * whole session down to that: the program inside reflows its entire screen and
 * everything already written is re-wrapped at 80 columns. Matching first means
 * the attach changes nothing, so there is no reflow to watch happen.
 */
export function windowSizeLine(size: { cols: number; rows: number }): string {
  return `printf '\\033[8;${size.rows};${size.cols}t'`;
}

/**
 * The one line a `.command` launcher needs to take the session over. `-d` steals
 * the client, so the app's own PTY lets go the moment this window opens.
 */
export function launcherLine(terminalId: string): string {
  return `exec tmux ${attachArgs(terminalId, { steal: true })
    .map(shq)
    .join(" ")}`;
}

function run(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    timeout: 10000,
    // The tmux *server* inherits this env, so it must be the sanitized one —
    // otherwise PORT/CLAUDE_STATION_* leak into every shell it ever spawns.
    env: childBaseEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function hasSession(terminalId: string): boolean {
  try {
    run(["-L", TMUX_SOCKET, "has-session", "-t", `=${sessionName(terminalId)}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the session if it isn't there. Returns false when one already exists —
 * that is the reattach path, and the caller's `command` is deliberately ignored:
 * the work is already running inside.
 */
/**
 * `-f` is read once, when the tmux *server* starts. A server that is already up
 * — which it is for every terminal after the first — never sees a rewritten
 * config, so anything the station needs from it has to be set again at runtime.
 * Idempotent, and cheap enough to just always do.
 */
export function applyServerOptions(): void {
  if (probe().version < 3.2) return;
  try {
    // One fork, both settings: the hook is useless without focus-events, since
    // that is what turns a client's `CSI I` into the event it hangs off.
    run([
      "-L",
      TMUX_SOCKET,
      "set-option",
      "-g",
      "focus-events",
      "on",
      ";",
      "set-hook",
      "-g",
      "client-focus-in",
      "refresh-client",
    ]);
  } catch {
    /* no server yet — the config file carries the same settings for a fresh one */
  }
}

export function ensureSession(input: NewSessionInput): boolean {
  applyServerOptions();
  if (hasSession(input.id)) return false;
  const envFlag = supportsEnvFlag();
  run(newSessionArgs({ ...input, envFlag }));
  if (!envFlag) {
    for (const [k, v] of Object.entries(input.env ?? {})) {
      run(["-L", TMUX_SOCKET, "set-environment", "-t", sessionName(input.id), k, v]);
    }
  }
  return true;
}

/** An attached tmux client: the tty to refresh, and the size it is drawing at. */
export interface TmuxClient {
  name: string;
  cols: number;
  rows: number;
}

/**
 * Forces tmux to repaint the current screen to the given clients. Our PTY is a
 * long-lived tmux client that survives WS reconnects, so a reconnecting tab
 * triggers no attach and therefore no repaint of its own — this is what gives it
 * a correct screen instead of a replayed byte log.
 *
 * `refresh-client -t` takes a *client* (`/dev/ttys003`), not a session, hence the
 * `sessionClients` lookup first: aiming it at a session name only ever yields
 * "can't find client".
 */
export function refreshClients(clients: TmuxClient[]): void {
  for (const c of clients) {
    try {
      run(refreshClientArgs(c.name));
    } catch {
      /* that client detached between the two calls */
    }
  }
}

/**
 * The clients attached to this terminal's session, with their sizes — one fork
 * serves both the repaint target and the "did anything actually change" check.
 */
export function sessionClients(terminalId: string): TmuxClient[] {
  try {
    return run(listClientsArgs(terminalId))
      .split("\n")
      .flatMap((line) => {
        const m = /^(\S+) (\d+)x(\d+)$/.exec(line.trim());
        return m ? [{ name: m[1]!, cols: Number(m[2]), rows: Number(m[3]) }] : [];
      });
  } catch {
    return []; // session gone — nothing left to repaint
  }
}

/**
 * `=` so a session we merely prefix is not hit. The size is the *client's* own,
 * never the window's: tmux takes a row off the window for the status line, so
 * comparing a client geometry against a window geometry reads as a change when
 * nothing moved.
 */
export function listClientsArgs(terminalId: string): string[] {
  const target = `=${sessionName(terminalId)}`;
  const format = "#{client_name} #{client_width}x#{client_height}";
  return ["-L", TMUX_SOCKET, "list-clients", "-t", target, "-F", format];
}

/** `client` is a tty name out of `listClientsArgs`, never a session name. */
export function refreshClientArgs(client: string): string[] {
  return ["-L", TMUX_SOCKET, "refresh-client", "-t", client];
}

export function windowSizeArgs(terminalId: string): string[] {
  return [
    "-L",
    TMUX_SOCKET,
    "display-message",
    "-p",
    // The trailing ":" makes this the session's *current window*, not the session:
    // targeted at a bare session name the window fields resolve to nothing at all
    // (`display -p -t =sess "#{window_width}"` prints an empty string).
    "-t",
    `=${sessionName(terminalId)}:`,
    "#{window_width}x#{window_height}",
  ];
}

/**
 * The size the session is drawing at, so a new client can attach *at* it. Every
 * other size squeezes the window (`window-size latest`) and makes the program
 * inside redraw for nothing — and a squeeze to 80 columns truncates the history
 * it already wrote. Null when the session is gone.
 */
export function windowSize(terminalId: string): { cols: number; rows: number } | null {
  try {
    const m = /^(\d+)x(\d+)$/.exec(run(windowSizeArgs(terminalId)).trim());
    return m ? { cols: Number(m[1]), rows: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

/**
 * Two early repaints, for the window that opens without ever taking focus. The
 * `client-focus-in` hook is what actually makes this reliable, so this stays
 * short on purpose: every entry is a whole screen redrawn, and a long list of
 * them is visible as flicker while the window settles.
 */
export const ATTACH_REPAINTS_MS = [500, 2000];

/**
 * A handed-off session is painted once, as the new window attaches — and that
 * paint is lost when the terminal app is still setting the window up as it
 * lands: the window stays blank and only the cells that change afterwards ever
 * appear (reproduced with Terminal.app; `refresh-client` fixes it instantly).
 *
 * Deliberately repaints *whatever is attached* rather than trying to single out
 * the new window. Telling clients apart by name does not work: macOS hands the
 * freed `/dev/ttysNNN` of the PTY we just killed straight back to the terminal
 * app, so the window that appears can carry the exact name of the client it
 * replaced — and a "new clients only" filter then matches nothing, forever.
 */
export function repaintOnAttach(terminalId: string): void {
  for (const ms of ATTACH_REPAINTS_MS) {
    setTimeout(() => refreshClients(sessionClients(terminalId)), ms).unref?.();
  }
}

export function killSession(terminalId: string): void {
  try {
    run(["-L", TMUX_SOCKET, "kill-session", "-t", `=${sessionName(terminalId)}`]);
  } catch {
    /* already gone */
  }
}

/** Session names on our socket, ours or not. Empty when no server is running. */
export function listSessions(): string[] {
  try {
    return run(["-L", TMUX_SOCKET, "list-sessions", "-F", "#{session_name}"])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Terminal ids that still have a live session on our socket. */
export function liveTerminalIds(): string[] {
  return listSessions()
    .map(terminalIdOf)
    .filter((id): id is string => id !== null);
}
