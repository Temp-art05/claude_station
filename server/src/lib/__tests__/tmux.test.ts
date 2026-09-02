import { describe, expect, it } from "vitest";
import {
  attachArgs,
  configFor,
  launcherLine,
  listClientsArgs,
  newSessionArgs,
  parseVersion,
  refreshClientArgs,
  sessionName,
  terminalIdOf,
  TMUX_SOCKET,
  windowSizeArgs,
  windowSizeLine,
} from "../tmux";

const base = { id: "t1", cwd: "/Users/me/repo", shell: "/bin/zsh", cols: 200, rows: 50 };

describe("session names", () => {
  it("round-trips a terminal id", () => {
    expect(terminalIdOf(sessionName("abc"))).toBe("abc");
  });

  it("ignores sessions that are not ours", () => {
    expect(terminalIdOf("work")).toBeNull();
  });
});

describe("parseVersion", () => {
  it("reads the usual forms", () => {
    expect(parseVersion("tmux 3.4")).toBe(3.4);
    expect(parseVersion("tmux 3.2a")).toBe(3.2);
    expect(parseVersion("tmux next-3.5")).toBe(3.5);
  });

  it("falls back to 0 when there is no version", () => {
    expect(parseVersion("command not found")).toBe(0);
  });
});

describe("newSessionArgs", () => {
  it("always targets our own socket and config", () => {
    const args = newSessionArgs({ ...base });
    expect(args.slice(0, 4)).toEqual(["-L", TMUX_SOCKET, "-f", expect.stringMatching(/tmux\.conf$/)]);
    expect(args).toContain("-d");
    expect(args.slice(-1)[0]).toBe("'/bin/zsh' -l");
  });

  it("runs a command through a login+interactive shell, quoted for sh -c", () => {
    const args = newSessionArgs({ ...base, command: "claude --continue || claude" });
    expect(args.slice(-1)[0]).toBe("'/bin/zsh' -l -i -c 'claude --continue || claude'");
  });

  it("passes env with -e when tmux supports it", () => {
    const args = newSessionArgs({ ...base, env: { API_URL: "http://x", B: "2" } });
    expect(args).toContain("-e");
    expect(args).toContain("API_URL=http://x");
    expect(args).toContain("B=2");
  });

  it("omits -e on the pre-3.2 path (env is applied separately)", () => {
    const args = newSessionArgs({ ...base, env: { A: "1" }, envFlag: false });
    expect(args).not.toContain("-e");
    expect(args).not.toContain("A=1");
  });

  it("carries cwd and an explicit size", () => {
    const args = newSessionArgs({ ...base });
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toBe("/Users/me/repo");
    expect(args[args.indexOf("-x") + 1]).toBe("200");
    expect(args[args.indexOf("-y") + 1]).toBe("50");
  });
});

describe("attachArgs", () => {
  it("attaches without stealing by default", () => {
    expect(attachArgs("t1")).toEqual(["-L", TMUX_SOCKET, "attach-session", "-t", "cs-t1"]);
  });

  it("steals the client for a hand-off", () => {
    expect(attachArgs("t1", { steal: true })).toContain("-d");
  });
});

describe("repaint targeting", () => {
  it("looks a session's clients up by exact name", () => {
    expect(listClientsArgs("t1")).toEqual([
      "-L",
      TMUX_SOCKET,
      "list-clients",
      "-t",
      "=cs-t1",
      "-F",
      "#{client_name} #{client_width}x#{client_height}",
    ]);
  });

  // The window is a row shorter than its client whenever the status line is on, so
  // a client geometry compared against a window geometry reads as a change when
  // nothing moved — and the repaint that reconnect depends on gets skipped.
  it("asks for the client's own size, not the window's", () => {
    const format = listClientsArgs("t1").at(-1);
    expect(format).toContain("client_width");
    expect(format).not.toContain("window_width");
  });

  // refresh-client's -t is a *client*; handing it a session only ever answers
  // "can't find client", which a swallowed error turns into a silent no-op.
  it("refreshes a tty, never a session name", () => {
    expect(refreshClientArgs("/dev/ttys003")).toEqual([
      "-L",
      TMUX_SOCKET,
      "refresh-client",
      "-t",
      "/dev/ttys003",
    ]);
    expect(refreshClientArgs("/dev/ttys003")).not.toContain(sessionName("t1"));
  });
});

describe("windowSizeArgs", () => {
  // The attach size has to be the window's, not a client's: a client is a row
  // shorter when the status line is on, and attaching a row short resizes the
  // window — the very reflow the lookup exists to avoid.
  it("asks for the window's geometry of an exactly named session", () => {
    expect(windowSizeArgs("t1")).toEqual([
      "-L",
      TMUX_SOCKET,
      "display-message",
      "-p",
      "-t",
      "=cs-t1:",
      "#{window_width}x#{window_height}",
    ]);
  });

  // Bare session name: tmux resolves no window context and prints "x".
  it("targets the session's current window, not the session", () => {
    expect(windowSizeArgs("t1").at(-2)).toBe("=cs-t1:");
  });
});

describe("windowSizeLine", () => {
  // Sizing the window first is what stops `window-size latest` from dragging the
  // session down to the new window's 80x24 and reflowing everything in it.
  it("emits a real CSI 8 resize, rows before cols", () => {
    expect(windowSizeLine({ cols: 215, rows: 32 })).toBe("printf '\\033[8;32;215t'");
  });
});

describe("configFor", () => {
  it("never leaves C-b as the prefix — readline needs it", () => {
    const conf = configFor(3.4);
    expect(conf).toContain("set -g prefix C-]");
    expect(conf).toContain("unbind C-b");
  });

  it("keeps a detached session alive and lets the newest client set the size", () => {
    const conf = configFor(3.4);
    expect(conf).toContain("set -g destroy-unattached off");
    expect(conf).toContain("set -g window-size latest");
  });

  // A client that dropped the frame tmux sent it has no way to ask again, and
  // tmux only ever sends differences after that — so focus is the cheapest
  // moment to hand it a whole screen.
  it("repaints a client whenever it is focused", () => {
    expect(configFor(3.4)).toContain("set-hook -g client-focus-in refresh-client");
  });

  // The hook is 3.2; older tmux has to do without rather than fail to load the
  // config, which would take every setting above it down with it.
  it("leaves the focus hook out of a tmux too old for it", () => {
    expect(configFor(3.1)).not.toContain("client-focus-in");
  });

  it("uses terminal-features on 3.2+ and terminal-overrides below it", () => {
    expect(configFor(3.4)).toContain("terminal-features");
    expect(configFor(3.4)).toContain("allow-passthrough");
    const old = configFor(3.0);
    expect(old).toContain("terminal-overrides");
    expect(old).not.toContain("terminal-features");
    expect(old).not.toContain("allow-passthrough");
    expect(old).not.toContain("window-size");
  });
});

describe("launcherLine", () => {
  it("builds an exec line the shell can run verbatim", () => {
    expect(launcherLine("t1")).toBe(
      `exec tmux '-L' 'claude-station' 'attach-session' '-d' '-t' 'cs-t1'`,
    );
  });
});
