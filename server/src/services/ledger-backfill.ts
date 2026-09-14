/**
 * Getting history into the ledger that predates capture — including conversations
 * that ran outside the app entirely, which the History panel already lists from
 * `~/.claude/projects`.
 *
 * This runs at boot, which the first draft of the plan said it must not: the fear
 * was 219 transcripts making startup crawl. Measured, the whole store — 306MB —
 * parses in 820ms, and the scan skips any file nothing was appended to, so the
 * second boot does almost no work. The Settings button stays, with a narrower job:
 * a full reindex after the parser changes.
 */
import { statSync } from "node:fs";
import { transcriptsUnder, transcriptPath } from "../lib/claude-transcript";
import { db, schema } from "../db";
import { pathUnder } from "../lib/path-compare";
import * as ledger from "./session-ledger";
import { catchUpTranscript, indexTranscript, isFollowing } from "./transcript-follower";

export interface ScanResult {
  /** Never seen before: parsed in full. */
  indexed: number;
  /** Known, but appended to since: read on from the stored offset. */
  caughtUp: number;
  /** Unchanged, or being followed live by a terminal tab. */
  skipped: number;
}

interface ProjectRepo {
  projectId: string;
  path: string;
}

function projectRepos(projectId?: string): ProjectRepo[] {
  const rows = db
    .select({ projectId: schema.projectPaths.projectId, path: schema.projectPaths.path })
    .from(schema.projectPaths)
    .all();
  return projectId ? rows.filter((r) => r.projectId === projectId) : rows;
}

/**
 * Which project a conversation belongs to, by its recorded cwd.
 *
 * The longest matching repo wins, the same rule the ledger uses for files: nested
 * project paths are a real shape here, and the innermost one is the answer.
 */
function ownerOf(cwd: string, repos: ProjectRepo[]): ProjectRepo | null {
  let best: ProjectRepo | null = null;
  for (const repo of repos) {
    if (!pathUnder(cwd, repo.path)) continue;
    if (!best || repo.path.length > best.path.length) best = repo;
  }
  return best;
}

/**
 * Index every transcript that belongs to a configured repo.
 *
 * `full` forces a reparse of everything, for when the parser itself changed;
 * without it the scan does the least work that keeps the ledger current.
 */
export function scanTranscripts(opts: { projectId?: string; full?: boolean } = {}): ScanResult {
  const result: ScanResult = { indexed: 0, caughtUp: 0, skipped: 0 };
  if (!ledger.ledgerEnabled()) return result;

  const repos = projectRepos(opts.projectId);
  if (repos.length === 0) return result;

  for (const transcript of transcriptsUnder(repos.map((r) => r.path))) {
    const owner = ownerOf(transcript.cwd, repos);
    if (!owner) {
      result.skipped += 1;
      continue;
    }

    // A live tab owns its own conversation; reindexing under it would delete the
    // turn it is currently filling.
    if (isFollowing(transcript.sessionId)) {
      result.skipped += 1;
      continue;
    }

    const file = transcriptPath(transcript.sessionId);
    if (!file) {
      result.skipped += 1;
      continue;
    }

    const saved = ledger.getCapture(transcript.sessionId);
    const input = {
      claudeSessionId: transcript.sessionId,
      projectId: owner.projectId,
      cwd: transcript.cwd,
      transcriptFile: file,
    };

    if (!saved || opts.full) {
      indexTranscript(input);
      result.indexed += 1;
      continue;
    }

    let unchanged: boolean;
    try {
      const stat = statSync(file);
      unchanged = stat.size === saved.sizeBytes && Math.round(stat.mtimeMs) === saved.mtimeMs;
    } catch {
      unchanged = false;
    }
    if (unchanged) {
      result.skipped += 1;
      continue;
    }

    // Appended to since we last looked: read on from the offset rather than
    // reparsing, so a 29MB transcript costs the size of the append.
    catchUpTranscript(input);
    result.caughtUp += 1;
  }

  return result;
}
