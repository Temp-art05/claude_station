import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { assertPathAllowed } from "../lib/path-safety";
import { storeDirFor } from "../services/knowledge";
import { startRun, tailLog } from "../services/commands";
import { readSheet, writeWorkbook } from "../services/excel";
import {
  addComment,
  addWorklog,
  getIssue,
  getTransitions,
  searchIssues,
  transitionIssue,
} from "../services/jira";
import {
  createMemory,
  deleteMemory,
  getMemory,
  listGlobalMemories,
  listMemories,
  searchMemories,
  updateMemory,
} from "../services/memory";
import { search } from "../services/search";
import {
  artifactDir,
  emitArtifactRecord,
  hasPendingAsk,
  markAwaitingInput,
  recordQuestions,
  registerAsk,
  setStepNote,
} from "../services/workflow-runner";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

/**
 * In-process MCP server: this is what lets Claude *act* — update Jira, produce
 * spreadsheets, run the project's build commands — instead of only reading code.
 * Mutating tools still pass through canUseTool, so the user approves each one.
 */
export function stationMcpServer(
  projectId: string,
  sessionId: string,
  /** Set when this session is executing a workflow step — unlocks the workflow tools. */
  workflowRunStepId?: string | null,
) {
  const workflowTools = workflowRunStepId
    ? buildWorkflowTools(projectId, workflowRunStepId)
    : [];

  /**
   * A memory this session may read or change: its own project's, or a global
   * one. Ids belong to a single table, so without this a session could edit
   * another project's notes by guessing an id.
   */
  const inScope = (id: string) => {
    const found = getMemory(id);
    if (!found) return null;
    return found.projectId === null || found.projectId === projectId ? found : null;
  };

  return createSdkMcpServer({
    name: "station",
    version: "0.1.0",
    instructions:
      "Tools for this workspace: Jira read/write, spreadsheet read/write, knowledge search, " +
      "project memory, and the project's own build/test commands. Prefer run_project_command " +
      "over raw shell for builds — it streams to the user's UI and keeps a log." +
      (workflowRunStepId
        ? " You are running one step of a workflow: ask the user through workflow_ask instead of " +
          "guessing, and save anything the next step needs with workflow_emit_artifact."
        : ""),
    tools: [
      // ── Jira ──────────────────────────────────────────────────────────────
      tool(
        "jira_search",
        "Search Jira issues with JQL. Omit the query for issues assigned to the current user.",
        { jql: z.string().optional(), limit: z.number().int().max(50).optional() },
        async (args) => json(await searchIssues(args.jql, args.limit ?? 25)),
      ),
      tool(
        "jira_get_issue",
        "Fetch one Jira issue with its description converted to markdown.",
        { key: z.string().describe("Issue key, e.g. ABC-123") },
        async (args) => json(await getIssue(args.key)),
      ),
      tool(
        "jira_list_transitions",
        "List the workflow transitions available on a Jira issue. Call before transitioning.",
        { key: z.string() },
        async (args) => json(await getTransitions(args.key)),
      ),
      tool(
        "jira_comment",
        "Add a comment to a Jira issue.",
        { key: z.string(), body: z.string() },
        async (args) => {
          await addComment(args.key, args.body);
          audit(projectId, "jira_commented", `Claude commented on ${args.key}`, args.key);
          return text(`Commented on ${args.key}.`);
        },
      ),
      tool(
        "jira_transition",
        "Move a Jira issue to another status. Pass statusName or a transitionId.",
        { key: z.string(), statusName: z.string().optional(), transitionId: z.string().optional() },
        async (args) => {
          const label = await transitionIssue(args.key, {
            statusName: args.statusName,
            transitionId: args.transitionId,
          });
          audit(projectId, "jira_transitioned", `Claude transitioned ${args.key} (${label})`, args.key);
          return text(`Transitioned ${args.key}: ${label}`);
        },
      ),
      tool(
        "jira_worklog",
        "Log work against a Jira issue. timeSpent uses Jira syntax such as '2h 30m'.",
        { key: z.string(), timeSpent: z.string(), comment: z.string().optional() },
        async (args) => {
          await addWorklog(args.key, args.timeSpent, args.comment);
          audit(projectId, "jira_worklogged", `Claude logged ${args.timeSpent} on ${args.key}`, args.key);
          return text(`Logged ${args.timeSpent} on ${args.key}.`);
        },
      ),

      // ── Spreadsheets ──────────────────────────────────────────────────────
      tool(
        "excel_list",
        "List spreadsheets imported into this workspace, with their parsed sheet names.",
        {},
        async () => {
          const rows = db
            .select()
            .from(schema.knowledgeItems)
            .where(eq(schema.knowledgeItems.projectId, projectId))
            .all()
            .filter((r) => r.kind === "excel");
          return json(
            rows.map((r) => ({
              id: r.id,
              name: r.originalFilename,
              description: r.description,
              sheets: sheetNames(r.parsedPath),
              parsedDir: r.parsedPath,
            })),
          );
        },
      ),
      tool(
        "excel_read",
        "Read rows from an imported spreadsheet. Use excel_list first to get the id.",
        {
          knowledgeItemId: z.string(),
          sheet: z.string().optional(),
          limit: z.number().int().max(500).optional(),
        },
        async (args) => {
          const row = db
            .select()
            .from(schema.knowledgeItems)
            .where(eq(schema.knowledgeItems.id, args.knowledgeItemId))
            .get();
          if (!row) return text("No such knowledge item.");
          return json(readSheet(row.storedPath, args.sheet, args.limit ?? 200));
        },
      ),
      tool(
        "excel_write",
        "Create a spreadsheet in this project's knowledge store. Returns the path the user can download.",
        {
          filename: z.string().describe("e.g. weekly-report.xlsx"),
          sheets: z
            .array(
              z.object({
                name: z.string(),
                rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
              }),
            )
            .min(1),
        },
        async (args) => {
          const safe = args.filename.replace(/[/\\]/g, "_");
          const target = join(storeDirFor(projectId), safe.endsWith(".xlsx") ? safe : `${safe}.xlsx`);
          writeWorkbook(target, args.sheets);
          audit(projectId, "knowledge_imported", `Claude wrote ${safe}`, sessionId);
          return text(`Wrote ${target}. It now shows up in the project's Knowledge tab.`);
        },
      ),

      // ── Knowledge ─────────────────────────────────────────────────────────
      tool(
        "knowledge_search",
        "Full-text search over imported docs and past chat history in this workspace.",
        {
          query: z.string(),
          scope: z.enum(["all", "chat", "knowledge"]).optional(),
        },
        async (args) => json(search(args.query, args.scope ?? "all", 20)),
      ),

      // ── Memory ────────────────────────────────────────────────────────────
      tool(
        "memory_list",
        "List the memory notes in scope (titles only): this project's plus the global ones. " +
          "Pinned notes are already in your context.",
        {},
        async () =>
          json(
            [...listGlobalMemories(), ...listMemories(projectId)].map((m) => ({
              id: m.id,
              title: m.title,
              scope: m.projectId === null ? "global" : "project",
              pinned: m.pinned,
              tags: m.tags,
            })),
          ),
      ),
      tool(
        "memory_get",
        "Read one memory note in full, by id or exact title.",
        { id: z.string().optional(), title: z.string().optional() },
        async (args) => {
          const found = args.id
            ? inScope(args.id)
            : ([...listGlobalMemories(), ...listMemories(projectId)].find(
                (m) => m.title.toLowerCase() === (args.title ?? "").toLowerCase(),
              ) ?? null);
          if (!found) return text("No such memory.");
          return text(`# ${found.title}\n\n${found.body}`);
        },
      ),
      tool(
        "memory_search",
        "Search memory notes by keyword — this project's and the global ones.",
        { query: z.string() },
        async (args) => json(searchMemories(projectId, args.query)),
      ),
      tool(
        "memory_write",
        "Save something worth remembering next session: a convention, a decision, a gotcha. " +
          "Keep it short and durable — not a task log. Search first and update instead of " +
          "saving a near-duplicate. Use scope 'global' for a rule that holds in every project. " +
          "Pin it only if every session needs it.",
        {
          title: z.string(),
          body: z.string(),
          tags: z.array(z.string()).optional(),
          pinned: z.boolean().optional(),
          scope: z.enum(["project", "global"]).optional(),
        },
        async (args) => {
          const global = args.scope === "global";
          const created = createMemory(
            global ? null : projectId,
            {
              title: args.title,
              body: args.body,
              tags: args.tags ?? null,
              pinned: args.pinned ?? false,
            },
            "claude",
          );
          return text(
            `Saved ${global ? "global " : ""}memory "${created.title}"` +
              `${created.pinned ? " (pinned)" : ""}.`,
          );
        },
      ),
      tool(
        "memory_update",
        "Rewrite an existing memory note — use this to merge a new detail into a note that " +
          "already covers the topic, instead of adding a second one. Only the fields you pass change.",
        {
          id: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          tags: z.array(z.string()).optional(),
          pinned: z.boolean().optional(),
        },
        async (args) => {
          if (!inScope(args.id)) return text("No such memory.");
          const updated = updateMemory(args.id, {
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.body !== undefined ? { body: args.body } : {}),
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
            ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
          });
          return text(`Updated memory "${updated.title}".`);
        },
      ),
      tool(
        "memory_delete",
        "Delete a memory note that is wrong or no longer true. Prefer memory_update when the " +
          "note is merely out of date.",
        { id: z.string() },
        async (args) => {
          const found = inScope(args.id);
          if (!found) return text("No such memory.");
          deleteMemory(args.id);
          return text(`Deleted memory "${found.title}".`);
        },
      ),

      // ── Project commands ──────────────────────────────────────────────────
      tool(
        "list_project_commands",
        "List the build/test/lint commands configured for this project's repos.",
        {},
        async () => {
          const paths = db
            .select()
            .from(schema.projectPaths)
            .where(eq(schema.projectPaths.projectId, projectId))
            .orderBy(asc(schema.projectPaths.sortOrder))
            .all();
          return json(
            paths.map((p) => ({
              label: p.label,
              path: p.path,
              commands: db
                .select()
                .from(schema.pathCommands)
                .where(eq(schema.pathCommands.projectPathId, p.id))
                .all()
                .map((c) => ({ id: c.id, name: c.name, kind: c.kind, command: c.command })),
            })),
          );
        },
      ),
      tool(
        "run_project_command",
        "Run one of the project's configured commands (xcodebuild, gradlew, npm…) and wait for it. " +
          "Returns the exit code plus the tail of the log; the full log stays in the UI.",
        {
          commandId: z.string().describe("id from list_project_commands"),
          extraArgs: z.string().optional(),
        },
        async (args) => {
          const { runId, done } = startRun({
            projectId,
            pathCommandId: args.commandId,
            origin: "claude",
            sessionId,
            extraArgs: args.extraArgs,
          });
          const { exitCode, tail } = await done;
          return text(
            `run ${runId} exited ${exitCode ?? "by signal"}\n\n--- log tail ---\n${tail}`,
          );
        },
      ),
      ...workflowTools,
      tool(
        "read_command_log",
        "Read more of a previous command run's log when the tail wasn't enough.",
        { runId: z.string(), bytes: z.number().int().max(200_000).optional() },
        async (args) => {
          const row = db
            .select()
            .from(schema.commandRuns)
            .where(eq(schema.commandRuns.id, args.runId))
            .get();
          if (!row) return text("No such run.");
          return text(tailLog(row.logPath, args.bytes ?? setting("log.toolTailBytes") * 4));
        },
      ),
    ],
  });
}


