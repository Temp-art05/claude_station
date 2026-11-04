import { describe, expect, it } from "vitest";
import { hasBackgroundAgents, isBusy, isComposerReady } from "../claude-screen";
import { ScreenMirror } from "../screen-mirror";

function written(m: ScreenMirror, data: string): Promise<void> {
  return new Promise((resolve) => m.write(data, resolve));
}

/**
 * How `claude` ends a turn: the composer was drawn once, below the spinner, and
 * is never redrawn; the spinner row is overwritten in place with the summary.
 */
const FRAMES =
  "> do the thing\r\n" +
  "\r\n" +
  "✢ Befuddling… (1m 14s · ↓ 6.6k tokens)\r\n" +
  "────────\r\n" +
  "› \r\n" +
  "  ⏵⏵ auto mode on (shift+tab to cycle)\r\n" +
  // Back up to the spinner row and draw the finished summary over it.
  "\x1b[4A\r\x1b[2K✻ Cooked for 1m 15s" +
  "\x1b[4B\r";

describe("ScreenMirror", () => {
  it("shows the screen as drawn, not the bytes that drew it", async () => {
    const m = new ScreenMirror(80, 24);
    await written(m, FRAMES);
    const screen = m.text();

    expect(screen).toContain("✻ Cooked for 1m 15s");
    expect(screen).not.toContain("Befuddling");
    expect(isBusy(screen)).toBe(false);
    expect(hasBackgroundAgents(screen)).toBe(false);
    expect(isComposerReady(screen)).toBe(true);
    // The raw tail is what the engine used to read, and it says the opposite.
    expect(isBusy(FRAMES)).toBe(true);
    m.dispose();
  });

  it("keeps history above the screen, like capture-pane -S", async () => {
    const m = new ScreenMirror(40, 5);
    await written(m, Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\r\n"));

    const all = m.text(80).split("\n");
    expect(all[0]).toBe("line 0");
    expect(all.at(-1)).toBe("line 29");
    expect(m.text(2).split("\n")).toHaveLength(7);
    m.dispose();
  });

  it("joins a wrapped row back onto its line", async () => {
    const m = new ScreenMirror(10, 5);
    await written(m, "auto mode on, really");
    expect(m.text()).toBe("auto mode on, really");
    m.dispose();
  });

  it("follows a resize", async () => {
    const m = new ScreenMirror(80, 24);
    m.resize(120, 30);
    await written(m, "x".repeat(100));
    expect(m.text()).toBe("x".repeat(100));
    m.dispose();
  });
});
