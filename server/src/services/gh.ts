import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { githubConfigSchema, normalizeGithubRepo, type GithubConfig } from "@claude-station/shared";
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
  const cfg = githubConfigSchema.parse(JSON.parse(row.config));
  // Settings accepts full URLs / ssh remotes; everything downstream wants owner/name.
  return { repos: cfg.repos.map(normalizeGithubRepo).filter((r): r is string => r !== null) };
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** `gh` is invoked with an argv array, and the repo shape is validated first. */
async function ghRaw(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("gh", args, {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT")) {
      throw badRequest("gh CLI not found on PATH — install it and run `gh auth login`");
    }
    throw Object.assign(new Error(`gh failed: ${message.slice(0, 400)}`), { statusCode: 502 });
  }
}

async function gh<T>(args: string[]): Promise<T> {
  return JSON.parse((await ghRaw(args)) || "[]") as T;
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

// ── PR detail (GitHub-like view) ─────────────────────────────────────────────

export interface PrDetail {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  mergeable: string;
  createdAt: string;
  labels: string[];
  assignees: string[];
  comments: { author: string; body: string; createdAt: string }[];
  reviews: { author: string; state: string; body: string; submittedAt: string }[];
  commits: { sha: string; message: string; author: string; date: string }[];
  files: { path: string; additions: number; deletions: number }[];
  checks: { name: string; state: string }[];
}

export async function pullDetailFull(repo: string, number: number): Promise<PrDetail> {
  const raw = await gh<{
    number: number;
    title?: string;
    body?: string;
    state?: string;
    isDraft?: boolean;
    author?: { login?: string };
    headRefName?: string;
    baseRefName?: string;
    url?: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
    reviewDecision?: string;
    mergeable?: string;
    createdAt?: string;
    labels?: { name?: string }[];
    assignees?: { login?: string }[];
    comments?: { author?: { login?: string }; body?: string; createdAt?: string }[];
    reviews?: { author?: { login?: string }; state?: string; body?: string; submittedAt?: string }[];
    commits?: {
      oid?: string;
      messageHeadline?: string;
      authors?: { login?: string; name?: string }[];
      committedDate?: string;
    }[];
    files?: { path?: string; additions?: number; deletions?: number }[];
    statusCheckRollup?: {
      __typename?: string;
      name?: string;
      conclusion?: string;
      status?: string;
      context?: string;
      state?: string;
    }[];
  }>([
    "pr",
    "view",
    String(number),
    "--repo",
    assertRepo(repo),
    "--json",
    "number,title,body,state,isDraft,author,headRefName,baseRefName,url,additions," +
      "deletions,changedFiles,reviewDecision,mergeable,createdAt,labels,assignees," +
      "comments,reviews,commits,files,statusCheckRollup",
  ]);
  return {
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? "",
    state: (raw.state === "MERGED" || raw.state === "CLOSED" ? raw.state : "OPEN") as PrDetail["state"],
    isDraft: !!raw.isDraft,
    author: raw.author?.login ?? "unknown",
    headRefName: raw.headRefName ?? "",
    baseRefName: raw.baseRefName ?? "",
    url: raw.url ?? "",
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    reviewDecision: raw.reviewDecision ?? "",
    mergeable: raw.mergeable ?? "UNKNOWN",
    createdAt: raw.createdAt ?? "",
    labels: (raw.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    assignees: (raw.assignees ?? []).map((a) => a.login ?? "").filter(Boolean),
    comments: (raw.comments ?? []).map((c) => ({
      author: c.author?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.createdAt ?? "",
    })),
    reviews: (raw.reviews ?? []).map((r) => ({
      author: r.author?.login ?? "unknown",
      state: r.state ?? "",
      body: r.body ?? "",
      submittedAt: r.submittedAt ?? "",
    })),
    commits: (raw.commits ?? []).map((c) => ({
      sha: (c.oid ?? "").slice(0, 7),
      message: c.messageHeadline ?? "",
      author: c.authors?.[0]?.login || c.authors?.[0]?.name || "unknown",
      date: c.committedDate ?? "",
    })),
    files: (raw.files ?? []).map((f) => ({
      path: f.path ?? "",
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    })),
    // CheckRun rows carry name+conclusion, plain status contexts context+state.
    checks: (raw.statusCheckRollup ?? []).map((c) => ({
      name: c.name || c.context || "check",
      state: (c.conclusion || c.state || c.status || "").toUpperCase(),
    })),
  };
}

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export async function pullDiff(
  repo: string,
  number: number,
): Promise<{ files: { path: string; patch: string }[]; truncated: boolean }> {
  const raw = await ghRaw(["pr", "diff", String(number), "--repo", assertRepo(repo)]);
  const truncated = raw.length > MAX_DIFF_BYTES;
  const text = truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw;
  const files = text
    .split(/^diff --git /m)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      // First line looks like `a/src/x.ts b/src/x.ts`; prefer the +++ side.
      const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk);
      const head = /^a\/.* b\/(.+)$/m.exec(chunk.split("\n", 1)[0] ?? "");
      return { path: plus?.[1] ?? head?.[1] ?? "(unknown)", patch: chunk };
    });
  return { files, truncated };
}

