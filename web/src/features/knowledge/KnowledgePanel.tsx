import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderInput,
  FolderUp,
  Sparkles,
  Trash2,
  Upload,
} from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import {
  collectDropped,
  directoryInputProps,
  filesFromDirectoryInput,
  uploadFiles,
  type PickedFile,
} from "@/lib/folder-upload";
import { fileUrl, uploadFile } from "@/lib/upload";
import { FilterChip } from "@/components/ui/chip";
import { KNOWLEDGE_FOLDER_SUGGESTIONS } from "@claude-station/shared";

export interface KnowledgeRow {
  id: string;
  projectId: string | null;
  kind: "doc" | "excel" | "skill" | "folder";
  name: string;
  description: string;
  folder: string;
  originalFilename: string;
  storedPath: string;
  parsedPath: string | null;
  sizeBytes: number;
  createdAt: string;
  exists: boolean;
  linkState?: "linked" | "unlinked" | "conflict";
  /** Set on the project view: true = attached from the library, not owned. */
  attached?: boolean;
}

const ICONS = {
  doc: FileText,
  excel: FileSpreadsheet,
  skill: Sparkles,
  folder: Folder,
} as const;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  /** Undefined = global store (the Knowledge page); set = project store. */
  projectId?: string;
}

export function KnowledgePanel({ projectId }: Props) {
  const qc = useQueryClient();
  const queryKey = ["knowledge", projectId ?? "global"];
  const fileRef = useRef<HTMLInputElement | null>(null);
  const skillRef = useRef<HTMLInputElement | null>(null);
  const dirRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<{ id: string; names: string[] } | null>(null);
  // Library view only: which folder is being browsed / uploaded into.
  const [folder, setFolder] = useState<string>("");

  const { data: rows = [] } = useQuery({
    queryKey,
    queryFn: () =>
      api.get<KnowledgeRow[]>(
        projectId ? `/api/knowledge?projectId=${projectId}` : "/api/knowledge",
      ),
  });

  const { data: folders = [] } = useQuery({
    queryKey: ["knowledge-folders"],
    queryFn: () => api.get<{ folder: string; count: number }[]>("/api/knowledge/folders"),
    enabled: !projectId,
  });

  const upload = useMutation({
    mutationFn: async ({ file }: { file: File }) => {
      const params = new URLSearchParams();
      if (projectId) params.set("projectId", projectId);
      else if (folder) params.set("folder", folder);
      const suffix = params.toString() ? `?${params}` : "";
      return uploadFile<KnowledgeRow>(`/api/knowledge${suffix}`, file);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["knowledge-folders"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const uploadFolder = useMutation({
    mutationFn: async (files: PickedFile[]) => {
      const params = new URLSearchParams();
      if (projectId) params.set("projectId", projectId);
      else if (folder) params.set("folder", folder);
      const suffix = params.toString() ? `?${params}` : "";
      return uploadFiles<KnowledgeRow>(`/api/knowledge/folder${suffix}`, files);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["knowledge-folders"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const uploadSkill = useMutation({
    mutationFn: (file: File) =>
      uploadFile<KnowledgeRow>(
        `/api/knowledge/skills/import${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`,
        file,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["knowledge-folders"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/knowledge/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["knowledge-folders"] });
    },
  });

  const detach = useMutation({
    mutationFn: (id: string) => api.delete(`/api/projects/${projectId}/knowledge/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  const move = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api.put(`/api/knowledge/${id}/folder`, { folder: to }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["knowledge-folders"] });
    },
  });

  const showSheets = async (row: KnowledgeRow) => {
    const meta = await api.get<{ sheets: { name: string }[] }>(`/api/knowledge/${row.id}/sheets`);
    setSheets({ id: row.id, names: meta.sheets.map((s) => s.name) });
  };

  const visible = projectId ? rows : rows.filter((r) => !folder || r.folder === folder);
  const folderOptions = [
    ...new Set([...folders.map((f) => f.folder), ...KNOWLEDGE_FOLDER_SUGGESTIONS]),
  ]
    .filter(Boolean)
    .sort();

  return (
    <div className="space-y-3">
      {!projectId && (
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip onClick={() => setFolder("")} selected={folder === ""}>
            all · {rows.length}
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

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          setError(null);
          // Folders go to the folder endpoint as one item; files keep the old path.
          void collectDropped(e.dataTransfer.items).then(({ folders, looseFiles }) => {
            for (const dropped of folders) {
              if (dropped.files.length === 0) continue;
              uploadFolder.mutate(dropped.files);
            }
            for (const file of looseFiles) upload.mutate({ file });
          });
        }}
        className={`rounded-xl border border-dashed px-4 py-8 text-center transition-[background-color,border-color] duration-200 ease-emphasized ${
          dragging ? "border-primary bg-primary/8" : "border-outline/60"
        }`}
      >
        <div className="mx-auto mb-3 grid size-12 place-items-center rounded-lg bg-secondary-container text-on-secondary-container">
          <Upload size={24} fill={1} />
        </div>
        <p className="m3-body-md text-ink-muted">
          Drop docs, spreadsheets or whole folders here — Claude gets them as read-only context.
        </p>
        <p className="mb-3 m3-label-sm text-ink-faint">
          .xlsx is also flattened to CSV per sheet so Claude can read it reliably.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {!projectId && (
            <Select
              value={folder}
              onChange={setFolder}
              title="Folder for the next import"
              options={[
                { value: "", label: "unfiled" },
                ...folderOptions.map((f) => ({ value: f, label: f })),
              ]}
            />
          )}
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
            <Upload size={16} /> {upload.isPending ? "Uploading…" : "Choose file"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dirRef.current?.click()}
            disabled={uploadFolder.isPending}
          >
            <FolderUp size={16} /> {uploadFolder.isPending ? "Importing…" : "Import folder"}
          </Button>
          {!projectId && (
            <Button size="sm" variant="ghost" onClick={() => skillRef.current?.click()}>
              <Sparkles size={16} /> Import skill (SKILL.md)
            </Button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate({ file });
            e.target.value = "";
          }}
        />
        <input
          ref={skillRef}
          type="file"
          accept=".md"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) uploadSkill.mutate(file);
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
              if (files.length) uploadFolder.mutate(files);
            }
            e.target.value = "";
          }}
        />
      </div>

      {error && <p className="m3-body-sm text-err">{error}</p>}

      {visible.length === 0 && (
        <Card className="m3-body-md py-10 text-center text-ink-muted">Nothing imported yet.</Card>
      )}

      {visible.map((row) => {
        const Icon = ICONS[row.kind];
        return (
          <Card key={row.id} className="flex items-start gap-3 p-3.5">
            <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-primary-container/45 text-on-primary-container">
              <Icon size={18} fill={1} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="m3-title-sm truncate">{row.originalFilename}</span>
                <Badge>{row.kind}</Badge>
                {row.linkState && (
                  <Badge tone={row.linkState === "linked" ? "ok" : "err"}>{row.linkState}</Badge>
                )}
                {row.attached && <Badge tone="accent">library</Badge>}
                {row.folder && <Badge>{row.folder}</Badge>}
                {!row.exists && <Badge tone="err">missing on disk</Badge>}
                <span className="m3-label-sm text-ink-faint">{humanSize(row.sizeBytes)}</span>
              </div>
              {row.description && (
                <p className="m3-body-sm mt-1 text-ink-muted">{row.description}</p>
              )}
              {sheets?.id === row.id && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {sheets.names.map((name) => (
                    <a
                      key={name}
                      href={fileUrl(
                        `/api/knowledge/${row.id}/file?sheet=${encodeURIComponent(name)}`,
                      )}
                      className="m3-label-sm rounded-pill bg-white/8 px-2.5 py-1 font-mono text-ink-muted transition-colors duration-150 hover:text-ink"
                    >
                      {name}.csv
                    </a>
                  ))}
                </div>
              )}
            </div>
            {row.kind === "excel" && (
              <Button size="sm" variant="ghost" onClick={() => void showSheets(row)}>
                Sheets
              </Button>
            )}
            {!projectId && (
              <Select
                value={row.folder}
                onChange={(v) => move.mutate({ id: row.id, to: v })}
                title="Move to folder"
                options={[
                  { value: "", label: "unfiled" },
                  ...folderOptions.map((f) => ({ value: f, label: f })),
                ]}
              />
            )}
            <a
              href={fileUrl(`/api/knowledge/${row.id}/file`)}
              download
              className="state-layer inline-flex size-9 items-center justify-center rounded-pill text-ink-muted transition-colors duration-200 ease-emphasized hover:text-ink"
              title={
                row.kind === "folder" || row.kind === "skill" ? "Download as .zip" : "Download"
              }
            >
              <Download size={16} />
            </a>
            {row.attached ? (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => detach.mutate(row.id)}
                title="Detach from this project (keeps the library copy)"
                aria-label="Detach"
              >
                <FolderInput size={16} />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => remove.mutate(row.id)}
                aria-label="Delete"
              >
                <Trash2 size={16} />
              </Button>
            )}
          </Card>
        );
      })}
    </div>
  );
}
