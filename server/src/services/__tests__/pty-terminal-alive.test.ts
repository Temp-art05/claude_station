/**
 * `terminalAlive` with `terminal.tmux` off: a PTY this process spawned is alive
 * while it runs and dead once it exits. Before this, liveness was asked of tmux
 * alone, so every non-tmux terminal read as dead and a workflow step failed with
 * "exited before it was ready" a few milliseconds after a healthy CLI started.
 *
 * Its own file because the settings module is mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/config", () => ({
  setting: (key: string) => (key === "terminal.tmux" ? false : 200_000),
}));

const { kill, start, terminalAlive } = await import("../pty-manager");

const started: string[] = [];

afterEach(() => {
  for (const id of started.splice(0)) kill(id);
});

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe("terminalAlive without tmux", () => {
  it("is true while the PTY runs", () => {
    const id = `alive-${Date.now()}`;
    started.push(id);
    start({ id, cwd: process.cwd(), shell: "/bin/sh", command: "sleep 5" });

    expect(terminalAlive(id)).toBe(true);
  });

  it("turns false once the PTY exits", async () => {
    const id = `exits-${Date.now()}`;
    started.push(id);
    start({ id, cwd: process.cwd(), shell: "/bin/sh", command: "true" });

    expect(await waitUntil(() => !terminalAlive(id))).toBe(true);
  });

  it("is false for a terminal this process never started", () => {
    expect(terminalAlive("never-started")).toBe(false);
  });
});
