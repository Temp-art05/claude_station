/**
 * Deliberately not an expression language. Three shapes only, so a workflow
 * can't grow into a scripting environment nobody can reason about:
 *
 *   answers.<key> == "value"      answers.<key> != "value"
 *   answers.<key> == true|false
 *   steps.<key>.failed            steps.<key>.done      steps.<key>.skipped
 *
 * Anything else throws, and the runner surfaces that as a step error rather than
 * silently treating the condition as true.
 */
export interface ConditionContext {
  answers: Record<string, string | null>;
  stepStatus: Record<string, string>;
}

const ANSWER_RE = /^answers\.([a-z0-9_-]+)\s*(==|!=)\s*(.+)$/i;
const STEP_RE = /^steps\.([a-z0-9_-]+)\.(failed|done|skipped)$/i;

export class ConditionError extends Error {}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** True = run the step. An empty condition always runs. */
export function evaluateCondition(condition: string | null, ctx: ConditionContext): boolean {
  const expr = condition?.trim();
  if (!expr) return true;

  const step = STEP_RE.exec(expr);
  if (step) {
    const [, key, want] = step;
    const status = ctx.stepStatus[key!] ?? "pending";
    if (want === "failed") return status === "failed";
    if (want === "done") return status === "done";
    return status === "skipped";
  }

  const answer = ANSWER_RE.exec(expr);
  if (answer) {
    const [, key, op, rhsRaw] = answer;
    const actual = ctx.answers[key!] ?? null;
    const rhs = unquote(rhsRaw!);
    const equal =
      rhs === "true" || rhs === "false"
        ? (actual ?? "").toLowerCase() === rhs
        : (actual ?? "") === rhs;
    return op === "==" ? equal : !equal;
  }

  throw new ConditionError(
    `Cannot read condition "${expr}". Use answers.<key> == "value", answers.<key> == true, or steps.<key>.failed`,
  );
}
