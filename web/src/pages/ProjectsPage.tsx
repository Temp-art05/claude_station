import { useState } from "react";
import { Link } from "react-router";
import { FolderGit2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Badge } from "@/components/ui/card";
import { ProjectFormDialog } from "@/features/projects/ProjectFormDialog";
import { useProjects } from "@/features/projects/hooks";

export function ProjectsPage() {
  const { data: projects, isLoading } = useProjects();
  const [createOpen, setCreateOpen] = useState(false);

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
          <Link key={p.id} to={`/projects/${p.id}`}>
            <Card className="h-full hover:border-edge-strong hover:bg-surface-2">
              <div className="mb-1 flex items-center justify-between">
                <h2 className="font-medium">{p.name}</h2>
                <Badge>{p.paths.length} repo{p.paths.length === 1 ? "" : "s"}</Badge>
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
        ))}
      </div>

      <ProjectFormDialog key={String(createOpen)} open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
