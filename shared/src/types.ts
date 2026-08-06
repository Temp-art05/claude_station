import { z } from "zod";

// ── Path commands (build/test/lint runner) ────────────────────────────────────
// Declared before projects: a project path carries its commands inline.

export const commandKindSchema = z.enum(["build", "test", "lint", "run", "custom"]);
export type CommandKind = z.infer<typeof commandKindSchema>;

export const pathCommandSchema = z.object({
  id: z.string(),
  projectPathId: z.string(),
  name: z.string(),
  kind: commandKindSchema,
  command: z.string(),
  cwdOverride: z.string().nullable(),
  timeoutSec: z.number().int().positive(),
  sortOrder: z.number().int(),
});
export type PathCommand = z.infer<typeof pathCommandSchema>;

export const pathCommandInputSchema = z.object({
  name: z.string().min(1),
  kind: commandKindSchema.default("custom"),
  command: z.string().min(1),
  cwdOverride: z.string().nullable().default(null),
  timeoutSec: z.number().int().positive().max(24 * 3600).default(900),
});
export type PathCommandInput = z.infer<typeof pathCommandInputSchema>;

export const commandRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  pathCommandId: z.string().nullable(),
  name: z.string(),
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number().nullable(),
  logPath: z.string(),
  origin: z.enum(["ui", "claude"]),
  sessionId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type CommandRun = z.infer<typeof commandRunSchema>;

/** Presets offered when adding a path — user edits before saving. */
export const COMMAND_PRESETS: Record<string, PathCommandInput[]> = {
  ios: [
    {
      name: "Build (Simulator)",
      kind: "build",
      command:
        "xcodebuild -scheme $SCHEME -destination 'platform=iOS Simulator,name=iPhone 16' build",
      cwdOverride: null,
      timeoutSec: 1800,
    },
    {
      name: "Test",
      kind: "test",
      command:
        "xcodebuild -scheme $SCHEME -destination 'platform=iOS Simulator,name=iPhone 16' test",
      cwdOverride: null,
      timeoutSec: 1800,
    },
  ],
  android: [
    { name: "Assemble Debug", kind: "build", command: "./gradlew :app:assembleDebug", cwdOverride: null, timeoutSec: 1800 },
    { name: "Unit Test", kind: "test", command: "./gradlew test", cwdOverride: null, timeoutSec: 1800 },
    { name: "Lint", kind: "lint", command: "./gradlew lint", cwdOverride: null, timeoutSec: 900 },
  ],
  kmp: [
    { name: "Build Shared", kind: "build", command: "./gradlew :shared:build", cwdOverride: null, timeoutSec: 1800 },
    { name: "All Tests", kind: "test", command: "./gradlew :shared:allTests", cwdOverride: null, timeoutSec: 1800 },
  ],
  node: [
    { name: "Build", kind: "build", command: "npm run build", cwdOverride: null, timeoutSec: 900 },
    { name: "Test", kind: "test", command: "npm test", cwdOverride: null, timeoutSec: 900 },
    { name: "Lint", kind: "lint", command: "npm run lint", cwdOverride: null, timeoutSec: 600 },
  ],
};

// ── Projects ──────────────────────────────────────────────────────────────────

export const projectPathSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  path: z.string(),
  /** Home-collapsed form for display (`~/IOS/ReelMe`). */
  displayPath: z.string().optional(),
  label: z.string(),
  description: z.string().default(""),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  /** Default env set for this repo's command runs (UI and Claude's tool). */
  envSetId: z.string().nullable().default(null),
  commands: z.array(pathCommandSchema).default([]),
});
export type ProjectPath = z.infer<typeof projectPathSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
  paths: z.array(projectPathSchema).default([]),
});
export type Project = z.infer<typeof projectSchema>;

export const projectPathInputSchema = z.object({
  /** Accepts `~/…` or a relative path; the server expands + realpaths it. */
  path: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  isDefault: z.boolean().default(false),
  envSetId: z.string().nullable().default(null),
  commands: z.array(pathCommandInputSchema).default([]),
});
export type ProjectPathInput = z.infer<typeof projectPathInputSchema>;

export const projectInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  paths: z.array(projectPathInputSchema).default([]),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

