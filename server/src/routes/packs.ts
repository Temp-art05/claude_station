/**
 * Installing a repo's worth of skills, agents and workflows.
 *
 * Two steps on purpose: `preview` clones and reports, `install` registers what
 * was chosen. A one-call version would mean the first time anyone saw what a
 * pack contained was after it was already in their prompts.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  discardStaged,
  installPack,
  listPacks,
  packDiff,
  previewPack,
  uninstallPack,
  updatePack,
} from "../services/packs";

const idParam = z.object({ id: z.string() });

const previewBody = z.object({
  repoUrl: z.string().min(4),
  ref: z.string().default("HEAD"),
});

const installBody = z.object({
  name: z.string(),
  repoUrl: z.string(),
  ref: z.string().default("HEAD"),
  sha: z.string(),
  stagedPath: z.string(),
  /** The user's selection from the preview. Empty means install nothing. */
  relPaths: z.array(z.string()).default([]),
});

export function packRoutes(app: FastifyInstance): void {
  app.get("/api/packs", async () => listPacks());

  app.post("/api/packs/preview", async (req) => {
    const body = previewBody.parse(req.body ?? {});
    return await previewPack(body.repoUrl, body.ref);
  });

  app.post("/api/packs/discard", async (req, reply) => {
    const body = z.object({ stagedPath: z.string() }).parse(req.body ?? {});
    discardStaged(body.stagedPath);
    return reply.code(204).send();
  });

  app.post("/api/packs", async (req) => {
    const body = installBody.parse(req.body ?? {});
    return installPack(body, body.relPaths);
  });

  app.get<{ Params: { id: string } }>("/api/packs/:id/diff", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const diff = packDiff(id);
    if (!diff) return reply.code(404).send({ error: "No such pack, or its remote is unreachable" });
    return diff;
  });

  /**
   * Move a pack to the latest commit on its ref.
   *
   * "Already current" comes back as a **200**, not an error: it is the ordinary
   * answer, and the version that sent a 409 gave the UI nothing to say, so the
   * button looked dead exactly when it had worked.
   */
  app.post<{ Params: { id: string } }>("/api/packs/:id/update", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const outcome = updatePack(id);
    if (outcome.status === "missing") {
      return reply.code(404).send({ error: "No such pack, or its clone is gone" });
    }
    if (outcome.status === "unreachable") {
      return reply.code(502).send({ error: "Could not reach the remote to check for updates" });
    }
    return outcome;
  });

  app.delete<{ Params: { id: string } }>("/api/packs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    if (!uninstallPack(id)) return reply.code(404).send({ error: "No such pack" });
    return reply.code(204).send();
  });
}
