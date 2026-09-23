/**
 * What an agent step says about its own outcome, as opposed to what its screen
 * says.
 *
 * The screen can only tell that a turn ended. A step that ends its turn saying
 * "not finished yet" or "the impl is half-built" used to be booked `done` all the
 * same — its only outlet was a note — and the run walked on to a PR. The agent
 * reports through `workflow_step_result`; this decides what the report does to
 * the turn's outcome.
 */

export interface StepReport {
  /** The dispatch it was made in. A report from an older one is about nothing. */
  generation: number;
  status: "done" | "failed";
  reason: string;
}

export interface ReportedOutcome {
  ok: boolean;
  error?: string;
  tail?: string;
  waiting?: boolean;
  /** The failure came from the agent's own verdict, not from the terminal. */
  reported?: boolean;
}

export function applyReport(
  result: { ok: boolean; error?: string; tail?: string; waiting?: boolean },
  report: StepReport | undefined,
  generation: number,
): ReportedOutcome {
  if (!report || report.generation !== generation) return result;
  // Somebody is being asked something; the verdict waits for the answer's turn.
  if (result.waiting) return result;
  // A turn that broke (timeout, dead terminal) keeps its own error: that is a
  // problem with running the step, and retrying it is the right response.
  if (!result.ok || report.status !== "failed") return result;
  // `tail` doubles as the loop fingerprint: two rounds failing for the same
  // stated reason are turning on the spot.
  return { ok: false, error: report.reason, tail: report.reason, reported: true };
}
