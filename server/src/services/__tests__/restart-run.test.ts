import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Restarting a run, and the distinction that makes it safe.
 *
 * "Chạy lại" means two different things depending on why you press it. After a
 * step failed halfway you want the rest of the run, not a second set of Jira
 * tickets and a second plan — steps that already succeeded must stay succeeded.
 * After pointing the run at the wrong spec you want the opposite.
 *
 * The behaviour lives in `restartRun`; these check the properties that stop a
 * resume from quietly becoming a redo.
 */
const RUNNER = readFileSync(join(import.meta.dirname, "../workflow-runner.ts"), "utf8");
const RESTART = RUNNER.slice(
  RUNNER.indexOf("export function restartRun"),
  RUNNER.indexOf("export async function skipStep"),
);

describe("restartRun", () => {
  it("defaults to resume — the mode that cannot redo finished work", () => {
    expect(RESTART).toMatch(/mode: "resume" \| "fresh" = "resume"/);
  });

  it("keeps a step that finished, in resume", () => {
    expect(RESTART).toContain('rs?.status === "done" || rs?.status === "skipped"');
    expect(RESTART).toMatch(/if \(keepDone && settled\)/);
  });

  it("drops terminals only when starting over", () => {
    // Resume keeps them: a step re-run in the same terminal knows what it already
    // tried. Fresh drops them, or the old conversation walks into the new run.
    expect(RESTART).toMatch(/keepDone \? \{\} : \{ sessionId: null, terminalId: null/);
  });

  it("clears the questions of every step it resets", () => {
    // A question from a turn that no longer exists blocks the run before it
    // dispatches anything — the scheduler stops on any unanswered question.
    expect(RESTART).toContain("db.delete(schema.workflowQuestions)");
    expect(RESTART).toContain("pendingAsks.delete(rs.id)");
  });

  it("resets the gate loop counter, not just the status", () => {
    // A gate carrying loops from the failed attempt would give up early on the
    // retry, which reads as the check being broken rather than exhausted.
    expect(RESTART).toMatch(/loops: 0/);
  });

  it("gives an unattended run its clock back", () => {
    // Restarting a run that died of its own budget must not expire on step one.
    expect(RESTART).toContain("deadlineAt");
    expect(RESTART).toContain("workflows.runBudgetMinutes");
  });

  it("refuses a terminal-mode run, which drives itself", () => {
    expect(RESTART).toMatch(/run\.mode === "terminal"/);
  });
});
