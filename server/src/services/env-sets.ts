import { asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "../db";
import { newId } from "../lib/id";

/** Flatten an env set into the map we hand to node-pty / execa / the Agent SDK. */
export function envVarsFor(envSetId: string | null | undefined): Record<string, string> {
  if (!envSetId) return {};
  const vars = db
    .select()
    .from(schema.envVars)
    .where(eq(schema.envVars.envSetId, envSetId))
    .all();
  const out: Record<string, string> = {};
  for (const v of vars) out[v.key] = v.value;
  return out;
}

export function loadEnvSet(id: string) {
  const set = db.select().from(schema.envSets).where(eq(schema.envSets.id, id)).get();
  if (!set) return null;
  const vars = db
    .select()
    .from(schema.envVars)
    .where(eq(schema.envVars.envSetId, id))
    .orderBy(asc(schema.envVars.key))
    .all();
  const sharedWith = db
    .select()
    .from(schema.projectEnvSets)
    .where(eq(schema.projectEnvSets.envSetId, id))
    .all()
    .map((r) => r.projectId);
  return { ...set, vars, sharedWith };
}

/** Replace the share list wholesale — same contract as editing vars. */
export function setEnvSetShares(envSetId: string, projectIds: string[]): void {
  const owner = db.select().from(schema.envSets).where(eq(schema.envSets.id, envSetId)).get();
  // A global set already reaches every project, and sharing a set with its own
  // owner is a no-op row that would only ever confuse the UI.
  const wanted = new Set(owner?.projectId ? projectIds.filter((p) => p !== owner.projectId) : []);
  db.delete(schema.projectEnvSets).where(eq(schema.projectEnvSets.envSetId, envSetId)).run();
  for (const projectId of wanted) {
    db.insert(schema.projectEnvSets).values({ id: newId(), projectId, envSetId }).run();
  }
}

/** Sets usable by a project = global + its own + the ones shared into it. */
export function listEnvSets(projectId?: string) {
  if (!projectId) {
    return sorted(db.select().from(schema.envSets).all().map((r) => r.id));
  }
  const shared = db
    .select()
    .from(schema.projectEnvSets)
    .where(eq(schema.projectEnvSets.projectId, projectId))
    .all()
    .map((r) => r.envSetId);
  const owned = db
    .select()
    .from(schema.envSets)
    .where(or(isNull(schema.envSets.projectId), eq(schema.envSets.projectId, projectId)))
    .all()
    .map((r) => r.id);
  const ids = [...new Set([...owned, ...shared])];
  return sorted(ids);
}

function sorted(ids: string[]) {
  if (ids.length === 0) return [];
  // One query for the rows, then loadEnvSet per hit — the set count is small
  // and this keeps the shape identical everywhere.
  const known = new Set(
    db
      .select()
      .from(schema.envSets)
      .where(inArray(schema.envSets.id, ids))
      .all()
      .map((r) => r.id),
  );
  return ids
    .filter((id) => known.has(id))
    .map((id) => loadEnvSet(id))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
