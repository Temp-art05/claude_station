import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Pencil } from "lucide-react";
import type { ChatSession, EnvSet } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useProject } from "@/features/projects/hooks";
import { ProjectFormDialog } from "@/features/projects/ProjectFormDialog";
import { TerminalsTab } from "@/features/terminals/TerminalsTab";
import { CommandsTab } from "@/features/commands/CommandsTab";
import { ChatTab } from "@/features/chat/ChatTab";
import { DiffTab } from "@/features/git/DiffTab";
import { HistoryTab } from "@/features/history/HistoryTab";
import { KnowledgePanel } from "@/features/knowledge/KnowledgePanel";
import { AttachFromLibrary } from "@/features/knowledge/AttachFromLibrary";
import { AgentsTab } from "@/features/agents/AgentsTab";
import { AgentWorkspace } from "@/features/agents/AgentWorkspace";
import { MemoryTab } from "@/features/memory/MemoryTab";
import { WorkflowsTab } from "@/features/workflows/WorkflowsTab";

const TABS = [
  { value: "chat", label: "Chat" },
  { value: "terminals", label: "Terminals" },
  { value: "commands", label: "Commands" },
  { value: "diff", label: "Diff" },
  { value: "knowledge", label: "Knowledge" },
  { value: "workflows", label: "Workflows" },
  { value: "memory", label: "Memory" },
  { value: "agents", label: "Agents" },
  { value: "history", label: "History" },
] as const;

type Tab = string;

export function ProjectDetailPage() {
  const { id = "" } = useParams();
  const { data: project, isLoading } = useProject(id);
  const { data: envSets = [] } = useQuery({
    queryKey: ["env-sets", id],
    queryFn: () => api.get<EnvSet[]>(`/api/env-sets?projectId=${id}`),
    enabled: !!id,
  });
  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", id],
    queryFn: () => api.get<ChatSession[]>(`/api/projects/${id}/sessions`),
    enabled: !!id,
  });
  const [params] = useSearchParams();
  const [picked, setTab] = useState<Tab | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  // "Work with Claude" deep-links via ?tab=chat; an explicit click wins after that.
  // Every open agent workspace is an extra tab; the route carries which one.
  const workspaces = sessions.filter((s) => s.kind === "agent" && !s.archived);
  const workspaceTabs = workspaces.map((s) => ({
    value: `agent:${s.id}`,
    label: s.agentName ?? s.title,
  }));
  const allTabs = [...TABS, ...workspaceTabs];

  const requested = params.get("tab");
  const fromUrl = allTabs.find((t) => t.value === requested)?.value;
  const tab = picked ?? fromUrl ?? "chat";
  const activeWorkspace = tab.startsWith("agent:")
    ? workspaces.find((s) => `agent:${s.id}` === tab)
    : undefined;

  if (isLoading) return <p className="p-6 text-sm text-ink-muted">Loading…</p>;
  if (!project) return <p className="p-6 text-sm text-err">Project not found.</p>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-edge px-6 pt-4">
        <div className="mb-2 flex items-center gap-1.5 text-xs text-ink-muted">
          <Link to="/projects" className="hover:text-ink">
            Projects
          </Link>
          <ChevronRight size={12} />
          <span className="text-ink">{project.name}</span>
        </div>
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{project.name}</h1>
            {project.description && (
              <p className="mt-0.5 text-sm text-ink-muted">{project.description}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {project.paths.map((p) => (
                <Badge key={p.id} tone={p.isDefault ? "accent" : "default"} title={p.path}>
                  {p.label}
                </Badge>
              ))}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
            <Pencil size={13} /> Edit
          </Button>
        </div>
        <Tabs tabs={allTabs} value={tab} onChange={setTab} className="border-b-0" />
      </div>

      <div className="min-h-0 flex-1">
        {tab === "chat" && <ChatTab project={project} envSets={envSets} />}
        {tab === "terminals" && <TerminalsTab project={project} envSets={envSets} />}
        {tab === "commands" && <CommandsTab project={project} envSets={envSets} />}
        {tab === "diff" && <DiffTab project={project} />}
        {tab === "knowledge" && (
          <div className="h-full overflow-y-auto px-6 py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm text-ink-muted">
                Uploads live in this project. Assets attached from the library stay shared.
              </p>
              <AttachFromLibrary projectId={project.id} />
            </div>
            <KnowledgePanel projectId={project.id} />
          </div>
        )}
        {tab === "workflows" && <WorkflowsTab project={project} envSets={envSets} />}
        {tab === "memory" && <MemoryTab projectId={project.id} />}
        {tab === "agents" && <AgentsTab projectId={project.id} />}
        {activeWorkspace && (
          <AgentWorkspace
            key={activeWorkspace.id}
            project={project}
            envSets={envSets}
            session={activeWorkspace}
          />
        )}
        {tab === "history" && <HistoryTab projectId={project.id} />}
      </div>

      <ProjectFormDialog key={`${project.id}-${editOpen}`} open={editOpen} onClose={() => setEditOpen(false)} project={project} />
    </div>
  );
}
