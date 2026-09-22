import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { workflowInputSchema } from "@claude-station/shared";

/**
 * The confirmation gate is a conversation, not a form.
 *
 * It started as a question the engine invented after a step finished: the run
 * view showed a box, you typed one answer, the run moved on. Two things were
 * wrong with that. The terminal underneath — where the work actually happened —
 * sat silent, so a stopped step read as a hung one. And reviewing work is rarely
 * one answer: you ask the agent to change something, look again, ask again.
 *
 * So a step that needs confirming parks, its terminal is free, and you talk to
 * the agent that did the work for as long as you want. `continueStep` is the
 * moment you are satisfied — the only thing the run actually needs to know.
 */
const RUNNER = readFileSync(join(import.meta.dirname, "../workflow-runner.ts"), "utf8");

describe("the confirm gate", () => {
  it("parks the step instead of filing a question", () => {
    const settle = RUNNER.slice(RUNNER.indexOf("function settleStep"));
    const gate = settle.slice(settle.indexOf("step.requiresConfirm"));
    expect(gate.slice(0, 600)).toContain('status: "awaiting_input"');
    // A question would take one answer and close, which is the shape this stopped
    // being.
    expect(gate.slice(0, 600)).not.toContain("recordQuestions");
  });

  it("only gates when somebody is there to talk to", () => {
    expect(RUNNER).toContain("step.requiresConfirm && !run.autoMode");
  });

  it("tells the person where to look, in the note the step carries", () => {
    expect(RUNNER).toMatch(/terminal của step, rồi bấm Tiếp tục/);
  });
});

describe("continueStep", () => {
  const FN = RUNNER.slice(
    RUNNER.indexOf("export function continueStep"),
    RUNNER.indexOf("export async function skipStep"),
  );

  it("refuses to walk past a question the agent actually asked", () => {
    // That kind is parked inside a tool call: only an answer releases it, and
    // continuing would leave the agent waiting for ever.
    expect(FN).toContain("q.answer === null");
    expect(FN).toMatch(/answer it instead of continuing past it/);
  });

  it("only applies to a step that is waiting", () => {
    expect(FN).toMatch(/rs\.status !== "awaiting_input"/);
  });

  it("marks the step done and lets the run carry on", () => {
    expect(FN).toContain('status: "done"');
    expect(FN).toContain("advanceRun(runId)");
  });
});

describe("the workflows that use it", () => {
  const DIR = join(import.meta.dirname, "../../../../docs/workflows");

  it("only mark a step requiresConfirm where a person really decides", () => {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yaml"))) {
      const parsed = workflowInputSchema.parse(yaml.load(readFileSync(join(DIR, file), "utf8")));
      for (const step of parsed.steps.filter((s) => s.requiresConfirm)) {
        // A gate or a command has no terminal to talk in — marking one for
        // confirmation would park the run with nothing to review.
        expect({ file, key: step.key, type: step.type }).toEqual({
          file,
          key: step.key,
          type: "agent",
        });
      }
    }
  });
});
