import { useState } from "react";
import { Select } from "@/components/ui/select";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "@/components/ui/icons";
import {
  agentModelSchema,
  KNOWLEDGE_FOLDER_SUGGESTIONS,
  PERMISSION_MODE_CHOICES,
  workflowInputTypeSchema,
  workflowStepTypeSchema,
  type Agent,
  type PermissionMode,
  type Workflow,
  type WorkflowInput,
  type WorkflowInputDef,
  type WorkflowStepInput,
  type WorkflowStepType,
} from "@claude-station/shared";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { MentionTextarea } from "@/components/ui/mention-textarea";
import { DraftNotice } from "@/components/DraftNotice";
import { api } from "@/lib/api";
import { globalKey, useRestorableDraft } from "@/lib/uiStore";
import { useSaveWorkflow } from "./hooks";

const STEP_TYPES = workflowStepTypeSchema.options;
/** "inherit" is the empty value here, so it is dropped from the list itself. */
const STEP_MODELS = agentModelSchema.options.filter((m) => m !== "inherit");
const INPUT_TYPES = workflowInputTypeSchema.options;

const TYPE_HINT: Record<WorkflowStepType, string> = {
  agent: "Runs an agent in its own session — you can open it and watch.",
  command: "Runs one of the project's build/test commands by name.",
  confirm: "Stops for you to answer the questions raised so far.",
  manual: "Stops for you to do something outside the app, then tick it off.",
  gate: "Runs a command and lets the exit code decide: pass, or go back and fix it.",
};

/**
 * Where a failing step sends the run back to. A gate fails on its command's exit
 * code; an agent step fails when it says so through `workflow_step_result`.
 */
function LoopBackFields({
  step,
  others,
  onChange,
  hint,
}: {
  step: WorkflowStepInput;
  others: string[];
  onChange: (patch: Partial<WorkflowStepInput>) => void;
  hint?: string;
}) {
  return (
    <>
      <div>
        <Label>On fail, go back to</Label>
        <Select
          className="w-full"
          value={step.onFail ?? ""}
          onChange={(v) => onChange({ onFail: v || null })}
          options={[
            { value: "", label: "nothing — just fail" },
            ...others.map((key) => ({ value: key, label: key })),
          ]}
        />
        {hint && <p className="mt-1 m3-label-sm text-ink-faint">{hint}</p>}
      </div>
      <div>
        <Label>Max loops</Label>
        <Input
          type="number"
          value={step.maxLoops}
          onChange={(e) =>
            onChange({ maxLoops: Math.min(3, Math.max(0, Number(e.target.value) || 0)) })
          }
        />
        <p className="mt-1 m3-label-sm text-ink-faint">
          3 is the ceiling, and two identical rounds stop it sooner.
        </p>
      </div>
    </>
  );
}

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
    dependsOn: [],
    onFail: null,
    maxLoops: 0,
    cwdLabel: null,
    isolate: false,
    readOnly: false,
    model: null,
  };
}

function toInput(workflow: Workflow): WorkflowInput {
  return {
    name: workflow.name,
    description: workflow.description,
    folder: workflow.folder,
    inputs: workflow.inputs,
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
      dependsOn: s.dependsOn,
      onFail: s.onFail,
      maxLoops: s.maxLoops,
      cwdLabel: s.cwdLabel,
      isolate: s.isolate,
      readOnly: s.readOnly,
      model: s.model,
    })),
  };
}

interface Props {
  onClose: () => void;
  workflow?: Workflow;
  preset?: WorkflowInput;
}

