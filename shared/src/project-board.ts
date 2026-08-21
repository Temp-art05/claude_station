/**
 * The Projects page is a two-column board (Working on / Backlog), and a card can
 * be dropped into either column at any slot. The arithmetic of that move lives
 * here so it can be tested on its own, away from drag events.
 */
import type { ProjectBoardInput, ProjectStatus } from "./types";

/**
 * `id` moved into `status` at `index`, as the board would then read. `null` when
 * the card would land exactly where it already is — the caller can skip the
 * write instead of round-tripping a no-op.
 */
export function moveOnBoard(
  board: ProjectBoardInput,
  id: string,
  status: ProjectStatus,
  index: number,
): ProjectBoardInput | null {
  const next: ProjectBoardInput = { active: [...board.active], backlog: [...board.backlog] };
  const from: ProjectStatus = next.active.includes(id) ? "active" : "backlog";
  const wasAt = next[from].indexOf(id);
  if (wasAt === -1) return null;
  next[from] = next[from].filter((x) => x !== id);
  // Pulling the card out shifts every slot below it up by one, so a drop below
  // its old position has to come back down by that same one.
  const at = from === status && wasAt < index ? index - 1 : index;
  next[status].splice(at, 0, id);
  const same =
    next.active.join(" ") === board.active.join(" ") &&
    next.backlog.join(" ") === board.backlog.join(" ");
  return same ? null : next;
}
