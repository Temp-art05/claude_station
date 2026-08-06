import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { githubConfigSchema, type GithubConfig } from "@claude-station/shared";
import { db, schema } from "../db";
import { badRequest } from "../lib/path-safety";

const exec = promisify(execFile);

export function githubConfig(): GithubConfig {
  const row = db
    .select()
    .from(schema.integrations)
    .where(eq(schema.integrations.kind, "github"))
    .get();
  if (!row) return { repos: [] };
  return githubConfigSchema.parse(JSON.parse(row.config));
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** `gh` is invoked with an argv array, and the repo shape is validated first. */
async function gh<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await exec("gh", args, {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout || "[]") as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT")) {
      throw badRequest("gh CLI not found on PATH — install it and run `gh auth login`");
    }
    throw Object.assign(new Error(`gh failed: ${message.slice(0, 400)}`), { statusCode: 502 });
  }
}

function assertRepo(repo: string): string {
  if (!REPO_RE.test(repo)) throw badRequest(`Invalid repo: ${repo} (expected owner/name)`);
  return repo;
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  url: string;
}

export async function listPulls(repo: string, limit = 30): Promise<PullRequest[]> {
  const raw = await gh<
    {
      number: number;
      title: string;
      state: string;
      isDraft: boolean;
      author?: { login?: string };
      headRefName: string;
      baseRefName: string;
      updatedAt: string;
      url: string;
    }[]
  >([
    "pr",
    "list",
    "--repo",
    assertRepo(repo),
    "--limit",
    String(limit),
    "--state",
    "open",
    "--json",
    "number,title,state,isDraft,author,headRefName,baseRefName,updatedAt,url",
  ]);
  return raw.map((p) => ({ ...p, author: p.author?.login ?? "unknown" }));
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  updatedAt: string;
  url: string;
}

export async function listIssues(repo: string, limit = 30): Promise<Issue[]> {
  const raw = await gh<
    {
      number: number;
      title: string;
      state: string;
      author?: { login?: string };
      labels?: { name?: string }[];
      updatedAt: string;
      url: string;
    }[]
  >([
    "issue",
    "list",
    "--repo",
    assertRepo(repo),
    "--limit",
    String(limit),
    "--state",
    "open",
    "--json",
    "number,title,state,author,labels,updatedAt,url",
  ]);
  return raw.map((i) => ({
    ...i,
    author: i.author?.login ?? "unknown",
    labels: (i.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
  }));
}

export async function pullDetail(repo: string, number: number) {
  return gh<Record<string, unknown>>([
    "pr",
    "view",
    String(number),
    "--repo",
    assertRepo(repo),
    "--json",
    "number,title,body,state,isDraft,author,headRefName,baseRefName,url,additions,deletions,changedFiles,reviewDecision",
  ]);
}

export async function issueDetail(repo: string, number: number) {
  return gh<Record<string, unknown>>([
    "issue",
    "view",
    String(number),
    "--repo",
    assertRepo(repo),
    "--json",
    "number,title,body,state,author,labels,url",
  ]);
}

/** Seed text for a "Work with Claude" session started from GitHub. */
export async function githubContext(
  repo: string,
  kind: "pr" | "issue",
  number: number,
): Promise<string> {
  const data =
    kind === "pr" ? await pullDetail(repo, number) : await issueDetail(repo, number);
  const body = typeof data.body === "string" ? data.body : "";
  return [
    `# GitHub ${kind === "pr" ? "PR" : "issue"} ${repo}#${number}: ${String(data.title ?? "")}`,
    String(data.url ?? ""),
    kind === "pr"
      ? `Branch: ${String(data.headRefName ?? "")} → ${String(data.baseRefName ?? "")} · ` +
        `+${String(data.additions ?? 0)}/-${String(data.deletions ?? 0)} in ${String(
          data.changedFiles ?? 0,
        )} files`
      : "",
    "",
    "## Body",
    body || "(empty)",
  ]
    .filter(Boolean)
    .join("\n");
}
