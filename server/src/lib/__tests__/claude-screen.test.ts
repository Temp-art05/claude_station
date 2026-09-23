import { describe, expect, it } from "vitest";
import {
  hasBackgroundAgents,
  isBusy,
  isComposerReady,
  isTrustDialog,
  looksLikeDialog,
  needsApproval,
  waitingForPerson,
} from "../claude-screen";
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

/** Captured while a step's CLI sat waiting for a person, which the engine read as
 *  a finished turn — it asked to confirm work that had not happened yet. */
const APPROVAL_PANE = `
 Bash command
   │ git -C /Users/x/data/worktrees/abc status --porcelain
   Check worktree status
 This command requires approval
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for: git *
   4. No
`;

const BUSY_PANE = `
● Reading docs/plans/feature.md
  ⎿ 120 lines

· Working… (12s · esc to interrupt)
`;

describe("telling a turn that ended from one that is waiting", () => {
  it("does not call an approval dialog idle", () => {
    expect(needsApproval(APPROVAL_PANE)).toBe(true);
    // This is the pair that matters: the composer hint is still on screen behind
    // the dialog, so "composer is ready" alone would have called this finished.
    expect(isBusy(APPROVAL_PANE)).toBe(false);
  });

  it("knows a turn is still running", () => {
    expect(isBusy(BUSY_PANE)).toBe(true);
    expect(needsApproval(BUSY_PANE)).toBe(false);
  });

  it("calls an idle composer idle", () => {
    expect(isBusy(READY_PANE)).toBe(false);
    expect(needsApproval(READY_PANE)).toBe(false);
    expect(isComposerReady(READY_PANE)).toBe(true);
  });
});

/**
 * The CLI's own question UI, captured while somebody was halfway through
 * answering it. The engine read "no composer, not busy" as a terminal that had
 * never started, and failed the step out from under them.
 */
const QUESTION_PANE = `
● I've mapped the situation. Before writing the plan I need 4 decisions.

← ⊠ Playbook? ⊠ Tắt gì ⊠ Cách tắt □ Nhánh ✓ Submit →

  1. Từ develop, pick 4 (bỏ bump)
  2. Từ develop, pick cả 5
  3. Merge release/1.5.0 vào develop
  4. Khác — mình mô tả
  5. Type something.
  6. Chat about this
`;

describe("waitingForPerson", () => {
  it("recognises the question UI an agent puts up", () => {
    expect(waitingForPerson(QUESTION_PANE)).toBe("form câu hỏi của agent");
    // These are the two that made it look like a dead terminal.
    expect(isBusy(QUESTION_PANE)).toBe(false);
    expect(isComposerReady(QUESTION_PANE)).toBe(false);
  });

  it("recognises an approval dialog", () => {
    expect(waitingForPerson(APPROVAL_PANE)).toBe("hộp xin phê duyệt");
  });

  it("counts the trust dialog, which is the same thing at first run", () => {
    expect(waitingForPerson("Do you trust the files in this folder?")).toBe(
      "hộp hỏi có tin thư mục này không",
    );
  });

  it("leaves a working turn and an idle composer alone", () => {
    expect(waitingForPerson(BUSY_PANE)).toBeNull();
    expect(waitingForPerson(READY_PANE)).toBeNull();
  });
});

/**
 * The screen a step was parked in front of while claiming somebody was being
 * asked something. Nothing is open; the composer hint simply mentions a key.
 * A claim about the user's screen that the user can see is false costs more than
 * the detection is worth, so this pins the exact pane.
 */
const FRESH_START_PANE = `
 ▐▛███▛█   Claude Code v2.1.270
▝▜██████▀  Opus 5 (1M context) with high effort · Claude Team
  ▝▝ ▝▝    ~/SkillsAgent/claude_station/data/worktrees/mu102v40-f6276142-df4

›
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
`;

describe("the weak markers that made it lie", () => {
  it("does not park a run on a dialog footer alone", () => {
    // These outlive the dialog they belong to by a frame. Treating one as proof
    // is how a step ended up parked in front of an empty terminal.
    expect(waitingForPerson("  Esc to cancel · Tab to amend")).toBeNull();
  });

  it("still uses them to recognise a dialog once something else says so", () => {
    expect(looksLikeDialog("  Esc to cancel · Tab to amend")).toBe(true);
    expect(looksLikeDialog(FRESH_START_PANE)).toBe(false);
  });
});

describe("a terminal that is not asking anything", () => {
  it("is not reported as waiting", () => {
    expect(waitingForPerson(FRESH_START_PANE)).toBeNull();
  });

  it("is reported as ready to be typed at", () => {
    expect(isComposerReady(FRESH_START_PANE)).toBe(true);
    expect(isBusy(FRESH_START_PANE)).toBe(false);
  });
});

/**
 * An impl step's terminal, captured while it was waiting on the UI slices it had
 * fanned out. Composer ready, nothing "busy" — and the engine called the step
 * done here, ten minutes before the code it was supposed to have written existed.
 */
const BACKGROUND_PANE = `
⏺ Agent "v1.3.0 Home slice F31/F32/F38" finished · 10m 35s

⏺ Lát cắt Home đã merge. Hai lát cắt này còn đang chạy.

✻ Waiting for 2 background agents to finish

────────────────────────────────────────
❯ 
────────────────────────────────────────
  ⏵⏵ bypass permissions on · 1 monitor · ← 2 agents · ↓ to manage

  ⏺ main
  ◯ fork  Fixing R8 missing class in proguard-rules.pro        15m 5s · ↓ 428.1k tokens
  ◯ fork  Fixing launch scope in OnboardingFlowUseCaseTest     14m 49s · ↓ 495.3k tokens
`;

describe("hasBackgroundAgents", () => {
  it("sees the wait that looked like a finished turn", () => {
    expect(isBusy(BACKGROUND_PANE)).toBe(false);
    expect(isComposerReady(BACKGROUND_PANE)).toBe(true);
    expect(hasBackgroundAgents(BACKGROUND_PANE)).toBe(true);
  });

  it("still waits in the moment between an agent finishing and the main agent waking", () => {
    const pane = `
✻ Waiting for 1 background agent to finish

⏺ Agent "v1.3.0 App slice" finished · 12m 2s

❯ 
  ⏵⏵ bypass permissions on
`;
    expect(hasBackgroundAgents(pane)).toBe(true);
  });

  it("lets go once the main agent has written on after the wait", () => {
    const pane = `
✻ Waiting for 2 background agents to finish

⏺ Agent "v1.3.0 App slice" finished · 12m 2s

⏺ Agent "v1.3.0 Onboarding slice" finished · 13m 40s

⏺ Đã merge cả 4 lát cắt, build xanh.

❯ 
  ⏵⏵ bypass permissions on
`;
    expect(hasBackgroundAgents(pane)).toBe(false);
  });

  it("reads the ● glyph some terminals draw instead of ⏺", () => {
    const pane = `✻ Waiting for 1 background agent to finish\n\n● Xong.\n\n❯ \n  ? for shortcuts\n`;
    expect(hasBackgroundAgents(pane)).toBe(false);
  });

  it("does not take the footer's agent count for running work", () => {
    expect(hasBackgroundAgents(READY_PANE)).toBe(false);
  });
});
