/**
 * Reading the session ledger, and asking it to index history.
 *
 * The ledger is written by the capture surfaces, never by a client — there is no
 * POST here that records a turn. What a client can do is read what was recorded
 * and ask for a (re)index of the CLI's own transcripts.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../db";
import { desc, eq } from "drizzle-orm";
import { assertPathAllowed, badRequest } from "../lib/path-safety";
import { scanTranscripts } from "../services/ledger-backfill";
import {
  captureHealth,
  filesOf,
  turnsOf,
  turnsTouching,
  type Turn,
} from "../services/session-ledger";

const idParam = z.object({ id: z.string() });

/**
 * A turn as a client wants it: no full prompt text unless it was asked for.
 *
 * The prompt is the most valuable field in the record and also the largest, so a
 * list of 200 turns sends previews and a single turn sends the whole thing.
 */
function toRow(turn: Turn) {
  return {
    id: turn.id,
    projectId: turn.projectId,
    sourceKind: turn.sourceKind,
    chatSessionId: turn.chatSessionId,
    claudeSessionId: turn.claudeSessionId,
    terminalId: turn.terminalId,
    workflowRunId: turn.workflowRunId,
    seq: turn.seq,
    cwd: turn.cwd,
    gitBranch: turn.gitBranch,
    model: turn.model,
    promptPreview: turn.promptPreview,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheCreateTokens: turn.cacheCreateTokens,
    costUsd: turn.costUsd,
    durationMs: turn.durationMs,
    toolCallCount: turn.toolCallCount,
    status: turn.status,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
  };
}

export function ledgerRoutes(app: FastifyInstance): void {
  /** Turns of one conversation, whichever surface it ran on. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/ledger/turns", async (req) => {
    const { id } = idParam.parse(req.params);
    const query = z
      .object({
        chatSessionId: z.string().optional(),
        claudeSessionId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query ?? {});

    if (!query.chatSessionId && !query.claudeSessionId) {
      throw badRequest("Pass chatSessionId or claudeSessionId");
    }
    const key = query.chatSessionId
      ? { chatSessionId: query.chatSessionId }
      : { claudeSessionId: query.claudeSessionId! };

    return turnsOf(key, query.limit)
      .filter((turn) => turn.projectId === id)
      .map(toRow);
  });

  /**
   * The project's most recent turns, whichever surface they ran on.
   *
   * What the History panel lists next to the audit feed: the feed says what the
   * app did, this says what the agents did.
   */
  app.get<{ Params: { id: string } }>("/api/projects/:id/ledger/recent", async (req) => {
    const { id } = idParam.parse(req.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {});
    const rows = db
      .select()
      .from(schema.sessionTurns)
      .where(eq(schema.sessionTurns.projectId, id))
      .orderBy(desc(schema.sessionTurns.startedAt))
      .limit(limit)
      .all();
    return rows.map((turn) => ({
      ...toRow(turn),
      // The list is what a person scans; a count is enough until they open one.
      fileCount: filesOf(turn.id).filter((f) => f.op !== "read").length,
    }));
  });

  /** One turn in full: the prompt as it was, plus every file it touched. */
  app.get<{ Params: { id: string; turnId: string } }>(
    "/api/projects/:id/ledger/turns/:turnId",
    async (req, reply) => {
      const { id, turnId } = z.object({ id: z.string(), turnId: z.string() }).parse(req.params);
      const turn = db
        .select()
        .from(schema.sessionTurns)
        .where(eq(schema.sessionTurns.id, turnId))
        .get();
      if (!turn || turn.projectId !== id) return reply.code(404).send({ error: "Turn not found" });
      return {
        ...toRow(turn),
        promptText: turn.promptText,
        files: filesOf(turn.id).map((file) => ({
          absPath: file.absPath,
          relPath: file.relPath,
          projectPathId: file.projectPathId,
          op: file.op,
          // `tree` means the working tree really moved; `tool` is a tool call's
          // word for it, which misses anything done through the shell.
          source: file.source,
          toolName: file.toolName,
        })),
      };
    },
  );

  /**
   * Who last wrote this file. What the Diff tab asks to put a session behind an
   * uncommitted change.
   */
  app.get<{ Params: { id: string } }>("/api/projects/:id/ledger/file", async (req) => {
    const { id } = idParam.parse(req.params);
    const { path, limit } = z
      .object({ path: z.string().min(1), limit: z.coerce.number().int().min(1).max(50).default(5) })
      .parse(req.query ?? {});
    // Same guard as every other path-taking route: a client must not be able to
    // ask about files outside the project's own repos.
    const absPath = assertPathAllowed(path, id);
    return turnsTouching(id, absPath, limit).map(toRow);
  });

  /**
   * Index the CLI's transcripts for this project.
   *
   * `full=true` reparses everything, for after the parser changed; without it only
   * new and grown transcripts are read.
   */
  app.post<{ Params: { id: string } }>("/api/projects/:id/ledger/index", async (req) => {
    const { id } = idParam.parse(req.params);
    const { full } = z.object({ full: z.boolean().default(false) }).parse(req.body ?? {});
    return scanTranscripts({ projectId: id, full });
  });

  /** Same, across every project — the Settings button. */
  app.post("/api/ledger/index", async (req) => {
    const { full } = z.object({ full: z.boolean().default(false) }).parse(req.body ?? {});
    return scanTranscripts({ full });
  });

  /** One line per unhealthy conversation, for the Doctor panel. */
  app.get("/api/ledger/health", async () => ({ capture: captureHealth() }));
}
