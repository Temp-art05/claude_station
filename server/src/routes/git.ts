import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import {
  abortInProgress,
  branchInfo,
  branches,
  checkout,
  commit,
  commitFiles,
  commitPatch,
  deleteBranch,
  diff,
  fetchAll,
  isGitRepo,
  listFiles,
  log,
  merge,
  pull,
  push,
  readTreeFile,
  rebase,
  revertFiles,
  revertHunk,
  status,
} from "../services/git";

const idParam = z.object({ id: z.string() });

/** Resolve which working tree to inspect: a session's worktree, or a project path. */
function resolveTree(projectId: string, query: { pathId?: string; sessionId?: string }): string {
  if (query.sessionId) {
    const session = db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, query.sessionId))
      .get();
    if (!session) throw badRequest("Session not found");
    return session.worktreePath ?? session.cwd;
  }
  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, projectId))
    .all();
  const chosen = query.pathId
    ? paths.find((p) => p.id === query.pathId)
    : (paths.find((p) => p.isDefault) ?? paths[0]);
  if (!chosen) throw badRequest("No path to inspect");
  return chosen.path;
}

const treeQuery = z.object({
  pathId: z.string().optional(),
  sessionId: z.string().optional(),
  file: z.string().optional(),
});

export function gitRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/git/status", async (req) => {
    const { id } = idParam.parse(req.params);
    const q = treeQuery.parse(req.query ?? {});
    const cwd = resolveTree(id, q);
    return { cwd, isRepo: isGitRepo(cwd), branch: branchInfo(cwd), files: status(cwd) };
  });

  /** Every file the project tree shows: tracked + untracked, .gitignore respected. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/git/tree", async (req) => {
    const { id } = idParam.parse(req.params);
    const q = treeQuery.parse(req.query ?? {});
    const cwd = resolveTree(id, q);
    return { cwd, isRepo: isGitRepo(cwd), ...listFiles(cwd) };
  });

  /** One file's content — worktree version by default, HEAD version on demand. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/git/file", async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z
      .object({
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
        file: z.string().min(1),
        rev: z.enum(["worktree", "head"]).default("worktree"),
      })
      .parse(req.query ?? {});
    const cwd = resolveTree(id, q);
    assertPathAllowed(`${cwd}/${q.file}`, id);
    return readTreeFile(cwd, q.file, q.rev);
  });

  // ── Branches / history / hunk ops ─────────────────────────────────────────

  app.get<{ Params: { id: string } }>("/api/projects/:id/git/branches", async (req) => {
    const { id } = idParam.parse(req.params);
    const cwd = resolveTree(id, treeQuery.parse(req.query ?? {}));
    return branches(cwd);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/git/log", async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z
      .object({
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
        branch: z.string().optional(),
        limit: z.coerce.number().int().max(500).default(100),
      })
      .parse(req.query ?? {});
    const cwd = resolveTree(id, q);
    return { commits: log(cwd, q.limit, q.branch) };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/git/commit-files", async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z
      .object({
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
        hash: z.string().regex(/^[0-9a-f]{4,40}$/i),
      })
      .parse(req.query ?? {});
    const cwd = resolveTree(id, q);
    return { files: commitFiles(cwd, q.hash) };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/git/show", async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z
      .object({
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
        hash: z.string().regex(/^[0-9a-f]{4,40}$/i),
        file: z.string().optional(),
      })
      .parse(req.query ?? {});
    const cwd = resolveTree(id, q);
    return { patch: commitPatch(cwd, q.hash, q.file) };
  });

  /**
   * Branch/sync operations, one endpoint per verb via `op`. Conflicts are not
   * resolved here — the error carries git's stderr and `abort` is the way out.
   */
  app.post<{ Params: { id: string } }>("/api/projects/:id/git/op", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
        op: z.enum([
          "checkout",
          "create-branch",
          "delete-branch",
          "fetch",
          "pull",
          "pull-rebase",
          "push",
          "merge",
          "merge-squash",
          "rebase",
          "abort",
        ]),
        branch: z.string().optional(),
        force: z.boolean().default(false),
      })
      .parse(req.body);
    const cwd = resolveTree(id, body);
    const need = (b?: string): string => {
      if (!b) throw badRequest("branch is required for this operation");
      return b;
    };
    let output = "";
    switch (body.op) {
      case "checkout": output = checkout(cwd, need(body.branch)); break;
      case "create-branch": output = checkout(cwd, need(body.branch), true); break;
      case "delete-branch": output = deleteBranch(cwd, need(body.branch), body.force); break;
      case "fetch": output = fetchAll(cwd); break;
      case "pull": output = pull(cwd, false); break;
      case "pull-rebase": output = pull(cwd, true); break;
      case "push": output = push(cwd); break;
      case "merge": output = merge(cwd, need(body.branch), false); break;
      case "merge-squash": output = merge(cwd, need(body.branch), true); break;
      case "rebase": output = rebase(cwd, need(body.branch)); break;
      case "abort": output = abortInProgress(cwd); break;
    }
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: id,
        kind: "git_op",
        refId: null,
        summary: `git ${body.op}${body.branch ? ` ${body.branch}` : ""}`,
        createdAt: nowIso(),
      })
      .run();
    return { ok: true, output: output.slice(0, 2000), branches: branches(cwd) };
  });

  /** Roll back one hunk in the working tree (the ⤺ button on a diff hunk). */
  app.post<{ Params: { id: string } }>("/api/projects/:id/git/revert-hunk", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
        patch: z.string().min(1).max(1_000_000),
      })
      .parse(req.body);
    const cwd = resolveTree(id, body);
    revertHunk(cwd, body.patch);
    return { ok: true };
  });

  /** Commit the picked files; optionally push right after (Android Studio style). */
  app.post<{ Params: { id: string } }>("/api/projects/:id/git/commit", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        files: z.array(z.string().min(1)).min(1),
        message: z.string().default(""),
        amend: z.boolean().default(false),
        push: z.boolean().default(false),
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .parse(req.body);
    const cwd = resolveTree(id, body);
    for (const file of body.files) assertPathAllowed(`${cwd}/${file}`, id);
    const result = commit(cwd, body.files, body.message, body.amend);
    let pushed = false;
    if (body.push) {
      push(cwd);
      pushed = true;
    }
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: id,
        kind: "git_committed",
        refId: body.sessionId ?? null,
        summary: `Committed ${body.files.length} file(s)${pushed ? " + pushed" : ""}: ${result.summary}`,
        createdAt: nowIso(),
      })
      .run();
    return { ...result, pushed };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/git/diff", async (req) => {
    const { id } = idParam.parse(req.params);
    const q = treeQuery.parse(req.query ?? {});
    const cwd = resolveTree(id, q);
    return { cwd, patch: diff(cwd, q.file) };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/git/revert", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        files: z.array(z.string().min(1)).min(1),
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .parse(req.body);
    const cwd = resolveTree(id, body);
    // Every file must resolve inside the tree we're operating on.
    for (const file of body.files) assertPathAllowed(`${cwd}/${file}`, id);
    revertFiles(cwd, body.files);
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: id,
        kind: "git_reverted",
        refId: body.sessionId ?? null,
        summary: `Reverted ${body.files.length} file(s) in ${cwd}`,
        createdAt: nowIso(),
      })
      .run();
    return { reverted: body.files.length };
  });
}
