import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { ExternalLink, Play, RotateCw, Square, TerminalSquare } from "@/components/ui/icons";
import type { Agent, ChatSession, EnvSet, EnvVar, Project, Terminal } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { projectKey, useUiState } from "@/lib/uiStore";
import { fileUrl } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { ChatTab } from "@/features/chat/ChatTab";
import { TerminalPane } from "@/features/terminals/TerminalPane";

interface Props {
  project: Project;
  envSets: EnvSet[];
  session: ChatSession;
}

/**
 * One agent's working tab inside a project. It's the same persisted session
 * machinery as the project chat — history, resume and tool approvals all carry
 * over — with that agent running as the main thread.
 *
 * Two escape hatches for "big" agents:
 * - viewUrl (app agents): the agent is a runnable app — Start runs its command
 *   in a Station terminal (real PTY, stdin confirms work) and the tab shows the
 *   app's own web UI and that terminal side by side.
 * - viewPath: a static .html under the data dir rendered instead of the chat.
 */
export function AgentWorkspace({ project, envSets, session }: Props) {
  const { data: agents = [] } = useQuery({
    queryKey: ["agents", project.id],
    queryFn: () => api.get<Agent[]>(`/api/agents?projectId=${project.id}`),
  });
  const agent = agents.find((a) => a.name === session.agentName);

  if (agent?.viewUrl) {
    return <AppAgentView project={project} envSets={envSets} agent={agent} />;
  }

  if (agent?.viewPath) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-2">
          <span className="font-mono text-xs text-accent">{agent.name}</span>
          <span className="truncate font-mono m3-label-sm text-ink-faint">{agent.viewPath}</span>
          <a
            href={fileUrl(`/api/agents/${agent.id}/view`)}
            target="_blank"
            rel="noreferrer"
            className="ml-auto"
          >
            <Button size="sm" variant="ghost">
              <ExternalLink size={16} /> Open standalone
            </Button>
          </a>
        </div>
        <iframe
          // Same-origin so the view can call the API with the session's token.
          src={fileUrl(`/api/agents/${agent.id}/view`)}
          title={`${agent.name} workspace`}
          className="min-h-0 flex-1 border-0 bg-base"
        />
      </div>
    );
  }

  return <ChatTab project={project} envSets={envSets} pinnedSessionId={session.id} />;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * An app agent's `viewUrl` may reference the env set it is started with, e.g.
 * `http://127.0.0.1:${PORT:-4747}/`. The port lives in the env set (one per Jira
 * project), so a hardcoded URL only ever matches one of them — the others got a
 * blank iframe pointing at a port nothing listens on.
 *
 * `${VAR}` → the set's value, `${VAR:-default}` → default when the set has no
 * such key. A name with neither is left as-is and reported in `missing`, so the
 * caller can say what's wrong instead of rendering that blank frame.
 */
export function resolveViewUrl(url: string, vars: EnvVar[]): { url: string; missing: string[] } {
  const byKey = new Map(vars.map((v) => [v.key, v.value]));
  const missing: string[] = [];
  const resolved = url.replace(PLACEHOLDER, (whole, name: string, fallback?: string) => {
    const value = byKey.get(name);
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return whole;
  });
  return { url: resolved, missing };
}

