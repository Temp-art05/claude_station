/**
 * Keeping the plans an agent proposed.
 *
 * Claude leaves plan mode by calling `ExitPlanMode` with the plan as markdown.
 * That call is the only place the plan exists: the approval modal renders it and
 * throws it away, and in a terminal it scrolls off. So a repo whose whole working
 * rule is *plan first, implement second* keeps no record of the plans — only of
 * the ones somebody remembered to paste into `docs/plans/`.
 *
 * This records every one of them, from both surfaces, and records the answer too.
 * A rejected plan is kept deliberately: the approach that was turned down is
 * usually the more useful half of the record, and deleting it is how a project
 * ends up relitigating the same idea twice.
 *
 * Write-side only cares about two moments — proposed, and settled — so the
 * capture surfaces need one call each and no state of their own.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { redact } from "../lib/redact";
import { setting } from "../lib/config";
import { secretValues } from "./session-ledger";
import { emit } from "./shared-memory";

export type PlanStatus = "proposed" | "accepted" | "rejected";
export type Plan = typeof schema.sessionPlans.$inferSelect;

export interface RecordPlanInput {
  projectId: string;
  sourceKind: "sdk" | "cli";
  markdown: string;
  chatSessionId?: string | null;
  claudeSessionId?: string | null;
  turnId?: string | null;
  /** The SDK approval this belongs to, so the decision can be written back. */
  requestId?: string | null;
  promptPreview?: string;
  createdAt?: string;
}

/** Same rule as the ledger's: capture off means no rows at all, not empty rows. */
function enabled(): boolean {
  return setting("ledger.enabled");
}

/**
 * Record a proposal.
 *
 * Returns the row id, or null when nothing was written — capture off, an empty
 * plan, or a duplicate. Never throws: failing to keep a plan must not fail the
 * approval the user is waiting on.
 */
