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
    expect(resume).toBe(
      "claude --continue --append-system-prompt-file '/data/t1.md' --add-dir '/Users/me/BE'",
    );
    expect(fallback).toBe(
      "claude --append-system-prompt-file '/data/t1.md' --add-dir '/Users/me/BE'",
    );
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

describe("buildClaudeCommand for a workflow step", () => {
  it("hands the step the station's tools, and only those", () => {
    const cmd = buildClaudeCommand(false, {
      sessionId: "s1",
      mcpConfigFile: "/data/workflows/r1/mcp.json",
    });
    expect(cmd).toContain("--mcp-config '/data/workflows/r1/mcp.json'");
    // Without --strict-mcp-config the step also inherits whatever MCP servers this
    // machine happens to have configured, which is not what the workflow asked for.
    expect(cmd).toContain("--strict-mcp-config");
  });

  it("starts the CLI in the step's own permission mode", () => {
    expect(buildClaudeCommand(false, { permissionMode: "acceptEdits" })).toContain(
      "--permission-mode 'acceptEdits'",
    );
  });

  it("pins the step's model when it asked for one", () => {
    expect(buildClaudeCommand(false, { sessionId: "s1", model: "sonnet" })).toContain(
      "--model 'sonnet'",
    );
  });

  it("leaves all three flags off for an ordinary terminal", () => {
    const cmd = buildClaudeCommand(false, { sessionId: "s1" });
    expect(cmd).not.toContain("--mcp-config");
    expect(cmd).not.toContain("--permission-mode");
    // No --model means the machine's own default, which is what somebody who
    // opened a terminal by hand expects to be talking to.
    expect(cmd).not.toContain("--model");
  });

  it("repeats them on the restart fallback, or a failed resume loses its tools", () => {
    const cmd = buildClaudeCommand(true, {
      sessionId: "s1",
      mcpConfigFile: "/tmp/mcp.json",
      permissionMode: "acceptEdits",
      model: "sonnet",
    });
    const [resume, fallback] = cmd.split(" || ");
    for (const branch of [resume, fallback]) {
      expect(branch).toContain("--mcp-config '/tmp/mcp.json'");
      expect(branch).toContain("--strict-mcp-config");
      expect(branch).toContain("--permission-mode 'acceptEdits'");
      expect(branch).toContain("--model 'sonnet'");
    }
  });
});
