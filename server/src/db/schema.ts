import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    /**
     * JSON string[] of step keys this one waits for. NULL or empty keeps the old
     * meaning — "the step before me" — so every workflow written before the
     * scheduler understood graphs still runs in exactly the same order.
     */
    dependsOn: text("depends_on"),
    /** gate: which step the run goes back to when the check fails. */
    onFail: text("on_fail"),
    /** gate: how many times it may send the run back before giving up. */
    maxLoops: integer("max_loops").notNull().default(0),
    /** Project path label to run in — how two branches reach two repos at once. */
    cwdLabel: text("cwd_label"),
    /** Own worktree, so a sibling branch may touch the same repo. */
    isolate: integer("isolate", { mode: "boolean" }).notNull().default(false),
    /** Writes nothing to the tree, so it needn't wait for one. */
    readOnly: integer("read_only", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_workflow_steps_workflow").on(t.workflowId, t.sortOrder)],
);

/**
 * What a workflow asks for before it runs.
 *
 * The difference between an asset and a draft: without these, pointing the same
 * workflow at a different spec meant editing a step's instruction, so nobody
 * reused one — they copied it.
 */
export const workflowInputs = sqliteTable(
  "workflow_inputs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Referenced as {{key}} in step instructions and in the run's goal. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** text|choice|docs|jira-project|jira-ticket|repo|path — decides the widget
     * and, for `docs`/`jira-ticket`, what the server fetches before step one. */
    type: text("type").notNull().default("text"),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    defaultValue: text("default_value").notNull().default(""),
    help: text("help").notNull().default(""),
    options: text("options"), // JSON string[] for choice
  },
  (t) => [uniqueIndex("idx_workflow_inputs_unique").on(t.workflowId, t.key)],
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
    /** Unattended: no gate that exists only to make a human press Continue. */
    autoMode: integer("auto_mode", { mode: "boolean" }).notNull().default(false),
    /** stop | assume — what an unattended run does with a real question. */
    askPolicy: text("ask_policy").notNull().default("stop"),
    /**
     * When an unattended run must give up. A run with nobody watching needs a
     * clock, or a step that hangs holds a repo lock until someone notices.
     */
    deadlineAt: text("deadline_at"),
    /** Assumptions an `assume` run made, so the PR can carry them. */
    assumptions: text("assumptions"),
    /** JSON: what the declared inputs were filled with, snapshotted at start. */
    inputs: text("inputs"),
    /** What started it: manual, or the trigger row that picked the work up. */
    triggerId: text("trigger_id"),
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
    /** gate: times this check sent the run back. Separate from `attempt`, which
     * counts re-runs of the step itself — the two caps must not multiply. */
    loops: integer("loops").notNull().default(0),
    sessionId: text("session_id"),
    /**
     * The `claude` terminal this step ran in. Steps run in a real PTY so the work
     * can be watched as it happens, and the run view needs the id to show it.
     */
    terminalId: text("terminal_id"),
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

/**
 * A standing order: work of this shape shows up, this workflow starts.
 *
 * The difference between a workflow someone runs and a workflow that runs. It is
 * a row per project rather than one global setting because the label that means
 * "do this one automatically" is never the same twice across repos.
 *
 * `lastSeenKey` and the `workflow_trigger_seen` table below are what stop the
 * same ticket from being picked up twice — the failure mode every polling
 * integration hits, and the one that costs a duplicate PR when it does.
 */
