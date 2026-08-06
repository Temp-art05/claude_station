import { describe, expect, it } from "vitest";
import { isSkippablePath, sanitizeRelPath, splitFolderRoot } from "../multipart";

describe("sanitizeRelPath", () => {
  it("accepts normal nested paths", () => {
    expect(sanitizeRelPath("MyFolder/sub/file.txt")).toBe("MyFolder/sub/file.txt");
    expect(sanitizeRelPath("a\\b\\c.md")).toBe("a/b/c.md");
  });

  it("rejects traversal and absolute paths", () => {
    expect(() => sanitizeRelPath("../x")).toThrow();
    expect(() => sanitizeRelPath("a/../b")).toThrow();
    expect(() => sanitizeRelPath("/etc/passwd")).toThrow();
    expect(() => sanitizeRelPath("C:\\Windows\\x")).toThrow();
    expect(() => sanitizeRelPath("a/./b")).toThrow();
    expect(() => sanitizeRelPath("")).toThrow();
    expect(() => sanitizeRelPath("a\0b")).toThrow();
  });

  it("keeps dotfiles — app bundles need their .env", () => {
    expect(sanitizeRelPath("folder/.env")).toBe("folder/.env");
    expect(sanitizeRelPath("folder/.hidden.md")).toBe("folder/.hidden.md");
    expect(() => sanitizeRelPath("folder/...")).toThrow();
  });
});

describe("isSkippablePath", () => {
  it("skips OS junk and VCS internals", () => {
    expect(isSkippablePath("folder/.DS_Store")).toBe(true);
    expect(isSkippablePath("folder/Thumbs.db")).toBe(true);
    expect(isSkippablePath("folder/.git/config")).toBe(true);
    expect(isSkippablePath("folder/node_modules/x/index.js")).toBe(true);
    expect(isSkippablePath("folder/readme.md")).toBe(false);
  });
});

describe("splitFolderRoot", () => {
  const buf = Buffer.from("x");

  it("strips the shared root segment", () => {
    const { rootName, files } = splitFolderRoot([
      { relPath: "Pack/SKILL.md", data: buf },
      { relPath: "Pack/refs/a.md", data: buf },
    ]);
    expect(rootName).toBe("Pack");
    expect(files.map((f) => f.relPath)).toEqual(["SKILL.md", "refs/a.md"]);
  });

  it("leaves mixed-root uploads untouched", () => {
    const { rootName, files } = splitFolderRoot([
      { relPath: "a.md", data: buf },
      { relPath: "Pack/b.md", data: buf },
    ]);
    expect(rootName).toBe("import");
    expect(files.map((f) => f.relPath)).toEqual(["a.md", "Pack/b.md"]);
  });
});
