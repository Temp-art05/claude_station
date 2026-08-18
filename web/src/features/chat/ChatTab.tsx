import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  GitBranch,
  MessageSquarePlus,
  Paperclip,
  Send,
  StopCircle,
  X,
} from "@/components/ui/icons";
import {
  PERMISSION_MODE_CHOICES,
  type ChatSession,
  type EnvSet,
  type PermissionMode,
  type Project,
} from "@claude-station/shared";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { MessageView } from "./MessageView";
import { PermissionPrompt } from "./PermissionPrompt";
import { useChatSocket } from "./useChatSocket";

interface Props {
  project: Project;
  envSets: EnvSet[];
  /** Set by an agent workspace: show only this session, hide the session list. */
  pinnedSessionId?: string;
}

interface Attachment {
  id: string;
  kind: string;
  originalFilename: string;
}

export function ChatTab({ project, envSets, pinnedSessionId }: Props) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  // "Work with Claude" arrives as ?session=…&seed=…; read it once at mount.
  const [selectedId, setActiveId] = useState<string | null>(() => params.get("session"));
  const [draft, setDraft] = useState(() => params.get("seed") ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pathId, setPathId] = useState(project.paths[0]?.id ?? "");
  const [envSetId, setEnvSetId] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [useWorktree, setUseWorktree] = useState(false);

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", project.id],
    queryFn: () => api.get<ChatSession[]>(`/api/projects/${project.id}/sessions`),
  });

  const createSession = useMutation({
    mutationFn: () =>
      api.post<ChatSession>(`/api/projects/${project.id}/sessions`, {
        cwdPathId: pathId || undefined,
        envSetId: envSetId || null,
        permissionMode: mode,
        useWorktree,
      }),
    onSuccess: (session) => {
      void qc.invalidateQueries({ queryKey: ["sessions", project.id] });
      setActiveId(session.id);
    },
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.patch(`/api/sessions/${id}`, { archived: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions", project.id] }),
  });

  const openSessions = sessions.filter((s) => !s.archived && s.kind === "chat");
  // Derived: falls back to the newest open session until one is picked.
  const activeId =
    pinnedSessionId ??
    (selectedId && (openSessions.some((s) => s.id === selectedId) || sessions.length === 0)
      ? selectedId
      : (selectedId ?? openSessions[0]?.id ?? null));

  const chat = useChatSocket(activeId);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Drop the seed out of the address bar once it's in the composer.
  useEffect(() => {
    if (!params.has("session") && !params.has("seed")) return;
    const next = new URLSearchParams(params);
    next.delete("session");
    next.delete("seed");
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [chat.entries.length, chat.streaming]);

  const submit = () => {
    const text = draft.trim();
    if (!text || chat.running) return;
    chat.send(
      text,
      attachments.map((a) => a.id),
    );
    setDraft("");
    setAttachments([]);
  };

  /** Screenshots and design mocks: paste or pick, uploaded before the turn. */
  const attach = async (file: File | Blob) => {
    if (!activeId) return;
    setUploadError(null);
    try {
      const row = await uploadFile<Attachment>(`/api/sessions/${activeId}/attachments`, file);
      setAttachments((prev) => [...prev, row]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {!pinnedSessionId && (
        <div className="w-64 shrink-0 overflow-y-auto border-r border-hairline p-3.5">
          <div className="mb-2 space-y-2">
            <Button
              size="sm"
              variant="primary"
              className="w-full"
              onClick={() => createSession.mutate()}
              disabled={createSession.isPending || project.paths.length === 0}
            >
              <MessageSquarePlus size={16} /> New session
            </Button>
            <Select
              className="w-full"
              value={pathId}
              onChange={setPathId}
              options={project.paths.map((p) => ({ value: p.id, label: p.label }))}
            />
            <Select
              className="w-full"
              value={envSetId}
              onChange={setEnvSetId}
              options={[
                { value: "", label: "No env set" },
                ...envSets.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
            <Select
              className="w-full"
              value={mode}
              onChange={(v) => setMode(v as PermissionMode)}
              options={PERMISSION_MODE_CHOICES.map((m) => ({ value: m, label: m }))}
            />
            <label className="flex cursor-pointer items-center gap-1.5 m3-label-sm text-ink-muted">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => setUseWorktree(e.target.checked)}
                className="accent-(--color-accent)"
              />
              own git worktree
            </label>
          </div>

          <div className="space-y-0.5">
            {openSessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={cn(
                  "state-layer m3-body-sm group flex w-full cursor-pointer items-center gap-2 rounded-pill px-3 py-2 text-left",
                  "transition-[background-color,color] duration-200 ease-emphasized",
                  activeId === s.id
                    ? "bg-secondary-container text-on-secondary-container"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    s.status === "running"
                      ? "bg-warn animate-status"
                      : s.status === "error"
                        ? "bg-err"
                        : "bg-ink-faint",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {s.worktreePath && <GitBranch size={16} className="shrink-0 text-primary" />}
                <Archive
                  size={16}
                  className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    archive.mutate(s.id);
                  }}
                />
              </button>
            ))}
            {openSessions.length === 0 && (
              <p className="m3-body-sm px-3 py-1.5 text-ink-faint">No sessions yet.</p>
            )}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {!activeId ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="m3-title-md">Start a session to talk to Claude.</p>
            <p className="m3-body-sm max-w-sm text-ink-faint">
              It runs in the selected repo with your workspace description, paths and commands as
              context.
            </p>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {chat.entries.map((entry) => (
                <MessageView key={entry.seq} entry={entry} />
              ))}
              {chat.streaming && (
                <p className="m3-body-md whitespace-pre-wrap leading-relaxed text-ink-muted">
                  {chat.streaming}
                  <span className="animate-status ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-xs bg-primary" />
                </p>
              )}
              {chat.entries.length === 0 && !chat.running && (
                <p className="m3-body-sm text-ink-faint">
                  Try: “which repo here is the BE source, and what does it do?”
                </p>
              )}
            </div>

            {chat.error && (
              <div className="m3-body-sm border-t border-err/30 bg-err/8 px-4 py-2.5 text-err">
                {chat.error}
              </div>
            )}

            {chat.lastResult && (
              <div className="m3-label-md flex items-center gap-3 border-t border-hairline px-4 py-2.5 text-ink-faint">
                {chat.lastResult.isError && <Badge tone="err">error</Badge>}
                {chat.lastResult.durationMs !== null && (
                  <span>{(chat.lastResult.durationMs / 1000).toFixed(1)}s</span>
                )}
                {chat.lastResult.costUsd !== null && (
                  <span>${chat.lastResult.costUsd.toFixed(4)}</span>
                )}
              </div>
            )}

            {chat.permission && (
              <PermissionPrompt
                key={chat.permission.requestId}
                request={chat.permission}
                onRespond={chat.respondPermission}
              />
            )}

            <div className="border-t border-hairline p-3.5">
              {(attachments.length > 0 || uploadError) && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  {attachments.map((a) => (
                    <span
                      key={a.id}
                      className="m3-label-md inline-flex items-center gap-1.5 rounded-pill bg-surface-3 px-2.5 py-1"
                    >
                      {a.originalFilename}
                      <X
                        size={16}
                        className="cursor-pointer text-ink-faint hover:text-ink"
                        onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      />
                    </span>
                  ))}
                  {uploadError && <span className="m3-label-sm text-err">{uploadError}</span>}
                </div>
              )}
              <div className="flex items-end gap-2">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => fileRef.current?.click()}
                  title="Attach a screenshot or file"
                >
                  <Paperclip size={16} />
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void attach(file);
                    e.target.value = "";
                  }}
                />
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    const image = Array.from(e.clipboardData.files).find((f) =>
                      f.type.startsWith("image/"),
                    );
                    if (image) {
                      e.preventDefault();
                      void attach(image);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={
                    chat.running
                      ? "Claude is working…"
                      : "Ask or assign a task…  (⌘↵, paste images)"
                  }
                  className="min-h-[56px]"
                  disabled={chat.running}
                />
                {chat.running ? (
                  <Button variant="danger" onClick={chat.interrupt}>
                    <StopCircle size={16} /> Stop
                  </Button>
                ) : (
                  <Button variant="primary" onClick={submit} disabled={!draft.trim()}>
                    <Send size={16} />
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
