import { asc, eq, isNull, or } from "drizzle-orm";
import { db, schema } from "../db";

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
  return { ...set, vars };
}

/** Sets usable by a project = its own + the global ones. */
export function listEnvSets(projectId?: string) {
  const rows = projectId
    ? db
        .select()
        .from(schema.envSets)
        .where(or(isNull(schema.envSets.projectId), eq(schema.envSets.projectId, projectId)))
        .all()
    : db.select().from(schema.envSets).all();
  return rows
    .map((r) => loadEnvSet(r.id))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
