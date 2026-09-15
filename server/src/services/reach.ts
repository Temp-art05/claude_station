/**
 * Reach — what a `claude` terminal can ask the station, from inside the terminal.
 *
 * # The gap this closes
 *
 * A chat session gets the whole workspace every turn: `buildWorkspaceContext()`
 * puts the repo index, the knowledge listing, memory and the shared-memory bus
 * into `systemPrompt.append`. A terminal gets one context file at spawn and
 * nothing afterwards — so mid-session it cannot answer "who last touched this
 * file", "why was it done this way", "what does the ticket say". The person ends
 * up being the transport: open another tab, copy, paste back.
 *
 * And the terminal is the surface people actually use all day.
 *
 * # Why this is a resolver and not an `@` handler
 *
 * In a terminal the `@` key is not ours. The PTY runs the real CLI and the bytes
 * go straight through; `@` is already the CLI's file-path completion. There is no
 * point where the app could substitute text the way `mentions.ts` does for a
 * workflow step, because there the text stays ours until the step runs.
 *
 * So Reach uses a door the CLI already opens: a skill can run a shell command and
 * have its output folded in **before Claude reads the message**. Each generated
 * command is a two-line `SKILL.md` that curls the endpoint this file backs. Three
 * things follow: it costs no turn, it works in a detached tmux session with no
 * browser attached, and any agent that reads `SKILL.md` gets it too.
 *
 * Every answer here is text that will be prepended to somebody's prompt, so the
 * rules are the ones the ledger already lives by: redact before returning, cap
 * the size, and never return the value of an env var — only its name.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { pathUnder } from "../lib/path-compare";
import { redact } from "../lib/redact";
import { issueContext, searchIssues } from "./jira";
import { createMemory, listGlobalMemories, listMemories, searchMemories } from "./memory";
import { filesOf, secretValues, turnsTouching } from "./session-ledger";
import { eventsOf, stateOf } from "./shared-memory";
import { plansOf } from "./plans";
import { checkpointDetail } from "./checkpoints";
import { githubConfig, pullDetailFull } from "./gh";
import { search } from "./search";
import { searchRepo } from "./git";
import { cacheTicket } from "./reach-mirror";
import { listProjectKnowledge } from "./library";

export type ReachKind =
  | "overview"
  | "cmds"
  | "file"
  | "why"
  | "fail"
  | "plan"
  | "last"
  | "kb"
  | "ticket"
  | "commit"
  | "prior"
  | "sprint"
  | "pr"
  | "doc";

export const REACH_KINDS: ReachKind[] = [
  "overview",
  "cmds",
  "file",
  "why",
  "fail",
  "plan",
  "last",
  "kb",
  "ticket",
  "commit",
  "prior",
  "sprint",
  "pr",
  "doc",
];

export interface ReachResult {
  text: string;
  truncated: boolean;
}

/** Everything a Reach answer is allowed to be. Past this it is a context leak. */
const DEFAULT_CAP = 8_000;

export interface ProjectRepo {
  projectId: string;
  projectName: string;
  projectPathId: string;
  path: string;
  label: string;
}

/**
 * Which project a working directory belongs to.
 *
 * Longest matching repo wins, the same rule the ledger uses for files and the
 * transcript importer uses for conversations: nested project paths are a real
 * shape here, and the innermost one is the answer.
 *
 * Returns null rather than guessing. A terminal opened somewhere unconfigured
 * should be told so — picking the nearest project would answer questions about
 * the wrong repo, which is worse than answering none.
 */
export function projectForCwd(cwd: string): ProjectRepo | null {
  const rows = db
    .select({
      projectId: schema.projectPaths.projectId,
      projectPathId: schema.projectPaths.id,
      path: schema.projectPaths.path,
      label: schema.projectPaths.label,
      projectName: schema.projects.name,
    })
    .from(schema.projectPaths)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectPaths.projectId))
    .all();

  let best: ProjectRepo | null = null;
  for (const row of rows) {
    if (!pathUnder(cwd, row.path)) continue;
    if (!best || row.path.length > best.path.length) best = row;
  }
  return best;
}

