import { describe, expect, it } from "vitest";
import { pathEq, pathUnder, pathUnderAny, relativeUnder } from "../path-compare";

const darwin = process.platform === "darwin";

describe("pathEq", () => {
  it("matches identical paths", () => {
    expect(pathEq("/a/b", "/a/b")).toBe(true);
  });

  it("ignores a trailing separator", () => {
    expect(pathEq("/a/b/", "/a/b")).toBe(true);
  });

  it("separates different paths", () => {
    expect(pathEq("/a/b", "/a/c")).toBe(false);
  });

  it("ignores case where the filesystem does", () => {
    // The case that actually bit: ~/iOS and ~/IOS are one directory on macOS,
    // and the CLI records whichever spelling the shell's cwd had.
    expect(pathEq("/Users/x/iOS/App", "/Users/x/IOS/App")).toBe(darwin);
  });
});

describe("pathUnder", () => {
  it("counts a directory as under itself", () => {
    expect(pathUnder("/a/b", "/a/b")).toBe(true);
  });

  it("matches a nested path", () => {
    expect(pathUnder("/a/b/c/d.ts", "/a/b")).toBe(true);
  });

  it("does not match a sibling with a shared prefix", () => {
    expect(pathUnder("/a/bc/d.ts", "/a/b")).toBe(false);
  });

  it("matches across a case difference where the filesystem does", () => {
    expect(pathUnder("/Users/x/IOS/App/f.swift", "/Users/x/iOS")).toBe(darwin);
  });
});

describe("relativeUnder", () => {
  it("returns the path inside the parent, in the child's own spelling", () => {
    expect(relativeUnder("/a/b/Sources/App.swift", "/a/b")).toBe("Sources/App.swift");
  });

  it("keeps the child's spelling even when the parent's differs", () => {
    if (!darwin) return;
    expect(relativeUnder("/Users/x/IOS/App/F.swift", "/Users/x/iOS")).toBe("App/F.swift");
  });

  it("is empty for the parent itself and for a path outside it", () => {
    expect(relativeUnder("/a/b", "/a/b")).toBe("");
    expect(relativeUnder("/a/c/d", "/a/b")).toBe("");
  });
});

describe("pathUnderAny", () => {
  it("is true when any parent contains the child", () => {
    expect(pathUnderAny("/a/w/f.ts", ["/a/b", "/a/w"])).toBe(true);
  });

  it("is false when none does", () => {
    expect(pathUnderAny("/z/f.ts", ["/a/b", "/a/w"])).toBe(false);
    expect(pathUnderAny("/z/f.ts", [])).toBe(false);
  });
});
