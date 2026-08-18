import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Play } from "@/components/ui/icons";
import type { ChatSession } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { AgentList } from "./AgentList";
import { useAgents } from "./hooks";

/** Per-project view: same list, with a switch per agent for this project. */
export function AgentsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: agents = [], isLoading } = useAgents(projectId);
  const active = agents.filter((a) => a.enabledGlobally || a.enabledForProject);

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.get<ChatSession[]>(`/api/projects/${projectId}/sessions`),
  });
  const workspaces = sessions.filter((s) => s.kind === "agent" && !s.archived);

  /** Starting an agent opens a persistent working tab in this project. */
  const start = useMutation({
    mutationFn: (agentName: string) =>
      api.post<ChatSession>(`/api/projects/${projectId}/sessions`, { agentName }),
    onSuccess: (session) => {
      void qc.invalidateQueries({ queryKey: ["sessions", projectId] });
      navigate(`/projects/${projectId}?tab=agent:${session.id}`);
    },
  });

  /** One tab per agent: an already-open workspace is focused, not duplicated. */
  const openWorkspace = (agentName: string) => {
    const existing = workspaces.find((w) => w.agentName === agentName);
    if (existing) navigate(`/projects/${projectId}?tab=agent:${existing.id}`);
    else start.mutate(agentName);
  };

  if (isLoading) return <p className="p-6 text-sm text-ink-muted">Loading…</p>;

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-ink-muted">
          {active.length === 0
            ? "No agents active — Claude handles everything in the main session."
            : `${active.length} agent${active.length === 1 ? "" : "s"} available to sessions in this project.`}
        </p>
        <Link to="/agents" className="text-xs text-accent hover:underline">
          Manage agents →
        </Link>
      </div>

      {workspaces.length > 0 && (
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-bold tracking-wide text-ink-faint uppercase">
            Open workspaces
          </p>
          <div className="flex flex-wrap gap-1.5">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => navigate(`/projects/${projectId}?tab=agent:${w.id}`)}
                className="liquid liquid-interactive m3-label-md inline-flex cursor-pointer items-center gap-2 rounded-pill px-3.5 py-2 font-semibold"
              >
                <span
                  className={
                    w.status === "running"
                      ? "h-1.5 w-1.5 rounded-full bg-warn animate-status"
                      : "h-1.5 w-1.5 rounded-full bg-ink-faint"
                  }
                />
                {w.agentName ?? w.title}
                {w.worktreePath && <Badge>worktree</Badge>}
              </button>
            ))}
          </div>
        </div>
      )}

      {active.length > 0 && (
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-bold tracking-wide text-ink-faint uppercase">
            Start a workspace
          </p>
          <div className="flex flex-wrap gap-1.5">
            {active.map((a) => (
              <Button
                key={a.id}
                size="sm"
                onClick={() => openWorkspace(a.name)}
                disabled={start.isPending}
                title={a.description}
              >
                <Play size={16} /> {a.name}
              </Button>
            ))}
          </div>
          {start.isError && (
            <p className="mt-1.5 text-xs text-err">
              {start.error instanceof Error ? start.error.message : "Could not start"}
            </p>
          )}
        </div>
      )}

      {agents.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <Bot size={26} className="text-ink-faint" />
          <p className="text-sm font-medium">Nothing defined yet</p>
          <p className="max-w-sm text-xs text-ink-muted">
            Create an agent on the{" "}
            <Link to="/agents" className="text-accent hover:underline">
              Agents page
            </Link>{" "}
            — there are presets for build fixing, code review, Jira write-ups and spreadsheets.
          </p>
        </Card>
      ) : (
        <AgentList agents={agents} projectId={projectId} editable={false} />
      )}
    </div>
  );
}
