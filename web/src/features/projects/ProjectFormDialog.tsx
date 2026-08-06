import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Project, ProjectInput, ProjectPathInput } from "@claude-station/shared";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { useCreateProject, useUpdateProject } from "./hooks";

interface Props {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this project instead of creating one. */
  project?: Project;
}

const emptyPath: ProjectPathInput = {
  path: "",
  label: "",
  description: "",
  isDefault: false,
  commands: [],
};

/** Remounted per open (see the key below), so state initialises from `project`. */
export function ProjectFormDialog({ open, onClose, project }: Props) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [paths, setPaths] = useState<ProjectPathInput[]>(() =>
    project?.paths.length
      ? project.paths.map((p) => ({
          path: p.path,
          label: p.label,
          description: p.description,
          isDefault: p.isDefault,
          // Commands are managed in the Commands tab — keep them on save.
          commands: p.commands.map((c) => ({
            name: c.name,
            kind: c.kind,
            command: c.command,
            cwdOverride: c.cwdOverride,
            timeoutSec: c.timeoutSec,
          })),
        }))
      : [{ ...emptyPath }],
  );
  const [error, setError] = useState<string | null>(null);

  const create = useCreateProject();
  const update = useUpdateProject(project?.id ?? "");
  const pending = create.isPending || update.isPending;

  const setPath = (i: number, patch: Partial<ProjectPathInput>) =>
    setPaths((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const submit = async () => {
    setError(null);
    const input: ProjectInput = {
      name: name.trim(),
      description: description.trim(),
      paths: paths.filter((p) => p.path.trim()).map((p) => ({ ...p, label: p.label.trim() || p.path.split("/").pop() || p.path })),
    };
    if (!input.name) return setError("Name is required");
    try {
      await (project ? update.mutateAsync(input) : create.mutateAsync(input));
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={project ? "Edit project" : "New project"} className="max-w-2xl">
      <div className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ReelMe" autoFocus />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this workspace about? Claude reads this as context."
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label className="mb-0">Repo paths</Label>
            <Button size="sm" variant="ghost" onClick={() => setPaths((p) => [...p, { ...emptyPath }])}>
              <Plus size={14} /> Add path
            </Button>
          </div>
          <div className="space-y-3">
            {paths.map((p, i) => (
              <div key={i} className="rounded-md border border-edge bg-surface p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    className="font-mono text-xs"
                    value={p.path}
                    onChange={(e) => setPath(i, { path: e.target.value })}
                    placeholder="/Users/you/IOS/IIP555-ReelMe"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setPaths((prev) => prev.filter((_, j) => j !== i))}
                    disabled={paths.length === 1}
                    aria-label="Remove path"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Input
                    className="w-44"
                    value={p.label}
                    onChange={(e) => setPath(i, { label: e.target.value })}
                    placeholder="Label (e.g. BE source)"
                  />
                  <Input
                    value={p.description}
                    onChange={(e) => setPath(i, { description: e.target.value })}
                    placeholder="Describe this repo so Claude understands it"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
                  <input
                    type="radio"
                    name="default-path"
                    checked={p.isDefault}
                    onChange={() => setPaths((prev) => prev.map((q, j) => ({ ...q, isDefault: j === i })))}
                    className="accent-(--color-accent)"
                  />
                  Default working directory
                </label>
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-err">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? "Saving…" : project ? "Save changes" : "Create project"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
