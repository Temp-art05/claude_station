import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { isRunActive, killRun } from "./commands";
import { removeWorktree } from "./git";
import { deleteKnowledge } from "./knowledge";
import * as pty from "./pty-manager";
import { cancelRun, deleteRun } from "./workflow-runner";

/**
 * Delete a project and everything it owns.
 *
 * Row cascades handle the database. What they cannot reach is everything
 * living outside it — shells still attached to a PTY, command processes, SDK
 * sessions mid-flight, git worktrees registered in the user's own repo, and
 * files under the data dir. Those are torn down here first: kill before
 * unlinking, so nothing writes back into a directory that just went away.
 */
export async function deleteProject(id: string): Promise<void> {
  for (const t of db
    .select()
    .from(schema.terminals)
    .where(eq(schema.terminals.projectId, id))
    .all()) {
    pty.killSession(t.id);
  }

  for (const run of db
    .select()
    .from(schema.commandRuns)
    .where(eq(schema.commandRuns.projectId, id))
    .all()) {
    if (isRunActive(run.id)) killRun(run.id);
    rmSync(run.logPath, { force: true });
  }

  for (const run of db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.projectId, id))
    .all()) {
    if (run.status === "running" || run.status === "awaiting_input") await cancelRun(run.id);
    deleteRun(run.id); // takes the run's artifact dir with it
  }

  // A worktree is a checkout git tracks from inside the real repo — dropping
  // the session row alone would leave git pointing at a ghost.
  for (const s of db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.projectId, id))
    .all()) {
    if (s.worktreePath) removeWorktree(s.cwd, s.worktreePath);
  }

  // Env sets outlive their project. Credentials are typed once and reused, and
  // losing 80 variables because a workspace was tidied up is not a trade anyone
  // would make — so ownership is released to global instead of cascading.
  const orphanedSets = db
    .select()
    .from(schema.envSets)
    .where(eq(schema.envSets.projectId, id))
    .all();
  db.update(schema.envSets)
    .set({ projectId: null })
    .where(eq(schema.envSets.projectId, id))
    .run();
  // Now that they reach every project, per-project shares are dead weight.
  for (const set of orphanedSets) {
    db.delete(schema.projectEnvSets).where(eq(schema.projectEnvSets.envSetId, set.id)).run();
  }

  // Owned knowledge only. Items shared in from the global library are attached
  // through project_knowledge, and that link is all the cascade should take.
  for (const item of db
    .select()
    .from(schema.knowledgeItems)
    .where(eq(schema.knowledgeItems.projectId, id))
    .all()) {
    deleteKnowledge(item.id);
  }

  db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
}
