import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { projectKnowledgeDir } from "../lib/data-dir";
import { listProjectKnowledge } from "./library";
import { memoryPromptSection } from "./memory";

/**
 * The prompt fragment that tells Claude what this workspace *is*: which repo is
 * which, what commands exist, where imported docs live. Capped so a big
 * knowledge folder can't crowd out the conversation — anything past the cap is
 * reachable through the knowledge_search tool instead.
 */
export function buildWorkspaceContext(projectId: string): string {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return "";

  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, projectId))
    .orderBy(asc(schema.projectPaths.sortOrder))
    .all();

  const lines: string[] = [
    `# Workspace: ${project.name}`,
    project.description ? project.description : "",
    "",
    "## Repositories",
  ];

  for (const p of paths) {
    lines.push(`- \`${p.path}\` — **${p.label}**${p.description ? `: ${p.description}` : ""}`);
    const commands = db
      .select()
      .from(schema.pathCommands)
      .where(eq(schema.pathCommands.projectPathId, p.id))
      .orderBy(asc(schema.pathCommands.sortOrder))
      .all();
    for (const c of commands) {
      lines.push(`    - command \`${c.name}\` (${c.kind}): \`${c.command}\``);
    }
  }

  // Own uploads plus assets attached from the global library.
  const knowledge = listProjectKnowledge(projectId);

  if (knowledge.length > 0) {
    lines.push("", "## Imported knowledge", `Project store: \`${projectKnowledgeDir(projectId)}\`.`);
    for (const k of knowledge) {
      const parsed = k.parsedPath ? ` (parsed copy: \`${k.parsedPath}\`)` : "";
      const from = k.attached ? ` [library${k.folder ? `/${k.folder}` : ""}]` : "";
      lines.push(
        `- \`${k.storedPath}\`${from} — ${k.description || k.kind}${parsed}`,
      );
    }
    lines.push(
      "",
      "Spreadsheets are also stored as CSV per sheet next to the original — read those instead of parsing .xlsx.",
    );
  }

  const cap = setting("prompt.knowledgeIndexBytes");

  // Truncate the repo/knowledge index on its own, then append memory. Memory
  // carries the rule that tells Claude to keep writing notes, so it must not be
  // what a long knowledge listing pushes off the end.
  let text = lines.filter((l) => l !== undefined).join("\n");
  const totalCap = cap * 2;
  if (Buffer.byteLength(text, "utf8") > totalCap) {
    const head = Buffer.from(text, "utf8").subarray(0, totalCap).toString("utf8");
    text = `${head}\n\n…(index truncated — use knowledge_search instead of assuming)`;
  }

  return `${text}\n\n${memoryPromptSection(projectId, cap)}`;
}
