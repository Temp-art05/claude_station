import { describe, expect, it } from "vitest";
import { buildClaudeCommand, shq } from "../claude-cli";

describe("shq", () => {
  it("wraps a plain path in single quotes", () => {
    expect(shq("/Users/me/BE-WISS555")).toBe("'/Users/me/BE-WISS555'");
  });

  it("keeps spaces inside one argument", () => {
    expect(shq("/Users/me/My Repo")).toBe("'/Users/me/My Repo'");
  });

  it("escapes an embedded single quote", () => {
    // 'a'\''b' is how a shell reads a'b — closing, escaping, reopening.
    expect(shq("/tmp/a'b")).toBe(`'/tmp/a'\\''b'`);
  });

  it("leaves shell metacharacters inert", () => {
    for (const raw of ["/tmp/$HOME", "/tmp/`id`", "/tmp/a;rm -rf /", "/tmp/a b#c"]) {
      const quoted = shq(raw);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      // Nothing but the escape sequence may break out of the quoting.
      expect(quoted.slice(1, -1).replaceAll(`'\\''`, "")).not.toContain("'");
    }
  });
});

describe("buildClaudeCommand", () => {
  it("is the bare CLI with no context", () => {
    expect(buildClaudeCommand(false)).toBe("claude");
    expect(buildClaudeCommand(true)).toBe("claude --continue || claude");
  });

  it("treats an empty dir list as no context", () => {
    expect(buildClaudeCommand(false, { extraDirs: [] })).toBe("claude");
  });

  it("passes the context file and one --add-dir per directory", () => {
    const cmd = buildClaudeCommand(false, {
      contextFile: "/data/terminal-context/t1.md",
      extraDirs: ["/Users/me/BE", "/Users/me/Docs"],
    });
    expect(cmd).toBe(
      "claude --append-system-prompt-file '/data/terminal-context/t1.md'" +
        " --add-dir '/Users/me/BE' --add-dir '/Users/me/Docs'",
    );
  });

  it("omits the context flag when there is no file but keeps --add-dir", () => {
    const cmd = buildClaudeCommand(false, { extraDirs: ["/Users/me/BE"] });
    expect(cmd).toBe("claude --add-dir '/Users/me/BE'");
    expect(cmd).not.toContain("--append-system-prompt-file");
  });

  it("repeats the flags on the restart fallback branch", () => {
    // Regression guard: a failed --continue must not fall back to a context-less CLI.
    const cmd = buildClaudeCommand(true, {
      contextFile: "/data/t1.md",
      extraDirs: ["/Users/me/BE"],
    });
    const [resume, fallback] = cmd.split(" || ");
    expect(resume).toBe("claude --continue --append-system-prompt-file '/data/t1.md' --add-dir '/Users/me/BE'");
    expect(fallback).toBe("claude --append-system-prompt-file '/data/t1.md' --add-dir '/Users/me/BE'");
  });

  it("quotes a directory containing a space", () => {
    expect(buildClaudeCommand(false, { extraDirs: ["/Users/me/My Repo"] })).toBe(
      "claude --add-dir '/Users/me/My Repo'",
    );
  });
});

describe("buildClaudeCommand with a session id", () => {
  const sid = "11111111-2222-3333-4444-555555555555";

  it("pins a fresh session to the id", () => {
    expect(buildClaudeCommand(false, { sessionId: sid })).toBe(`claude --session-id '${sid}'`);
  });

  it("resumes that id, not whatever was newest in the directory", () => {
    const cmd = buildClaudeCommand(true, { sessionId: sid });
    expect(cmd).toBe(`claude --resume '${sid}' || claude --session-id '${sid}'`);
    expect(cmd).not.toContain("--continue");
  });

  it("keeps the workspace flags on both branches", () => {
    const cmd = buildClaudeCommand(true, {
      sessionId: sid,
      contextFile: "/data/ctx.md",
      extraDirs: ["/repo/be"],
    });
    const [resume, fallback] = cmd.split(" || ");
    for (const branch of [resume, fallback]) {
      expect(branch).toContain("--append-system-prompt-file '/data/ctx.md'");
      expect(branch).toContain("--add-dir '/repo/be'");
    }
  });

  it("falls back to the old --continue form when there is no id (legacy rows)", () => {
    expect(buildClaudeCommand(true)).toBe("claude --continue || claude");
  });
});
