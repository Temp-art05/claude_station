import { getContents, githubConfig } from "./gh";
import { getIssue, issueContext, jiraConfig } from "./jira";

/**
 * `@` tags, and what they are actually for.
 *
 * The picker is the small half. The half that matters is here: a tag is resolved
 * on the server *before* the step runs, so the agent is handed the spec and the
 * ticket rather than a pointer to them. Left as a pointer, step one spends a turn
 * fetching — and a turn is the one thing a run has a budget of.
 *
 *   @doc:owner/repo:path/to/spec.md[@ref]   the file's text, read with `gh`
 *   @ticket:ABC-123                          the issue, description as markdown
 *   @jira:ABC                                the project key, for creating issues
 *   @repo:owner/name                         just the name, so prose can say it
 *
 * A GitHub URL pasted whole is accepted too and normalised to `@doc:` — pasting
 * the link is what people actually do.
 */

const TOKEN_RE = /@(doc|ticket|jira|repo):([^\s,;)\]}'"]+)/g;
/** A blob/tree URL from the browser's address bar. */
const BLOB_URL_RE =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:blob|raw)\/([^/\s]+)\/([^\s?#]+)(?:[?#][^\s]*)?/g;

/** Total budget for everything pasted in. A long spec must not crowd out the rest. */
const RESOLVE_CAP = 60_000;

export interface Mention {
  kind: "doc" | "ticket" | "jira" | "repo";
  raw: string;
  value: string;
}

/** Turn pasted GitHub URLs into `@doc:` tags so there is one shape downstream. */
export function normalizeMentions(text: string): string {
  return text.replace(
    BLOB_URL_RE,
    (_m, owner, repo, ref, path) =>
      `@doc:${owner}/${repo}:${path}${ref && ref !== "HEAD" ? `@${ref}` : ""}`,
  );
}

export function findMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const m of normalizeMentions(text).matchAll(TOKEN_RE)) {
    // A tag at the end of a sentence takes the full stop with it, and
    // `@jira:ABC.` then looks up a project that does not exist. Dots inside a
    // value are real (`owner/repo.js`), so only trailing punctuation goes.
    const value = m[2]!.replace(/[.,;:!?]+$/, "");
    if (!value) continue;
    const kind = m[1] as Mention["kind"];
    const raw = `@${kind}:${value}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ kind, raw, value });
  }
  return out;
}

interface Resolved {
  /** Markdown blocks to append to the step's context. */
  blocks: string[];
  /** What could not be read, said plainly rather than left as a silent gap. */
  problems: string[];
}

async function resolveDoc(value: string): Promise<{ block?: string; problem?: string }> {
  // owner/repo:path[@ref]
  const at = value.lastIndexOf("@");
  const ref = at > 0 ? value.slice(at + 1) : "";
  const body = at > 0 ? value.slice(0, at) : value;
  const colon = body.indexOf(":");
  if (colon < 0) return { problem: `@doc:${value} — expected owner/repo:path` };
  const repo = body.slice(0, colon);
  const path = body.slice(colon + 1);
  if (!repo.includes("/") || !path) {
    return { problem: `@doc:${value} — expected owner/repo:path` };
  }

  try {
    const content = await getContents(repo, path, ref);
    if (content.type === "dir") {
      const names = content.entries.map((e) => `${e.name}${e.type === "dir" ? "/" : ""}`);
      return {
        block: [
          `### Directory \`${path}\` in ${repo}`,
          "It is a folder, not a file. It holds:",
          ...names.map((n) => `- ${n}`),
        ].join("\n"),
      };
    }
    if (content.text === null) return { problem: `@doc:${value} — that file is binary` };
    return {
      block: [
        `### Document: ${repo}/${path}${ref ? ` @${ref}` : ""}`,
        content.truncated
          ? "_(truncated — read the rest with the GitHub tools if you need it)_"
          : "",
        "",
        content.text,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  } catch (err) {
    return { problem: `@doc:${value} — ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function resolveTicket(key: string): Promise<{ block?: string; problem?: string }> {
  try {
    return { block: `### Jira ticket\n\n${await issueContext(key)}` };
  } catch (err) {
    return { problem: `@ticket:${key} — ${err instanceof Error ? err.message : String(err)}` };
  }
}

function resolveProject(key: string): { block?: string; problem?: string } {
  const pinned = jiraConfig().projects ?? [];
  const known = pinned.some((p) => p.toUpperCase() === key.toUpperCase());
  return {
    block: [
      `### Jira project \`${key.toUpperCase()}\``,
      known ? "" : "_(not in the pinned list — check the key before creating issues)_",
      "Create issues here with `jira_create_issue` (pass `projectKey`, or `parentKey` for a subtask).",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function resolveRepo(name: string): { block?: string; problem?: string } {
  const known = githubConfig().repos.includes(name);
  return {
    block: `### GitHub repo \`${name}\`${known ? "" : " _(not in the configured repos)_"}`,
  };
}

/**
 * Read everything the text points at. Runs the fetches together — a spec, a
 * ticket and a project is three round trips, and doing them in series is the
 * difference between a step starting now and starting in four seconds.
 */
export async function resolveMentions(text: string): Promise<Resolved> {
  const mentions = findMentions(text);
  if (mentions.length === 0) return { blocks: [], problems: [] };

  const results = await Promise.all(
    mentions.map(async (m) => {
      switch (m.kind) {
        case "doc":
          return resolveDoc(m.value);
        case "ticket":
          return resolveTicket(m.value);
        case "jira":
          return resolveProject(m.value);
        case "repo":
          return resolveRepo(m.value);
      }
    }),
  );

  const blocks: string[] = [];
  const problems: string[] = [];
  let used = 0;
  for (const r of results) {
    if (r.problem) problems.push(r.problem);
    if (!r.block) continue;
    if (used + r.block.length > RESOLVE_CAP) {
      problems.push("Some tagged content was left out — the whole lot would not fit in context.");
      break;
    }
    used += r.block.length;
    blocks.push(r.block);
  }
  return { blocks, problems };
}

/** Look up a ticket without reading its whole context — used by the pickers. */
export async function ticketSummary(key: string): Promise<{ key: string; summary: string }> {
  const issue = await getIssue(key);
  return { key: issue.key, summary: issue.summary };
}
