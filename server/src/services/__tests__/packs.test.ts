/**
 * What a pack is understood to contain, and what it is not allowed to be.
 *
 * The scan is the whole security surface worth unit-testing: install is a
 * registration of whatever this returns, so a script that scans as a skill is a
 * script that gets linked where Claude Code loads it.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-packs-"));
process.env.CLAUDE_STATION_DATA = dataDir;

const packs = await import("../packs");
const { db, schema } = await import("../../db");
const { eq } = await import("drizzle-orm");

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cs-pack-src-"));
  for (const [relPath, body] of Object.entries(files)) {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return root;
}

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("normaliseRepoUrl", () => {
  it("takes an https git URL", () => {
    expect(packs.normaliseRepoUrl(" https://github.com/owner/name ")).toBe(
      "https://github.com/owner/name",
    );
    expect(packs.normaliseRepoUrl("https://github.com/owner/name.git")).toBe(
      "https://github.com/owner/name.git",
    );
  });

  it("refuses anything that would point the cloner at this machine", () => {
    // The pack directory is read back through the API, so a local clone source
    // is a way to copy arbitrary files into something this app serves.
    for (const bad of [
      "file:///etc",
      "/Users/me/secrets",
      "git@github.com:owner/name.git",
      "ssh://git@github.com/owner/name",
      "http://github.com/owner/name",
    ]) {
      expect(() => packs.normaliseRepoUrl(bad)).toThrow();
    }
  });
});

describe("packNameFrom", () => {
  it("names the pack after the repo", () => {
    expect(packs.packNameFrom("https://github.com/Owner/Cool_Pack.git")).toBe("cool_pack");
  });

  it("keeps the name usable as a directory", () => {
    expect(packs.packNameFrom("https://github.com/o/we ird$name")).toBe("we-ird-name");
  });
});

describe("scanPack", () => {
  it("reads the tree rather than a manifest the pack wrote", () => {
    const root = tree({
      "skills/reviewer/SKILL.md": "---\nname: reviewer\n---\nreview things",
      "skills/reviewer/reference.md": "more",
      "agents/be-docs.md": "---\nname: be-docs\n---\nfetch docs",
      "workflows/release.yaml": "name: release\nsteps: []",
      "README.md": "# a pack",
    });
    const assets = packs.scanPack(root);
    expect(assets.map((a) => `${a.kind}:${a.name}`)).toEqual([
      "agent:be-docs",
      "skill:reviewer",
      "workflow:release",
    ]);
    expect(assets.find((a) => a.kind === "skill")?.files).toContain("skills/reviewer/reference.md");
  });

  it("calls a loose script a script, and always with a warning", () => {
    const root = tree({
      "skills/deploy/SKILL.md": "---\nname: deploy\n---\nship it",
      "skills/deploy/run.sh": "rm -rf /",
      "hooks/pre-commit.py": "print('hi')",
    });
    const scripts = packs.scanPack(root).filter((a) => a.kind === "script");
    // `run.sh` belongs to the deploy skill and is reported on that skill's row;
    // only the hook is loose. See the "what belongs to a skill" block below.
    expect(scripts.map((s) => s.relPath)).toEqual(["hooks/pre-commit.py"]);
    expect(scripts.every((s) => s.warning)).toBe(true);
  });

  it("warns on a skill that carries scripts, because installing it copies them", () => {
    const root = tree({
      "skills/deploy/SKILL.md": "---\nname: deploy\n---\nship it",
      "skills/deploy/run.sh": "echo hi",
    });
    const skill = packs.scanPack(root).find((a) => a.kind === "skill");
    expect(skill?.warning).toContain("script");
  });

  it("ignores the repo's own machinery", () => {
    const root = tree({
      "node_modules/pkg/index.js": "module.exports = 1",
      ".git/config": "[core]",
      "agents/real.md": "---\nname: real\n---\nhi",
    });
    expect(packs.scanPack(root).map((a) => a.relPath)).toEqual(["agents/real.md"]);
  });

  it("does not mistake a loose markdown file for an asset", () => {
    // Only `agents/` and `workflows/` are claimed, plus any directory with a
    // SKILL.md. A repo's docs are documents, not things to install.
    const root = tree({ "docs/architecture.md": "# how it works", "CONTRIBUTING.md": "hi" });
    expect(packs.scanPack(root)).toEqual([]);
  });
});

describe("scanPack — what belongs to a skill", () => {
  it("does not list a skill's own scripts as separate assets", () => {
    // The bug this replaced: `docx.py` appeared as a `script` row saying "never
    // installed or run", directly above the `docx` skill whose install copies
    // it. Two rows, opposite claims, the same file.
    const root = tree({
      "skills/docx/SKILL.md": "---\nname: docx\n---\nedit word files",
      "skills/docx/scripts/docx.py": "print(1)",
      "skills/docx/scripts/office/soffice.py": "print(2)",
    });
    const assets = packs.scanPack(root);
    expect(assets.map((a) => a.kind)).toEqual(["skill"]);
    expect(assets[0]!.warning).toContain("2 script");
  });

  it("still lists a script that belongs to no skill", () => {
    const root = tree({
      "skills/docx/SKILL.md": "---\nname: docx\n---\nhi",
      "skills/docx/run.sh": "echo in-skill",
      "hooks/pre-commit.py": "print('loose')",
      "tools/release.sh": "echo loose",
    });
    const scripts = packs.scanPack(root).filter((a) => a.kind === "script");
    expect(scripts.map((s) => s.relPath).sort()).toEqual([
      "hooks/pre-commit.py",
      "tools/release.sh",
    ]);
  });

  it("finds agents and workflows at any depth, not just the repo root", () => {
    // The Claude Code plugin layout, which put 202 agents out of reach when
    // this only matched a top-level `agents/`.
    const root = tree({
      "plugins/backend-development/agents/backend-architect.md": "---\nname: ba\n---\nhi",
      "plugins/backend-development/workflows/release.yaml": "name: release\nsteps: []",
      "agents/top-level.md": "---\nname: tl\n---\nhi",
    });
    const assets = packs.scanPack(root);
    expect(
      assets
        .filter((a) => a.kind === "agent")
        .map((a) => a.name)
        .sort(),
    ).toEqual(["backend-architect", "top-level"]);
    expect(assets.filter((a) => a.kind === "workflow")).toHaveLength(1);
  });

  it("does not claim a markdown file just because a parent dir is named agents", () => {
    const root = tree({ "agents/docs/notes/readme.md": "not an agent" });
    expect(packs.scanPack(root)).toEqual([]);
  });
});

describe("sweepStaging", () => {
  it("removes an abandoned preview clone and leaves a fresh one alone", () => {
    const packsDir = join(dataDir, "packs");
    mkdirSync(join(packsDir, ".staging-old-1"), { recursive: true });
    mkdirSync(join(packsDir, ".staging-new-2"), { recursive: true });
    mkdirSync(join(packsDir, "installed-pack"), { recursive: true });

    // Two hours back: past the hour a preview is given to be decided on.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(packsDir, ".staging-old-1"), old, old);

    expect(packs.sweepStaging()).toBe(1);
    expect(existsSync(join(packsDir, ".staging-old-1"))).toBe(false);
    expect(existsSync(join(packsDir, ".staging-new-2"))).toBe(true);
    // Never touches an installed pack, whatever its age.
    expect(existsSync(join(packsDir, "installed-pack"))).toBe(true);
  });
});

describe("install and uninstall, end to end", () => {
  /** A staged clone, the way `previewPack` leaves one behind. */
  function staged(files: Record<string, string>): { stagedPath: string } {
    const packsDir = join(dataDir, "packs");
    mkdirSync(packsDir, { recursive: true });
    const stagedPath = join(packsDir, `.staging-demo-${Date.now()}`);
    for (const [relPath, body] of Object.entries(files)) {
      const full = join(stagedPath, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
    return { stagedPath };
  }

  it("files a skill in Knowledge, the same as a hand upload does", () => {
    const { stagedPath } = staged({
      "skills/reviewer/SKILL.md": "---\nname: reviewer\ndescription: review code\n---\nlook hard",
      "skills/reviewer/reference.md": "more detail",
    });

    const { pack, installed } = packs.installPack(
      {
        name: "demo",
        repoUrl: "https://github.com/o/demo",
        ref: "HEAD",
        sha: "a".repeat(40),
        stagedPath,
      },
      ["skills/reviewer/SKILL.md"],
    );

    expect(installed).toHaveLength(1);
    const item = db
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, installed[0]!.refId!))
      .get();
    // The whole point: a pack's skill is a Knowledge row like any other, and
    // says which pack it came from rather than hiding in a separate store.
    expect(item?.kind).toBe("skill");
    expect(item?.name).toBe("reviewer");
    expect(item?.description).toBe("review code");
    expect(item?.folder).toBe("packs/demo");

    packs.uninstallPack(pack.id);
    expect(
      db
        .select()
        .from(schema.knowledgeItems)
        .where(eq(schema.knowledgeItems.id, installed[0]!.refId!))
        .get(),
    ).toBeUndefined();
    expect(packs.listPacks()).toHaveLength(0);
  });

  it("records a script without installing it", () => {
    const { stagedPath } = staged({ "hooks/pre-commit.sh": "echo hi" });
    const { pack, installed } = packs.installPack(
      {
        name: "hooky",
        repoUrl: "https://github.com/o/hooky",
        ref: "HEAD",
        sha: "b".repeat(40),
        stagedPath,
      },
      ["hooks/pre-commit.sh"],
    );
    expect(installed[0]!.status).toBe("skipped");
    expect(installed[0]!.refId).toBeNull();
    packs.uninstallPack(pack.id);
  });
});

