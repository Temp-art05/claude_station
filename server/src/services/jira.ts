import { eq } from "drizzle-orm";
import { jiraConfigSchema, type JiraConfig } from "@claude-station/shared";
import { db, schema } from "../db";
import { badRequest } from "../lib/path-safety";

export function jiraConfig(): JiraConfig {
  const row = db
    .select()
    .from(schema.integrations)
    .where(eq(schema.integrations.kind, "jira"))
    .get();
  if (!row) throw badRequest("Jira is not configured (Settings → Jira)");
  return jiraConfigSchema.parse(JSON.parse(row.config));
}

function isServer(cfg: JiraConfig): boolean {
  return cfg.deployment === "server";
}

/** Cloud speaks REST v3; Server/DC only has v2. Paths passed to jiraFetch are
 *  version-less (e.g. "/issue/KEY-1") and get the right prefix here. */
function apiPath(cfg: JiraConfig, path: string): string {
  return `/rest/api/${isServer(cfg) ? "2" : "3"}${path}`;
}

/** Cloud authenticates with Basic email:apiToken; Server/DC uses a Personal
 *  Access Token as a Bearer header (Basic+PAT just returns an HTML 401 page). */
function authHeader(cfg: JiraConfig): string {
  return isServer(cfg)
    ? `Bearer ${cfg.apiToken}`
    : `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64")}`;
}

async function jiraFetch<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const cfg = jiraConfig();
  const auth = authHeader(cfg);
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}${apiPath(cfg, path)}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: auth,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Jira ${res.status}: ${text.slice(0, 300)}`), {
      statusCode: res.status === 401 || res.status === 403 ? 400 : 502,
    });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Sprints live on a different API from everything else: `/rest/agile/1.0`, the
 * same path on Cloud and on Server/DC. It can also be switched off entirely on a
 * self-hosted instance, which is why a 404 here is reported as "this Jira has no
 * Agile API" rather than being left to read as "there are no sprints".
 */
async function jiraAgileFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const cfg = jiraConfig();
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/rest/agile/1.0${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: authHeader(cfg),
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404 && path.startsWith("/board")) {
      throw Object.assign(
        new Error("This Jira has no Agile API (boards and sprints) at /rest/agile/1.0"),
        { statusCode: 400 },
      );
    }
    throw Object.assign(new Error(`Jira agile ${res.status}: ${text.slice(0, 300)}`), {
      statusCode: res.status === 401 || res.status === 403 ? 400 : 502,
    });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── ADF → markdown ────────────────────────────────────────────────────────────
// Jira returns Atlassian Document Format; Claude and the UI both want text.

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type?: string }[];
}

export function adfToMarkdown(node: unknown, depth = 0): string {
  if (!node || typeof node !== "object") return "";
  const n = node as AdfNode;
  const kids = () => (n.content ?? []).map((c) => adfToMarkdown(c, depth + 1)).join("");

  switch (n.type) {
    case "doc":
      return (n.content ?? [])
        .map((c) => adfToMarkdown(c, depth))
        .join("\n\n")
        .trim();
    case "paragraph":
      return kids();
    case "text": {
      let text = n.text ?? "";
      for (const mark of n.marks ?? []) {
        if (mark.type === "strong") text = `**${text}**`;
        else if (mark.type === "em") text = `*${text}*`;
        else if (mark.type === "code") text = `\`${text}\``;
        else if (mark.type === "strike") text = `~~${text}~~`;
      }
      return text;
    }
    case "hardBreak":
      return "\n";
    case "heading": {
      const level = Number(n.attrs?.level ?? 1);
      return `${"#".repeat(Math.min(6, level))} ${kids()}`;
    }
    case "bulletList":
    case "orderedList":
      return (n.content ?? [])
        .map((item, i) => {
          const bullet = n.type === "orderedList" ? `${i + 1}.` : "-";
          return `${"  ".repeat(Math.max(0, depth - 1))}${bullet} ${adfToMarkdown(item, depth + 1).trim()}`;
        })
        .join("\n");
    case "listItem":
      return kids();
    case "codeBlock":
      return `\`\`\`${String(n.attrs?.language ?? "")}\n${kids()}\n\`\`\``;
    case "blockquote":
      return kids()
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    case "mediaSingle":
    case "mediaGroup":
      return "[attachment]";
    case "inlineCard":
      return String(n.attrs?.url ?? "[link]");
    case "mention":
      return `@${String(n.attrs?.text ?? "user").replace(/^@/, "")}`;
    case "emoji":
      return String(n.attrs?.text ?? "");
    case "table":
    case "tableRow":
    case "tableCell":
    case "tableHeader":
      return kids();
    default:
      return kids();
  }
}

