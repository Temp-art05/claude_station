import type { WorkflowStep } from "@claude-station/shared";

/**
 * The shape of a run, separated from running one.
 *
 * Which steps may start, and what has to be redone when one of them is retried,
 * are questions about a graph and nothing else — no sessions, no commands, no
 * database. Kept here they can be tested by asking them, instead of by starting
 * a run and watching what happens.
 */

/** Anything that counts as "this dependency is behind us". */
const SETTLED = new Set(["done", "skipped"]);

/**
 * What a step waits for: its declared dependencies, or — when it declares none —
 * the step before it in the list. That fallback is the whole compatibility story:
 * every workflow written before dependencies existed means exactly what it did.
 */
export function depsOf(steps: WorkflowStep[], step: WorkflowStep): string[] {
  if (step.dependsOn.length > 0) return step.dependsOn;
  const i = steps.findIndex((s) => s.key === step.key);
  return i > 0 ? [steps[i - 1]!.key] : [];
}

/**
 * Steps that can start right now: still pending, and every dependency settled.
 *
 * A failed dependency blocks — unless the waiting step exists precisely because
 * of that failure, which is what `steps.<key>.failed` in a condition says. That
 * is how a fix-tests step gets to run at all.
 */
export function readySteps(
  steps: WorkflowStep[],
  statusOf: (key: string) => string,
): WorkflowStep[] {
  return steps.filter((step) => {
    if (statusOf(step.key) !== "pending") return false;
    return depsOf(steps, step).every((dep) => {
      const status = statusOf(dep);
      if (SETTLED.has(status)) return true;
      return status === "failed" && (step.condition?.includes(`steps.${dep}.failed`) ?? false);
    });
  });
}

/**
 * Everything downstream of a step, transitively — what a retry or a gate's
 * loop-back has to redo. Deliberately not "every later step": a branch running
 * beside this one was computed from something else and is still valid.
 */
export function dependentsOf(steps: WorkflowStep[], key: string): string[] {
  const found = new Set<string>();
  const visit = (from: string): void => {
    for (const step of steps) {
      if (found.has(step.key) || step.key === from) continue;
      if (depsOf(steps, step).includes(from)) {
        found.add(step.key);
        visit(step.key);
      }
    }
  };
  visit(key);
  return [...found];
}

/**
 * Reject a graph that can't run, at the moment it is saved. A cycle or a
 * dependency naming nothing would otherwise show up as a run that quietly never
 * starts a step, which reads like the scheduler is broken.
 *
 * Returns the problem as a sentence, or null when the graph is fine — the caller
 * decides whether that is a 400 or a validation message.
 */
export function graphProblem(
  steps: { key: string; dependsOn: string[]; onFail?: string | null }[],
): string | null {
  const keys = new Set(steps.map((s) => s.key));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.key) return `Step "${step.key}" depends on itself`;
      if (!keys.has(dep)) return `Step "${step.key}" depends on unknown step "${dep}"`;
    }
    if (step.onFail && !keys.has(step.onFail)) {
      return `Gate "${step.key}" falls back to unknown step "${step.onFail}"`;
    }
  }

  // Only declared edges can close a circle; the implicit "the step before me"
  // edge always points backwards through the list.
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const mark = new Map<string, "open" | "closed">();
  let problem: string | null = null;
  const walk = (key: string, trail: string[]): void => {
    if (problem) return;
    if (mark.get(key) === "closed") return;
    if (mark.get(key) === "open") {
      problem = `Steps depend on each other in a circle: ${[...trail, key].join(" → ")}`;
      return;
    }
    mark.set(key, "open");
    for (const dep of byKey.get(key)?.dependsOn ?? []) walk(dep, [...trail, key]);
    mark.set(key, "closed");
  };
  for (const step of steps) walk(step.key, []);
  return problem;
}
