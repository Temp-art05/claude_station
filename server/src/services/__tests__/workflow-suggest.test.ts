/**
 * C6 — the sequence-finding, which is the whole of the idea.
 *
 * Both functions under test are pure, so this needs no database: what matters is
 * that "these commands ran together, repeatedly" is decided the way a person
 * would decide it, and that a one-off never looks like a habit.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Temp data dir before the import, even though nothing here touches the
 * database: `workflow-suggest` imports `../db`, which resolves the data
 * directory and migrates it at import time. Without this, running the tests
 * migrates the developer's own `data/claude-station.db`.
 */
process.env.CLAUDE_STATION_DATA = mkdtempSync(join(tmpdir(), "cs-suggest-"));

const { intoSittings, sequenceOf } = await import("../workflow-suggest");

const T0 = Date.parse("2026-09-15T09:00:00.000Z");
/** `minutes` after the fixed start, as the ISO string the table stores. */
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const run = (name: string, minutes: number, exitCode = 0) => ({
  name,
  cwd: "/repo",
  exitCode,
  startedAt: at(minutes),
});

describe("intoSittings", () => {
  it("splits on a long gap, because two runs an hour apart are two pieces of work", () => {
    const sittings = intoSittings([
      run("build", 0),
      run("test", 2),
      run("build", 90),
      run("test", 92),
    ]);
    expect(sittings).toHaveLength(2);
    expect(sittings[0]!.map((r) => r.name)).toEqual(["build", "test"]);
  });

  it("keeps a slow sitting together as long as nothing exceeds the gap", () => {
    // 19 minutes between each: still one sitting, because each step follows the
    // last within the window — a long build is not a new train of thought.
    const sittings = intoSittings([run("build", 0), run("test", 19), run("deploy", 38)]);
    expect(sittings).toHaveLength(1);
  });

  it("answers with nothing for no runs", () => {
    expect(intoSittings([])).toEqual([]);
  });
});

describe("sequenceOf", () => {
  it("folds an immediate repeat — running the tests four times is one step", () => {
    expect(
      sequenceOf([run("build", 0), run("test", 1), run("test", 3), run("test", 5), run("lint", 6)]),
    ).toEqual(["build", "test", "lint"]);
  });

  it("keeps a repeat that is not immediate, because the order is the point", () => {
    expect(sequenceOf([run("test", 0), run("build", 1), run("test", 2)])).toEqual([
      "test",
      "build",
      "test",
    ]);
  });

  it("caps a sitting that turned into a whole day", () => {
    const long = Array.from({ length: 20 }, (_, i) => run(`cmd${i}`, i));
    expect(sequenceOf(long)).toHaveLength(8);
  });
});
