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

export function isComposerReady(screen: string): boolean {
  return COMPOSER.test(screen);
}

export function isTrustDialog(screen: string): boolean {
  return TRUST_DIALOG.test(screen);
}
