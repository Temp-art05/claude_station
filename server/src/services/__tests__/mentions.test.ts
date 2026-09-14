import { describe, expect, it, vi } from "vitest";

// The parsing half is pure; the fetching half talks to gh and Jira, so those are
// stubbed and only the wiring is asserted here.
vi.mock("../gh", () => ({
  getContents: vi.fn(),
  githubConfig: () => ({ repos: ["AperoVN/spec"] }),
}));
vi.mock("../jira", () => ({
  getIssue: vi.fn(),
  issueContext: vi.fn(),
  jiraConfig: () => ({ projects: ["IIP707"] }),
}));

const { findMentions, normalizeMentions, resolveMentions } = await import("../mentions");
const { getContents } = await import("../gh");
const { issueContext } = await import("../jira");

describe("normalizeMentions", () => {
  it("turns a pasted GitHub blob URL into a doc tag — pasting is what people do", () => {
    const out = normalizeMentions(
      "theo https://github.com/AperoVN/spec/blob/main/docs/v1.5.md nhé",
    );
    expect(out).toContain("@doc:AperoVN/spec:docs/v1.5.md@main");
  });

  it("keeps the ref off when it is HEAD", () => {
    expect(normalizeMentions("https://github.com/a/b/blob/HEAD/x.md")).toBe("@doc:a/b:x.md");
  });

  it("survives the fragment a line link carries", () => {
    const out = normalizeMentions("https://github.com/a/b/blob/main/docs/x.md#L12-L30");
    expect(out).toBe("@doc:a/b:docs/x.md@main");
  });

  it("leaves a plain repo URL alone — it names no file", () => {
    const url = "https://github.com/AperoVN/spec";
    expect(normalizeMentions(url)).toBe(url);
  });
});

describe("findMentions", () => {
  it("finds each kind once, in order", () => {
    const found = findMentions("fix @ticket:IIP707-1 in @repo:a/b for @jira:IIP707");
    expect(found.map((m) => m.kind)).toEqual(["ticket", "repo", "jira"]);
    expect(found.map((m) => m.value)).toEqual(["IIP707-1", "a/b", "IIP707"]);
  });

  it("does not trip over punctuation that ends a sentence", () => {
    const found = findMentions("see @ticket:ABC-1, then @jira:ABC.");
    expect(found.map((m) => m.value)).toEqual(["ABC-1", "ABC"]);
  });

  it("ignores an email address, which is not a tag", () => {
    expect(findMentions("mail me at someone@example.com")).toEqual([]);
  });

  it("reports one tag once, however many times it is written", () => {
    expect(findMentions("@jira:ABC and again @jira:ABC")).toHaveLength(1);
  });
});

describe("resolveMentions", () => {
  it("reads a tagged document so the step doesn't have to", async () => {
    vi.mocked(getContents).mockResolvedValue({
      type: "file",
      path: "docs/v1.5.md",
      name: "v1.5.md",
      size: 12,
      text: "# Spec\n\nnội dung",
      truncated: false,
    } as Awaited<ReturnType<typeof getContents>>);

    const { blocks, problems } = await resolveMentions("@doc:AperoVN/spec:docs/v1.5.md");
    expect(problems).toEqual([]);
    expect(blocks[0]).toContain("nội dung");
    expect(getContents).toHaveBeenCalledWith("AperoVN/spec", "docs/v1.5.md", "");
  });

  it("says so when a document cannot be read, instead of leaving a silent gap", async () => {
    vi.mocked(getContents).mockRejectedValue(new Error("not found"));
    const { blocks, problems } = await resolveMentions("@doc:a/b:missing.md");
    expect(blocks).toEqual([]);
    expect(problems[0]).toContain("not found");
  });

  it("rejects a doc tag that names no path", async () => {
    const { problems } = await resolveMentions("@doc:justrepo");
    expect(problems[0]).toContain("expected owner/repo:path");
  });

  it("marks a truncated document as truncated", async () => {
    vi.mocked(getContents).mockResolvedValue({
      type: "file",
      path: "big.md",
      name: "big.md",
      size: 999,
      text: "…",
      truncated: true,
    } as Awaited<ReturnType<typeof getContents>>);
    const { blocks } = await resolveMentions("@doc:a/b:big.md");
    expect(blocks[0]).toContain("truncated");
  });

  it("pulls a ticket's own context in", async () => {
    vi.mocked(issueContext).mockResolvedValue("# Jira ABC-1: làm gì đó");
    const { blocks } = await resolveMentions("@ticket:ABC-1");
    expect(blocks[0]).toContain("ABC-1");
  });

  it("flags a project key that is not pinned rather than refusing it", async () => {
    const { blocks } = await resolveMentions("@jira:NOPE");
    expect(blocks[0]).toContain("not in the pinned list");
  });

  it("says nothing about a pinned project beyond how to use it", async () => {
    const { blocks } = await resolveMentions("@jira:IIP707");
    expect(blocks[0]).not.toContain("not in the pinned list");
    expect(blocks[0]).toContain("jira_create_issue");
  });

  it("does no work when there is nothing tagged", async () => {
    const { blocks, problems } = await resolveMentions("just some prose");
    expect(blocks).toEqual([]);
    expect(problems).toEqual([]);
  });
});
