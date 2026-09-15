/** The shapes `/api/insights/*` returns. Mirrors `server/src/routes/insights.ts`. */

/** Summed columns every grouping carries. */
export interface Totals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  /** How much of `costUsd` we derived from a price table rather than were told. */
  estimatedCost: number;
  /** Turns with no cost at all — no report, and no price for their model. */
  unpricedTurns: number;
  linesAdded: number;
  linesRemoved: number;
  toolCalls: number;
  errors: number;
}

export interface DayRow extends Totals {
  day: string;
}
export interface ProjectRow extends Totals {
  projectId: string;
  name: string | null;
}
export interface ModelRow extends Totals {
  model: string;
}
export interface SourceRow extends Totals {
  sourceKind: "sdk" | "cli";
}

export interface TopTurn {
  id: string;
  projectId: string;
  projectName: string | null;
  sourceKind: "sdk" | "cli";
  model: string | null;
  promptPreview: string;
  costUsd: number | null;
  costSource: "reported" | "estimated" | "unknown";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  linesAdded: number;
  linesRemoved: number;
  toolCallCount: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export interface CaptureRow {
  status: "ok" | "degraded" | "stopped";
  count: number;
  details: string[];
}

export interface UsageResponse {
  window: { days: number; from: string };
  totals: Totals | null;
  daily: DayRow[];
  byProject: ProjectRow[];
  byModel: ModelRow[];
  bySource: SourceRow[];
  top: TopTurn[];
  capture: CaptureRow[];
  pricing: { fetchedAt: string; models: number } | null;
}

export interface FilesResponse {
  window: { days: number; from: string };
  byExtension: { ext: string; files: number; reads: number; writes: number }[];
}
