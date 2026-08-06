import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Hammer, Play, Square, Trash2, Plus, X } from "lucide-react";
import {
  COMMAND_PRESETS,
  commandKindSchema,
  type EnvSet,
  type PathCommandInput,
  type Project,
} from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { LogPane } from "./LogPane";
import {
  useCommandRuns,
  useCreateCommand,
  useDeleteCommand,
  useDeleteRun,
  useKillRun,
  useRunCommand,
} from "./hooks";

const KINDS = commandKindSchema.options;

interface Props {
  project: Project;
  envSets: EnvSet[];
}

export function CommandsTab({ project, envSets }: Props) {
  const qc = useQueryClient();
  const { data: runs = [] } = useCommandRuns(project.id);
  const run = useRunCommand(project.id);
  const kill = useKillRun(project.id);
  const removeRun = useDeleteRun(project.id);

  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<string | null>(null);

  // Each repo remembers its own default env set — Claude's runs use it too.
  const setPathEnv = useMutation({
    mutationFn: ({ pathId, envSetId }: { pathId: string; envSetId: string | null }) =>
      api.patch(`/api/projects/${project.id}/paths/${pathId}`, { envSetId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  const activeRun = selectedRun ?? runs.find((r) => r.active)?.id ?? runs[0]?.id ?? null;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-[420px] shrink-0 overflow-y-auto border-r border-edge p-4">
        <h2 className="mb-3 text-sm font-medium">Commands</h2>

        {project.paths.map((path) => (
          <div key={path.id} className="mb-5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{path.label}</p>
                <p className="truncate font-mono text-[10.5px] text-ink-faint">{path.path}</p>
              </div>
              <select
                value={path.envSetId ?? ""}
                onChange={(e) =>
                  setPathEnv.mutate({ pathId: path.id, envSetId: e.target.value || null })
                }
                title="Default env set for this repo's commands (also used when Claude runs them)"
                className="h-7 max-w-36 shrink-0 rounded-md border border-edge bg-surface px-2 text-[11px] text-ink"
              >
                <option value="">no env</option>
                {envSets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="ghost" onClick={() => setAddFor(path.id)}>
                <Plus size={13} />
              </Button>
            </div>

            {path.commands.length === 0 && (
              <p className="rounded-md border border-dashed border-edge px-3 py-2.5 text-[11px] text-ink-faint">
                No commands. Add one (xcodebuild, ./gradlew, npm run build…) so both you and Claude
                can run it.
              </p>
            )}

            <div className="space-y-1.5">
              {path.commands.map((cmd) => (
                <CommandRow
                  key={cmd.id}
                  pathId={path.id}
                  command={cmd}
                  pending={run.isPending}
                  onRun={() =>
                    run.mutate(
                      { commandId: cmd.id },
                      { onSuccess: (r) => setSelectedRun(r.runId) },
                    )
                  }
                />
              ))}
            </div>
          </div>
        ))}

        <h2 className="mb-2 mt-6 text-sm font-medium">Recent runs</h2>
        <div className="space-y-1">
          {runs.length === 0 && <p className="text-[11px] text-ink-faint">Nothing run yet.</p>}
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedRun(r.id)}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors cursor-pointer",
                activeRun === r.id ? "bg-surface-3" : "hover:bg-surface-2",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  r.active
                    ? "bg-warn animate-status"
                    : r.exitCode === 0
                      ? "bg-ok"
                      : "bg-err",
                )}
              />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="shrink-0 text-[10px] text-ink-faint">
                {r.origin === "claude" ? "claude" : ""}
              </span>
              {r.active && (
                <Square
                  size={11}
                  className="shrink-0 text-err"
                  onClick={(e) => {
                    e.stopPropagation();
                    kill.mutate(r.id);
                  }}
                />
              )}
              <X
                size={12}
                aria-label="Delete run"
                className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-err"
                onClick={(e) => {
                  e.stopPropagation();
                  if (r.active && !confirm(`"${r.name}" is still running — stop it and delete the run?`)) {
                    return;
                  }
                  if (selectedRun === r.id) setSelectedRun(null);
                  removeRun.mutate(r.id);
                }}
              />
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {activeRun ? (
          <LogPane key={activeRun} runId={activeRun} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Hammer size={28} className="text-ink-faint" />
            <p className="text-sm text-ink-muted">Run a command to see its log here.</p>
          </div>
        )}
      </div>

      <AddCommandDialog pathId={addFor} onClose={() => setAddFor(null)} />
    </div>
  );
}

function CommandRow({
  pathId,
  command,
  pending,
  onRun,
}: {
  pathId: string;
  command: Project["paths"][number]["commands"][number];
  pending: boolean;
  onRun: () => void;
}) {
  const del = useDeleteCommand(pathId);
  return (
    <Card className="group flex items-center gap-2 p-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{command.name}</span>
          <Badge>{command.kind}</Badge>
        </div>
        <p className="truncate font-mono text-[10.5px] text-ink-faint">{command.command}</p>
      </div>
      <Button size="icon" variant="ghost" onClick={onRun} disabled={pending} aria-label="Run">
        <Play size={13} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="opacity-0 group-hover:opacity-100"
        onClick={() => del.mutate(command.id)}
        aria-label="Delete command"
      >
        <Trash2 size={13} />
      </Button>
    </Card>
  );
}

function AddCommandDialog({ pathId, onClose }: { pathId: string | null; onClose: () => void }) {
  const create = useCreateCommand(pathId ?? "");
  const [draft, setDraft] = useState<PathCommandInput>({
    name: "",
    kind: "build",
    command: "",
    cwdOverride: null,
    timeoutSec: 900,
  });

  const applyPreset = (key: keyof typeof COMMAND_PRESETS) => {
    const preset = COMMAND_PRESETS[key]?.[0];
    if (preset) setDraft({ ...preset });
  };

  return (
    <Dialog open={pathId !== null} onClose={onClose} title="Add command">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {Object.keys(COMMAND_PRESETS).map((key) => (
            <Button
              key={key}
              size="sm"
              variant="ghost"
              onClick={() => applyPreset(key as keyof typeof COMMAND_PRESETS)}
            >
              {key}
            </Button>
          ))}
        </div>
        <div>
          <Label>Name</Label>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Build (Simulator)"
          />
        </div>
        <div>
          <Label>Command</Label>
          <Input
            className="font-mono text-xs"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            placeholder="./gradlew :app:assembleDebug"
          />
        </div>
        <div className="flex gap-2">
          <div className="w-32">
            <Label>Kind</Label>
            <select
              value={draft.kind}
              onChange={(e) =>
                setDraft({ ...draft, kind: e.target.value as PathCommandInput["kind"] })
              }
              className="h-9 w-full rounded-md border border-edge bg-surface px-2 text-sm text-ink"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="w-32">
            <Label>Timeout (s)</Label>
            <Input
              type="number"
              value={draft.timeoutSec}
              onChange={(e) => setDraft({ ...draft, timeoutSec: Number(e.target.value) || 900 })}
            />
          </div>
          <div className="flex-1">
            <Label>cwd override (optional)</Label>
            <Input
              className="font-mono text-xs"
              value={draft.cwdOverride ?? ""}
              onChange={(e) => setDraft({ ...draft, cwdOverride: e.target.value || null })}
              placeholder="defaults to the path"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!draft.name.trim() || !draft.command.trim() || create.isPending}
            onClick={() =>
              create.mutate(draft, {
                onSuccess: () => {
                  setDraft({ name: "", kind: "build", command: "", cwdOverride: null, timeoutSec: 900 });
                  onClose();
                },
              })
            }
          >
            Add
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
