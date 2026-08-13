import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { resolveTree } from "../services/git-paths";
import {
  addFiles,
  abortInProgress,
  branchInfo,
  branches,
  checkout,
  commit,
  commitFiles,
  commitPatch,
  deleteBranch,
  deleteUntracked,
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
  writeTreeFile,
} from "../services/git";

const idParam = z.object({ id: z.string() });

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

  /**
   * Save an edit from the Diff tab's editor. `baseHash` is what the editor loaded;
   * a mismatch means someone else (very possibly one of this app's own agents)
   * wrote the file first, and the answer is 409 rather than an overwrite.
   */
  app.put<{ Params: { id: string } }>("/api/projects/:id/git/file", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
        file: z.string().min(1),
        content: z.string().max(2_000_000),
        baseHash: z.string().min(1),
      })
      .parse(req.body);
    const cwd = resolveTree(id, body);
    assertPathAllowed(`${cwd}/${body.file}`, id);
    const result = writeTreeFile(cwd, body.file, body.content, body.baseHash);
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: id,
        kind: "git_file_edited",
        refId: body.sessionId ?? null,
        summary: `Edited ${body.file}`,
        createdAt: nowIso(),
      })
      .run();
    return result;
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

  /** "Add to VCS" for untracked files — one file or the whole group. */
  app.post<{ Params: { id: string } }>("/api/projects/:id/git/add", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        files: z.array(z.string().min(1)).min(1),
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .parse(req.body);
    const cwd = resolveTree(id, body);
    for (const file of body.files) assertPathAllowed(`${cwd}/${file}`, id);
    addFiles(cwd, body.files);
    return { added: body.files.length };
  });

  /** Delete unversioned files from disk (the Unversioned Files group's Rollback). */
  app.post<{ Params: { id: string } }>("/api/projects/:id/git/delete-files", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        files: z.array(z.string().min(1)).min(1),
        pathId: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .parse(req.body);
    const cwd = resolveTree(id, body);
    for (const file of body.files) assertPathAllowed(`${cwd}/${file}`, id);
    const deleted = deleteUntracked(cwd, body.files);
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: id,
        kind: "git_deleted",
        refId: body.sessionId ?? null,
        summary: `Deleted ${deleted} unversioned file(s) in ${cwd}`,
        createdAt: nowIso(),
      })
      .run();
    return { deleted };
  });

  // ── Changelists (Station-side grouping; git has no equivalent) ─────────────

  /** Lists plus their file mappings, for one repo path of this project. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/git/changelists", async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ pathId: z.string().default("") }).parse(req.query ?? {});
    const lists = db
      .select()
      .from(schema.gitChangelists)
      .where(
        and(
          eq(schema.gitChangelists.projectId, id),
          eq(schema.gitChangelists.pathId, q.pathId),
        ),
      )
      .all();
    if (lists.length === 0) return { changelists: [] };
    const files = db
      .select()
      .from(schema.gitChangelistFiles)
      .where(
        inArray(
          schema.gitChangelistFiles.changelistId,
          lists.map((l) => l.id),
        ),
      )
      .all();
    return {
      changelists: lists.map((l) => ({
        id: l.id,
        name: l.name,
        files: files.filter((f) => f.changelistId === l.id).map((f) => f.path),
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/git/changelists", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ pathId: z.string().default(""), name: z.string().min(1).max(120) })
      .parse(req.body);
    const row = {
      id: newId(),
      projectId: id,
      pathId: body.pathId,
      name: body.name.trim(),
      createdAt: nowIso(),
    };
    db.insert(schema.gitChangelists).values(row).run();
    reply.code(201);
    return { ...row, files: [] };
  });

  app.patch<{ Params: { id: string; clId: string } }>(
    "/api/projects/:id/git/changelists/:clId",
    async (req) => {
      const { clId } = z.object({ id: z.string(), clId: z.string() }).parse(req.params);
      const body = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
      db.update(schema.gitChangelists)
        .set({ name: body.name.trim() })
        .where(eq(schema.gitChangelists.id, clId))
        .run();
      return { ok: true };
    },
  );

  /** Deleting a list only drops the grouping — the files themselves are untouched. */
  app.delete<{ Params: { id: string; clId: string } }>(
    "/api/projects/:id/git/changelists/:clId",
    async (req, reply) => {
      const { clId } = z.object({ id: z.string(), clId: z.string() }).parse(req.params);
      db.delete(schema.gitChangelists).where(eq(schema.gitChangelists.id, clId)).run();
      reply.code(204);
    },
  );

  /**
   * Move files into a changelist, or back to the default group with `clId: null`.
   * Old mappings are cleared first so a file is never in two lists at once.
   */
  app.post<{ Params: { id: string } }>("/api/projects/:id/git/changelist-files", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        pathId: z.string().default(""),
        clId: z.string().nullable(),
        paths: z.array(z.string().min(1)).min(1),
      })
      .parse(req.body);
    const scoped = db
      .select()
      .from(schema.gitChangelists)
      .where(
        and(eq(schema.gitChangelists.projectId, id), eq(schema.gitChangelists.pathId, body.pathId)),
      )
      .all();
    if (body.clId && !scoped.some((l) => l.id === body.clId)) {
      throw badRequest("Changelist not found in this repo");
    }
    if (scoped.length > 0) {
      db.delete(schema.gitChangelistFiles)
        .where(
          and(
            inArray(
              schema.gitChangelistFiles.changelistId,
              scoped.map((l) => l.id),
            ),
            inArray(schema.gitChangelistFiles.path, body.paths),
          ),
        )
        .run();
    }
    if (body.clId) {
      for (const path of body.paths) {
        db.insert(schema.gitChangelistFiles)
          .values({ id: newId(), changelistId: body.clId, path })
          .run();
      }
    }
    return { moved: body.paths.length };
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