export function recordPlan(input: RecordPlanInput): string | null {
  if (!enabled()) return null;
  const markdown = input.markdown?.trim();
  if (!markdown) return null;

  try {
    // A plan carries whatever the agent quoted from the repo, and that can
    // include a credential the same way a prompt can.
    const safe = redact(markdown, secretValues(), {
      entropy: setting("ledger.redactEntropy"),
    });

    if (input.requestId) {
      const existing = db
        .select({ id: schema.sessionPlans.id })
        .from(schema.sessionPlans)
        .where(eq(schema.sessionPlans.requestId, input.requestId))
        .get();
      if (existing) return existing.id;
    } else if (isDuplicate(input, safe)) {
      // A transcript is read forward and can be re-read from an earlier offset,
      // and a follower refines the same turn several times. The same plan in the
      // same turn is one plan.
      return null;
    }

    const id = newId();
    db.insert(schema.sessionPlans)
      .values({
        id,
        projectId: input.projectId,
        sourceKind: input.sourceKind,
        chatSessionId: input.chatSessionId ?? null,
        claudeSessionId: input.claudeSessionId ?? null,
        turnId: input.turnId ?? null,
        requestId: input.requestId ?? null,
        // Copied rather than joined: a plan read back months later should still
        // say what was asked, even after its turn has been deleted.
        promptPreview: input.promptPreview ?? promptOfTurn(input.turnId),
        markdown: safe,
        status: "proposed",
        createdAt: input.createdAt ?? nowIso(),
      })
      .run();

    // The bus carries the heading, not the plan: a briefing says what is being
    // worked on, and anyone who needs the steps opens the Plans view.
    emit({
      projectId: input.projectId,
      kind: "plan",
      sourceKind: input.sourceKind,
      sessionKey: input.chatSessionId ?? input.claudeSessionId ?? null,
      turnId: input.turnId ?? null,
      refId: id,
      text: `proposed: ${headingOf(safe)}`,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return id;
  } catch {
    return null;
  }
}

/** The plan's own title, or its first line when it has no heading. */
function headingOf(markdown: string): string {
  const heading = markdown.match(/^#{1,3}\s+(.+)$/m)?.[1];
  return (heading ?? markdown.split("\n").find((l) => l.trim()) ?? "a plan").trim();
}

/** What the user asked in the turn this plan came out of, if we still have it. */
function promptOfTurn(turnId: string | null | undefined): string {
  if (!turnId) return "";
  try {
    const row = db
      .select({ preview: schema.sessionTurns.promptPreview })
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.id, turnId))
      .get();
    return row?.preview ?? "";
  } catch {
    return "";
  }
}

/** Was this exact plan already recorded for this turn? */
function isDuplicate(input: RecordPlanInput, markdown: string): boolean {
  if (!input.turnId) return false;
  const row = db
    .select({ id: schema.sessionPlans.id })
    .from(schema.sessionPlans)
    .where(
      and(eq(schema.sessionPlans.turnId, input.turnId), eq(schema.sessionPlans.markdown, markdown)),
    )
    .get();
  return !!row;
}

/**
 * Write back what the user answered.
 *
 * Keyed by the approval rather than the plan id, because the approval is all the
 * resolve path knows — it never sees the tool name again.
 */
export function settlePlan(requestId: string, status: PlanStatus): void {
  try {
    const plan = db
      .select()
      .from(schema.sessionPlans)
      .where(eq(schema.sessionPlans.requestId, requestId))
      .get();
    if (!plan) return;

    db.update(schema.sessionPlans)
      .set({ status, settledAt: nowIso() })
      .where(eq(schema.sessionPlans.requestId, requestId))
      .run();

    // An accepted plan is the project's current direction; a rejected one is a
    // direction ruled out. Both are worth another session knowing.
    emit({
      projectId: plan.projectId,
      kind: status === "accepted" ? "decision" : "plan",
      sourceKind: plan.sourceKind === "cli" ? "cli" : "sdk",
      sessionKey: plan.chatSessionId ?? plan.claudeSessionId ?? null,
      turnId: plan.turnId,
      refId: plan.id,
      text: `${status}: ${headingOf(plan.markdown)}`,
    });
  } catch {
    /* best effort, like every other capture path */
  }
}

// -- reading ------------------------------------------------------------------

export function plansOf(projectId: string, limit = 100): Plan[] {
  try {
    return db
      .select()
      .from(schema.sessionPlans)
      .where(eq(schema.sessionPlans.projectId, projectId))
      .orderBy(desc(schema.sessionPlans.createdAt))
      .limit(limit)
      .all();
  } catch {
    return [];
  }
}

export function planById(id: string): Plan | null {
  try {
    return (
      db.select().from(schema.sessionPlans).where(eq(schema.sessionPlans.id, id)).get() ?? null
    );
  } catch {
    return null;
  }
}

export function deletePlan(id: string): boolean {
  try {
    const result = db.delete(schema.sessionPlans).where(eq(schema.sessionPlans.id, id)).run();
    return result.changes > 0;
  } catch {
    return false;
  }
}

/** How many plans a project has, by status — one row for the view's header. */
export function planCounts(projectId: string): Record<PlanStatus, number> {
  const empty: Record<PlanStatus, number> = { proposed: 0, accepted: 0, rejected: 0 };
  try {
    const rows = db
      .select({ status: schema.sessionPlans.status, n: sql<number>`count(*)` })
      .from(schema.sessionPlans)
      .where(eq(schema.sessionPlans.projectId, projectId))
      .groupBy(schema.sessionPlans.status)
      .all();
    for (const row of rows) {
      if (row.status in empty) empty[row.status as PlanStatus] = row.n;
    }
    return empty;
  } catch {
    return empty;
  }
}

// -- export -------------------------------------------------------------------

/**
 * A filename for a plan, derived from its first heading.
 *
 * The heading is what the author called it; a timestamp would sort well and tell
 * nobody anything. Falls back to the date only when there is no heading at all.
 */
export function planSlug(plan: Plan): string {
  const heading = plan.markdown.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? "";
  const slug = heading
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `plan-${plan.createdAt.slice(0, 10)}`;
}

/**
 * The file a plan becomes when exported: front matter that says where it came
 * from, then the plan as proposed.
 *
 * The provenance block is the point of exporting through the app rather than
 * copy-pasting — a plan in `docs/plans/` with no session behind it is the state
 * this feature exists to end.
 */
export function planDocument(plan: Plan): string {
  const lines = [
    `<!-- Proposed by ${plan.sourceKind === "sdk" ? "a Claude session" : "a terminal session"}`,
    `     on ${plan.createdAt}`,
    `     status: ${plan.status}`,
    plan.promptPreview ? `     asked: ${plan.promptPreview.replace(/-->/g, "--?")}` : null,
    `     exported from claude-station -->`,
    "",
    plan.markdown.trimEnd(),
    "",
  ].filter((line) => line !== null);
  return lines.join("\n");
}
