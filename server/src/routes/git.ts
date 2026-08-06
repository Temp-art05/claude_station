import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { diff, isGitRepo, revertFiles, status } from "../services/git";

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
    return { cwd, isRepo: isGitRepo(cwd), files: status(cwd) };
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
