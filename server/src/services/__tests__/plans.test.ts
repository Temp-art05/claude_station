/**
 * Real database, temporary data dir — same setup as the ledger's own test, and
 * for the same reason: `../../db` resolves its path and migrates at import time.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "cs-plans-"));
process.env.CLAUDE_STATION_DATA = dataDir;

const { db, schema } = await import("../../db");
const plans = await import("../plans");
const { nowIso } = await import("../../lib/id");

const PROJECT = "p-plans";

const PLAN = `## Thu gọn workflow runner

- Bước 1: tách scheduler
- Bước 2: DAG
`;

beforeAll(() => {
  db.insert(schema.projects)
    .values({
      id: PROJECT,
      name: "Plans test",
      description: "",
      sortOrder: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
});

beforeEach(() => {
  db.delete(schema.sessionPlans).run();
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("recordPlan", () => {
  it("keeps the plan and starts it as proposed", () => {
    const id = plans.recordPlan({
      projectId: PROJECT,
      sourceKind: "sdk",
      markdown: PLAN,
      requestId: "req-1",
    });
    expect(id).toBeTruthy();
    const row = plans.plansOf(PROJECT)[0]!;
    expect(row.status).toBe("proposed");
    expect(row.markdown).toContain("tách scheduler");
  });

  it("answers with the same row when one approval asks twice", () => {
    const first = plans.recordPlan({
      projectId: PROJECT,
      sourceKind: "sdk",
      markdown: PLAN,
      requestId: "req-2",
    });
    const second = plans.recordPlan({
      projectId: PROJECT,
      sourceKind: "sdk",
      markdown: PLAN,
      requestId: "req-2",
    });
    expect(second).toBe(first);
    expect(plans.plansOf(PROJECT)).toHaveLength(1);
  });

  it("does not record the same plan twice in one turn", () => {
    // A transcript is re-read from an earlier offset and a follower refines the
    // same turn repeatedly; the same plan in the same turn is one plan.
    const input = {
      projectId: PROJECT,
      sourceKind: "cli" as const,
      markdown: PLAN,
      turnId: "turn-1",
    };
    plans.recordPlan(input);
    plans.recordPlan(input);
    expect(plans.plansOf(PROJECT)).toHaveLength(1);
  });

  it("records a second, different plan in the same turn", () => {
    const base = { projectId: PROJECT, sourceKind: "cli" as const, turnId: "turn-2" };
    plans.recordPlan({ ...base, markdown: PLAN });
    plans.recordPlan({ ...base, markdown: `${PLAN}\n- Bước 3: gate` });
    expect(plans.plansOf(PROJECT)).toHaveLength(2);
  });

  it("scrubs a credential the plan quoted", () => {
    plans.recordPlan({
      projectId: PROJECT,
      sourceKind: "sdk",
      markdown: "Dùng ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 để push",
      requestId: "req-3",
    });
    expect(plans.plansOf(PROJECT)[0]!.markdown).not.toContain("ghp_ABCDEFGH");
  });

  it("writes nothing for an empty plan", () => {
    expect(plans.recordPlan({ projectId: PROJECT, sourceKind: "sdk", markdown: "  " })).toBeNull();
    expect(plans.plansOf(PROJECT)).toHaveLength(0);
  });
});

describe("settlePlan", () => {
  it("writes back what the user answered", () => {
    plans.recordPlan({
      projectId: PROJECT,
      sourceKind: "sdk",
      markdown: PLAN,
      requestId: "req-4",
    });
    plans.settlePlan("req-4", "accepted");
    const row = plans.plansOf(PROJECT)[0]!;
    expect(row.status).toBe("accepted");
    expect(row.settledAt).toBeTruthy();
  });

  it("keeps a rejected plan rather than dropping it", () => {
    plans.recordPlan({
      projectId: PROJECT,
      sourceKind: "sdk",
      markdown: PLAN,
      requestId: "req-5",
    });
    plans.settlePlan("req-5", "rejected");
    expect(plans.plansOf(PROJECT)[0]!.status).toBe("rejected");
    expect(plans.planCounts(PROJECT).rejected).toBe(1);
  });

  it("does nothing for an approval that was not a plan", () => {
    expect(() => plans.settlePlan("req-not-a-plan", "accepted")).not.toThrow();
  });
});

describe("export shape", () => {
  it("names the file after the plan's own heading", () => {
    plans.recordPlan({
      projectId: PROJECT,
      sourceKind: "sdk",
      markdown: PLAN,
      requestId: "req-6",
    });
    expect(plans.planSlug(plans.plansOf(PROJECT)[0]!)).toBe("thu-gon-workflow-runner");
  });

  it("falls back to the date when the plan has no heading", () => {
    plans.recordPlan({
      projectId: PROJECT,
      sourceKind: "sdk",
      markdown: "just do the thing",
      requestId: "req-7",
      createdAt: "2026-09-15T10:00:00.000Z",
    });
    expect(plans.planSlug(plans.plansOf(PROJECT)[0]!)).toBe("plan-2026-09-15");
  });

  it("puts the provenance in the file, which is the point of exporting", () => {
    plans.recordPlan({
      projectId: PROJECT,
      sourceKind: "cli",
      markdown: PLAN,
      requestId: "req-8",
      promptPreview: "gộp bớt step đi",
    });
    const doc = plans.planDocument(plans.plansOf(PROJECT)[0]!);
    expect(doc).toContain("terminal session");
    expect(doc).toContain("gộp bớt step đi");
    expect(doc).toContain("tách scheduler");
  });
});
