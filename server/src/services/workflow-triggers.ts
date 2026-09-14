import { and, desc, eq } from "drizzle-orm";
import type { WorkflowTrigger, WorkflowTriggerInput } from "@claude-station/shared";
import { db, schema } from "../db";
import { setting } from "../lib/config";
import { newId, nowIso } from "../lib/id";
import { badRequest } from "../lib/path-safety";
import { githubConfig, issueDetail, listIssues } from "./gh";
import { issueContext, searchIssues } from "./jira";
import { notify } from "./notify";
import { advanceRun, createRun } from "./workflow-runner";
import { getWorkflow } from "./workflows";

/**
 * Work picking itself up.
 *
 * A workflow somebody starts is a tool; a workflow that starts when the work
 * appears is a team member. This is the difference, and it is also the part that
 * goes wrong quietly: a poller with a weak guard opens the same PR twice, and a
 * poller with an over-tight query never fires and looks like it is working.
 *
 * So two rules are load-bearing here. **Once taken, never retaken** — even if the
 * ticket changes afterwards, because the agent's own comment on that ticket
 * changes it, and "updated since we looked" would then be true for ever. And
 * **one run per trigger at a time** — the first poll of a label that already has
 * twenty issues must not start twenty runs.
 */

type TriggerRow = typeof schema.workflowTriggers.$inferSelect;

function toTrigger(row: TriggerRow): WorkflowTrigger {
  return {
    id: row.id,
    projectId: row.projectId,
    workflowId: row.workflowId,
    source: row.source === "jira" ? "jira" : "github",
    query: row.query,
    repo: row.repo,
    enabled: row.enabled,
    autoMode: row.autoMode,
    askPolicy: row.askPolicy === "assume" ? "assume" : "stop",
    pollSeconds: row.pollSeconds,
    cwdPathId: row.cwdPathId,
    envSetId: row.envSetId,
    lastPolledAt: row.lastPolledAt,
    lastSeenKey: row.lastSeenKey,
    status: row.status,
    detail: row.detail,
    createdAt: row.createdAt,
  };
}

export function listTriggers(projectId: string): WorkflowTrigger[] {
  return db
    .select()
    .from(schema.workflowTriggers)
    .where(eq(schema.workflowTriggers.projectId, projectId))
    .orderBy(desc(schema.workflowTriggers.createdAt))
    .all()
    .map(toTrigger);
}

export function getTrigger(id: string): WorkflowTrigger | null {
  const row = db
    .select()
    .from(schema.workflowTriggers)
    .where(eq(schema.workflowTriggers.id, id))
    .get();
  return row ? toTrigger(row) : null;
}

export function createTrigger(projectId: string, input: WorkflowTriggerInput): WorkflowTrigger {
  if (!getWorkflow(input.workflowId)) throw badRequest("Workflow not found");
  const id = newId();
  db.insert(schema.workflowTriggers)
    .values({
      id,
      projectId,
      workflowId: input.workflowId,
      source: input.source,
      query: input.query.trim(),
      repo: input.repo?.trim() || null,
      enabled: input.enabled,
      autoMode: input.autoMode,
      askPolicy: input.askPolicy,
      pollSeconds: input.pollSeconds,
      cwdPathId: input.cwdPathId,
      envSetId: input.envSetId,
      lastPolledAt: null,
      lastSeenKey: null,
      status: input.enabled ? "idle" : "disabled",
      detail: null,
      createdAt: nowIso(),
    })
    .run();
  return getTrigger(id)!;
}

export function updateTrigger(id: string, input: WorkflowTriggerInput): WorkflowTrigger {
  if (!getTrigger(id)) throw badRequest("Trigger not found");
  if (!getWorkflow(input.workflowId)) throw badRequest("Workflow not found");
  db.update(schema.workflowTriggers)
    .set({
      workflowId: input.workflowId,
      source: input.source,
      query: input.query.trim(),
      repo: input.repo?.trim() || null,
      enabled: input.enabled,
      autoMode: input.autoMode,
      askPolicy: input.askPolicy,
      pollSeconds: input.pollSeconds,
      cwdPathId: input.cwdPathId,
      envSetId: input.envSetId,
      status: input.enabled ? "idle" : "disabled",
    })
    .where(eq(schema.workflowTriggers.id, id))
    .run();
  return getTrigger(id)!;
}

export function deleteTrigger(id: string): void {
  db.delete(schema.workflowTriggers).where(eq(schema.workflowTriggers.id, id)).run();
}

/** For the Doctor panel: what is armed, and what is broken. */
export function triggerHealth(): {
  id: string;
  projectId: string;
  source: string;
  query: string;
  status: string;
  detail: string | null;
  lastPolledAt: string | null;
}[] {
  return db
    .select()
    .from(schema.workflowTriggers)
    .all()
    .filter((t) => t.enabled)
    .map((t) => ({
      id: t.id,
      projectId: t.projectId,
      source: t.source,
      query: t.query,
      status: t.status,
      detail: t.detail,
      lastPolledAt: t.lastPolledAt,
    }));
}

// ── Picking work up ───────────────────────────────────────────────────────────

interface Item {
  /** Stable across polls, and unique per trigger. */
  key: string;
  title: string;
  updatedAt: string;
  url: string;
  /** Everything the first step needs to start without asking. */
  goal: string;
}