/**
 * Only present when the session is executing a workflow step. A plain chat
 * session shouldn't be able to answer-block itself or write run artifacts.
 */
function buildWorkflowTools(projectId: string, runStepId: string) {
  const stepRow = db
    .select()
    .from(schema.workflowRunSteps)
    .where(eq(schema.workflowRunSteps.id, runStepId))
    .get();
  if (!stepRow) return [];
  const runId = stepRow.runId;

  return [
    tool(
      "workflow_ask",
      "Ask the user to decide something before you continue. This blocks until they answer, and " +
        "their answers are passed to the later steps — use it instead of guessing at scope, " +
        "auth, migrations or anything else the plan depends on.",
      {
        questions: z
          .array(
            z.object({
              key: z
                .string()
                .describe("short stable id, e.g. \"auth\" — later steps read answers.<key>"),
              question: z.string(),
              kind: z.enum(["text", "choice", "bool"]).optional(),
              options: z.array(z.string()).optional().describe("required when kind is choice"),
            }),
          )
          .min(1)
          .max(10),
      },
      async (args) => {
        if (hasPendingAsk(runStepId)) return text("You already have questions waiting.");
        recordQuestions(
          runId,
          runStepId,
          args.questions.map((q) => ({
            key: q.key,
            question: q.question,
            kind: q.kind ?? (q.options?.length ? "choice" : "text"),
            options: q.options,
          })),
        );
        markAwaitingInput(runId);
        const answers = await new Promise<Record<string, string>>((resolve) => {
          registerAsk(runStepId, resolve);
        });
        return json({ answers });
      },
    ),
    tool(
      "workflow_emit_artifact",
      "Save something the later steps or the user will need — a plan, a report. Pass content to " +
        "have it written for you, or path if you already wrote the file.",
      {
        kind: z.enum(["plan", "doc", "report", "patch", "other"]),
        title: z.string(),
        content: z.string().optional(),
        path: z.string().optional(),
      },
      async (args) => {
        let target = args.path ?? "";
        if (args.content !== undefined) {
          const safeName =
            args.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 60) || args.kind;
          target = join(artifactDir(runId), `${safeName}.md`);
          writeFileSync(target, args.content, "utf8");
        }
        if (!target) return text("Pass either content or path.");
        const artifact = emitArtifactRecord(runId, runStepId, {
          kind: args.kind,
          title: args.title,
          path: assertPathAllowed(target, projectId),
        });
        return text(`Saved artifact "${artifact.title}" → ${artifact.path}`);
      },
    ),
    tool(
      "workflow_note",
      "One short line about where you are, shown on the run's step list. Not for long output.",
      { text: z.string().max(400) },
      async (args) => {
        setStepNote(runId, stepRow.stepKey, args.text);
        return text("Noted.");
      },
    ),
  ];
}

function sheetNames(parsedPath: string | null): string[] {
  if (!parsedPath) return [];
  const metaPath = join(parsedPath, "meta.json");
  if (!existsSync(metaPath)) return [];
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { sheets?: { name: string }[] };
    return (meta.sheets ?? []).map((s) => s.name);
  } catch {
    return [];
  }
}

function audit(projectId: string, kind: string, summary: string, refId: string | null): void {
  db.insert(schema.workHistory)
    .values({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      kind,
      refId,
      summary,
      createdAt: new Date().toISOString(),
    })
    .run();
}