/** Cut to the cap on a line boundary, and say so — a silent cut reads as the whole answer. */
function cap(text: string, limit = DEFAULT_CAP): ReachResult {
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  const head = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8");
  const cut = head.slice(0, head.lastIndexOf("\n") + 1 || head.length);
  return { text: `${cut}\n…(cut at ${limit} bytes — ask for something narrower)`, truncated: true };
}

/** The one exit. Nothing leaves this file without going through redaction. */
function answer(text: string, limit = DEFAULT_CAP): ReachResult {
  const safe = redact(text.trim(), secretValues(), {
    entropy: setting("ledger.redactEntropy"),
  });
  return cap(safe, limit);
}

export async function resolve(input: {
  kind: string;
  q?: string;
  cwd: string;
  limit?: number;
}): Promise<ReachResult> {
  const repo = projectForCwd(input.cwd);
  if (!repo) {
    return answer(
      `This directory is not inside any project configured in claude-station:\n  ${input.cwd}\n\n` +
        `Add it as a project path, or run from a directory that is one.`,
    );
  }

  const q = (input.q ?? "").trim();
  const limit = input.limit ?? DEFAULT_CAP;

  switch (input.kind) {
    case "overview":
      return answer(overview(repo), limit);
    case "cmds":
      return answer(commands(repo), limit);
    case "file":
      return answer(fileHistory(repo, q), limit);
    case "why":
      return answer(why(repo, q), limit);
    case "fail":
      return answer(failures(repo), limit);
    case "plan":
      return answer(activePlan(repo), limit);
    case "last":
      return answer(lastSession(repo), limit);
    case "kb":
      return answer(knowledge(repo, q), limit);
    case "ticket":
      return answer(await ticket(q, repo), limit);
    case "doc":
      return answer(doc(repo, q), limit);
    case "commit":
      return answer(commit(repo, q), limit);
    case "prior":
      return answer(prior(repo, q), limit);
    case "sprint":
      return answer(await sprint(), limit);
    case "pr":
      return answer(await pullRequest(q), limit);
    default:
      return answer(`Unknown Reach kind: ${input.kind}. Known: ${REACH_KINDS.join(", ")}.`);
  }
}

// -- the answers --------------------------------------------------------------

/**
 * Where am I, and what does this workspace already know?
 *
 * Deliberately counts rather than contents: this is the command someone runs on
 * arriving, and the useful thing is knowing which of the other commands is worth
 * running, not receiving every store at once.
 */
