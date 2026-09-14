/**
 * The ledger has to switch off cleanly: no rows, no partial state, and callers
 * needing no extra branch. Its own file because the settings module is mocked,
 * and a mock applies to the whole file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-ledger-off-"));
process.env.CLAUDE_STATION_DATA = dataDir;

vi.mock("../../lib/config", () => ({
  setting: (key: string) => (key === "ledger.enabled" ? false : 24),
}));

const { db, schema } = await import("../../db");
const ledger = await import("../session-ledger");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("ledger.enabled = false", () => {
  it("records no turn and reports it by returning null", () => {
    const id = ledger.openTurn({
      projectId: "p-off",
      sourceKind: "sdk",
      cwd: "/tmp/off",
      prompt: "should not be stored",
    });
    expect(id).toBeNull();
    expect(db.select().from(schema.sessionTurns).all()).toEqual([]);
  });

  it("lets a caller pass that null straight back in without branching", () => {
    const id = ledger.openTurn({ projectId: "p-off", sourceKind: "sdk", cwd: "/tmp/off" });
    expect(() => {
      ledger.recordFiles(id, [{ absPath: "/tmp/off/a.ts", op: "write", source: "tree" }]);
      ledger.bumpToolCalls(id);
      ledger.closeTurn(id, { status: "done" });
    }).not.toThrow();
    expect(db.select().from(schema.sessionFiles).all()).toEqual([]);
  });

  it("still answers reads, with nothing", () => {
    expect(ledger.turnsOf({ claudeSessionId: "whatever" })).toEqual([]);
    expect(ledger.turnsTouching("p-off", "/tmp/off/a.ts")).toEqual([]);
    expect(ledger.turnsRunningAt(["/tmp/off"], new Date().toISOString())).toEqual([]);
  });
});
