/**
 * The one endpoint every Reach command calls.
 *
 * Called by `curl` from inside a `claude` terminal, not by the browser — which is
 * why the arguments arrive as query parameters and why the auth guard's
 * "no Origin header is fine" rule matters here (`lib/auth.ts`).
 *
 * One endpoint rather than one per command: every answer is text destined for the
 * same place, under the same cap and the same redaction, and a new command should
 * be a row in a table rather than a route.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REACH_KINDS, projectForCwd, resolve, writeNote } from "../services/reach";
import { refreshMirrors } from "../services/reach-mirror";
import { localAssets } from "../services/reach-assets";
import { remoteSuggestions } from "../services/reach-remote";
import {
  installReachCommands,
  REACH_COMMANDS,
  removeReachCommands,
} from "../services/reach-skills";

const resolveQuery = z.object({
  kind: z.string(),
  q: z.string().optional(),
  /** The terminal's working directory — how a command knows which project it is in. */
  cwd: z.string(),
  limit: z.coerce.number().int().min(256).max(32_000).optional(),
});

export function reachRoutes(app: FastifyInstance): void {
  /**
   * Form-encoded bodies, for the one Reach command that writes.
   *
   * Fastify parses JSON and nothing else here, and `curl --data-urlencode` — the
   * only way to pass a note containing quotes and newlines without building a
   * shell quoting minefield — sends form encoding. Five lines instead of another
   * dependency, and purely additive: this content type used to be a 415.
   */
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /**
   * Answers as plain text, not JSON: the caller pipes this straight into a
   * prompt, and making a shell command unwrap JSON first would put `jq` between
   * the station and every answer.
   */
  app.get("/api/reach/resolve", async (req, reply) => {
    const query = resolveQuery.parse(req.query ?? {});
    const result = await resolve(query);
    reply.type("text/plain; charset=utf-8");
    return result.text;
  });

  /**
   * The one Reach call that changes something.
   *
   * A POST because it does: a terminal has no station MCP server (that is only
   * wired for workflow steps), so this is the only way a session running in one
   * can keep what it learned. Body is form-encoded, which is what `curl
   * --data-urlencode` sends without extra flags.
   */
  app.post("/api/reach/note", async (req, reply) => {
    const body = z
      .object({ cwd: z.string(), q: z.string().optional() })
      .parse((req.body ?? {}) as Record<string, unknown>);
    reply.type("text/plain; charset=utf-8");
    return writeNote(body.cwd, body.q ?? "").text;
  });

  /**
   * Rebuild the `.station/` pointers for a project, on demand.
   *
   * Normally done when a Claude terminal opens; this is for the case where the
   * stores changed while one was already running.
   */
  app.post<{ Params: { id: string } }>("/api/projects/:id/reach/mirror", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return { mirrors: refreshMirrors(id) };
  });

  /**
   * The `@`-able assets for a working directory.
   *
   * Feeds the picker this app owns, which types the path in — the CLI's own
   * suggestion menu is not something this side can see or test.
   */
  app.get("/api/reach/assets", async (req) => {
    const query = z
      .object({ cwd: z.string(), remote: z.coerce.boolean().default(false) })
      .parse(req.query ?? {});
    const repo = projectForCwd(query.cwd);
    if (!repo) return { assets: [], project: null };

    // Local first and remote on a second call, because Jira and GitHub are a
    // network round trip and a picker that waits for them opens slowly every
    // time — including the nine times out of ten somebody wanted a local file.
    const assets = query.remote ? await remoteSuggestions() : localAssets(repo);
    return { assets, project: repo.projectName };
  });

  app.get("/api/reach/commands", async () => ({
    commands: REACH_COMMANDS.map((c) => ({
      name: c.name,
      kind: c.kind,
      description: c.description,
      argument: c.argument?.name ?? null,
      modelInvocable: c.modelInvocable,
    })),
    kinds: REACH_KINDS,
  }));

  app.post("/api/reach/install", async () => ({ written: installReachCommands(true) }));

  app.delete("/api/reach/install", async () => ({ removed: removeReachCommands() }));
}