describe("a pack installed by the older version", () => {
  it("still unlinks its skills, which were recorded by name rather than by id", () => {
    // Before skills were filed in Knowledge, `pack_assets.refId` held the skill
    // name. Uninstall must not walk away leaving twenty live symlinks behind.
    const { stagedPath } = (() => {
      const packsDir = join(dataDir, "packs");
      mkdirSync(packsDir, { recursive: true });
      const p = join(packsDir, `.staging-legacy-${Date.now()}`);
      mkdirSync(join(p, "skills/legacy-skill"), { recursive: true });
      writeFileSync(
        join(p, "skills/legacy-skill/SKILL.md"),
        "---\nname: legacy-skill\n---\nold shape",
        "utf8",
      );
      return { stagedPath: p };
    })();

    const { pack, installed } = packs.installPack(
      {
        name: "legacy",
        repoUrl: "https://github.com/o/legacy",
        ref: "HEAD",
        sha: "c".repeat(40),
        stagedPath,
      },
      ["skills/legacy-skill/SKILL.md"],
    );

    // Rewrite the row into the old shape: refId = the name, not the row id.
    db.update(schema.packAssets)
      .set({ refId: "legacy-skill" })
      .where(eq(schema.packAssets.id, installed[0]!.id))
      .run();

    expect(() => packs.uninstallPack(pack.id)).not.toThrow();
    expect(packs.listPacks()).toHaveLength(0);
    // The tree, not only the link. Leaving it meant the next install of the
    // same pack came back as `legacy-skill-2`.
    expect(existsSync(join(dataDir, "skills", "legacy-skill"))).toBe(false);
  });
});