// ── Chat sessions ─────────────────────────────────────────────────────────────

/** Mirrors PermissionMode in @anthropic-ai/claude-agent-sdk 0.3.222 — all 6 values. */
export const permissionModeSchema = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
  "auto",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/** Modes offered in the chat composer; dontAsk/auto stay advanced-only. */
export const PERMISSION_MODE_CHOICES: readonly PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
];

export const chatSessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  sdkSessionId: z.string().nullable(),
  cwd: z.string(),
  envSetId: z.string().nullable(),
  permissionMode: permissionModeSchema,
  model: z.string().nullable(),
  origin: z.string(), // 'manual' | 'jira:KEY' | 'github:pr:N'
  status: z.enum(["idle", "running", "error"]),
  worktreePath: z.string().nullable(),
  kind: z.enum(["chat", "agent", "workflow"]),
  agentName: z.string().nullable(),
  workflowRunStepId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
  live: z.boolean().optional(),
});
export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatSessionInputSchema = z.object({
  title: z.string().optional(),
  seedPrompt: z.string().optional(),
  cwdPathId: z.string().optional(),
  envSetId: z.string().nullable().optional(),
  permissionMode: permissionModeSchema.default("default"),
  model: z.string().nullable().optional(),
  origin: z.string().default("manual"),
  /** Give the session its own git checkout so parallel work can't collide. */
  useWorktree: z.boolean().optional(),
  /** Set to open an agent workspace: that agent runs as the main thread. */
  agentName: z.string().nullable().optional(),
  /** Set by the workflow runner: ties this session to one run step. */
  workflowRunStepId: z.string().nullable().optional(),
  kind: z.enum(["chat", "agent", "workflow"]).optional(),
});
export type ChatSessionInput = z.infer<typeof chatSessionInputSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  role: z.string(), // user|assistant|system|result
  type: z.string(), // raw SDKMessage.type
  content: z.string(), // full SDKMessage JSON
  textPreview: z.string(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

// ── Terminals ─────────────────────────────────────────────────────────────────

export const terminalKindSchema = z.enum(["shell", "claude"]);
export type TerminalKind = z.infer<typeof terminalKindSchema>;

export const terminalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  cwd: z.string(),
  envSetId: z.string().nullable(),
  pid: z.number().nullable(),
  /** shell = plain login shell; claude = runs the `claude` CLI, dies with it. */
  kind: terminalKindSchema.default("shell"),
  /** Command the PTY was started with (app agents) — restart re-runs it. */
  command: z.string().nullable().default(null),
  status: z.enum(["running", "exited", "orphaned"]),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Terminal = z.infer<typeof terminalSchema>;

export const terminalInputSchema = z.object({
  title: z.string().optional(),
  cwdPathId: z.string().optional(),
  cwd: z.string().optional(),
  envSetId: z.string().nullable().optional(),
  kind: terminalKindSchema.optional(),
});
export type TerminalInput = z.infer<typeof terminalInputSchema>;

// ── Env sets ──────────────────────────────────────────────────────────────────

export const envVarSchema = z.object({
  id: z.string(),
  envSetId: z.string(),
  key: z.string(),
  value: z.string(),
  isSecret: z.boolean().default(false),
});
export type EnvVar = z.infer<typeof envVarSchema>;

export const envSetSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(), // null = global set
  name: z.string(),
  description: z.string().default(""),
  createdAt: z.string(),
  vars: z.array(envVarSchema).default([]),
  /** Extra projects this set is shared into, beyond its owner. */
  sharedWith: z.array(z.string()).default([]),
});
export type EnvSet = z.infer<typeof envSetSchema>;

export const envVarInputSchema = z.object({
  key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid env var name"),
  value: z.string(),
  isSecret: z.boolean().default(false),
});
export const envSetInputSchema = z.object({
  projectId: z.string().nullable().default(null),
  name: z.string().min(1),
  description: z.string().default(""),
  vars: z.array(envVarInputSchema).default([]),
  /** Replaced wholesale on save, the same way vars are. */
  sharedWith: z.array(z.string()).default([]),
});
export type EnvSetInput = z.infer<typeof envSetInputSchema>;

// ── Agents (subagents handed to the SDK via options.agents) ───────────────────

