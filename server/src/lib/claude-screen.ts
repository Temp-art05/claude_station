/**
 * Reading a `claude` terminal's screen, as opposed to showing it.
 *
 * A workflow step types its prompt into a real CLI, so before it types it has to
 * know what is on screen: a composer waiting for input, or a dialog that would
 * swallow those keystrokes as an answer. Both questions are pure string work,
 * kept here so they can be asked of a captured pane in a test instead of by
 * starting a terminal and hoping.
 */

/**
 * The hint line under the composer, in each of the permission modes.
 *
 * Matched on the hint rather than the `›` glyph: the glyph is drawn inside
 * dialogs too, so a prompt typed on the strength of it lands in whatever is
 * asking.
 */
const COMPOSER =
  /\? for shortcuts|auto[- ]accept edits|auto mode on|bypass permissions|plan mode on|accept edits on/i;

/**
 * The first-run trust dialog, and the reason any of this exists.
 *
 * The CLI asks whether it trusts a folder it has not seen, and the highlighted
 * answer is "No, exit". A prompt typed blind ends with Enter, so a step used to
 * answer that question by quitting — and all anyone saw was a terminal that
 * vanished and a step stuck on `running`.
 */
const TRUST_DIALOG =
  /trust (the )?(files|this folder)|Is this a project you created or one you trust|Do you trust the files in this folder/i;

/**
 * The CLI is mid-turn. It prints this while it works, and stops printing it the
 * moment the turn ends — which is the only honest end-of-turn signal available
 * from the outside: the transcript's totals are refreshed on every append, so
 * "the ledger closed the turn" means "we know more about it now", not "it is
 * over".
 */
const BUSY = /esc to interrupt|\(interrupt\)|Thinking…|Running…/i;

/**
 * The main agent has handed work to background agents and is sitting at an idle
 * composer until they report back. Nothing on screen says "busy", and the
 * composer is ready — exactly what a finished turn looks like. Reading it as one
 * marked an impl step done after its foundation layer, with four UI slices still
 * being written in the background, and every step after it checked a half-built
 * branch.
 *
 * Only the status line counts, and only while it is the last thing the main
 * agent said: it stays in the scrollback after the agents finish and the agent
 * writes on. The footer's "N agents" is no use — a freshly opened CLI shows one.
 */
const BACKGROUND_WAIT = /Waiting for \d+ background agents? to finish/gi;
/**
 * A line the main agent wrote — the end of any wait above it. Column 0 only: the
 * agents panel under the composer lists "  ⏺ main" indented, and that is a row in
 * a list, not something said after the wait.
 */
const AGENT_LINE = /^[⏺●] (.*)$/gm;
/** Written by the CLI when one background agent is done, not by the main agent. */
const AGENT_FINISHED = /^Agent ".*" (finished|failed|stopped)/;

/**
 * The CLI is asking the person to approve something — a command it may not run
 * on its own. Left undetected this looks exactly like a finished turn: output
 * stops, nothing more is written to the transcript, and a step waits or, worse,
 * is called done.
 */
const APPROVAL =
  /Do you want to proceed\?|requires approval|Do you want to (make this edit|create)|\bYes, and don't ask again\b/i;

/**
 * The CLI is asking the person something and will not move until they answer.
 *
 * Two shapes, and the engine used to mistake both for a broken terminal: the
 * approval dialog for a command, and the question UI an agent opens to put
 * choices to you. Neither is busy — nothing is running — and neither shows the
 * composer, so "not busy and no composer" read as "the CLI never came up", and a
 * step was failed out from under somebody who was mid-answer.
 */
const WAITING_MARKERS: [RegExp, string][] = [
  [/Do you want to proceed\?/i, "hộp xin phê duyệt"],
  [/requires approval/i, "lệnh cần phê duyệt"],
  [/Chat about this/i, "form câu hỏi của agent"],
  [/✓ Submit/i, "form câu hỏi của agent"],
];

/**
 * Footers a dialog draws — and so does a dialog that has just closed, for the
 * fraction of a second before the screen is redrawn.
 *
 * They were part of the detection and turned it into a liar: a step parked in
 * front of an empty terminal claiming somebody was being asked something. A claim
 * about the user's own screen, contradicted by the screen. They still help name
 * what is there once something else establishes that a dialog is up, which is all
 * they are good for.
 */
const WEAK_MARKERS = /Esc to cancel|Tab to amend/i;

/**
 * Which dialog is on screen, or null.
 *
 * Returns the marker rather than a boolean because the engine then stops a step
 * with a reason somebody can check against their own screen.
 */
export function waitingForPerson(screen: string): string | null {
  for (const [re, what] of WAITING_MARKERS) if (re.test(screen)) return what;
  if (TRUST_DIALOG.test(screen)) return "hộp hỏi có tin thư mục này không";
  return null;
}

/** True when something *else* has established a dialog is up and we want its name. */
export function looksLikeDialog(screen: string): boolean {
  return waitingForPerson(screen) !== null || WEAK_MARKERS.test(screen);
}

export function isBusy(screen: string): boolean {
  return BUSY.test(screen);
}

export function hasBackgroundAgents(screen: string): boolean {
  const waits = [...screen.matchAll(BACKGROUND_WAIT)];
  if (waits.length === 0) return false;
  const lastWait = waits[waits.length - 1]!.index!;
  for (const line of screen.matchAll(AGENT_LINE)) {
    if (line.index! > lastWait && !AGENT_FINISHED.test(line[1]!)) return false;
  }
  return true;
}

export function needsApproval(screen: string): boolean {
  return APPROVAL.test(screen);
}

export function isComposerReady(screen: string): boolean {
  return COMPOSER.test(screen);
}

export function isTrustDialog(screen: string): boolean {
  return TRUST_DIALOG.test(screen);
}
