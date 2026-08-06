import { useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react";
import {
  KNOWLEDGE_FOLDER_SUGGESTIONS,
  PERMISSION_MODE_CHOICES,
  workflowStepTypeSchema,
  type Agent,
  type PermissionMode,
  type Workflow,
  type WorkflowInput,
  type WorkflowStepInput,
  type WorkflowStepType,
} from "@claude-station/shared";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useSaveWorkflow } from "./hooks";

const STEP_TYPES = workflowStepTypeSchema.options;

const TYPE_HINT: Record<WorkflowStepType, string> = {
  agent: "Runs an agent in its own session — you can open it and watch.",
  command: "Runs one of the project's build/test commands by name.",
  confirm: "Stops for you to answer the questions raised so far.",
  manual: "Stops for you to do something outside the app, then tick it off.",
};

function blankStep(index: number): WorkflowStepInput {
  return {
    key: `step-${index + 1}`,
    type: "agent",
    title: "",
    agentName: null,
    instruction: null,
    commandName: null,
    requiresConfirm: false,
    permissionMode: null,
    maxRetries: 0,
    condition: null,
  };
}

function toInput(workflow: Workflow): WorkflowInput {
  return {
    name: workflow.name,
    description: workflow.description,
    folder: workflow.folder,
    steps: workflow.steps.map((s) => ({
      key: s.key,
      type: s.type,
      title: s.title,
      agentName: s.agentName,
      instruction: s.instruction,
      commandName: s.commandName,
      requiresConfirm: s.requiresConfirm,
      permissionMode: s.permissionMode,
      maxRetries: s.maxRetries,
      condition: s.condition,
    })),
  };
}

interface Props {
  onClose: () => void;
  workflow?: Workflow;
  preset?: WorkflowInput;
}

