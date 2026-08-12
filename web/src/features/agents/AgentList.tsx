import { useState } from "react";
import { Ban, Bot, Download, Pencil, Trash2, Wrench } from "lucide-react";
import type { Agent } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { fileUrl } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { AgentEditor } from "./AgentEditor";
import { useDeleteAgent, useToggleProjectAgent } from "./hooks";

interface Props {
  agents: Agent[];
  /** When set, each row gets an on/off switch for that project. */
  projectId?: string;
  editable?: boolean;
}

export function AgentList({ agents, projectId, editable = true }: Props) {
  const [editing, setEditing] = useState<Agent | null>(null);
  const del = useDeleteAgent();
  const toggle = useToggleProjectAgent(projectId ?? "");

  if (agents.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 py-10 text-center">
        <Bot size={26} className="text-ink-faint" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-sm text-xs text-ink-muted">
          An agent is a scoped helper the main session can hand work to — a build fixer that can run
          gradle but not edit Jira, a reviewer that can read but never write.
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {agents.map((agent) => {
          const on = agent.enabledGlobally || agent.enabledForProject;
          return (
            <Card key={agent.id} className="p-3">
              <div className="flex items-start gap-3">
                {projectId && (
                  <button
                    role="switch"
                    aria-checked={on}
                    aria-label={`Toggle ${agent.name}`}
                    disabled={agent.enabledGlobally || toggle.isPending}
                    onClick={() => toggle.mutate({ agentId: agent.id, enabled: !on })}
                    className={cn(
                      "mt-0.5 h-4 w-7 shrink-0 rounded-full border transition-colors",
                      on ? "border-accent/60 bg-accent/30" : "border-edge bg-surface-3",
                      agent.enabledGlobally ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                    )}
                    title={
                      agent.enabledGlobally
                        ? "Enabled globally — change that on the Agents page"
                        : on
                          ? "Enabled for this project"
                          : "Disabled for this project"
                    }
                  >
                    <span
                      className={cn(
                        "block h-3 w-3 rounded-full bg-ink transition-transform",
                        on ? "translate-x-3.5" : "translate-x-0.5",
                      )}
                    />
                  </button>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[15px] font-bold text-ok">{agent.name}</span>
                    {agent.enabledGlobally && <Badge tone="accent">global</Badge>}
                    {agent.model && <Badge>{agent.model}</Badge>}
                    {agent.maxTurns && <Badge>{agent.maxTurns} turns</Badge>}
                    {agent.background && <Badge>background</Badge>}
                    {agent.source === "imported" && <Badge>imported</Badge>}
                  </div>
                  <p className="mt-1 text-[13px] text-white">{agent.description}</p>

                  {(agent.tools?.length || agent.disallowedTools?.length) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {agent.tools?.map((tool) => (
                        <span
                          key={tool}
                          className="inline-flex items-center gap-0.5 rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent"
                        >
                          <Wrench size={9} />
                          {tool.replace("mcp__station__", "")}
                        </span>
                      ))}
                      {agent.disallowedTools?.map((tool) => (
                        <span
                          key={tool}
                          className="inline-flex items-center gap-0.5 rounded bg-err/10 px-1.5 py-0.5 font-mono text-[10px] text-err"
                        >
                          <Ban size={9} />
                          {tool.replace("mcp__station__", "")}
                        </span>
                      ))}
                    </div>
                  )}
                  {!agent.tools?.length && !agent.disallowedTools?.length && (
                    <p className="mt-1.5 text-[12px] text-ink-muted">
                      Inherits every tool from the session.
                    </p>
                  )}
                </div>

                {editable && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <a
                      href={fileUrl(`/api/agents/${agent.id}/export`)}
                      download
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
                      title={
                        agent.bundleDir ? "Export bundle as .zip" : "Export as .agent.md"
                      }
                    >
                      <Download size={14} />
                    </a>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setEditing(agent)}
                      aria-label="Edit agent"
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        if (confirm(`Delete agent "${agent.name}"?`)) del.mutate(agent.id);
                      }}
                      aria-label="Delete agent"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {editing && (
        <AgentEditor
          key={editing.id}
          open
          agent={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
