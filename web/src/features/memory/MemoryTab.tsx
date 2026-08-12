import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Download, Pin, PinOff, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import type { ProjectMemory, ProjectMemoryInput } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DraftNotice } from "@/components/DraftNotice";
import { api } from "@/lib/api";
import { projectKey, useRestorableDraft, useUiState } from "@/lib/uiStore";
import { fileUrl, uploadFile } from "@/lib/upload";

const SOURCE_LABEL: Record<ProjectMemory["source"], string> = {
  manual: "you",
  imported: "imported",
  claude: "claude",
};

/**
 * Durable notes that ride along with every session in this project. Pinned ones
 * go into the prompt in full; the rest are titles Claude can pull on demand,
 * so a big memory bank doesn't eat the context window.
 */
export function MemoryTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ["memory", projectId];
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Stored as an id, not the record: a memory saved here last week would come
  // back stale and quietly overwrite whatever the server has now.
  const [editingId, setEditingId] = useUiState<string | null>(
    projectKey(projectId, "memory", "editing"),
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const { data: memories = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<ProjectMemory[]>(`/api/projects/${projectId}/memory`),
  });

  // Resolved against the live list, so an id whose memory was deleted while we
  // were on another tab just closes the editor instead of opening it on nothing.
  const editing: ProjectMemory | "new" | null =
    editingId === "new" ? "new" : (memories.find((m) => m.id === editingId) ?? null);
  const setEditing = (next: ProjectMemory | "new" | null) =>
    setEditingId(next === null ? null : next === "new" ? "new" : next.id);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["memory"] });

  const importFile = useMutation({
    mutationFn: (file: File) =>
      uploadFile<ProjectMemory>(`/api/projects/${projectId}/memory/import`, file),
    onSuccess: invalidate,
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });
  const togglePin = useMutation({
    mutationFn: (m: ProjectMemory) => api.patch(`/api/memory/${m.id}`, { pinned: !m.pinned }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/memory/${id}`),
    onSuccess: invalidate,
  });

  const pinnedCount = memories.filter((m) => m.pinned).length;

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-ink-muted">
            Context that isn't in the code: conventions, decisions, gotchas. Claude reads pinned
            notes every session and can save new ones itself.
          </p>
          {memories.length > 0 && (
            <p className="mt-1 text-[11px] text-ink-faint">
              {pinnedCount} pinned · {memories.length - pinnedCount} on demand
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Import .md
          </Button>
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus size={15} /> New memory
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt"
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
      </div>

      {error && <p className="mb-3 text-xs text-err">{error}</p>}

      {memories.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <Brain size={26} className="text-ink-faint" />
          <p className="text-sm font-medium">No memory yet</p>
          <p className="max-w-md text-xs text-ink-muted">
            Good first notes: which module owns what, why an odd workaround exists, the release
            checklist, naming conventions Claude keeps getting wrong.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {memories.map((m) => (
            <Card key={m.id} className="p-3">
              <div className="flex items-start gap-3">
                <button
                  onClick={() => togglePin.mutate(m)}
                  title={m.pinned ? "Unpin (fetched on demand)" : "Pin (always in context)"}
                  className={`mt-0.5 cursor-pointer transition-colors ${
                    m.pinned ? "text-accent" : "text-ink-faint hover:text-ink-muted"
                  }`}
                >
                  {m.pinned ? <Pin size={14} /> : <PinOff size={14} />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold">{m.title}</span>
                    {m.pinned && <Badge tone="accent">pinned</Badge>}
                    {m.source === "claude" && (
                      <Badge>
                        <Sparkles size={9} className="mr-1" />
                        {SOURCE_LABEL[m.source]}
                      </Badge>
                    )}
                    {m.tags?.map((t) => <Badge key={t}>{t}</Badge>)}
                  </div>
                  <p className="mt-1 line-clamp-3 text-xs whitespace-pre-wrap text-ink-muted">
                    {m.body}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <a
                    href={fileUrl(`/api/memory/${m.id}/export`)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-pill text-ink-muted hover:bg-white/6 hover:text-ink"
                    title="Export as .md"
                  >
                    <Download size={14} />
                  </a>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                    Edit
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Delete memory "${m.title}"?`)) remove.mutate(m.id);
                    }}
                    aria-label="Delete memory"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <MemoryEditor
          key={editing === "new" ? "new" : editing.id}
          projectId={projectId}
          memory={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function MemoryEditor({
  projectId,
  memory,
  onClose,
}: {
  projectId: string;
  memory?: ProjectMemory;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const {
    value: draft,
    set: setDraft,
    restored,
    discard,
    clear: clearDraft,
  } = useRestorableDraft<ProjectMemoryInput>(
    projectKey(projectId, "memoryEditor", memory?.id ?? "new"),
    {
      title: memory?.title ?? "",
      body: memory?.body ?? "",
      tags: memory?.tags ?? null,
      pinned: memory?.pinned ?? false,
    },
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: ProjectMemoryInput) =>
      memory
        ? api.patch(`/api/memory/${memory.id}`, input)
        : api.post(`/api/projects/${projectId}/memory`, input),
    onSuccess: () => {
      clearDraft(); // saved — nothing left unsaved to restore
      void qc.invalidateQueries({ queryKey: ["memory"] });
      onClose();
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "Failed"),
  });

  return (
    <Dialog open onClose={onClose} title={memory ? "Edit memory" : "New memory"} className="max-w-2xl">
      <div className="space-y-3">
        {restored && <DraftNotice onDiscard={discard} />}
        <div>
          <Label>Title</Label>
          <Input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Release checklist"
            autoFocus
          />
        </div>
        <div>
          <Label>Note</Label>
          <Textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder="Bump the version in both Info.plist and build.gradle before tagging…"
            className="min-h-[160px]"
          />
        </div>
        <div>
          <Label>Tags (comma separated)</Label>
          <Input
            value={draft.tags?.join(", ") ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                tags:
                  e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean) || null,
              })
            }
            placeholder="ios, release"
          />
        </div>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-hairline bg-white/4 px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={draft.pinned}
            onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            Pin to every session
            <span className="block text-[10.5px] text-ink-faint">
              Pinned notes go into the prompt in full. Leave off and Claude fetches it by title when
              relevant.
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
            disabled={!draft.title.trim() || !draft.body.trim() || save.isPending}
            onClick={() => save.mutate(draft)}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
