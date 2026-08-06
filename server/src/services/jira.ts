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

async function jiraFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const cfg = jiraConfig();
  // Cloud authenticates with Basic email:apiToken; Server/DC uses a Personal
  // Access Token as a Bearer header (Basic+PAT just returns an HTML 401 page).
  const auth = isServer(cfg)
    ? `Bearer ${cfg.apiToken}`
    : `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64")}`;
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
      return (n.content ?? []).map((c) => adfToMarkdown(c, depth)).join("\n\n").trim();
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

const MY_ISSUES_JQL =
  "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

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
  const data = await jiraFetch<{ issues?: RawIssue[] }>(
    isServer(cfg) ? "/search" : "/search/jql",
    { method: "POST", body },
  );
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
  const data = await jiraFetch<{ transitions?: { id: string; name: string; to?: { name?: string } }[] }>(
    `/issue/${encodeURIComponent(key)}/transitions`,
  );
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

export async function addWorklog(
  key: string,
  timeSpent: string,
  comment?: string,
): Promise<void> {
  const cfg = jiraConfig();
  await jiraFetch(`/issue/${encodeURIComponent(key)}/worklog`, {
    method: "POST",
    body: {
      timeSpent,
      ...(comment ? { comment: isServer(cfg) ? comment : toAdf(comment) } : {}),
    },
  });
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