function overview(repo: ProjectRepo): string {
  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, repo.projectId))
    .all();

  const count = (table: "memories" | "plans" | "turns" | "checkpoints"): number => {
    try {
      if (table === "memories") return listMemories(repo.projectId).length;
      // Plans written as files count: this repo's own rule puts them in
      // `docs/plans/`, and reporting only the captured ones said "0 plans" to a
      // project with forty of them.
      if (table === "plans")
        return plansOf(repo.projectId, 500).length + planFiles(repo.path).length;
      if (table === "turns")
        return (
          db
            .select({ n: sql<number>`count(*)` })
            .from(schema.sessionTurns)
            .where(eq(schema.sessionTurns.projectId, repo.projectId))
            .get()?.n ?? 0
        );
      return (
        db
          .select({ n: sql<number>`count(*)` })
          .from(schema.checkpoints)
          .where(eq(schema.checkpoints.projectId, repo.projectId))
          .get()?.n ?? 0
      );
    } catch {
      return 0;
    }
  };

  const lines = [
    `# ${repo.projectName}`,
    "",
    `You are in \`${repo.path}\` (${repo.label}).`,
    "",
    "## Repos in this project",
    ...paths.map((p) => `- \`${p.path}\` — ${p.label}${p.isDefault ? " (default)" : ""}`),
    "",
    "## What the station holds for it",
    `- ${count("turns")} recorded turns, ${count("checkpoints")} commits linked to sessions`,
    `- ${count("memories")} project notes, ${listGlobalMemories().length} global rules`,
    `- ${count("plans")} plans proposed`,
  ];

  const envSet = db
    .select({ name: schema.envSets.name, id: schema.envSets.id })
    .from(schema.projectEnvSets)
    .innerJoin(schema.envSets, eq(schema.envSets.id, schema.projectEnvSets.envSetId))
    .where(eq(schema.projectEnvSets.projectId, repo.projectId))
    .get();
  if (envSet) {
    // Names only, never values. This store holds vars marked secret, and this
    // text goes straight into a prompt.
    const keys = db
      .select({ key: schema.envVars.key, secret: schema.envVars.isSecret })
      .from(schema.envVars)
      .where(eq(schema.envVars.envSetId, envSet.id))
      .all();
    lines.push(
      "",
      `## Env set: ${envSet.name}`,
      `Variables available to commands here (names only): ${keys
        .map((k) => `\`${k.key}\`${k.secret ? "*" : ""}`)
        .join(", ")}`,
      `\`*\` is marked secret — its value is never shown here or anywhere else in a prompt.`,
    );
  }

  const state = stateOf(repo.projectId);
  const recent = [state.plan, ...state.decisions].filter(Boolean).slice(0, 5);
  if (recent.length > 0) {
    lines.push(
      "",
      "## What other sessions established most recently",
      ...recent.map((event) => `- ${event!.text}`),
    );
  }

  lines.push(
    "",
    "Other Reach commands: `/reach-cmds`, `/reach-file <path>`, `/reach-why <topic>`, " +
      "`/reach-fail`, `/reach-plan`, `/reach-last`, `/reach-kb <query>`, `/reach-ticket <key>`.",
  );
  return lines.join("\n");
}

/**
 * The commands this repo actually has, with their exact command lines.
 *
 * The failure this prevents is specific and common: an agent guesses `npm test`
 * in a repo whose tests are `bundle exec rspec`, watches it fail, and spends the
 * next turn debugging the wrong thing.
 */
function commands(repo: ProjectRepo): string {
  const rows = db
    .select()
    .from(schema.pathCommands)
    .where(eq(schema.pathCommands.projectPathId, repo.projectPathId))
    .orderBy(schema.pathCommands.sortOrder)
    .all();

  const scripts = packageScripts(repo.path);
  const parts: string[] = [];

  if (rows.length > 0) {
    parts.push(
      `# Lệnh đã cấu hình trong station cho ${repo.label}`,
      "",
      "Chạy đúng như viết — đây là thứ project này được set up để dùng.",
      "",
      ...rows.map(
        (c) =>
          `- **${c.name}** (${c.kind}): \`${c.command}\`${c.cwdOverride ? ` trong \`${c.cwdOverride}\`` : ""}`,
      ),
      "",
    );
  }

  if (scripts.length > 0) {
    parts.push(
      "# Script trong package.json",
      "",
      "Đọc thẳng từ repo, nên đúng kể cả khi station chưa cấu hình gì.",
      "",
      ...scripts.map((s) => `- \`${s.run}\` — ${s.body}`),
    );
  }

  if (parts.length === 0) {
    return `Không có lệnh nào cấu hình trong station cho \`${repo.path}\`, và repo cũng không có package.json. Làm theo README của repo.`;
  }
  return parts.join("\n");
}

/**
 * What the repo itself says it can run.
 *
 * The first version answered "no commands are configured" in a repo with
 * fourteen npm scripts sitting in `package.json` — it reported what the station
 * had been told rather than what the project can do, which is the exact guess
 * (`npm test` in a repo that uses something else) this command exists to stop.
 */
