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
  closePull,
  commentPull,
  createPull,
  deleteBranch,
  editPullAssignees,
  editPullBase,
  getContents,
  githubConfig,
  githubContext,
  issueDetail,
  listAssignableUsers,
  listBranches,
  listIssues,
  listPulls,
  listReleases,
  mergePull,
  pullDetail,
  pullDetailFull,
  pullDiff,
  reopenPull,
  repoViewer,
  reviewPull,
  setPullDraft,
} from "../services/gh";
import { createTerminal } from "../services/terminals";

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

  /** "Work on this with Claude": new claude terminal, issue context typed into its composer. */
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
    const terminal = createTerminal(projectId, {
      kind: "claude",
      title: key,
      cwdPathId,
      useWorktree,
    });
    audit(projectId, "jira_linked", `Claude terminal from ${key}`, terminal.id);
    reply.code(201);
    return { terminalId: terminal.id, seed };
  });

  app.get("/api/jira/status", async () => {
    try {
      const cfg = jiraConfig();
      return { configured: true, baseUrl: cfg.baseUrl, email: cfg.email, deployment: cfg.deployment };
    } catch {
      return { configured: false };
    }
  });

  // ── GitHub ────────────────────────────────────────────────────────────────
  app.get("/api/github/repos", async () => githubConfig());

  app.get("/api/github/:owner/:repo/pulls", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    // The enum is what keeps an arbitrary string out of `gh`'s argv. The page cap
    // matters more than it looks: a page is fetched as `--limit page * 30 + 1`, so
    // an uncapped ?page= would set `gh` crawling GitHub's API for minutes.
    const { state, q, page } = z
      .object({
        state: z.enum(["open", "closed", "all"]).default("open"),
        q: z.string().max(256).default(""),
        page: z.coerce.number().int().min(1).max(20).default(1),
      })
      .parse(req.query);
    return listPulls(`${owner}/${repo}`, { state, search: q, page });
  });

  app.get("/api/github/:owner/:repo/issues", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    return listIssues(`${owner}/${repo}`);
  });

  app.post("/api/github/:owner/:repo/pulls", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    const input = z
      .object({
        title: z.string().min(1),
        body: z.string().optional(),
        base: z.string().min(1),
        head: z.string().min(1),
        draft: z.boolean().default(false),
      })
      .parse(req.body);
    return createPull(`${owner}/${repo}`, input);
  });

  const prParams = z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.coerce.number().int(),
  });

  app.get("/api/github/:owner/:repo/pulls/:number/detail", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    return pullDetailFull(`${owner}/${repo}`, number);
  });

  app.get("/api/github/:owner/:repo/pulls/:number/diff", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    return pullDiff(`${owner}/${repo}`, number);
  });

  app.post("/api/github/:owner/:repo/pulls/:number/comment", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    const { body } = z.object({ body: z.string().min(1) }).parse(req.body);
    await commentPull(`${owner}/${repo}`, number, body);
    return { ok: true };
  });

  app.post("/api/github/:owner/:repo/pulls/:number/review", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    const { event, body } = z
      .object({
        event: z.enum(["approve", "request-changes", "comment"]),
        body: z.string().optional(),
      })
      .parse(req.body);
    await reviewPull(`${owner}/${repo}`, number, event, body);
    return { ok: true };
  });

  app.post("/api/github/:owner/:repo/pulls/:number/merge", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    const { method, deleteBranch: del } = z
      .object({
        method: z.enum(["merge", "squash", "rebase"]),
        deleteBranch: z.boolean().default(false),
      })
      .parse(req.body);
    await mergePull(`${owner}/${repo}`, number, method, del);
    return { ok: true };
  });

  app.get("/api/github/:owner/:repo/viewer", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    return repoViewer(`${owner}/${repo}`);
  });

  app.get("/api/github/:owner/:repo/assignable-users", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    return listAssignableUsers(`${owner}/${repo}`);
  });

  app.post("/api/github/:owner/:repo/pulls/:number/base", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    const { base } = z.object({ base: z.string().min(1) }).parse(req.body);
    await editPullBase(`${owner}/${repo}`, number, base);
    return { ok: true };
  });

  app.post("/api/github/:owner/:repo/pulls/:number/close", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    await closePull(`${owner}/${repo}`, number);
    return { ok: true };
  });

  app.post("/api/github/:owner/:repo/pulls/:number/reopen", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    await reopenPull(`${owner}/${repo}`, number);
    return { ok: true };
  });

  app.post("/api/github/:owner/:repo/pulls/:number/draft", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    const { draft } = z.object({ draft: z.boolean() }).parse(req.body);
    await setPullDraft(`${owner}/${repo}`, number, draft);
    return { ok: true };
  });

  app.post("/api/github/:owner/:repo/pulls/:number/assignees", async (req) => {
    const { owner, repo, number } = prParams.parse(req.params);
    const { add, remove } = z
      .object({
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
      })
      .parse(req.body);
    await editPullAssignees(`${owner}/${repo}`, number, add, remove);
    return { ok: true };
  });

  app.get("/api/github/:owner/:repo/branches", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    return listBranches(`${owner}/${repo}`);
  });

  // Branch names contain "/" (feature/x), so the branch rides in the query string.
  app.delete("/api/github/:owner/:repo/branch", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    const { name } = z.object({ name: z.string().min(1) }).parse(req.query);
    await deleteBranch(`${owner}/${repo}`, name);
    return { deleted: name };
  });

  app.get("/api/github/:owner/:repo/releases", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    return listReleases(`${owner}/${repo}`);
  });

  app.get("/api/github/:owner/:repo/contents", async (req) => {
    const { owner, repo } = z.object({ owner: z.string(), repo: z.string() }).parse(req.params);
    const { path, ref } = z
      .object({ path: z.string().optional(), ref: z.string().optional() })
      .parse(req.query);
    return getContents(`${owner}/${repo}`, path ?? "", ref ?? "");
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
    const terminal = createTerminal(projectId, {
      kind: "claude",
      title: `${repo}#${number}`,
      cwdPathId,
      useWorktree,
    });
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId,
        kind: "github_linked",
        refId: terminal.id,
        summary: `Claude terminal from ${slug} ${kind} #${number}`,
        createdAt: nowIso(),
      })
      .run();
    reply.code(201);
    return { terminalId: terminal.id, seed };
  });
}
