/**
 * What the agents did, next to the audit feed that says what the app did.
 *
 * One row per turn: the prompt, what it cost, how many files it changed. Opening a
 * row shows the files, and where each claim came from — `tree` means the working
 * tree really moved, `tool` means a tool call said so and could have missed an
 * edit made through the shell.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronRight, Terminal } from "@/components/ui/icons";
import { Badge } from "@/components/ui/card";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface TurnRow {
  id: string;
  sourceKind: "sdk" | "cli";
  seq: number;
  model: string | null;
  gitBranch: string | null;
  promptPreview: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  toolCallCount: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
  fileCount: number;
}

interface TurnDetail extends TurnRow {
  promptText: string;
  files: {
    absPath: string;
    relPath: string;
    op: "read" | "write" | "delete";
    source: "tree" | "tool";
    toolName: string | null;
  }[];
}

const STATUS_TONE: Record<string, string> = {
  error: "text-error",
  interrupted: "text-warn",
  running: "text-accent",
};

/** Thousands, because token counts are read at a glance, not summed by eye. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function TurnFiles({ projectId, turnId }: { projectId: string; turnId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["ledger-turn", projectId, turnId],
    queryFn: () => api.get<TurnDetail>(`/api/projects/${projectId}/ledger/turns/${turnId}`),
  });

  if (isLoading) return <p className="py-1 pl-8 text-ink-faint m3-label-sm">Loading…</p>;
  if (!data) return null;

  const written = data.files.filter((f) => f.op !== "read");
  const read = data.files.length - written.length;

  return (
    <div className="space-y-1 py-1 pl-8">
      {data.promptText && data.promptText !== data.promptPreview && (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-ink-muted m3-label-sm">
          {data.promptText}
        </p>
      )}
      {written.length === 0 ? (
        <p className="text-ink-faint m3-label-sm">No files changed.</p>
      ) : (
        written.map((file) => (
          <div
            key={`${file.source}-${file.op}-${file.absPath}`}
            className="flex items-baseline gap-2"
          >
            <span
              className={cn(
                "w-11 shrink-0 text-right font-mono m3-label-sm",
                file.op === "delete" ? "text-error" : "text-ink-faint",
              )}
            >
              {file.op}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono m3-label-sm text-ink">
              {file.relPath || file.absPath}
            </span>
            {/* Where the claim comes from. `tree` is ground truth; `tool` is a
                tool call's word for it and misses shell-driven edits. */}
            <span
              className={cn(
                "shrink-0 m3-label-sm",
                file.source === "tree" ? "text-ink-muted" : "text-ink-faint",
              )}
              title={
                file.source === "tree"
                  ? "The working tree really changed across this turn"
                  : `Named by a ${file.toolName ?? "tool"} call`
              }
            >
              {file.source === "tree" ? "tree" : (file.toolName ?? "tool")}
            </span>
          </div>
        ))
      )}
      {read > 0 && <p className="text-ink-faint m3-label-sm">and {read} file(s) read</p>}
    </div>
  );
}

export function TurnsPanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const { data: turns = [], isLoading } = useQuery({
    queryKey: ["ledger-recent", projectId],
    queryFn: () => api.get<TurnRow[]>(`/api/projects/${projectId}/ledger/recent?limit=50`),
  });

  if (isLoading) return <p className="text-ink-muted m3-label-sm">Loading turns…</p>;
  if (turns.length === 0) {
    return (
      <p className="text-ink-faint m3-label-sm">
        No turns recorded yet. They appear as Claude works — in a terminal tab or an agent
        workspace.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {turns.map((turn) => {
        const isOpen = open === turn.id;
        return (
          <div key={turn.id}>
            <button
              onClick={() => setOpen(isOpen ? null : turn.id)}
              className="flex w-full cursor-pointer items-baseline gap-2 rounded-md px-1.5 py-1 text-left hover:bg-white/6"
            >
              <span className="mt-0.5 shrink-0 text-ink-faint">
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
              <span className="w-14 shrink-0 font-mono m3-label-sm text-ink-faint">
                {new Date(turn.startedAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span
                className="shrink-0 text-ink-faint"
                title={turn.sourceKind === "cli" ? "Terminal tab" : "Agent workspace"}
              >
                {turn.sourceKind === "cli" ? <Terminal size={12} /> : <Bot size={12} />}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink m3-label-md">
                {turn.promptPreview || <span className="text-ink-faint">(no prompt recorded)</span>}
              </span>
              {turn.fileCount > 0 && (
                <Badge className="shrink-0">
                  {turn.fileCount} file{turn.fileCount > 1 ? "s" : ""}
                </Badge>
              )}
              <span className="shrink-0 font-mono m3-label-sm text-ink-faint">
                {tokens(turn.outputTokens)} out
              </span>
              {/* Only the SDK reports a cost; a terminal turn has none to report. */}
              {turn.costUsd !== null && (
                <span className="shrink-0 font-mono m3-label-sm text-ink-faint">
                  ${turn.costUsd.toFixed(2)}
                </span>
              )}
              {turn.status !== "done" && (
                <span className={cn("shrink-0 m3-label-sm", STATUS_TONE[turn.status])}>
                  {turn.status}
                </span>
              )}
            </button>
            {isOpen && <TurnFiles projectId={projectId} turnId={turn.id} />}
          </div>
        );
      })}
    </div>
  );
}