export const workflowTriggers = sqliteTable(
  "workflow_triggers",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    source: text("source").notNull(), // github|jira
    /** A label for github, a JQL for jira. */
    query: text("query").notNull(),
    /** github only: owner/repo, or NULL for every repo in Integrations. */
    repo: text("repo"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    autoMode: integer("auto_mode", { mode: "boolean" }).notNull().default(true),
    askPolicy: text("ask_policy").notNull().default("stop"),
    pollSeconds: integer("poll_seconds").notNull().default(120),
    cwdPathId: text("cwd_path_id"),
    envSetId: text("env_set_id"),
    /** JSON: input values a picked-up run starts with. */
    inputs: text("inputs"),
    lastPolledAt: text("last_polled_at"),
    lastSeenKey: text("last_seen_key"),
    status: text("status").notNull().default("idle"), // idle|ok|error|disabled
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_workflow_triggers_project").on(t.projectId)],
);

/**
 * One row per piece of work a trigger has already taken. Keyed by the item *and*
 * its last update, so a ticket edited after its run finished can legitimately
 * come round again while an edit mid-run cannot start a second one.
 */
export const workflowTriggerSeen = sqliteTable(
  "workflow_trigger_seen",
  {
    id: text("id").primaryKey(),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => workflowTriggers.id, { onDelete: "cascade" }),
    /** `<source>:<repo|project>:<id>` — stable across polls. */
    itemKey: text("item_key").notNull(),
    /** The item's own updated-at when it was taken. */
    itemUpdatedAt: text("item_updated_at"),
    runId: text("run_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_workflow_trigger_seen_unique").on(t.triggerId, t.itemKey)],
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

/**
 * One agent turn: a user prompt and everything the agent did answering it.
 *
 * The unit every provenance question actually asks about — "which session wrote
 * this file", "what did that turn cost", "what was running in this repo at 14:22"
 * — and the unit a commit gets attributed to. Message-level records already exist
 * in `chat_messages`; they can't answer any of those without parsing every row.
 *
 * Filled from both surfaces: the Agent SDK in process, and the `claude` CLI's own
 * transcripts under ~/.claude/projects, tailed. The transcript stays the source of
 * truth — this table is an index over it and can be rebuilt at any time, so a
 * parser bug means reindex, not migrate.
 */
export const sessionTurns = sqliteTable(
  "session_turns",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** sdk | cli — which surface produced this turn. */
    sourceKind: text("source_kind").notNull(),
    chatSessionId: text("chat_session_id").references(() => chatSessions.id, {
      onDelete: "cascade",
    }),
    /**
     * The `claude` CLI conversation this turn belongs to. Deliberately NOT a
     * foreign key: a transcript outlives — and often predates — any `terminals`
     * row, which is exactly what the History panel's "From the CLI" section
     * lists. Keying it to a row would mean inventing rows for conversations this
     * app never opened, and closing a tab would cascade the history away.
     */
    claudeSessionId: text("claude_session_id"),
    /** The tab, when one is known. NULL for turns recovered from a transcript. */
    terminalId: text("terminal_id").references(() => terminals.id, { onDelete: "set null" }),
    /**
     * Set when the turn ran as a workflow step. Filled from the start even though
     * nothing reads it yet: it is what makes "which commits did this run produce"
     * a query instead of a migration.
     */
    workflowRunId: text("workflow_run_id"),
    /** Turn number within its session, 1-based. */
    seq: integer("seq").notNull(),
    /** Repo path, or the session's own worktree — where the turn actually ran. */
    cwd: text("cwd").notNull(),
    gitBranch: text("git_branch"),
    model: text("model"),
    /** The user's prompt in full, redacted. Short, and the most valuable field here. */
    promptText: text("prompt_text").notNull().default(""),
    promptPreview: text("prompt_preview").notNull().default(""),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreateTokens: integer("cache_create_tokens").notNull().default(0),
    /**
     * Only the SDK reports a cost (`result.total_cost_usd`). CLI transcripts carry
     * none — measured, not assumed — so this stays NULL for them rather than being
     * derived from a price table that would silently rot every old number.
     */
    costUsd: real("cost_usd"),
    durationMs: integer("duration_ms"),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    status: text("status").notNull().default("running"), // running|done|error|interrupted
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => [
    index("idx_session_turns_project").on(t.projectId, t.startedAt),
    index("idx_session_turns_chat").on(t.chatSessionId, t.seq),
    // SQLite treats NULLs as distinct here, so SDK turns (no CLI id) don't collide.
    uniqueIndex("idx_session_turns_cli_seq").on(t.claudeSessionId, t.seq),
  ],
);

/** A file one turn touched. */
export const sessionFiles = sqliteTable(
  "session_files",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => sessionTurns.id, { onDelete: "cascade" }),
    /** Denormalised: "who wrote this file" is then one indexed lookup, not a join. */
    projectId: text("project_id").notNull(),
    projectPathId: text("project_path_id").references(() => projectPaths.id, {
      onDelete: "set null",
    }),
    absPath: text("abs_path").notNull(),
    relPath: text("rel_path").notNull().default(""),
    op: text("op").notNull(), // read|write|delete
    /**
     * Where the claim comes from, and they are not equally trustworthy:
     *   tree — the git working tree really changed across the turn. Ground truth.
     *   tool — an Edit/Write tool call said so. A hint only: measured on 224
     *          transcripts, an edit made through Bash (`sed -i`, heredoc, `tee`)
     *          appears in neither the tool calls nor the CLI's own file history.
     */
    source: text("source").notNull(), // tree|tool
    toolName: text("tool_name"),
  },
  (t) => [
    index("idx_session_files_path").on(t.projectId, t.absPath),
    index("idx_session_files_turn").on(t.turnId),
  ],
);

