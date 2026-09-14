/**
 * Reading checkpoints, and opening a conversation with one.
 *
 * Nothing here creates or edits an attribution: those are derived from the ledger
 * and from git, and a client asking for a different answer would be asking to be
 * lied to. What a client can do is read one, and start a session seeded with it.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  checkpointDetail,
  checkpointsOfSession,
  ingest,
  orphanCount,
  reconcileGoneCommits,
} from "../services/checkpoints";
import { resolveTree } from "../services/git-paths";
import { createTerminal } from "../services/terminals";

const params = z.object({ id: z.string(), cpId: z.string() });

/**
 * The context a session gets when you open a checkpoint.
 *
 * The diff is referenced, not pasted: a commit can be enormous, and the session
 * can run `git show` when it wants the detail. Same reason a folder mention
 * resolves to a path rather than its contents.
 */
function buildSeedPrompt(detail: NonNullable<ReturnType<typeof checkpointDetail>>): string {
  const short = detail.commitSha.slice(0, 12);
  const lines = [
    `# Checkpoint ${short} — "${detail.subject}"`,
    "",
    `Committed ${detail.committedAt} by ${detail.author} in \`${detail.repoPath}\`.`,
    `Attribution: **${detail.confidence}**${detail.score !== null ? ` (score ${detail.score.toFixed(2)})` : ""} — ${detail.reason}`,
  ];

  if (detail.turn) {
    lines.push(
      "",
      "## What was asked",
      "",
      detail.turn.promptText || "(no prompt recorded for that turn)",
      "",
      `That turn ran ${detail.turn.startedAt} → ${detail.turn.endedAt ?? "(still open)"}` +
        `${detail.turn.model ? ` on ${detail.turn.model}` : ""}, ${detail.turn.toolCallCount} tool call(s).`,
    );
    if (detail.turn.files.length > 0) {
      lines.push(
        "",
        "Files that turn touched:",
        ...detail.turn.files.map((f) => `- ${f.op} \`${f.relPath}\` (${f.source})`),
      );
    }
  } else {
    lines.push(
      "",
      "No session could be attributed to this commit, so there is no prompt behind it.",
    );
  }

  lines.push(
    "",
    "## What the commit changed",
    "",
    ...detail.commitFiles.map((f) => `- ${f.status} \`${f.path}\``),
    "",
    `Read the diff with \`git show ${short}\` when you need it — it is not pasted here on purpose.`,
    "",
    "Answer from what actually happened in that turn. Where the record does not say,",
    "say you don't know rather than reading the code and inferring intent.",
  );
  return lines.join("\n");
}

export function checkpointRoutes(app: FastifyInstance): void {
  /** One checkpoint: the commit, the turn behind it, and both file lists. */
  app.get<{ Params: { id: string; cpId: string } }>(
    "/api/projects/:id/checkpoints/:cpId",
    async (req, reply) => {
      const { id, cpId } = params.parse(req.params);
      const detail = checkpointDetail(cpId);
      if (!detail || detail.projectId !== id) {
        return reply.code(404).send({ error: "Checkpoint not found" });
      }
      return detail;
    },
  );

  /**
   * "Ask this checkpoint": a new Claude terminal that already knows the commit.
   *
   * A terminal, not an Agent-SDK chat — which is a change from the plan, made
   * because the app has no surface for a `kind: "chat"` session any more (only
   * agent workspaces get a tab). Every other hand-off in the app — Jira, a PR —
   * opens a claude terminal with the context typed into it and never auto-sent,
   * so this one behaves the same way rather than inventing a second convention.
   */
  app.post<{ Params: { id: string; cpId: string } }>(
    "/api/projects/:id/checkpoints/:cpId/work-with-claude",
    async (req, reply) => {
      const { id, cpId } = params.parse(req.params);
      const body = z
        .object({ cwdPathId: z.string().optional(), useWorktree: z.boolean().optional() })
        .parse(req.body ?? {});
      const detail = checkpointDetail(cpId);
      if (!detail || detail.projectId !== id) {
        return reply.code(404).send({ error: "Checkpoint not found" });
      }
      const terminal = createTerminal(id, {
        kind: "claude",
        title: `Checkpoint ${detail.commitSha.slice(0, 8)}`,
        // Default to the repo the commit is in, not the project's default path.
        cwdPathId: body.cwdPathId ?? detail.projectPathId ?? undefined,
        useWorktree: body.useWorktree,
      });
      reply.code(201);
      return { terminalId: terminal.id, seed: buildSeedPrompt(detail) };
    },
  );

  /** Every commit attributed to one session. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/checkpoints", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const query = z
      .object({ chatSessionId: z.string().optional(), claudeSessionId: z.string().optional() })
      .parse(req.query ?? {});
    if (!query.chatSessionId && !query.claudeSessionId) {
      return { commits: [], orphans: orphanCount(id) };
    }
    return {
      commits: checkpointsOfSession(query).filter((c) => c.projectId === id),
      orphans: orphanCount(id),
    };
  });

  /**
   * Read this repo's commits now, instead of waiting for a ref to move.
   *
   * The watcher covers the normal case; this is for after a rebase done outside
   * the app, and for a repo where no filesystem watcher could be started.
   */
  app.post<{ Params: { id: string } }>("/api/projects/:id/checkpoints/scan", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const query = z.object({ pathId: z.string().optional() }).parse(req.query ?? {});
    const cwd = resolveTree(id, query);
    const result = ingest(cwd);
    return { ...result, orphaned: reconcileGoneCommits(cwd) };
  });
}