function packageScripts(repoPath: string): { run: string; body: string }[] {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return Object.entries(pkg.scripts ?? {})
      .filter(([name]) => !name.startsWith("pre") && !name.startsWith("post"))
      .slice(0, 25)
      .map(([name, body]) => ({
        run: name === "start" || name === "test" ? `npm ${name}` : `npm run ${name}`,
        body,
      }));
  } catch {
    return [];
  }
}

/** Who last changed this file, what they had been asked, and what landed. */
function fileHistory(repo: ProjectRepo, path: string): string {
  if (!path) return "Usage: `/reach-file <path>` — relative to the repo, or absolute.";
  const abs = path.startsWith("/") ? path : `${repo.path.replace(/\/$/, "")}/${path}`;
  const turns = turnsTouching(repo.projectId, abs, 5);
  if (turns.length === 0) {
    return `Nothing in the session record touched \`${path}\`. Either nobody has, or it changed before capture started.`;
  }

  const lines = [`# Recent work on \`${path}\``, ""];
  for (const turn of turns) {
    const touched = filesOf(turn.id).filter((f) => f.op !== "read");
    lines.push(
      `## ${turn.startedAt} — ${turn.sourceKind === "sdk" ? "chat session" : "terminal"}`,
      "",
      `Asked: ${turn.promptText || turn.promptPreview || "(no prompt recorded)"}`,
      "",
      `Changed ${touched.length} file(s) in that turn${turn.model ? `, on ${turn.model}` : ""}.`,
    );
    const commit = db
      .select({ sha: schema.checkpoints.commitSha, subject: schema.checkpoints.subject })
      .from(schema.checkpoints)
      .where(eq(schema.checkpoints.turnId, turn.id))
      .get();
    if (commit) lines.push(`Committed as \`${commit.sha.slice(0, 8)}\` — ${commit.subject}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Why is it like this?
 *
 * Reads the two places a reason can have been written down: the bus, where
 * sessions record decisions as they make them, and memory, where a person or an
 * agent wrote one deliberately.
 */
function why(repo: ProjectRepo, topic: string): string {
  if (!topic) return "Usage: `/reach-why <topic>` — a word or two about the thing in question.";
  const needles = topic
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const matches = (text: string): boolean => {
    const low = text.toLowerCase();
    return needles.length === 0 || needles.some((n) => low.includes(n));
  };

  const events = eventsOf(repo.projectId, 400).filter(
    (e) => ["decision", "fact", "architecture", "plan"].includes(e.kind) && matches(e.text),
  );
  const notes = searchMemories(repo.projectId, topic, 5);

  if (events.length === 0 && notes.length === 0) {
    return `Nothing recorded about "${topic}". That is an answer too: no session wrote a reason down, so treat it as undecided rather than settled.`;
  }

  const lines = [`# What is on record about "${topic}"`, ""];
  if (events.length > 0) {
    lines.push("## Decided while working", "");
    for (const event of events.slice(0, 12)) {
      lines.push(`- **${event.kind}** (${event.createdAt.slice(0, 10)}): ${event.text}`);
    }
    lines.push("");
  }
  if (notes.length > 0) {
    lines.push("## Written down on purpose", "");
    for (const note of notes) lines.push(`### ${note.title}`, note.body, "");
  }
  return lines.join("\n");
}

/** What has already been tried here and broken. The half nobody writes down. */
function failures(repo: ProjectRepo): string {
  const events = eventsOf(repo.projectId, 400).filter((e) => e.kind === "failure");
  if (events.length === 0) return "No failure is on record for this project.";
  return [
    "# What has gone wrong here before",
    "",
    "Recorded by sessions as it happened. Worth reading before repeating an approach.",
    "",
    ...events.slice(0, 20).map((e) => `- ${e.createdAt.slice(0, 10)}: ${e.text}`),
  ].join("\n");
}

/**
 * The plan this project is working to, so a fresh terminal continues it.
 *
 * Two sources, and the second one is the one that matters in practice. The table
 * holds plans captured from `ExitPlanMode` — real, but only from sessions that
 * used plan mode. A repo whose convention is *write the plan to a file* keeps
 * them in `docs/plans/`, and the first version of this answered "no plan has
 * been proposed" to a project with forty of them sitting on disk.
 *
 * Files are listed rather than inlined: a roadmap runs to hundreds of lines, and
 * the useful answer is which one to open.
 */
function activePlan(repo: ProjectRepo): string {
  const parts: string[] = [];

  const plans = plansOf(repo.projectId, 20);
  const active = plans.find((p) => p.status === "accepted") ?? plans[0];
  if (active) {
    parts.push(
      `# Plan đề xuất gần nhất (${active.status}, ${active.createdAt.slice(0, 10)})`,
      active.promptPreview ? `\nĐược hỏi: ${active.promptPreview}\n` : "",
      active.markdown,
      "",
    );
  }

  const files = planFiles(repo.path);
  if (files.length > 0) {
    parts.push(
      "# Plan viết thành file trong repo",
      "",
      "Mở cái liên quan rồi làm tiếp theo nó, đừng lập lại kế hoạch từ đầu.",
      "",
      ...files.map((f) => `- \`${f.relPath}\` — sửa lần cuối ${f.modified.slice(0, 10)}`),
    );
  }

  if (parts.length === 0) {
    return "Project này chưa có plan nào, cả trong session lẫn trong `docs/plans/`. Việc lớn thì viết plan trước.";
  }
  return parts.join("\n");
}

/**
 * Plan files on disk, newest first.
 *
 * `docs/plans/` because that is where this repo's own rule puts them; a project
 * that keeps them elsewhere simply has none here, which the caller states rather
 * than guessing at another directory.
 */
function planFiles(repoPath: string): { relPath: string; modified: string }[] {
  const dir = join(repoPath, "docs", "plans");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => ({
        relPath: `docs/plans/${name}`,
        modified: new Date(statSync(join(dir, name)).mtimeMs).toISOString(),
      }))
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, 25);
  } catch {
    return [];
  }
}

