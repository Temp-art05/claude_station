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