/** Model aliases the SDK accepts for a subagent; null/undefined = inherit. */
export const agentModelSchema = z.enum(["inherit", "opus", "sonnet", "haiku", "fable"]);
export type AgentModel = z.infer<typeof agentModelSchema>;

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).nullable(),
  disallowedTools: z.array(z.string()).nullable(),
  skills: z.array(z.string()).nullable(),
  model: z.string().nullable(),
  maxTurns: z.number().int().nullable(),
  background: z.boolean(),
  viewPath: z.string().nullable(),
  /** App agents: URL of the running app's own web UI, iframed in the workspace tab. */
  viewUrl: z.string().nullable(),
  /** App agents: command run in a Station terminal at bundleDir (e.g. "./start.sh"). */
  startCommand: z.string().nullable(),
  /** Companion files from a folder import — readable by the agent's sessions. */
  bundleDir: z.string().nullable(),
  enabledGlobally: z.boolean(),
  source: z.enum(["manual", "imported"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Only present on the per-project listing. */
  enabledForProject: z.boolean().optional(),
});
export type Agent = z.infer<typeof agentSchema>;

export const agentInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers and dashes"),
  description: z.string().min(1, "Describe when Claude should delegate to this agent"),
  prompt: z.string().min(1, "The agent needs a system prompt"),
  tools: z.array(z.string()).nullable().default(null),
  disallowedTools: z.array(z.string()).nullable().default(null),
  skills: z.array(z.string()).nullable().default(null),
  model: z.string().nullable().default(null),
  maxTurns: z.number().int().positive().max(200).nullable().default(null),
  background: z.boolean().default(false),
  /** Path (under the data dir) to a custom .html view for this agent's tab. */
  viewPath: z.string().nullable().default(null),
  /** App agents: URL of the running app's UI (iframed); takes priority over viewPath. */
  viewUrl: z.string().nullable().default(null),
  /** App agents: command run in a Station terminal at the bundle dir. */
  startCommand: z.string().nullable().default(null),
  enabledGlobally: z.boolean().default(false),
});
export type AgentInput = z.infer<typeof agentInputSchema>;

/** Per-file outcome of a folder (batch) import — e.g. a directory of workflows. */
export const folderImportResultSchema = z.object({
  file: z.string(),
  status: z.enum(["imported", "renamed", "skipped", "error"]),
  name: z.string().optional(),
  id: z.string().optional(),
  error: z.string().optional(),
});
export type FolderImportResult = z.infer<typeof folderImportResultSchema>;

export const folderImportSummarySchema = z.object({
  results: z.array(folderImportResultSchema),
});
export type FolderImportSummary = z.infer<typeof folderImportSummarySchema>;

/** Tool names offered in the agent editor — built-ins plus our own MCP server. */
export const AGENT_TOOL_CHOICES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "Task",
  "mcp__station__knowledge_search",
  "mcp__station__memory_list",
  "mcp__station__memory_get",
  "mcp__station__memory_search",
  "mcp__station__memory_write",
  "mcp__station__workflow_ask",
  "mcp__station__workflow_emit_artifact",
  "mcp__station__workflow_note",
  "mcp__station__list_project_commands",
  "mcp__station__run_project_command",
  "mcp__station__read_command_log",
  "mcp__station__excel_list",
  "mcp__station__excel_read",
  "mcp__station__excel_write",
  "mcp__station__jira_search",
  "mcp__station__jira_get_issue",
  "mcp__station__jira_list_transitions",
  "mcp__station__jira_comment",
  "mcp__station__jira_transition",
  "mcp__station__jira_worklog",
] as const;

