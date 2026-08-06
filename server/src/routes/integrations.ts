import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { githubConfigSchema, jiraConfigSchema } from "@claude-station/shared";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import {
  addComment,
  addWorklog,
  getIssue,
  getTransitions,
  issueContext,
  jiraConfig,
  searchIssues,
  transitionIssue,
} from "../services/jira";
import {
  githubConfig,
  githubContext,
  issueDetail,
  listIssues,
  listPulls,
  pullDetail,
} from "../services/gh";
import { createChatSession } from "../services/sessions";

const keyParam = z.object({ key: z.string().min(1) });

function saveIntegration(kind: "jira" | "github", config: unknown): void {
  const encoded = JSON.stringify(config);
  const existing = db
    .select()
    .from(schema.integrations)
    .where(eq(schema.integrations.kind, kind))
    .get();
  if (existing) {
    db.update(schema.integrations)
      .set({ config: encoded })
      .where(eq(schema.integrations.kind, kind))
      .run();
  } else {
    db.insert(schema.integrations).values({ id: newId(), kind, config: encoded }).run();
  }
}

/** Audit every mutation we make on someone else's tracker. */
function audit(projectId: string | null, kind: string, summary: string, refId?: string): void {
  if (!projectId) return;
  db.insert(schema.workHistory)
    .values({ id: newId(), projectId, kind, refId: refId ?? null, summary, createdAt: nowIso() })
    .run();
}

export function integrationRoutes(app: FastifyInstance): void {
  // ── config ────────────────────────────────────────────────────────────────
  app.get("/api/integrations/:kind", async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(["jira", "github"]) }).parse(req.params);
    const row = db
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.kind, kind))
      .get();
    if (!row) return reply.code(404).send({ error: "Not configured" });
    const config = JSON.parse(row.config) as Record<string, unknown>;
    // Never echo the token back — the UI only needs to know one is stored.
    if (typeof config.apiToken === "string") config.apiToken = "";
    return { kind, config, configured: true };
  });

  app.put("/api/integrations/jira", async (req) => {
    const input = jiraConfigSchema.parse(req.body);
    saveIntegration("jira", input);
    return { ok: true };
  });

  app.put("/api/integrations/github", async (req) => {
    const input = githubConfigSchema.parse(req.body);
    saveIntegration("github", input);
    return { ok: true };
  });

  // ── Jira ──────────────────────────────────────────────────────────────────
  app.get("/api/jira/issues", async (req) => {
    const { jql, limit } = z
      .object({ jql: z.string().optional(), limit: z.coerce.number().int().max(100).default(50) })
      .parse(req.query ?? {});
    return searchIssues(jql, limit);
  });

  app.get("/api/jira/issues/:key", async (req) => {
    const { key } = keyParam.parse(req.params);
    return getIssue(key);
  });

  app.get("/api/jira/issues/:key/transitions", async (req) => {
    const { key } = keyParam.parse(req.params);
    return getTransitions(key);
  });

  app.post("/api/jira/issues/:key/comment", async (req) => {
    const { key } = keyParam.parse(req.params);
    const { body, projectId } = z
      .object({ body: z.string().min(1), projectId: z.string().nullable().default(null) })
      .parse(req.body);
    await addComment(key, body);
    audit(projectId, "jira_commented", `Commented on ${key}`, key);
    return { ok: true };
  });

  app.post("/api/jira/issues/:key/transition", async (req) => {
    const { key } = keyParam.parse(req.params);
    const { transitionId, statusName, projectId } = z
      .object({
        transitionId: z.string().optional(),
        statusName: z.string().optional(),
        projectId: z.string().nullable().default(null),
      })
      .parse(req.body);
    const label = await transitionIssue(key, { transitionId, statusName });
    audit(projectId, "jira_transitioned", `Transitioned ${key} (${label})`, key);
    return { ok: true, transition: label };
  });

  app.post("/api/jira/issues/:key/worklog", async (req) => {
    const { key } = keyParam.parse(req.params);
    const { timeSpent, comment, projectId } = z
      .object({
        timeSpent: z.string().min(1),
        comment: z.string().optional(),
        projectId: z.string().nullable().default(null),
      })
      .parse(req.body);
    await addWorklog(key, timeSpent, comment);
    audit(projectId, "jira_worklogged", `Logged ${timeSpent} on ${key}`, key);
    return { ok: true };
  });

  /** "Work on this with Claude": new session seeded with the issue as context. */
  app.post("/api/jira/issues/:key/work-with-claude", async (req, reply) => {
    const { key } = keyParam.parse(req.params);
    const { projectId, cwdPathId, useWorktree } = z
      .object({
        projectId: z.string(),
        cwdPathId: z.string().optional(),
        useWorktree: z.boolean().optional(),
      })
      .parse(req.body);
    const seed = await issueContext(key);
    const session = createChatSession(projectId, {
      title: `${key}`,
      cwdPathId,
      permissionMode: "default",
      origin: `jira:${key}`,
      useWorktree,
    });
    reply.code(201);
    return { sessionId: session.id, seed };
  });

  app.get("/api/jira/status", async () => {
    try {
      const cfg = jiraConfig();
      return { configured: true, baseUrl: cfg.baseUrl, email: cfg.email };
    } catch {
      return { configured: false };
    }
  });

  // ── GitHub ────────────────────────────────────────────────────────────────
  app.get("/api/github/repos", async () => githubConfig());

  app.get("/api/github/:owner/:repo/pulls", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    return listPulls(`${owner}/${repo}`);
  });

  app.get("/api/github/:owner/:repo/issues", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    return listIssues(`${owner}/${repo}`);
  });

  app.get("/api/github/:owner/:repo/pulls/:number", async (req) => {
    const { owner, repo, number } = z
      .object({ owner: z.string(), repo: z.string(), number: z.coerce.number().int() })
      .parse(req.params);
    return pullDetail(`${owner}/${repo}`, number);
  });

  app.get("/api/github/:owner/:repo/issues/:number", async (req) => {
    const { owner, repo, number } = z
      .object({ owner: z.string(), repo: z.string(), number: z.coerce.number().int() })
      .parse(req.params);
    return issueDetail(`${owner}/${repo}`, number);
  });

  app.post("/api/github/:owner/:repo/:kind/:number/work-with-claude", async (req, reply) => {
    const { owner, repo, kind, number } = z
      .object({
        owner: z.string(),
        repo: z.string(),
        kind: z.enum(["pr", "issue"]),
        number: z.coerce.number().int(),
      })
      .parse(req.params);
    const { projectId, cwdPathId, useWorktree } = z
      .object({
        projectId: z.string(),
        cwdPathId: z.string().optional(),
        useWorktree: z.boolean().optional(),
      })
      .parse(req.body);
    const slug = `${owner}/${repo}`;
    const seed = await githubContext(slug, kind, number);
    const session = createChatSession(projectId, {
      title: `${repo}#${number}`,
      cwdPathId,
      permissionMode: "default",
      origin: `github:${kind}:${number}`,
      useWorktree,
    });
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId,
        kind: "github_linked",
        refId: session.id,
        summary: `Session from ${slug} ${kind} #${number}`,
        createdAt: nowIso(),
      })
      .run();
    reply.code(201);
    return { sessionId: session.id, seed };
  });
}
