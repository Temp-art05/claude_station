import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Play, RotateCw, Square, TerminalSquare } from "lucide-react";
import type { Agent, ChatSession, EnvSet, Project, Terminal } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
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
          <span className="truncate font-mono text-[10.5px] text-ink-faint">{agent.viewPath}</span>
          <a
            href={fileUrl(`/api/agents/${agent.id}/view`)}
            target="_blank"
            rel="noreferrer"
            className="ml-auto"
          >
            <Button size="sm" variant="ghost">
              <ExternalLink size={12} /> Open standalone
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
  const qc = useQueryClient();
  const envKey = `agentEnv:${project.id}:${agent.name}`;
  const [envSetId, setEnvSetId] = useState<string>(() => localStorage.getItem(envKey) ?? "");
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2">
        <span className="font-mono text-xs text-accent">{agent.name}</span>
        <span
          className={cn(
            "rounded-pill px-2 py-0.5 text-[10px] font-medium",
            appTerminal ? "bg-ok/15 text-ok" : "bg-white/8 text-ink-faint",
          )}
        >
          {appTerminal ? "running" : "stopped"}
        </span>
        {canStart && (
          <select
            value={envSetId}
            onChange={(e) => {
              setEnvSetId(e.target.value);
              localStorage.setItem(envKey, e.target.value);
            }}
            disabled={Boolean(appTerminal)}
            className="h-7 px-2 text-[11px]"
            title="Env set injected when starting — overrides the bundle's .env"
          >
            <option value="">env: bundle .env only</option>
            {envSets.map((s) => (
              <option key={s.id} value={s.id}>
                env: {s.name}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {canStart &&
            (appTerminal ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (confirm(`Stop ${agent.name}?`)) stop.mutate(appTerminal.id);
                }}
              >
                <Square size={12} /> Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
                <Play size={12} /> {start.isPending ? "Starting…" : "Start"}
              </Button>
            ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFrameNonce((n) => n + 1)}
            title="Reload the app UI"
          >
            <RotateCw size={12} />
          </Button>
          <Button
            size="sm"
            variant={showTerminal ? "primary" : "ghost"}
            onClick={() => setShowTerminal((v) => !v)}
            title="Show / hide the app's terminal"
          >
            <TerminalSquare size={12} /> Terminal
          </Button>
          <a href={agent.viewUrl!} target="_blank" rel="noreferrer">
            <Button size="sm" variant="ghost">
              <ExternalLink size={12} /> Open standalone
            </Button>
          </a>
        </div>
      </div>

      {error && <p className="border-b border-hairline px-4 py-1.5 text-xs text-err">{error}</p>}

      <iframe
        key={frameNonce}
        src={agent.viewUrl!}
        title={`${agent.name} app UI`}
        className="min-h-0 flex-1 border-0 bg-base"
      />

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
