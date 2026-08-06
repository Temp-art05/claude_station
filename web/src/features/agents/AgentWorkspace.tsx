import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { Agent, ChatSession, EnvSet, Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fileUrl } from "@/lib/upload";
import { ChatTab } from "@/features/chat/ChatTab";

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
 * If the agent declares a custom view, we render that instead: the escape hatch
 * for a "big" agent that deserves its own UI rather than a chat transcript.
 */
export function AgentWorkspace({ project, envSets, session }: Props) {
  const { data: agents = [] } = useQuery({
    queryKey: ["agents", project.id],
    queryFn: () => api.get<Agent[]>(`/api/agents?projectId=${project.id}`),
  });
  const agent = agents.find((a) => a.name === session.agentName);

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
