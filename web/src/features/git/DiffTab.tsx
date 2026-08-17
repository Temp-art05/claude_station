import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Columns2,
  Eye,
  FileDiff,
  FilePlus,
  FolderPlus,
  LocateFixed,
  Pencil,
  RotateCcw,
  Rows3,
  Trash2,
} from "lucide-react";
import type { Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Splitter } from "@/components/ui/Splitter";
import { usePanelActive } from "@/components/KeepAlive";
import { api, ApiError } from "@/lib/api";
import { projectKey, useUiDraft, useUiSet, useUiState } from "@/lib/uiStore";
import { useScrollMemory } from "@/lib/useScrollMemory";
import { cn } from "@/lib/utils";
import { AUTOSAVE_MS, shouldAutosave } from "./autosave";
import { BranchMenu } from "./BranchMenu";
import { FileTree } from "./FileTree";
import { MarkdownView } from "./MarkdownView";
import { SideBySideDiff, splitHunks } from "./SideBySideDiff";
import { useGitWatch } from "./useGitWatch";

interface StatusResponse {
  cwd: string;
  isRepo: boolean;
  branch: { branch: string; ahead: number; behind: number } | null;
  files: { path: string; status: string; staged: boolean }[];
}

interface TreeResponse {
  cwd: string;
  isRepo: boolean;
  files: string[];
  truncated: boolean;
}

interface FileResponse {
  content: string;
  truncated: boolean;
  binary: boolean;
  hash: string;
}

/**
 * CodeMirror is a few hundred KB and this bundle is already over vite's warning
 * threshold — so it loads on the first Edit click, not on page load.
 */
const FileEditor = lazy(() => import("./FileEditor"));

interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  refs: string[];
}

interface Changelist {
  id: string;
  name: string;
  files: string[];
}

const STATUS_TONE: Record<string, string> = {
  M: "text-warn",
  A: "text-ok",
  "?": "text-ok",
  D: "text-err",
  R: "text-accent",
};

/** Untracked in porcelain v1. Everything else is a change git already knows about. */
const isUntracked = (status: string) => status === "??" || status === "?";

/** Drag payload: which file is being moved, and out of which repo. */
const DND_MIME = "application/x-station-change";

