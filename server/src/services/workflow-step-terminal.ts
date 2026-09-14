import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { WorkflowRun, WorkflowStep } from "@claude-station/shared";
import { db, schema } from "../db";
import { TOKEN } from "../lib/auth";
import { isComposerReady, isTrustDialog } from "../lib/claude-screen";
import { env } from "../lib/config";
import { DATA_DIR } from "../lib/data-dir";
import { REPO_ROOT } from "../lib/repo-root";
import { onTurnClosed } from "./session-ledger";
import { createTerminal } from "./terminals";
import { recentOutput, write as ptyWrite, sessionAlive } from "./pty-manager";

/**
 * Running a workflow step inside a real `claude` terminal.
 *
 * The engine used to drive steps through headless Agent SDK sessions. They work,
 * but you cannot watch one the way you watch a terminal — and watching is the
 * whole reason somebody sits with an agent that is changing their repo. So the
 * engine still schedules, still gates, still stops on a question; what changed is
 * that a step's turn happens in a PTY you can read as it types.
 *
 * Two pieces make it possible, and both already existed:
 *   - The CLI is pinned to a session id we choose, so its transcript is findable.
 *   - The transcript follower closes a ledger turn the moment that turn ends,
 *     which is exactly the "this step is finished" signal the engine needs. It is
 *     what A1 bought, used for something A1 was not built for.
 */

/** How long to wait for one turn before calling the step stuck. */
const TURN_TIMEOUT_MS = 45 * 60_000;
/** How long to wait for the CLI to reach its composer before giving up on it. */
const READY_TIMEOUT_MS = 60_000;

/**
 * The MCP config a step's CLI is started with.
 *
 * Written per run rather than per step: the bridge resolves which step is current
 * from the run itself, so one file serves every step and there is nothing to
 * rewrite when the run moves on.
 */
function writeMcpConfig(run: WorkflowRun): string {
  const dir = join(DATA_DIR, "workflows", run.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "mcp.json");
  const config = {
    mcpServers: {
      station: {
        command: "node",
        args: [join(REPO_ROOT, "scripts", "station-mcp-bridge.mjs")],
        env: {
          CLAUDE_STATION_URL: `http://127.0.0.1:${env.port}`,
          CLAUDE_STATION_TOKEN: TOKEN,
          CLAUDE_STATION_PROJECT: run.projectId,
          CLAUDE_STATION_RUN: run.id,
        },
      },
    },
  };
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/**
 * The terminal a step runs in: its own, reused across retries and gate loops so
 * the agent keeps the context of what it already tried.
 */
export function terminalForStep(
  run: WorkflowRun,
  step: WorkflowStep,
  cwdPathId: string | null,
): { terminalId: string; claudeSessionId: string } {
  const existing = db
    .select()
    .from(schema.workflowRunSteps)
    .where(eq(schema.workflowRunSteps.runId, run.id))
    .all()
    .find((s) => s.stepKey === step.key);

  if (existing?.terminalId) {
    const row = db
      .select()
      .from(schema.terminals)
      .where(eq(schema.terminals.id, existing.terminalId))
      .get();
    if (row?.claudeSessionId && sessionAlive(row.id)) {
      return { terminalId: row.id, claudeSessionId: row.claudeSessionId };
    }
  }

  const terminal = createTerminal(run.projectId, {
    kind: "claude",
    title: `${run.title} · ${step.title}`.slice(0, 80),
    cwdPathId: cwdPathId ?? undefined,
    envSetId: run.envSetId,
    // A step that declares itself isolated gets its own worktree even when the run
    // doesn't use one: that is the only way two branches may touch the same repo.
    useWorktree: step.isolate || run.useWorktree,
    mcpConfigFile: writeMcpConfig(run),
    permissionMode: step.permissionMode ?? undefined,
  });
  return { terminalId: terminal.id, claudeSessionId: terminal.claudeSessionId! };
}

/**
 * Wait until the CLI is actually ready to be typed at.
 *
 * A fixed delay was not enough and never could be: a cold start takes as long as
 * it takes, and — worse — the CLI may be showing a dialog rather than a composer,
 * in which case the keystrokes answer the dialog instead.
 */
async function waitForComposer(terminalId: string): Promise<{ ok: boolean; error?: string }> {
  const until = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (!sessionAlive(terminalId)) {
      return { ok: false, error: "The step's terminal exited before it was ready" };
    }
    // The visible screen is enough, and this runs twice a second: asking tmux for
    // the whole scrollback each time would be paying for history nobody reads.
    const text = recentOutput(terminalId, 4000);
    if (isTrustDialog(text)) {
      return {
        ok: false,
        error:
          "Claude is asking whether it trusts this folder. Open this step's terminal and answer " +
          "once — it is asked per folder, and a run must not answer it on your behalf.",
      };
    }
    if (isComposerReady(text)) return { ok: true };
    if (Date.now() > until) {
      return {
        ok: false,
        error:
          "The CLI did not reach its prompt within a minute — open the step's terminal to see why",
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Type the prompt in and wait for the turn to end.
 *
 * Bracketed paste, then Enter: without the markers a multi-line prompt is read as
 * a line at a time and the CLI answers the first paragraph.
 */
export async function runTurnInTerminal(input: {
  terminalId: string;
  claudeSessionId: string;
  prompt: string;
  /** Stop waiting at this moment, whatever the turn is doing. */
  deadlineAt?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { terminalId, claudeSessionId, prompt } = input;

  // Subscribe before typing: a short turn can close before the await is reached.
  let resolveTurn: (result: { ok: boolean; error?: string }) => void = () => {};
  const finished = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    resolveTurn = resolve;
  });
  const off = onTurnClosed(claudeSessionId, (_turnId, status) => {
    resolveTurn(
      status === "done" ? { ok: true } : { ok: false, error: `The turn ended as ${status}` },
    );
  });

  try {
    const ready = await waitForComposer(terminalId);
    if (!ready.ok) return ready;

    const paste = `\x1b[200~${prompt.replace(/\r\n?/g, "\n")}\x1b[201~\r`;
    if (!ptyWrite(terminalId, paste)) {
      return { ok: false, error: "Could not write the prompt into the step's terminal" };
    }

    const budget = input.deadlineAt
      ? Math.max(30_000, input.deadlineAt - Date.now())
      : TURN_TIMEOUT_MS;
    const timeout = new Promise<{ ok: boolean; error?: string }>((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: false,
            error: `No turn finished within ${Math.round(budget / 60_000)} minutes — open the step's terminal to see where it is`,
          }),
        Math.min(budget, TURN_TIMEOUT_MS),
      ).unref?.(),
    );
    return await Promise.race([finished, timeout]);
  } finally {
    off();
  }
}
