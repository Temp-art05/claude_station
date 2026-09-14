/**
 * The follower against real files: appends, a half-written line, a restart that
 * resumes from the stored offset, a deleted transcript, a truncated one.
 *
 * These are the cases the byte offset and the leftover buffer exist for, and none
 * of them can be checked by reading the code.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-l3-"));
process.env.CLAUDE_STATION_DATA = dataDir;

const { db, schema } = await import("../../db");
const ledger = await import("../session-ledger");
const followerApi = await import("../transcript-follower");
const { nowIso } = await import("../../lib/id");

const files = mkdtempSync(join(tmpdir(), "cs-l3-files-"));
const PROJECT = "p-l3";
const REPO = "/tmp/cs-l3/repo";

afterAll(() => {
  followerApi.unfollowAll();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(files, { recursive: true, force: true });
});

const jsonl = (...records: unknown[]): string =>
  records.map((r) => JSON.stringify(r)).join("\n") + "\n";

let clock = 0;
const nextAt = (): string => new Date(Date.UTC(2026, 8, 3, 10, 0, clock++)).toISOString();

const prompt = (text: string, over: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: nextAt(),
  cwd: REPO,
  gitBranch: "main",
  message: { role: "user", content: text },
  ...over,
});

const toolResult = () => ({
  type: "user",
  timestamp: nextAt(),
  cwd: REPO,
  message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
});

const work = (tools: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: nextAt(),
  cwd: REPO,
  gitBranch: "main",
  message: {
    role: "assistant",
    model: "claude-opus-5",
    usage: {
      input_tokens: 5,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 10,
    },
    content: tools.map((t) => ({ type: "tool_use", ...t })),
  },
  ...over,
});

const edit = (rel: string) => ({ name: "Edit", input: { file_path: `${REPO}/${rel}` } });

beforeEach(() => {
  followerApi.unfollowAll();
  clock = 0;
  db.delete(schema.sessionTurns).run();
  db.delete(schema.sessionCapture).run();
  db.delete(schema.terminals).run();
  db.delete(schema.projectPaths).run();
  db.delete(schema.projects).run();
  db.insert(schema.projects)
    .values({ id: PROJECT, name: "L3", description: "", createdAt: nowIso(), updatedAt: nowIso() })
    .run();
  db.insert(schema.projectPaths)
    .values({
      id: "pp-l3",
      projectId: PROJECT,
      path: REPO,
      label: "repo",
      description: "",
      isDefault: true,
      sortOrder: 0,
    })
    .run();
});

function transcript(name: string, body: string): string {
  const file = join(files, `${name}.jsonl`);
  writeFileSync(file, body);
  return file;
}

/**
 * Follow as a real tab does: the terminal row exists first. `session_turns`
 * references it, so following an id with no row behind it records nothing —
 * which is also the order `createTerminal` uses.
 */
const follow = (id: string, file: string) => {
  const terminalId = `t-${id}`;
  db.insert(schema.terminals)
    .values({
      id: terminalId,
      projectId: PROJECT,
      title: id,
      cwd: REPO,
      kind: "claude",
      claudeSessionId: id,
      status: "running",
      createdAt: nowIso(),
    })
    .onConflictDoNothing()
    .run();
  followerApi.follow({
    claudeSessionId: id,
    projectId: PROJECT,
    cwd: REPO,
    terminalId,
    transcriptFile: file,
  });
};

const turns = (id: string) => ledger.turnsOf({ claudeSessionId: id });

