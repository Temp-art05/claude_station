import { existsSync } from "node:fs";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { skillLinkState } from "./skills";

type ItemRow = typeof schema.knowledgeItems.$inferSelect;

function decorate(row: ItemRow, attached?: boolean) {
  return {
    ...row,
    exists: existsSync(row.storedPath),
    ...(row.kind === "skill" ? { linkState: skillLinkState(row.name) } : {}),
    ...(attached === undefined ? {} : { attached }),
  };
}

/** Folders that actually contain something, with counts for the UI. */
export function listFolders(): { folder: string; count: number }[] {
  const rows = db
    .select()
    .from(schema.knowledgeItems)
    .where(isNull(schema.knowledgeItems.projectId))
    .all();
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.folder, (counts.get(row.folder) ?? 0) + 1);
  return [...counts.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => (a.folder === "" ? 1 : b.folder === "" ? -1 : a.folder.localeCompare(b.folder)));
}

/** The global library, optionally narrowed to one folder. */
export function listLibrary(folder?: string) {
  const rows = db
    .select()
    .from(schema.knowledgeItems)
    .where(isNull(schema.knowledgeItems.projectId))
    .orderBy(asc(schema.knowledgeItems.folder), asc(schema.knowledgeItems.name))
    .all()
    .filter((r) => folder === undefined || r.folder === folder);
  return rows.map((r) => decorate(r));
}

export function setFolder(itemId: string, folder: string): void {
  const row = db
    .select()
    .from(schema.knowledgeItems)
    .where(eq(schema.knowledgeItems.id, itemId))
    .get();
  if (!row) throw badRequest("Knowledge item not found");
  db.update(schema.knowledgeItems)
    .set({ folder })
    .where(eq(schema.knowledgeItems.id, itemId))
    .run();
}

/** Assets a project can use: its own uploads plus attached global ones. */
export function listProjectKnowledge(projectId: string) {
  const own = db
    .select()
    .from(schema.knowledgeItems)
    .where(eq(schema.knowledgeItems.projectId, projectId))
    .all()
    .map((r) => decorate(r, false));

  const attachedIds = db
    .select()
    .from(schema.projectKnowledge)
    .where(eq(schema.projectKnowledge.projectId, projectId))
    .all()
    .map((r) => r.knowledgeItemId);

  const attached = attachedIds
    .map((id) =>
      db.select().from(schema.knowledgeItems).where(eq(schema.knowledgeItems.id, id)).get(),
    )
    .filter((r): r is ItemRow => !!r)
    .map((r) => decorate(r, true));

  return [...own, ...attached].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function attachItems(projectId: string, itemIds: string[]): number {
  let added = 0;
  db.transaction(() => {
    for (const knowledgeItemId of itemIds) {
      const item = db
        .select()
        .from(schema.knowledgeItems)
        .where(eq(schema.knowledgeItems.id, knowledgeItemId))
        .get();
      if (!item) continue;
      if (item.projectId !== null) continue; // already owned by a project
      const existing = db
        .select()
        .from(schema.projectKnowledge)
        .where(
          and(
            eq(schema.projectKnowledge.projectId, projectId),
            eq(schema.projectKnowledge.knowledgeItemId, knowledgeItemId),
          ),
        )
        .get();
      if (existing) continue;
      db.insert(schema.projectKnowledge).values({ id: newId(), projectId, knowledgeItemId }).run();
      added += 1;
    }
  });
  return added;
}

/** The whole point of folders: attach a stack of assets in one action. */
export function attachFolder(projectId: string, folder: string): number {
  const ids = db
    .select()
    .from(schema.knowledgeItems)
    .where(isNull(schema.knowledgeItems.projectId))
    .all()
    .filter((r) => r.folder === folder)
    .map((r) => r.id);
  const added = attachItems(projectId, ids);
  if (added > 0) {
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId,
        kind: "knowledge_attached",
        refId: null,
        summary: `Attached ${added} asset(s) from folder "${folder || "unfiled"}"`,
        createdAt: nowIso(),
      })
      .run();
  }
  return added;
}

export function detachItem(projectId: string, knowledgeItemId: string): void {
  db.delete(schema.projectKnowledge)
    .where(
      and(
        eq(schema.projectKnowledge.projectId, projectId),
        eq(schema.projectKnowledge.knowledgeItemId, knowledgeItemId),
      ),
    )
    .run();
}

/** Directories a session needs Read access to for its attached assets. */
export function attachedAssetDirs(projectId: string): string[] {
  const dirs = new Set<string>();
  for (const item of listProjectKnowledge(projectId)) {
    if (!item.attached) continue;
    const dir = item.storedPath.slice(0, item.storedPath.lastIndexOf("/"));
    if (dir) dirs.add(dir);
  }
  return [...dirs];
}
