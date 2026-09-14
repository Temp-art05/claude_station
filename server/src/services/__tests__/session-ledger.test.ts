/**
 * Real database, temporary data dir.
 *
 * `CLAUDE_STATION_DATA` has to be set before anything imports `../../db`, because
 * that module resolves the path and runs the migrations at import time. Hence the
 * dynamic imports below: a top-level `import` would be hoisted above the env var
 * and would open (and write to) the developer's own data/claude-station.db.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-ledger-"));
process.env.CLAUDE_STATION_DATA = dataDir;

const { db, schema } = await import("../../db");
const ledger = await import("../session-ledger");
const { newId, nowIso } = await import("../../lib/id");

const PROJECT = "p-ledger";
const REPO = "/tmp/cs-fake/repo";
const NESTED = "/tmp/cs-fake/repo/ios";
let repoPathId = "";
let nestedPathId = "";

/** Minutes before/after a fixed instant, so window assertions read clearly. */
const T0 = new Date("2026-09-03T12:00:00.000Z").getTime();
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

beforeAll(() => {
  db.insert(schema.projects)
    .values({
      id: PROJECT,
      name: "Ledger test",
      description: "",
      sortOrder: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  repoPathId = newId();
  nestedPathId = newId();
  // Nested on purpose: a monorepo can hold several project paths inside one another.
  db.insert(schema.projectPaths)
    .values([
      {
        id: repoPathId,
        projectId: PROJECT,
        path: REPO,
        label: "repo",
        description: "",
        isDefault: true,
        sortOrder: 0,
      },
      {
        id: nestedPathId,
        projectId: PROJECT,
        path: NESTED,
        label: "ios",
        description: "",
        isDefault: false,
        sortOrder: 1,
      },
    ])
    .run();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.delete(schema.sessionTurns).run(); // session_files cascades
  db.delete(schema.sessionCapture).run();
  db.delete(schema.envVars).run();
  db.delete(schema.envSets).run();
  ledger.forgetSecrets();
});

function openSdkTurn(over: Partial<Parameters<typeof ledger.openTurn>[0]> = {}): string {
  const id = ledger.openTurn({
    projectId: PROJECT,
    sourceKind: "sdk",
    cwd: REPO,
    chatSessionId: null,
    prompt: "add a tmux toggle",
    ...over,
  });
  expect(id).not.toBeNull();
  return id!;
}

describe("openTurn", () => {
  it("records a turn as running, with a preview of the prompt", () => {
    const id = openSdkTurn({ claudeSessionId: "cli-1", prompt: "  add   a\ntmux toggle  " });
    const turn = ledger.turnsOf({ claudeSessionId: "cli-1" })[0]!;
    expect(turn.id).toBe(id);
    expect(turn.status).toBe("running");
    expect(turn.promptText).toBe("  add   a\ntmux toggle  ");
    // Preview is collapsed to one line so a list row can't be broken by a newline.
    expect(turn.promptPreview).toBe("add a tmux toggle");
    expect(turn.endedAt).toBeNull();
  });

  it("numbers turns per session, independently for each one", () => {
    openSdkTurn({ claudeSessionId: "cli-a" });
    openSdkTurn({ claudeSessionId: "cli-a" });
    openSdkTurn({ claudeSessionId: "cli-b" });
    expect(ledger.turnsOf({ claudeSessionId: "cli-a" }).map((t) => t.seq)).toEqual([1, 2]);
    expect(ledger.turnsOf({ claudeSessionId: "cli-b" }).map((t) => t.seq)).toEqual([1]);
  });

  it("accepts an explicit seq and startedAt, so backfill can replay history", () => {
    ledger.openTurn({
      projectId: PROJECT,
      sourceKind: "cli",
      cwd: REPO,
      claudeSessionId: "cli-old",
      seq: 7,
      startedAt: at(-6000),
      prompt: "old work",
    });
    const turn = ledger.turnsOf({ claudeSessionId: "cli-old" })[0]!;
    expect(turn.seq).toBe(7);
    expect(turn.startedAt).toBe(at(-6000));
  });

  it("redacts the prompt with values marked secret in an env set", () => {
    const setId = newId();
    db.insert(schema.envSets)
      .values({ id: setId, projectId: PROJECT, name: "jira", createdAt: nowIso() })
      .run();
    db.insert(schema.envVars)
      .values([
        {
          id: newId(),
          envSetId: setId,
          key: "JIRA_TOKEN",
          value: "sup3r-secret-token",
          isSecret: true,
        },
        {
          id: newId(),
          envSetId: setId,
          key: "JIRA_URL",
          value: "https://jira.apero.vn",
          isSecret: false,
        },
      ])
      .run();
    ledger.forgetSecrets();

    openSdkTurn({
      claudeSessionId: "cli-secret",
      prompt: "call https://jira.apero.vn with sup3r-secret-token please",
    });
    const turn = ledger.turnsOf({ claudeSessionId: "cli-secret" })[0]!;
    expect(turn.promptText).not.toContain("sup3r-secret-token");
    // A non-secret var is ordinary text and must survive.
    expect(turn.promptText).toContain("https://jira.apero.vn");
  });
});

describe("recordFiles", () => {
  it("resolves a file to the innermost project path", () => {
    const id = openSdkTurn({ claudeSessionId: "cli-paths" });
    ledger.recordFiles(id, [
      { absPath: `${NESTED}/Sources/App.swift`, op: "write", source: "tool", toolName: "Edit" },
      { absPath: `${REPO}/README.md`, op: "write", source: "tool", toolName: "Write" },
    ]);
    const files = ledger.filesOf(id);
    const swift = files.find((f) => f.absPath.endsWith("App.swift"))!;
    const readme = files.find((f) => f.absPath.endsWith("README.md"))!;
    expect(swift.projectPathId).toBe(nestedPathId);
    expect(swift.relPath).toBe("Sources/App.swift");
    expect(readme.projectPathId).toBe(repoPathId);
    expect(readme.relPath).toBe("README.md");
  });

  it("leaves a file outside every project path unresolved rather than guessing", () => {
    const id = openSdkTurn({ claudeSessionId: "cli-outside" });
    ledger.recordFiles(id, [
      { absPath: "/tmp/cs-fake/repo-other/x.txt", op: "write", source: "tree" },
    ]);
    const file = ledger.filesOf(id)[0]!;
    expect(file.projectPathId).toBeNull();
    expect(file.relPath).toBe("");
  });

  it("deduplicates the same claim, repeated", () => {
    const id = openSdkTurn({ claudeSessionId: "cli-dedupe" });
    const touch = {
      absPath: `${REPO}/a.ts`,
      op: "read",
      source: "tool",
      toolName: "Read",
    } as const;
    expect(ledger.recordFiles(id, [touch, touch, touch])).toBe(1);
    expect(ledger.recordFiles(id, [touch])).toBe(0);
    expect(ledger.filesOf(id)).toHaveLength(1);
  });

  it("keeps a tree claim separate from a tool claim for the same path", () => {
    // The distinction is what A2's confidence scoring reads: tree is ground truth,
    // tool is a hint that misses Bash-driven edits.
    const id = openSdkTurn({ claudeSessionId: "cli-sources" });
    ledger.recordFiles(id, [
      { absPath: `${REPO}/a.ts`, op: "write", source: "tool", toolName: "Edit" },
      { absPath: `${REPO}/a.ts`, op: "write", source: "tree" },
    ]);
    expect(
      ledger
        .filesOf(id)
        .map((f) => f.source)
        .sort(),
    ).toEqual(["tool", "tree"]);
  });

  it("ignores a null turn id and an empty list", () => {
    expect(ledger.recordFiles(null, [{ absPath: "/x", op: "read", source: "tool" }])).toBe(0);
    expect(ledger.recordFiles("nope", [])).toBe(0);
  });

  it("records nothing for a turn that does not exist", () => {
    expect(
      ledger.recordFiles("missing-turn", [{ absPath: "/x", op: "read", source: "tool" }]),
    ).toBe(0);
  });
});

describe("closeTurn", () => {
  it("stores tokens, cost and duration and marks the turn done", () => {
    const id = openSdkTurn({ claudeSessionId: "cli-close" });
    ledger.closeTurn(id, {
      inputTokens: 18_200,
      outputTokens: 3_100,
      cacheReadTokens: 141_387,
      cacheCreateTokens: 955,
      costUsd: 0.09,
      durationMs: 164_000,
      toolCallCount: 12,
      endedAt: at(5),
    });
    const turn = ledger.turnsOf({ claudeSessionId: "cli-close" })[0]!;
    expect(turn.status).toBe("done");
    expect(turn.inputTokens).toBe(18_200);
    expect(turn.cacheReadTokens).toBe(141_387);
    expect(turn.costUsd).toBeCloseTo(0.09);
    expect(turn.toolCallCount).toBe(12);
    expect(turn.endedAt).toBe(at(5));
  });

  it("leaves cost NULL when the caller has none — a CLI turn never reports one", () => {
    const id = openSdkTurn({ claudeSessionId: "cli-nocost", sourceKind: "cli" });
    ledger.closeTurn(id, { inputTokens: 10, outputTokens: 20 });
    const turn = ledger.turnsOf({ claudeSessionId: "cli-nocost" })[0]!;
    expect(turn.costUsd).toBeNull();
    expect(turn.inputTokens).toBe(10);
  });

  it("can close a turn as failed", () => {
    const id = openSdkTurn({ claudeSessionId: "cli-err" });
    ledger.closeTurn(id, { status: "error" });
    expect(ledger.turnsOf({ claudeSessionId: "cli-err" })[0]!.status).toBe("error");
  });

  it("ignores a null id, so a caller that is not capturing needs no branch", () => {
    expect(() => ledger.closeTurn(null, { status: "done" })).not.toThrow();
  });
});

describe("bumpToolCalls", () => {
  it("adds to the counter instead of overwriting it", () => {
    const id = openSdkTurn({ claudeSessionId: "cli-bump" });
    ledger.bumpToolCalls(id);
    ledger.bumpToolCalls(id, 4);
    expect(ledger.turnsOf({ claudeSessionId: "cli-bump" })[0]!.toolCallCount).toBe(5);
  });
});

describe("markInterrupted", () => {
  it("closes every turn left running by a crash", () => {
    openSdkTurn({ claudeSessionId: "cli-i1" });
    openSdkTurn({ claudeSessionId: "cli-i2" });
    const done = openSdkTurn({ claudeSessionId: "cli-i3" });
    ledger.closeTurn(done);

    expect(ledger.markInterrupted()).toBe(2);
    expect(ledger.turnsOf({ claudeSessionId: "cli-i1" })[0]!.status).toBe("interrupted");
    expect(ledger.turnsOf({ claudeSessionId: "cli-i1" })[0]!.endedAt).not.toBeNull();
    // Already finished — must not be rewritten.
    expect(ledger.turnsOf({ claudeSessionId: "cli-i3" })[0]!.status).toBe("done");
  });

  it("can be scoped to specific turns", () => {
    const a = openSdkTurn({ claudeSessionId: "cli-s1" });
    openSdkTurn({ claudeSessionId: "cli-s2" });
    expect(ledger.markInterrupted([a])).toBe(1);
    expect(ledger.turnsOf({ claudeSessionId: "cli-s2" })[0]!.status).toBe("running");
  });

  it("reports zero when there is nothing open", () => {
    expect(ledger.markInterrupted()).toBe(0);
  });
});

describe("turnsTouching", () => {
  it("finds turns that wrote the path, newest first, ignoring reads", () => {
    const older = openSdkTurn({ claudeSessionId: "cli-w1", startedAt: at(-120) });
    const newer = openSdkTurn({ claudeSessionId: "cli-w2", startedAt: at(-10) });
    const reader = openSdkTurn({ claudeSessionId: "cli-w3", startedAt: at(-5) });
    const target = `${REPO}/pty-manager.ts`;
    ledger.recordFiles(older, [{ absPath: target, op: "write", source: "tree" }]);
    ledger.recordFiles(newer, [{ absPath: target, op: "write", source: "tool", toolName: "Edit" }]);
    ledger.recordFiles(reader, [{ absPath: target, op: "read", source: "tool", toolName: "Read" }]);

    const hits = ledger.turnsTouching(PROJECT, target).map((t) => t.id);
    expect(hits).toEqual([newer, older]);
  });

  it("counts a delete as touching the file", () => {
    const id = openSdkTurn({ claudeSessionId: "cli-del" });
    ledger.recordFiles(id, [{ absPath: `${REPO}/gone.ts`, op: "delete", source: "tree" }]);
    expect(ledger.turnsTouching(PROJECT, `${REPO}/gone.ts`).map((t) => t.id)).toEqual([id]);
  });

  it("returns nothing for a path no turn wrote", () => {
    expect(ledger.turnsTouching(PROJECT, `${REPO}/never.ts`)).toEqual([]);
  });
});

describe("turnsRunningAt", () => {
  const commit = at(0);

  function turn(session: string, startMin: number, endMin: number | null, cwd = REPO): string {
    const id = ledger.openTurn({
      projectId: PROJECT,
      sourceKind: "cli",
      cwd,
      claudeSessionId: session,
      startedAt: at(startMin),
      prompt: session,
    })!;
    if (endMin !== null) ledger.closeTurn(id, { endedAt: at(endMin) });
    return id;
  }

  it("includes a turn that finished inside the window", () => {
    const id = turn("in-window", -60, -30);
    expect(ledger.turnsRunningAt([REPO], commit, 24).map((t) => t.id)).toEqual([id]);
  });

  it("includes a turn still running when the commit was made", () => {
    // It started before the commit and never closed — it may well have written it.
    const id = turn("still-open", -20, null);
    expect(ledger.turnsRunningAt([REPO], commit, 24).map((t) => t.id)).toEqual([id]);
  });

  it("excludes a turn that started after the commit", () => {
    // It cannot have produced a commit that already existed.
    turn("later", 30, 40);
    expect(ledger.turnsRunningAt([REPO], commit, 24)).toEqual([]);
  });

  it("excludes a turn that finished before the window opens", () => {
    turn("ancient", -60 * 40, -60 * 39);
    expect(ledger.turnsRunningAt([REPO], commit, 24)).toEqual([]);
    // Widen the window and the same turn becomes a candidate again.
    expect(ledger.turnsRunningAt([REPO], commit, 48).map((t) => t.id)).toHaveLength(1);
  });

  it("matches only the trees it was asked about", () => {
    turn("other-tree", -10, -5, "/tmp/cs-fake/elsewhere");
    expect(ledger.turnsRunningAt([REPO], commit, 24)).toEqual([]);
    expect(ledger.turnsRunningAt(["/tmp/cs-fake/elsewhere"], commit, 24)).toHaveLength(1);
  });

  it("takes several trees, so a session worktree counts as the repo's own", () => {
    const worktree = "/tmp/cs-fake/worktrees/s1";
    turn("in-repo", -30, -20);
    turn("in-worktree", -15, -10, worktree);
    expect(ledger.turnsRunningAt([REPO, worktree], commit, 24)).toHaveLength(2);
  });

  it("returns newest first, so a caller can rank without re-sorting", () => {
    turn("older", -120, -110);
    turn("newer", -20, -10);
    const [first] = ledger.turnsRunningAt([REPO], commit, 24);
    expect(first!.promptText).toBe("newer");
  });

  it("returns nothing when asked about no trees", () => {
    expect(ledger.turnsRunningAt([], commit)).toEqual([]);
  });
});

describe("capture bookkeeping", () => {
  it("upserts by conversation id and keeps the newest offset", () => {
    ledger.saveCapture({
      claudeSessionId: "cli-cap",
      projectId: PROJECT,
      transcriptPath: "/x/cli-cap.jsonl",
      byteOffset: 1024,
      mtimeMs: 111,
      sizeBytes: 2048,
    });
    ledger.saveCapture({ claudeSessionId: "cli-cap", byteOffset: 4096, sizeBytes: 4096 });
    const row = ledger.getCapture("cli-cap")!;
    expect(row.byteOffset).toBe(4096);
    expect(row.status).toBe("ok");
  });

  it("reports unhealthy conversations, grouped, and stays quiet about healthy ones", () => {
    ledger.saveCapture({ claudeSessionId: "ok-1" });
    ledger.saveCapture({
      claudeSessionId: "gone-1",
      status: "stopped",
      detail: "transcript deleted",
    });
    ledger.saveCapture({
      claudeSessionId: "gone-2",
      status: "stopped",
      detail: "transcript deleted",
    });
    ledger.saveCapture({ claudeSessionId: "slow-1", status: "degraded", detail: "watcher failed" });

    const health = ledger.captureHealth();
    expect(health.map((h) => h.status).sort()).toEqual(["degraded", "stopped"]);
    const stopped = health.find((h) => h.status === "stopped")!;
    expect(stopped.count).toBe(2);
    // The same reason twice is one line to show, not two.
    expect(stopped.details).toEqual(["transcript deleted"]);
  });

  it("returns null for a conversation it never saw", () => {
    expect(ledger.getCapture("never")).toBeNull();
  });
});

describe("capture mtime bookkeeping", () => {
  it("stores mtime as a whole number, so an unchanged file compares equal", () => {
    // statSync reports a float; SQLite keeps floats in INTEGER columns, and the
    // scan's "nothing appended, skip it" check compares against this value.
    const mtimeMs = 1787053769133.0837;
    ledger.saveCapture({ claudeSessionId: "cli-mtime", mtimeMs, sizeBytes: 42 });
    const row = ledger.getCapture("cli-mtime")!;
    expect(row.mtimeMs).toBe(Math.round(mtimeMs));
    expect(Number.isInteger(row.mtimeMs)).toBe(true);
  });
});
