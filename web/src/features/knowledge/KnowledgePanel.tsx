import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, FileText, FolderInput, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { fileUrl, uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { KNOWLEDGE_FOLDER_SUGGESTIONS } from "@claude-station/shared";

export interface KnowledgeRow {
  id: string;
  projectId: string | null;
  kind: "doc" | "excel" | "skill";
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
  const folderOptions = [...new Set([...folders.map((f) => f.folder), ...KNOWLEDGE_FOLDER_SUGGESTIONS])]
    .filter(Boolean)
    .sort();

  return (
    <div className="space-y-3">
      {!projectId && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setFolder("")}
            className={cn(
              "cursor-pointer rounded-pill border px-2.5 py-1 text-xs transition-colors",
              folder === ""
                ? "border-accent/40 bg-accent/12 text-accent"
                : "border-hairline text-ink-muted hover:text-ink",
            )}
          >
            all · {rows.length}
          </button>
          {folders.map((f) => (
            <button
              key={f.folder}
              onClick={() => setFolder(f.folder)}
              className={cn(
                "cursor-pointer rounded-pill border px-2.5 py-1 text-xs transition-colors",
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
          for (const file of Array.from(e.dataTransfer.files)) upload.mutate({ file });
        }}
        className={`rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
          dragging ? "border-accent bg-accent/5" : "border-edge"
        }`}
      >
        <Upload size={20} className="mx-auto mb-2 text-ink-faint" />
        <p className="text-sm text-ink-muted">
          Drop docs or spreadsheets here — Claude gets them as read-only context.
        </p>
        <p className="mb-3 text-[11px] text-ink-faint">
          .xlsx is also flattened to CSV per sheet so Claude can read it reliably.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {!projectId && (
            <select
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className="h-7 px-2 text-xs"
              title="Folder for the next import"
            >
              <option value="">unfiled</option>
              {folderOptions.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
            <Upload size={13} /> {upload.isPending ? "Uploading…" : "Choose file"}
          </Button>
          {!projectId && (
            <Button size="sm" variant="ghost" onClick={() => skillRef.current?.click()}>
              <Sparkles size={13} /> Import skill (SKILL.md)
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
      </div>

      {error && <p className="text-xs text-err">{error}</p>}

      {visible.length === 0 && (
        <Card className="py-8 text-center text-sm text-ink-muted">Nothing imported yet.</Card>
      )}

      {visible.map((row) => {
        const Icon = ICONS[row.kind];
        return (
          <Card key={row.id} className="flex items-start gap-3 p-3">
            <Icon size={15} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-medium">{row.originalFilename}</span>
                <Badge>{row.kind}</Badge>
                {row.linkState && (
                  <Badge tone={row.linkState === "linked" ? "ok" : "err"}>{row.linkState}</Badge>
                )}
                {row.attached && <Badge tone="accent">library</Badge>}
                {row.folder && <Badge>{row.folder}</Badge>}
                {!row.exists && <Badge tone="err">missing on disk</Badge>}
                <span className="text-[10.5px] text-ink-faint">{humanSize(row.sizeBytes)}</span>
              </div>
              {row.description && (
                <p className="mt-0.5 text-xs text-ink-muted">{row.description}</p>
              )}
              {sheets?.id === row.id && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {sheets.names.map((name) => (
                    <a
                      key={name}
                      href={fileUrl(`/api/knowledge/${row.id}/file?sheet=${encodeURIComponent(name)}`)}
                      className="rounded-md bg-white/8 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted hover:text-ink"
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
              <select
                value={row.folder}
                onChange={(e) => move.mutate({ id: row.id, to: e.target.value })}
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
            )}
            <a
              href={fileUrl(`/api/knowledge/${row.id}/file`)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
              title="Download"
            >
              <Download size={14} />
            </a>
            {row.attached ? (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => detach.mutate(row.id)}
                title="Detach from this project (keeps the library copy)"
                aria-label="Detach"
              >
                <FolderInput size={14} />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => remove.mutate(row.id)}
                aria-label="Delete"
              >
                <Trash2 size={14} />
              </Button>
            )}
          </Card>
        );
      })}
    </div>
  );
}
