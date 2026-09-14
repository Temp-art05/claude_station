/**
 * Deliberately not an expression language. Four shapes, joined by `||` and
 * nothing else, so a workflow can't grow into a scripting environment nobody can
 * reason about:
 *
 *   answers.<key> == "value"      answers.<key> != "value"
 *   answers.<key> == true|false
 *   steps.<key>.failed            steps.<key>.done      steps.<key>.skipped
 *   inputs.<key>                  inputs.<key> == "value"
 *
 * `inputs.<key>` is true when the person filled that box in. It exists because
 * the alternative was a step that runs for minutes to announce it has nothing to
 * do: the Jira steps of a run started without a project used to spend a whole
 * agent turn saying so.
 *
 * `||` is the one operator. "Skip unless one of these two was filled in" is a
 * real need — a Jira step wants either a project or a parent ticket — and every
 * way of expressing it without an `or` was worse than allowing one.
 *
 * Anything else throws, and the runner surfaces that as a step error rather than
 * silently treating the condition as true.
 */
export interface ConditionContext {
  answers: Record<string, string | null>;
  stepStatus: Record<string, string>;
  inputs: Record<string, string>;
}

const ANSWER_RE = /^answers\.([a-z0-9_-]+)\s*(==|!=)\s*(.+)$/i;
const STEP_RE = /^steps\.([a-z0-9_-]+)\.(failed|done|skipped)$/i;
const INPUT_RE = /^inputs\.([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:(==|!=)\s*(.+))?$/;

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
  const whole = condition?.trim();
  if (!whole) return true;
  // One operator, and it binds the whole line: any clause being true runs the step.
  if (whole.includes("||")) {
    return whole
      .split("||")
      .map((part) => evaluateCondition(part, ctx))
      .some(Boolean);
  }
  return evaluateClause(whole, ctx);
}

function evaluateClause(expr: string, ctx: ConditionContext): boolean {
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

  const input = INPUT_RE.exec(expr);
  if (input) {
    const [, key, op, rhsRaw] = input;
    const value = (ctx.inputs[key!] ?? "").trim();
    // Bare `inputs.x` asks whether it was filled in at all — the common case, and
    // the only thing a step needs in order to know it has nothing to do.
    if (!op) return value.length > 0;
    const equal = value === unquote(rhsRaw!);
    return op === "==" ? equal : !equal;
  }

  throw new ConditionError(
    `Cannot read condition "${expr}". Use answers.<key> == "value", steps.<key>.failed, or inputs.<key>`,
  );
}
