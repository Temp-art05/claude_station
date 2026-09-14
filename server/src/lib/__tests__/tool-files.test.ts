import { describe, expect, it } from "vitest";
import { filesFromToolUse, toolLabel } from "../tool-files";

const CWD = "/Users/x/repo";

describe("filesFromToolUse", () => {
  it("reads the path off an Edit and calls it a write", () => {
    expect(filesFromToolUse("Edit", { file_path: "/Users/x/repo/a.ts" }, CWD)).toEqual([
      { absPath: "/Users/x/repo/a.ts", op: "write", toolName: "Edit" },
    ]);
  });

  it("treats Write and MultiEdit the same way", () => {
    expect(filesFromToolUse("Write", { file_path: "/a/b.ts" }, CWD)[0]!.op).toBe("write");
    expect(filesFromToolUse("MultiEdit", { file_path: "/a/b.ts" }, CWD)[0]!.op).toBe("write");
  });

  it("records a Read as a read, not a write", () => {
    expect(filesFromToolUse("Read", { file_path: "/a/b.ts" }, CWD)[0]!.op).toBe("read");
  });

  it("takes the notebook path when that is what the tool names", () => {
    expect(filesFromToolUse("NotebookEdit", { notebook_path: "/a/n.ipynb" }, CWD)).toEqual([
      { absPath: "/a/n.ipynb", op: "write", toolName: "NotebookEdit" },
    ]);
  });

  it("absolutises a relative path against the turn's cwd", () => {
    expect(filesFromToolUse("Edit", { file_path: "src/a.ts" }, CWD)[0]!.absPath).toBe(
      "/Users/x/repo/src/a.ts",
    );
  });

  it("says nothing about a Bash call, however obvious the path looks", () => {
    // The measured blind spot: a path in a shell command is not evidence the
    // command wrote it. The tree snapshot closes this, not a guess here.
    expect(
      filesFromToolUse("Bash", { command: "sed -i '' s/a/b/ /Users/x/repo/a.ts" }, CWD),
    ).toEqual([]);
  });

  it("says nothing for tools that name no file", () => {
    expect(filesFromToolUse("Grep", { pattern: "foo" }, CWD)).toEqual([]);
    expect(filesFromToolUse("Task", { subagent_type: "docs-planner" }, CWD)).toEqual([]);
  });

  it("survives input that is missing, empty or the wrong shape", () => {
    expect(filesFromToolUse("Edit", null, CWD)).toEqual([]);
    expect(filesFromToolUse("Edit", {}, CWD)).toEqual([]);
    expect(filesFromToolUse("Edit", { file_path: "   " }, CWD)).toEqual([]);
    expect(filesFromToolUse("Edit", { file_path: 42 }, CWD)).toEqual([]);
    expect(filesFromToolUse("Edit", "nope", CWD)).toEqual([]);
  });
});

describe("toolLabel", () => {
  it("names the subagent a Task ran", () => {
    expect(toolLabel("Task", { subagent_type: "docs-planner" })).toBe("Task:docs-planner");
  });

  it("falls back to plain Task when the subagent is unnamed", () => {
    expect(toolLabel("Task", {})).toBe("Task");
    expect(toolLabel("Task", { subagent_type: "  " })).toBe("Task");
    expect(toolLabel("Task", null)).toBe("Task");
  });

  it("leaves every other tool name alone", () => {
    expect(toolLabel("Edit", { file_path: "/a" })).toBe("Edit");
  });
});