/** App agent: embedded app UI on top, the terminal running it below. */
function AppAgentView({
  project,
  envSets,
  agent,
}: {
  project: Project;
  envSets: EnvSet[];
  agent: Agent;
}) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  // Was a hand-rolled localStorage key; now it rides the same store as every
  // other remembered choice, so "reset UI state" and project deletion reach it.
  const [storedEnvSetId, setEnvSetId] = useUiState(
    projectKey(project.id, "agentEnv", agent.name),
    "",
  );
  const envSetId = envSets.some((e) => e.id === storedEnvSetId) ? storedEnvSetId : "";
  const [showTerminal, setShowTerminal] = useState(true);
  const [frameNonce, setFrameNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const terminalsKey = ["terminals", project.id];
  const { data: terminals = [] } = useQuery({
    queryKey: terminalsKey,
    queryFn: () => api.get<Terminal[]>(`/api/projects/${project.id}/terminals`),
  });
  const appTerminal = terminals.find(
    (t) => t.title === `agent:${agent.name}` && t.status === "running",
  );

  const start = useMutation({
    mutationFn: () =>
      api.post<Terminal>(`/api/agents/${agent.id}/start`, {
        projectId: project.id,
        envSetId: envSetId || null,
      }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: terminalsKey });
      // The app needs a moment before its UI answers — reload the frame then.
      setTimeout(() => setFrameNonce((n) => n + 1), 1500);
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const stop = useMutation({
    mutationFn: (terminalId: string) => api.delete(`/api/terminals/${terminalId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: terminalsKey }),
  });

  const canStart = Boolean(agent.startCommand && agent.bundleDir);
  // The URL follows the SELECTED env set: same agent, different project/port.
  const view = resolveViewUrl(agent.viewUrl!, envSets.find((e) => e.id === envSetId)?.vars ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2">
        <span className="font-mono text-xs text-accent">{agent.name}</span>
        <span
          className={cn(
            "rounded-pill px-2 py-0.5 m3-label-sm font-medium",
            appTerminal ? "bg-ok/15 text-ok" : "bg-white/8 text-ink-faint",
          )}
        >
          {appTerminal ? "running" : "stopped"}
        </span>
        {canStart && (
          <Select
            value={envSetId}
            onChange={setEnvSetId}
            disabled={Boolean(appTerminal)}
            title="Env set injected when starting — overrides the bundle's .env"
            options={[
              { value: "", label: "env: bundle .env only" },
              ...envSets.map((s) => ({ value: s.id, label: `env: ${s.name}` })),
            ]}
          />
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {canStart &&
            (appTerminal ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void confirm({
                    title: `Stop ${agent.name}?`,
                    confirmLabel: "Stop",
                    tone: "danger",
                  }).then((ok) => ok && stop.mutate(appTerminal.id));
                }}
              >
                <Square size={16} /> Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
                <Play size={16} /> {start.isPending ? "Starting…" : "Start"}
              </Button>
            ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFrameNonce((n) => n + 1)}
            title="Reload the app UI"
          >
            <RotateCw size={16} />
          </Button>
          <Button
            size="sm"
            variant={showTerminal ? "primary" : "ghost"}
            onClick={() => setShowTerminal((v) => !v)}
            title="Show / hide the app's terminal"
          >
            <TerminalSquare size={16} /> Terminal
          </Button>
          <a
            href={view.url}
            target="_blank"
            rel="noreferrer"
            className={cn(view.missing.length > 0 && "pointer-events-none opacity-40")}
          >
            <Button size="sm" variant="ghost">
              <ExternalLink size={16} /> Open standalone
            </Button>
          </a>
        </div>
      </div>

      {error && <p className="border-b border-hairline px-4 py-1.5 text-xs text-err">{error}</p>}

      {view.missing.length > 0 ? (
        // Say what's missing. Rendering the frame anyway just shows a broken
        // page and reads as "the agent is dead" — which is what happened with
        // ISI888 (agent healthy on :4750, URL pinned to :4747).
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-xs text-err">
            viewUrl cần {view.missing.map((k) => `\${${k}}`).join(", ")} — env set đang chọn không
            có biến này.
          </p>
          <p className="m3-label-sm text-ink-faint">
            Chọn env set có biến đó, hoặc đặt mặc định trong viewUrl: {"${PORT:-4747}"}
          </p>
        </div>
      ) : (
        <iframe
          key={frameNonce}
          src={view.url}
          title={`${agent.name} app UI`}
          className="min-h-0 flex-1 border-0 bg-base"
        />
      )}

      {showTerminal && appTerminal && (
        <div className="h-64 shrink-0 border-t border-hairline">
          <TerminalPane
            terminalId={appTerminal.id}
            onExit={() => void qc.invalidateQueries({ queryKey: terminalsKey })}
          />
        </div>
      )}
      {showTerminal && !appTerminal && (
        <div className="flex h-16 shrink-0 items-center justify-center border-t border-hairline text-xs text-ink-faint">
          {canStart
            ? "App is not running — press Start to launch it in a terminal here."
            : "This agent has no start command — set one in the agent editor to launch it from here."}
        </div>
      )}
    </div>
  );
}
