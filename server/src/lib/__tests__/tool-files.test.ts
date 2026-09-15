import { describe, expect, it } from "vitest";
import { filesFromToolUse, linesFromToolUse, toolLabel } from "../tool-files";

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

describe("linesFromToolUse", () => {
  it("counts an Edit on both sides", () => {
    expect(linesFromToolUse("Edit", { old_string: "a\nb", new_string: "a\nb\nc" })).toEqual({
      added: 3,
      removed: 2,
    });
  });

  it("sums every edit of a MultiEdit", () => {
    expect(
      linesFromToolUse("MultiEdit", {
        edits: [
          { old_string: "a", new_string: "a\nb" },
          { old_string: "x\ny", new_string: "" },
        ],
      }),
    ).toEqual({ added: 2, removed: 3 });
  });

  it("counts a Write as all added — the call says nothing about what was there", () => {
    expect(linesFromToolUse("Write", { content: "one\ntwo\nthree" })).toEqual({
      added: 3,
      removed: 0,
    });
  });

  it("counts nothing for a Bash call, which is the known blind spot", () => {
    expect(linesFromToolUse("Bash", { command: "sed -i '' s/a/b/ f.ts" })).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it("treats an empty string as zero lines, not one", () => {
    expect(linesFromToolUse("Write", { content: "" }).added).toBe(0);
  });

  it("survives arguments that are not what the tool promised", () => {
    expect(linesFromToolUse("Edit", null)).toEqual({ added: 0, removed: 0 });
    expect(linesFromToolUse("MultiEdit", { edits: "nope" })).toEqual({ added: 0, removed: 0 });
  });

  it("counts a notebook cell delete as removed", () => {
    expect(linesFromToolUse("NotebookEdit", { edit_mode: "delete", new_source: "a\nb" })).toEqual({
      added: 0,
      removed: 2,
    });
  });
});