export function WorkflowEditor({ onClose, workflow, preset }: Props) {
  const [draft, setDraft] = useState<WorkflowInput>(
    () =>
      workflow
        ? toInput(workflow)
        : (preset ?? { name: "", description: "", folder: "", steps: [blankStep(0)] }),
  );
  const [openStep, setOpenStep] = useState<number | null>(0);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveWorkflow(workflow?.id);

  const { data: agents = [] } = useQuery({
    queryKey: ["agents", "library"],
    queryFn: () => api.get<Agent[]>("/api/agents"),
  });

  const patchStep = (i: number, next: Partial<WorkflowStepInput>) =>
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.map((s, j) => (j === i ? { ...s, ...next } : s)),
    }));

  const move = (i: number, delta: number) =>
    setDraft((prev) => {
      const steps = [...prev.steps];
      const target = i + delta;
      if (target < 0 || target >= steps.length) return prev;
      const [item] = steps.splice(i, 1);
      steps.splice(target, 0, item!);
      return { ...prev, steps };
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={workflow ? `Edit ${workflow.name}` : "New workflow"}
      className="max-w-3xl"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="ios-feature"
              className="font-mono text-xs"
            />
          </div>
          <div className="col-span-2">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Read docs → plan → confirm → implement → test"
            />
          </div>
        </div>

        <div className="w-40">
          <Label>Folder</Label>
          <select
            value={draft.folder}
            onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
            className="h-9 w-full px-2 text-sm"
          >
            <option value="">unfiled</option>
            {KNOWLEDGE_FOLDER_SUGGESTIONS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="mb-0">Steps ({draft.steps.length})</Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft((prev) => ({ ...prev, steps: [...prev.steps, blankStep(prev.steps.length)] }));
                setOpenStep(draft.steps.length);
              }}
            >
              <Plus size={13} /> Add step
            </Button>
          </div>

          <div className="space-y-1.5">
            {draft.steps.map((step, i) => (
              <div key={i} className="rounded-md border border-hairline bg-white/4">
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <GripVertical size={13} className="shrink-0 text-ink-faint" />
                  <span className="w-6 shrink-0 text-center font-mono text-[11px] text-ink-faint">
                    {i + 1}
                  </span>
                  <button
                    onClick={() => setOpenStep(openStep === i ? null : i)}
                    className="min-w-0 flex-1 cursor-pointer text-left"
                  >
                    <span className="text-sm">{step.title || "(untitled step)"}</span>
                    <span className="ml-2 font-mono text-[10.5px] text-ink-faint">{step.key}</span>
                  </button>
                  <Badge tone={step.type === "agent" ? "accent" : "default"}>{step.type}</Badge>
                  {step.requiresConfirm && <Badge tone="accent">confirm</Badge>}
                  {step.permissionMode && step.permissionMode !== "default" && (
                    <Badge>{step.permissionMode}</Badge>
                  )}
                  {step.condition && <Badge>conditional</Badge>}
                  <Button size="icon" variant="ghost" onClick={() => move(i, -1)} aria-label="Up">
                    <ChevronUp size={13} />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => move(i, 1)} aria-label="Down">
                    <ChevronDown size={13} />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={draft.steps.length === 1}
                    onClick={() =>
                      setDraft((prev) => ({ ...prev, steps: prev.steps.filter((_, j) => j !== i) }))
                    }
                    aria-label="Remove step"
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>

                {openStep === i && (
                  <div className="space-y-2.5 border-t border-hairline px-3 py-3">
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <Label>Key</Label>
                        <Input
                          className="font-mono text-xs"
                          value={step.key}
                          onChange={(e) => patchStep(i, { key: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>Type</Label>
                        <select
                          value={step.type}
                          onChange={(e) =>
                            patchStep(i, { type: e.target.value as WorkflowStepType })
                          }
                          className="h-9 w-full px-2 text-sm"
                        >
                          {STEP_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <Label>Title</Label>
                        <Input
                          value={step.title}
                          onChange={(e) => patchStep(i, { title: e.target.value })}
                          placeholder="Plan FE + BE"
                        />
                      </div>
                    </div>
                    <p className="text-[10.5px] text-ink-faint">{TYPE_HINT[step.type]}</p>

                    {step.type === "agent" && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label>Agent</Label>
                          <select
                            value={step.agentName ?? ""}
                            onChange={(e) => patchStep(i, { agentName: e.target.value || null })}
                            className="h-9 w-full px-2 text-sm"
                          >
                            <option value="">choose an agent…</option>
                            {agents.map((a) => (
                              <option key={a.id} value={a.name}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <Label>Permission mode</Label>
                          <select
                            value={step.permissionMode ?? ""}
                            onChange={(e) =>
                              patchStep(i, {
                                permissionMode: (e.target.value || null) as PermissionMode | null,
                              })
                            }
                            className="h-9 w-full px-2 text-sm"
                          >
                            <option value="">default (ask every edit)</option>
                            {PERMISSION_MODE_CHOICES.filter((m) => m !== "default").map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-[10.5px] text-ink-faint">
                            Use acceptEdits for long implement steps so it runs unattended.
                          </p>
                        </div>
                      </div>
                    )}

                    {step.type === "command" && (
                      <div className="w-56">
                        <Label>Command name</Label>
                        <Input
                          className="font-mono text-xs"
                          value={step.commandName ?? ""}
                          onChange={(e) => patchStep(i, { commandName: e.target.value || null })}
                          placeholder="Test"
                        />
                        <p className="mt-1 text-[10.5px] text-ink-faint">
                          Matched by name against the project's Commands at run time.
                        </p>
                      </div>
                    )}

                    <div>
                      <Label>Instruction</Label>
                      <Textarea
                        value={step.instruction ?? ""}
                        onChange={(e) => patchStep(i, { instruction: e.target.value || null })}
                        placeholder={
                          step.type === "manual"
                            ? "What you need to do before continuing"
                            : "What this step should accomplish"
                        }
                        className="min-h-[70px] text-xs"
                      />
                    </div>

                    <div className="grid grid-cols-3 items-end gap-2">
                      <div>
                        <Label>Max retries</Label>
                        <Input
                          type="number"
                          value={step.maxRetries}
                          onChange={(e) =>
                            patchStep(i, { maxRetries: Math.min(3, Number(e.target.value) || 0) })
                          }
                        />
                      </div>
                      <div className="col-span-2">
                        <Label>Condition</Label>
                        <Input
                          className="font-mono text-xs"
                          value={step.condition ?? ""}
                          onChange={(e) => patchStep(i, { condition: e.target.value || null })}
                          placeholder='steps.test.failed · answers.scope == "fe-only"'
                        />
                      </div>
                    </div>

                    {step.type === "agent" && (
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
                        <input
                          type="checkbox"
                          checked={step.requiresConfirm}
                          onChange={(e) => patchStep(i, { requiresConfirm: e.target.checked })}
                        />
                        Stop for my confirmation after this step
                      </label>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-err">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!draft.name.trim() || save.isPending}
            onClick={() => {
              setError(null);
              save.mutate(draft, {
                onSuccess: onClose,
                onError: (err: unknown) =>
                  setError(err instanceof Error ? err.message : "Failed to save"),
              });
            }}
          >
            {save.isPending ? "Saving…" : workflow ? "Save changes" : "Create workflow"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
