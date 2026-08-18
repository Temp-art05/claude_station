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
} from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import {
  KNOWLEDGE_FOLDER_SUGGESTIONS,
  WORKFLOW_PRESETS,
  type FolderImportResult,
  type Workflow,
  type WorkflowInput,
} from "@claude-station/shared";
import { Button, IconButton } from "@/components/ui/button";
import { FilterChip } from "@/components/ui/chip";
import { Badge, Card } from "@/components/ui/card";
import {
  directoryInputProps,
  filesFromDirectoryInput,
  uploadFiles,
  type PickedFile,
} from "@/lib/folder-upload";
import { globalKey, useUiState } from "@/lib/uiStore";
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
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: workflows = [] } = useWorkflows();
  const { data: folders = [] } = useWorkflowFolders();
  const del = useDeleteWorkflow();
  const move = useMoveWorkflow();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dirRef = useRef<HTMLInputElement | null>(null);

  // Validated on read: a folder can vanish when its last workflow moves out.
  const [storedFolder, setFolder] = useUiState(globalKey("workflows", "folder"), "");
  const folder = folders.some((f) => f.folder === storedFolder) ? storedFolder : "";
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
  const missingPresets = WORKFLOW_PRESETS.filter((p) => !workflows.some((w) => w.name === p.name));

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <PageHeader
        title="Workflows"
        icon={WorkflowIcon}
        supporting="The sequence you repeat for a kind of work: read docs → plan → confirm → implement → test. Each step is an agent, a project command, or a stop for your decision."
        actions={
          <>
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              <Upload size={18} /> Import .yaml
            </Button>
            <Button
              variant="ghost"
              onClick={() => dirRef.current?.click()}
              disabled={importFolder.isPending}
              title="Import every .yaml/.yml/.json in a folder — one workflow each"
            >
              <FolderUp size={18} /> {importFolder.isPending ? "Importing…" : "Import folder"}
            </Button>
            <Button
              variant="primary"
              onClick={() => setCreating({ name: "", description: "", folder, steps: [] })}
            >
              <Plus size={18} /> New workflow
            </Button>
          </>
        }
      />
      <div className="hidden">
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
        <Card className="mb-3 p-3.5">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="m3-title-sm">
              Folder import — {importResults.filter((r) => r.status === "imported").length}{" "}
              imported, {importResults.filter((r) => r.status === "renamed").length} renamed,{" "}
              {importResults.filter((r) => r.status === "error").length} failed,{" "}
              {importResults.filter((r) => r.status === "skipped").length} skipped
            </p>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setImportResults(null)}
              aria-label="Dismiss"
            >
              <X size={16} />
            </Button>
          </div>
          <div className="space-y-0.5">
            {importResults
              .filter((r) => r.status !== "skipped")
              .map((r) => (
                <p key={r.file} className="font-mono m3-label-sm text-ink-muted">
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
          <FilterChip onClick={() => setFolder("")} selected={folder === ""}>
            all · {workflows.length}
          </FilterChip>
          {folders.map((f) => (
            <FilterChip
              key={f.folder}
              onClick={() => setFolder(f.folder)}
              selected={folder === f.folder}
            >
              {f.folder || "unfiled"} · {f.count}
            </FilterChip>
          ))}
        </div>
      )}

      {error && <p className="m3-body-sm mb-3 text-err">{error}</p>}

      {visible.length === 0 && (
        <EmptyState icon={WorkflowIcon} title="No workflows here">
          Start from a preset below, or build one step by step.
        </EmptyState>
      )}

      <div className="space-y-2">
        {visible.map((w) => (
          <Card key={w.id} className="flex items-start gap-3 p-3.5">
            {/* Leading glyph in its own tonal container — the M3 list-item shape. */}
            <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-primary-container/45 text-on-primary-container">
              <WorkflowIcon size={18} fill={1} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="m3-title-sm font-mono">{w.name}</span>
                <Badge>{w.steps.length} steps</Badge>
                {w.source === "imported" && <Badge>imported</Badge>}
              </div>
              {w.description && <p className="m3-body-sm mt-1 text-ink-muted">{w.description}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {w.steps.map((s) => (
                  <span
                    key={s.key}
                    title={`${s.type}${s.agentName ? ` · ${s.agentName}` : ""}${
                      s.permissionMode ? ` · ${s.permissionMode}` : ""
                    }${s.condition ? ` · if ${s.condition}` : ""}`}
                    className={cn(
                      "m3-label-sm rounded-pill px-2.5 py-1 font-mono font-semibold",
                      s.type === "agent"
                        ? "bg-primary/16 text-primary"
                        : s.type === "command"
                          ? "bg-white/8 text-ink-muted"
                          : "bg-warn/16 text-warn",
                    )}
                  >
                    {s.key}
                  </span>
                ))}
              </div>
            </div>
            <Select
              value={w.folder}
              onChange={(v) => move.mutate({ id: w.id, folder: v })}
              title="Move to folder"
              options={[
                { value: "", label: "unfiled" },
                ...folderOptions.map((f) => ({ value: f, label: f })),
              ]}
            />
            <a
              href={fileUrl(`/api/workflows/${w.id}/export`)}
              download
              className="state-layer inline-flex size-9 items-center justify-center rounded-pill text-ink-muted transition-colors duration-200 ease-emphasized hover:text-ink"
              title="Export as .workflow.yaml"
            >
              <Download size={18} />
            </a>
            <IconButton dense onClick={() => setEditing(w)} aria-label="Edit" title="Edit workflow">
              <Pencil size={18} />
            </IconButton>
            <IconButton
              dense
              onClick={() => {
                void confirm({
                  title: `Delete workflow "${w.name}"?`,
                  confirmLabel: "Delete",
                  tone: "danger",
                }).then((ok) => ok && del.mutate(w.id));
              }}
              aria-label="Delete"
              title="Delete workflow"
              className="hover:text-err"
            >
              <Trash2 size={18} />
            </IconButton>
          </Card>
        ))}
      </div>

      {missingPresets.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-hairline pt-5">
          <span className="m3-label-md text-ink-faint">Add from preset:</span>
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
