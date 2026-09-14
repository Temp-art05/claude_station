/**
 * Attribution and history rewrites, on real repos.
 *
 * The whole feature is a judgement call about evidence, so the cases that matter
 * are the ones where it must refuse to answer: two sessions that match equally, a
 * commit nobody was around for, a squash. Those are checked as carefully as the
 * happy path.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-a2-"));
process.env.CLAUDE_STATION_DATA = dataDir;

const { db, schema } = await import("../../db");
const ledger = await import("../session-ledger");
const cp = await import("../checkpoints");
const { nowIso } = await import("../../lib/id");

const root = mkdtempSync(join(tmpdir(), "cs-a2-repos-"));
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const PROJECT = "p-a2";
let repo = "";
let n = 0;

/** A fresh repo, registered as this project's only path. */
function freshRepo(): string {
  n += 1;
  const path = join(root, `r${n}`);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main", "."]);
  git(path, ["config", "user.email", "t@e.com"]);
  git(path, ["config", "user.name", "test"]);
  writeFileSync(join(path, "seed.txt"), "seed\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-qm", "seed"]);

  db.delete(schema.projectPaths).run();
  db.insert(schema.projectPaths)
    .values({
      id: `pp-${n}`,
      projectId: PROJECT,
      path,
      label: "repo",
      description: "",
      isDefault: true,
      sortOrder: 0,
    })
    .run();
  return path;
}

/** A turn that wrote these files, ending `minutesAgo` before now. */
function turnThatWrote(
  session: string,
  files: string[],
  opts: { minutesAgo?: number; source?: "tree" | "tool"; cwd?: string } = {},
): string {
  const endedAt = new Date(Date.now() - (opts.minutesAgo ?? 5) * 60_000).toISOString();
  const startedAt = new Date(Date.now() - ((opts.minutesAgo ?? 5) + 5) * 60_000).toISOString();
  const cwd = opts.cwd ?? repo;
  const turnId = ledger.openTurn({
    projectId: PROJECT,
    sourceKind: "cli",
    cwd,
    claudeSessionId: session,
    prompt: `work by ${session}`,
    startedAt,
  })!;
  ledger.recordFiles(
    turnId,
    files.map((relPath) => ({
      absPath: join(cwd, relPath),
      op: "write" as const,
      source: opts.source ?? "tree",
      toolName: opts.source === "tool" ? "Edit" : null,
    })),
  );
  ledger.closeTurn(turnId, { endedAt });
  return turnId;
}

