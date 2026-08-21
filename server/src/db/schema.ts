import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** Board column on the Projects page: "active" | "backlog". */
  status: text("status").notNull().default("active"),
  /** Manual order inside the column; ties fall back to `updated_at` desc. */
  sortOrder: integer("sort_order").notNull().default(0),
});

export const projectPaths = sqliteTable(
  "project_paths",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Default env set for THIS repo — used by command runs (UI and Claude's tool). */
    envSetId: text("env_set_id"),
  },
  (t) => [index("idx_project_paths_project").on(t.projectId)],
);

/** Build/test/lint commands attached to a path — shared by the UI runner and Claude's tool. */
export const pathCommands = sqliteTable(
  "path_commands",
  {
    id: text("id").primaryKey(),
    projectPathId: text("project_path_id")
      .notNull()
      .references(() => projectPaths.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("custom"), // build|test|lint|run|custom
    command: text("command").notNull(),
    cwdOverride: text("cwd_override"),
    timeoutSec: integer("timeout_sec").notNull().default(900),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("idx_path_commands_path").on(t.projectPathId)],
);

export const commandRuns = sqliteTable(
  "command_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pathCommandId: text("path_command_id").references(() => pathCommands.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    command: text("command").notNull(),
    cwd: text("cwd").notNull(),
    exitCode: integer("exit_code"),
    logPath: text("log_path").notNull(),
    origin: text("origin").notNull().default("ui"), // ui|claude
    sessionId: text("session_id"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("idx_command_runs_project").on(t.projectId, t.startedAt)],
);

export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sdkSessionId: text("sdk_session_id"),
    cwd: text("cwd").notNull(),
    envSetId: text("env_set_id"),
    permissionMode: text("permission_mode").notNull().default("default"),
    model: text("model"),
    origin: text("origin").notNull().default("manual"),
    status: text("status").notNull().default("idle"), // idle|running|error
    worktreePath: text("worktree_path"),
    /** chat | agent (a workspace tab) | workflow (one step of a run). */
    kind: text("kind").notNull().default("chat"),
    /** Set for kind=agent|workflow: runs as the SDK's main-thread agent (options.agent). */
    agentName: text("agent_name"),
    /** Set for kind=workflow: which run step this session is executing. */
    workflowRunStepId: text("workflow_run_step_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("idx_chat_sessions_project").on(t.projectId)],
);

export const chatAttachments = sqliteTable(
  "chat_attachments",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // image|file
    mime: text("mime").notNull(),
    storedPath: text("stored_path").notNull(),
    originalFilename: text("original_filename").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_chat_attachments_session").on(t.sessionId)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    type: text("type").notNull(),
    content: text("content").notNull(), // raw SDKMessage JSON — source of truth
    textPreview: text("text_preview").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_chat_messages_session_seq").on(t.sessionId, t.seq)],
);

export const terminals = sqliteTable(
  "terminals",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    cwd: text("cwd").notNull(),
    envSetId: text("env_set_id"),
    pid: integer("pid"),
    kind: text("kind").notNull().default("shell"), // shell|claude
    /** Command the PTY was started with (app agents) — restart re-runs it. */
    command: text("command"),
    /**
     * The `claude` CLI session this tab owns (--session-id). Resuming targets it
     * by id instead of `--continue`, which would grab whichever conversation in
     * this directory happens to be newest. NULL on shells and on rows opened
     * before this existed.
     */
    claudeSessionId: text("claude_session_id"),
    status: text("status").notNull().default("running"), // running|exited|orphaned
    createdAt: text("created_at").notNull(),
    closedAt: text("closed_at"),
  },
  (t) => [index("idx_terminals_project").on(t.projectId)],
);

