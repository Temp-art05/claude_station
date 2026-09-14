/**
 * Who last wrote the file you are looking at.
 *
 * `git blame` answers this with a person's name, which for a repo an agent works
 * in is the same name on every line. This answers it with the turn: the prompt
 * that asked for the change, and when.
 *
 * Silent when there is nothing to say — a file the user edited by hand has no turn
 * behind it, and an empty row would just add noise to the header.
 */
import { useQuery } from "@tanstack/react-query";
import { Bot, Terminal } from "@/components/ui/icons";
import { api } from "@/lib/api";

interface TurnRow {
  id: string;
  sourceKind: "sdk" | "cli";
  promptPreview: string;
  startedAt: string;
  endedAt: string | null;
  toolCallCount: number;
}

function shortTime(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function LedgerAttribution({
  projectId,
  repoPath,
  relPath,
}: {
  projectId: string;
  /** The repo the Diff tab is showing, so the relative path can be absolutised. */
  repoPath: string | undefined;
  relPath: string;
}) {
  const absPath = repoPath ? `${repoPath.replace(/\/$/, "")}/${relPath}` : "";
  const { data } = useQuery({
    queryKey: ["ledger-file", projectId, absPath],
    enabled: absPath.length > 0,
    queryFn: () =>
      api.get<TurnRow[]>(
        `/api/projects/${projectId}/ledger/file?path=${encodeURIComponent(absPath)}&limit=3`,
      ),
    // The record for a file only changes when a turn writes it, and the Diff tab
    // already refetches on its own when the tree moves.
    staleTime: 30_000,
    retry: false,
  });

  const last = data?.[0];
  if (!last) return null;

  const others = (data?.length ?? 0) - 1;
  const when = shortTime(last.endedAt ?? last.startedAt);

  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-ink-faint m3-label-sm"
      title={`${last.promptPreview}\n\n${new Date(last.endedAt ?? last.startedAt).toLocaleString()}${
        others > 0 ? `\n\n+${others} earlier turn(s) also wrote this file` : ""
      }`}
    >
      {last.sourceKind === "cli" ? <Terminal size={12} /> : <Bot size={12} />}
      <span className="truncate">{last.promptPreview || "(no prompt recorded)"}</span>
      <span className="shrink-0">· {when}</span>
      {others > 0 && <span className="shrink-0">· +{others}</span>}
    </span>
  );
}
