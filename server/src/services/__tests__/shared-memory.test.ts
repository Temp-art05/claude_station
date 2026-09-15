/**
 * Real database, temporary data dir — `../../db` migrates at import time.
 *
 * What is actually under test is the cursor: that a session is told everything
 * once, told the difference afterwards, and told nothing when there is no
 * difference. Everything else on the bus is bookkeeping around that.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-bus-"));
process.env.CLAUDE_STATION_DATA = dataDir;

const { db, schema } = await import("../../db");
const bus = await import("../shared-memory");
const { nowIso } = await import("../../lib/id");

const PROJECT = "p-bus";
const OTHER = "p-bus-other";

beforeAll(() => {
  for (const id of [PROJECT, OTHER]) {
    db.insert(schema.projects)
      .values({
        id,
        name: id,
        description: "",
        sortOrder: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
  }
});

beforeEach(() => {
  db.delete(schema.sessionMemoryEvents).run();
  db.delete(schema.sessionMemoryCursors).run();
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function say(text: string, sessionKey = "s-writer", projectId = PROJECT) {
  return bus.emit({ projectId, kind: "decision", sourceKind: "sdk", sessionKey, text });
}

describe("the log", () => {
  it("numbers events per project, from one", () => {
    expect(say("dùng patch-id để nối lại checkpoint")).toBe(1);
    expect(say("cache-read tính theo giá riêng")).toBe(2);
    expect(say("ghi ledger trước khi render", "s-writer", OTHER)).toBe(1);
  });

  it("refuses the same thing said twice in a row", () => {
    expect(say("chốt dùng FTS5 trước, vector sau")).toBe(1);
    expect(say("chốt dùng FTS5 trước, vector sau")).toBeNull();
  });

  it("collapses an event to one line", () => {
    bus.emit({
      projectId: PROJECT,
      kind: "fact",
      sourceKind: "sdk",
      text: "dòng một\n\n   dòng hai",
    });
    expect(bus.eventsOf(PROJECT)[0]!.text).toBe("dòng một dòng hai");
  });

  it("scrubs a credential before it reaches the log", () => {
    bus.emit({
      projectId: PROJECT,
      kind: "fact",
      sourceKind: "sdk",
      text: "token là ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    });
    expect(bus.eventsOf(PROJECT)[0]!.text).not.toContain("ghp_ABCDEFGH");
  });
});

describe("the cursor", () => {
  it("hands a new session the state, then nothing", () => {
    say("chốt worktree riêng cho mỗi step song song");
    const first = bus.promptBlock(PROJECT, "s-reader");
    expect(first).toContain("worktree riêng");
    expect(first).toContain("What other sessions");
    // Nothing has happened since, so the second turn carries no block at all —
    // not an empty heading, not "nothing new".
    expect(bus.promptBlock(PROJECT, "s-reader")).toBe("");
  });

  it("hands only the difference on later turns", () => {
    say("quyết định A");
    bus.promptBlock(PROJECT, "s-reader");
    say("quyết định B");
    const delta = bus.promptBlock(PROJECT, "s-reader");
    expect(delta).toContain("quyết định B");
    expect(delta).not.toContain("quyết định A");
    expect(delta).toContain("New since");
  });

  it("never hands a session its own writing back", () => {
    say("tôi tự nói câu này", "s-self");
    bus.promptBlock(PROJECT, "s-other"); // s-other inherits the state
    say("người khác nói câu này", "s-third");
    expect(bus.promptBlock(PROJECT, "s-self")).not.toContain("tôi tự nói");
  });

  it("says nothing at all when the project's log is empty", () => {
    expect(bus.promptBlock(PROJECT, "s-reader")).toBe("");
  });

  it("says nothing without a session key — a preview must not move a cursor", () => {
    say("có sự kiện");
    expect(bus.promptBlock(PROJECT, null)).toBe("");
  });

  it("keeps one project's log out of another's block", () => {
    say("chỉ thuộc project khác", "s-writer", OTHER);
    expect(bus.promptBlock(PROJECT, "s-reader")).toBe("");
  });
});

describe("marked claims", () => {
  it("takes only lines the agent marked on purpose", () => {
    const claims = bus.markedClaims(
      [
        "Tao sẽ sửa scheduler trước rồi mới đụng tới storage.",
        "**Quyết định:** giữ SQLite, không đổi sang Postgres",
        "Gotcha: transcript CLI không mang cost, phải tự tính",
        "Cái này chắc cũng quan trọng nhưng không có marker.",
      ].join("\n"),
    );
    expect(claims).toEqual([
      { kind: "decision", text: "giữ SQLite, không đổi sang Postgres" },
      { kind: "fact", text: "transcript CLI không mang cost, phải tự tính" },
    ]);
  });

  it("reads a marker through a bullet or a blockquote", () => {
    expect(bus.markedClaims("- Decision: ship behind a flag")[0]?.kind).toBe("decision");
    expect(bus.markedClaims("> Why: the watcher fires twice")[0]?.kind).toBe("fact");
  });

  it("finds nothing in ordinary prose, which is the whole point", () => {
    const prose =
      "I decided that this approach works better because the watcher already " +
      "sees the refs. Note that it runs after listen.";
    // "decided that" and "Note that" are not markers: a marker is a label at the
    // start of a line followed by a colon. Widening this fills the log with noise.
    expect(bus.markedClaims(prose)).toEqual([]);
  });

  it("caps one message so it cannot become a notebook", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Decision: điều thứ ${i} cần nhớ`).join("\n");
    expect(bus.markedClaims(many).length).toBeLessThanOrEqual(8);
  });
});

describe("state", () => {
  it("folds the log into the current picture", () => {
    bus.emit({ projectId: PROJECT, kind: "plan", sourceKind: "sdk", text: "proposed: gộp step" });
    say("chốt gộp bảy job");
    bus.emit({ projectId: PROJECT, kind: "failure", sourceKind: "cli", text: "build iOS gãy" });
    const state = bus.stateOf(PROJECT);
    expect(state.plan?.text).toContain("gộp step");
    expect(state.decisions[0]!.text).toContain("bảy job");
    expect(state.failures[0]!.text).toContain("build iOS");
    expect(state.lastSeq).toBe(3);
  });
});