export const envSets = sqliteTable(
  "env_sets",
  {
    id: text("id").primaryKey(),
    /** NULL = global set, usable by every project. */
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_env_sets_project").on(t.projectId)],
);

export const envVars = sqliteTable(
  "env_vars",
  {
    id: text("id").primaryKey(),
    envSetId: text("env_set_id")
      .notNull()
      .references(() => envSets.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("idx_env_vars_set").on(t.envSetId)],
);

/**
 * Extra projects an env set is available in, on top of its owner.
 *
 * `env_sets.project_id` says who owns a set (NULL = global, everyone gets it).
 * Ownership alone made a set unusable anywhere else, which is wrong for the
 * common case: the same credentials feed several projects. This is the same
 * shape as project_knowledge — share without duplicating.
 */
export const projectEnvSets = sqliteTable(
  "project_env_sets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    envSetId: text("env_set_id")
      .notNull()
      .references(() => envSets.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("idx_project_env_sets_unique").on(t.projectId, t.envSetId)],
);

export const knowledgeItems = sqliteTable(
  "knowledge_items",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }), // NULL = global
    kind: text("kind").notNull(), // doc|excel|skill|folder
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Library folder, e.g. "android" or "fe/react". Empty = unfiled. */
    folder: text("folder").notNull().default(""),
    originalFilename: text("original_filename").notNull(),
    storedPath: text("stored_path").notNull(),
    parsedPath: text("parsed_path"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_knowledge_project").on(t.projectId),
    index("idx_knowledge_folder").on(t.folder),
  ],
);

/**
 * Global library assets attached to a project. Lets one skill or doc serve many
 * projects without copying the file, and makes "attach the whole android folder"
 * a single action.
 */
export const projectKnowledge = sqliteTable(
  "project_knowledge",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    knowledgeItemId: text("knowledge_item_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("idx_project_knowledge_unique").on(t.projectId, t.knowledgeItemId)],
);

/**
 * Durable notes handed to Claude on top of the code: conventions, decisions,
 * gotchas. Pinned ones go into the prompt in full; the rest are listed by title
 * and fetched on demand through the memory_get tool.
 *
 * A null projectId means the note is global — a rule that holds in every
 * workspace, so it rides along with every session rather than one project's.
 */
export const projectMemories = sqliteTable(
  "project_memories",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    tags: text("tags"), // JSON string[]
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    source: text("source").notNull().default("manual"), // manual|imported|claude
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_project_memories_project").on(t.projectId, t.pinned)],
);

export const integrations = sqliteTable("integrations", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().unique(), // jira|github
  config: text("config").notNull(), // JSON
});

/** Behaviour settings editable from the UI — see plan § Config tier 2. */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON-encoded
});

/**
 * Subagent definitions handed to the SDK via `options.agents`. Managed here
 * rather than as loose files so they can be edited in the UI and switched on
 * per project.
 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    /** The key Claude sees in options.agents — kebab-case, unique. */
    name: text("name").notNull().unique(),
    description: text("description").notNull(),
    prompt: text("prompt").notNull(),
    tools: text("tools"), // JSON string[] — null = inherit every tool
    disallowedTools: text("disallowed_tools"), // JSON string[]
    skills: text("skills"), // JSON string[]
    model: text("model"), // alias (opus/sonnet/haiku) or null = inherit
    maxTurns: integer("max_turns"),
    background: integer("background", { mode: "boolean" }).notNull().default(false),
    /**
     * Optional custom UI for this agent's workspace tab: a path under the data
     * dir to an .html file. Empty = the default chat view.
     */
    viewPath: text("view_path"),
    /**
     * App agents (a runnable app packaged as a folder): URL of the app's own
     * web UI (iframed in the workspace tab, wins over viewPath) and the command
     * that starts it — run in a Station terminal at bundleDir so stdin confirm
     * prompts keep working.
     */
    viewUrl: text("view_url"),
    startCommand: text("start_command"),
    /**
     * Companion files from a folder import, stored under data/agents/<name>.
     * Added to additionalDirectories whenever this agent is in a session.
     */
    bundleDir: text("bundle_dir"),
    /** Available to every project without an explicit opt-in. */
    enabledGlobally: integer("enabled_globally", { mode: "boolean" }).notNull().default(false),
    source: text("source").notNull().default("manual"), // manual|imported
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_agents_name").on(t.name)],
);

// ── Workflows ─────────────────────────────────────────────────────────────────

/**
 * A repeatable working sequence for a kind of project (read docs → plan →
 * confirm → update docs → implement → test). A library asset like skills and
 * agents: it has a folder and gets imported into projects.
 */
export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull().default(""),
    folder: text("folder").notNull().default(""),
    source: text("source").notNull().default("manual"), // manual|imported
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_workflows_folder").on(t.folder)],
);