describe("following a live conversation", () => {
  it("records one turn per real prompt, ignoring tool results", () => {
    const file = transcript(
      "live",
      jsonl(prompt("first"), work([edit("a.ts")]), toolResult(), prompt("second"), work([])),
    );
    follow("s-live", file);

    expect(turns("s-live").map((t) => [t.seq, t.promptText])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
  });

  it("accumulates usage and tool calls across a turn's activity", () => {
    const file = transcript(
      "usage",
      jsonl(prompt("go"), work([edit("a.ts")]), work([edit("b.ts")])),
    );
    follow("s-usage", file);

    const [turn] = turns("s-usage");
    expect(turn!.inputTokens).toBe(10);
    expect(turn!.outputTokens).toBe(100);
    expect(turn!.cacheReadTokens).toBe(2000);
    expect(turn!.toolCallCount).toBe(2);
    // No cost on this surface, ever: the transcript carries none.
    expect(turn!.costUsd).toBeNull();
  });

  it("records the files the turn's tool calls named", () => {
    const file = transcript("files", jsonl(prompt("go"), work([edit("services/a.ts")])));
    follow("s-files", file);

    const [turn] = turns("s-files");
    expect(ledger.filesOf(turn!.id).map((f) => [f.relPath, f.op, f.source])).toEqual([
      ["services/a.ts", "write", "tool"],
    ]);
  });

  it("attributes a subagent's edits to the parent turn, labelled", () => {
    const file = transcript(
      "sub",
      jsonl(
        prompt("plan it"),
        work([{ name: "Task", input: { subagent_type: "docs-planner" } }]),
        work([edit("docs/plan.md")], { isSidechain: true }),
      ),
    );
    follow("s-sub", file);

    const [turn] = turns("s-sub");
    expect(turns("s-sub")).toHaveLength(1);
    const file0 = ledger.filesOf(turn!.id)[0]!;
    expect(file0.relPath).toBe("docs/plan.md");
    expect(file0.toolName).toBe("Task/Edit");
  });

  it("picks up an append without re-reading what it already read", () => {
    const file = transcript("append", jsonl(prompt("first"), work([edit("a.ts")])));
    follow("s-append", file);
    const firstOffset = ledger.getCapture("s-append")!.byteOffset;
    expect(firstOffset).toBeGreaterThan(0);

    appendFileSync(file, jsonl(prompt("second"), work([edit("b.ts")])));
    followerApi.drain("s-append");

    expect(turns("s-append").map((t) => t.promptText)).toEqual(["first", "second"]);
    expect(ledger.getCapture("s-append")!.byteOffset).toBeGreaterThan(firstOffset);
  });

  it("waits for a line to be finished before recording it", () => {
    // The CLI appends record by record; a drain can land mid-write.
    const file = transcript("partial", jsonl(prompt("done")) + '{"type":"assistant","mes');
    follow("s-partial", file);

    expect(turns("s-partial")).toHaveLength(1);
    const offset = ledger.getCapture("s-partial")!.byteOffset;

    // Finish the line: the record must now be counted, exactly once.
    appendFileSync(file, 'sage":{"role":"assistant","usage":{"output_tokens":7},"content":[]}}\n');
    followerApi.drain("s-partial");
    expect(turns("s-partial")[0]!.outputTokens).toBe(7);
    expect(ledger.getCapture("s-partial")!.byteOffset).toBeGreaterThan(offset);
  });

  it("refines the same turn rather than opening a new one for late activity", () => {
    const file = transcript("refine", jsonl(prompt("go")));
    follow("s-refine", file);
    const before = turns("s-refine");
    expect(before).toHaveLength(1);

    appendFileSync(file, jsonl(work([edit("a.ts")])));
    followerApi.drain("s-refine");

    const after = turns("s-refine");
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.toolCallCount).toBe(1);
  });
});

describe("across a restart", () => {
  it("resumes from the stored offset instead of replaying the file", () => {
    const file = transcript("restart", jsonl(prompt("before restart"), work([edit("a.ts")])));
    follow("s-restart", file);
    const offset = ledger.getCapture("s-restart")!.byteOffset;

    // What a restart looks like: the in-memory follower is gone, the row is not.
    followerApi.unfollowAll();
    appendFileSync(file, jsonl(prompt("after restart"), work([edit("b.ts")])));
    follow("s-restart", file);

    const rows = turns("s-restart");
    expect(rows.map((t) => t.promptText)).toEqual(["before restart", "after restart"]);
    expect(rows.map((t) => t.seq)).toEqual([1, 2]);
    expect(ledger.getCapture("s-restart")!.byteOffset).toBeGreaterThan(offset);
  });

  it("adopts the last turn when activity arrives before any new prompt", () => {
    // The tmux case: the conversation carried on mid-turn while the server was down.
    const file = transcript("midturn", jsonl(prompt("keep going")));
    follow("s-midturn", file);
    const turnId = turns("s-midturn")[0]!.id;

    followerApi.unfollowAll();
    appendFileSync(file, jsonl(work([edit("a.ts")]), work([edit("b.ts")])));
    follow("s-midturn", file);

    const rows = turns("s-midturn");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(turnId);
    expect(rows[0]!.toolCallCount).toBe(2);
    expect(ledger.filesOf(turnId)).toHaveLength(2);
  });

  it("records spend even when following a conversation whose prompt it never saw", () => {
    const file = transcript("noprompt", jsonl(work([edit("a.ts")])));
    follow("s-noprompt", file);

    const rows = turns("s-noprompt");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.promptText).toBe("");
    expect(rows[0]!.outputTokens).toBe(50);
  });
});

