import { useState } from "react";
import { Link } from "react-router";
import { FolderGit2, Plus, Trash2 } from "lucide-react";
import type { Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Card, Badge } from "@/components/ui/card";
import { DeleteProjectDialog } from "@/features/projects/DeleteProjectDialog";
import { ProjectFormDialog } from "@/features/projects/ProjectFormDialog";
import { useProjects } from "@/features/projects/hooks";

export function ProjectsPage() {
  const { data: projects, isLoading } = useProjects();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Projects</h1>
          <p className="text-sm text-ink-muted">Workspaces Claude can work in — each groups related repos.</p>
        </div>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={16} /> New project
        </Button>
      </div>

      {isLoading && <p className="text-sm text-ink-muted">Loading…</p>}

      {projects?.length === 0 && (
        <Card className="flex flex-col items-center gap-3 py-12 text-center">
          <FolderGit2 size={32} className="text-ink-faint" />
          <div>
            <p className="font-medium">No projects yet</p>
            <p className="text-sm text-ink-muted">Create one and point it at your repos (FE, BE, iOS…).</p>
          </div>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> New project
          </Button>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {projects?.map((p) => (
          // The delete button is a sibling of the Link, not a child: a button
          // nested in an anchor is invalid, and swallowing the navigation click
          // on every card just to support one control is worse.
          <div key={p.id} className="group relative">
            <Link to={`/projects/${p.id}`}>
              <Card className="h-full hover:border-edge-strong hover:bg-surface-2">
                <div className="mb-1 flex items-center justify-between">
                  <h2 className="font-medium">{p.name}</h2>
                  <Badge className="transition-opacity group-hover:opacity-0">
                    {p.paths.length} repo{p.paths.length === 1 ? "" : "s"}
                  </Badge>
                </div>
                {p.description && <p className="mb-2 text-sm text-ink-muted line-clamp-2">{p.description}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {p.paths.map((path) => (
                    <Badge key={path.id} tone="accent">
                      {path.label}
                    </Badge>
                  ))}
                </div>
              </Card>
            </Link>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Delete project ${p.name}`}
              title="Delete project"
              className="absolute top-2.5 right-2.5 opacity-0 hover:text-err group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => setPendingDelete(p)}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
      </div>

      {pendingDelete && (
        <DeleteProjectDialog
          project={pendingDelete}
          open
          onClose={() => setPendingDelete(null)}
        />
      )}

      <ProjectFormDialog key={String(createOpen)} open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