async function githubItems(row: TriggerRow): Promise<Item[]> {
  const label = row.query.trim().toLowerCase();
  const repos = row.repo ? [row.repo] : githubConfig().repos;
  const out: Item[] = [];
  for (const repo of repos) {
    const issues = await listIssues(repo, 30);
    for (const issue of issues) {
      if (!issue.labels.some((l) => l.toLowerCase() === label)) continue;
      const detail = (await issueDetail(repo, issue.number)) as { body?: string };
      out.push({
        key: `github:${repo}#${issue.number}`,
        title: `${repo}#${issue.number} ${issue.title}`,
        updatedAt: issue.updatedAt,
        url: issue.url,
        goal: [
          `# Requirement: ${issue.title}`,
          `Source: GitHub issue ${repo}#${issue.number} — ${issue.url}`,
          "",
          detail.body?.trim() ||
            "(the issue has no body — read the title and ask if it is not enough)",
        ].join("\n"),
      });
    }
  }
  return out;
}

async function jiraItems(row: TriggerRow): Promise<Item[]> {
  const issues = await searchIssues(row.query, 20);
  const out: Item[] = [];
  for (const issue of issues) {
    out.push({
      key: `jira:${issue.key}`,
      title: `${issue.key} ${issue.summary}`,
      updatedAt: issue.updated,
      url: issue.url,
      goal: await issueContext(issue.key),
    });
  }
  return out;
}

function alreadyTaken(triggerId: string, itemKey: string): boolean {
  return (
    db
      .select()
      .from(schema.workflowTriggerSeen)
      .where(
        and(
          eq(schema.workflowTriggerSeen.triggerId, triggerId),
          eq(schema.workflowTriggerSeen.itemKey, itemKey),
        ),
      )
      .get() !== undefined
  );
}

/** One run per trigger at a time — the rest of the queue waits its turn. */
function hasLiveRun(triggerId: string): boolean {
  return db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.triggerId, triggerId))
    .all()
    .some((r) => r.status !== "done" && r.status !== "failed" && r.status !== "cancelled");
}

function setStatus(id: string, status: string, detail: string | null): void {
  db.update(schema.workflowTriggers)
    .set({ status, detail, lastPolledAt: nowIso() })
    .where(eq(schema.workflowTriggers.id, id))
    .run();
}

/**
 * Look once, and start at most one run. Exported so the UI can say "check now"
 * without waiting for the interval — which is also how you find out that a query
 * matches nothing, instead of assuming it is quiet.
 */
export async function pollTrigger(id: string): Promise<{ found: number; started: string | null }> {
  const row = db
    .select()
    .from(schema.workflowTriggers)
    .where(eq(schema.workflowTriggers.id, id))
    .get();
  if (!row) throw badRequest("Trigger not found");

  let items: Item[];
  try {
    items = row.source === "jira" ? await jiraItems(row) : await githubItems(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(row.id, "error", message.slice(0, 300));
    return { found: 0, started: null };
  }

  const fresh = items.filter((i) => !alreadyTaken(row.id, i.key));
  if (fresh.length === 0) {
    setStatus(row.id, "ok", items.length > 0 ? "nothing new" : "no matching work");
    return { found: 0, started: null };
  }
  if (hasLiveRun(row.id)) {
    setStatus(row.id, "ok", `${fresh.length} waiting — a run is still going`);
    return { found: fresh.length, started: null };
  }

  const item = fresh[0]!;
  let runId: string;
  try {
    const run = createRun(row.projectId, {
      workflowId: row.workflowId,
      title: item.title.slice(0, 120),
      goal: item.goal,
      cwdPathId: row.cwdPathId ?? undefined,
      envSetId: row.envSetId,
      autoMode: row.autoMode,
      askPolicy: row.askPolicy === "assume" ? "assume" : "stop",
      triggerId: row.id,
    });
    runId = run.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(row.id, "error", message.slice(0, 300));
    return { found: fresh.length, started: null };
  }

  // Marked taken before the run advances: if the first step throws, the ticket
  // stays taken rather than being picked up again on the next tick.
  db.insert(schema.workflowTriggerSeen)
    .values({
      id: newId(),
      triggerId: row.id,
      itemKey: item.key,
      itemUpdatedAt: item.updatedAt,
      runId,
      createdAt: nowIso(),
    })
    .run();
  db.update(schema.workflowTriggers)
    .set({ lastSeenKey: item.key })
    .where(eq(schema.workflowTriggers.id, row.id))
    .run();
  setStatus(row.id, "ok", `started a run for ${item.title}`);
  notify("Workflow picked up work", item.title);
  void advanceRun(runId);
  return { found: fresh.length, started: runId };
}

// ── The loop ──────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
const TICK_MS = 30_000;

function due(row: TriggerRow): boolean {
  if (!row.enabled) return false;
  if (!row.lastPolledAt) return true;
  return Date.parse(row.lastPolledAt) + row.pollSeconds * 1000 <= Date.now();
}

async function tick(): Promise<void> {
  if (!setting("workflows.triggersEnabled")) return;
  const rows = db.select().from(schema.workflowTriggers).all().filter(due);
  for (const row of rows) {
    try {
      await pollTrigger(row.id);
    } catch {
      // pollTrigger records its own failures; a thrown one here must not take
      // the loop down with it.
    }
  }
}

/**
 * Start watching. Safe to call twice, and cheap when the master switch is off —
 * which is how it ships, so that nothing fires until somebody says it should.
 */
export function startTriggerLoop(): number {
  if (timer) return watchedCount();
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return watchedCount();
}

export function stopTriggerLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function watchedCount(): number {
  if (!setting("workflows.triggersEnabled")) return 0;
  return db
    .select()
    .from(schema.workflowTriggers)
    .all()
    .filter((t) => t.enabled).length;
}
