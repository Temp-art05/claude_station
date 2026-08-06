import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDiff, RotateCcw } from "lucide-react";
import type { Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface StatusResponse {
  cwd: string;
  isRepo: boolean;
  files: { path: string; status: string; staged: boolean }[];
}

/** Minimal unified-diff colouring — enough to review what Claude changed. */
function DiffView({ patch }: { patch: string }) {
  if (!patch.trim()) {
    return <p className="p-4 text-xs text-ink-faint">No changes against HEAD.</p>;
  }
  return (
    <pre className="scroll-x h-full overflow-auto bg-base px-3 py-2 font-mono text-[11.5px] leading-relaxed">
      {patch.split("\n").map((line, i) => (
        <div
          key={i}
          className={cn(
            line.startsWith("+") && !line.startsWith("+++") && "text-ok",
            line.startsWith("-") && !line.startsWith("---") && "text-err",
            line.startsWith("@@") && "text-accent",
            (line.startsWith("diff ") || line.startsWith("index ")) && "text-ink-faint",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

export function DiffTab({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [pathId, setPathId] = useState(project.paths[0]?.id ?? "");
  const [file, setFile] = useState<string | null>(null);

  const statusKey = ["git-status", project.id, pathId];
  const { data: status } = useQuery({
    queryKey: statusKey,
    queryFn: () =>
      api.get<StatusResponse>(`/api/projects/${project.id}/git/status?pathId=${pathId}`),
    enabled: !!pathId,
    refetchInterval: 5000,
  });

  const { data: diff } = useQuery({
    queryKey: ["git-diff", project.id, pathId, file],
    queryFn: () =>
      api.get<{ patch: string }>(
        `/api/projects/${project.id}/git/diff?pathId=${pathId}${
          file ? `&file=${encodeURIComponent(file)}` : ""
        }`,
      ),
    enabled: !!pathId,
  });

  const revert = useMutation({
    mutationFn: (files: string[]) =>
      api.post(`/api/projects/${project.id}/git/revert`, { files, pathId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: statusKey });
      void qc.invalidateQueries({ queryKey: ["git-diff", project.id, pathId] });
    },
  });

  return (
    <div className="flex h-full min-h-0">
      <div className="w-72 shrink-0 overflow-y-auto border-r border-edge p-3">
        <select
          value={pathId}
          onChange={(e) => {
            setPathId(e.target.value);
            setFile(null);
          }}
          className="mb-3 h-7 w-full rounded-md border border-edge bg-surface px-2 text-xs text-ink"
        >
          {project.paths.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        {status && !status.isRepo && <p className="text-xs text-ink-faint">Not a git repo.</p>}

        {status?.isRepo && status.files.length === 0 && (
          <p className="text-xs text-ink-faint">Working tree clean.</p>
        )}

        <button
          onClick={() => setFile(null)}
          className={cn(
            "mb-1 w-full cursor-pointer rounded-md px-2 py-1 text-left text-xs",
            file === null ? "bg-surface-3" : "hover:bg-surface-2",
          )}
        >
          All changes
        </button>

        {status?.files.map((f) => (
          <div
            key={f.path}
            className={cn(
              "group flex items-center gap-1.5 rounded-md px-2 py-1",
              file === f.path ? "bg-surface-3" : "hover:bg-surface-2",
            )}
          >
            <button
              onClick={() => setFile(f.path)}
              className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[11px]"
              title={f.path}
            >
              {f.path}
            </button>
            <Badge className="shrink-0">{f.status}</Badge>
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
              title="Discard changes to this file"
              onClick={() => {
                if (confirm(`Discard local changes to ${f.path}? This cannot be undone.`)) {
                  revert.mutate([f.path]);
                }
              }}
            >
              <RotateCcw size={11} />
            </Button>
          </div>
        ))}
      </div>

      <div className="min-w-0 flex-1">
        {diff ? (
          <DiffView patch={diff.patch} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <FileDiff size={26} className="text-ink-faint" />
            <p className="text-sm text-ink-muted">Pick a path to see its diff.</p>
          </div>
        )}
      </div>
    </div>
  );
}
