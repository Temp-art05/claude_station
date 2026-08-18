import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTranscripts, transcriptsUnder } from "../claude-transcript";

const uuid = (n: number) => `0000000${n}-1111-2222-3333-444444444444`;

let root: string;

/** A transcript the way the CLI writes one: JSONL, cwd on a record a few lines in. */
function write(dir: string, name: string, lines: unknown[]): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cs-transcripts-"));

  // The ordinary shape: cwd within the first few records, a title, a branch.
  write("-repo-a", `${uuid(1)}.jsonl`, [
    { type: "mode", mode: "normal" },
    { type: "user", cwd: "/repo/a", gitBranch: "main", message: { content: "hello" } },
    { type: "ai-title", aiTitle: "First title" },
    { type: "assistant", cwd: "/repo/a", gitBranch: "feature/x" },
    { type: "ai-title", aiTitle: "Latest title" },
  ]);

  // A first message big enough to push cwd past the head window: only the tail has it.
  write("-repo-a", `${uuid(2)}.jsonl`, [
    { type: "user", message: { content: [{ type: "text", text: "x".repeat(20000) }] } },
    { type: "assistant", cwd: "/repo/a/server", gitBranch: "main" },
  ]);

  // No title yet — the picker falls back to what the user said first.
  write("-repo-b", `${uuid(3)}.jsonl`, [
    { type: "user", cwd: "/repo/b", message: { content: [{ type: "text", text: "fix the  build" }] } },
  ]);

  // Subagent transcripts are part of a conversation, not one of their own.
  write(join("-repo-a", uuid(1), "subagents"), `${uuid(4)}.jsonl`, [
    { type: "user", cwd: "/repo/a" },
  ]);

  // Not a transcript at all.
  write("-repo-a", "notes.txt", [{ type: "user", cwd: "/repo/a" }]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("listTranscripts", () => {
  it("finds one entry per conversation and ignores everything else", () => {
    const ids = listTranscripts(root).map((t) => t.sessionId);
    expect(ids).toHaveLength(3);
    expect(ids).toContain(uuid(1));
    // A subagent file and a non-uuid file are not conversations.
    expect(ids).not.toContain(uuid(4));
  });

  it("takes the last title and branch, not the first — both change mid-conversation", () => {
    const t = listTranscripts(root).find((x) => x.sessionId === uuid(1));
    expect(t?.title).toBe("Latest title");
    expect(t?.gitBranch).toBe("feature/x");
  });

  it("still finds cwd when a pasted first message pushes it out of the head window", () => {
    const t = listTranscripts(root).find((x) => x.sessionId === uuid(2));
    expect(t?.cwd).toBe("/repo/a/server");
  });

  it("falls back to the first user text when the CLI never titled it", () => {
    const t = listTranscripts(root).find((x) => x.sessionId === uuid(3));
    expect(t?.title).toBe("fix the build");
  });

  it("reports a size and a last-written time", () => {
    const t = listTranscripts(root)[0]!;
    expect(t.sizeBytes).toBeGreaterThan(0);
    expect(Date.parse(t.modifiedAt)).not.toBeNaN();
  });
});

describe("transcriptsUnder", () => {
  it("matches a directory and anything below it", () => {
    const ids = transcriptsUnder(["/repo/a"], root).map((t) => t.sessionId);
    expect(ids).toContain(uuid(1));
    expect(ids).toContain(uuid(2)); // ran in /repo/a/server
    expect(ids).not.toContain(uuid(3));
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(transcriptsUnder(["/repo/a-other"], root)).toHaveLength(0);
  });

  it("takes every path of a project", () => {
    expect(transcriptsUnder(["/repo/a", "/repo/b"], root)).toHaveLength(3);
  });

  it("returns nothing for a project with no paths", () => {
    expect(transcriptsUnder([], root)).toHaveLength(0);
  });
});
