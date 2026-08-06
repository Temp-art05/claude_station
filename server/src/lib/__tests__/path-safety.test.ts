import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The module reads the DB for allowed roots; stub that out so these stay unit tests.
const roots: string[] = [];
vi.mock("../../db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ all: () => roots.map((path) => ({ path })) }),
        all: () => roots.map((path) => ({ path })),
      }),
    }),
  },
  schema: { projectPaths: { projectId: "project_id" } },
}));

const { assertPathAllowed, expandPath, prettyPath, resolveDirectory } = await import(
  "../path-safety"
);

let allowed: string;
let outside: string;

beforeAll(() => {
  allowed = mkdtempSync(join(tmpdir(), "cs-allowed-"));
  outside = mkdtempSync(join(tmpdir(), "cs-outside-"));
  mkdirSync(join(allowed, "src"), { recursive: true });
  writeFileSync(join(allowed, "src", "file.ts"), "// hi");
  writeFileSync(join(outside, "secret.txt"), "nope");
  roots.length = 0;
  roots.push(allowed);
});

describe("expandPath", () => {
  it("expands ~ to the home directory", () => {
    expect(expandPath("~/Documents")).toBe(join(homedir(), "Documents"));
  });

  it("rejects an empty path", () => {
    expect(() => expandPath("   ")).toThrow(/empty/i);
  });
});

describe("resolveDirectory", () => {
  it("accepts an existing directory", () => {
    expect(resolveDirectory(allowed)).toContain("cs-allowed-");
  });

  it("rejects a file", () => {
    expect(() => resolveDirectory(join(allowed, "src", "file.ts"))).toThrow(/not an existing directory/);
  });

  it("rejects a missing directory", () => {
    expect(() => resolveDirectory(join(allowed, "nope"))).toThrow(/not an existing directory/);
  });
});

describe("assertPathAllowed", () => {
  it("allows a path inside a registered root", () => {
    expect(assertPathAllowed(join(allowed, "src", "file.ts"))).toContain("file.ts");
  });

  it("blocks a path outside every root", () => {
    expect(() => assertPathAllowed(join(outside, "secret.txt"))).toThrow(/outside allowed roots/);
  });

  it("blocks .. traversal that escapes the root", () => {
    expect(() => assertPathAllowed(join(allowed, "..", "..", "etc", "hosts"))).toThrow(
      /outside allowed roots|does not resolve/,
    );
  });

  it("blocks a symlink pointing outside the root", () => {
    const link = join(allowed, "escape");
    symlinkSync(outside, link, "dir");
    expect(() => assertPathAllowed(join(link, "secret.txt"))).toThrow(/outside allowed roots/);
  });

  it("allows a not-yet-existing file whose parent is inside the root", () => {
    expect(assertPathAllowed(join(allowed, "src", "new-file.ts"))).toContain("new-file.ts");
  });
});

describe("prettyPath", () => {
  it("collapses the home prefix", () => {
    expect(prettyPath(join(homedir(), "IOS", "ReelMe"))).toBe("~/IOS/ReelMe");
  });

  it("leaves unrelated paths alone", () => {
    expect(prettyPath("/opt/tools")).toBe("/opt/tools");
  });
});
