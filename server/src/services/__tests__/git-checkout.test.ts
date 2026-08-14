import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { branchAncestors, buildBranchTree } from "@claude-station/shared";
import { branches, checkout } from "../git";

const run = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repo with one commit, a nested local branch, and an `origin` to clone from. */
function makeRepos(): { repo: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "cs-git-"));
  const repo = join(root, "origin");
  run(root, ["init", "-q", "-b", "main", "origin"]);
  run(repo, ["config", "user.email", "t@example.com"]);
  run(repo, ["config", "user.name", "test"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  run(repo, ["add", "a.txt"]);
  run(repo, ["commit", "-qm", "init"]);
  run(repo, ["branch", "version/4.0.0"]);
  run(repo, ["branch", "version/4.0.10"]);
  run(repo, ["branch", "feature/x"]);
  const clone = join(root, "clone");
  run(root, ["clone", "-q", repo, clone]);
  run(clone, ["config", "user.email", "t@example.com"]);
  run(clone, ["config", "user.name", "test"]);
  return { repo, clone };
}

describe("checkout", () => {
  let repo = "";
  let clone = "";
  beforeAll(() => {
    ({ repo, clone } = makeRepos());
  });

  it("switches to a local branch with a slash instead of creating one", () => {
    const out = checkout(repo, "version/4.0.0");
    expect(out).toBeTypeOf("string");
    const after = branches(repo);
    expect(after.current).toBe("version/4.0.0");
    // The bug this guards: `version/4.0.0` used to be read as remote `version` +
    // branch `4.0.0`, so a click created a new local `4.0.0`.
    expect(after.local.map((b) => b.name)).not.toContain("4.0.0");
    expect(after.local).toHaveLength(4);
  });

  it("is a no-op-ish switch when the local branch already exists", () => {
    checkout(repo, "main");
    checkout(repo, "version/4.0.10");
    expect(branches(repo).current).toBe("version/4.0.10");
    expect(branches(repo).local).toHaveLength(4);
  });

  it("creates a tracking local branch from a remote ref, keeping the full name", () => {
    checkout(clone, "origin/feature/x");
    const after = branches(clone);
    expect(after.current).toBe("feature/x");
    expect(after.local.find((b) => b.name === "feature/x")?.upstream).toBe("origin/feature/x");
    expect(after.local.map((b) => b.name)).not.toContain("x");
  });

  it("prefers an existing local branch over the same-named remote ref", () => {
    checkout(clone, "origin/version/4.0.0");
    expect(branches(clone).current).toBe("version/4.0.0");
    const before = branches(clone).local.length;
    checkout(clone, "main");
    checkout(clone, "origin/version/4.0.0");
    expect(branches(clone).current).toBe("version/4.0.0");
    expect(branches(clone).local).toHaveLength(before);
  });

  it("surfaces git's error for an unknown ref", () => {
    expect(() => checkout(repo, "nope/nope")).toThrow(/checkout failed/i);
  });
});

describe("buildBranchTree", () => {
  it("groups a shared prefix and sorts versions naturally", () => {
    const tree = buildBranchTree(["backup_develop", "version/4.0.10", "version/4.0.0"]);
    expect(tree).toEqual([
      {
        kind: "folder",
        label: "version",
        path: "version",
        count: 2,
        children: [
          { kind: "leaf", name: "version/4.0.0", label: "4.0.0" },
          { kind: "leaf", name: "version/4.0.10", label: "4.0.10" },
        ],
      },
      { kind: "leaf", name: "backup_develop", label: "backup_develop" },
    ]);
  });

  it("leaves a lone prefix flat instead of making a one-child folder", () => {
    expect(buildBranchTree(["version/4.0.0", "develop"])).toEqual([
      { kind: "leaf", name: "develop", label: "develop" },
      { kind: "leaf", name: "version/4.0.0", label: "version/4.0.0" },
    ]);
  });

  it("nests deeper paths and keeps the full ref on every leaf", () => {
    const tree = buildBranchTree([
      "origin/develop",
      "origin/cherry-pick/aip555",
      "origin/cherry-pick/aip556",
    ]);
    const origin = tree[0];
    expect(origin).toMatchObject({ kind: "folder", label: "origin", count: 3 });
    if (origin?.kind !== "folder") throw new Error("expected folder");
    expect(origin.children[0]).toMatchObject({
      kind: "folder",
      label: "cherry-pick",
      path: "origin/cherry-pick",
      count: 2,
    });
    const nested = origin.children[0];
    if (nested?.kind !== "folder") throw new Error("expected folder");
    expect(nested.children.map((c) => (c.kind === "leaf" ? c.name : c.path))).toEqual([
      "origin/cherry-pick/aip555",
      "origin/cherry-pick/aip556",
    ]);
  });
});

describe("branchAncestors", () => {
  it("lists the folder paths above a branch", () => {
    expect(branchAncestors("version/4.0.0")).toEqual(["version"]);
    expect(branchAncestors("a/b/c")).toEqual(["a", "a/b"]);
    expect(branchAncestors("main")).toEqual([]);
  });
});
