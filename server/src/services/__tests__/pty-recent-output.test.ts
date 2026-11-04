/**
 * `recentOutput` with `terminal.tmux` off reads the emulated screen, not the
 * byte log. The log still holds frames the program drew over, so a `claude` turn
 * that had ended read as busy until a reload forced a full redraw.
 *
 * Its own file because the settings module is mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/config", () => ({
  setting: (key: string) => (key === "terminal.tmux" ? false : 200_000),
}));

const { kill, recentOutput, start } = await import("../pty-manager");
const { isBusy, isComposerReady } = await import("../../lib/claude-screen");

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

describe("recentOutput without tmux", () => {
  it("returns what the screen shows after a spinner is drawn over", async () => {
    const id = `screen-${Date.now()}`;
    started.push(id);
    // Spinner, composer below it, then the spinner row rewritten in place.
    const script =
      "printf '✢ Working… (12s)\\r\\n› \\r\\n  auto mode on\\r\\n'; " +
      "printf '\\033[3A\\r\\033[2K✻ Cooked for 13s\\033[3B\\r'; sleep 5";
    start({ id, cwd: process.cwd(), shell: "/bin/sh", command: script });

    expect(await waitUntil(() => recentOutput(id).includes("Cooked"))).toBe(true);
    const screen = recentOutput(id);
    expect(screen).not.toContain("Working");
    expect(isBusy(screen)).toBe(false);
    expect(isComposerReady(screen)).toBe(true);
  });
});
