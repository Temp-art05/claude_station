import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { workflowInputSchema } from "@claude-station/shared";

/**
 * The confirmation gate belongs to the step, not to the engine.
 *
 * It used to be a question the engine invented after a step finished. That works
 * — the run parks, the run view shows it — but the terminal underneath sat
 * silent, and the terminal is where somebody watching a step is actually looking.
 * A step that stops for confirmation with nothing on screen reads as a step that
 * hung.
 *
 * So the instruction now goes into the step's own prompt, which is built here in
 * the runner. These assert the wording that makes that work, because it is the
 * kind of text an edit can quietly drop.
 */

const RUNNER = readFileSync(join(import.meta.dirname, "../workflow-runner.ts"), "utf8");

describe("the confirm gate the step is told to raise", () => {
  it("is added to the prompt only when the step asked for it and someone is watching", () => {
    expect(RUNNER).toContain("step.requiresConfirm && !run.autoMode");
    // An unattended run has nobody to confirm to: the gate is the thing that mode
    // exists to remove.
    expect(RUNNER).toMatch(/## Before you finish this step/);
  });

  it("names workflow_ask and the key the engine will look for", () => {
    expect(RUNNER).toMatch(/workflow_ask.*confirmKey\(step\)|confirmKey\(step\).*workflow_ask/s);
    expect(RUNNER).toContain("function confirmKey(step: WorkflowStep)");
  });

  it("nudges in the step's own terminal before inventing the question", () => {
    // Order matters: the engine files its own question only after the terminal
    // has been asked and said nothing. The other way round, the gate is invisible
    // again for every step that would have complied.
    const nudge = RUNNER.slice(RUNNER.indexOf("async function nudgeForConfirmation"));
    const askInTerminal = nudge.indexOf("runTurnInTerminal");
    const inventHere = nudge.indexOf("recordQuestions");
    expect(askInTerminal).toBeGreaterThan(-1);
    expect(inventHere).toBeGreaterThan(askInTerminal);
  });

  it("never leaves a step marked done while it waits", () => {
    const nudge = RUNNER.slice(RUNNER.indexOf("async function nudgeForConfirmation"));
    expect(nudge).toContain('status: "awaiting_input"');
  });
});

describe("the workflows that use it", () => {
  const DIR = join(import.meta.dirname, "../../../../docs/workflows");

  it("only mark a step requiresConfirm where a person really decides", () => {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yaml"))) {
      const parsed = workflowInputSchema.parse(yaml.load(readFileSync(join(DIR, file), "utf8")));
      for (const step of parsed.steps.filter((s) => s.requiresConfirm)) {
        // A gate or a command has no turn to ask in — marking one for
        // confirmation would park the run with nothing able to raise a question.
        expect({ file, key: step.key, type: step.type }).toEqual({
          file,
          key: step.key,
          type: "agent",
        });
      }
    }
  });
});
