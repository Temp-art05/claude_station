import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStep } from "@claude-station/shared";
import { readySteps } from "../../lib/workflow-graph";

/**
 * The race that made a run look like it skipped a step.
 *
 * A turn lives inside an `await` for tens of minutes. Retry, Skip, Restart and
 * Cancel all rewrite the step's row while it sits there. When the old turn landed
 * it booked its outcome regardless — so a step somebody had just retried was
 * stamped `done`, the scheduler saw a settled dependency, and the run walked
 * through everything downstream while the retry never ran.
 *
 * Seen for real in run `muc63i2x-4d9b6669-1a5`: `impl` on attempt 12 with
 * `maxRetries: 0` and no `finishedAt`, while `test`, `parity-check`, `review`,
 * `fix-review` and `pr` all had a `startedAt`. `settleStep` can never return a
 * step to `pending` when `maxRetries` is 0, so those 11 extra attempts came from
 * `retryStep` — and the steps behind `impl` should not have been reachable at all.
 */
const RUNNER = readFileSync(join(import.meta.dirname, "../workflow-runner.ts"), "utf8");

function step(key: string, dependsOn: string[] = []): WorkflowStep {
  return { key, dependsOn } as WorkflowStep;
}

describe("the scheduler's own rule", () => {
  const steps = [step("impl"), step("test", ["impl"]), step("review", ["test"])];

  it("will not start a step whose dependency is back to pending", () => {
    // This is the state a retry leaves behind, and the state the run was in when
    // `test` started anyway.
    const status: Record<string, string> = { impl: "pending", test: "pending", review: "pending" };
    expect(readySteps(steps, (k) => status[k]!).map((s) => s.key)).toEqual(["impl"]);
  });

  it("will not start a step whose dependency is still running", () => {
    const status: Record<string, string> = { impl: "running", test: "pending", review: "pending" };
    expect(readySteps(steps, (k) => status[k]!)).toEqual([]);
  });

  it("opens the next step only once the one before it settles", () => {
    const status: Record<string, string> = { impl: "done", test: "pending", review: "pending" };
    expect(readySteps(steps, (k) => status[k]!).map((s) => s.key)).toEqual(["test"]);
  });
});

describe("the generation guard", () => {
  const SETTLE = RUNNER.slice(RUNNER.indexOf("function settleStep"));

  it("refuses an outcome whose dispatch was replaced", () => {
    expect(SETTLE.slice(0, 1600)).toContain("stepRow.generation !== generation");
  });

  it("refuses it before anything is written", () => {
    const guard = SETTLE.indexOf("stepRow.generation !== generation");
    const firstWrite = SETTLE.indexOf("upsertRunStep");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstWrite);
  });

  it("claims a generation before the turn is awaited, not after", () => {
    const claim = RUNNER.indexOf("const claims = new Map(");
    const dispatch = RUNNER.indexOf("await runAgentStep(run, step, index, attempt)");
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(dispatch);
  });

  it("is moved by everything that can rewrite a step mid-turn", () => {
    for (const fn of [
      "export function retryStep",
      "export async function skipStep",
      "export function restartRun",
      "export async function cancelRun",
    ]) {
      const start = RUNNER.indexOf(fn);
      expect({ fn, found: start > -1 }).toEqual({ fn, found: true });
      expect({ fn, bumps: RUNNER.slice(start, start + 2600).includes("bumpGeneration") }).toEqual({
        fn,
        bumps: true,
      });
    }
  });

  it("does not lean on attempt, which restartRun sets back to 1", () => {
    const bump = RUNNER.slice(RUNNER.indexOf("function bumpGeneration"));
    expect(bump.slice(0, 400)).toContain("generation");
  });
});

describe("advanceRun", () => {
  const FN = RUNNER.slice(
    RUNNER.indexOf("export async function advanceRun"),
    RUNNER.indexOf("async function advanceOnce"),
  );

  it("remembers a request that arrived while it was busy", () => {
    // Returning early was the bug: a retry pressed mid-turn called advanceRun,
    // was told "already advancing", and nothing ever picked the request up.
    expect(FN).toContain("advanceAgain.add(runId)");
  });

  it("runs another pass for that request, then stops", () => {
    expect(FN).toContain("await advanceOnce(runId)");
    expect(FN).toContain("if (!advanceAgain.delete(runId)) return settled");
  });

  it("clears the flag when it gives up the lock", () => {
    expect(FN).toContain("advanceAgain.delete(runId)");
    expect(FN).toContain("advancing.delete(runId)");
  });
});

describe("skipStep", () => {
  const FN = RUNNER.slice(
    RUNNER.indexOf("export async function skipStep"),
    RUNNER.indexOf("export async function cancelRun"),
  );

  it("stops a live turn instead of only relabelling its row", () => {
    // Without this the agent keeps editing the repo for minutes after somebody
    // said "skip" — the guard drops its outcome, but not its writes to disk.
    expect(FN).toContain("await interrupt(rs.sessionId)");
    expect(FN).toMatch(/rs\?\.status === "running"/);
  });

  it("invalidates the dispatch it is walking away from", () => {
    expect(FN).toContain("bumpGeneration(runId, stepKey)");
  });
});

describe("reconcileRunsOnBoot", () => {
  const FN = RUNNER.slice(RUNNER.indexOf("export function reconcileRunsOnBoot"));

  it("counts interrupted steps per run, not across every run", () => {
    // The flag used to be the running total, so one run with a mid-flight step
    // parked every run listed after it — runs a restart had nothing to do with.
    expect(FN).toContain("let interruptedHere = 0");
    expect(FN).toContain("if (interruptedHere > 0)");
  });

  it("still reports the total to the boot log", () => {
    expect(FN).toContain("return touched;");
  });
});
