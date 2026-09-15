/**
 * C6 — proposing a workflow out of work that actually happened.
 *
 * This is the one item on the roadmap that Atlas has no equivalent for, and the
 * reason is instructive: Atlas records sessions, this app also *runs* things.
 * Every project command executed here leaves a `command_runs` row with its name,
 * its exit code and its time, so "what do you actually do, in what order" is a
 * query rather than a guess.
 *
 * # What it will and will not claim
 *
 * It looks at **commands**, not at prose. A suggestion is a sequence of named
 * commands that ran close together, more than once, in the same repo — which is
 * exactly the shape a workflow already has, and needs no interpretation of what
 * anybody meant. It does not read prompts, it does not infer intent, and it does
 * not call a model.
 *
 * That is a deliberate ceiling. The obvious next step is "notice that the agent
 * kept doing implement → test → fix and propose a gate", which needs a judgement
 * about what a turn was *for* — and a wrong judgement produces a confident
 * suggestion for work nobody does. A sequence of commands is either repeated or
 * it is not.
 *
 * Nothing here writes a workflow. It returns a draft the person opens in the
 * editor, because a workflow that appeared by itself is one nobody reviewed.
 */
import { and, asc, eq, gte } from "drizzle-orm";
import { db, schema } from "../db";

/** Runs further apart than this are separate pieces of work, not one sequence. */
const SESSION_GAP_MS = 20 * 60 * 1000;
/** A sequence has to have happened this often before it is worth proposing. */
const MIN_OCCURRENCES = 2;
/** Longer than this and it is a day's work, not a workflow. */
const MAX_LENGTH = 8;

export interface Suggestion {
  /** The command names, in the order they ran. */
  steps: string[];
  /** How many separate times this exact sequence happened. */
  occurrences: number;
  /** How often it ended with every command succeeding. */
  cleanRuns: number;
  lastSeenAt: string;
  /** The repo it ran in, when it was always the same one. */
  cwd: string | null;
  /** A name for the draft, derived from the ends of the sequence. */
  title: string;
}

interface RunRow {
  name: string;
  cwd: string;
  exitCode: number | null;
  startedAt: string;
}

/**
 * Split a project's command history into sittings.
 *
 * A gap in time is the only separator available and it is a good one: the thing
 * being looked for is "these ran together", and two runs twenty minutes apart
 * were not part of the same thought.
 */
export function intoSittings(runs: readonly RunRow[]): RunRow[][] {
  const sittings: RunRow[][] = [];
  let current: RunRow[] = [];
  let previous = 0;

  for (const run of runs) {
    const at = Date.parse(run.startedAt);
    if (current.length > 0 && at - previous > SESSION_GAP_MS) {
      sittings.push(current);
      current = [];
    }
    current.push(run);
    previous = at;
  }
  if (current.length > 0) sittings.push(current);
  return sittings;
}

/**
 * Collapse a sitting into the sequence of distinct commands it was made of.
 *
 * Immediate repeats are folded — running the tests four times while fixing them
 * is one step of the workflow, not four — and that folding is why the same work
 * on two different days produces the same sequence.
 */
export function sequenceOf(sitting: readonly RunRow[]): string[] {
  const names: string[] = [];
  for (const run of sitting) {
    if (names[names.length - 1] !== run.name) names.push(run.name);
  }
  return names.slice(0, MAX_LENGTH);
}

/**
 * Sequences this project has actually repeated, most frequent first.
 *
 * Sub-sequences count too: `build → test → deploy` also counts as evidence for
 * `build → test`, because the shorter one is a real thing people run on its own
 * and would otherwise be invisible behind the longer one.
 */
export function suggestFromHistory(projectId: string, days = 60): Suggestion[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const runs = db
    .select({
      name: schema.commandRuns.name,
      cwd: schema.commandRuns.cwd,
      exitCode: schema.commandRuns.exitCode,
      startedAt: schema.commandRuns.startedAt,
    })
    .from(schema.commandRuns)
    .where(
      and(eq(schema.commandRuns.projectId, projectId), gte(schema.commandRuns.startedAt, since)),
    )
    .orderBy(asc(schema.commandRuns.startedAt))
    .all();

  if (runs.length < MIN_OCCURRENCES * 2) return [];

  const seen = new Map<
    string,
    {
      steps: string[];
      occurrences: number;
      cleanRuns: number;
      lastSeenAt: string;
      cwds: Set<string>;
    }
  >();

  for (const sitting of intoSittings(runs)) {
    const steps = sequenceOf(sitting);
    if (steps.length < 2) continue;
    const clean = sitting.every((run) => run.exitCode === 0);
    const cwds = new Set(sitting.map((run) => run.cwd));
    const lastSeenAt = sitting[sitting.length - 1]!.startedAt;

    // Every prefix of length >= 2: the whole sitting, and the shorter runs
    // inside it that are worth proposing on their own.
    for (let length = 2; length <= steps.length; length += 1) {
      const slice = steps.slice(0, length);
      // JSON rather than a joined string: a command name can contain anything,
      // and two different sequences must never collapse onto one key.
      const key = JSON.stringify(slice);
      const entry = seen.get(key) ?? {
        steps: slice,
        occurrences: 0,
        cleanRuns: 0,
        lastSeenAt,
        cwds: new Set<string>(),
      };
      entry.occurrences += 1;
      if (clean) entry.cleanRuns += 1;
      if (lastSeenAt > entry.lastSeenAt) entry.lastSeenAt = lastSeenAt;
      for (const cwd of cwds) entry.cwds.add(cwd);
      seen.set(key, entry);
    }
  }

  return [...seen.values()]
    .filter((entry) => entry.occurrences >= MIN_OCCURRENCES)
    .map((entry) => ({
      steps: entry.steps,
      occurrences: entry.occurrences,
      cleanRuns: entry.cleanRuns,
      lastSeenAt: entry.lastSeenAt,
      cwd: entry.cwds.size === 1 ? [...entry.cwds][0]! : null,
      title: `${entry.steps[0]} → ${entry.steps[entry.steps.length - 1]}`,
    }))
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        b.steps.length - a.steps.length ||
        b.lastSeenAt.localeCompare(a.lastSeenAt),
    )
    .slice(0, 8);
}

/**
 * The suggestion as a workflow definition, ready for the editor.
 *
 * Command steps only, chained in order — no agent step is invented, because
 * nothing in the command history says an agent was involved, and a draft that
 * guesses is a draft that has to be un-guessed by hand.
 */
export function draftFrom(suggestion: Suggestion): {
  name: string;
  description: string;
  steps: {
    key: string;
    type: "command";
    title: string;
    commandName: string;
    dependsOn: string[];
  }[];
} {
  const steps = suggestion.steps.map((name, index) => ({
    key: `s${index + 1}`,
    type: "command" as const,
    title: name,
    commandName: name,
    dependsOn: index === 0 ? [] : [`s${index}`],
  }));

  return {
    name: suggestion.title,
    description:
      `Proposed from this project's own command history: this sequence ran ` +
      `${suggestion.occurrences} times, ${suggestion.cleanRuns} of them with every command ` +
      `succeeding. Nothing has been created — edit it into shape before saving.`,
    steps,
  };
}