function toAdf(markdownish: string): AdfNode {
  return {
    type: "doc",
    version: 1,
    content: markdownish.split(/\n{2,}/).map((para) => ({
      type: "paragraph",
      content: para
        .split("\n")
        .flatMap((line, i) =>
          i === 0
            ? [{ type: "text", text: line }]
            : [{ type: "hardBreak" }, { type: "text", text: line }],
        )
        .filter((b) => b.type === "hardBreak" || (b as AdfNode).text !== ""),
    })),
  } as AdfNode;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface JiraIssueSummary {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority: string | null;
  assignee: string | null;
  updated: string;
  url: string;
}

interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string };
    updated?: string;
    description?: unknown;
    reporter?: { displayName?: string };
    labels?: string[];
  };
}

function toSummary(issue: RawIssue, baseUrl: string): JiraIssueSummary {
  return {
    key: issue.key,
    summary: issue.fields.summary ?? "",
    status: issue.fields.status?.name ?? "Unknown",
    issueType: issue.fields.issuetype?.name ?? "Task",
    priority: issue.fields.priority?.name ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
    updated: issue.fields.updated ?? "",
    url: `${baseUrl.replace(/\/$/, "")}/browse/${issue.key}`,
  };
}

const MY_ISSUES_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

// Operators/keywords that mean the user typed real JQL, not a search phrase.
const JQL_HINT = /[=~<>!]|\b(AND|OR|NOT|ORDER\s+BY|IS|IN|WAS|CHANGED|EMPTY)\b/i;
// Bare issue keys jump straight to that ticket.
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]+-\d+$/;

/** The search box takes plain text; JQL still passes through untouched. */
function toJql(query: string): string {
  const q = query.trim();
  if (!q) return MY_ISSUES_JQL;
  if (ISSUE_KEY.test(q)) return `key = "${q.toUpperCase()}"`;
  if (JQL_HINT.test(q)) return q;
  const esc = q.replace(/(["\\])/g, "\\$1");
  return `text ~ "${esc}" ORDER BY updated DESC`;
}

export async function searchIssues(jql?: string, limit = 50): Promise<JiraIssueSummary[]> {
  const cfg = jiraConfig();
  const body = {
    jql: toJql(jql ?? ""),
    maxResults: limit,
    fields: ["summary", "status", "issuetype", "priority", "assignee", "updated"],
  };
  // Same request body, different endpoint name: v3 renamed /search to /search/jql.
  const data = await jiraFetch<{ issues?: RawIssue[] }>(isServer(cfg) ? "/search" : "/search/jql", {
    method: "POST",
    body,
  });
  return (data.issues ?? []).map((i) => toSummary(i, cfg.baseUrl));
}

export async function getIssue(key: string) {
  const cfg = jiraConfig();
  const issue = await jiraFetch<RawIssue>(
    `/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype,priority,assignee,reporter,updated,description,labels`,
  );
  return {
    ...toSummary(issue, cfg.baseUrl),
    reporter: issue.fields.reporter?.displayName ?? null,
    labels: issue.fields.labels ?? [],
    // Server/DC (v2) returns description as a wiki-markup string; Cloud as ADF.
    description:
      typeof issue.fields.description === "string"
        ? issue.fields.description
        : adfToMarkdown(issue.fields.description),
  };
}

export async function getTransitions(key: string) {
  const data = await jiraFetch<{
    transitions?: { id: string; name: string; to?: { name?: string } }[];
  }>(`/issue/${encodeURIComponent(key)}/transitions`);
  return (data.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name ?? "" }));
}

export async function addComment(key: string, body: string): Promise<void> {
  // v2 takes the comment as a plain string; v3 wants ADF.
  const payload = isServer(jiraConfig()) ? body : toAdf(body);
  await jiraFetch(`/issue/${encodeURIComponent(key)}/comment`, {
    method: "POST",
    body: { body: payload },
  });
}

export async function transitionIssue(
  key: string,
  target: { transitionId?: string; statusName?: string },
): Promise<string> {
  let id = target.transitionId;
  let label = id ?? "";
  if (!id) {
    if (!target.statusName) throw badRequest("Provide transitionId or statusName");
    const transitions = await getTransitions(key);
    const match = transitions.find(
      (t) =>
        t.name.toLowerCase() === target.statusName!.toLowerCase() ||
        t.to.toLowerCase() === target.statusName!.toLowerCase(),
    );
    if (!match) {
      throw badRequest(
        `No transition to "${target.statusName}". Available: ${transitions
          .map((t) => `${t.name}→${t.to}`)
          .join(", ")}`,
      );
    }
    id = match.id;
    label = `${match.name}→${match.to}`;
  }
  await jiraFetch(`/issue/${encodeURIComponent(key)}/transitions`, {
    method: "POST",
    body: { transition: { id } },
  });
  return label;
}

export async function addWorklog(key: string, timeSpent: string, comment?: string): Promise<void> {
  const cfg = jiraConfig();
  await jiraFetch(`/issue/${encodeURIComponent(key)}/worklog`, {
    method: "POST",
    body: {
      timeSpent,
      ...(comment ? { comment: isServer(cfg) ? comment : toAdf(comment) } : {}),
    },
  });
}

export interface JiraProject {
  key: string;
  name: string;
  /** True when it is one of the keys pinned in Integrations. */
  pinned: boolean;
}

/**
 * Every project this account can see.
 *
 * Cloud paginates `/project/search`; Server/DC returns the lot from `/project`.
 * Both are asked for here rather than guessed from ticket keys, which is what
 * had to happen before: no list meant no way to create an issue that wasn't a
 * subtask of something already open.
 */
export async function listProjects(): Promise<JiraProject[]> {
  const cfg = jiraConfig();
  const pinned = new Set((cfg.projects ?? []).map((p) => p.toUpperCase()));
  const rows: { key?: string; name?: string }[] = isServer(cfg)
    ? await jiraFetch<{ key?: string; name?: string }[]>("/project")
    : ((
        await jiraFetch<{ values?: { key?: string; name?: string }[] }>(
          "/project/search?maxResults=200",
        )
      ).values ?? []);

  return rows
    .filter((p) => p.key)
    .map((p) => ({
      key: String(p.key),
      name: p.name ?? String(p.key),
      pinned: pinned.has(String(p.key).toUpperCase()),
    }))
    .sort((a, b) => (a.pinned === b.pinned ? a.key.localeCompare(b.key) : a.pinned ? -1 : 1));
}

/**
 * The issue types this project offers, and which of them is a subtask.
 *
 * Asked rather than assumed: "Sub-task", "Subtask" and "Sub-Task" are all real
 * spellings across the Jira instances we talk to, and a hardcoded guess fails
 * with an error that reads like the ticket is at fault.
 */
export async function projectIssueTypes(
  projectKey: string,
): Promise<{ id: string; name: string; subtask: boolean }[]> {
  const data = await jiraFetch<{
    projects?: { issuetypes?: { id: string; name: string; subtask?: boolean }[] }[];
  }>(`/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes`);
  return (data.projects?.[0]?.issuetypes ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    subtask: t.subtask === true,
  }));
}

