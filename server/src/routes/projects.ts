import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  projectInputSchema,
  projectPathInputSchema,
  type PathCommandInput,
} from "@claude-station/shared";
import { db, schema } from "../db";
import { newId, nowIso } from "../lib/id";
import { prettyPath, resolveDirectory } from "../lib/path-safety";

const idParam = z.object({ id: z.string() });
const pathIdParam = z.object({ id: z.string(), pathId: z.string() });

function insertCommands(projectPathId: string, commands: PathCommandInput[]): void {
  commands.forEach((c, i) => {
    db.insert(schema.pathCommands)
      .values({
        id: newId(),
        projectPathId,
        name: c.name,
        kind: c.kind,
        command: c.command,
        cwdOverride: c.cwdOverride,
        timeoutSec: c.timeoutSec,
        sortOrder: i,
      })
      .run();
  });
}

function insertPath(
  projectId: string,
  input: z.infer<typeof projectPathInputSchema>,
  sortOrder: number,
  isDefault: boolean,
): string {
  const id = newId();
  db.insert(schema.projectPaths)
    .values({
      id,
      projectId,
      path: resolveDirectory(input.path),
      label: input.label,
      description: input.description,
      isDefault,
      sortOrder,
    })
    .run();
  insertCommands(id, input.commands);
  return id;
}

function loadProject(id: string) {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project) return null;
  const paths = db
    .select()
    .from(schema.projectPaths)
    .where(eq(schema.projectPaths.projectId, id))
    .orderBy(asc(schema.projectPaths.sortOrder))
    .all();
  return {
    ...project,
    paths: paths.map((p) => ({
      ...p,
      displayPath: prettyPath(p.path),
      commands: db
        .select()
        .from(schema.pathCommands)
        .where(eq(schema.pathCommands.projectPathId, p.id))
        .orderBy(asc(schema.pathCommands.sortOrder))
        .all(),
    })),
  };
}

export function projectRoutes(app: FastifyInstance): void {
  app.get("/api/projects", async () => {
    const projects = db
      .select()
      .from(schema.projects)
      .orderBy(desc(schema.projects.updatedAt))
      .all();
    return projects.map((p) => loadProject(p.id));
  });

  app.post("/api/projects", async (req, reply) => {
    const input = projectInputSchema.parse(req.body);
    const id = newId();
    const now = nowIso();
    // One transaction: a bad path must not leave a project with no repos behind.
    db.transaction(() => {
      db.insert(schema.projects)
        .values({
          id,
          name: input.name,
          description: input.description,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      input.paths.forEach((p, i) => insertPath(id, p, i, p.isDefault || i === 0));
      db.insert(schema.workHistory)
        .values({
          id: newId(),
          projectId: id,
          kind: "project_created",
          refId: id,
          summary: `Created project ${input.name}`,
          createdAt: now,
        })
        .run();
    });
    reply.code(201);
    return loadProject(id);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const project = loadProject(id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return project;
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = projectInputSchema.partial().parse(req.body);
    const existing = loadProject(id);
    if (!existing) return reply.code(404).send({ error: "Project not found" });

    // Same deal on edit: a rejected path must not wipe the existing ones.
    db.transaction(() => {
      db.update(schema.projects)
        .set({
          name: input.name ?? existing.name,
          description: input.description ?? existing.description,
          updatedAt: nowIso(),
        })
        .where(eq(schema.projects.id, id))
        .run();

      // Full replace of paths when provided — the form edits them as one list.
      if (input.paths) {
        db.delete(schema.projectPaths).where(eq(schema.projectPaths.projectId, id)).run();
        input.paths.forEach((p, i) => insertPath(id, p, i, p.isDefault || i === 0));
      }
    });
    return loadProject(id);
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    reply.code(204);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/paths", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = projectPathInputSchema.parse(req.body);
    if (!loadProject(id)) return reply.code(404).send({ error: "Project not found" });
    const count = db
      .select()
      .from(schema.projectPaths)
      .where(eq(schema.projectPaths.projectId, id))
      .all().length;
    insertPath(id, input, count, input.isDefault || count === 0);
    reply.code(201);
    return loadProject(id);
  });

  app.patch<{ Params: { id: string; pathId: string } }>(
    "/api/projects/:id/paths/:pathId",
    async (req, reply) => {
      const { id, pathId } = pathIdParam.parse(req.params);
      const input = projectPathInputSchema.partial().parse(req.body);
      const existing = db
        .select()
        .from(schema.projectPaths)
        .where(and(eq(schema.projectPaths.id, pathId), eq(schema.projectPaths.projectId, id)))
        .get();
      if (!existing) return reply.code(404).send({ error: "Path not found" });
      db.update(schema.projectPaths)
        .set({
          path: input.path ? resolveDirectory(input.path) : existing.path,
          label: input.label ?? existing.label,
          description: input.description ?? existing.description,
          isDefault: input.isDefault ?? existing.isDefault,
        })
        .where(eq(schema.projectPaths.id, pathId))
        .run();
      return loadProject(id);
    },
  );

  app.delete<{ Params: { id: string; pathId: string } }>(
    "/api/projects/:id/paths/:pathId",
    async (req, reply) => {
      const { id, pathId } = pathIdParam.parse(req.params);
      db.delete(schema.projectPaths)
        .where(and(eq(schema.projectPaths.id, pathId), eq(schema.projectPaths.projectId, id)))
        .run();
      reply.code(204);
    },
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/history", async (req) => {
    const { id } = idParam.parse(req.params);
    const { kind, limit } = z
      .object({ kind: z.string().optional(), limit: z.coerce.number().int().max(500).default(200) })
      .parse(req.query ?? {});
    const base = db
      .select()
      .from(schema.workHistory)
      .where(
        kind
          ? and(eq(schema.workHistory.projectId, id), eq(schema.workHistory.kind, kind))
          : eq(schema.workHistory.projectId, id),
      )
      .orderBy(desc(schema.workHistory.createdAt))
      .limit(limit);
    return base.all();
  });
}