export async function commentPull(repo: string, number: number, body: string): Promise<void> {
  await ghRaw(["pr", "comment", String(number), "--repo", assertRepo(repo), "--body", body]);
}

export type ReviewEvent = "approve" | "request-changes" | "comment";

export async function reviewPull(
  repo: string,
  number: number,
  event: ReviewEvent,
  body?: string,
): Promise<void> {
  const flag =
    event === "approve" ? "--approve" : event === "request-changes" ? "--request-changes" : "--comment";
  const args = ["pr", "review", String(number), "--repo", assertRepo(repo), flag];
  // gh requires a body for request-changes/comment reviews.
  if (body || event !== "approve") args.push("--body", body ?? "");
  await ghRaw(args);
}

export interface CreatePullInput {
  title: string;
  body?: string;
  base: string;
  head: string;
  draft?: boolean;
}

export async function createPull(
  repo: string,
  input: CreatePullInput,
): Promise<{ number: number; url: string }> {
  assertRepo(repo);
  assertBranch(input.base);
  assertBranch(input.head);
  if (input.base === input.head) throw badRequest("Base and head must be different branches");
  const args = [
    "pr",
    "create",
    "--repo",
    repo,
    "--title",
    input.title,
    "--body",
    input.body ?? "",
    "--base",
    input.base,
    "--head",
    input.head,
  ];
  if (input.draft) args.push("--draft");
  // gh prints the new PR's URL as the last line of stdout.
  const url = (await ghRaw(args)).trim().split("\n").pop() ?? "";
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
  return { number, url };
}

export interface RepoViewer {
  login: string;
  canPush: boolean;
  canAdmin: boolean;
}

export async function repoViewer(repo: string): Promise<RepoViewer> {
  assertRepo(repo);
  const [user, meta] = await Promise.all([
    gh<{ login?: string }>(["api", "user"]),
    gh<{ permissions?: { push?: boolean; admin?: boolean } }>(["api", `repos/${repo}`]),
  ]);
  return {
    login: user.login ?? "",
    canPush: !!meta.permissions?.push,
    canAdmin: !!meta.permissions?.admin,
  };
}

export async function editPullBase(repo: string, number: number, base: string): Promise<void> {
  await ghRaw([
    "pr",
    "edit",
    String(number),
    "--repo",
    assertRepo(repo),
    "--base",
    assertBranch(base),
  ]);
}

export async function closePull(repo: string, number: number): Promise<void> {
  await ghRaw(["pr", "close", String(number), "--repo", assertRepo(repo)]);
}

export async function reopenPull(repo: string, number: number): Promise<void> {
  await ghRaw(["pr", "reopen", String(number), "--repo", assertRepo(repo)]);
}

export async function setPullDraft(repo: string, number: number, draft: boolean): Promise<void> {
  const args = ["pr", "ready", String(number), "--repo", assertRepo(repo)];
  if (draft) args.push("--undo");
  await ghRaw(args);
}

export async function listAssignableUsers(repo: string): Promise<string[]> {
  assertRepo(repo);
  const raw = await gh<{ login?: string }[]>(["api", `repos/${repo}/assignees?per_page=100`]);
  return raw.map((u) => u.login ?? "").filter(Boolean);
}

const LOGIN_RE = /^[a-zA-Z\d](?:[a-zA-Z\d-]{0,38})$/;

function assertLogins(logins: string[]): string[] {
  for (const login of logins) {
    if (!LOGIN_RE.test(login)) throw badRequest(`Invalid GitHub login: ${login}`);
  }
  return logins;
}

export async function editPullAssignees(
  repo: string,
  number: number,
  add: string[],
  remove: string[],
): Promise<void> {
  if (!add.length && !remove.length) return;
  const args = ["pr", "edit", String(number), "--repo", assertRepo(repo)];
  if (add.length) args.push("--add-assignee", assertLogins(add).join(","));
  if (remove.length) args.push("--remove-assignee", assertLogins(remove).join(","));
  await ghRaw(args);
}