/** Starting points offered in the "new agent" dialog. */
export const AGENT_PRESETS: (AgentInput & { label: string })[] = [
  {
    label: "Build fixer (mobile)",
    name: "build-fixer",
    description:
      "Use when a build or test command fails. Runs the project's build, reads the log, fixes compile errors, and re-runs until it passes.",
    prompt:
      "You fix broken builds. Start with list_project_commands, run the relevant build or test command, and read the failing output. Fix the smallest thing that makes it compile, then re-run the same command to confirm. Do not refactor beyond the fix, and report the exact error you fixed.",
    tools: [
      "Read",
      "Edit",
      "Glob",
      "Grep",
      "mcp__station__list_project_commands",
      "mcp__station__run_project_command",
      "mcp__station__read_command_log",
    ],
    disallowedTools: null,
    skills: null,
    model: null,
    maxTurns: 40,
    background: false,
    viewPath: null,
    viewUrl: null,
    startCommand: null,
    enabledGlobally: false,
  },
  {
    label: "Docs planner",
    name: "docs-planner",
    description:
      "Use to read docs and code and produce an implementation plan. Asks before assuming; never edits code.",
    prompt:
      "You turn docs into an implementation plan. Read the project's docs and the relevant source first, then write a plan covering both client and server work: what changes, in which files, in what order, and how it will be verified. Anything you are not sure about — scope, auth, offline behaviour, migrations — ask through workflow_ask rather than guessing. Save the plan with workflow_emit_artifact. Never edit code in this role.",
    tools: [
      "Read",
      "Glob",
      "Grep",
      "mcp__station__knowledge_search",
      "mcp__station__memory_get",
      "mcp__station__memory_list",
      "mcp__station__jira_get_issue",
      "mcp__station__workflow_ask",
      "mcp__station__workflow_emit_artifact",
      "mcp__station__workflow_note",
    ],
    disallowedTools: ["Write", "Edit"],
    skills: null,
    model: null,
    maxTurns: 40,
    background: false,
    viewPath: null,
    viewUrl: null,
    startCommand: null,
    enabledGlobally: false,
  },
  {
    label: "Docs writer",
    name: "docs-writer",
    description:
      "Use after decisions are confirmed, to fold them into the project's docs and memory.",
    prompt:
      "You keep the project's written context current. Fold confirmed decisions into the docs and into project memory with memory_write — durable conventions only, not a task log. Keep edits tight and don't restate what the code already says.",
    tools: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "mcp__station__memory_write",
  "mcp__station__workflow_ask",
  "mcp__station__workflow_emit_artifact",
  "mcp__station__workflow_note",
      "mcp__station__memory_list",
      "mcp__station__knowledge_search",
      "mcp__station__workflow_emit_artifact",
      "mcp__station__workflow_note",
    ],
    disallowedTools: null,
    skills: null,
    model: null,
    maxTurns: 30,
    background: false,
    viewPath: null,
    viewUrl: null,
    startCommand: null,
    enabledGlobally: false,
  },
  {
    label: "Implementer",
    name: "impl",
    description: "Use to implement a confirmed plan, then verify with the project's own commands.",
    prompt:
      "You implement a plan that has already been agreed. Follow it; if it turns out to be wrong, say so instead of quietly doing something else. Match the surrounding code's style. When done, run the project's build or test command to check your work, and fix what you broke.",
    tools: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "mcp__station__list_project_commands",
      "mcp__station__run_project_command",
      "mcp__station__read_command_log",
      "mcp__station__workflow_note",
    ],
    disallowedTools: null,
    skills: null,
    model: null,
    maxTurns: 80,
    background: false,
    viewPath: null,
    viewUrl: null,
    startCommand: null,
    enabledGlobally: false,
  },
  {
    label: "Code reviewer",
    name: "reviewer",
    description:
      "Use to review a diff or a set of files before committing. Reports findings only; never edits code.",
    prompt:
      "You review code. Read the changes and report every issue you find, including low-confidence ones, with a severity and a one-line rationale each — a later step filters them. Never edit files. Point at file:line for each finding.",
    tools: ["Read", "Glob", "Grep", "Bash"],
    disallowedTools: ["Write", "Edit"],
    skills: null,
    model: null,
    maxTurns: null,
    background: false,
    viewPath: null,
    viewUrl: null,
    startCommand: null,
    enabledGlobally: false,
  },
  {
    label: "Jira scribe",
    name: "jira-scribe",
    description:
      "Use to write up work into Jira: post a summary comment, move the issue, and log time.",
    prompt:
      "You keep Jira in sync with what actually happened. Read the issue first, then post a concise comment describing the change (what and why, not a diff dump). List transitions before moving an issue, and only log time you were given explicitly.",
    tools: [
      "mcp__station__jira_get_issue",
      "mcp__station__jira_list_transitions",
      "mcp__station__jira_comment",
      "mcp__station__jira_transition",
      "mcp__station__jira_worklog",
    ],
    disallowedTools: null,
    skills: null,
    model: "sonnet",
    maxTurns: 20,
    background: false,
    viewPath: null,
    viewUrl: null,
    startCommand: null,
    enabledGlobally: false,
  },
  {
    label: "Spreadsheet analyst",
    name: "sheet-analyst",
    description:
      "Use for questions about imported spreadsheets, and to produce .xlsx reports from them.",
    prompt:
      "You work with the workspace's spreadsheets. Use excel_list to find them, excel_read to pull rows, and excel_write to produce a new file. State the numbers you used so the result can be checked.",
    tools: [
      "mcp__station__excel_list",
      "mcp__station__excel_read",
      "mcp__station__excel_write",
      "mcp__station__knowledge_search",
  "mcp__station__memory_list",
  "mcp__station__memory_get",
  "mcp__station__memory_search",
  "mcp__station__memory_write",
  "mcp__station__workflow_ask",
  "mcp__station__workflow_emit_artifact",
  "mcp__station__workflow_note",
    ],
    disallowedTools: null,
    skills: null,
    model: null,
    maxTurns: null,
    background: false,
    viewPath: null,
    viewUrl: null,
    startCommand: null,
    enabledGlobally: false,
  },
];

