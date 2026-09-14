import { describe, expect, it } from "vitest";
import { ConditionError, evaluateCondition } from "../workflow-condition";

const ctx = {
  answers: { scope: "fe-only", offline: "false", auth: "custom-jwt", empty: null },
  stepStatus: { test: "failed", plan: "done", "impl-be": "skipped" },
  inputs: { jiraProject: "IIP707", sprint: "", docs: "https://github.com/a/b/blob/main/x.md" },
};

describe("evaluateCondition", () => {
  it("runs the step when there is no condition", () => {
    expect(evaluateCondition(null, ctx)).toBe(true);
    expect(evaluateCondition("   ", ctx)).toBe(true);
  });

  it("compares answers by string", () => {
    expect(evaluateCondition('answers.scope == "fe-only"', ctx)).toBe(true);
    expect(evaluateCondition('answers.scope == "full"', ctx)).toBe(false);
    expect(evaluateCondition('answers.scope != "full"', ctx)).toBe(true);
  });

  it("accepts single quotes and stray spacing", () => {
    expect(evaluateCondition("answers.auth   ==   'custom-jwt'", ctx)).toBe(true);
  });

  it("compares booleans case-insensitively", () => {
    expect(evaluateCondition("answers.offline == false", ctx)).toBe(true);
    expect(evaluateCondition("answers.offline == true", ctx)).toBe(false);
  });

  it("treats a missing or unanswered key as not matching", () => {
    expect(evaluateCondition('answers.nope == "x"', ctx)).toBe(false);
    expect(evaluateCondition('answers.empty == "x"', ctx)).toBe(false);
    expect(evaluateCondition('answers.nope != "x"', ctx)).toBe(true);
  });

  it("reads step outcomes", () => {
    expect(evaluateCondition("steps.test.failed", ctx)).toBe(true);
    expect(evaluateCondition("steps.plan.failed", ctx)).toBe(false);
    expect(evaluateCondition("steps.plan.done", ctx)).toBe(true);
    expect(evaluateCondition("steps.impl-be.skipped", ctx)).toBe(true);
  });

  it("treats an unknown step as pending rather than failed", () => {
    expect(evaluateCondition("steps.ghost.failed", ctx)).toBe(false);
    expect(evaluateCondition("steps.ghost.done", ctx)).toBe(false);
  });

  // The runner surfaces this as a step error instead of silently running.
  it("rejects anything outside the three supported shapes", () => {
    expect(() => evaluateCondition("answers.scope && true", ctx)).toThrow(ConditionError);
    expect(() => evaluateCondition("1 == 1", ctx)).toThrow(ConditionError);
    expect(() => evaluateCondition("steps.test.running", ctx)).toThrow(ConditionError);
    expect(() => evaluateCondition("process.exit(1)", ctx)).toThrow(ConditionError);
  });
});

describe("inputs", () => {
  it("is true when the box was filled in", () => {
    expect(evaluateCondition("inputs.jiraProject", ctx)).toBe(true);
  });

  it("is false for a box left empty, and for one that isn't there at all", () => {
    // These are the same thing to a step: nothing to work with. The Jira steps
    // used to spend a whole agent turn discovering it.
    expect(evaluateCondition("inputs.sprint", ctx)).toBe(false);
    expect(evaluateCondition("inputs.nothingLikeThis", ctx)).toBe(false);
  });

  it("compares a value when asked to", () => {
    expect(evaluateCondition('inputs.jiraProject == "IIP707"', ctx)).toBe(true);
    expect(evaluateCondition('inputs.jiraProject != "OTHER"', ctx)).toBe(true);
  });
});

describe("||", () => {
  it("runs the step when either side holds", () => {
    // The case it exists for: a Jira step needs a project *or* a parent ticket.
    expect(evaluateCondition("inputs.sprint || inputs.jiraProject", ctx)).toBe(true);
    expect(evaluateCondition("inputs.jiraProject || inputs.sprint", ctx)).toBe(true);
  });

  it("skips when neither does", () => {
    expect(evaluateCondition("inputs.sprint || inputs.nope", ctx)).toBe(false);
  });

  it("mixes clause kinds", () => {
    expect(evaluateCondition('steps.test.failed || answers.scope == "full"', ctx)).toBe(true);
    expect(evaluateCondition('steps.plan.failed || answers.scope == "full"', ctx)).toBe(false);
  });

  it("still refuses a clause it cannot read", () => {
    expect(() => evaluateCondition("inputs.a || nonsense", ctx)).toThrow(ConditionError);
  });
});
