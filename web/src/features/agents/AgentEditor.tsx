import { useState } from "react";
import { Wrench, Ban } from "lucide-react";
import {
  AGENT_TOOL_CHOICES,
  agentModelSchema,
  type Agent,
  type AgentInput,
} from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DraftNotice } from "@/components/DraftNotice";
import { globalKey, useRestorableDraft } from "@/lib/uiStore";
import { cn } from "@/lib/utils";
import { useSaveAgent } from "./hooks";

const MODELS = agentModelSchema.options;

function blank(): AgentInput {
  return {
    name: "",
    description: "",
    prompt: "",
    tools: null,
    disallowedTools: null,
    skills: null,
    model: null,
    maxTurns: null,
    background: false,
    viewPath: null,
    viewUrl: null,
    startCommand: null,
    enabledGlobally: false,
  };
}

function toInput(agent: Agent): AgentInput {
  return {
    name: agent.name,
    description: agent.description,
    prompt: agent.prompt,
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    skills: agent.skills,
    model: agent.model,
    maxTurns: agent.maxTurns,
    background: agent.background,
    viewPath: agent.viewPath,
    viewUrl: agent.viewUrl,
    startCommand: agent.startCommand,
    enabledGlobally: agent.enabledGlobally,
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Editing an existing agent, or seeding a new one from a preset. */
  agent?: Agent;
  preset?: AgentInput;
}

/**
 * Tool access is the part people get wrong, so allow/deny is a visible
 * three-state toggle per tool rather than two free-text lists.
 */
export function AgentEditor({ open, onClose, agent, preset }: Props) {
  const {
    value: draft,
    set: setDraft,
    restored,
    discard,
    clear: clearDraft,
  } = useRestorableDraft<AgentInput>(
    globalKey("agentEditor", agent?.id ?? "new"),
    agent ? toInput(agent) : (preset ?? blank()),
  );
  const [error, setError] = useState<string | null>(null);
  const save = useSaveAgent(agent?.id);

  const patch = (next: Partial<AgentInput>) => setDraft((prev) => ({ ...prev, ...next }));

  const toolState = (tool: string): "allow" | "deny" | "inherit" => {
    if (draft.disallowedTools?.includes(tool)) return "deny";
    if (draft.tools?.includes(tool)) return "allow";
    return "inherit";
  };

  const cycleTool = (tool: string) => {
    const state = toolState(tool);
    const without = (list: string[] | null) => {
      const next = (list ?? []).filter((t) => t !== tool);
      return next.length ? next : null;
    };
    if (state === "inherit") {
      patch({ tools: [...(draft.tools ?? []), tool], disallowedTools: without(draft.disallowedTools) });
    } else if (state === "allow") {
      patch({
        tools: without(draft.tools),
        disallowedTools: [...(draft.disallowedTools ?? []), tool],
      });
    } else {
      patch({ tools: without(draft.tools), disallowedTools: without(draft.disallowedTools) });
    }
  };

  const submit = () => {
    setError(null);
    save.mutate(
      { ...draft, name: draft.name.trim(), description: draft.description.trim() },
      {
        onSuccess: () => {
          clearDraft(); // saved — nothing left unsaved to restore
          onClose();
        },
        onError: (err: unknown) => setError(err instanceof Error ? err.message : "Failed to save"),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={agent ? `Edit ${agent.name}` : "New agent"}
      className="max-w-3xl"
    >
      <div className="space-y-4">
        {restored && <DraftNotice onDiscard={discard} />}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="build-fixer"
              className="font-mono text-xs"
              disabled={!!agent && agent.source === "imported"}
            />
            <p className="mt-1 text-[10.5px] text-ink-faint">
              The name Claude delegates to. Lowercase and dashes.
            </p>
          </div>
          <div>
            <Label>Model</Label>
            <select
              value={draft.model ?? "inherit"}
              onChange={(e) =>
                patch({ model: e.target.value === "inherit" ? null : e.target.value })
              }
              className="h-9 w-full rounded-md border border-edge bg-surface px-2 text-sm text-ink"
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10.5px] text-ink-faint">
              A cheaper model is fine for narrow agents.
            </p>
          </div>
          <div>
            <Label>Max turns</Label>
            <Input
              type="number"
              value={draft.maxTurns ?? ""}
              onChange={(e) => patch({ maxTurns: Number(e.target.value) || null })}
              placeholder="unlimited"
            />
            <p className="mt-1 text-[10.5px] text-ink-faint">Caps a runaway loop.</p>
          </div>
        </div>

        <div>
          <Label>When should Claude use it?</Label>
          <Input
            value={draft.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="Use when a build or test command fails…"
          />
          <p className="mt-1 text-[10.5px] text-ink-faint">
            This is the only thing the main agent reads when deciding to delegate — describe the
            trigger, not the personality.
          </p>
        </div>

        <div>
          <Label>System prompt</Label>
          <Textarea
            value={draft.prompt}
            onChange={(e) => patch({ prompt: e.target.value })}
            placeholder="You fix broken builds. Start with list_project_commands…"
            className="min-h-[140px] font-mono text-xs"
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="mb-0">Tools</Label>
            <div className="flex items-center gap-3 text-[10.5px] text-ink-faint">
              <span className="inline-flex items-center gap-1">
                <Wrench size={10} className="text-accent" /> allow
              </span>
              <span className="inline-flex items-center gap-1">
                <Ban size={10} className="text-err" /> deny
              </span>
              <span>click to cycle · nothing selected = inherit everything</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_TOOL_CHOICES.map((tool) => {
              const state = toolState(tool);
              return (
                <button
                  key={tool}
                  onClick={() => cycleTool(tool)}
                  className={cn(
                    "cursor-pointer rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors",
                    state === "allow" && "border-accent/50 bg-accent/10 text-accent",
                    state === "deny" && "border-err/50 bg-err/10 text-err line-through",
                    state === "inherit" && "border-edge text-ink-faint hover:text-ink-muted",
                  )}
                >
                  {tool.replace("mcp__station__", "station: ")}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <Label>Custom workspace view (optional)</Label>
          <Input
            className="font-mono text-xs"
            value={draft.viewPath ?? ""}
            onChange={(e) => patch({ viewPath: e.target.value || null })}
            placeholder="agent-views/my-agent.html — relative to the data dir"
          />
          <p className="mt-1 text-[10.5px] text-ink-faint">
            Point this at your own .html and the agent's tab renders it instead of the chat view.
            Leave empty for the default.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>App UI URL (optional)</Label>
            <Input
              className="font-mono text-xs"
              value={draft.viewUrl ?? ""}
              onChange={(e) => patch({ viewUrl: e.target.value || null })}
              placeholder="http://127.0.0.1:4747/?token=…"
            />
            <p className="mt-1 text-[10.5px] text-ink-faint">
              For app agents: the running app's own web UI, embedded in the workspace tab.
            </p>
          </div>
          <div>
            <Label>Start command (optional)</Label>
            <Input
              className="font-mono text-xs"
              value={draft.startCommand ?? ""}
              onChange={(e) => patch({ startCommand: e.target.value || null })}
              placeholder="./start.sh"
            />
            <p className="mt-1 text-[10.5px] text-ink-faint">
              Runs in a Station terminal at the agent's bundle folder when you press Start.
            </p>
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-hairline bg-white/4 px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabledGlobally}
            onChange={(e) => patch({ enabledGlobally: e.target.checked })}
            className="mt-0.5 accent-(--color-accent)"
          />
          <span>
            Available in every project
            <span className="block text-[10.5px] text-ink-faint">
              Leave off to pick projects individually on this page or in the project's Agents tab.
            </span>
          </span>
        </label>

        {error && <p className="text-xs text-err">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              !draft.name.trim() || !draft.description.trim() || !draft.prompt.trim() || save.isPending
            }
            onClick={submit}
          >
            {save.isPending ? "Saving…" : agent ? "Save changes" : "Create agent"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