/** The tail of the previous session here, whichever surface it ran on. */
function lastSession(repo: ProjectRepo): string {
  const turns = db
    .select()
    .from(schema.sessionTurns)
    .where(eq(schema.sessionTurns.projectId, repo.projectId))
    .orderBy(desc(schema.sessionTurns.startedAt))
    .limit(8)
    .all();
  if (turns.length === 0) return "Nothing recorded for this project yet.";

  const lines = ["# What was being worked on most recently", ""];
  for (const turn of turns.reverse()) {
    const files = filesOf(turn.id).filter((f) => f.op !== "read");
    lines.push(
      `- ${turn.startedAt.slice(0, 16).replace("T", " ")} (${turn.sourceKind}) — ${
        turn.promptPreview || "(no prompt)"
      }${files.length > 0 ? ` · ${files.length} file(s)` : ""}${turn.status !== "done" ? ` · ${turn.status}` : ""}`,
    );
  }
  return lines.join("\n");
}

/** Documents this workspace holds — paths and snippets, never whole files. */
function knowledge(repo: ProjectRepo, query: string): string {
  if (!query) return "Cách dùng: `/reach-kb <từ khoá>`.";

  const hits = search(query, "knowledge", 8).knowledge.filter(
    (h) => h.projectId === null || h.projectId === repo.projectId,
  );
  const docs = repoDocs(repo.path, query);

  if (hits.length === 0 && docs.length === 0) {
    return `Không tài liệu nào khớp "${query}" — cả trong kho của station lẫn trong repo.`;
  }

  const parts: string[] = [
    `# Tài liệu khớp "${query}"`,
    "",
    "Đường dẫn, không phải nội dung — mở cái nào trông đúng.",
    "",
  ];

  if (docs.length > 0) {
    // Repo files first: they are the thing being worked on, and they need no
    // mirror — `@docs/plans/reach.md` is already a path that resolves.
    parts.push("## Trong repo", "");
    for (const doc of docs) {
      parts.push(`- \`${doc.relPath}\`${doc.snippet ? `\n  ${doc.snippet}` : ""}`);
    }
    parts.push("");
  }

  if (hits.length > 0) {
    parts.push("## Trong kho tài liệu của station", "");
    for (const hit of hits) {
      const item = db
        .select({ storedPath: schema.knowledgeItems.storedPath })
        .from(schema.knowledgeItems)
        .where(eq(schema.knowledgeItems.id, hit.itemId))
        .get();
      parts.push(
        `- \`${item?.storedPath ?? hit.name}\` — ${hit.name} (${hit.itemKind})${
          hit.snippet ? `\n  ${hit.snippet.replace(/\s+/g, " ").slice(0, 200)}` : ""
        }`,
      );
    }
  }

  return parts.join("\n");
}

