/**
 * Idle time before an edit is written to disk. Long enough that a normal typing
 * burst is one save, short enough that "it saved itself" feels true.
 */
export const AUTOSAVE_MS = 1200;

export interface AutosaveGate {
  /** Is there anything unsaved for the open file? */
  dirty: boolean;
  /** A file is open and writable (not binary, not truncated). */
  editable: boolean;
  /** The file moved underneath us, or a save already came back 409. */
  conflicted: boolean;
  /** A save is in flight. */
  saving: boolean;
}

/**
 * Whether the autosave timer should be armed.
 *
 * Extracted from the component because the `conflicted` rule is the one thing here
 * that can go badly wrong: without it a rejected save retries every 1.2s forever,
 * spraying errors while the user types. Being a plain function makes that rule
 * testable instead of asserted.
 */
export function shouldAutosave(g: AutosaveGate): boolean {
  return g.editable && g.dirty && !g.conflicted && !g.saving;
}

/**
 * Should an incoming document be pushed into the live editor?
 *
 * Only when it is genuinely different content. Pushing needlessly resets the
 * caret, and this used to be a remount that also threw scroll position away — the
 * "it jumps to the top every time it saves" bug. Two guards, both needed:
 *
 * - `doc === emitted`: our own text coming back through the parent's state. The
 *   parent keeps the very string we emitted, so this is reference-equal and free.
 * - `current !== doc`: the refetch after a save returns identical text as a *new*
 *   string, so identity alone would let it through. Costs one compare, and only on
 *   a refetch — not per keystroke.
 */
export function shouldPushDoc(doc: string, emitted: string | null, current: string): boolean {
  if (doc === emitted) return false;
  return current !== doc;
}
