import { describe, expect, it } from "vitest";
import type { WorkflowStep } from "@claude-station/shared";
import { dependentsOf, depsOf, graphProblem, readySteps } from "../workflow-graph";

function step(key: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: key,
    workflowId: "w",
    sortOrder: 0,
    key,
    type: "agent",
    title: key,
    agentName: "dev",
    instruction: null,
    commandName: null,
    requiresConfirm: false,
    permissionMode: null,
    maxRetries: 0,
    condition: null,
    dependsOn: [],
    onFail: null,
    maxLoops: 0,
    cwdLabel: null,
    isolate: false,
    readOnly: false,
    model: null,
    ...extra,
  };
}

/** Statuses as a map, defaulting to pending — how a fresh run looks. */
function statuses(given: Record<string, string> = {}) {
  return (key: string) => given[key] ?? "pending";
}

describe("depsOf", () => {
  it("falls back to the step before it, so old workflows keep their order", () => {
    const steps = [step("a"), step("b"), step("c")];
    expect(depsOf(steps, steps[0]!)).toEqual([]);
    expect(depsOf(steps, steps[1]!)).toEqual(["a"]);
    expect(depsOf(steps, steps[2]!)).toEqual(["b"]);
  });

  it("uses declared dependencies when there are any", () => {
    const steps = [step("a"), step("b"), step("c", { dependsOn: ["a"] })];
    expect(depsOf(steps, steps[2]!)).toEqual(["a"]);
  });
});

describe("readySteps", () => {
  it("starts only the first step of a plain list", () => {
    const steps = [step("a"), step("b"), step("c")];
    expect(readySteps(steps, statuses()).map((s) => s.key)).toEqual(["a"]);
  });

  it("offers both branches at once when they name the same dependency", () => {
    const steps = [
      step("plan"),
      step("fe", { dependsOn: ["plan"] }),
      step("be", { dependsOn: ["plan"] }),
      step("join", { dependsOn: ["fe", "be"] }),
    ];
    const ready = readySteps(steps, statuses({ plan: "done" }));
    expect(ready.map((s) => s.key)).toEqual(["fe", "be"]);
  });

  it("holds a join until every branch has settled", () => {
    const steps = [
      step("plan"),
      step("fe", { dependsOn: ["plan"] }),
      step("be", { dependsOn: ["plan"] }),
      step("join", { dependsOn: ["fe", "be"] }),
    ];
    const half = readySteps(steps, statuses({ plan: "done", fe: "done" }));
    expect(half.map((s) => s.key)).toEqual(["be"]);

    const both = readySteps(steps, statuses({ plan: "done", fe: "done", be: "done" }));
    expect(both.map((s) => s.key)).toEqual(["join"]);
  });

  it("treats a skipped dependency as settled — a branch not taken blocks nothing", () => {
    const steps = [
      step("route"),
      step("plan", { dependsOn: ["route"] }),
      step("impl", { dependsOn: ["plan"] }),
    ];
    const ready = readySteps(steps, statuses({ route: "done", plan: "skipped" }));
    expect(ready.map((s) => s.key)).toEqual(["impl"]);
  });

  it("blocks on a failed dependency", () => {
    const steps = [step("test"), step("pr", { dependsOn: ["test"] })];
    expect(readySteps(steps, statuses({ test: "failed" }))).toEqual([]);
  });

  it("lets a recovery step through on exactly the failure it names", () => {
    const steps = [
      step("test"),
      step("fix", { dependsOn: ["test"], condition: "steps.test.failed" }),
    ];
    const ready = readySteps(steps, statuses({ test: "failed" }));
    expect(ready.map((s) => s.key)).toEqual(["fix"]);
  });

  it("does not let a step through on someone else's failure", () => {
    const steps = [
      step("lint"),
      step("test", { dependsOn: ["lint"] }),
      step("fix", { dependsOn: ["test"], condition: "steps.lint.failed" }),
    ];
    expect(readySteps(steps, statuses({ lint: "done", test: "failed" }))).toEqual([]);
  });
});

describe("dependentsOf", () => {
  it("follows the chain, not the list order", () => {
    const steps = [
      step("plan"),
      step("fe", { dependsOn: ["plan"] }),
      step("be", { dependsOn: ["plan"] }),
      step("join", { dependsOn: ["fe", "be"] }),
    ];
    expect(dependentsOf(steps, "fe").sort()).toEqual(["join"]);
    expect(dependentsOf(steps, "plan").sort()).toEqual(["be", "fe", "join"]);
    expect(dependentsOf(steps, "join")).toEqual([]);
  });

  it("leaves a sibling branch alone — retrying one must not redo the other", () => {
    const steps = [
      step("plan"),
      step("fe", { dependsOn: ["plan"] }),
      step("be", { dependsOn: ["plan"] }),
    ];
    expect(dependentsOf(steps, "fe")).toEqual([]);
  });
});

describe("graphProblem", () => {
  it("passes a plain list", () => {
    expect(
      graphProblem([
        { key: "a", dependsOn: [] },
        { key: "b", dependsOn: ["a"] },
      ]),
    ).toBeNull();
  });

  it("catches a dependency that names nothing", () => {
    expect(graphProblem([{ key: "a", dependsOn: ["ghost"] }])).toMatch(/unknown step "ghost"/);
  });

  it("catches a step depending on itself", () => {
    expect(graphProblem([{ key: "a", dependsOn: ["a"] }])).toMatch(/depends on itself/);
  });

  it("catches a circle", () => {
    const problem = graphProblem([
      { key: "a", dependsOn: ["c"] },
      { key: "b", dependsOn: ["a"] },
      { key: "c", dependsOn: ["b"] },
    ]);
    expect(problem).toMatch(/circle/);
  });

  it("catches a gate falling back to a step that isn't there", () => {
    expect(graphProblem([{ key: "gate", dependsOn: [], onFail: "nope" }])).toMatch(
      /falls back to unknown step "nope"/,
    );
  });
});
