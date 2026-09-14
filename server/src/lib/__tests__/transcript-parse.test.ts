import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addUsage,
  emptyUsage,
  isRealPrompt,
  parseRecords,
  promptText,
  readAppended,
} from "../transcript-parse";

const dir = mkdtempSync(join(tmpdir(), "cs-tp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const jsonl = (...records: unknown[]): string =>
  records.map((r) => JSON.stringify(r)).join("\n") + "\n";

const userText = (text: string, over: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: "2026-09-03T10:00:00.000Z",
  cwd: "/repo",
  gitBranch: "main",
  message: { role: "user", content: text },
  ...over,
});

const toolResult = () => ({
  type: "user",
  timestamp: "2026-09-03T10:00:05.000Z",
  cwd: "/repo",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
  },
});

const assistant = (over: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: "2026-09-03T10:00:10.000Z",
  cwd: "/repo",
  gitBranch: "main",
  message: {
    role: "assistant",
    model: "claude-opus-5",
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 40,
    },
    content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/a.ts" } }],
  },
  ...over,
});

describe("isRealPrompt", () => {
  it("accepts string content", () => {
    expect(isRealPrompt("do the thing")).toBe(true);
  });

  it("accepts text blocks", () => {
    expect(isRealPrompt([{ type: "text", text: "hello" }])).toBe(true);
  });

  it("rejects a tool result, which arrives as a user record too", () => {
    expect(isRealPrompt([{ type: "tool_result", content: "ok" }])).toBe(false);
  });

  it("rejects a tool result even when text rides alongside it", () => {
    expect(
      isRealPrompt([
        { type: "tool_result", content: "ok" },
        { type: "text", text: "and more" },
      ]),
    ).toBe(false);
  });

  it("rejects empty, blank and unexpected shapes", () => {
    expect(isRealPrompt("")).toBe(false);
    expect(isRealPrompt("   ")).toBe(false);
    expect(isRealPrompt([])).toBe(false);
    expect(isRealPrompt(null)).toBe(false);
    expect(isRealPrompt({ type: "text" })).toBe(false);
    expect(isRealPrompt([{ type: "image" }])).toBe(false);
  });
});

describe("promptText", () => {
  it("returns string content as it is", () => {
    expect(promptText("hi")).toBe("hi");
  });

  it("joins text blocks and ignores the rest", () => {
    expect(
      promptText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
    ).toBe("a\nb");
  });

  it("is empty for content it cannot read", () => {
    expect(promptText(null)).toBe("");
  });
});

