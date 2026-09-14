/**
 * The session behind a commit, and a way to ask it questions.
 *
 * Three visual states, because the record has three:
 *   - `exact`    filled badge; the app made the commit, or one session plainly did
 *   - `inferred` outlined badge with a `~`; the files line up but something else
 *                could explain it — the tooltip says the score and the reason
 *   - `orphan`   nothing at all, and the reason on hover of the plain sha
 *
 * `inferred` is shown rather than hidden: with the working-tree snapshot switched
 * off nearly every commit made outside the app lands there, and a feature that
 * shows nothing may as well not exist. It has to look different at a glance
 * though, not merely dimmer, or it will be read as certainty.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Bot, MessageSquarePlus, Terminal } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface CheckpointView {
  id: string;
  commitSha: string;
  confidence: "exact" | "inferred" | "orphan";
  score: number | null;
  reason: string;
  turnId: string | null;
  sessionKind: "sdk" | "cli" | null;
  promptPreview: string | null;
  supersededSha: string | null;
}

/** The compact marker that rides along a row in the commit list. */
export function CheckpointBadge({ checkpoint }: { checkpoint: CheckpointView | null }) {
  if (!checkpoint || checkpoint.confidence === "orphan") return null;
  const exact = checkpoint.confidence === "exact";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 font-mono m3-label-sm",
        exact
          ? "bg-secondary-container text-on-secondary-container"
          : "border border-hairline text-ink-faint",
      )}
      title={
        `${exact ? "Attributed" : "Probably"} to this session: ${checkpoint.promptPreview ?? "(no prompt recorded)"}\n\n` +
        `${checkpoint.reason}${checkpoint.score !== null ? `\nscore ${checkpoint.score.toFixed(2)}` : ""}`
      }
    >
      {!exact && "~"}
      {checkpoint.sessionKind === "cli" ? <Terminal size={11} /> : <Bot size={11} />}
    </span>
  );
}

interface Detail {
  id: string;
  commitSha: string;
  subject: string;
  confidence: "exact" | "inferred" | "orphan";
  score: number | null;
  reason: string;
  supersededSha: string | null;
  turn: {
    id: string;
    promptText: string;
    startedAt: string;
    model: string | null;
    outputTokens: number;
    costUsd: number | null;
    toolCallCount: number;
    files: { relPath: string; op: string; source: string; toolName: string | null }[];
  } | null;
  commitFiles: { path: string; status: string }[];
}

/**
 * The strip under a selected commit: what was asked, and what the turn touched
 * next to what the commit actually contains.
 *
 * Those two lists are shown together on purpose. Where they differ is information:
 * a file in the commit that the turn never wrote is one you changed yourself.
 */
export function CheckpointStrip({
  projectId,
  checkpointId,
  pathId,
}: {
  projectId: string;
  checkpointId: string;
  /** The repo the Diff tab is showing, so the terminal opens in the right one. */
  pathId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["checkpoint", projectId, checkpointId],
    queryFn: () => api.get<Detail>(`/api/projects/${projectId}/checkpoints/${checkpointId}`),
  });

  /**
   * Same shape as every other hand-off: the server builds the context and opens a
   * claude terminal, the client lands in it with the prompt typed and unsent.
   */
  const ask = useMutation({
    mutationFn: () =>
      api.post<{ terminalId: string; seed: string }>(
        `/api/projects/${projectId}/checkpoints/${checkpointId}/work-with-claude`,
        { cwdPathId: pathId },
      ),
    onSuccess: ({ terminalId, seed }) => {
      void qc.invalidateQueries({ queryKey: ["terminals", projectId] });
      navigate(
        `/projects/${projectId}?tab=chat&terminal=${terminalId}&seed=${encodeURIComponent(seed)}`,
      );
    },
  });

  if (!data) return null;

  const turnPaths = new Set(data.turn?.files.filter((f) => f.op !== "read").map((f) => f.relPath));
  const unclaimed = data.commitFiles.filter((f) => !turnPaths.has(f.path));

  return (
    <div className="border-b border-hairline bg-white/3 px-3 py-1.5">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 rounded-sm px-1 m3-label-sm",
            data.confidence === "exact"
              ? "bg-secondary-container text-on-secondary-container"
              : "border border-hairline text-ink-faint",
          )}
          title={data.reason}
        >
          {data.confidence}
          {data.score !== null && ` ${data.score.toFixed(2)}`}
        </span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-ink m3-label-md"
          title={data.turn?.promptText ?? data.reason}
        >
          {data.turn?.promptText.split("\n")[0] ?? (
            <span className="text-ink-faint">{data.reason}</span>
          )}
        </button>
        {data.turn && (
          <Button size="sm" variant="ghost" onClick={() => ask.mutate()} disabled={ask.isPending}>
            <MessageSquarePlus size={16} /> {ask.isPending ? "Opening…" : "Ask this checkpoint"}
          </Button>
        )}
      </div>

      {data.supersededSha && (
        <p className="mt-0.5 text-ink-faint m3-label-sm">
          Followed here from <span className="font-mono">{data.supersededSha.slice(0, 10)}</span>{" "}
          after a rewrite.
        </p>
      )}

      {expanded && data.turn && (
        <div className="mt-1 space-y-0.5">
          <p className="whitespace-pre-wrap text-ink-muted m3-label-sm">{data.turn.promptText}</p>
          <p className="text-ink-faint m3-label-sm">
            {new Date(data.turn.startedAt).toLocaleString()}
            {data.turn.model && ` · ${data.turn.model}`} · {data.turn.toolCallCount} tool calls
            {data.turn.costUsd !== null && ` · $${data.turn.costUsd.toFixed(2)}`}
          </p>
          {unclaimed.length > 0 && (
            <p className="text-warn m3-label-sm">
              {unclaimed.length} file(s) in this commit were not written by that turn — most likely
              your own edits: {unclaimed.map((f) => f.path).join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
