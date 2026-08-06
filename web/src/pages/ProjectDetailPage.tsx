import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, Pencil } from "lucide-react";
import type { ChatSession, EnvSet } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useProject } from "@/features/projects/hooks";
import { ProjectFormDialog } from "@/features/projects/ProjectFormDialog";
import { TerminalsTab } from "@/features/terminals/TerminalsTab";
import { CommandsTab } from "@/features/commands/CommandsTab";
import { DiffTab } from "@/features/git/DiffTab";
import { HistoryTab } from "@/features/history/HistoryTab";
import { KnowledgePanel } from "@/features/knowledge/KnowledgePanel";
import { AttachFromLibrary } from "@/features/knowledge/AttachFromLibrary";
import { AgentsTab } from "@/features/agents/AgentsTab";
import { AgentWorkspace } from "@/features/agents/AgentWorkspace";
import { MemoryTab } from "@/features/memory/MemoryTab";
import { WorkflowsTab } from "@/features/workflows/WorkflowsTab";

// "chat" keeps its value so old ?tab=chat deep links still land on the Claude tab.
const TABS = [
  { value: "chat", label: "Claude" },
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
  // GitHub web URL per repo path (from each repo's git remote) — shortcut links.
  const { data: githubLinks = [] } = useQuery({
    queryKey: ["project-github", id],
    queryFn: () =>
      api.get<{ pathId: string; label: string; url: string | null }[]>(
        `/api/projects/${id}/github`,
      ),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });
  const [params] = useSearchParams();
  const [picked, setTab] = useState<Tab | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const qc = useQueryClient();

  // "Work with Claude" deep-links via ?tab=chat; an explicit click wins after that.
  // Every open agent workspace is an extra tab; the route carries which one.
  const workspaces = sessions.filter((s) => s.kind === "agent" && !s.archived);
  const workspaceTabs = workspaces.map((s) => ({
    value: `agent:${s.id}`,
    label: s.agentName ?? s.title,
    closable: true,
  }));
  const allTabs = [...TABS, ...workspaceTabs];

  // Closing a workspace tab archives its session — history stays, tab goes.
  const closeWorkspace = useMutation({
    mutationFn: (sessionId: string) =>
      api.patch(`/api/sessions/${sessionId}`, { archived: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sessions", id] }),
  });

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
              // The description is context for Claude, not for the human every
              // visit — one clamped line, click to unfold when actually needed.
              <p
                onClick={() => setDescOpen((v) => !v)}
                title={descOpen ? "Click to collapse" : "Click to expand"}
                className={
                  descOpen
                    ? "mt-0.5 cursor-pointer text-sm text-ink-muted"
                    : "mt-0.5 line-clamp-1 max-w-3xl cursor-pointer text-xs text-ink-faint"
                }
              >
                {project.description}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {project.paths.map((p) => {
                const gh = githubLinks.find((g) => g.pathId === p.id)?.url;
                return (
                  <span key={p.id} className="flex items-center gap-1">
                    <Badge tone={p.isDefault ? "accent" : "default"} title={p.path}>
                      {p.label}
                    </Badge>
                    {gh && (
                      <a
                        href={gh}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${p.label} on GitHub`}
                        className="text-ink-faint hover:text-ink"
                      >
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
            <Pencil size={13} /> Edit
          </Button>
        </div>
        <Tabs
          tabs={allTabs}
          value={tab}
          onChange={setTab}
          onClose={(value) => {
            const sessionId = value.slice("agent:".length);
            closeWorkspace.mutate(sessionId);
            if (tab === value) setTab("agents");
          }}
          className="border-b-0"
        />
      </div>

      <div className="min-h-0 flex-1">
        {tab === "chat" && <TerminalsTab kind="claude" project={project} envSets={envSets} />}
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
