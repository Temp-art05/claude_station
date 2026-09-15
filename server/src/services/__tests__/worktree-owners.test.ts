import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Who owns a worktree.
 *
 * Boot prunes worktrees whose owner is gone — that is what stops a dead session
 * from keeping a branch checked out. It decided "gone" by looking for a chat
 * session with that id, which was right until workflow steps moved into real
 * terminals: their checkouts are named after the *terminal*, so every one of them
 * was pruned on the next boot.
 *
 * The step then started a CLI in a directory that no longer existed. The PTY
 * exited instantly, the terminal row still said `running`, and the step waited
 * for a prompt that could never appear — a failure that reads as the terminal
 * being broken rather than as its folder having been deleted underneath it.
 */
const SESSIONS = readFileSync(join(import.meta.dirname, "../sessions.ts"), "utf8");
const RECONCILE = SESSIONS.slice(
  SESSIONS.indexOf("export function reconcileWorktreesOnBoot"),
  SESSIONS.indexOf("/** Shared by the chat routes"),
);

describe("reconcileWorktreesOnBoot", () => {
  it("counts terminals as owners, not just chat sessions", () => {
    expect(RECONCILE).toContain("schema.chatSessions.id");
    expect(RECONCILE).toContain("schema.terminals.id");
  });

  it("only spares terminals that are still open", () => {
    // A terminal that was closed properly should take its checkout with it —
    // otherwise the prune never reclaims anything and branches stay checked out.
    expect(RECONCILE).toMatch(/closedAt === null/);
  });
});