export function WorkflowEditor({ onClose, workflow, preset }: Props) {
  // Keyed by what's being edited, so the new-workflow draft and each existing
  // workflow's edits never bleed into one another.
  const {
    value: draft,
    set: setDraft,
    restored,
    discard,
    clear: clearDraft,
  } = useRestorableDraft<WorkflowInput>(
    globalKey("workflowEditor", workflow?.id ?? "new"),
    workflow
      ? toInput(workflow)
      : (preset ?? { name: "", description: "", folder: "", steps: [blankStep(0)], inputs: [] }),
  );
  const [openStep, setOpenStep] = useState<number | null>(0);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveWorkflow(workflow?.id);

  const { data: agents = [] } = useQuery({
    queryKey: ["agents", "library"],
    queryFn: () => api.get<Agent[]>("/api/agents"),
  });

  const patchInput = (i: number, next: Partial<WorkflowInputDef>) =>
    setDraft((prev) => ({
      ...prev,
      inputs: prev.inputs.map((inp, j) => (j === i ? { ...inp, ...next } : inp)),
    }));

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
        {restored && <DraftNotice onDiscard={discard} />}
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
          <Select
            className="w-full"
            value={draft.folder}
            onChange={(v) => setDraft({ ...draft, folder: v })}
            options={[
              { value: "", label: "unfiled" },
              ...KNOWLEDGE_FOLDER_SUGGESTIONS.map((f) => ({ value: f, label: f })),
            ]}
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="mb-0">Inputs ({draft.inputs.length})</Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  inputs: [
                    ...prev.inputs,
                    {
                      key: `input-${prev.inputs.length + 1}`,
                      label: "",
                      type: "text",
                      required: false,
                      defaultValue: "",
                      help: "",
                      options: [],
                    },
                  ],
                }))
              }
            >
              <Plus size={16} /> Add input
            </Button>
          </div>
          <p className="mb-1.5 m3-label-sm text-ink-faint">
            What this workflow asks for before it starts. Reach a value from any step with{" "}
            <span className="font-mono">{"{{key}}"}</span>; a{" "}
            <span className="font-mono">docs</span> link and a{" "}
            <span className="font-mono">jira-ticket</span> are fetched and handed to the first step,
            so it doesn't spend a turn going to look.
          </p>
          <div className="space-y-1.5">
            {draft.inputs.map((def, i) => (
              <div
                key={i}
                className="grid grid-cols-[9rem_1fr_9rem_auto] gap-2 rounded-md border border-hairline bg-white/4 p-2"
              >
                <Input
                  className="font-mono text-xs"
                  value={def.key}
                  placeholder="key"
                  onChange={(e) => patchInput(i, { key: e.target.value })}
                />
                <Input
                  value={def.label}
                  placeholder="What to call it on the Start screen"
                  onChange={(e) => patchInput(i, { label: e.target.value })}
                />
                <Select
                  className="w-full"
                  value={def.type}
                  onChange={(v) => patchInput(i, { type: v as WorkflowInputDef["type"] })}
                  options={INPUT_TYPES.map((t) => ({ value: t, label: t }))}
                />
                <div className="flex items-center gap-1">
                  <label className="flex cursor-pointer items-center gap-1 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      checked={def.required}
                      onChange={(e) => patchInput(i, { required: e.target.checked })}
                    />
                    req
                  </label>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove input"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        inputs: prev.inputs.filter((_, j) => j !== i),
                      }))
                    }
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="mb-0">Steps ({draft.steps.length})</Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft((prev) => ({
                  ...prev,
                  steps: [...prev.steps, blankStep(prev.steps.length)],
                }));
                setOpenStep(draft.steps.length);
              }}
            >
              <Plus size={16} /> Add step
            </Button>
          </div>

          <div className="space-y-1.5">
            {draft.steps.map((step, i) => (
              <div key={i} className="rounded-md border border-hairline bg-white/4">
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <GripVertical size={16} className="shrink-0 text-ink-faint" />
                  <span className="w-6 shrink-0 text-center font-mono m3-label-sm text-ink-faint">
                    {i + 1}
                  </span>
                  <button
                    onClick={() => setOpenStep(openStep === i ? null : i)}
                    className="min-w-0 flex-1 cursor-pointer text-left"
                  >
                    <span className="text-sm">{step.title || "(untitled step)"}</span>
                    <span className="ml-2 font-mono m3-label-sm text-ink-faint">{step.key}</span>
                  </button>
                  <Badge tone={step.type === "agent" ? "accent" : "default"}>{step.type}</Badge>
                  {step.requiresConfirm && <Badge tone="accent">confirm</Badge>}
                  {step.permissionMode && step.permissionMode !== "default" && (
                    <Badge>{step.permissionMode}</Badge>
                  )}
                  {step.model && <Badge>{step.model}</Badge>}
                  {step.condition && <Badge>conditional</Badge>}
                  <Button size="icon" variant="ghost" onClick={() => move(i, -1)} aria-label="Up">
                    <ChevronUp size={16} />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => move(i, 1)} aria-label="Down">
                    <ChevronDown size={16} />
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
                    <Trash2 size={16} />
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
                        <Select
                          className="w-full"
                          value={step.type}
                          onChange={(v) => patchStep(i, { type: v as WorkflowStepType })}
                          options={STEP_TYPES.map((t) => ({ value: t, label: t }))}
                        />
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
                    <p className="m3-label-sm text-ink-faint">{TYPE_HINT[step.type]}</p>

                    {step.type === "agent" && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label>Agent</Label>
                          <Select
                            className="w-full"
                            value={step.agentName ?? ""}
                            onChange={(v) => patchStep(i, { agentName: v || null })}
                            options={[
                              { value: "", label: "choose an agent…" },
                              ...agents.map((a) => ({ value: a.name, label: a.name })),
                            ]}
                          />
                        </div>
                        <div>
                          <Label>Permission mode</Label>
                          <Select
                            className="w-full"
                            value={step.permissionMode ?? ""}
                            onChange={(v) =>
                              patchStep(i, {
                                permissionMode: (v || null) as PermissionMode | null,
                              })
                            }
                            options={[
                              { value: "", label: "default (ask every edit)" },
                              ...PERMISSION_MODE_CHOICES.filter((m) => m !== "default").map(
                                (m) => ({
                                  value: m,
                                  label: m,
                                }),
                              ),
                            ]}
                          />
                          <p className="mt-1 m3-label-sm text-ink-faint">
                            Use acceptEdits for long implement steps so it runs unattended.
                          </p>
                        </div>
                        <div>
                          <Label>Model</Label>
                          <Select
                            className="w-full"
                            value={step.model ?? ""}
                            onChange={(v) => patchStep(i, { model: v || null })}
                            options={[
                              { value: "", label: "default (this machine's)" },
                              ...STEP_MODELS.map((m) => ({ value: m, label: m })),
                            ]}
                          />
                          <p className="mt-1 m3-label-sm text-ink-faint">
                            A step that repeats a narrow check — build, screenshot, compare — is
                            where a cheaper model pays for itself.
                          </p>
                        </div>
                      </div>
                    )}

                    {step.type === "agent" && (
                      <div className="grid grid-cols-2 gap-2">
                        <LoopBackFields
                          step={step}
                          others={draft.steps.filter((s) => s.key !== step.key).map((s) => s.key)}
                          onChange={(patch) => patchStep(i, patch)}
                          hint="Used when this step reports failed through workflow_step_result — a check that finds the work unfinished sends the run back to redo it."
                        />
                      </div>
                    )}

                    {(step.type === "command" || step.type === "gate") && (
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <Label>Command name</Label>
                          <Input
                            className="font-mono text-xs"
                            value={step.commandName ?? ""}
                            onChange={(e) => patchStep(i, { commandName: e.target.value || null })}
                            placeholder="Test"
                          />
                          <p className="mt-1 m3-label-sm text-ink-faint">
                            Matched by name against the project's Commands at run time.
                          </p>
                        </div>
                        {step.type === "gate" && (
                          <LoopBackFields
                            step={step}
                            others={draft.steps.filter((s) => s.key !== step.key).map((s) => s.key)}
                            onChange={(patch) => patchStep(i, patch)}
                          />
                        )}
                      </div>
                    )}

                    <div>
                      <Label>Instruction</Label>
                      <MentionTextarea
                        value={step.instruction ?? ""}
                        onChange={(v) => patchStep(i, { instruction: v || null })}
                        placeholder={
                          step.type === "manual"
                            ? "What you need to do before continuing"
                            : "What this step should accomplish — {{inputKey}} and @tags are filled in for you"
                        }
                        rows={4}
                        className="text-xs"
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

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label>Runs after</Label>
                        <Input
                          className="font-mono text-xs"
                          value={step.dependsOn.join(", ")}
                          onChange={(e) =>
                            patchStep(i, {
                              dependsOn: e.target.value
                                .split(",")
                                .map((k) => k.trim())
                                .filter(Boolean),
                            })
                          }
                          placeholder="the step above"
                        />
                        <p className="mt-1 m3-label-sm text-ink-faint">
                          Name two or more keys and this step waits for all of them — which is also
                          how two steps naming the same one end up running side by side.
                        </p>
                      </div>
                      <div>
                        <Label>Path label</Label>
                        <Input
                          value={step.cwdLabel ?? ""}
                          onChange={(e) => patchStep(i, { cwdLabel: e.target.value || null })}
                          placeholder="the run's own directory"
                        />
                        <p className="mt-1 m3-label-sm text-ink-faint">
                          Which repo of the project this step works in.
                        </p>
                      </div>
                    </div>

                    {step.type === "agent" && (
                      <div className="space-y-1.5">
                        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
                          <input
                            type="checkbox"
                            checked={step.requiresConfirm}
                            onChange={(e) => patchStep(i, { requiresConfirm: e.target.checked })}
                          />
                          Stop for my confirmation after this step
                        </label>
                        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
                          <input
                            type="checkbox"
                            checked={step.isolate}
                            onChange={(e) => patchStep(i, { isolate: e.target.checked })}
                          />
                          Own git worktree — needed for steps that run beside one another in the
                          same repo
                        </label>
                      </div>
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
                onSuccess: () => {
                  clearDraft(); // saved — nothing left unsaved to restore
                  onClose();
                },
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
