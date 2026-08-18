import "./lib/env-file"; // must be first: applies <repo>/.env before anything reads it
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { registerAuth, TOKEN } from "./lib/auth";
import { env, setting } from "./lib/config";
import { REPO_ROOT } from "./lib/repo-root";
import { agentRoutes } from "./routes/agents";
import { backupRoutes } from "./routes/backup";
import { attachmentRoutes } from "./routes/attachments";
import { chatRoutes } from "./routes/chat";
import { commandRoutes } from "./routes/commands";
import { envRoutes } from "./routes/env";
import { gitRoutes } from "./routes/git";
import { integrationRoutes } from "./routes/integrations";
import { knowledgeRoutes } from "./routes/knowledge";
import { memoryRoutes } from "./routes/memory";
import { projectRoutes } from "./routes/projects";
import { searchRoutes } from "./routes/search";
import { settingsRoutes } from "./routes/settings";
import { terminalRoutes } from "./routes/terminals";
import { workflowRoutes } from "./routes/workflows";
import { seedGlobalMemories } from "./services/memory";
import { backfillChatSearch, ensureSearchTables } from "./services/search";
import { reconcileWorktreesOnBoot } from "./services/sessions";
import { reconcileRunsOnBoot } from "./services/workflow-runner";
import { killAllRuns } from "./services/commands";
import { killAll as killAllPtys, tmuxEnabled } from "./services/pty-manager";
import * as tmux from "./lib/tmux";
import { chatWs } from "./ws/chat-ws";
import { workflowWs } from "./ws/workflow-ws";
import { commandWs } from "./ws/command-ws";
import { gitWs } from "./ws/git-ws";
import { terminalWs } from "./ws/terminal-ws";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.setErrorHandler((err: unknown, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "Validation failed", issues: err.issues });
  }
  const statusCode =
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as { statusCode?: unknown }).statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : 500;
  if (statusCode >= 500) app.log.error(err);
  const message = err instanceof Error ? err.message : "Internal error";
  return reply.code(statusCode).send({ error: message });
});

await app.register(fastifyWebsocket);
// Folder imports send one part per file — the default parts cap (1000) is too
// small for a real directory; per-route fileSize limits stay the byte guard.
// preservePath keeps the relative path in part.filename (busboy strips it by
// default); every consumer sanitises the name before touching the filesystem.
await app.register(fastifyMultipart, {
  preservePath: true,
  limits: { fileSize: 64 * 1024 * 1024, files: 2000, parts: 2100, fields: 20 },
});
registerAuth(app);

// FTS5 tables + triggers live outside drizzle's schema.
ensureSearchTables();
backfillChatSearch();
// Built-in global memory notes — inserted once each, then left alone.
seedGlobalMemories();
// Our own tmux socket gets its config rewritten every boot: the settings there are
// what make a session usable in an embedded xterm (no status bar, mouse scrolling).
if (tmuxEnabled()) {
  tmux.writeConfig();
  app.log.info(`terminals run inside tmux (${tmux.probe().detail}, socket ${tmux.TMUX_SOCKET})`);
} else if (setting("terminal.tmux")) {
  app.log.warn(`tmux not usable, terminals run as plain PTYs — ${tmux.probe().detail}`);
}
// A step that was mid-flight when the process died is marked interrupted, never
// resumed blind: it may already have edited files or commented on a ticket.
const interruptedSteps = reconcileRunsOnBoot();
if (interruptedSteps > 0) {
  app.log.warn(
    `${interruptedSteps} workflow step(s) interrupted by a restart — resume from the UI`,
  );
}
// A worktree whose session is gone keeps its branch checked out, which makes that
// branch impossible to switch to or delete until the worktree is dropped.
const worktrees = reconcileWorktreesOnBoot();
if (worktrees.removed.length > 0) {
  app.log.info(
    `Removed ${worktrees.removed.length} orphaned worktree(s): ${worktrees.removed.join(", ")}`,
  );
}
for (const path of worktrees.kept) {
  app.log.warn(`Orphaned worktree kept — it still holds work: ${path}`);
}

app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));
// Gated on purpose: the UI calls this to find out whether the token it holds is
// still the one we accept, before it renders an app that would 401 everywhere.
app.get("/api/auth/check", async () => ({ ok: true }));

projectRoutes(app);
terminalRoutes(app);
commandRoutes(app);
chatRoutes(app);
attachmentRoutes(app);
agentRoutes(app);
gitRoutes(app);
knowledgeRoutes(app);
memoryRoutes(app);
workflowRoutes(app);
integrationRoutes(app);
searchRoutes(app);
envRoutes(app);
settingsRoutes(app);
backupRoutes(app);
terminalWs(app);
commandWs(app);
chatWs(app);
workflowWs(app);
gitWs(app);

// Prod mode: serve the built web app from the same port.
const webDist = join(REPO_ROOT, "web/dist");
if (env.isProd && existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html"); // SPA fallback
  });
}

// Never leave orphaned shells or build processes behind. tmux-backed terminals are
// only detached here — they are meant to survive a restart and be reattached.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    killAllPtys();
    killAllRuns();
    app.close().finally(() => process.exit(0));
  });
}

try {
  await app.listen({ port: env.port, host: env.host });
  // The hosts alias is redirected from port 80, so it needs no port either way.
  const uiUrl = env.stationHost
    ? `http://${env.stationHost}`
    : env.isProd
      ? `http://${env.host}:${env.port}`
      : `http://${env.host}:${env.webPort}`;
  console.log(`\n  claude-station ready\n  → ${uiUrl}/?t=${TOKEN}\n`);
  console.log(`  (token also in data/.token — API needs header x-cs-token)\n`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
