import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, Pencil, Trash2 } from "lucide-react";
import type { ChatSession, EnvSet } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { KeepAlive, useRetainedKeys, usePanelActive } from "@/components/KeepAlive";
import { api } from "@/lib/api";
import { projectKey } from "@/lib/uiStore";
import { useStickyUrlState } from "@/lib/useUrlState";
import { useProject } from "@/features/projects/hooks";
import { DeleteProjectDialog } from "@/features/projects/DeleteProjectDialog";
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

/**
 * Panels kept mounted behind other tabs. Each holds something a remount would
 * throw away — a live PTY, an unsent commit, a running command's log. The rest
 * (knowledge, memory, agents, history) rebuild instantly from the query cache.
 */
const RETAINED_TABS = new Set(["chat", "terminals", "commands", "diff", "workflows"]);

/**
 * No cap: every panel visited stays alive for the life of the page.
 *
 * The cost is real and unbounded — each retained terminal or agent workspace
 * holds a WebSocket and an xterm instance, and nothing reclaims them. This is
 * a deliberate choice for a local single-user tool where never losing a view
 * matters more than idle memory. Lower it here if that ever stops being true.
 */
const RETAIN_LIMIT = Infinity;

/**
 * Rendered by `AppShell` rather than the router's outlet, so it stays mounted
 * while you visit GitHub or Jira. That is why the id arrives as a prop: a
 * hidden instance would read `useParams()` from whatever route is *currently*
 * matched and quietly show another project's data.
 */
export function ProjectDetailPage({ projectId: id }: { projectId: string }) {
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
  // Per project: each one remembers the tab you left it on. Re-entering from
  // the project list carries no `?tab=`, so the URL alone can't answer this.
  // `enabled` follows visibility — while this page is kept alive behind GitHub
  // or Jira it must leave their `?tab=` alone and read only from the store.
  const onScreen = usePanelActive();
  const [requested, setTab] = useStickyUrlState("tab", projectKey(id, "tab"), "chat", {
    enabled: onScreen,
  });
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

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

  // The URL alone decides the tab, so a reload, a Back press and a pasted link
  // all agree. An `agent:<id>` tab only resolves once sessions arrive — until
  // then this falls back to chat and self-corrects, rather than sticking.
  const tab: Tab = allTabs.find((t) => t.value === requested)?.value ?? "chat";
  // Only panels expensive to rebuild — live terminals, an in-progress diff —
  // earn retention; the cheap ones are left to remount from the query cache.
  const worthRetaining = RETAINED_TABS.has(tab) || tab.startsWith("agent:");
  const retained = useRetainedKeys(worthRetaining ? tab : null, RETAIN_LIMIT);

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
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
              <Pencil size={13} /> Edit
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Delete project"
              title="Delete project"
              className="hover:text-err"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 size={14} />
            </Button>
          </div>
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
        {/* Heavy panels stay mounted while another tab is on screen — see KeepAlive. */}
        <KeepAlive active={tab === "chat"} retained={retained.has("chat")}>
          <TerminalsTab kind="claude" project={project} envSets={envSets} />
        </KeepAlive>
        <KeepAlive active={tab === "terminals"} retained={retained.has("terminals")}>
          <TerminalsTab project={project} envSets={envSets} />
        </KeepAlive>
        <KeepAlive active={tab === "commands"} retained={retained.has("commands")}>
          <CommandsTab project={project} envSets={envSets} />
        </KeepAlive>
        <KeepAlive active={tab === "diff"} retained={retained.has("diff")}>
          <DiffTab project={project} />
        </KeepAlive>
        <KeepAlive active={tab === "workflows"} retained={retained.has("workflows")}>
          <WorkflowsTab project={project} envSets={envSets} />
        </KeepAlive>
        {/* Every open workspace holds a socket, so they share the same LRU budget. */}
        {workspaces.map((session) => (
          <KeepAlive
            key={session.id}
            active={tab === `agent:${session.id}`}
            retained={retained.has(`agent:${session.id}`)}
          >
            <AgentWorkspace project={project} envSets={envSets} session={session} />
          </KeepAlive>
        ))}

        {/* The rest are cheap and query-cached: remounting them is imperceptible,
            and retaining them would spend memory for nothing. */}
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
        {tab === "memory" && <MemoryTab projectId={project.id} />}
        {tab === "agents" && <AgentsTab projectId={project.id} />}
        {tab === "history" && <HistoryTab projectId={project.id} />}
      </div>

      <ProjectFormDialog key={`${project.id}-${editOpen}`} open={editOpen} onClose={() => setEditOpen(false)} project={project} />
      <DeleteProjectDialog
        project={project}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => void navigate("/projects")}
      />
    </div>
  );
}
