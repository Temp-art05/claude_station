import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { badRequest } from "../lib/path-safety";

/**
 * Resolve which working tree to inspect: a session's worktree, or a project path.
 * Shared by the git routes and the git watch socket so both agree on what "this
 * repo" means for a given (projectId, pathId/sessionId).
 */
export function resolveTree(
  projectId: string,
  query: { pathId?: string; sessionId?: string },
): string {
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
