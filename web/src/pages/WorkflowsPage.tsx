import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  FolderUp,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import {
  KNOWLEDGE_FOLDER_SUGGESTIONS,
  WORKFLOW_PRESETS,
  type FolderImportResult,
  type Workflow,
  type WorkflowInput,
} from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import {
  directoryInputProps,
  filesFromDirectoryInput,
  uploadFiles,
  type PickedFile,
} from "@/lib/folder-upload";
import { fileUrl, uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { WorkflowEditor } from "@/features/workflows/WorkflowEditor";
import {
  useDeleteWorkflow,
  useMoveWorkflow,
  useWorkflowFolders,
  useWorkflows,
} from "@/features/workflows/hooks";

export function WorkflowsPage() {
  const qc = useQueryClient();
  const { data: workflows = [] } = useWorkflows();
  const { data: folders = [] } = useWorkflowFolders();
  const del = useDeleteWorkflow();
  const move = useMoveWorkflow();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dirRef = useRef<HTMLInputElement | null>(null);

  const [folder, setFolder] = useState<string>("");
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [creating, setCreating] = useState<WorkflowInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importResults, setImportResults] = useState<FolderImportResult[] | null>(null);

  const importFile = useMutation({
    mutationFn: (file: File) => uploadFile<Workflow>("/api/workflows/import", file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflows"] });
      void qc.invalidateQueries({ queryKey: ["workflow-folders"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const importFolder = useMutation({
    mutationFn: (files: PickedFile[]) =>
      uploadFiles<{ results: FolderImportResult[] }>("/api/workflows/import-folder", files),
    onSuccess: (data) => {
      setImportResults(data.results);
      void qc.invalidateQueries({ queryKey: ["workflows"] });
      void qc.invalidateQueries({ queryKey: ["workflow-folders"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const visible = workflows.filter((w) => !folder || w.folder === folder);
  const folderOptions = [
    ...new Set([...folders.map((f) => f.folder), ...KNOWLEDGE_FOLDER_SUGGESTIONS]),
  ]
    .filter(Boolean)
    .sort();
  const missingPresets = WORKFLOW_PRESETS.filter(
    (p) => !workflows.some((w) => w.name === p.name),
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Workflows</h1>
          <p className="text-sm text-ink-muted">
            The sequence you repeat for a kind of work: read docs → plan → confirm → implement →
            test. Each step is an agent, a project command, or a stop for your decision.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Import .yaml
          </Button>
          <Button
            variant="ghost"
            onClick={() => dirRef.current?.click()}
            disabled={importFolder.isPending}
            title="Import every .yaml/.yml/.json in a folder — one workflow each"
          >
            <FolderUp size={14} /> {importFolder.isPending ? "Importing…" : "Import folder"}
          </Button>
          <Button
            variant="primary"
            onClick={() => setCreating({ name: "", description: "", folder, steps: [] })}
          >
            <Plus size={15} /> New workflow
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".yaml,.yml,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              setError(null);
              importFile.mutate(file);
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
              setImportResults(null);
              const files = filesFromDirectoryInput(e.target.files);
              if (files.length) importFolder.mutate(files);
            }
            e.target.value = "";
          }}
        />
      </div>

      {importResults && (
        <Card className="mb-3 p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium">
              Folder import — {importResults.filter((r) => r.status === "imported").length}{" "}
              imported, {importResults.filter((r) => r.status === "renamed").length} renamed,{" "}
              {importResults.filter((r) => r.status === "error").length} failed,{" "}
              {importResults.filter((r) => r.status === "skipped").length} skipped
            </p>
            <Button size="icon" variant="ghost" onClick={() => setImportResults(null)} aria-label="Dismiss">
              <X size={13} />
            </Button>
          </div>
          <div className="space-y-0.5">
            {importResults
              .filter((r) => r.status !== "skipped")
              .map((r) => (
                <p key={r.file} className="font-mono text-[11px] text-ink-muted">
                  {r.file}
                  {r.status === "imported" && ` → ${r.name}`}
                  {r.status === "renamed" && ` → renamed to ${r.name}`}
                  {r.status === "error" && <span className="text-err"> — {r.error}</span>}
                </p>
              ))}
          </div>
        </Card>
      )}

      {folders.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <button
            onClick={() => setFolder("")}
            className={cn(
              "cursor-pointer rounded-pill border px-2.5 py-1 text-xs",
              folder === ""
                ? "border-accent/40 bg-accent/12 text-accent"
                : "border-hairline text-ink-muted hover:text-ink",
            )}
          >
            all · {workflows.length}
          </button>
          {folders.map((f) => (
            <button
              key={f.folder}
              onClick={() => setFolder(f.folder)}
              className={cn(
                "cursor-pointer rounded-pill border px-2.5 py-1 text-xs",
                folder === f.folder
                  ? "border-accent/40 bg-accent/12 text-accent"
                  : "border-hairline text-ink-muted hover:text-ink",
              )}
            >
              {f.folder || "unfiled"} · {f.count}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mb-3 text-xs text-err">{error}</p>}

      {visible.length === 0 && (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <WorkflowIcon size={26} className="text-ink-faint" />
          <p className="text-sm font-medium">No workflows here</p>
          <p className="max-w-md text-xs text-ink-muted">
            Start from a preset below, or build one step by step.
          </p>
        </Card>
      )}

      <div className="space-y-2">
        {visible.map((w) => (
          <Card key={w.id} className="flex items-start gap-3 p-3">
            <WorkflowIcon size={15} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-sm">{w.name}</span>
                <Badge>{w.steps.length} steps</Badge>
                {w.source === "imported" && <Badge>imported</Badge>}
              </div>
              {w.description && <p className="mt-0.5 text-xs text-ink-muted">{w.description}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {w.steps.map((s) => (
                  <span
                    key={s.key}
                    title={`${s.type}${s.agentName ? ` · ${s.agentName}` : ""}${
                      s.permissionMode ? ` · ${s.permissionMode}` : ""
                    }${s.condition ? ` · if ${s.condition}` : ""}`}
                    className={cn(
                      "rounded-pill border px-1.5 py-0.5 font-mono text-[10px]",
                      s.type === "agent"
                        ? "border-accent/30 bg-accent/10 text-accent"
                        : s.type === "command"
                          ? "border-hairline bg-white/6 text-ink-muted"
                          : "border-warn/30 bg-warn/10 text-warn",
                    )}
                  >
                    {s.key}
                  </span>
                ))}
              </div>
            </div>
            <select
              value={w.folder}
              onChange={(e) => move.mutate({ id: w.id, folder: e.target.value })}
              className="h-8 px-2 text-[11px]"
              title="Move to folder"
            >
              <option value="">unfiled</option>
              {folderOptions.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <a
              href={fileUrl(`/api/workflows/${w.id}/export`)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-pill text-ink-muted hover:bg-white/6 hover:text-ink"
              title="Export as .workflow.yaml"
            >
              <Download size={14} />
            </a>
            <Button size="icon" variant="ghost" onClick={() => setEditing(w)} aria-label="Edit">
              <Pencil size={14} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                if (confirm(`Delete workflow "${w.name}"?`)) del.mutate(w.id);
              }}
              aria-label="Delete"
            >
              <Trash2 size={14} />
            </Button>
          </Card>
        ))}
      </div>

      {missingPresets.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
          <span className="text-xs text-ink-faint">Add from preset:</span>
          {missingPresets.map(({ label, ...preset }) => (
            <Button key={label} size="sm" variant="ghost" onClick={() => setCreating(preset)}>
              {label}
            </Button>
          ))}
        </div>
      )}

      {(editing || creating) && (
        <WorkflowEditor
          key={editing?.id ?? creating?.name ?? "new"}
          workflow={editing ?? undefined}
          preset={creating?.steps.length ? creating : undefined}
          onClose={() => {
            setEditing(null);
            setCreating(null);
          }}
        />
      )}
    </div>
  );
}
