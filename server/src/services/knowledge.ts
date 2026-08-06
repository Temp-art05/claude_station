import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { eq } from "drizzle-orm";
import matter from "gray-matter";
import { db, schema } from "../db";
import { GLOBAL_KNOWLEDGE_DIR, projectKnowledgeDir } from "../lib/data-dir";
import { newId, nowIso } from "../lib/id";
import type { UploadedFile } from "../lib/multipart";
import { badRequest } from "../lib/path-safety";
import { parseWorkbook } from "./excel";
import { linkSkill, linkSkillTree, unlinkSkill } from "./skills";

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

export interface FolderImportInput {
  projectId: string | null;
  /** Name of the dropped folder — becomes the item name and the dir on disk. */
  rootName: string;
  /** Paths already sanitised and relative to the folder root. */
  files: UploadedFile[];
  description?: string;
  folder?: string;
}

/**
 * A whole directory as ONE knowledge item: storedPath is the directory, the
 * internal structure is preserved. A global folder whose root holds a SKILL.md
 * is a packaged skill and goes through the skill pipeline instead.
 */
export function importFolder(input: FolderImportInput) {
  if (input.files.length === 0) throw badRequest("The folder is empty");

  if (input.projectId === null && input.files.some((f) => f.relPath === "SKILL.md")) {
    return importSkillBundle(input);
  }

  const base = safeName(input.rootName);
  const store = storeDirFor(input.projectId);
  let dirName = base;
  for (let n = 2; existsSync(join(store, dirName)); n += 1) dirName = `${base}-${n}`;
  const storedPath = join(store, dirName);

  let sizeBytes = 0;
  for (const file of input.files) {
    const target = join(storedPath, file.relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.data);
    sizeBytes += file.data.byteLength;
  }

  const row = {
    id: newId(),
    projectId: input.projectId,
    kind: "folder" as const,
    name: dirName,
    description: input.description || `Folder — ${input.files.length} files`,
    folder: input.folder ?? "",
    originalFilename: dirName,
    storedPath,
    parsedPath: null,
    sizeBytes,
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
        summary: `Imported folder ${dirName} (${input.files.length} files)`,
        createdAt: row.createdAt,
      })
      .run();
  }
  return row;
}

/** A folder with a root SKILL.md — the whole tree becomes one linked skill. */
function importSkillBundle(input: FolderImportInput) {
  const skillMd = input.files.find((f) => f.relPath === "SKILL.md")!;
  const parsed = matter(skillMd.data.toString("utf8"));
  const requestedName =
    typeof parsed.data.name === "string" && parsed.data.name.trim()
      ? parsed.data.name.trim()
      : input.rootName;

  const { dir, linked, finalName } = linkSkillTree(requestedName, input.files);

  const row = {
    id: newId(),
    projectId: null,
    kind: "skill" as const,
    name: finalName,
    folder: input.folder ?? "",
    description:
      input.description ||
      (typeof parsed.data.description === "string" ? parsed.data.description : "") ||
      "Skill",
    originalFilename: `${finalName}/`,
    storedPath: dir,
    parsedPath: linked,
    sizeBytes: input.files.reduce((sum, f) => sum + f.data.byteLength, 0),
    createdAt: nowIso(),
  };
  db.insert(schema.knowledgeItems).values(row).run();
  return { ...row, linked };
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
  if (kind === "folder") return folderTextBody(storedPath);
  const ext = extname(storedPath).toLowerCase();
  if (!TEXTUAL.has(ext)) return "";
  try {
    if (statSync(storedPath).size > 1_000_000) return "";
    return readFileSync(storedPath, "utf8");
  } catch {
    return "";
  }
}

/** Concatenate the textual files inside a folder item, capped so FTS stays sane. */
function folderTextBody(dir: string, budget = { bytes: 2_000_000 }): string {
  const parts: string[] = [];
  const walk = (current: string, rel: string) => {
    if (budget.bytes <= 0) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.bytes <= 0) return;
      const abs = join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (!entry.isFile() || !TEXTUAL.has(extname(entry.name).toLowerCase())) continue;
      try {
        const size = statSync(abs).size;
        if (size > 1_000_000) continue;
        parts.push(`\n--- ${relPath} ---\n${readFileSync(abs, "utf8")}`);
        budget.bytes -= size;
      } catch {
        /* unreadable file — skip */
      }
    }
  };
  walk(dir, "");
  return parts.join("");
}
