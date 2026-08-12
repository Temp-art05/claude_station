import { useEffect } from "react";
import { NavLink, Outlet, useLocation, useMatch } from "react-router";
import {
  FolderKanban,
  Ticket,
  GitPullRequest,
  BookOpen,
  Bot,
  Workflow,
  KeyRound,
  Search,
  Settings,
  TerminalSquare,
} from "lucide-react";
import type { Project } from "@claude-station/shared";
import { cn } from "@/lib/utils";
import { globalKey, useUiState } from "@/lib/uiStore";
import { useScrollMemory } from "@/lib/useScrollMemory";
import { useProjects } from "@/features/projects/hooks";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { KeepAlive, useRetainedKeys } from "./KeepAlive";
import { TokenGate } from "./TokenGate";

const NAV = [
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/jira", label: "Jira", icon: Ticket },
  { to: "/github", label: "GitHub", icon: GitPullRequest },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/env", label: "Env", icon: KeyRound },
  { to: "/search", label: "Search", icon: Search },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** Nav is grouped so the daily surfaces sit apart from the configuration ones. */
const GROUPS: { label?: string; items: typeof NAV }[] = [
  { items: NAV.slice(0, 3) },
  { label: "Library", items: NAV.slice(3, 6) },
  { label: "Setup", items: NAV.slice(6) },
];

export function AppShell() {
  // The page scroller. Keyed by the full URL, so each view — including each
  // tab and each open PR — is remembered separately rather than sharing one
  // offset that would be wrong for all of them.
  const { pathname, search } = useLocation();
  const mainRef = useScrollMemory<HTMLElement>(pathname + search);

  // The router still owns the URL; it just doesn't render the project page.
  const projectId = useMatch("/projects/:id")?.params.id ?? null;
  const retained = useRetainedKeys(projectId, Infinity);

  // Sidebar "Projects" returns you to the project you were working in, the same
  // way GitHub returns you to the repo and PR you had open. The list is still
  // reachable from the breadcrumb inside a project — leaving your work to go
  // pick it out of a grid again is the thing that made this feel broken.
  const { data: projects = [] } = useProjects();
  const [rememberedId, remember] = useUiState<string | null>(globalKey("lastProject"), null);
  useEffect(() => {
    if (projectId && projectId !== rememberedId) remember(projectId);
  }, [projectId, rememberedId, remember]);
  // Validated: the remembered project may have been deleted since.
  const lastProject = projects.some((p) => p.id === rememberedId) ? rememberedId : null;

  // A project deleted while open leaves a retained id behind — drop it so no
  // hidden page keeps rendering against data that no longer exists.
  const openProjects = [...retained]
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => p !== undefined);

  return (
    <div className="flex h-full gap-2 p-2">
      <aside className="glass flex w-56 shrink-0 flex-col rounded-xl">
        <div className="flex items-center gap-3 px-3.5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink shadow-[inset_0_1px_0_rgb(255_255_255/35%),0_6px_16px_-8px_var(--color-accent)]">
            <TerminalSquare size={18} />
          </div>
          <div className="min-w-0">
            <p className="font-display truncate text-lg leading-tight font-bold">Claude Station</p>
            <p className="truncate text-[11px] font-medium text-ink-faint">local workspace</p>
          </div>
        </div>

        <nav className="flex flex-col px-2">
          {GROUPS.map((group, i) => (
            <div
              key={group.label ?? i}
              // A hairline separates each group; the first sits under the brand.
              className="flex flex-col gap-0.5 border-t border-hairline pt-2.5 pb-1 first:border-t-0"
            >
              {group.label && (
                <p className="px-3 pb-1.5 text-xs font-bold tracking-[0.14em] text-ink-muted uppercase">
                  {group.label}
                </p>
              )}
              {group.items.map(({ to, label, icon: Icon }) => {
                // `to` stays the section root for highlighting; the click can go
                // deeper — Projects returns you to the project you were in.
                const active = pathname === to || pathname.startsWith(`${to}/`);
                return (
                  <NavLink
                    key={to}
                    to={to === "/projects" && lastProject ? `/projects/${lastProject}` : to}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-pill px-3 py-2 text-sm transition-all duration-150",
                      active
                        ? "border border-hairline-strong bg-white/8 font-bold text-ink shadow-[inset_0_1px_0_rgb(255_255_255/10%)] backdrop-blur-md"
                        : "border border-transparent font-semibold text-ink-muted hover:bg-white/5 hover:text-ink",
                    )}
                  >
                    <Icon size={16} strokeWidth={2.25} className={active ? "text-accent" : undefined} />
                    {label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto border-t border-hairline px-3.5 py-3 text-[11px] font-medium text-ink-faint">
          v0.1.0 · 127.0.0.1
        </div>
      </aside>

      <main
        ref={mainRef}
        className="glass-flat min-w-0 flex-1 overflow-y-auto rounded-xl border border-hairline"
      >
        <TokenGate>
          {/* Project pages live here, not in the outlet, so leaving for GitHub
              or Jira hides them instead of tearing down their terminals. Every
              project you open stays mounted for the life of the page. */}
          {openProjects.map((p) => (
            <KeepAlive key={p.id} active={p.id === projectId} retained>
              <ProjectDetailPage projectId={p.id} />
            </KeepAlive>
          ))}
          <Outlet />
        </TokenGate>
      </main>
    </div>
  );
}