// ── Knowledge library folders ─────────────────────────────────────────────────

/** Suggested folders; any string works, so the list is a starting point. */
export const KNOWLEDGE_FOLDER_SUGGESTIONS = [
  "android",
  "ios",
  "kmp",
  "fe",
  "be",
  "devops",
  "design",
  "process",
] as const;

export const knowledgeFolderSchema = z
  .string()
  .max(60)
  .regex(/^[a-z0-9]([a-z0-9/-]*[a-z0-9])?$|^$/, "Lowercase letters, numbers, dashes and /")
  .default("");

// ── Workflows ─────────────────────────────────────────────────────────────────

export const workflowStepTypeSchema = z.enum(["agent", "command", "confirm", "manual"]);
export type WorkflowStepType = z.infer<typeof workflowStepTypeSchema>;

export const workflowStepSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  sortOrder: z.number().int(),
  key: z.string(),
  type: workflowStepTypeSchema,
  title: z.string(),
  agentName: z.string().nullable(),
  instruction: z.string().nullable(),
  commandName: z.string().nullable(),
  requiresConfirm: z.boolean(),
  permissionMode: permissionModeSchema.nullable(),
  maxRetries: z.number().int(),
  condition: z.string().nullable(),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowStepInputSchema = z.object({
  /** Stable handle used by conditions (`steps.test.failed`) and run bookkeeping. */
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase letters, numbers and dashes"),
  type: workflowStepTypeSchema,
  title: z.string().min(1).max(120),
  agentName: z.string().nullable().default(null),
  instruction: z.string().nullable().default(null),
  commandName: z.string().nullable().default(null),
  requiresConfirm: z.boolean().default(false),
  /** Per step: a long implement step can run at acceptEdits without babysitting. */
  permissionMode: permissionModeSchema.nullable().default(null),
  maxRetries: z.number().int().min(0).max(3).default(0),
  /** `answers.<key> == "x"` · `answers.<key> == true` · `steps.<key>.failed` */
  condition: z.string().nullable().default(null),
});
export type WorkflowStepInput = z.infer<typeof workflowStepInputSchema>;

export const workflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  folder: z.string(),
  source: z.enum(["manual", "imported"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  steps: z.array(workflowStepSchema).default([]),
  /** Set on the per-project listing. */
  imported: z.boolean().optional(),
});
export type Workflow = z.infer<typeof workflowSchema>;

export const workflowInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase letters, numbers and dashes"),
  description: z.string().default(""),
  folder: knowledgeFolderSchema.default(""),
  steps: z.array(workflowStepInputSchema).min(1, "A workflow needs at least one step"),
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

export const workflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_input",
  "done",
  "failed",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export const workflowRunStepStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_input",
  "done",
  "skipped",
  "failed",
  "interrupted",
]);
export type WorkflowRunStepStatus = z.infer<typeof workflowRunStepStatusSchema>;

