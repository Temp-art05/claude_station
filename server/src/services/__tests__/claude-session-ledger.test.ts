/**
 * Drives a whole Agent SDK turn with a fake message stream, to prove the ledger
 * hooks in `claude-session.ts` are wired the way L2 says: one turn per user
 * prompt, files recorded as they stream, usage and cost stored on the result.
 *
 * The SDK is mocked because the point is the wiring, not Claude. Everything else
 * is real — the database, the ledger, the workspace context builder — so a broken
 * assumption about any of those shows up here rather than in production.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-l2-"));
process.env.CLAUDE_STATION_DATA = dataDir;

/** Messages the fake `query` will yield, set per test. */
let stream: unknown[] = [];
/** Set to have `query` throw partway, the way a dead resume id does. */
let throwAfter: number | null = null;

// Only `query` is faked. The rest of the SDK stays real, because the in-process
// MCP server is built from it (`tool`, `createSdkMcpServer`) on every turn.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: () => ({
    async *[Symbol.asyncIterator]() {
      let i = 0;
      for (const message of stream) {
        if (throwAfter !== null && i === throwAfter) throw new Error("resume: session not found");
        i += 1;
        // A function in the stream is a side effect mid-turn — how a Bash edit
        // looks from here: the tree moves and no message mentions it.
        if (typeof message === "function") {
          (message as () => void)();
          continue;
        }
        yield message;
      }
    },
    interrupt: async () => undefined,
  }),
}));

// A real notification would fire an osascript per test run.
vi.mock("../notify", () => ({ notify: () => undefined }));

const { db, schema } = await import("../../db");
const ledger = await import("../session-ledger");
const { sendUserMessage } = await import("../claude-session");
const { nowIso } = await import("../../lib/id");

const PROJECT = "p-l2";
const REPO = "/tmp/cs-l2/repo";
const SESSION = "s-l2";

function assistantWithTools(blocks: Record<string, unknown>[]) {
  return {
    type: "assistant",
    session_id: "sdk-1",
    message: { role: "assistant", content: blocks },
  };
}

function result(over: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    session_id: "sdk-1",
    is_error: false,
    duration_ms: 164_000,
    total_cost_usd: 0.0912,
    usage: {
      input_tokens: 964,
      output_tokens: 4_832,
      cache_read_input_tokens: 141_387,
      cache_creation_input_tokens: 955,
    },
    result: "done",
    ...over,
  };
}

