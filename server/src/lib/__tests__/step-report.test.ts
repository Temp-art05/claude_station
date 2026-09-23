import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyReport, type StepReport } from "../step-report";

/**
 * Run `mudjshot-1adcd31d-525`: `parity-check` wrote "CHƯA chấm — impl vẫn đang
 * ghi" and was booked `done`, because a note was the only thing it could say. The
 * report is how a step says "this is not done", and these are the rules for when
 * that is believed.
 */
const failed = (generation: number): StepReport => ({
  generation,
  status: "failed",
  reason: "impl chưa xong: 3 lát cắt UI chưa merge",
});

describe("applyReport", () => {
  it("turns an ended turn into a failure when the agent says it failed", () => {
    expect(applyReport({ ok: true }, failed(4), 4)).toEqual({
      ok: false,
      error: "impl chưa xong: 3 lát cắt UI chưa merge",
      tail: "impl chưa xong: 3 lát cắt UI chưa merge",
      reported: true,
    });
  });

  it("ignores a report made in an older dispatch", () => {
    expect(applyReport({ ok: true }, failed(3), 4)).toEqual({ ok: true });
  });

  it("changes nothing when the agent says done, or says nothing", () => {
    expect(applyReport({ ok: true }, { ...failed(4), status: "done" }, 4)).toEqual({ ok: true });
    expect(applyReport({ ok: true }, undefined, 4)).toEqual({ ok: true });
  });

  it("leaves a broken turn as a broken turn, not a verdict", () => {
    const timedOut = { ok: false, error: "The turn did not finish within 60 minutes" };
    expect(applyReport(timedOut, failed(4), 4)).toEqual(timedOut);
  });

  it("does not override a step that is waiting on a person", () => {
    const waiting = { ok: false, waiting: true, error: "hộp xin phê duyệt" };
    expect(applyReport(waiting, failed(4), 4)).toEqual(waiting);
  });
});

const RUNNER = readFileSync(join(import.meta.dirname, "../../services/workflow-runner.ts"), "utf8");

describe("the runner acts on the report", () => {
  const start = RUNNER.indexOf("function settleStep(");
  const end = RUNNER.indexOf("function settleGate(");
  const SETTLE = RUNNER.slice(start, end);

  it("finds settleStep and settleGate", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("reads the report only after the generation guard", () => {
    const guard = SETTLE.indexOf("stepRow.generation !== generation");
    const apply = SETTLE.indexOf("applyReport(");
    expect(guard).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(guard);
  });

  it("sends a reported failure with onFail through the gate's loop", () => {
    expect(SETTLE).toContain("result.reported && step.onFail");
    expect(SETTLE.indexOf("applyReport(")).toBeLessThan(SETTLE.indexOf("settleGate("));
  });

  it("moves the generation of every step it sends back", () => {
    const gate = RUNNER.slice(end, RUNNER.indexOf("export function answerQuestions"));
    const loop = gate.slice(gate.indexOf("const chain = new Set("));
    expect(loop.slice(0, 600)).toContain("bumpGeneration(runId, key)");
  });

  it("tells the step it sent back why", () => {
    const agent = RUNNER.slice(RUNNER.indexOf("async function runAgentStep("));
    expect(agent.slice(0, 2500)).toContain("Why this step is running again");
  });
});