describe("when the transcript goes away", () => {
  it("keeps what it recorded and says capture stopped", () => {
    const file = transcript("deleted", jsonl(prompt("work"), work([edit("a.ts")])));
    follow("s-deleted", file);
    expect(turns("s-deleted")).toHaveLength(1);

    rmSync(file);
    followerApi.drain("s-deleted");

    const capture = ledger.getCapture("s-deleted")!;
    expect(capture.status).toBe("stopped");
    expect(capture.detail).toContain("gone");
    // The turn survives the transcript: prompt, files and tokens are ours now.
    expect(turns("s-deleted")).toHaveLength(1);
    expect(ledger.filesOf(turns("s-deleted")[0]!.id)).toHaveLength(1);
  });

  it("starts over when the file is shorter than the offset", () => {
    // A pruned-and-reused id: reading on from a stale offset would invent turns.
    const file = transcript("rewound", jsonl(prompt("a".repeat(500)), work([edit("a.ts")])));
    follow("s-rewound", file);
    expect(ledger.getCapture("s-rewound")!.byteOffset).toBeGreaterThan(400);

    writeFileSync(file, jsonl(prompt("fresh start")));
    followerApi.drain("s-rewound");

    expect(turns("s-rewound").some((t) => t.promptText === "fresh start")).toBe(true);
  });

  it("marks capture degraded when a record will not parse", () => {
    const file = transcript("bad", "{not json}\n" + jsonl(prompt("still works")));
    follow("s-bad", file);

    expect(turns("s-bad")).toHaveLength(1);
    const capture = ledger.getCapture("s-bad")!;
    expect(capture.status).toBe("degraded");
    expect(capture.detail).toContain("unreadable");
  });
});

describe("unfollow", () => {
  it("drains once more before letting go", () => {
    const file = transcript("unfollow", jsonl(prompt("go")));
    follow("s-unfollow", file);
    appendFileSync(file, jsonl(work([edit("a.ts")])));

    followerApi.unfollow("s-unfollow");
    expect(followerApi.isFollowing("s-unfollow")).toBe(false);
    expect(turns("s-unfollow")[0]!.toolCallCount).toBe(1);
  });

  it("records the reason when one is given", () => {
    const file = transcript("reason", jsonl(prompt("go")));
    follow("s-reason", file);
    followerApi.unfollow("s-reason", "history row and transcript deleted by the user");
    expect(ledger.getCapture("s-reason")!.status).toBe("stopped");
  });
});

describe("indexTranscript", () => {
  it("indexes a whole conversation the app never followed", () => {
    const file = transcript(
      "backfill",
      jsonl(prompt("old one"), work([edit("a.ts")]), toolResult(), prompt("old two"), work([])),
    );
    const count = followerApi.indexTranscript({
      claudeSessionId: "s-backfill",
      projectId: PROJECT,
      cwd: REPO,
      transcriptFile: file,
    });
    expect(count).toBe(2);
    expect(turns("s-backfill").map((t) => t.promptText)).toEqual(["old one", "old two"]);
    expect(turns("s-backfill")[0]!.sourceKind).toBe("cli");
    // Not a tab: there is no terminal to point at.
    expect(turns("s-backfill")[0]!.terminalId).toBeNull();
  });

  it("does not follow the file afterwards", () => {
    const file = transcript("oneshot", jsonl(prompt("once")));
    followerApi.indexTranscript({
      claudeSessionId: "s-oneshot",
      projectId: PROJECT,
      cwd: REPO,
      transcriptFile: file,
    });
    expect(followerApi.isFollowing("s-oneshot")).toBe(false);
  });

  it("re-indexing rewrites rather than duplicating", () => {
    const file = transcript("reindex", jsonl(prompt("one"), work([edit("a.ts")])));
    const input = {
      claudeSessionId: "s-reindex",
      projectId: PROJECT,
      cwd: REPO,
      transcriptFile: file,
    };
    followerApi.indexTranscript(input);
    const first = turns("s-reindex");
    followerApi.indexTranscript(input);
    const second = turns("s-reindex");

    expect(second).toHaveLength(first.length);
    expect(second[0]!.seq).toBe(1);
  });
});