/** Minimal unified-diff colouring — the "All changes" overview. */
function UnifiedDiff({ patch }: { patch: string }) {
  if (!patch.trim()) {
    return <p className="p-4 text-xs text-ink-faint">No changes against HEAD.</p>;
  }
  return (
    <pre className="scroll-x h-full overflow-auto bg-base px-3 py-2 font-mono text-[11.5px] leading-relaxed">
      {patch.split("\n").map((line, i) => (
        <div
          key={i}
          className={cn(
            line.startsWith("+") && !line.startsWith("+++") && "text-ok",
            line.startsWith("-") && !line.startsWith("---") && "text-err",
            line.startsWith("@@") && "text-accent",
            (line.startsWith("diff ") || line.startsWith("index ")) && "text-ink-faint",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/** Read-only file viewer with line numbers — the tree's editor pane. */
function FileView({ file }: { file: FileResponse }) {
  if (file.binary) {
    return <p className="p-4 text-xs text-ink-faint">Binary file — no preview.</p>;
  }
  const lines = file.content.split("\n");
  return (
    <div className="h-full overflow-auto bg-base font-mono text-[11.5px] leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-12 shrink-0 border-r border-hairline px-1.5 text-right text-ink-faint select-none">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 px-2 break-all whitespace-pre-wrap">{line}</span>
        </div>
      ))}
      {file.truncated && (
        <p className="border-t border-hairline px-3 py-1.5 text-[11px] text-warn">
          File truncated at 1 MB.
        </p>
      )}
    </div>
  );
}

/**
 * Tick-all with a real third state. `indeterminate` exists only as a DOM
 * property — there is no attribute for it — so it has to be set through a ref.
 */
function TriCheckbox({
  checked,
  indeterminate,
  onToggle,
  title,
}: {
  checked: boolean;
  indeterminate: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <input
      type="checkbox"
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      checked={checked}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      title={title}
      className="shrink-0 accent-(--color-accent)"
    />
  );
}

type Selection =
  | { type: "change"; path: string }
  | { type: "file"; path: string }
  | { type: "commit"; hash: string; subject: string; file?: string }
  | null;

export function DiffTab({ project }: { project: Project }) {
  const qc = useQueryClient();
  const panelActive = usePanelActive();
  const ui = (...parts: string[]) => projectKey(project.id, "diff", ...parts);
  const [storedPathId, setPathId] = useUiState(ui("pathId"), project.paths[0]?.id ?? "");
  // A repo can be removed from the project between visits.
  const pathId = project.paths.some((p) => p.id === storedPathId)
    ? storedPathId
    : (project.paths[0]?.id ?? "");
  const [storedSelection, setSelected] = useUiState<Selection>(ui(pathId, "selection"), null);
  // Everything starts checked, Android Studio style — we track the unchecks.
  const [unchecked, setUnchecked] = useUiSet(ui(pathId, "unchecked"));
  // The one piece of typed-but-unsent text here — it outlives tab switches,
  // route changes and reloads until it is actually committed.
  const [message, setMessage] = useUiDraft(ui(pathId, "commitMessage"));
  const [amend, setAmend] = useUiState(ui("amend"), false);
  const [sideBySide, setSideBySide] = useUiState(ui("sideBySide"), true);
  const [bottomView, setBottomView] = useUiState<"files" | "history">(ui("bottomView"), "files");
  const [mdSource, setMdSource] = useUiState(ui("mdSource"), false); // .md: preview ⟷ source
  const [collapsed, setCollapsed] = useUiSet(ui(pathId, "collapsedGroups"));
  // Pane sizes in px — dragged by the user, remembered like every other bit of
  // tab state. Height is for the Changes block; the rest of the column flexes.
  const [colWidth, setColWidth] = useUiState(ui("colWidth"), 320);
  const [changesHeight, setChangesHeight] = useUiState(ui("changesHeight"), 260);
  // Transient by design: a one-shot scroll target and a toast. Both *should*
  // die with the panel — restoring either would be noise, not continuity.
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  /**
   * Unsaved edit buffers, keyed by path — a file with no entry here is clean and
   * renders straight from the query, so a change on disk needs no reseeding.
   *
   * Keyed rather than a single buffer: editing file A then switching to B would
   * otherwise drop A's unsaved work without a word. Transient on purpose too —
   * persisting it would mean silently restoring an old version of a file an agent
   * has since rewritten. `baseHash` is the version the buffer forked from; the
   * whole overwrite guard hangs off it.
   */
  const [buffers, setBuffers] = useState<Record<string, { text: string; baseHash: string }>>({});
  /** Paths whose last save hit a 409 — autosave stays off for them until resolved. */
  const [conflictPaths, setConflictPaths] = useState<Record<string, true>>({});
  // KeepAlive covers tab switches; these cover leaving the project entirely,
  // which still unmounts the panel.
  const changesScroll = useScrollMemory<HTMLDivElement>(ui(pathId, "scroll", "changes"));
  const bottomScroll = useScrollMemory<HTMLDivElement>(ui(pathId, "scroll", bottomView));

  const statusKey = ["git-status", project.id, pathId];
  const { data: status } = useQuery({
    queryKey: statusKey,
    queryFn: () =>
      api.get<StatusResponse>(`/api/projects/${project.id}/git/status?pathId=${pathId}`),
    enabled: !!pathId,
    // The watcher below is the real refresh path. This is the safety net for
    // when it can't come up (OS limits, odd filesystem), so it stays slow —
    // `git status` on a large repo is not something to run every few seconds.
    refetchInterval: panelActive ? 20000 : false,
  });

  const changes = status?.files ?? [];
  const changedSet = new Set(changes.map((f) => f.path));
  // A restored selection can point at a file that has since been committed or
  // reverted. Derived rather than written back — correcting it with a state
  // update would fight the store on every render. Waits for `status`, so the
  // first render (before it loads) doesn't discard a perfectly good selection.
  const selected: Selection =
    storedSelection?.type === "change" && status && !changedSet.has(storedSelection.path)
      ? null
      : storedSelection;

  const { data: tree } = useQuery({
    queryKey: ["git-tree", project.id, pathId],
    queryFn: () => api.get<TreeResponse>(`/api/projects/${project.id}/git/tree?pathId=${pathId}`),
    enabled: !!pathId,
  });

  const { data: history } = useQuery({
    queryKey: ["git-log", project.id, pathId],
    queryFn: () =>
      api.get<{ commits: LogEntry[] }>(`/api/projects/${project.id}/git/log?pathId=${pathId}`),
    enabled: !!pathId && bottomView === "history",
  });

  const changelistKey = ["git-changelists", project.id, pathId];
  const { data: changelistData } = useQuery({
    queryKey: changelistKey,
    queryFn: () =>
      api.get<{ changelists: Changelist[] }>(
        `/api/projects/${project.id}/git/changelists?pathId=${pathId}`,
      ),
    enabled: !!pathId,
  });

  const changeSelected = selected?.type === "change" ? selected.path : null;
  const { data: diff } = useQuery({
    queryKey: ["git-diff", project.id, pathId, changeSelected],
    queryFn: () =>
      api.get<{ patch: string }>(
        `/api/projects/${project.id}/git/diff?pathId=${pathId}${
          changeSelected ? `&file=${encodeURIComponent(changeSelected)}` : ""
        }`,
      ),
    enabled: !!pathId && (selected === null || selected.type === "change"),
  });

  const fileSelected = selected?.type === "file" ? selected.path : null;
  const { data: fileContent } = useQuery({
    queryKey: ["git-file", project.id, pathId, fileSelected],
    queryFn: () =>
      api.get<FileResponse>(
        `/api/projects/${project.id}/git/file?pathId=${pathId}&file=${encodeURIComponent(fileSelected!)}`,
      ),
    enabled: !!pathId && !!fileSelected,
  });

  const commitSel = selected?.type === "commit" ? selected : null;
  const { data: commitFilesData } = useQuery({
    queryKey: ["git-commit-files", project.id, pathId, commitSel?.hash],
    queryFn: () =>
      api.get<{ files: { path: string; status: string }[] }>(
        `/api/projects/${project.id}/git/commit-files?pathId=${pathId}&hash=${commitSel!.hash}`,
      ),
    enabled: !!pathId && !!commitSel,
  });
  const { data: commitPatch } = useQuery({
    queryKey: ["git-show", project.id, pathId, commitSel?.hash, commitSel?.file],
    queryFn: () =>
      api.get<{ patch: string }>(
        `/api/projects/${project.id}/git/show?pathId=${pathId}&hash=${commitSel!.hash}&file=${encodeURIComponent(commitSel!.file!)}`,
      ),
    enabled: !!pathId && !!commitSel?.file,
  });

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: statusKey });
    void qc.invalidateQueries({ queryKey: ["git-diff", project.id, pathId] });
    void qc.invalidateQueries({ queryKey: ["git-tree", project.id, pathId] });
    void qc.invalidateQueries({ queryKey: ["git-file", project.id, pathId] });
    void qc.invalidateQueries({ queryKey: ["git-log", project.id, pathId] });
  };

  // This is what makes the tab live: the server watches the working tree and
  // every change re-runs the queries above, including the open diff — which the
  // old 5s status poll never touched, so the diff pane sat stale until a reload.
  const watching = useGitWatch(project.id, pathId, panelActive, refreshAll);

  const revert = useMutation({
    mutationFn: (files: string[]) =>
      api.post(`/api/projects/${project.id}/git/revert`, { files, pathId }),
    onSuccess: refreshAll,
  });

  const addToVcs = useMutation({
    mutationFn: (files: string[]) =>
      api.post(`/api/projects/${project.id}/git/add`, { files, pathId }),
    onSuccess: refreshAll,
    onError: (err: unknown) =>
      setNotice({ tone: "err", text: err instanceof Error ? err.message : String(err) }),
  });

  const deleteUnversioned = useMutation({
    mutationFn: (files: string[]) =>
      api.post<{ deleted: number }>(`/api/projects/${project.id}/git/delete-files`, {
        files,
        pathId,
      }),
    onSuccess: (r, files) => {
      setNotice({ tone: "ok", text: `Deleted ${r.deleted} file(s)` });
      if (files.includes(changeSelected ?? "")) setSelected(null);
      refreshAll();
    },
    onError: (err: unknown) =>
      setNotice({ tone: "err", text: err instanceof Error ? err.message : String(err) }),
  });

  const saveFile = useMutation({
    mutationFn: ({
      silent: _silent,
      ...v
    }: {
      file: string;
      content: string;
      baseHash: string;
      silent?: boolean;
    }) => api.put<{ hash: string }>(`/api/projects/${project.id}/git/file`, { pathId, ...v }),
    onSuccess: (r, v) => {
      // Autosave stays quiet: a toast every 1.2s while typing is noise, not news.
      if (!v.silent) setNotice({ tone: "ok", text: `Saved ${v.file}` });
      // Write the result straight into the cache instead of waiting for the
      // refetch: in that gap the query still holds the OLD content and hash,
      // which looks exactly like "someone else just wrote this file" and would
      // flash the editor back to the previous version.
      qc.setQueryData<FileResponse>(["git-file", project.id, pathId, v.file], (old) =>
        old ? { ...old, content: v.content, hash: r.hash } : old,
      );
      dropBuffer(v.file);
      setConflictPaths((prev) => {
        if (!prev[v.file]) return prev;
        const next = { ...prev };
        delete next[v.file];
        return next;
      });
      refreshAll();
    },
    onError: (err: unknown, v) => {
      setNotice({ tone: "err", text: err instanceof Error ? err.message : String(err) });
      // A 409 must latch. Without this, autosave retries every 1.2s — each attempt
      // failing — because `fileContent.hash` still matches `baseHash` until the
      // refetch lands, so nothing else would tell autosave to stand down.
      if (err instanceof ApiError && err.status === 409) {
        setConflictPaths((prev) => ({ ...prev, [v.file]: true }));
        void qc.invalidateQueries({ queryKey: ["git-file", project.id, pathId, v.file] });
      }
    },
  });

  const revertHunk = useMutation({
    mutationFn: (patch: string) =>
      api.post(`/api/projects/${project.id}/git/revert-hunk`, { patch, pathId }),
    onSuccess: () => {
      setNotice({ tone: "ok", text: "Hunk rolled back" });
      refreshAll();
    },
    onError: (err: unknown) =>
      setNotice({ tone: "err", text: err instanceof Error ? err.message : String(err) }),
  });

  const refreshChangelists = () => void qc.invalidateQueries({ queryKey: changelistKey });

  const createList = useMutation({
    mutationFn: (name: string) =>
      api.post(`/api/projects/${project.id}/git/changelists`, { pathId, name }),
    onSuccess: refreshChangelists,
  });
  const renameList = useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      api.patch(`/api/projects/${project.id}/git/changelists/${v.id}`, { name: v.name }),
    onSuccess: refreshChangelists,
  });
  const deleteList = useMutation({
    mutationFn: (id: string) => api.delete(`/api/projects/${project.id}/git/changelists/${id}`),
    onSuccess: refreshChangelists,
  });
  const moveFiles = useMutation({
    mutationFn: (v: { clId: string | null; paths: string[] }) =>
      api.post(`/api/projects/${project.id}/git/changelist-files`, { pathId, ...v }),
    onSuccess: refreshChangelists,
  });

  const doCommit = useMutation({
    mutationFn: (push: boolean) =>
      api.post<{ summary: string; pushed: boolean }>(`/api/projects/${project.id}/git/commit`, {
        pathId,
        files: checkedFiles,
        message,
        amend,
        push,
      }),
    onSuccess: (r) => {
      setNotice({ tone: "ok", text: `${r.summary}${r.pushed ? " — pushed ✓" : ""}` });
      setMessage("");
      setAmend(false);
      setSelected(null);
      refreshAll();
      refreshChangelists();
    },
    onError: (err: unknown) =>
      setNotice({ tone: "err", text: err instanceof Error ? err.message : String(err) }),
  });

  const checkedFiles = changes.map((f) => f.path).filter((p) => !unchecked.has(p));
  const canCommit =
    checkedFiles.length > 0 && (amend || message.trim().length > 0) && !doCommit.isPending;

  const toggleCheck = (path: string) => {
    const next = new Set(unchecked);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setUnchecked(next);
  };

  /**
   * Tick-all for one group. Deliberately scoped to the group's own files: a
   * top-level "check everything" that reached into the other groups would
   * silently re-tick files the user had just cleared there.
   */
  const toggleGroup = (paths: string[], allChecked: boolean) => {
    const next = new Set(unchecked);
    for (const p of paths) {
      if (allChecked) next.add(p);
      else next.delete(p);
    }
    setUnchecked(next);
  };

  const toggleCollapsed = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  // ── Grouping ───────────────────────────────────────────────────────────────
  // Unversioned files are their own node and never join a changelist: the group
  // is defined by "git doesn't track this yet", and it owns the Add action.
  const tracked = changes.filter((f) => !isUntracked(f.status));
  const untracked = changes.filter((f) => isUntracked(f.status));
  const lists = changelistData?.changelists ?? [];
  const assigned = new Map<string, string>();
  for (const l of lists) for (const p of l.files) assigned.set(p, l.id);
  // A file in a changelist that has since been committed or reverted is gone
  // from `status`; filtering here is what keeps stale mappings invisible.
  const groups: { id: string; name: string; files: typeof tracked; custom: boolean }[] = [
    {
      id: "default",
      name: "Changes",
      files: tracked.filter((f) => !assigned.has(f.path)),
      custom: false,
    },
    ...lists.map((l) => ({
      id: l.id,
      name: l.name,
      files: tracked.filter((f) => assigned.get(f.path) === l.id),
      custom: true,
    })),
  ];

  // ── Editing ────────────────────────────────────────────────────────────────
  // The file pane is always editable — no Edit button to press. Binary and
  // truncated files stay read-only: saving a truncated file would silently drop
  // everything past the 1 MB the viewer received.
  const editable = !!fileSelected && !!fileContent && !fileContent.binary && !fileContent.truncated;
  const dirtyBuf = fileSelected ? buffers[fileSelected] : undefined;
  const dirty = !!dirtyBuf;
  const editorText = dirtyBuf?.text ?? fileContent?.content ?? "";
  // While dirty this stays frozen at the forked-from version, which is both what
  // the save guard needs and what keeps the editor from remounting mid-typing.
  const editorBase = dirtyBuf?.baseHash ?? fileContent?.hash ?? "";
  // Dirty AND the file moved underneath us — someone else (very likely an agent)
  // wrote it. Never resolve this silently; the user picks. The latched 409 counts
  // too: right after the rejection the refetch hasn't landed, so the hashes still
  // look equal even though the server just told us otherwise.
  const conflicted =
    dirty && ((!!fileContent && fileContent.hash !== dirtyBuf.baseHash) || !!conflictPaths[fileSelected!]);
  const onEditorChange = (text: string) => {
    if (!fileSelected) return;
    setBuffers((prev) => ({
      ...prev,
      [fileSelected]: { text, baseHash: prev[fileSelected]?.baseHash ?? (fileContent?.hash ?? "") },
    }));
  };

  const dropBuffer = (path: string) => {
    setBuffers((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    setConflictPaths((prev) => {
      if (!prev[path]) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  };

  const commitEdit = (baseHash = editorBase, silent = false) => {
    if (!fileSelected || !dirty) return;
    saveFile.mutate({ file: fileSelected, content: editorText, baseHash, silent });
  };

  // Autosave: 1.2s after the last keystroke. `editorText` in the deps is what makes
  // each keystroke restart the timer instead of letting the first one win.
  const armAutosave = shouldAutosave({
    dirty,
    editable,
    conflicted,
    saving: saveFile.isPending,
  });
  useEffect(() => {
    if (!armAutosave || !fileSelected) return;
    const t = setTimeout(() => commitEdit(editorBase, true), AUTOSAVE_MS);
    return () => clearTimeout(t);
    // `commitEdit` is rebuilt every render; listing it would re-arm the timer on
    // every render rather than on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armAutosave, fileSelected, editorText, editorBase]);

  // Switching files inside the autosave window would otherwise leave that buffer
  // unsaved with nothing on screen saying so — now there is no indicator at all,
  // so the switch itself has to flush it. Conflicted buffers are left alone: they
  // would only 409 again, and their banner is waiting when you come back.
  const prevFile = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevFile.current;
    prevFile.current = fileSelected;
    if (!prev || prev === fileSelected) return;
    const buf = buffers[prev];
    if (!buf || conflictPaths[prev]) return;
    saveFile.mutate({ file: prev, content: buf.text, baseHash: buf.baseHash, silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSelected]);

  const askDelete = (paths: string[]) => {
    const what = paths.length === 1 ? paths[0] : `${paths.length} unversioned files`;
    if (
      confirm(
        `Delete ${what} from disk?\n\nUnversioned files have no committed version to restore from — this cannot be undone.`,
      )
    ) {
      deleteUnversioned.mutate(paths);
    }
  };

  const selectedIsUntracked =
    !!changeSelected && untracked.some((f) => f.path === changeSelected);

  // Del/Backspace on the selected row. Scoped to unversioned files on purpose:
  // tracked files already have Rollback, and a mistyped key should never be able
  // to remove a file the repo is carrying.
  useEffect(() => {
    if (!panelActive || !selectedIsUntracked || !changeSelected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Without this, Backspace while writing a commit message deletes a file.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      askDelete([changeSelected]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `askDelete` closes over react-query's `mutate`, which is stable; listing it
    // would re-bind the listener on every render for no behavioural gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelActive, selectedIsUntracked, changeSelected]);

  const onDropInto = (clId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const path = e.dataTransfer.getData(DND_MIME);
    if (path) moveFiles.mutate({ clId, paths: [path] });
  };

  const fileRow = (f: { path: string; status: string }, group: string) => (
    <div
      key={f.path}
      draggable={!isUntracked(f.status)}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_MIME, f.path);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "group flex items-center gap-1.5 rounded-md px-1.5 py-0.5",
        changeSelected === f.path ? "bg-surface-3" : "hover:bg-surface-2",
      )}
    >
      <input
        type="checkbox"
        checked={!unchecked.has(f.path)}
        onChange={() => toggleCheck(f.path)}
        className="shrink-0 accent-(--color-accent)"
      />
      <span
        className={cn(
          "w-3 shrink-0 text-center font-mono text-[10px] font-bold",
          STATUS_TONE[f.status[0] ?? ""] ?? "text-ink-muted",
        )}
      >
        {f.status}
      </span>
      <button
        onClick={() => setSelected({ type: "change", path: f.path })}
        className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[11px]"
        title={f.path}
      >
        <span className="text-ink">{f.path.split("/").pop()}</span>
        {f.path.includes("/") && (
          <span className="text-ink-faint">
            {"  "}
            {f.path.slice(0, f.path.lastIndexOf("/"))}
          </span>
        )}
      </button>
      {group === "unversioned" ? (
        <>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
            title="Add to VCS"
            onClick={() => addToVcs.mutate([f.path])}
          >
            <FilePlus size={11} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
            title="Delete from disk (Del)"
            onClick={() => askDelete([f.path])}
          >
            <Trash2 size={11} />
          </Button>
        </>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
          title="Rollback — discard changes to this file"
          onClick={() => {
            if (confirm(`Discard local changes to ${f.path}? This cannot be undone.`)) {
              revert.mutate([f.path]);
            }
          }}
        >
          <RotateCcw size={11} />
        </Button>
      )}
    </div>
  );

  const groupHeader = (
    id: string,
    name: string,
    files: { path: string }[],
    extra?: React.ReactNode,
  ) => {
    const paths = files.map((f) => f.path);
    const allChecked = paths.length > 0 && paths.every((p) => !unchecked.has(p));
    const someChecked = paths.some((p) => !unchecked.has(p));
    const isCollapsed = collapsed.has(id);
    return (
      <div
        className={cn(
          "group/hdr flex items-center gap-1.5 rounded-md px-1.5 py-1",
          dragOver === id && "bg-accent/15 ring-1 ring-accent/40",
        )}
      >
        <button
          onClick={() => toggleCollapsed(id)}
          className="cursor-pointer text-ink-faint hover:text-ink"
          title={isCollapsed ? "Expand" : "Collapse"}
        >
          {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <TriCheckbox
          checked={allChecked}
          indeterminate={!allChecked && someChecked}
          onToggle={() => toggleGroup(paths, allChecked)}
          title={allChecked ? "Uncheck all in this group" : "Check all in this group"}
        />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink">{name}</span>
        <Badge>{files.length}</Badge>
        {extra}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left: repo + branch, changes + commit, files / history ────────── */}
      <div
        className="flex shrink-0 flex-col border-r border-edge"
        style={{ width: colWidth }}
      >
        <div className="space-y-1.5 border-b border-hairline p-3 pb-2">
          <select
            value={pathId}
            // Selection, unchecks and commit message are keyed by repo path, so
            // switching repos reveals that repo's own state instead of clearing.
            onChange={(e) => setPathId(e.target.value)}
            className="h-7 w-full rounded-md border border-edge bg-surface px-2 text-xs text-ink"
          >
            {project.paths.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <BranchMenu
                projectId={project.id}
                pathId={pathId}
                onChanged={refreshAll}
                onNotice={(tone, text) => setNotice({ tone, text })}
              />
            </div>
            {status?.branch && status.branch.ahead > 0 && (
              <span className="inline-flex shrink-0 items-center text-[11px] text-ok">
                <ArrowUp size={10} />
                {status.branch.ahead}
              </span>
            )}
            {status?.branch && status.branch.behind > 0 && (
              <span className="inline-flex shrink-0 items-center text-[11px] text-warn">
                <ArrowDown size={10} />
                {status.branch.behind}
              </span>
            )}
          </div>
        </div>

        {/* Changes + commit box */}
        <div
          className="flex shrink-0 flex-col border-b border-hairline"
          style={{ height: changesHeight }}
        >
          <div className="flex items-center gap-1.5 px-3 py-1.5">
            <TriCheckbox
              checked={changes.length > 0 && checkedFiles.length === changes.length}
              indeterminate={checkedFiles.length > 0 && checkedFiles.length < changes.length}
              onToggle={() =>
                toggleGroup(
                  changes.map((f) => f.path),
                  checkedFiles.length === changes.length,
                )
              }
              title="Check / uncheck every file"
            />
            <button
              onClick={() => setSelected(null)}
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs font-medium",
                selected === null ? "bg-surface-3" : "hover:bg-surface-2",
              )}
            >
              All changes
              <Badge>{changes.length}</Badge>
              {status && !status.isRepo && <span className="text-ink-faint">not a repo</span>}
            </button>
            {/* No dot = the watcher never came up and the 20s poll is carrying
                the tab. Worth showing: it explains a laggy list. */}
            {!watching && panelActive && (
              <span className="shrink-0 text-[10px] text-ink-faint" title="Live watch unavailable — refreshing every 20s">
                poll
              </span>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 shrink-0"
              title="New changelist"
              onClick={() => {
                const name = prompt("Changelist name")?.trim();
                if (name) createList.mutate(name);
              }}
            >
              <FolderPlus size={12} />
            </Button>
          </div>

          <div ref={changesScroll} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
            {changes.length === 0 && (
              <p className="px-2 py-1 text-xs text-ink-faint">Working tree clean.</p>
            )}

            {groups.map((g) => {
              // The default group is always a drop target so a file can come
              // back out of a changelist; custom ones vanish when deleted.
              const empty = g.files.length === 0;
              if (empty && g.id === "default" && lists.length === 0) return null;
              return (
                <div
                  key={g.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOver !== g.id) setDragOver(g.id);
                  }}
                  onDragLeave={() => setDragOver((cur) => (cur === g.id ? null : cur))}
                  onDrop={onDropInto(g.id === "default" ? null : g.id)}
                >
                  {groupHeader(
                    g.id,
                    g.name,
                    g.files,
                    g.custom ? (
                      <span className="flex shrink-0 items-center opacity-0 group-hover/hdr:opacity-100">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          title="Rename changelist"
                          onClick={() => {
                            const name = prompt("Changelist name", g.name)?.trim();
                            if (name && name !== g.name) renameList.mutate({ id: g.id, name });
                          }}
                        >
                          <Pencil size={10} />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          title="Delete changelist (files are not touched)"
                          onClick={() => deleteList.mutate(g.id)}
                        >
                          <Trash2 size={10} />
                        </Button>
                      </span>
                    ) : null,
                  )}
                  {!collapsed.has(g.id) && (
                    <div className="pl-3">
                      {g.files.map((f) => fileRow(f, g.id))}
                      {empty && (
                        <p className="px-2 py-0.5 text-[10.5px] text-ink-faint">
                          Drag files here.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {untracked.length > 0 && (
              <div>
                {groupHeader(
                  "unversioned",
                  "Unversioned Files",
                  untracked,
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 shrink-0 px-1.5 text-[10px]"
                    title="Add every unversioned file to VCS"
                    onClick={() => addToVcs.mutate(untracked.map((f) => f.path))}
                  >
                    Add all
                  </Button>,
                )}
                {!collapsed.has("unversioned") && (
                  <div className="pl-3">{untracked.map((f) => fileRow(f, "unversioned"))}</div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1.5 border-t border-hairline p-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              rows={2}
              className="w-full resize-y rounded-md border border-edge bg-surface px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1 text-[11px] text-ink-muted">
                <input
                  type="checkbox"
                  checked={amend}
                  onChange={(e) => setAmend(e.target.checked)}
                  className="accent-(--color-accent)"
                />
                Amend
              </label>
              <span className="ml-auto text-[10.5px] text-ink-faint">
                {checkedFiles.length}/{changes.length} files
              </span>
              <Button size="sm" disabled={!canCommit} onClick={() => doCommit.mutate(false)}>
                <Check size={12} /> Commit
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!canCommit}
                onClick={() => doCommit.mutate(true)}
              >
                Commit & Push
              </Button>
            </div>
            {notice && (
              <p
                className={cn(
                  "text-[10.5px]",
                  // A success line is short, so clipping it is fine. git's failures
                  // carry the fix in their tail ("run 'git branch -D …'"), which a
                  // single truncated line hid completely.
                  notice.tone === "ok"
                    ? "truncate text-ok"
                    : "line-clamp-4 break-words whitespace-pre-wrap text-err",
                )}
                title={notice.text}
              >
                {notice.text}
              </p>
            )}
          </div>
        </div>

        <Splitter
          axis="y"
          size={changesHeight}
          onResize={setChangesHeight}
          min={140}
          max={700}
        />

        {/* Bottom: project files ⟷ history */}
        <div className="flex items-center gap-1 px-3 pt-1.5 pb-0.5">
          {(["files", "history"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setBottomView(v)}
              className={cn(
                "cursor-pointer rounded-pill px-2 py-0.5 text-[10.5px] font-bold tracking-wide uppercase",
                bottomView === v ? "bg-white/8 text-ink" : "text-ink-faint hover:text-ink-muted",
              )}
            >
              {v === "files" ? `Project files${tree?.truncated ? " (truncated)" : ""}` : "History"}
            </button>
          ))}
        </div>
        <div ref={bottomScroll} className="min-h-0 flex-1 overflow-y-auto p-1.5 pt-0.5">
          {bottomView === "files" ? (
            <FileTree
              files={tree?.files ?? []}
              selected={fileSelected ?? changeSelected}
              changed={changedSet}
              reveal={reveal}
              // Tree clicks always preview the file; the Changes list is where diffs open.
              onOpen={(path) => setSelected({ type: "file", path })}
            />
          ) : (
            <div>
              {(history?.commits ?? []).map((c) => (
                <button
                  key={c.hash}
                  onClick={() =>
                    setSelected({ type: "commit", hash: c.hash, subject: c.subject })
                  }
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-1.5 rounded-md px-1.5 py-1 text-left",
                    commitSel?.hash === c.hash ? "bg-surface-3" : "hover:bg-surface-2",
                  )}
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/60" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] text-ink">{c.subject}</span>
                    <span className="block truncate text-[10px] text-ink-faint">
                      <span className="font-mono">{c.shortHash}</span> · {c.author} · {c.date}
                      {c.refs.map((r) => (
                        <span
                          key={r}
                          className="ml-1 rounded-pill border border-accent/30 bg-accent/10 px-1 font-mono text-[9px] text-accent"
                        >
                          {r}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              ))}
              {history && history.commits.length === 0 && (
                <p className="px-2 py-1 text-xs text-ink-faint">No commits.</p>
              )}
            </div>
          )}
        </div>
      </div>

      <Splitter axis="x" size={colWidth} onResize={setColWidth} min={220} max={640} />

      {/* ── Right: diff / file viewer / commit ────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected && selected.type !== "commit" && (
          <div className="flex items-center gap-2 border-b border-hairline px-3 py-1.5">
            <span className="truncate font-mono text-xs text-ink">{selected.path}</span>
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 shrink-0"
              title="Locate in Project files"
              onClick={() => {
                setBottomView("files");
                setReveal((prev) => ({ path: selected.path, nonce: (prev?.nonce ?? 0) + 1 }));
              }}
            >
              <LocateFixed size={12} />
            </Button>
            {selected.type === "file" && (
              <div className="ml-auto flex items-center gap-1">
                {fileContent && !editable && (
                  <span className="text-[10.5px] text-ink-faint">
                    {fileContent.binary ? "binary — read only" : "truncated at 1 MB — read only"}
                  </span>
                )}
                {selected.path.toLowerCase().endsWith(".md") && (
                  <>
                    <Button
                      size="sm"
                      variant={!mdSource ? "primary" : "ghost"}
                      onClick={() => setMdSource(false)}
                      title="Rendered preview"
                    >
                      <Eye size={12} /> Preview
                    </Button>
                    <Button
                      size="sm"
                      variant={mdSource ? "primary" : "ghost"}
                      onClick={() => setMdSource(true)}
                      title="Editable source"
                    >
                      <Code size={12} /> Source
                    </Button>
                  </>
                )}
                {/* No Save / unsaved / Discard chrome on purpose: it appeared and
                    vanished as you typed, shifting the header around. Saving is
                    automatic, so the only thing worth interrupting for is the
                    conflict banner below. */}
              </div>
            )}
            {selected.type === "change" && (
              <>
                <Badge>{changes.find((f) => f.path === selected.path)?.status ?? ""}</Badge>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Open this file in the editor"
                    onClick={() => setSelected({ type: "file", path: selected.path })}
                  >
                    <Pencil size={12} /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant={sideBySide ? "primary" : "ghost"}
                    onClick={() => setSideBySide(true)}
                    title="Side-by-side"
                  >
                    <Columns2 size={12} />
                  </Button>
                  <Button
                    size="sm"
                    variant={!sideBySide ? "primary" : "ghost"}
                    onClick={() => setSideBySide(false)}
                    title="Unified"
                  >
                    <Rows3 size={12} />
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        {commitSel && (
          <div className="flex items-center gap-2 border-b border-hairline px-3 py-1.5">
            {commitSel.file && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected({ ...commitSel, file: undefined })}
              >
                <ArrowLeft size={12} /> files
              </Button>
            )}
            <span className="font-mono text-[11px] text-accent">
              {commitSel.hash.slice(0, 10)}
            </span>
            <span className="min-w-0 truncate text-xs text-ink">{commitSel.subject}</span>
            {commitSel.file && (
              <span className="truncate font-mono text-[10.5px] text-ink-faint">
                {commitSel.file}
              </span>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1">
          {commitSel ? (
            commitSel.file ? (
              commitPatch ? (
                <SideBySideDiff patch={commitPatch.patch} />
              ) : (
                <p className="p-4 text-xs text-ink-faint">Loading…</p>
              )
            ) : (
              <div className="h-full overflow-y-auto p-2">
                {(commitFilesData?.files ?? []).map((f) => (
                  <button
                    key={f.path}
                    onClick={() => setSelected({ ...commitSel, file: f.path })}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-2"
                  >
                    <span
                      className={cn(
                        "w-3 shrink-0 text-center font-mono text-[10px] font-bold",
                        STATUS_TONE[f.status] ?? "text-ink-muted",
                      )}
                    >
                      {f.status}
                    </span>
                    <span className="truncate font-mono text-[11.5px]">{f.path}</span>
                  </button>
                ))}
              </div>
            )
          ) : fileSelected ? (
            fileContent ? (
              fileSelected.toLowerCase().endsWith(".md") && !mdSource && !fileContent.binary ? (
                <MarkdownView source={fileContent.content} />
              ) : editable ? (
                <div className="flex h-full min-h-0 flex-col">
                  {conflicted && (
                    <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5">
                      <span className="min-w-0 flex-1 text-[11px] text-warn">
                        This file changed on disk while you were editing it.
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Throw away your edits and load the version on disk"
                        onClick={() => dropBuffer(fileSelected)}
                      >
                        Reload
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        title="Keep your edits and overwrite what is on disk"
                        onClick={() => commitEdit(fileContent.hash)}
                      >
                        Overwrite
                      </Button>
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    <Suspense
                      fallback={<p className="p-4 text-xs text-ink-faint">Loading editor…</p>}
                    >
                      {/* Keyed on the path ALONE. Including the content hash meant
                          every autosave changed the key and remounted the editor,
                          throwing caret and scroll position back to the top.
                          Content updates are pushed in as a transaction instead. */}
                      <FileEditor
                        key={fileSelected}
                        path={fileSelected}
                        doc={editorText}
                        onChange={onEditorChange}
                        onSave={() => commitEdit()}
                      />
                    </Suspense>
                  </div>
                </div>
              ) : (
                <FileView file={fileContent} />
              )
            ) : (
              <p className="p-4 text-xs text-ink-faint">Loading…</p>
            )
          ) : diff ? (
            changeSelected && sideBySide ? (
              <SideBySideDiff
                patch={diff.patch}
                onRevertHunk={(i) => {
                  const hunks = splitHunks(diff.patch);
                  const patch = hunks[i];
                  if (!patch) return;
                  if (confirm("Rollback this hunk? The change is discarded from your working tree.")) {
                    revertHunk.mutate(patch);
                  }
                }}
              />
            ) : (
              <UnifiedDiff patch={diff.patch} />
            )
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <FileDiff size={26} className="text-ink-faint" />
              <p className="text-sm text-ink-muted">Pick a path to see its diff.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
