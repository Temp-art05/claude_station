import matter from "gray-matter";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@claude-station/shared";

// The service imports the DB at module load; these tests only touch the
// markdown round-trip, so stub it rather than opening a real database.
vi.mock("../../db", () => ({ db: {}, schema: {} }));

const { exportAgentMarkdown } = await import("../agents");

const agent: Agent = {
  id: "a1",
  name: "build-fixer",
  description: "Use when a build fails",
  prompt: "You fix broken builds.",
  tools: ["Bash", "Read"],
  disallowedTools: ["Write"],
  skills: null,
  model: "sonnet",
  maxTurns: 40,
  background: false,
  viewPath: null,
  viewUrl: null,
  startCommand: null,
  bundleDir: null,
  enabledGlobally: false,
  source: "manual",
  createdAt: "now",
  updatedAt: "now",
};

describe("exportAgentMarkdown", () => {
  it("writes every configured field into the frontmatter", () => {
    const md = exportAgentMarkdown(agent);
    expect(md).toContain("name: build-fixer");
    expect(md).toContain("tools: Bash, Read");
    expect(md).toContain("disallowedTools: Write");
    expect(md).toContain("model: sonnet");
    expect(md).toContain("maxTurns: 40");
    expect(md).toContain("You fix broken builds.");
    expect(md).not.toContain("background:");
  });

  it("quotes the description so a colon can't break the YAML", () => {
    const md = exportAgentMarkdown({ ...agent, description: "Use when: a build fails" });
    expect(matter(md).data.description).toBe("Use when: a build fails");
  });

  it("omits fields that are unset", () => {
    const md = exportAgentMarkdown({ ...agent, tools: null, disallowedTools: null, model: null });
    expect(md).not.toContain("tools:");
    expect(md).not.toContain("model:");
  });

  it("round-trips: what it writes, gray-matter reads back", () => {
    const parsed = matter(exportAgentMarkdown(agent));
    expect(parsed.data.name).toBe("build-fixer");
    expect(parsed.data.tools).toBe("Bash, Read");
    expect(parsed.data.maxTurns).toBe(40);
    expect(parsed.content.trim()).toBe(agent.prompt);
  });
});
