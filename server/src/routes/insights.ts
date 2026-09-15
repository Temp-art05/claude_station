/**
 * Mission control: what the agents consumed, and whether the record can be trusted.
 *
 * Everything here is a read over the session ledger — no new capture, no new
 * table. The folding stays on this side on purpose: a month of turns is tens of
 * thousands of rows, and the browser only ever needs the buckets.
 *
 * Two honesty rules the shapes below exist to keep:
 *   - A cost the SDK reported and a cost we derived from a price table are not
 *     the same claim, so every total carries how much of it was estimated.
 *   - Capture health travels with the numbers rather than living on another page.
 *     A dashboard that quietly lost its input looks exactly like a quiet week.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema, sqlite } from "../db";
import { captureHealth } from "../services/session-ledger";
import { priceTable } from "../services/model-pricing";

const querySchema = z.object({
  /** Window in days, counted back from now. */
  days: z.coerce.number().int().min(1).max(365).default(30),
  projectId: z.string().optional(),
});

/** Start of the window, as the ISO string the ledger stores. */
function since(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Summed columns every grouping needs.
 *
 * `costUsd` is summed across both kinds of number deliberately — it is the figure
 * people want — while `estimatedCost` carries how much of it was derived, so the
 * UI can mark a total rather than a row.
 */
const totals = {
  turns: sql<number>`count(*)`,
  inputTokens: sql<number>`coalesce(sum(${schema.sessionTurns.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${schema.sessionTurns.outputTokens}), 0)`,
  cacheReadTokens: sql<number>`coalesce(sum(${schema.sessionTurns.cacheReadTokens}), 0)`,
  cacheCreateTokens: sql<number>`coalesce(sum(${schema.sessionTurns.cacheCreateTokens}), 0)`,
  costUsd: sql<number>`coalesce(sum(${schema.sessionTurns.costUsd}), 0)`,
  estimatedCost: sql<number>`coalesce(sum(case when ${schema.sessionTurns.costSource} = 'estimated' then ${schema.sessionTurns.costUsd} else 0 end), 0)`,
  unpricedTurns: sql<number>`coalesce(sum(case when ${schema.sessionTurns.costSource} = 'unknown' then 1 else 0 end), 0)`,
  linesAdded: sql<number>`coalesce(sum(${schema.sessionTurns.linesAdded}), 0)`,
  linesRemoved: sql<number>`coalesce(sum(${schema.sessionTurns.linesRemoved}), 0)`,
  toolCalls: sql<number>`coalesce(sum(${schema.sessionTurns.toolCallCount}), 0)`,
  // Coalesced like every other sum here: over an empty window SQLite's `sum`
  // answers NULL, and a dashboard that renders "null turns" is worse than one
  // that renders zero.
  errors: sql<number>`coalesce(sum(case when ${schema.sessionTurns.status} in ('error', 'interrupted') then 1 else 0 end), 0)`,
};

export function insightsRoutes(app: FastifyInstance): void {
  /**
   * One call, the whole dashboard. Six groupings of the same window rather than
   * six endpoints, because they are always drawn together and a client that
   * fetched them separately could render a total that disagrees with its own
   * breakdown as turns land between requests.
   */
  app.get("/api/insights/usage", async (req) => {
    const { days, projectId } = querySchema.parse(req.query);
    const from = since(days);
    const window = projectId
      ? and(gte(schema.sessionTurns.startedAt, from), eq(schema.sessionTurns.projectId, projectId))
      : gte(schema.sessionTurns.startedAt, from);

    const summary = db.select(totals).from(schema.sessionTurns).where(window).get();

    // `substr(startedAt, 1, 10)` is the date part of an ISO string. Stored UTC,
    // bucketed UTC — a local-day bucket would need a timezone the server does not
    // know, and the alternative (guessing one) moves every number by a day for
    // whoever is not in it.
    const daily = db
      .select({ day: sql<string>`substr(${schema.sessionTurns.startedAt}, 1, 10)`, ...totals })
      .from(schema.sessionTurns)
      .where(window)
      .groupBy(sql`1`)
      .orderBy(sql`1`)
      .all();

    const byProject = db
      .select({
        projectId: schema.sessionTurns.projectId,
        name: schema.projects.name,
        ...totals,
      })
      .from(schema.sessionTurns)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.sessionTurns.projectId))
      .where(window)
      .groupBy(schema.sessionTurns.projectId)
      .orderBy(desc(sql`coalesce(sum(${schema.sessionTurns.costUsd}), 0)`))
      .all();

    const byModel = db
      .select({
        model: sql<string>`coalesce(${schema.sessionTurns.model}, 'unknown')`,
        ...totals,
      })
      .from(schema.sessionTurns)
      .where(window)
      .groupBy(sql`1`)
      .orderBy(desc(sql`count(*)`))
      .all();

    const bySource = db
      .select({ sourceKind: schema.sessionTurns.sourceKind, ...totals })
      .from(schema.sessionTurns)
      .where(window)
      .groupBy(schema.sessionTurns.sourceKind)
      .all();

    // The most expensive turns, not the most recent: a list of recent turns is
    // what the History tab already is. What a consumption screen is asked is
    // "where did it go", and the answer is a handful of rows.
    const top = db
      .select({
        id: schema.sessionTurns.id,
        projectId: schema.sessionTurns.projectId,
        projectName: schema.projects.name,
        sourceKind: schema.sessionTurns.sourceKind,
        model: schema.sessionTurns.model,
        promptPreview: schema.sessionTurns.promptPreview,
        costUsd: schema.sessionTurns.costUsd,
        costSource: schema.sessionTurns.costSource,
        inputTokens: schema.sessionTurns.inputTokens,
        outputTokens: schema.sessionTurns.outputTokens,
        cacheReadTokens: schema.sessionTurns.cacheReadTokens,
        linesAdded: schema.sessionTurns.linesAdded,
        linesRemoved: schema.sessionTurns.linesRemoved,
        toolCallCount: schema.sessionTurns.toolCallCount,
        status: schema.sessionTurns.status,
        startedAt: schema.sessionTurns.startedAt,
        endedAt: schema.sessionTurns.endedAt,
      })
      .from(schema.sessionTurns)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.sessionTurns.projectId))
      .where(window)
      .orderBy(desc(sql`coalesce(${schema.sessionTurns.costUsd}, 0)`))
      .limit(20)
      .all();

    const table = priceTable();

    return {
      window: { days, from },
      totals: summary ?? null,
      daily,
      byProject,
      byModel,
      bySource,
      top,
      capture: captureHealth(),
      pricing: table
        ? { fetchedAt: table.fetchedAt, models: Object.keys(table.models).length }
        : null,
    };
  });

  /**
   * Files the window touched, grouped by extension.
   *
   * Extension only — never a path. What this answers is "what kind of work was
   * this", and a path in an aggregate is a leak waiting to be screenshotted.
   *
   * Raw SQL because the extension has to be cut out in SQLite, which has no "last
   * index of": `rtrim(p, replace(p, '.', ''))` strips every trailing character
   * that is not a dot, leaving the path up to and including its last one, and
   * removing that prefix leaves the extension. A path whose only dot sits in a
   * directory name yields a fragment with a slash in it — binned as `(none)`
   * rather than returned, which is also what keeps this from leaking a path.
   */
  app.get("/api/insights/files", async (req) => {
    const { days, projectId } = querySchema.parse(req.query);
    const from = since(days);

    const rows = sqlite
      .prepare(
        `SELECT CASE
                  WHEN instr(raw_ext, '/') > 0 OR length(raw_ext) > 12 THEN '(none)'
                  ELSE raw_ext
                END AS ext,
                count(DISTINCT abs_path) AS files,
                sum(CASE WHEN op = 'read' THEN 1 ELSE 0 END) AS reads,
                sum(CASE WHEN op = 'read' THEN 0 ELSE 1 END) AS writes
           FROM (
             SELECT f.abs_path AS abs_path,
                    f.op       AS op,
                    CASE
                      WHEN instr(f.rel_path, '.') = 0 THEN '(none)'
                      ELSE lower(replace(f.rel_path,
                                         rtrim(f.rel_path, replace(f.rel_path, '.', '')),
                                         ''))
                    END AS raw_ext
               FROM session_files f
               JOIN session_turns t ON t.id = f.turn_id
              WHERE t.started_at >= ?
                AND (? IS NULL OR f.project_id = ?)
           )
          GROUP BY 1
          ORDER BY files DESC
          LIMIT 15`,
      )
      .all(from, projectId ?? null, projectId ?? null);

    return { window: { days, from }, byExtension: rows };
  });
}