export const workflowSteps = sqliteTable(
  "workflow_steps",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Stable handle used by conditions and run bookkeeping. */
    key: text("key").notNull(),
    type: text("type").notNull(), // agent|command|confirm|manual
    title: text("title").notNull(),
    agentName: text("agent_name"),
    instruction: text("instruction"),
    /** Matched against the project's path_commands by name at run time. */
    commandName: text("command_name"),
    requiresConfirm: integer("requires_confirm", { mode: "boolean" }).notNull().default(false),
    /** Per-step, so a long implement step can run without babysitting. */
    permissionMode: text("permission_mode"),
    maxRetries: integer("max_retries").notNull().default(0),
    condition: text("condition"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_workflow_steps_workflow").on(t.workflowId, t.sortOrder)],
);

/** Workflows imported into a project — shared, not copied. */
export const projectWorkflows = sqliteTable(
  "project_workflows",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("idx_project_workflows_unique").on(t.projectId, t.workflowId)],
);

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    title: text("title").notNull(),
    /** What the user asked this run to do — injected into every step's context. */
    goal: text("goal"),
    /** "engine" = stepper drives sessions; "terminal" = an interactive claude PTY drives, reporting progress back. */
    mode: text("mode").notNull().default("engine"),
    /** Terminal-mode runs: the claude PTY that drives this run. */
    terminalId: text("terminal_id"),
    /**
     * Snapshot of the steps as they were at start. Editing the workflow later
     * must not rewrite a finished run or change one that's mid-flight.
     */
    definition: text("definition").notNull(),
    status: text("status").notNull().default("pending"),
    currentStepKey: text("current_step_key"),
    cwd: text("cwd").notNull(),
    envSetId: text("env_set_id"),
    useWorktree: integer("use_worktree", { mode: "boolean" }).notNull().default(false),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("idx_workflow_runs_project").on(t.projectId, t.startedAt)],
);

export const workflowRunSteps = sqliteTable(
  "workflow_run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    sessionId: text("session_id"),
    commandRunId: text("command_run_id"),
    note: text("note"),
    error: text("error"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [uniqueIndex("idx_workflow_run_steps_unique").on(t.runId, t.stepKey)],
);

/** Questions an agent raised through workflow_ask, plus the user's answers. */
export const workflowQuestions = sqliteTable(
  "workflow_questions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    runStepId: text("run_step_id").notNull(),
    key: text("key").notNull(),
    question: text("question").notNull(),
    kind: text("kind").notNull().default("text"), // text|choice|bool
    options: text("options"), // JSON string[]
    answer: text("answer"),
    answeredAt: text("answered_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_workflow_questions_run").on(t.runId)],
);

export const workflowArtifacts = sqliteTable(
  "workflow_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    runStepId: text("run_step_id").notNull(),
    kind: text("kind").notNull().default("other"), // plan|doc|report|patch|other
    title: text("title").notNull(),
    path: text("path").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_workflow_artifacts_run").on(t.runId)],
);

/** Per-project opt-in for agents that aren't globally enabled. */
export const projectAgents = sqliteTable(
  "project_agents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("idx_project_agents_unique").on(t.projectId, t.agentId)],
);

export const workHistory = sqliteTable(
  "work_history",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    refId: text("ref_id"),
    summary: text("summary").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_work_history_project").on(t.projectId)],
);

/**
 * Android Studio-style changelists. Git has no such concept — it is an IDE-side
 * grouping of pending changes — so Station stores it. Scoped to one repo path of
 * one project, because the same file path means different things in two repos.
 */
export const gitChangelists = sqliteTable(
  "git_changelists",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Which entry of project_paths this list belongs to. */
    pathId: text("path_id").notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_git_changelists_scope").on(t.projectId, t.pathId)],
);

/**
 * Only files that were actually dragged somewhere get a row — everything else is
 * implicitly in the default group. Keeps this table proportional to what the user
 * organised, not to the size of the repo.
 */
export const gitChangelistFiles = sqliteTable(
  "git_changelist_files",
  {
    id: text("id").primaryKey(),
    changelistId: text("changelist_id")
      .notNull()
      .references(() => gitChangelists.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
  },
  (t) => [uniqueIndex("idx_git_changelist_files_unique").on(t.changelistId, t.path)],
);
