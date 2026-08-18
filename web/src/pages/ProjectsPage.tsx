import { useState } from "react";
import { Link } from "react-router";
import { FolderGit2, FolderKanban, Plus, Trash2 } from "@/components/ui/icons";
import type { Project } from "@claude-station/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Card, Badge } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { DeleteProjectDialog } from "@/features/projects/DeleteProjectDialog";
import { ProjectFormDialog } from "@/features/projects/ProjectFormDialog";
import { useProjects } from "@/features/projects/hooks";

export function ProjectsPage() {
  const { data: projects, isLoading } = useProjects();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <PageHeader
        title="Projects"
        icon={FolderKanban}
        supporting="Workspaces Claude can work in — each groups related repos."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={18} /> New project
          </Button>
        }
      />

      {isLoading && <p className="m3-body-md text-ink-muted">Loading…</p>}

      {projects?.length === 0 && (
        <EmptyState
          icon={FolderGit2}
          title="No projects yet"
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus size={18} /> New project
            </Button>
          }
        >
          Create one and point it at your repos (FE, BE, iOS…).
        </EmptyState>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {projects?.map((p) => (
          // The delete button is a sibling of the Link, not a child: a button
          // nested in an anchor is invalid, and swallowing the navigation click
          // on every card just to support one control is worse.
          <div key={p.id} className="group relative">
            <Link to={`/projects/${p.id}`}>
              <Card interactive className="h-full p-5">
                <div className="mb-1.5 flex items-start justify-between gap-3">
                  <h2 className="m3-title-md">{p.name}</h2>
                  <Badge className="shrink-0 transition-opacity group-hover:opacity-0">
                    {p.paths.length} repo{p.paths.length === 1 ? "" : "s"}
                  </Badge>
                </div>
                {p.description && (
                  <p className="m3-body-sm mb-3 line-clamp-2 text-ink-muted">{p.description}</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {p.paths.map((path) => (
                    <Badge key={path.id} tone="accent">
                      {path.label}
                    </Badge>
                  ))}
                </div>
              </Card>
            </Link>
            <IconButton
              dense
              aria-label={`Delete project ${p.name}`}
              title="Delete project"
              className="absolute top-3 right-3 opacity-0 hover:text-err group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => setPendingDelete(p)}
            >
              <Trash2 size={16} />
            </IconButton>
          </div>
        ))}
      </div>

      {pendingDelete && (
        <DeleteProjectDialog project={pendingDelete} open onClose={() => setPendingDelete(null)} />
      )}

      <ProjectFormDialog
        key={String(createOpen)}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