/** Commit some files, so a checkpoint has something to attribute. */
function commit(files: string[], subject: string): string {
  for (const relPath of files) {
    const full = join(repo, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, `${subject}\n`);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", subject]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

const checkpointOf = (sha: string) => cp.checkpointsForShas(repo, [sha])[sha];
const rowsFor = (sha: string) =>
  db
    .select()
    .from(schema.checkpoints)
    .all()
    .filter((c) => c.commitSha === sha);

beforeEach(() => {
  db.delete(schema.checkpoints).run();
  db.delete(schema.repoCursors).run();
  db.delete(schema.sessionTurns).run();
  db.delete(schema.projects).run();
  db.insert(schema.projects)
    .values({ id: PROJECT, name: "A2", description: "", createdAt: nowIso(), updatedAt: nowIso() })
    .run();
  repo = freshRepo();
});

describe("attributing a commit", () => {
  it("credits the one session that wrote the files", () => {
    turnThatWrote("s-only", ["a.ts", "b.ts"]);
    const sha = commit(["a.ts", "b.ts"], "feat: two files");
    cp.ingest(repo);

    const view = checkpointOf(sha)!;
    expect(view.confidence).toBe("exact");
    expect(view.promptPreview).toBe("work by s-only");
    expect(view.score).toBe(1);
  });

  it("drops to inferred when the file list came from tool calls only", () => {
    // Tool calls miss shell edits, so the list is a lower bound by construction.
    turnThatWrote("s-tool", ["a.ts"], { source: "tool" });
    const sha = commit(["a.ts"], "feat: one file");
    cp.ingest(repo);

    const view = checkpointOf(sha)!;
    expect(view.confidence).toBe("inferred");
    expect(view.reason).toContain("tool calls only");
  });

  it("still credits a session that wrote most of the commit", () => {
    turnThatWrote("s-most", ["a.ts", "b.ts", "c.ts"]);
    const sha = commit(["a.ts", "b.ts", "c.ts", "d.ts"], "feat: mostly mine");
    cp.ingest(repo);

    const view = checkpointOf(sha)!;
    expect(["exact", "inferred"]).toContain(view.confidence);
    expect(view.score).toBeGreaterThanOrEqual(0.5);
  });

  it("points at the best turn but says how many of that session's turns matched", () => {
    turnThatWrote("s-multi", ["a.ts"], { minutesAgo: 20 });
    turnThatWrote("s-multi", ["a.ts", "b.ts"], { minutesAgo: 5 });
    const sha = commit(["a.ts", "b.ts"], "feat: two turns of work");
    cp.ingest(repo);

    const view = checkpointOf(sha)!;
    expect(view.turnId).not.toBeNull();
    expect(view.reason).toContain("turns of this session");
  });
});

describe("refusing to attribute", () => {
  it("orphans a commit when two sessions match about equally", () => {
    turnThatWrote("s-one", ["a.ts"]);
    turnThatWrote("s-two", ["b.ts"]);
    const sha = commit(["a.ts", "b.ts"], "feat: both of them");
    cp.ingest(repo);

    const view = checkpointOf(sha)!;
    expect(view.confidence).toBe("orphan");
    expect(view.turnId).toBeNull();
    expect(view.reason).toContain("not guessing");
  });

  it("orphans a commit no session was around for", () => {
    const sha = commit(["hand.ts"], "chore: typed by hand");
    cp.ingest(repo);

    const view = checkpointOf(sha)!;
    expect(view.confidence).toBe("orphan");
    expect(view.reason).toContain("no session was working");
  });

  it("orphans a commit whose files no active session touched", () => {
    turnThatWrote("s-elsewhere", ["other.ts"]);
    const sha = commit(["unrelated.ts"], "chore: unrelated");
    cp.ingest(repo);

    const view = checkpointOf(sha)!;
    expect(view.confidence).toBe("orphan");
    expect(view.reason).toContain("none of them touched these files");
  });

  it("ignores a turn that ended outside the window", () => {
    turnThatWrote("s-ancient", ["a.ts"], { minutesAgo: 60 * 40 });
    const sha = commit(["a.ts"], "feat: much later");
    cp.ingest(repo);
    expect(checkpointOf(sha)!.confidence).toBe("orphan");
  });

  it("orphans a merge commit rather than pretending it has one patch", () => {
    turnThatWrote("s-merge", ["a.ts"]);
    commit(["a.ts"], "feat: on main");
    git(repo, ["checkout", "-q", "-b", "side", "HEAD~1"]);
    writeFileSync(join(repo, "side.ts"), "side\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "feat: on side"]);
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "--no-ff", "-q", "-m", "merge side", "side"]);
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    cp.ingest(repo);

    const view = checkpointOf(sha)!;
    expect(view.confidence).toBe("orphan");
    expect(view.reason).toContain("merge commit");
  });
});

describe("a commit the app made itself", () => {
  it("is exact without any inference", () => {
    const turnId = turnThatWrote("s-app", ["a.ts"]);
    const sha = commit(["a.ts"], "feat: through the app");
    cp.recordAppCommit({
      repoPath: repo,
      commitSha: sha,
      projectId: PROJECT,
      turnId,
      claudeSessionId: "s-app",
    });

    const view = checkpointOf(sha)!;
    expect(view.confidence).toBe("exact");
    expect(view.reason).toContain("committed by this app");
  });

  it("survives the watcher ingesting the same commit afterwards", () => {
    const turnId = turnThatWrote("s-app2", ["a.ts"]);
    const sha = commit(["a.ts"], "feat: app then watcher");
    cp.recordAppCommit({ repoPath: repo, commitSha: sha, projectId: PROJECT, turnId });
    cp.ingest(repo);

    expect(checkpointOf(sha)!.confidence).toBe("exact");
    // One row for this commit, whichever path recorded it (the repo's seed commit
    // gets a row of its own, which is correct — it is a commit).
    expect(rowsFor(sha)).toHaveLength(1);
  });
});

describe("history rewrites", () => {
  it("follows an --amend to the new sha", () => {
    turnThatWrote("s-amend", ["a.ts"]);
    const before = commit(["a.ts"], "feat: original message");
    cp.ingest(repo);
    const original = checkpointOf(before)!;
    expect(original.confidence).not.toBe("orphan");

    git(repo, ["commit", "-q", "--amend", "-m", "feat: reworded"]);
    const after = git(repo, ["rev-parse", "HEAD"]).trim();
    expect(after).not.toBe(before);
    cp.ingest(repo);

    const moved = checkpointOf(after)!;
    expect(moved.id).toBe(original.id);
    expect(moved.supersededSha).toBe(before);
    // The attribution is not re-derived: the work is the same work.
    expect(moved.turnId).toBe(original.turnId);
    // Re-pointed, not duplicated: the old sha has no row of its own any more.
    expect(rowsFor(before)).toHaveLength(0);
    expect(rowsFor(after)).toHaveLength(1);
  });

  it("follows a rebase, where the sha changes and the patch does not", () => {
    turnThatWrote("s-rebase", ["feature.ts"]);
    git(repo, ["checkout", "-q", "-b", "feature"]);
    const before = commit(["feature.ts"], "feat: my feature");
    cp.ingest(repo);
    const original = checkpointOf(before)!;

    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(join(repo, "main-moved.ts"), "x\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "chore: main moved on"]);
    git(repo, ["checkout", "-q", "feature"]);
    git(repo, ["rebase", "-q", "main"]);
    const after = git(repo, ["rev-parse", "HEAD"]).trim();
    cp.ingest(repo);

    const moved = checkpointOf(after)!;
    expect(moved.id).toBe(original.id);
    expect(moved.supersededSha).toBe(before);
  });

  it("treats a cherry-pick as its own commit, not a move", () => {
    // Same patch-id as the original, but the original is still reachable — that
    // difference is the whole reason reachability is checked instead of existence.
    turnThatWrote("s-pick", ["picked.ts"]);
    const source = commit(["picked.ts"], "feat: worth picking");
    cp.ingest(repo);

    git(repo, ["checkout", "-q", "-b", "target", "HEAD~1"]);
    // The target has to diverge first. Picking onto the very same parent
    // reproduces a byte-identical commit — same tree, same parent, same message
    // and dates — so git hands back the original sha and there is nothing to test.
    writeFileSync(join(repo, "target-only.ts"), "diverged\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "chore: target diverges"]);
    git(repo, ["cherry-pick", source]);
    const picked = git(repo, ["rev-parse", "HEAD"]).trim();
    cp.ingest(repo);

    expect(checkpointOf(source)).toBeDefined();
    expect(checkpointOf(picked)).toBeDefined();
    expect(checkpointOf(picked)!.id).not.toBe(checkpointOf(source)!.id);
    expect(checkpointOf(picked)!.supersededSha).toBeNull();
  });

  it("orphans a squashed commit instead of crediting one of its parts", () => {
    turnThatWrote("s-squash", ["one.ts", "two.ts"]);
    commit(["one.ts"], "feat: part one");
    const second = commit(["two.ts"], "feat: part two");
    cp.ingest(repo);
    expect(db.select().from(schema.checkpoints).all()).toHaveLength(3); // seed + 2

    git(repo, ["reset", "-q", "--soft", "HEAD~2"]);
    git(repo, ["commit", "-qm", "feat: squashed"]);
    const squashed = git(repo, ["rev-parse", "HEAD"]).trim();
    cp.ingest(repo);
    cp.reconcileGoneCommits(repo);

    // The squash is a new commit, and the two it replaced are gone rather than
    // silently re-pointed to it.
    expect(checkpointOf(squashed)).toBeDefined();
    expect(checkpointOf(squashed)!.supersededSha).toBeNull();
    const gone = db
      .select()
      .from(schema.checkpoints)
      .all()
      .filter((c) => c.commitSha === second);
    expect(gone[0]!.reason).toContain("commit is gone");
    expect(gone[0]!.confidence).toBe("orphan");
  });
});

describe("catching up", () => {
  it("ingests commits made while nothing was watching", () => {
    turnThatWrote("s-offline", ["a.ts", "b.ts"]);
    commit(["a.ts"], "feat: one");
    const second = commit(["b.ts"], "feat: two");
    // No watcher ran between the commits; the cursor is what recovers them.
    const { added } = cp.ingest(repo);
    expect(added).toBeGreaterThanOrEqual(2);
    expect(checkpointOf(second)).toBeDefined();
  });

  it("is a no-op when called again with nothing new", () => {
    commit(["a.ts"], "feat: one");
    cp.ingest(repo);
    expect(cp.ingest(repo)).toEqual({ added: 0, repointed: 0 });
  });

  it("records the repo as degraded when no project path owns it", () => {
    db.delete(schema.projectPaths).run();
    commit(["a.ts"], "feat: orphan repo");
    cp.ingest(repo);
    const health = cp.cursorHealth();
    // Repos are keyed by their resolved path — on macOS a temp dir under /var is
    // really /private/var, and one repo must not become two identities.
    expect(health.map((h) => h.repoPath)).toContain(realpathSync(repo));
    expect(health[0]!.detail).toContain("no project path");
  });
});

describe("reading back", () => {
  it("gives a commit's checkpoint with the turn behind it", () => {
    turnThatWrote("s-detail", ["a.ts"]);
    const sha = commit(["a.ts"], "feat: detailed");
    cp.ingest(repo);

    const detail = cp.checkpointDetail(checkpointOf(sha)!.id)!;
    expect(detail.subject).toBe("feat: detailed");
    expect(detail.turn?.promptText).toBe("work by s-detail");
    expect(detail.turn?.files.map((f) => f.relPath)).toEqual(["a.ts"]);
    // Both lists are returned: where they differ is the interesting part.
    expect(detail.commitFiles.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("lists every commit of one session", () => {
    turnThatWrote("s-many", ["a.ts", "b.ts"]);
    commit(["a.ts"], "feat: first");
    commit(["b.ts"], "feat: second");
    cp.ingest(repo);

    const commits = cp.checkpointsOfSession({ claudeSessionId: "s-many" });
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits.every((c) => c.claudeSessionId === "s-many")).toBe(true);
  });

  it("counts the commits nothing could be attributed to", () => {
    commit(["hand.ts"], "chore: by hand");
    cp.ingest(repo);
    expect(cp.orphanCount(PROJECT)).toBeGreaterThan(0);
  });
});

describe("what boot is allowed to cost", () => {
  it("puts up watchers without reading any history", async () => {
    // This is a regression guard, not a nicety. The first version read every
    // repo's history inside this call, before the server started listening: ~97
    // seconds of synchronous git on a real machine, repeated on every restart,
    // during which the UI answered nothing and looked exactly like it had lost
    // all its data.
    commit(["a.ts"], "feat: something to find");

    const watched = cp.watchProjectRepos();
    expect(watched.watched).toBeGreaterThan(0);
    expect(db.select().from(schema.checkpoints).all()).toHaveLength(0);

    // Reading history is the deferred half, and it is what records commits.
    const caught = await cp.catchUpRepos();
    expect(caught.added).toBeGreaterThan(0);
    expect(db.select().from(schema.checkpoints).all().length).toBeGreaterThan(0);
  });

  it("does not ask git what a commit changed when no session could have made it", () => {
    // Attribution answers from the database first. Most commits in a repo's
    // history predate the ledger, and paying git per commit for them is what made
    // the cold start slow.
    const sha = commit(["nobody.ts"], "chore: long before any session");
    cp.ingest(repo);
    const view = checkpointOf(sha)!;
    expect(view.confidence).toBe("orphan");
    expect(view.reason).toContain("no session was working");
    // No patch-id either: there is no attribution for a rewrite to preserve.
    const row = rowsFor(sha)[0]!;
    expect(row.patchId).toBeNull();
  });

  it("still records a patch-id for a commit it did attribute", () => {
    // That one can be rewritten and has something to lose, so it pays the cost.
    turnThatWrote("s-keep", ["kept.ts"]);
    const sha = commit(["kept.ts"], "feat: worth following");
    cp.ingest(repo);
    expect(checkpointOf(sha)!.confidence).not.toBe("orphan");
    expect(rowsFor(sha)[0]!.patchId).toMatch(/^[0-9a-f]{40}/);
  });
});
