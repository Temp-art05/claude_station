import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, FolderUp, Plus, Upload } from "@/components/ui/icons";
import { AGENT_PRESETS, type Agent, type AgentInput } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  directoryInputProps,
  filesFromDirectoryInput,
  uploadFiles,
  type PickedFile,
} from "@/lib/folder-upload";
import { uploadFile } from "@/lib/upload";
import { AgentEditor } from "@/features/agents/AgentEditor";
import { AgentList } from "@/features/agents/AgentList";
import { useAgents } from "@/features/agents/hooks";

export function AgentsPage() {
  const qc = useQueryClient();
  const { data: agents = [] } = useAgents();
  const [creating, setCreating] = useState<AgentInput | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dirRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const importAgent = useMutation({
    mutationFn: (file: File) => uploadFile<Agent>("/api/agents/import", file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const importAgentFolder = useMutation({
    mutationFn: (files: PickedFile[]) => uploadFiles<Agent>("/api/agents/import-folder", files),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <PageHeader
        title="Agents"
        icon={Bot}
        supporting="Scoped helpers the main session delegates to. Each one gets its own prompt, tool allowlist and model — so a build fixer can run gradle without ever touching Jira."
        actions={
          <>
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              <Upload size={18} /> Import .md
            </Button>
            <Button
              variant="ghost"
              onClick={() => dirRef.current?.click()}
              disabled={importAgentFolder.isPending}
              title="A folder with one agent .md plus companion files the agent can read"
            >
              <FolderUp size={18} /> {importAgentFolder.isPending ? "Importing…" : "Import folder"}
            </Button>
            <Button variant="primary" onClick={() => setCreating({} as AgentInput)}>
              <Plus size={18} /> New agent
            </Button>
          </>
        }
      />
      <div className="hidden">
        <input
          ref={fileRef}
          type="file"
          accept=".md"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              setError(null);
              importAgent.mutate(file);
            }
            e.target.value = "";
          }}
        />
        <input
          ref={dirRef}
          type="file"
          className="hidden"
          {...directoryInputProps}
          onChange={(e) => {
            if (e.target.files?.length) {
              setError(null);
              const files = filesFromDirectoryInput(e.target.files);
              if (files.length) importAgentFolder.mutate(files);
            }
            e.target.value = "";
          }}
        />
      </div>

      {error && <p className="mb-3 text-xs text-err">{error}</p>}

      {agents.length === 0 && (
        <Card className="mb-4">
          <p className="mb-2 text-sm font-medium">Start from a preset</p>
          <p className="mb-3 text-xs text-ink-muted">
            These are wired to this app's own tools — the build fixer can run your{" "}
            <code className="font-mono">xcodebuild</code> /{" "}
            <code className="font-mono">gradlew</code> commands and read the log.
          </p>
          <div className="flex flex-wrap gap-2">
            {AGENT_PRESETS.map(({ label, ...preset }) => (
              <Button key={label} size="sm" onClick={() => setCreating(preset)}>
                {label}
              </Button>
            ))}
          </div>
        </Card>
      )}

      <AgentList agents={agents} />

      {agents.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-4">
          <span className="text-xs text-ink-faint">Add from preset:</span>
          {AGENT_PRESETS.filter((p) => !agents.some((a) => a.name === p.name)).map(
            ({ label, ...preset }) => (
              <Button key={label} size="sm" variant="ghost" onClick={() => setCreating(preset)}>
                {label}
              </Button>
            ),
          )}
        </div>
      )}

      {creating && (
        <AgentEditor
          open
          preset={creating.name ? creating : undefined}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
}
