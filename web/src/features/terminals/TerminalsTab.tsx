import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { Select } from "@/components/ui/select";
import { Plus, RotateCw, X } from "@/components/ui/icons";
import type { EnvSet, Project, TerminalKind } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { usePanelActive } from "@/components/KeepAlive";
import { projectKey, useUiState } from "@/lib/uiStore";
import { cn } from "@/lib/utils";
import { TerminalPane } from "./TerminalPane";
import { useCreateTerminal, useKillTerminal, useRestartTerminal, useTerminals } from "./hooks";

interface Props {
  project: Project;
  envSets: EnvSet[];
  /** "shell" = the Terminals tab; "claude" = the Claude tab (PTYs running the claude CLI). */
  kind?: TerminalKind;
}

export function TerminalsTab({ project, envSets, kind = "shell" }: Props) {
  const { data: terminals = [], isLoading } = useTerminals(project.id, kind);
  const create = useCreateTerminal(project.id);
  const kill = useKillTerminal(project.id);
  const restart = useRestartTerminal(project.id);

  const onScreen = usePanelActive();
  // "Work with Claude" deep-links land here as ?terminal=<id>&seed=<text>.
  //
  // Read from the URL on every render rather than once at mount: this panel is
  // kept alive behind other pages, so a link from GitHub or Jira arrives at a
  // component that never remounts, and a mount-time read would honour only the
  // first link of the session. Only the Claude panel owns these params, and
  // never while hidden — it would be answering for the page on screen.
  const [params, setParams] = useSearchParams();
  const deepLinked = kind === "claude" && onScreen;
  const seedTarget = deepLinked ? params.get("terminal") : null;
  const seed = deepLinked ? params.get("seed") : null;

  // Keyed by kind: the Claude tab and the Terminals tab each keep their own.
  const ui = (...parts: string[]) => projectKey(project.id, "terminals", kind, ...parts);
  const [selectedId, setSelectedId] = useUiState<string | null>(ui("selectedId"), null);
  const [storedPathId, setPathId] = useUiState(ui("pathId"), project.paths[0]?.id ?? "");
  const [storedEnvSetId, setEnvSetId] = useUiState(ui("envSetId"), "");
  // A repo or env set can disappear between visits; "" is a valid env choice.
  const pathId = project.paths.some((p) => p.id === storedPathId)
    ? storedPathId
    : (project.paths[0]?.id ?? "");
  const envSetId = envSets.some((e) => e.id === storedEnvSetId) ? storedEnvSetId : "";

  // A deep link outranks whatever was selected last time — but it only fires on
  // the arriving link, so a later click on another terminal still wins.
  useEffect(() => {
    if (seedTarget) setSelectedId(seedTarget);
  }, [seedTarget, setSelectedId]);

  // One-shot: the params go once the prompt is actually in the CLI, so a reload
  // or a tab switch never types it a second time — and an arrival that never
  // reaches a running terminal keeps its seed instead of dropping it silently.
  // Functional form: ?tab= may be written in the same tick, and a snapshot-based
  // write here would silently roll it back.
  const clearSeed = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("terminal");
        next.delete("seed");
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

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
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {live.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={cn(
                "state-layer m3-label-md group flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-pill px-3 font-semibold",
                "transition-[background-color,color] duration-200 ease-emphasized",
                activeId === t.id
                  ? "bg-inverse-surface text-on-inverse-surface"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  t.status === "running" ? "bg-ok" : "bg-ink-faint",
                )}
              />
              {t.title}
              <X
                size={16}
                className="-mr-1 opacity-0 transition-opacity duration-150 group-hover:opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  kill.mutate(t.id);
                }}
              />
            </button>
          ))}
          {isLoading && <span className="m3-body-sm text-ink-muted">Loading…</span>}
        </div>

        <Select
          value={pathId}
          onChange={setPathId}
          aria-label="Repo"
          options={project.paths.map((p) => ({ value: p.id, label: p.label }))}
        />
        <Select
          value={envSetId}
          onChange={setEnvSetId}
          aria-label="Env set"
          options={[
            { value: "", label: "No env set" },
            ...envSets.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
        <Button
          size="sm"
          onClick={() =>
            create.mutate(
              { cwdPathId: pathId || undefined, envSetId: envSetId || null, kind },
              { onSuccess: (t) => setActiveId(t.id) },
            )
          }
          disabled={create.isPending || project.paths.length === 0}
        >
          <Plus size={16} /> {kind === "claude" ? "Claude" : "Terminal"}
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {!active && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            {kind === "claude" ? (
              <>
                <p className="m3-title-md">No Claude session open.</p>
                <p className="m3-body-sm text-ink-faint">
                  Pick a repo and hit <span className="text-ink-muted">+ Claude</span> — the{" "}
                  <code className="font-mono text-ink-muted">claude</code> CLI runs right here.
                </p>
              </>
            ) : (
              <>
                <p className="m3-title-md">No terminal open.</p>
                <p className="m3-body-sm text-ink-faint">
                  Open one and run <code className="font-mono text-ink-muted">claude</code> inside
                  it.
                </p>
              </>
            )}
          </div>
        )}
        {active?.status === "orphaned" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Badge tone="err">orphaned</Badge>
            <p className="m3-body-sm max-w-sm text-ink-muted">
              {kind === "claude"
                ? "This Claude session belonged to a previous server process. Restart resumes the last conversation in this directory via claude --continue."
                : "This shell belonged to a previous server process, so its output is gone. Restart it to get a fresh shell in the same directory."}
            </p>
            <Button
              size="sm"
              onClick={() => restart.mutate(active.id)}
              disabled={restart.isPending}
            >
              <RotateCw size={16} /> {kind === "claude" ? "Restart Claude" : "Restart shell"}
            </Button>
          </div>
        )}
        {active?.status === "running" && (
          <TerminalPane
            key={active.id}
            terminalId={active.id}
            seedText={seed && active.id === seedTarget ? seed : undefined}
            onSeedSent={clearSeed}
          />
        )}
      </div>

      {active && (
        <div className="m3-label-sm border-t border-hairline px-4 py-2.5 font-mono text-ink-faint">
          {active.cwd}
          {active.envSetId && <span className="ml-2 text-accent">env applied</span>}
        </div>
      )}
    </div>
  );
}