export interface CreateIssueInput {
  /** Omit when `parentKey` is given — the parent's project is the right one. */
  projectKey?: string;
  summary: string;
  description?: string;
  /** Makes the new issue a subtask of this one. */
  parentKey?: string;
  /** Defaults to the project's subtask type when there's a parent, else Task. */
  issueType?: string;
  labels?: string[];
}

/**
 * Create an issue — the piece that turns "break this requirement into tasks"
 * into something the board can show, rather than a list inside one comment.
 */
export async function createIssue(input: CreateIssueInput): Promise<{ key: string; url: string }> {
  const cfg = jiraConfig();
  const projectKey = (input.projectKey ?? input.parentKey?.split("-")[0] ?? "").toUpperCase();
  if (!projectKey) throw badRequest("Provide projectKey, or a parentKey to take it from");

  let issueType = input.issueType;
  if (!issueType) {
    const types = await projectIssueTypes(projectKey);
    const wanted = input.parentKey
      ? types.find((t) => t.subtask)
      : (types.find((t) => !t.subtask && t.name.toLowerCase() === "task") ??
        types.find((t) => !t.subtask));
    if (!wanted) {
      throw badRequest(
        `No ${input.parentKey ? "subtask" : "task"} issue type in ${projectKey}. Available: ${types
          .map((t) => t.name)
          .join(", ")}`,
      );
    }
    issueType = wanted.name;
  }

  const data = await jiraFetch<{ key?: string }>("/issue", {
    method: "POST",
    body: {
      fields: {
        project: { key: projectKey },
        summary: input.summary,
        issuetype: { name: issueType },
        ...(input.parentKey ? { parent: { key: input.parentKey.toUpperCase() } } : {}),
        ...(input.description
          ? { description: isServer(cfg) ? input.description : toAdf(input.description) }
          : {}),
        ...(input.labels?.length ? { labels: input.labels } : {}),
      },
    },
  });
  if (!data.key) throw badRequest("Jira accepted the issue but returned no key");
  return { key: data.key, url: `${cfg.baseUrl.replace(/\/$/, "")}/browse/${data.key}` };
}

export interface UpdateIssueInput {
  summary?: string;
  description?: string;
  labels?: string[];
  /** Account id on Cloud, username on Server/DC. `null` unassigns. */
  assignee?: string | null;
}

