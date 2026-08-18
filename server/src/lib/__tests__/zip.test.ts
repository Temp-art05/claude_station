import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// zip.ts pulls in path-safety for the 413 helper, which reads the DB at import.
vi.mock("../../db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ all: () => [] }), all: () => [] }) }) },
  schema: { projectPaths: { projectId: "project_id" } },
}));

const { attachmentName, contentDisposition, dirEntries, zipEntries } = await import("../zip");

describe("dirEntries", () => {
  it("walks nested dirs and keeps POSIX paths", () => {
    const root = mkdtempSync(join(tmpdir(), "zip-"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "SKILL.md"), "top");
    writeFileSync(join(root, "scripts", "run.sh"), "nested");

    const entries = dirEntries(root).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(entries.map((e) => e.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
  });

  it("refuses a tree past the budget instead of loading it", () => {
    const root = mkdtempSync(join(tmpdir(), "zip-"));
    writeFileSync(join(root, "big.bin"), Buffer.alloc(1024));
    expect(() => dirEntries(root, "", { bytes: 512 })).toThrowError(/Too big/);
  });
});

describe("zipEntries", () => {
  it("produces a zip archive", async () => {
    const buf = await zipEntries([{ path: "a/b.txt", data: "hello" }]);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});

describe("contentDisposition", () => {
  it("keeps accents in filename* and an ASCII fallback in filename", () => {
    const header = contentDisposition("Trợ lý", ".zip");
    expect(header).toContain('filename="Tr-l.zip"');
    expect(header).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(header.split("UTF-8''")[1]!)).toBe("Trợ lý.zip");
  });

  it("cannot inject a header field or a path", () => {
    const header = contentDisposition('evil"\r\nX-Injected: 1', ".yaml");
    expect(header).not.toMatch(/[\r\n"]X/);
    expect(header.split("UTF-8''")[1]!).not.toMatch(/[\r\n"]/);
    expect(decodeURIComponent(contentDisposition("a/../b", ".zip").split("UTF-8''")[1]!)).toBe(
      "a-..-b.zip",
    );
  });

  it("falls back when nothing survives sanitising", () => {
    expect(attachmentName("///", ".zip")).toBe("download.zip");
    expect(contentDisposition("///", ".zip")).toContain('filename="download.zip"');
  });

  it("can be inline for the preview pane", () => {
    expect(contentDisposition("Sheet 1", ".csv", "inline")).toMatch(/^inline; /);
  });
});
