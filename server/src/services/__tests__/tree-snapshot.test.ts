/**
 * Real git repos in a temp dir. The point of L4 is catching an edit no tool call
 * named, so the central test writes a file the way `Bash` would — with plain fs —
 * and checks the snapshot notices.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-l4-"));
process.env.CLAUDE_STATION_DATA = dataDir;

const { diffTrees, parseStatusZ, snapshotTree, touchesBetween } = await import("../tree-snapshot");

const root = mkdtempSync(join(tmpdir(), "cs-l4-repos-"));
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const run = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

function makeRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  run(repo, ["init", "-q", "-b", "main", "."]);
  run(repo, ["config", "user.email", "t@example.com"]);
  run(repo, ["config", "user.name", "test"]);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  run(repo, ["add", "."]);
  run(repo, ["commit", "-qm", "init"]);
  return repo;
}

const rels = (repo: string, before: ReturnType<typeof snapshotTree>) =>
  touchesBetween(before, snapshotTree(repo)).map((t) => [
    t.absPath.slice(repo.length + 1),
    t.op,
    t.source,
  ]);

describe("snapshotTree", () => {
  it("reads HEAD and a clean tree", () => {
    const repo = makeRepo("clean");
    const snap = snapshotTree(repo)!;
    expect(snap.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.entries.size).toBe(0);
  });

  it("returns null outside a git repo", () => {
    const plain = join(root, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    expect(snapshotTree(plain)).toBeNull();
  });

  it("has no HEAD in a repo with no commits, but still reads the tree", () => {
    const repo = join(root, "empty");
    mkdirSync(repo, { recursive: true });
    run(repo, ["init", "-q", "-b", "main", "."]);
    writeFileSync(join(repo, "new.ts"), "x\n");
    const snap = snapshotTree(repo)!;
    expect(snap.head).toBeNull();
    expect(snap.entries.has("new.ts")).toBe(true);
  });
});

describe("catching an edit no tool call named", () => {
  it("sees a file rewritten the way a Bash heredoc would", () => {
    // This is the whole reason L4 exists.
    const repo = makeRepo("bash-edit");
    const before = snapshotTree(repo);
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    expect(rels(repo, before)).toEqual([["a.ts", "write", "tree"]]);
  });

  it("sees a brand new untracked file", () => {
    const repo = makeRepo("new-file");
    const before = snapshotTree(repo);
    writeFileSync(join(repo, "c.ts"), "export const c = 1;\n");
    expect(rels(repo, before)).toEqual([["c.ts", "write", "tree"]]);
  });

  it("sees a new file in a new directory", () => {
    const repo = makeRepo("new-dir");
    const before = snapshotTree(repo);
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    writeFileSync(join(repo, "src", "deep", "d.ts"), "x\n");
    // -uall is what makes this a file rather than just "src/ is untracked".
    expect(rels(repo, before)).toEqual([["src/deep/d.ts", "write", "tree"]]);
  });

  it("reports a deletion as a delete", () => {
    const repo = makeRepo("deleted");
    const before = snapshotTree(repo);
    rmSync(join(repo, "b.ts"));
    expect(rels(repo, before)).toEqual([["b.ts", "delete", "tree"]]);
  });

  it("reports both halves of a rename", () => {
    const repo = makeRepo("renamed");
    const before = snapshotTree(repo);
    run(repo, ["mv", "a.ts", "renamed.ts"]);
    expect(rels(repo, before)).toEqual([
      ["a.ts", "delete", "tree"],
      ["renamed.ts", "write", "tree"],
    ]);
  });

  it("handles a path with spaces", () => {
    const repo = makeRepo("spaces");
    const before = snapshotTree(repo);
    writeFileSync(join(repo, "a file with spaces.md"), "x\n");
    expect(rels(repo, before)).toEqual([["a file with spaces.md", "write", "tree"]]);
  });

  it("counts a file that was modified and then committed mid-turn", () => {
    // The tree ends clean, but the turn did write the file.
    const repo = makeRepo("committed");
    const before = snapshotTree(repo);
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
    run(repo, ["commit", "-qam", "mid-turn commit"]);
    const after = snapshotTree(repo)!;
    expect(after.entries.size).toBe(0);
    expect(after.head).not.toBe(before!.head);
    expect(rels(repo, before)).toEqual([["a.ts", "write", "tree"]]);
  });

  it("says nothing when the tree did not move", () => {
    const repo = makeRepo("unchanged");
    const before = snapshotTree(repo);
    expect(rels(repo, before)).toEqual([]);
  });

  it("says nothing about a file that was already dirty and stayed the same", () => {
    const repo = makeRepo("already-dirty");
    writeFileSync(join(repo, "a.ts"), "dirty before the turn\n");
    const before = snapshotTree(repo);
    writeFileSync(join(repo, "b.ts"), "changed during the turn\n");
    // Only b.ts moved during the window; a.ts was someone else's business.
    expect(rels(repo, before)).toEqual([["b.ts", "write", "tree"]]);
  });

  it("notices staging, because the file's state changed", () => {
    const repo = makeRepo("staged");
    writeFileSync(join(repo, "a.ts"), "edited\n");
    const before = snapshotTree(repo);
    run(repo, ["add", "a.ts"]);
    expect(rels(repo, before)).toEqual([["a.ts", "write", "tree"]]);
  });
});

describe("diffTrees", () => {
  it("is empty when either side is missing", () => {
    const repo = makeRepo("missing-side");
    const snap = snapshotTree(repo);
    expect(diffTrees(null, snap)).toEqual([]);
    expect(diffTrees(snap, null)).toEqual([]);
    expect(touchesBetween(snap, null)).toEqual([]);
  });

  it("treats a first snapshot as no history rather than as everything changed", () => {
    // A turn whose start snapshot failed must not claim every dirty file.
    const repo = makeRepo("no-before");
    writeFileSync(join(repo, "a.ts"), "dirty\n");
    expect(touchesBetween(null, snapshotTree(repo))).toEqual([]);
  });
});

describe("parseStatusZ", () => {
  it("reads plain entries", () => {
    expect([...parseStatusZ(" M a.ts\0?? b.ts\0")]).toEqual([
      ["a.ts", " M"],
      ["b.ts", "??"],
    ]);
  });

  it("reads both paths of a rename and marks the old one gone", () => {
    expect([...parseStatusZ("R  new.ts\0old.ts\0")]).toEqual([
      ["new.ts", "R "],
      ["old.ts", " D"],
    ]);
  });

  it("keeps the source of a copy as still present", () => {
    expect([...parseStatusZ("C  copy.ts\0orig.ts\0")]).toEqual([
      ["copy.ts", "C "],
      ["orig.ts", "C "],
    ]);
  });

  it("ignores empty and truncated fields", () => {
    expect(parseStatusZ("").size).toBe(0);
    expect(parseStatusZ("\0\0").size).toBe(0);
    expect(parseStatusZ("M\0").size).toBe(0);
  });
});
