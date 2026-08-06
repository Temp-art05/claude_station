import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adfToMarkdown } from "../jira";
import { parseWorkbook, readSheet, writeWorkbook } from "../excel";
import { tailLog } from "../commands";

describe("adfToMarkdown", () => {
  it("renders paragraphs, marks and lists", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world", marks: [{ type: "strong" }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
          ],
        },
      ],
    };
    const md = adfToMarkdown(doc);
    expect(md).toContain("Hello **world**");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });

  it("renders code blocks with the language", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "swift" },
          content: [{ type: "text", text: "let x = 1" }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("```swift\nlet x = 1\n```");
  });

  it("survives unknown node types instead of throwing", () => {
    const doc = {
      type: "doc",
      content: [{ type: "someFutureThing", content: [{ type: "text", text: "kept" }] }],
    };
    expect(adfToMarkdown(doc)).toBe("kept");
  });

  it("returns empty string for null/undefined", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(undefined)).toBe("");
  });
});

describe("excel round trip", () => {
  it("writes a workbook, parses it to CSV per sheet and reads rows back", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-xlsx-"));
    const target = join(dir, "report.xlsx");

    writeWorkbook(target, [
      { name: "Summary", rows: [["sku", "price"], ["A-1", 10], ["A-2", 20]] },
      { name: "Notes", rows: [["note"], ["hello"]] },
    ]);

    const parsed = parseWorkbook(target);
    expect(parsed.sheets.map((s) => s.name)).toEqual(["Summary", "Notes"]);
    expect(parsed.sheets[0]?.rows).toBe(3);
    expect(parsed.sheets[0]?.cols).toBe(2);

    const read = readSheet(target, "Summary");
    expect(read.rows[0]).toEqual(["sku", "price"]);
    expect(read.rows[2]).toEqual(["A-2", 20]);
    expect(read.truncated).toBe(false);
  });

  it("rejects a missing sheet name", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-xlsx-"));
    const target = join(dir, "x.xlsx");
    writeWorkbook(target, [{ name: "Only", rows: [["a"]] }]);
    expect(() => readSheet(target, "Nope")).toThrow(/Sheet not found/);
  });
});

describe("tailLog", () => {
  it("returns the tail and flags truncation", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-log-"));
    const file = join(dir, "run.log");
    writeFileSync(file, "x".repeat(1000) + "END");

    const whole = tailLog(file, 10_000);
    expect(whole).not.toContain("truncated");
    expect(whole.endsWith("END")).toBe(true);

    const tail = tailLog(file, 20);
    expect(tail).toContain("truncated");
    expect(tail.endsWith("END")).toBe(true);
  });

  it("returns empty string when the log is gone", () => {
    expect(tailLog("/definitely/not/here.log", 100)).toBe("");
  });
});