/**
 * Follower bookkeeping, one row per CLI conversation. SDK sessions need none —
 * they are captured in process.
 *
 * `byteOffset` is what makes capture survive a restart, and a tmux session the
 * user carried on with in Terminal.app while the server was down: the CLI keeps
 * appending, and the follower picks up where it left off instead of reparsing a
 * file that can be 29MB. `mtimeMs`/`sizeBytes` let a boot scan skip everything
 * nothing was appended to.
 */
export const sessionCapture = sqliteTable("session_capture", {
  claudeSessionId: text("claude_session_id").primaryKey(),
  projectId: text("project_id"),
  terminalId: text("terminal_id"),
  /** NULL once the CLI (or the History panel) has pruned the transcript. */
  transcriptPath: text("transcript_path"),
  byteOffset: integer("byte_offset").notNull().default(0),
  mtimeMs: integer("mtime_ms").notNull().default(0),
  sizeBytes: integer("size_bytes").notNull().default(0),
  lastEventAt: text("last_event_at"),
  updatedAt: text("updated_at").notNull(),
  status: text("status").notNull().default("ok"), // ok|degraded|stopped
  /** Why it is not ok, in words the Doctor panel can show as-is. */
  detail: text("detail"),
});

/**
 * A commit, linked back to the turn that produced it.
 *
 * What a commit message cannot tell you: which session made it, what it was asked,
 * and why the change looks like that. Commits are observed rather than intercepted
 * (no git hook is installed in the user's repo), so one made from a terminal, from
 * Xcode, or while this app was closed still gets a row.
 *
 * `confidence` is part of the record, not a detail: an attribution that is only
 * probable must say so, and one that cannot be made says `orphan` rather than
 * guessing. A badge that is wrong is worse than no badge.
 */
export const checkpoints = sqliteTable(
  "checkpoints",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    projectPathId: text("project_path_id").references(() => projectPaths.id, {
      onDelete: "set null",
    }),
    /** The main checkout, never a worktree of it — one row per commit per repo. */
    repoPath: text("repo_path").notNull(),
    commitSha: text("commit_sha").notNull(),
    /**
     * `git patch-id --stable`: a hash of what the diff does. Survives `--amend`
     * and rebase, which both mint a new sha, and is how a checkpoint re-points
     * instead of breaking. NULL for a merge commit, which has no single patch.
     */
    patchId: text("patch_id"),
    committedAt: text("committed_at").notNull(),
    subject: text("subject").notNull().default(""),
    author: text("author").notNull().default(""),
    turnId: text("turn_id").references(() => sessionTurns.id, { onDelete: "set null" }),
    /** Denormalised so "every commit of this session" needs no join. */
    chatSessionId: text("chat_session_id"),
    claudeSessionId: text("claude_session_id"),
    confidence: text("confidence").notNull().default("orphan"), // exact|inferred|orphan
    /** 0..1, meaningful for `inferred`; the tooltip shows it. */
    score: real("score"),
    /** Why it was attributed, or why it could not be — shown as-is in the UI. */
    reason: text("reason").notNull().default(""),
    /** The sha this checkpoint pointed at before a rewrite re-pointed it. */
    supersededSha: text("superseded_sha"),
    detectedAt: text("detected_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_checkpoints_commit").on(t.repoPath, t.commitSha),
    index("idx_checkpoints_project").on(t.projectId, t.committedAt),
    index("idx_checkpoints_patch").on(t.patchId),
    index("idx_checkpoints_turn").on(t.turnId),
  ],
);

/**
 * How far commit ingestion has read in each repo.
 *
 * This is what catches commits made while the server was down: boot reads the
 * cursor and asks git for everything after it, instead of trusting that it saw
 * every ref change as it happened.
 */
export const repoCursors = sqliteTable("repo_cursors", {
  repoPath: text("repo_path").primaryKey(),
  lastSeenSha: text("last_seen_sha"),
  lastScanAt: text("last_scan_at").notNull(),
  status: text("status").notNull().default("ok"), // ok|degraded|stopped
  detail: text("detail"),
});
