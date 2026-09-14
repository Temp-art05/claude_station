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
      "branch-by-answer.workflow.yaml",
      "draft-critique-revise.workflow.yaml",
      "gate-loop-impl-test.workflow.yaml",
      "github-req-to-jira.workflow.yaml",
      "impl-fe-workflow.workflow.yaml",
      "impl-ios-workflow.workflow.yaml",
      "orchestrator-tasks.workflow.yaml",
      "parallel-multi-repo.workflow.yaml",
      "review-swarm.workflow.yaml",
      "seq-feature-auto.workflow.yaml",
      "spec-doc-to-delivery.workflow.yaml",
      "spec-doc-to-tasks.workflow.yaml",
      "ticket-to-pr.workflow.yaml",
      "voting-review.workflow.yaml",
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

  it("runs the two multi-repo branches side by side", () => {
    const parsed = workflowInputSchema.parse(
      yaml.load(readFileSync(join(DIR, "parallel-multi-repo.workflow.yaml"), "utf8")),
    );
    const steps = withIds(parsed.steps);
    const ready = readySteps(steps, (key) => (key === "plan" ? "done" : "pending"));
    expect(ready.map((s) => s.key).sort()).toEqual(["impl-be", "impl-fe", "impl-ios"]);
    // Three repos, three different working trees — otherwise the scheduler would
    // hand them out one per round and "parallel" would be a label, not a fact.
    expect(new Set(ready.map((s) => s.cwdLabel)).size).toBe(3);
  });

  it("sends every review of the swarm to its own worktree", () => {
    const parsed = workflowInputSchema.parse(
      yaml.load(readFileSync(join(DIR, "review-swarm.workflow.yaml"), "utf8")),
    );
    const reviewers = parsed.steps.filter((s) => s.key.startsWith("review-"));
    expect(reviewers.length).toBe(3);
    for (const r of reviewers) expect(r.isolate).toBe(true);
  });

  it("takes only the branch the answer chose", () => {
    const parsed = workflowInputSchema.parse(
      yaml.load(readFileSync(join(DIR, "branch-by-answer.workflow.yaml"), "utf8")),
    );
    const hotfix = parsed.steps.find((s) => s.key === "impl-hotfix");
    const feature = parsed.steps.find((s) => s.key === "impl-feature");
    expect(hotfix?.condition).toBe('answers.scope == "hotfix"');
    expect(feature?.condition).toBe('answers.scope == "feature"');
  });
});

/** The graph helpers take full steps; the schema gives step inputs. */
function withIds(steps: ReturnType<typeof workflowInputSchema.parse>["steps"]) {
  return steps.map((s, i) => ({ ...s, id: `s${i}`, workflowId: "w", sortOrder: i }));
}