export type MergeMethod = "merge" | "squash" | "rebase";

export async function mergePull(
  repo: string,
  number: number,
  method: MergeMethod,
  deleteBranch: boolean,
): Promise<void> {
  const args = ["pr", "merge", String(number), "--repo", assertRepo(repo), `--${method}`];
  if (deleteBranch) args.push("--delete-branch");
  await ghRaw(args);
}

export interface Branch {
  name: string;
  protected: boolean;
  sha: string;
}

export async function listBranches(
  repo: string,
): Promise<{ defaultBranch: string; branches: Branch[] }> {
  assertRepo(repo);
  const [meta, raw] = await Promise.all([
    gh<{ default_branch?: string }>(["api", `repos/${repo}`]),
    gh<{ name: string; protected?: boolean; commit?: { sha?: string } }[]>([
      "api",
      `repos/${repo}/branches?per_page=100`,
    ]),
  ]);
  return {
    defaultBranch: meta.default_branch ?? "main",
    branches: raw.map((b) => ({
      name: b.name,
      protected: !!b.protected,
      sha: b.commit?.sha?.slice(0, 7) ?? "",
    })),
  };
}

// Branch names never carry whitespace or git's forbidden ref characters; also
// refuse a leading "-" so a name can't read as a gh flag.
const BRANCH_RE = /^[^\s~^:?*\\[\]]+$/;

function assertBranch(branch: string): string {
  if (!branch || branch.startsWith("-") || !BRANCH_RE.test(branch)) {
    throw badRequest(`Invalid branch name: ${branch}`);
  }
  return branch;
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  assertRepo(repo);
  assertBranch(branch);
  const { defaultBranch, branches } = await listBranches(repo);
  if (branch === defaultBranch) throw badRequest("Refusing to delete the default branch");
  if (branches.find((b) => b.name === branch)?.protected) {
    throw badRequest("Refusing to delete a protected branch");
  }
  const refPath = branch.split("/").map(encodeURIComponent).join("/");
  await gh(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${refPath}`]);
}

export interface Release {
  tagName: string;
  name: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
  isLatest: boolean;
  url: string;
}

export async function listReleases(repo: string, limit = 30): Promise<Release[]> {
  const raw = await gh<
    {
      tagName: string;
      name?: string;
      publishedAt?: string;
      isDraft: boolean;
      isPrerelease: boolean;
      isLatest: boolean;
    }[]
  >([
    "release",
    "list",
    "--repo",
    assertRepo(repo),
    "--limit",
    String(limit),
    "--json",
    "tagName,name,publishedAt,isDraft,isPrerelease,isLatest",
  ]);
  return raw.map((r) => ({
    ...r,
    name: r.name || r.tagName,
    publishedAt: r.publishedAt ?? "",
    url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(r.tagName)}`,
  }));
}

const MAX_FILE_TEXT = 200_000; // bytes of file content served to the browser

export type RepoContent =
  | {
      type: "dir";
      path: string;
      entries: { name: string; path: string; type: "dir" | "file"; size: number }[];
    }
  | {
      type: "file";
      path: string;
      name: string;
      size: number;
      /** Null when the file is binary. */
      text: string | null;
      truncated: boolean;
    };

export async function getContents(repo: string, path = "", ref = ""): Promise<RepoContent> {
  assertRepo(repo);
  if (path.split("/").includes("..")) throw badRequest("Invalid path");
  const encPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const raw = await gh<unknown>(["api", `repos/${repo}/contents/${encPath}${qs}`]);

  if (Array.isArray(raw)) {
    const entries = (raw as { name?: string; path?: string; type?: string; size?: number }[])
      .map((e) => ({
        name: String(e.name ?? ""),
        path: String(e.path ?? ""),
        type: (e.type === "dir" ? "dir" : "file") as "dir" | "file",
        size: Number(e.size ?? 0),
      }))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
      );
    return { type: "dir", path, entries };
  }

  const f = raw as { name?: string; path?: string; size?: number; content?: string; encoding?: string };
  let text: string | null = null;
  let truncated = false;
  if (typeof f.content === "string" && f.encoding === "base64") {
    const buf = Buffer.from(f.content, "base64");
    if (buf.includes(0)) {
      text = null; // binary
    } else {
      truncated = buf.length > MAX_FILE_TEXT;
      text = buf.subarray(0, MAX_FILE_TEXT).toString("utf8");
    }
  }
  return {
    type: "file",
    path: String(f.path ?? path),
    name: String(f.name ?? ""),
    size: Number(f.size ?? 0),
    text,
    truncated,
  };
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
