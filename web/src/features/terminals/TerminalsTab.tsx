import { useEffect, useState } from "react";
import { Plus, RotateCw, X } from "lucide-react";
import type { EnvSet, Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { TerminalPane } from "./TerminalPane";
import {
  useCreateTerminal,
  useKillTerminal,
  useRestartTerminal,
  useTerminals,
} from "./hooks";

interface Props {
  project: Project;
  envSets: EnvSet[];
}

export function TerminalsTab({ project, envSets }: Props) {
  const { data: terminals = [], isLoading } = useTerminals(project.id);
  const create = useCreateTerminal(project.id);
  const kill = useKillTerminal(project.id);
  const restart = useRestartTerminal(project.id);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pathId, setPathId] = useState(project.paths[0]?.id ?? "");
  const [envSetId, setEnvSetId] = useState<string>("");

  const live = terminals.filter((t) => t.status !== "exited");
  // Derived, not synced: the selection falls back to the first live tab.
  const activeId =
    selectedId && live.some((t) => t.id === selectedId) ? selectedId : (live[0]?.id ?? null);
  const setActiveId = setSelectedId;

  // A running shell shouldn't die to a stray Cmd+W.
  useEffect(() => {
    const anyRunning = live.some((t) => t.status === "running");
    if (!anyRunning) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);

  const active = live.find((t) => t.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {live.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={cn(
                "group flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors cursor-pointer",
                activeId === t.id
                  ? "bg-surface-3 text-ink"
                  : "text-ink-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  t.status === "running" ? "bg-ok" : "bg-ink-faint",
                )}
              />
              {t.title}
              <X
                size={12}
                className="opacity-0 transition-opacity group-hover:opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  kill.mutate(t.id);
                }}
              />
            </button>
          ))}
          {isLoading && <span className="text-xs text-ink-muted">Loading…</span>}
        </div>

        <select
          value={pathId}
          onChange={(e) => setPathId(e.target.value)}
          className="h-7 rounded-md border border-edge bg-surface px-2 text-xs text-ink"
        >
          {project.paths.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          value={envSetId}
          onChange={(e) => setEnvSetId(e.target.value)}
          className="h-7 rounded-md border border-edge bg-surface px-2 text-xs text-ink"
        >
          <option value="">No env set</option>
          {envSets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={() =>
            create.mutate(
              { cwdPathId: pathId || undefined, envSetId: envSetId || null },
              { onSuccess: (t) => setActiveId(t.id) },
            )
          }
          disabled={create.isPending || project.paths.length === 0}
        >
          <Plus size={14} /> Terminal
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {!active && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-ink-muted">No terminal open.</p>
            <p className="text-xs text-ink-faint">
              Open one and run <code className="font-mono text-ink-muted">claude</code> inside it.
            </p>
          </div>
        )}
        {active?.status === "orphaned" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Badge tone="err">orphaned</Badge>
            <p className="max-w-sm text-xs text-ink-muted">
              This shell belonged to a previous server process, so its output is gone. Restart it to
              get a fresh shell in the same directory.
            </p>
            <Button size="sm" onClick={() => restart.mutate(active.id)} disabled={restart.isPending}>
              <RotateCw size={14} /> Restart shell
            </Button>
          </div>
        )}
        {active?.status === "running" && (
          <TerminalPane key={active.id} terminalId={active.id} />
        )}
      </div>

      {active && (
        <div className="border-t border-edge px-4 py-1.5 font-mono text-[11px] text-ink-faint">
          {active.cwd}
          {active.envSetId && <span className="ml-2 text-accent">env applied</span>}
        </div>
      )}
    </div>
  );
}