export const workflowQuestionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  runStepId: z.string(),
  key: z.string(),
  question: z.string(),
  kind: z.enum(["text", "choice", "bool"]),
  options: z.array(z.string()).nullable(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
});
export type WorkflowQuestion = z.infer<typeof workflowQuestionSchema>;

export const workflowArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  runStepId: z.string(),
  kind: z.enum(["plan", "doc", "report", "patch", "other"]),
  title: z.string(),
  path: z.string(),
  createdAt: z.string(),
});
export type WorkflowArtifact = z.infer<typeof workflowArtifactSchema>;

export const workflowRunStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepKey: z.string(),
  status: workflowRunStepStatusSchema,
  attempt: z.number().int(),
  sessionId: z.string().nullable(),
  commandRunId: z.string().nullable(),
  note: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type WorkflowRunStep = z.infer<typeof workflowRunStepSchema>;

export const workflowRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workflowId: z.string(),
  title: z.string(),
  /** What the user asked this run to do — shown to every step's agent. */
  goal: z.string().nullable().default(null),
  /** "engine" = stepper drives; "terminal" = an interactive claude PTY drives. */
  mode: z.enum(["engine", "terminal"]).default("engine"),
  /** Terminal-mode runs: the claude PTY that drives this run. */
  terminalId: z.string().nullable().default(null),
  status: workflowRunStatusSchema,
  currentStepKey: z.string().nullable(),
  cwd: z.string(),
  envSetId: z.string().nullable(),
  useWorktree: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Snapshot taken at start — the run never follows later edits. */
  steps: z.array(workflowStepSchema).default([]),
  runSteps: z.array(workflowRunStepSchema).default([]),
  questions: z.array(workflowQuestionSchema).default([]),
  artifacts: z.array(workflowArtifactSchema).default([]),
  /** True when the source workflow changed after this run started. */
  definitionStale: z.boolean().optional(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const workflowRunInputSchema = z.object({
  workflowId: z.string(),
  title: z.string().optional(),
  /** Free-text goal for this run (e.g. "impl feature v1.5.0 trong spec"). */
  goal: z.string().max(4000).optional(),
  cwdPathId: z.string().optional(),
  envSetId: z.string().nullable().optional(),
  useWorktree: z.boolean().optional(),
});
export type WorkflowRunInput = z.infer<typeof workflowRunInputSchema>;

/** Starting points offered in the workflow library. */
export const WORKFLOW_PRESETS: (WorkflowInput & { label: string })[] = [
  {
    label: "iOS / mobile feature",
    name: "ios-feature",
    description:
      "Read the docs, plan FE+BE, confirm the open questions, update the docs, implement, test, review, report.",
    folder: "ios",
    steps: [
      {
        key: "read-docs",
        type: "agent",
        title: "Read docs and repo",
        agentName: "docs-planner",
        instruction:
          "Read the project's imported docs and the relevant source. Summarise what exists today and what this feature touches. Do not write any files yet.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "default",
        maxRetries: 0,
        condition: null,
      },
      {
        key: "plan",
        type: "agent",
        title: "Plan FE + BE",
        agentName: "docs-planner",
        instruction:
          "Write an implementation plan covering both FE and BE. Save it with workflow_emit_artifact (kind: plan, title: 'Implementation plan'). Anything you are not sure about, ask through workflow_ask instead of guessing — scope, auth approach, offline behaviour, migration needs.",
        commandName: null,
        requiresConfirm: true,
        permissionMode: "default",
        maxRetries: 0,
        condition: null,
      },
      {
        key: "confirm-plan",
        type: "confirm",
        title: "Confirm the plan",
        agentName: null,
        instruction: "Answer the open questions from the plan.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: null,
        maxRetries: 0,
        condition: null,
      },
      {
        key: "update-docs",
        type: "agent",
        title: "Update project docs",
        agentName: "docs-writer",
        instruction:
          "Fold the confirmed decisions into the project's docs and memory. Use memory_write for durable conventions; keep it short.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "acceptEdits",
        maxRetries: 0,
        condition: null,
      },
      {
        key: "impl-be",
        type: "agent",
        title: "Implement backend",
        agentName: "impl",
        instruction: "Implement the backend part of the plan. Follow the plan artifact.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "acceptEdits",
        maxRetries: 0,
        condition: 'answers.scope == "fe-only"',
      },
      {
        key: "impl-fe",
        type: "agent",
        title: "Implement frontend",
        agentName: "impl",
        instruction: "Implement the client part of the plan. Follow the plan artifact.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "acceptEdits",
        maxRetries: 0,
        condition: null,
      },
      {
        key: "test",
        type: "command",
        title: "Run tests",
        agentName: null,
        instruction: null,
        commandName: "Test",
        requiresConfirm: false,
        permissionMode: null,
        maxRetries: 1,
        condition: null,
      },
      {
        key: "fix-tests",
        type: "agent",
        title: "Fix failing tests",
        agentName: "build-fixer",
        instruction:
          "The test command failed. Read the log with read_command_log, fix the smallest thing that makes it pass, then run the test command again.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "acceptEdits",
        maxRetries: 0,
        condition: "steps.test.failed",
      },
      {
        key: "review",
        type: "agent",
        title: "Review the diff",
        agentName: "reviewer",
        instruction: "Review everything changed in this run. Report findings; do not edit.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "default",
        maxRetries: 0,
        condition: null,
      },
      {
        key: "report",
        type: "agent",
        title: "Write up the work",
        agentName: "jira-scribe",
        instruction:
          "Summarise what shipped and save it with workflow_emit_artifact (kind: report). If the session came from a Jira issue, post the same summary as a comment.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "default",
        maxRetries: 0,
        condition: null,
      },
    ],
  },
  {
    label: "Bugfix from a Jira issue",
    name: "bugfix-from-jira",
    description: "Read the ticket, reproduce, fix, test, comment back on the issue.",
    folder: "process",
    steps: [
      {
        key: "read-issue",
        type: "agent",
        title: "Read the issue",
        agentName: "docs-planner",
        instruction:
          "Read the Jira issue this session came from with jira_get_issue, then find the relevant code. State the suspected cause. Ask through workflow_ask if the reproduction steps are unclear.",
        commandName: null,
        requiresConfirm: true,
        permissionMode: "default",
        maxRetries: 0,
        condition: null,
      },
      {
        key: "confirm-cause",
        type: "confirm",
        title: "Confirm the approach",
        agentName: null,
        instruction: null,
        commandName: null,
        requiresConfirm: false,
        permissionMode: null,
        maxRetries: 0,
        condition: null,
      },
      {
        key: "fix",
        type: "agent",
        title: "Fix it",
        agentName: "impl",
        instruction: "Apply the smallest fix that addresses the confirmed cause.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "acceptEdits",
        maxRetries: 0,
        condition: null,
      },
      {
        key: "test",
        type: "command",
        title: "Run tests",
        agentName: null,
        instruction: null,
        commandName: "Test",
        requiresConfirm: false,
        permissionMode: null,
        maxRetries: 1,
        condition: null,
      },
      {
        key: "comment",
        type: "agent",
        title: "Comment on the issue",
        agentName: "jira-scribe",
        instruction: "Post what changed and why on the issue, then move it to review.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "default",
        maxRetries: 0,
        condition: null,
      },
    ],
  },
  {
    label: "Frontend feature",
    name: "fe-feature",
    description: "Plan, confirm, implement, lint and test a client-only change.",
    folder: "fe",
    steps: [
      {
        key: "plan",
        type: "agent",
        title: "Plan the change",
        agentName: "docs-planner",
        instruction:
          "Plan the client change. Save the plan with workflow_emit_artifact and ask anything unclear through workflow_ask.",
        commandName: null,
        requiresConfirm: true,
        permissionMode: "default",
        maxRetries: 0,
        condition: null,
      },
      {
        key: "confirm-plan",
        type: "confirm",
        title: "Confirm the plan",
        agentName: null,
        instruction: null,
        commandName: null,
        requiresConfirm: false,
        permissionMode: null,
        maxRetries: 0,
        condition: null,
      },
      {
        key: "impl",
        type: "agent",
        title: "Implement",
        agentName: "impl",
        instruction: "Implement the confirmed plan.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: "acceptEdits",
        maxRetries: 0,
        condition: null,
      },
      {
        key: "lint",
        type: "command",
        title: "Lint",
        agentName: null,
        instruction: null,
        commandName: "Lint",
        requiresConfirm: false,
        permissionMode: null,
        maxRetries: 0,
        condition: null,
      },
      {
        key: "test",
        type: "command",
        title: "Test",
        agentName: null,
        instruction: null,
        commandName: "Test",
        requiresConfirm: false,
        permissionMode: null,
        maxRetries: 1,
        condition: null,
      },
      {
        key: "manual-check",
        type: "manual",
        title: "Eyeball it in the app",
        agentName: null,
        instruction: "Run the app and confirm the change looks right.",
        commandName: null,
        requiresConfirm: false,
        permissionMode: null,
        maxRetries: 0,
        condition: null,
      },
    ],
  },
];

// ── Project memory ────────────────────────────────────────────────────────────

export const projectMemorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()).nullable(),
  pinned: z.boolean(),
  source: z.enum(["manual", "imported", "claude"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectMemory = z.infer<typeof projectMemorySchema>;

export const projectMemoryInputSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  tags: z.array(z.string()).nullable().default(null),
  /** Pinned memories are injected into every session prompt in full. */
  pinned: z.boolean().default(false),
});
export type ProjectMemoryInput = z.infer<typeof projectMemoryInputSchema>;

