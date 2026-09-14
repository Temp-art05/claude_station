import { describe, expect, it } from "vitest";
import { isComposerReady, isTrustDialog } from "../claude-screen";
import { capturePaneArgs } from "../tmux";

/**
 * Captured from a real `claude` terminal this app had opened — the exact screen a
 * workflow step was looking at when it declared the CLI had never reached its
 * prompt.
 */
const READY_PANE = `
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
Claude Code v2.1.270
Opus 5 (1M context) with high effort · Claude Team
~/SkillsAgent/claude_station/data/worktrees/mu0y1ci1-98e5709e-ef0

›
  ▶▶ auto mode on (shift+tab to cycle) · ⌐ 2 agents
`;

describe("isComposerReady", () => {
  it("recognises the screen a step was told did not exist", () => {
    expect(isComposerReady(READY_PANE)).toBe(true);
  });

  it("recognises each permission mode's hint line", () => {
    for (const hint of [
      "? for shortcuts",
      "auto-accept edits on",
      "auto mode on (shift+tab to cycle)",
      "bypass permissions on",
      "plan mode on",
    ]) {
      expect({ hint, ready: isComposerReady(`› \n  ${hint}`) }).toEqual({ hint, ready: true });
    }
  });

  it("does not call a blank or still-booting screen ready", () => {
    expect(isComposerReady("")).toBe(false);
    expect(isComposerReady("Claude Code v2.1.270\nstarting…")).toBe(false);
  });

  it("is not fooled by the prompt glyph alone — dialogs draw one too", () => {
    expect(isComposerReady("│ › Do you want to proceed? │")).toBe(false);
  });
});

describe("isTrustDialog", () => {
  it("spots the first-run trust question", () => {
    expect(isTrustDialog("Do you trust the files in this folder?")).toBe(true);
    expect(isTrustDialog("Is this a project you created or one you trust?")).toBe(true);
  });

  it("leaves an ordinary screen alone", () => {
    expect(isTrustDialog(READY_PANE)).toBe(false);
  });
});

describe("capturePaneArgs", () => {
  it("targets the session without the exact-match prefix", () => {
    const args = capturePaneArgs("t1", 120);
    // `=name` is exact-match syntax for a *session*; capture-pane takes a pane and
    // answers "can't find pane" when given it. That typo cost a wrong diagnosis.
    expect(args).not.toContain("=cs-t1");
    expect(args).toContain("cs-t1");
    expect(args).toEqual(
      expect.arrayContaining(["capture-pane", "-p", "-t", "cs-t1", "-S", "-120"]),
    );
  });
});