/**
 * Documents that live in the repo itself.
 *
 * The knowledge store holds what was imported into the station; a repo also has
 * its own `README`, its specs and — in this one — forty plan files. Answering
 * only from the store told a session there was nothing on a subject the repo
 * documents at length.
 *
 * Name matches first, then content matches: a file called `checkpoints.md` is a
 * better answer for "checkpoints" than a line mentioning the word.
 */
function repoDocs(repoPath: string, query: string): { relPath: string; snippet: string }[] {
  const DOC_EXT = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
  try {
    const { files, matches } = searchRepo(repoPath, query, 120);
    const out: { relPath: string; snippet: string }[] = [];
    const seen = new Set<string>();

    for (const file of files.filter((f) => DOC_EXT.test(f)).slice(0, 8)) {
      seen.add(file);
      out.push({ relPath: file, snippet: "" });
    }
    for (const match of matches.filter((m) => DOC_EXT.test(m.path))) {
      if (seen.has(match.path) || out.length >= 12) continue;
      seen.add(match.path);
      out.push({ relPath: match.path, snippet: match.text.trim().slice(0, 160) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * What a commit was for.
 *
 * `git show` says what changed; this says what somebody asked for, which is the
 * half a diff cannot carry. Accepts any prefix git would.
 */
function commit(repo: ProjectRepo, sha: string): string {
  if (!sha) return "Usage: `/reach-commit <sha>`.";
  const row = db
    .select()
    .from(schema.checkpoints)
    .where(
      and(
        eq(schema.checkpoints.projectId, repo.projectId),
        sql`${schema.checkpoints.commitSha} like ${`${sha}%`}`,
      ),
    )
    .get();
  if (!row) return `No checkpoint for a commit starting \`${sha}\` in this project.`;

  const detail = checkpointDetail(row.id);
  if (!detail) return `No checkpoint for \`${sha}\`.`;

  const lines = [
    `# ${detail.commitSha.slice(0, 12)} — ${detail.subject}`,
    "",
    `By ${detail.author} on ${detail.committedAt}.`,
    `Attribution: **${detail.confidence}** — ${detail.reason}`,
  ];
  if (detail.turn) {
    lines.push("", "## What was asked", "", detail.turn.promptText || "(no prompt recorded)");
  } else {
    lines.push("", "No session could be attributed to it, so there is no prompt behind it.");
  }
  lines.push(
    "",
    "## Files it changed",
    "",
    ...detail.commitFiles.slice(0, 40).map((f) => `- ${f.status} \`${f.path}\``),
    "",
    `Read the diff with \`git show ${detail.commitSha.slice(0, 12)}\` — it is deliberately not pasted here.`,
  );
  return lines.join("\n");
}

/**
 * Has this been done here before?
 *
 * Matches against what people *asked for*, not against decisions — `/reach-why`
 * answers "what was settled", this answers "has anyone already been down this
 * road, and how did it end". A turn that ended `error` is the useful hit.
 */
function prior(repo: ProjectRepo, topic: string): string {
  if (!topic) return "Usage: `/reach-prior <topic>` — what you are about to start.";
  const needles = topic
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (needles.length === 0) return "Give a couple of words worth matching on.";

  const turns = db
    .select()
    .from(schema.sessionTurns)
    .where(eq(schema.sessionTurns.projectId, repo.projectId))
    .orderBy(desc(schema.sessionTurns.startedAt))
    .limit(600)
    .all()
    .filter((turn) => {
      const low = `${turn.promptText} ${turn.promptPreview}`.toLowerCase();
      return needles.some((n) => low.includes(n));
    })
    .slice(0, 8);

  if (turns.length === 0) {
    return `Nothing in the session record matches "${topic}". Treat it as new ground.`;
  }

  const lines = [`# Earlier work matching "${topic}"`, ""];
  for (const turn of turns) {
    const files = filesOf(turn.id).filter((f) => f.op !== "read");
    lines.push(
      `## ${turn.startedAt.slice(0, 16).replace("T", " ")} (${turn.sourceKind})${
        turn.status !== "done" ? ` — ended ${turn.status}` : ""
      }`,
      "",
      turn.promptPreview || "(no prompt)",
      "",
      files.length > 0
        ? `Touched: ${[...new Set(files.map((f) => f.relPath || f.absPath))].slice(0, 8).join(", ")}`
        : "Changed no files.",
      "",
    );
  }
  return lines.join("\n");
}

/** What is open in the current sprint, for whoever this Jira is authenticated as. */
async function sprint(): Promise<string> {
  try {
    const issues = await searchIssues(
      "sprint in openSprints() AND assignee = currentUser() ORDER BY updated DESC",
      30,
    );
    if (issues.length === 0) return "Nothing assigned to you in an open sprint.";
    return [
      "# Your open sprint work",
      "",
      ...issues.map((i) => `- **${i.key}** [${i.status}] ${i.summary}`),
    ].join("\n");
  } catch (err) {
    return `Could not reach Jira: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * A pull request, with its review comments.
 *
 * Takes `123` when exactly one repo is configured, or `owner/name#123` when the
 * number alone would be ambiguous — guessing which repo is the one thing that
 * would make this answer confidently about the wrong PR.
 */
async function pullRequest(arg: string): Promise<string> {
  if (!arg) return "Usage: `/reach-pr <number>` or `/reach-pr owner/name#123`.";
  const qualified = arg.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  let repoName: string;
  let number: number;

  if (qualified) {
    repoName = qualified[1]!;
    number = Number(qualified[2]);
  } else {
    const repos = githubConfig().repos;
    if (repos.length === 0) return "No GitHub repo is configured in Settings.";
    if (repos.length > 1) {
      return `Several repos are configured (${repos.join(", ")}) — say which: \`/reach-pr owner/name#${arg}\`.`;
    }
    repoName = repos[0]!;
    number = Number(arg.replace(/^#/, ""));
  }
  if (!Number.isFinite(number)) return `\`${arg}\` is not a pull request number.`;

  try {
    const pr = await pullDetailFull(repoName, number);
    const lines = [
      `# ${repoName}#${pr.number} — ${pr.title}`,
      "",
      `${pr.state}${pr.isDraft ? " (draft)" : ""} · ${pr.headRefName} → ${pr.baseRefName} · by ${pr.author}`,
      "",
      pr.body || "(no description)",
    ];
    if (pr.reviews.length > 0) {
      lines.push("", "## Reviews", "");
      for (const r of pr.reviews.slice(0, 10)) {
        lines.push(`- **${r.author}** — ${r.state}${r.body ? `: ${r.body}` : ""}`);
      }
    }
    if (pr.comments.length > 0) {
      lines.push("", "## Comments", "");
      for (const c of pr.comments.slice(0, 15)) {
        lines.push(`- **${c.author}**: ${c.body}`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `Could not fetch ${repoName}#${number}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * The one thing Reach writes.
 *
 * A plain `claude` terminal gets no station MCP server — `mcpConfigFile` is only
 * passed for workflow steps — so `memory_write` does not exist there. Without
 * this, everything a terminal session learns dies with the tab, which is the
 * failure the memory store was built to stop in the first place.
 */
export function writeNote(cwd: string, text: string): ReachResult {
  const repo = projectForCwd(cwd);
  if (!repo) return answer(`Not inside a configured project:\n  ${cwd}`);
  const body = (text ?? "").trim();
  if (!body) return answer("Usage: `/reach-note <what you learned>`.");

  // First line is the title, the rest is the note — the same shape the Memory
  // tab writes, so a note from a terminal is indistinguishable from one typed in.
  const [first, ...rest] = body.split("\n");
  const title = (first ?? "").trim().slice(0, 80) || "Note";
  const note = createMemory(
    repo.projectId,
    { title, body: rest.join("\n").trim() || body, tags: [], pinned: false },
    "claude",
  );
  return answer(
    `Saved to ${repo.projectName}'s memory as "${note.title}". It will be offered to future sessions in this project.`,
  );
}

/** A Jira issue as markdown, through the same renderer workflow mentions use. */
async function ticket(key: string, repo: ProjectRepo): Promise<string> {
  if (!key) return "Usage: `/reach-ticket <KEY-123>`.";
  try {
    const body = `# ${key}\n\n${await issueContext(key)}`;

    // Also drop it into the mirror, so the next mention of it can be a pointer
    // (`@.station/tickets/KEY.md`) instead of the whole issue again.
    if (setting("reach.mirror")) {
      try {
        const file = cacheTicket(repo.projectId, repo.path, key, body);
        return `${body}\n\n---\nAlso saved at \`${file}\` — refer to it later with \`@${file.slice(repo.path.length + 1)}\`.`;
      } catch {
        /* the mirror is a convenience; the answer stands without it */
      }
    }
    return body;
  } catch (err) {
    return `Could not fetch ${key}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * One document, by name, without going through a search.
 *
 * `/reach-kb` finds things; this points at a thing already known by name. The
 * answer is a path on purpose — a spec pasted into the prompt costs the same
 * context whether or not it turns out to be the right one.
 */
function doc(repo: ProjectRepo, name: string): string {
  if (!name) return "Cách dùng: `/reach-doc <tên>`.";
  const wanted = name.toLowerCase();

  const items = listProjectKnowledge(repo.projectId);
  const hit =
    items.find((i) => i.name.toLowerCase() === wanted) ??
    items.find((i) => i.name.toLowerCase().includes(wanted));

  if (hit) {
    return [
      `# ${hit.name}`,
      "",
      hit.description || `(${hit.kind})`,
      "",
      `Đường dẫn: \`${hit.storedPath}\``,
      hit.parsedPath ? `Bản đã parse: \`${hit.parsedPath}\`` : "",
      "",
      "Đọc khi cần — không dán nội dung vào đây.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Not in the store; the repo keeps documents of its own, and a name is usually
  // a filename.
  const inRepo = repoDocs(repo.path, name);
  if (inRepo.length > 0) {
    return [
      `# Không có tài liệu tên "${name}" trong kho, nhưng repo có:`,
      "",
      ...inRepo.map((d) => `- \`${d.relPath}\``),
    ].join("\n");
  }

  const names = items
    .slice(0, 15)
    .map((i) => `\`${i.name}\``)
    .join(", ");
  return `Không có tài liệu nào tên "${name}". Kho của project này có: ${names || "chưa có gì"}.`;
}