// ── App settings (behaviour, editable from UI — plan § Config tier 2) ──────────

export const appSettingsSchema = z.object({
  "ide.command": z.string().default("xed"),
  "permission.timeoutSec": z.number().int().min(5).max(3600).default(120),
  "concurrency.maxTurns": z.number().int().min(1).max(16).default(3),
  "concurrency.repoLock": z.boolean().default(true),
  "log.streamTailBytes": z.number().int().min(4096).default(204800),
  "log.toolTailBytes": z.number().int().min(512).default(8192),
  "prompt.knowledgeIndexBytes": z.number().int().min(512).default(8192),
  "terminal.scrollbackBytes": z.number().int().min(4096).default(204800),
  "notifications.enabled": z.boolean().default(true),
  "git.useWorktreeDefault": z.boolean().default(false),
  "theme.mode": z.enum(["dark", "light"]).default("dark"),
  "theme.accent": z.enum(["teal", "amber", "violet", "emerald"]).default("teal"),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;
export const APP_SETTINGS_DEFAULTS: AppSettings = appSettingsSchema.parse({});
export const appSettingsPatchSchema = appSettingsSchema.partial();
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

// ── Knowledge ─────────────────────────────────────────────────────────────────

export const knowledgeKindSchema = z.enum(["doc", "excel", "skill", "agent"]);
export type KnowledgeKind = z.infer<typeof knowledgeKindSchema>;

export const knowledgeItemSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(), // null = global
  kind: knowledgeKindSchema,
  name: z.string(),
  description: z.string().default(""),
  folder: z.string().default(""),
  originalFilename: z.string(),
  storedPath: z.string(),
  parsedPath: z.string().nullable(),
  sizeBytes: z.number().int().default(0),
  createdAt: z.string(),
  /** True when the item is a global asset attached to the project being viewed. */
  attached: z.boolean().optional(),
});
export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;

// ── Integrations ──────────────────────────────────────────────────────────────

export const jiraConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    /** "cloud" = *.atlassian.net (Basic email+token, API v3, ADF).
     *  "server" = self-hosted Server/DC (Bearer PAT, API v2, plain-text bodies). */
    deployment: z.enum(["cloud", "server"]).default("cloud"),
    email: z.string().email().optional().or(z.literal("")),
    apiToken: z.string().min(1),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.deployment === "cloud" && !cfg.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["email"],
        message: "Email is required for Jira Cloud",
      });
    }
  });
export type JiraConfig = z.infer<typeof jiraConfigSchema>;

export const githubConfigSchema = z.object({
  repos: z.array(z.string()).default([]), // "owner/repo"
});
export type GithubConfig = z.infer<typeof githubConfigSchema>;


// ── Work history ──────────────────────────────────────────────────────────────

export const workHistorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.string(), // session_created | terminal_opened | knowledge_imported | ...
  refId: z.string().nullable(),
  summary: z.string(),
  createdAt: z.string(),
});
export type WorkHistory = z.infer<typeof workHistorySchema>;