describe("parseRecords", () => {
  it("emits a prompt for a real user message", () => {
    const { events } = parseRecords(jsonl(userText("fix the toggle")));
    expect(events).toEqual([
      {
        kind: "prompt",
        at: "2026-09-03T10:00:00.000Z",
        text: "fix the toggle",
        cwd: "/repo",
        gitBranch: "main",
      },
    ]);
  });

  it("emits nothing for a tool result", () => {
    expect(parseRecords(jsonl(toolResult())).events).toEqual([]);
  });

  it("emits activity with usage, model and tool calls", () => {
    const { events } = parseRecords(jsonl(assistant()));
    expect(events).toHaveLength(1);
    const activity = events[0]!;
    expect(activity.kind).toBe("activity");
    if (activity.kind !== "activity") return;
    expect(activity.model).toBe("claude-opus-5");
    expect(activity.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheCreateTokens: 40,
    });
    expect(activity.tools).toEqual([
      { name: "Edit", input: { file_path: "/repo/a.ts" }, sidechain: false },
    ]);
  });

  it("marks a subagent's activity as sidechain but keeps it", () => {
    // A subagent's edits are real edits; they belong to the parent's turn.
    const { events } = parseRecords(jsonl(assistant({ isSidechain: true })));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind === "activity" && events[0]!.sidechain).toBe(true);
  });

  it("drops a subagent's own prompt, which would start a turn that never happened", () => {
    expect(parseRecords(jsonl(userText("sub prompt", { isSidechain: true }))).events).toEqual([]);
  });

  it("ignores the CLI's own bookkeeping records", () => {
    const noise = jsonl(
      { type: "ai-title", aiTitle: "Something" },
      { type: "queue-operation", operation: "enqueue", content: "queued prompt" },
      { type: "file-history-snapshot", snapshot: {} },
      { type: "file-history-delta", trackingPath: "a.ts" },
      { type: "mode", mode: "default" },
      { type: "system", subtype: "info" },
    );
    expect(parseRecords(noise).events).toEqual([]);
  });

  it("holds back a half-written last line instead of parsing it", () => {
    const text = jsonl(userText("complete")) + '{"type":"assistant","mess';
    const { events, leftover, badLines } = parseRecords(text);
    expect(events).toHaveLength(1);
    expect(leftover).toBe('{"type":"assistant","mess');
    expect(badLines).toBe(0);
  });

  it("counts a complete line that will not parse, and carries on", () => {
    const { events, badLines } = parseRecords("{not json}\n" + jsonl(userText("after")));
    expect(badLines).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("tolerates missing usage and missing timestamps", () => {
    const { events } = parseRecords(
      jsonl({ type: "assistant", message: { role: "assistant", content: [] } }),
    );
    const activity = events[0]!;
    if (activity.kind !== "activity") throw new Error("expected activity");
    expect(activity.usage).toEqual(emptyUsage());
    expect(activity.at).toBeNull();
    expect(activity.model).toBeNull();
  });

  it("keeps prompts and activity in file order", () => {
    const { events } = parseRecords(
      jsonl(userText("one"), assistant(), toolResult(), userText("two")),
    );
    expect(events.map((e) => e.kind)).toEqual(["prompt", "activity", "prompt"]);
  });
});

describe("addUsage", () => {
  it("sums every counter", () => {
    expect(
      addUsage(
        { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreateTokens: 4 },
        { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreateTokens: 40 },
      ),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreateTokens: 44,
    });
  });
});

describe("readAppended", () => {
  it("reads from the offset and reports the new size", () => {
    const file = join(dir, "a.jsonl");
    writeFileSync(file, jsonl(userText("first")));
    const first = readAppended(file, 0)!;
    expect(first.text).toContain("first");
    expect(first.rewound).toBe(false);

    appendFileSync(file, jsonl(userText("second")));
    const second = readAppended(file, first.size)!;
    // Only the appended part, which is what makes following a 29MB file cheap.
    expect(second.text).toContain("second");
    expect(second.text).not.toContain("first");
  });

  it("returns empty text when nothing was appended", () => {
    const file = join(dir, "b.jsonl");
    writeFileSync(file, jsonl(userText("only")));
    const { size } = readAppended(file, 0)!;
    expect(readAppended(file, size)!.text).toBe("");
  });

  it("reports a rewind when the file got shorter, and rereads from zero", () => {
    // The CLI prunes and reuses ids: continuing from a stale offset would read
    // the middle of a different conversation.
    const file = join(dir, "c.jsonl");
    writeFileSync(file, jsonl(userText("long".repeat(50))));
    writeFileSync(file, jsonl(userText("short")));
    const result = readAppended(file, 10_000)!;
    expect(result.rewound).toBe(true);
    expect(result.text).toContain("short");
  });

  it("returns null for a file that is not there", () => {
    expect(readAppended(join(dir, "missing.jsonl"), 0)).toBeNull();
  });

  it("reads a file larger than one chunk in full", () => {
    const file = join(dir, "big.jsonl");
    const many = Array.from({ length: 4000 }, (_, i) => userText(`m${i} ${"x".repeat(300)}`));
    writeFileSync(file, jsonl(...many));
    const { text, size } = readAppended(file, 0)!;
    expect(size).toBeGreaterThan(1 << 20);
    expect(parseRecords(text).events).toHaveLength(4000);
  });
});