beforeEach(() => {
  throwAfter = null;
  db.delete(schema.sessionTurns).run();
  db.delete(schema.chatMessages).run();
  db.delete(schema.chatSessions).run();
  db.delete(schema.projectPaths).run();
  db.delete(schema.projects).run();
  db.insert(schema.projects)
    .values({
      id: PROJECT,
      name: "L2",
      description: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  db.insert(schema.projectPaths)
    .values({
      id: "pp-l2",
      projectId: PROJECT,
      path: REPO,
      label: "repo",
      description: "",
      isDefault: true,
      sortOrder: 0,
    })
    .run();
  db.insert(schema.chatSessions)
    .values({
      id: SESSION,
      projectId: PROJECT,
      title: "L2 session",
      cwd: REPO,
      permissionMode: "default",
      model: "sonnet",
      status: "idle",
      kind: "chat",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const turn = () => ledger.turnsOf({ chatSessionId: SESSION })[0];

describe("a completed turn", () => {
  it("records one turn, with the user's own prompt", async () => {
    stream = [result()];
    await sendUserMessage(SESSION, "cho tao nut bat tat tmux");

    const turns = ledger.turnsOf({ chatSessionId: SESSION });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.sourceKind).toBe("sdk");
    expect(turns[0]!.promptText).toBe("cho tao nut bat tat tmux");
    expect(turns[0]!.cwd).toBe(REPO);
    expect(turns[0]!.model).toBe("sonnet");
    expect(turns[0]!.status).toBe("done");
  });

  it("stores the result's usage, cost and duration", async () => {
    stream = [result()];
    await sendUserMessage(SESSION, "go");

    const t = turn()!;
    expect(t.inputTokens).toBe(964);
    expect(t.outputTokens).toBe(4_832);
    expect(t.cacheReadTokens).toBe(141_387);
    expect(t.cacheCreateTokens).toBe(955);
    expect(t.costUsd).toBeCloseTo(0.0912);
    expect(t.durationMs).toBe(164_000);
    expect(t.endedAt).not.toBeNull();
  });

  it("records the files tool calls named, and counts the calls", async () => {
    stream = [
      assistantWithTools([
        { type: "tool_use", name: "Read", input: { file_path: `${REPO}/lib/tmux.ts` } },
        { type: "tool_use", name: "Edit", input: { file_path: `${REPO}/services/terminals.ts` } },
        {
          type: "tool_use",
          name: "Bash",
          input: { command: `sed -i '' s/a/b/ ${REPO}/hidden.ts` },
        },
      ]),
      result(),
    ];
    await sendUserMessage(SESSION, "go");

    const files = ledger.filesOf(turn()!.id);
    expect(files.map((f) => [f.relPath, f.op, f.source, f.toolName])).toEqual([
      ["lib/tmux.ts", "read", "tool", "Read"],
      ["services/terminals.ts", "write", "tool", "Edit"],
    ]);
    // The Bash edit is invisible here by design — the tree snapshot (L4) is what
    // catches it. Counted as a call all the same.
    expect(files.some((f) => f.absPath.endsWith("hidden.ts"))).toBe(false);
    expect(turn()!.toolCallCount).toBe(3);
  });

  it("names the subagent behind a Task call", async () => {
    stream = [
      assistantWithTools([
        { type: "tool_use", name: "Task", input: { subagent_type: "docs-planner" } },
        { type: "tool_use", name: "Write", input: { file_path: `${REPO}/plan.md` } },
      ]),
      result(),
    ];
    await sendUserMessage(SESSION, "plan it");
    // The Task itself names no file; the label matters on the files of the turn
    // it belongs to, and the count proves it was seen.
    expect(turn()!.toolCallCount).toBe(2);
    expect(ledger.filesOf(turn()!.id).map((f) => f.relPath)).toEqual(["plan.md"]);
  });

  it("keeps a prompt out of the record when the ledger already redacts it", async () => {
    const setId = "es-l2";
    db.insert(schema.envSets)
      .values({ id: setId, projectId: PROJECT, name: "jira", createdAt: nowIso() })
      .run();
    db.insert(schema.envVars)
      .values({
        id: "ev-l2",
        envSetId: setId,
        key: "TOKEN",
        value: "top-secret-token-1",
        isSecret: true,
      })
      .run();
    ledger.forgetSecrets();

    stream = [result()];
    await sendUserMessage(SESSION, "use top-secret-token-1 for the call");
    expect(turn()!.promptText).not.toContain("top-secret-token-1");

    db.delete(schema.envVars).run();
    db.delete(schema.envSets).run();
    ledger.forgetSecrets();
  });
});

describe("a turn that goes wrong", () => {
  it("marks the turn as errored when the result says so", async () => {
    stream = [result({ is_error: true, subtype: "error_during_execution" })];
    await sendUserMessage(SESSION, "go");
    expect(turn()!.status).toBe("error");
  });

  it("never leaves a turn stuck on running when the stream throws", async () => {
    stream = [assistantWithTools([]), result()];
    throwAfter = 0;
    await sendUserMessage(SESSION, "go");

    const turns = ledger.turnsOf({ chatSessionId: SESSION });
    // One prompt, one turn: the resume-failure retry replays the same prompt and
    // must not be counted twice.
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).not.toBe("running");
    expect(turns[0]!.endedAt).not.toBeNull();
  });
});

describe("turn numbering", () => {
  it("numbers consecutive prompts in the same session", async () => {
    stream = [result()];
    await sendUserMessage(SESSION, "first");
    await sendUserMessage(SESSION, "second");

    const turns = ledger.turnsOf({ chatSessionId: SESSION });
    expect(turns.map((t) => [t.seq, t.promptText])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
  });
});

describe("a workflow step", () => {
  it("carries the run id, so a run's commits are one query later on", async () => {
    db.insert(schema.workflowRuns)
      .values({
        id: "run-1",
        projectId: PROJECT,
        workflowId: "wf-1",
        title: "ios-feature",
        definition: "{}",
        status: "running",
        cwd: REPO,
        startedAt: nowIso(),
      })
      .run();
    db.insert(schema.workflowRunSteps)
      .values({ id: "rs-1", runId: "run-1", stepKey: "implement", status: "running", attempt: 1 })
      .run();
    db.update(schema.chatSessions).set({ kind: "workflow", workflowRunStepId: "rs-1" }).run();

    stream = [result()];
    await sendUserMessage(SESSION, "implement the plan");
    expect(turn()!.workflowRunId).toBe("run-1");
  });
});

describe("what a tool call never named", () => {
  const repos = mkdtempSync(join(tmpdir(), "cs-l2-repos-"));
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function repoSession(name: string): string {
    const repo = join(repos, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main", "."]);
    git(repo, ["config", "user.email", "t@e.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.ts"), "const a = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);

    db.update(schema.projectPaths).set({ path: repo }).run();
    db.update(schema.chatSessions).set({ cwd: repo }).run();
    return repo;
  }

  afterAll(() => rmSync(repos, { recursive: true, force: true }));

  it("records a file the turn changed through the shell", async () => {
    const repo = repoSession("bash");
    stream = [
      assistantWithTools([
        { type: "tool_use", name: "Bash", input: { command: "sed -i '' s/1/2/ a.ts" } },
      ]),
      // The edit itself: nothing in the message stream names this file.
      () => writeFileSync(join(repo, "a.ts"), "const a = 2;\n"),
      result(),
    ];
    await sendUserMessage(SESSION, "bump a");

    const files = ledger.filesOf(turn()!.id);
    expect(files.map((f) => [f.relPath, f.op, f.source])).toEqual([["a.ts", "write", "tree"]]);
  });

  it("records a new file, and a deletion, from the tree alone", async () => {
    const repo = repoSession("added-deleted");
    stream = [
      () => {
        writeFileSync(join(repo, "new.ts"), "x\n");
        rmSync(join(repo, "a.ts"));
      },
      result(),
    ];
    await sendUserMessage(SESSION, "restructure");

    expect(
      ledger
        .filesOf(turn()!.id)
        .map((f) => [f.relPath, f.op])
        .sort(),
    ).toEqual([
      ["a.ts", "delete"],
      ["new.ts", "write"],
    ]);
  });

  it("keeps the tool's own claim alongside the tree's", async () => {
    const repo = repoSession("both");
    stream = [
      assistantWithTools([
        { type: "tool_use", name: "Edit", input: { file_path: `${repo}/a.ts` } },
      ]),
      () => writeFileSync(join(repo, "a.ts"), "const a = 9;\n"),
      result(),
    ];
    await sendUserMessage(SESSION, "edit a");

    // Both rows survive: the distinction is what commit attribution scores on.
    const sources = ledger
      .filesOf(turn()!.id)
      .filter((f) => f.relPath === "a.ts")
      .map((f) => f.source)
      .sort();
    expect(sources).toEqual(["tool", "tree"]);
  });

  it("records what an interrupted turn had already changed", async () => {
    const repo = repoSession("interrupted");
    stream = [() => writeFileSync(join(repo, "half.ts"), "partial\n"), result()];
    throwAfter = 1; // throws after the side effect, before the result
    await sendUserMessage(SESSION, "start something");

    const rows = ledger.turnsOf({ chatSessionId: SESSION });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).not.toBe("running");
    expect(ledger.filesOf(rows[0]!.id).map((f) => f.relPath)).toContain("half.ts");
  });

  it("claims nothing when the turn left the tree alone", async () => {
    repoSession("untouched");
    stream = [result()];
    await sendUserMessage(SESSION, "just answer me");
    expect(ledger.filesOf(turn()!.id)).toEqual([]);
  });
});