describe("the tree, for a terminal turn", () => {
  const repos = mkdtempSync(join(tmpdir(), "cs-l3-repos-"));
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

  afterAll(() => rmSync(repos, { recursive: true, force: true }));

  /** A repo the follower will watch, registered as this project's path. */
  function repoFor(name: string): string {
    const repo = join(repos, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main", "."]);
    git(repo, ["config", "user.email", "t@e.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.ts"), "const a = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    db.update(schema.projectPaths).set({ path: repo }).run();
    return repo;
  }

  const followIn = (id: string, file: string, repo: string) => {
    const terminalId = `t-${id}`;
    db.insert(schema.terminals)
      .values({
        id: terminalId,
        projectId: PROJECT,
        title: id,
        cwd: repo,
        kind: "claude",
        claudeSessionId: id,
        status: "running",
        createdAt: nowIso(),
      })
      .onConflictDoNothing()
      .run();
    followerApi.follow({
      claudeSessionId: id,
      projectId: PROJECT,
      cwd: repo,
      terminalId,
      transcriptFile: file,
    });
  };

  it("records an edit the transcript never mentions", () => {
    const repo = repoFor("bash-edit");
    const file = transcript("tree-bash", jsonl(prompt("bump a"), work([])));
    followIn("s-tree-bash", file, repo);

    // What the follower can see: more activity. What it cannot: which file the
    // shell touched. The tree comparison is the only witness.
    writeFileSync(join(repo, "a.ts"), "const a = 2;\n");
    appendFileSync(file, jsonl(work([])));
    followerApi.drain("s-tree-bash");

    const turn = turns("s-tree-bash")[0]!;
    expect(ledger.filesOf(turn.id).map((f) => [f.relPath, f.op, f.source])).toEqual([
      ["a.ts", "write", "tree"],
    ]);
  });

  it("claims nothing on the first pass, when there is no baseline to compare", () => {
    const repo = repoFor("baseline");
    writeFileSync(join(repo, "dirty-before.ts"), "someone else's work\n");
    const file = transcript("tree-baseline", jsonl(prompt("go"), work([])));
    followIn("s-tree-baseline", file, repo);

    // dirty-before.ts was already there; this turn must not be blamed for it.
    expect(ledger.filesOf(turns("s-tree-baseline")[0]!.id)).toEqual([]);
  });

  it("ignores a tree that moved with no agent activity behind it", () => {
    const repo = repoFor("quiet");
    const file = transcript("tree-quiet", jsonl(prompt("go"), work([])));
    followIn("s-tree-quiet", file, repo);

    // The person edits by hand while nothing is running: no new activity records,
    // so nothing is attributed.
    writeFileSync(join(repo, "hand-edit.ts"), "typed by a human\n");
    followerApi.drain("s-tree-quiet");

    expect(ledger.filesOf(turns("s-tree-quiet")[0]!.id)).toEqual([]);
  });

  it("records what the turn committed itself", () => {
    const repo = repoFor("self-commit");
    const file = transcript("tree-commit", jsonl(prompt("commit it"), work([])));
    followIn("s-tree-commit", file, repo);

    writeFileSync(join(repo, "a.ts"), "const a = 3;\n");
    git(repo, ["commit", "-qam", "done by the agent"]);
    appendFileSync(file, jsonl(work([])));
    followerApi.drain("s-tree-commit");

    // Tree clean at both ends; HEAD moved. Without the commit range this is empty.
    expect(ledger.filesOf(turns("s-tree-commit")[0]!.id).map((f) => f.relPath)).toEqual(["a.ts"]);
  });
});
