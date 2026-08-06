import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Code,
  Columns2,
  Eye,
  FileDiff,
  LocateFixed,
  RotateCcw,
  Rows3,
} from "lucide-react";
import type { Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BranchMenu } from "./BranchMenu";
import { FileTree } from "./FileTree";
import { MarkdownView } from "./MarkdownView";
import { SideBySideDiff, splitHunks } from "./SideBySideDiff";

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
}

interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  refs: string[];
}

const STATUS_TONE: Record<string, string> = {
  M: "text-warn",
  A: "text-ok",
  "?": "text-ok",
  D: "text-err",
  R: "text-accent",
};

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

type Selection =
  | { type: "change"; path: string }
  | { type: "file"; path: string }
  | { type: "commit"; hash: string; subject: string; file?: string }
  | null;

export function DiffTab({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [pathId, setPathId] = useState(project.paths[0]?.id ?? "");
  const [selected, setSelected] = useState<Selection>(null);
  // Everything starts checked, Android Studio style — we track the unchecks.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [sideBySide, setSideBySide] = useState(true);
  const [bottomView, setBottomView] = useState<"files" | "history">("files");
  const [mdSource, setMdSource] = useState(false); // .md viewer: preview ⟷ source
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const statusKey = ["git-status", project.id, pathId];
  const { data: status } = useQuery({
    queryKey: statusKey,
    queryFn: () =>
      api.get<StatusResponse>(`/api/projects/${project.id}/git/status?pathId=${pathId}`),
    enabled: !!pathId,
    refetchInterval: 5000,
  });

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

  const revert = useMutation({
    mutationFn: (files: string[]) =>
      api.post(`/api/projects/${project.id}/git/revert`, { files, pathId }),
    onSuccess: refreshAll,
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
    },
    onError: (err: unknown) =>
      setNotice({ tone: "err", text: err instanceof Error ? err.message : String(err) }),
  });

  const changes = status?.files ?? [];
  const checkedFiles = changes.map((f) => f.path).filter((p) => !unchecked.has(p));
  const changedSet = new Set(changes.map((f) => f.path));
  const canCommit =
    checkedFiles.length > 0 && (amend || message.trim().length > 0) && !doCommit.isPending;

  const toggleCheck = (path: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left: repo + branch, changes + commit, files / history ────────── */}
      <div className="flex w-80 shrink-0 flex-col border-r border-edge">
        <div className="space-y-1.5 border-b border-hairline p-3 pb-2">
          <select
            value={pathId}
            onChange={(e) => {
              setPathId(e.target.value);
              setSelected(null);
              setUnchecked(new Set());
            }}
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
        <div className="flex max-h-[42%] flex-col border-b border-hairline">
          <button
            onClick={() => setSelected(null)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium",
              selected === null ? "bg-surface-3" : "hover:bg-surface-2",
            )}
          >
            Changes
            <Badge>{changes.length}</Badge>
            {status && !status.isRepo && <span className="text-ink-faint">not a repo</span>}
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
            {changes.length === 0 && (
              <p className="px-2 py-1 text-xs text-ink-faint">Working tree clean.</p>
            )}
            {changes.map((f) => (
              <div
                key={f.path}
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
              </div>
            ))}
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
                  "truncate text-[10.5px]",
                  notice.tone === "ok" ? "text-ok" : "text-err",
                )}
                title={notice.text}
              >
                {notice.text}
              </p>
            )}
          </div>
        </div>

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
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5 pt-0.5">
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
            {selected.type === "file" && selected.path.toLowerCase().endsWith(".md") && (
              <div className="ml-auto flex items-center gap-1">
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
                  title="Raw source with line numbers"
                >
                  <Code size={12} /> Source
                </Button>
              </div>
            )}
            {selected.type === "change" && (
              <>
                <Badge>{changes.find((f) => f.path === selected.path)?.status ?? ""}</Badge>
                <div className="ml-auto flex items-center gap-1">
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
