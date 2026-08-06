import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { eq } from "drizzle-orm";
import matter from "gray-matter";
import { db, schema } from "../db";
import { GLOBAL_KNOWLEDGE_DIR, projectKnowledgeDir } from "../lib/data-dir";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { parseWorkbook } from "./excel";
import { linkSkill, unlinkSkill } from "./skills";

const SPREADSHEET = new Set([".xlsx", ".xls", ".xlsm", ".csv"]);
const TEXTUAL = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".ts", ".tsx", ".js", ".swift", ".kt", ".java",
  ".sql", ".sh", ".xml", ".html", ".css",
]);

export function storeDirFor(projectId: string | null): string {
  const dir = projectId ? projectKnowledgeDir(projectId) : GLOBAL_KNOWLEDGE_DIR;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Keep the user's filename but never let it escape the store. */
function safeName(filename: string): string {
  const base = filename.replace(/[/\\]/g, "_").replace(/^\.+/, "").trim();
  if (!base) throw badRequest("Invalid filename");
  return base.slice(0, 180);
}

export interface ImportInput {
  projectId: string | null;
  filename: string;
  description?: string;
  data: Buffer;
  /** Library folder, e.g. "android". Only meaningful for global assets. */
  folder?: string;
  /** doc/excel are inferred from the extension. Agents live in their own table. */
  kind?: "doc" | "excel";
}

export function importFile(input: ImportInput) {
  const name = safeName(input.filename);
  const ext = extname(name).toLowerCase();
  const kind = input.kind ?? (SPREADSHEET.has(ext) && ext !== ".csv" ? "excel" : "doc");

  const dir = storeDirFor(input.projectId);
  mkdirSync(dir, { recursive: true });
  const storedPath = join(dir, name);
  writeFileSync(storedPath, input.data);

  let parsedPath: string | null = null;
  let description = input.description ?? "";

  if (kind === "excel") {
    const parsed = parseWorkbook(storedPath);
    parsedPath = parsed.dir;
    const summary = parsed.sheets.map((s) => `${s.name} (${s.rows}×${s.cols})`).join(", ");
    description = description || `Spreadsheet — sheets: ${summary}`;
  }

  const row = {
    id: newId(),
    projectId: input.projectId,
    kind,
    name: name.replace(ext, ""),
    description,
    folder: input.folder ?? "",
    originalFilename: name,
    storedPath,
    parsedPath,
    sizeBytes: input.data.byteLength,
    createdAt: nowIso(),
  };
  db.insert(schema.knowledgeItems).values(row).run();

  if (input.projectId) {
    db.insert(schema.workHistory)
      .values({
        id: newId(),
        projectId: input.projectId,
        kind: "knowledge_imported",
        refId: row.id,
        summary: `Imported ${name} (${kind})`,
        createdAt: row.createdAt,
      })
      .run();
  }
  return row;
}

/** Skills live in the app store and are symlinked into the user-level skills dir. */
export function importSkill(input: {
  filename: string;
  data: Buffer;
  description?: string;
  folder?: string;
}) {
  const name = safeName(input.filename).replace(/\.md$/i, "");
  const parsed = matter(input.data.toString("utf8"));
  const skillName =
    typeof parsed.data.name === "string" && parsed.data.name.trim() ? parsed.data.name.trim() : name;
  const { dir, linked } = linkSkill(skillName, input.data);

  const row = {
    id: newId(),
    projectId: null,
    kind: "skill" as const,
    name: skillName,
    folder: input.folder ?? "",
    description:
      input.description ||
      (typeof parsed.data.description === "string" ? parsed.data.description : "") ||
      "Skill",
    originalFilename: `${skillName}/SKILL.md`,
    storedPath: dir,
    parsedPath: linked,
    sizeBytes: input.data.byteLength,
    createdAt: nowIso(),
  };
  db.insert(schema.knowledgeItems).values(row).run();
  return { ...row, linked };
}

export function listKnowledge(projectId?: string | null) {
  const rows =
    projectId === undefined
      ? db.select().from(schema.knowledgeItems).all()
      : db
          .select()
          .from(schema.knowledgeItems)
          .where(
            projectId === null
              ? eq(schema.knowledgeItems.kind, schema.knowledgeItems.kind) // all, filtered below
              : eq(schema.knowledgeItems.projectId, projectId),
          )
          .all();
  const filtered = projectId === null ? rows.filter((r) => r.projectId === null) : rows;
  return filtered
    .map((r) => ({ ...r, exists: existsSync(r.storedPath) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteKnowledge(id: string): void {
  const row = db
    .select()
    .from(schema.knowledgeItems)
    .where(eq(schema.knowledgeItems.id, id))
    .get();
  if (!row) throw badRequest("Knowledge item not found");

  if (row.kind === "skill") unlinkSkill(row.name);
  for (const path of [row.storedPath, row.parsedPath]) {
    if (path && existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
  db.delete(schema.knowledgeItems).where(eq(schema.knowledgeItems.id, id)).run();
}

/** Body text used for full-text search — only for reasonably small text files. */
export function textBodyOf(storedPath: string, kind: string): string {
  if (kind === "skill" || kind === "excel") return "";
  const ext = extname(storedPath).toLowerCase();
  if (!TEXTUAL.has(ext)) return "";
  try {
    if (statSync(storedPath).size > 1_000_000) return "";
    return readFileSync(storedPath, "utf8");
  } catch {
    return "";
  }
}
