import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { workflowInputSchema } from "@claude-station/shared";
import { graphProblem, readySteps } from "../../lib/workflow-graph";

/**
 * The shipped workflow files are only useful if they import. A typo in one of
 * them surfaces as an error in the Import dialog long after it was written, so
 * they are parsed here with the same schema the importer uses.
 */
const DIR = join(import.meta.dirname, "../../../../docs/workflows");

const files = readdirSync(DIR).filter((f) => f.endsWith(".yaml"));

describe("shipped workflow library", () => {
  it("ships the set of shapes it claims to", () => {
    expect(files.sort()).toEqual([
      "bugfix-workflow.workflow.yaml",
      "bulk-change-workflow.workflow.yaml",
      "fe-be-spec-to-pr.workflow.yaml",
      "impl-fe-workflow.workflow.yaml",
      "impl-ios-ui-workflow.workflow.yaml",
      "impl-ios-workflow.workflow.yaml",
      "ios-be-spec-to-pr.workflow.yaml",
      "specs-to-jira.workflow.yaml",
    ]);
  });

  for (const file of files) {
    describe(file, () => {
      const parsed = workflowInputSchema.parse(yaml.load(readFileSync(join(DIR, file), "utf8")));

      it("parses with the importer's own schema", () => {
        expect(parsed.steps.length).toBeGreaterThan(0);
      });

      it("has a runnable graph", () => {
        expect(graphProblem(parsed.steps)).toBeNull();
      });

      it("can actually start — at least one step is ready on a fresh run", () => {
        expect(readySteps(withIds(parsed.steps), () => "pending").length).toBeGreaterThan(0);
      });

      it("names a command wherever the exit code decides", () => {
        for (const step of parsed.steps) {
          if (step.type === "gate" || step.type === "command")
            expect(step.commandName).toBeTruthy();
          if (step.type === "agent") expect(step.agentName).toBeTruthy();
        }
      });

      it("keeps every gate's loop at three or fewer", () => {
        for (const step of parsed.steps.filter((s) => s.type === "gate")) {
          expect(step.maxLoops).toBeLessThanOrEqual(3);
        }
      });
    });
  }

  it("runs every agent step at a permission mode that does not stop for a shell command", () => {
    // `acceptEdits` auto-accepts *edits* only: the first `git status` still opens
    // a dialog, and a step running with nobody watching parks there until its
    // budget runs out. The trade is deliberate — a step may run any command
    // without asking — and it is bounded by the step working in its own worktree
    // and by merge staying a person's.
    for (const file of files) {
      const parsed = workflowInputSchema.parse(yaml.load(readFileSync(join(DIR, file), "utf8")));
      for (const step of parsed.steps.filter((s) => s.type === "agent")) {
        expect({ file, key: step.key, mode: step.permissionMode }).toEqual({
          file,
          key: step.key,
          mode: "bypassPermissions",
        });
      }
    }
  });

  it("fans out after the plan, and again at the end", () => {
    // impl-ios-workflow is the reference the others copy: the Jira split and the
    // confirm both hang off `plan`, and PR and the Jira summary hang off the last
    // fix. Neither pair waits on the other, and neither writes what the other is
    // reading.
    const parsed = workflowInputSchema.parse(
      yaml.load(readFileSync(join(DIR, "impl-ios-workflow.workflow.yaml"), "utf8")),
    );
    const steps = withIds(parsed.steps);

    const afterPlan = readySteps(steps, (key) => (key === "plan" ? "done" : "pending"));
    expect(afterPlan.map((s) => s.key).sort()).toEqual(["confirm-plan", "jira-tasks"]);

    const settled = new Set([
      "plan",
      "jira-tasks",
      "confirm-plan",
      "impl",
      "test",
      "review",
      "fix-review",
    ]);
    const afterFix = readySteps(steps, (key) => (settled.has(key) ? "done" : "pending"));
    expect(afterFix.map((s) => s.key).sort()).toEqual(["jira-report", "pr"]);
  });

  it("gives the parallel Jira steps a claim of their own", () => {
    // Two steps never share a working tree, so without this the Jira half simply
    // waits a whole turn for a directory it never touches — "parallel" on paper,
    // sequential in fact.
    for (const file of files) {
      const parsed = workflowInputSchema.parse(yaml.load(readFileSync(join(DIR, file), "utf8")));
      for (const step of parsed.steps.filter((s) => s.agentName === "jira-pm")) {
        expect({ file, key: step.key, readOnly: step.readOnly }).toEqual({
          file,
          key: step.key,
          readOnly: true,
        });
      }
    }
  });

  it("moves each task through Jira as it goes, not once at the end", () => {
    for (const file of files) {
      const parsed = workflowInputSchema.parse(yaml.load(readFileSync(join(DIR, file), "utf8")));
      // Only workflows that touch the board at all. One that never opens Jira —
      // the UI loop, whose whole job is a screenshot against a design — has no
      // task to move, and demanding it say "In Progress" would be asking it to
      // lie about a board it doesn't use.
      const usesJira =
        parsed.steps.some((s) => s.agentName === "jira-pm") ||
        parsed.inputs.some((i) => i.type.startsWith("jira"));
      if (!usesJira) continue;
      const impl = parsed.steps.find((s) => ["impl", "impl-ios", "impl-fe", "fix"].includes(s.key));
      if (!impl) continue;
      // In Progress before the first line of code, Resolved the moment a task is
      // done — a board that is only correct at the end is a board nobody trusts
      // in the middle.
      expect({ file, live: /In Progress/.test(impl.instruction ?? "") }).toEqual({
        file,
        live: true,
      });
      expect({ file, live: /Resolved/.test(impl.instruction ?? "") }).toEqual({ file, live: true });
    }
  });

  it("runs the two sides of a fe-be feature side by side", () => {
    const parsed = workflowInputSchema.parse(
      yaml.load(readFileSync(join(DIR, "fe-be-spec-to-pr.workflow.yaml"), "utf8")),
    );
    const steps = withIds(parsed.steps);
    const ready = readySteps(steps, (key) =>
      key === "plan" || key === "jira-tasks" ? "done" : "pending",
    );
    expect(ready.map((s) => s.key).sort()).toEqual(["impl-be", "impl-fe"]);
    // Two repos, two working trees — otherwise the scheduler hands them out one
    // per round and "parallel" is a label rather than a fact.
    expect(new Set(ready.map((s) => s.cwdLabel)).size).toBe(2);
  });

  it("sends every worker of a bulk change to its own worktree", () => {
    const parsed = workflowInputSchema.parse(
      yaml.load(readFileSync(join(DIR, "bulk-change-workflow.workflow.yaml"), "utf8")),
    );
    const workers = parsed.steps.filter((s) => s.key.startsWith("worker-"));
    expect(workers.length).toBe(3);
    for (const w of workers) expect(w.isolate).toBe(true);
  });

  it("has a different agent grade the work than the one that did it", () => {
    // The whole point of folding review in: the author grading itself passes
    // every time, so `review` must not name the step's own implementer.
    for (const file of files) {
      const parsed = workflowInputSchema.parse(yaml.load(readFileSync(join(DIR, file), "utf8")));
      const review = parsed.steps.find((s) => s.key === "review");
      if (!review) continue;
      const implementers = parsed.steps
        .filter((s) => s.key.startsWith("impl") || s.key === "fix" || s.key === "fix-review")
        .map((s) => s.agentName);
      expect(implementers).not.toContain(review.agentName);
    }
  });

  it("skips its Jira steps instead of spending a turn discovering it has none", () => {
    // A run started without a project or a parent ticket has nothing for these
    // steps to do. Left unconditional they each open a terminal, start a CLI, and
    // burn minutes to say so.
    for (const file of files) {
      const parsed = workflowInputSchema.parse(yaml.load(readFileSync(join(DIR, file), "utf8")));
      // A workflow whose Jira input is *required* always has work for these steps —
      // specs-to-jira is exactly that, and a condition there would be noise.
      const jiraIsOptional =
        parsed.inputs.some((i) => /jira|parentTicket/i.test(i.key)) &&
        !parsed.inputs.some((i) => /jira/i.test(i.key) && i.required);
      if (!jiraIsOptional) continue;
      for (const step of parsed.steps.filter((s) => s.agentName === "jira-pm")) {
        expect({ file, key: step.key, condition: step.condition }).toEqual({
          file,
          key: step.key,
          condition: expect.stringContaining("inputs."),
        });
      }
    }
  });

  it("creates tickets only after checking what is already there", () => {
    // Re-running a workflow on the same spec must not refill the board. The rule
    // lives in the jira-pm agent, but every step that creates has to invoke it.
    for (const file of files) {
      const parsed = workflowInputSchema.parse(yaml.load(readFileSync(join(DIR, file), "utf8")));
      for (const step of parsed.steps) {
        // Only the steps that actually create — a step that just comments back
        // has nothing to deduplicate.
        if (step.agentName !== "jira-pm") continue;
        if (!/jira_create_issue|tạo trên|tạo phần còn/i.test(step.instruction ?? "")) continue;
        expect({ file, checks: /tra ticket|jira_search/i.test(step.instruction ?? "") }).toEqual({
          file,
          checks: true,
        });
      }
    }
  });
});

/** The graph helpers take full steps; the schema gives step inputs. */
function withIds(steps: ReturnType<typeof workflowInputSchema.parse>["steps"]) {
  return steps.map((s, i) => ({ ...s, id: `s${i}`, workflowId: "w", sortOrder: i }));
}