export async function updateIssue(key: string, input: UpdateIssueInput): Promise<void> {
  const cfg = jiraConfig();
  const fields: Record<string, unknown> = {};
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.description !== undefined) {
    fields.description = isServer(cfg) ? input.description : toAdf(input.description);
  }
  if (input.labels !== undefined) fields.labels = input.labels;
  if (input.assignee !== undefined) {
    // The two deployments name the same field differently, and sending the wrong
    // one is accepted and silently ignored rather than rejected.
    fields.assignee =
      input.assignee === null
        ? null
        : isServer(cfg)
          ? { name: input.assignee }
          : { accountId: input.assignee };
  }
  if (Object.keys(fields).length === 0) throw badRequest("Nothing to update");
  await jiraFetch(`/issue/${encodeURIComponent(key)}`, { method: "PUT", body: { fields } });
}

// ── Sprints ───────────────────────────────────────────────────────────────────

export interface JiraBoard {
  id: number;
  name: string;
  type: string;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  boardId: number;
}

/**
 * Boards for a project. Sprints hang off a board, not off a project, which is
 * the detail that makes "create the ticket in this sprint" a two-step lookup
 * rather than one field.
 */
export async function listBoards(projectKey: string): Promise<JiraBoard[]> {
  const data = await jiraAgileFetch<{ values?: { id: number; name?: string; type?: string }[] }>(
    `/board?projectKeyOrId=${encodeURIComponent(projectKey)}`,
  );
  return (data.values ?? []).map((b) => ({
    id: b.id,
    name: b.name ?? String(b.id),
    type: b.type ?? "scrum",
  }));
}

/**
 * Open sprints for a project — active first, then future.
 *
 * Closed sprints are left out on purpose: they are not somewhere new work can go,
 * and offering them turns a picker into a way to file a ticket where nobody will
 * look at it. A project with no scrum board simply has none, which is a fact the
 * caller has to state rather than treat as an error.
 */
export async function listSprints(projectKey: string): Promise<JiraSprint[]> {
  const boards = await listBoards(projectKey);
  const scrum = boards.filter((b) => b.type !== "kanban");
  const out: JiraSprint[] = [];
  for (const board of scrum) {
    try {
      const data = await jiraAgileFetch<{
        values?: { id: number; name?: string; state?: string }[];
      }>(`/board/${board.id}/sprint?state=active,future`);
      for (const s of data.values ?? []) {
        out.push({
          id: s.id,
          name: s.name ?? String(s.id),
          state: s.state ?? "future",
          boardId: board.id,
        });
      }
    } catch {
      // A board that refuses its sprints (kanban in disguise, or no permission)
      // must not take the other boards down with it.
    }
  }
  return out.sort((a, b) => (a.state === b.state ? a.id - b.id : a.state === "active" ? -1 : 1));
}

/**
 * Find a sprint by name, or make one. Reusing an existing name is the default
 * because the alternative — two sprints called "Sprint 12" — is a mess nobody
 * notices until standup.
 */
export async function ensureSprint(
  projectKey: string,
  name: string,
): Promise<{ sprint: JiraSprint; created: boolean }> {
  const existing = await listSprints(projectKey);
  const match = existing.find((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (match) return { sprint: match, created: false };

  const boards = await listBoards(projectKey);
  const board = boards.find((b) => b.type !== "kanban");
  if (!board) {
    throw badRequest(
      `${projectKey} has no scrum board, so it has no sprints — create the issues in the backlog instead`,
    );
  }
  const created = await jiraAgileFetch<{ id: number; name?: string; state?: string }>("/sprint", {
    method: "POST",
    body: { name: name.trim(), originBoardId: board.id },
  });
  return {
    sprint: {
      id: created.id,
      name: created.name ?? name,
      state: created.state ?? "future",
      boardId: board.id,
    },
    created: true,
  };
}

/** Move issues into a sprint. Jira takes at most 50 per call. */
export async function addIssuesToSprint(sprintId: number, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 50) {
    await jiraAgileFetch(`/sprint/${sprintId}/issue`, {
      method: "POST",
      body: { issues: keys.slice(i, i + 50) },
    });
  }
}

/** Seed text for a "Work on this with Claude" session. */
export async function issueContext(key: string): Promise<string> {
  const issue = await getIssue(key);
  return [
    `# Jira ${issue.key}: ${issue.summary}`,
    `Type: ${issue.issueType} · Status: ${issue.status}${
      issue.priority ? ` · Priority: ${issue.priority}` : ""
    }`,
    issue.assignee ? `Assignee: ${issue.assignee}` : "",
    issue.labels.length ? `Labels: ${issue.labels.join(", ")}` : "",
    issue.url,
    "",
    "## Description",
    issue.description || "(empty)",
  ]
    .filter(Boolean)
    .join("\n");
}
