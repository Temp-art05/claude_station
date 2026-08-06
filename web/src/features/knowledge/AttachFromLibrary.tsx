import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FolderOpen, Library } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { KnowledgeRow } from "./KnowledgePanel";

/**
 * The point of folders: attach a whole stack of assets (all the Android skills,
 * say) to a project in one click instead of picking files one by one.
 */
export function AttachFromLibrary({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);

  const { data: folders = [] } = useQuery({
    queryKey: ["knowledge-folders"],
    queryFn: () => api.get<{ folder: string; count: number }[]>("/api/knowledge/folders"),
    enabled: open,
  });
  const { data: items = [] } = useQuery({
    queryKey: ["library", folder],
    queryFn: () =>
      api.get<KnowledgeRow[]>(
        folder === null ? "/api/knowledge" : `/api/knowledge?folder=${encodeURIComponent(folder)}`,
      ),
    enabled: open,
  });

  // What this project already has — drives the attached/detach state per row.
  // Same key as the project's KnowledgePanel, so the cache stays shared.
  const { data: projectItems = [] } = useQuery({
    queryKey: ["knowledge", projectId],
    queryFn: () => api.get<KnowledgeRow[]>(`/api/knowledge?projectId=${projectId}`),
    enabled: open,
  });
  const attachedIds = new Set(projectItems.filter((i) => i.attached).map((i) => i.id));

  // The dialog stays open on purpose: attaching is usually a batch action.
  const attach = useMutation({
    mutationFn: (body: { folder?: string; itemIds?: string[] }) =>
      api.post<{ attached: number }>(`/api/projects/${projectId}/knowledge/attach`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["knowledge"] }),
  });

  const detach = useMutation({
    mutationFn: (itemId: string) => api.delete(`/api/projects/${projectId}/knowledge/${itemId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["knowledge"] }),
  });

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Library size={14} /> Attach from library
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Attach library assets"
        className="max-w-2xl"
      >
        <div className="space-y-3">
          <p className="text-xs text-ink-muted">
            Assets stay in the library — attaching just makes them readable by this project's
            sessions.
          </p>

          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setFolder(null)}
              className={cn(
                "cursor-pointer rounded-pill border px-2.5 py-1 text-xs transition-colors",
                folder === null
                  ? "border-accent/40 bg-accent/12 text-accent"
                  : "border-hairline text-ink-muted hover:text-ink",
              )}
            >
              all
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

          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-hairline p-2">
            {items.length === 0 && (
              <p className="px-1 py-2 text-xs text-ink-faint">Nothing in the library here.</p>
            )}
            {items.map((item) => {
              const isAttached = attachedIds.has(item.id);
              return (
                <div key={item.id} className="flex items-center gap-2 rounded-md px-1.5 py-1">
                  <span className="min-w-0 flex-1 truncate text-xs">{item.originalFilename}</span>
                  <Badge>{item.kind}</Badge>
                  {item.folder && <Badge tone="accent">{item.folder}</Badge>}
                  {isAttached ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-ok hover:text-err"
                      onClick={() => detach.mutate(item.id)}
                      disabled={detach.isPending}
                      title="Attached — click to detach from this project"
                    >
                      <Check size={12} /> attached
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => attach.mutate({ itemIds: [item.id] })}
                      disabled={attach.isPending}
                    >
                      attach
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink-faint">
              {folder === null
                ? "Pick a folder to attach it whole."
                : `Attach every asset in "${folder || "unfiled"}".`}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button
                variant="primary"
                disabled={folder === null || attach.isPending}
                onClick={() => folder !== null && attach.mutate({ folder })}
              >
                <FolderOpen size={14} /> Attach folder
              </Button>
            </div>
          </div>
        </div>
      </Dialog>
    </>
  );
}
