/**
 * Reading back the plans an agent proposed, and turning one into a file.
 *
 * There is no POST that records a plan: capture belongs to the two surfaces that
 * see `ExitPlanMode` go past (`claude-session.ts`, `transcript-follower.ts`), and
 * a client that could write one would make the record something other than what
 * actually happened.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";
import { assertPathAllowed, badRequest, conflict } from "../lib/path-safety";
import {
  deletePlan,
  planById,
  planCounts,
  planDocument,
  plansOf,
  planSlug,
} from "../services/plans";

const idParam = z.object({ id: z.string() });
const planParam = z.object({ planId: z.string() });

const exportBody = z.object({
  /**
   * Which repo of the project to write into. A project can have several, and the
   * plan itself does not know which one it was about.
   */
  projectPathId: z.string(),
  /** Relative to the repo root. Defaults to `docs/plans/<slug>.md`. */
  relPath: z.string().optional(),
  /** Refuse rather than overwrite, unless the caller has seen the clash. */
  overwrite: z.boolean().default(false),
});

/** A list row: everything but the markdown, which is only worth sending once. */
function toRow(plan: ReturnType<typeof plansOf>[number]) {
  return {
    id: plan.id,
    projectId: plan.projectId,
    sourceKind: plan.sourceKind,
    chatSessionId: plan.chatSessionId,
    claudeSessionId: plan.claudeSessionId,
    turnId: plan.turnId,
    promptPreview: plan.promptPreview,
    status: plan.status,
    createdAt: plan.createdAt,
    settledAt: plan.settledAt,
    /** Enough to recognise it in a list without shipping the whole document. */
    heading: plan.markdown.match(/^#{1,3}\s+(.+)$/m)?.[1]?.slice(0, 120) ?? "",
    lines: plan.markdown.split("\n").length,
    bytes: plan.markdown.length,
  };
}

export function planRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/plans", async (req) => {
    const { id } = idParam.parse(req.params);
    return { plans: plansOf(id).map(toRow), counts: planCounts(id) };
  });

  app.get<{ Params: { planId: string } }>("/api/plans/:planId", async (req, reply) => {
    const { planId } = planParam.parse(req.params);
    const plan = planById(planId);
    if (!plan) return reply.code(404).send({ error: "No such plan" });
    return {
      ...toRow(plan),
      markdown: plan.markdown,
      suggestedPath: `docs/plans/${planSlug(plan)}.md`,
    };
  });

  app.delete<{ Params: { planId: string } }>("/api/plans/:planId", async (req, reply) => {
    const { planId } = planParam.parse(req.params);
    if (!deletePlan(planId)) return reply.code(404).send({ error: "No such plan" });
    return reply.code(204).send();
  });

  /**
   * Write a plan into a repo as markdown.
   *
   * This is the only place the app writes into someone's working tree on its own
   * initiative, so it is bounded on every side: a path under a configured repo of
   * this project (checked by `assertPathAllowed`, which is what stops `../`), a
   * `.md` file, and never over an existing file unless asked twice.
   */
  app.post<{ Params: { planId: string } }>("/api/plans/:planId/export", async (req, reply) => {
    const { planId } = planParam.parse(req.params);
    const body = exportBody.parse(req.body ?? {});
    const plan = planById(planId);
    if (!plan) return reply.code(404).send({ error: "No such plan" });

    const repo = db
      .select()
      .from(schema.projectPaths)
      .where(eq(schema.projectPaths.id, body.projectPathId))
      .get();
    if (!repo || repo.projectId !== plan.projectId) {
      throw badRequest("That repo does not belong to this plan's project");
    }

    const relPath = (body.relPath ?? `docs/plans/${planSlug(plan)}.md`).replace(/^\/+/, "");
    if (!relPath.endsWith(".md")) throw badRequest("A plan is exported as markdown");

    const safe = assertPathAllowed(join(repo.path, relPath), plan.projectId);
    if (existsSync(safe) && !body.overwrite) {
      throw conflict(`${relPath} already exists — export again to overwrite it`);
    }

    try {
      mkdirSync(dirname(safe), { recursive: true });
      writeFileSync(safe, planDocument(plan), "utf8");
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Could not write the file");
    }
    return { path: safe, relPath };
  });
}
