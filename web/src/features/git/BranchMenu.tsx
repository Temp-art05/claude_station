import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  GitBranch,
  GitMerge,
  ListRestart,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Branches {
  current: string;
  local: { name: string; upstream: string | null }[];
  remote: string[];
  inProgress: "merge" | "rebase" | null;
}

type Op =
  | "checkout"
  | "create-branch"
  | "delete-branch"
  | "fetch"
  | "pull"
  | "pull-rebase"
  | "push"
  | "merge"
  | "merge-squash"
  | "rebase"
  | "abort";

interface Props {
  projectId: string;
  pathId: string;
  /** Refresh status/diff/tree after anything that moves the working tree. */
  onChanged: () => void;
  onNotice: (tone: "ok" | "err", text: string) => void;
}

/** Android Studio-style branch popup: search, sync ops, local/remote lists. */
export function BranchMenu({ projectId, pathId, onChanged, onNotice }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const branchesKey = ["git-branches", projectId, pathId];
  const { data } = useQuery({
    queryKey: branchesKey,
    queryFn: () => api.get<Branches>(`/api/projects/${projectId}/git/branches?pathId=${pathId}`),
    enabled: !!pathId,
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const run = useMutation({
    mutationFn: (body: { op: Op; branch?: string; force?: boolean }) =>
      api.post<{ ok: boolean; output: string }>(`/api/projects/${projectId}/git/op`, {
        ...body,
        pathId,
      }),
    onSuccess: (r, vars) => {
      onNotice("ok", `git ${vars.op}${vars.branch ? ` ${vars.branch}` : ""} ✓`);
      void qc.invalidateQueries({ queryKey: branchesKey });
      void qc.invalidateQueries({ queryKey: ["git-log", projectId, pathId] });
      onChanged();
    },
    onError: (err: unknown) =>
      onNotice("err", err instanceof Error ? err.message : String(err)),
  });

  const doOp = (op: Op, branch?: string, force?: boolean) => {
    setOpen(false);
    run.mutate({ op, branch, force });
  };

  const current = data?.current ?? "…";
  const q = filter.toLowerCase();
  const local = (data?.local ?? []).filter((b) => b.name.toLowerCase().includes(q));
  const remote = (data?.remote ?? []).filter((b) => b.toLowerCase().includes(q));

  const topAction = (icon: React.ReactNode, label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      disabled={run.isPending}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
    >
      {icon}
      {label}
    </button>
  );

  const branchRow = (name: string, isCurrent: boolean, isLocal: boolean) => (
    <div
      key={name}
      className={cn(
        "group flex items-center gap-1 rounded-md px-2 py-0.5",
        isCurrent ? "bg-accent/10 text-accent" : "hover:bg-surface-2",
      )}
    >
      <button
        onClick={() => !isCurrent && doOp("checkout", name)}
        disabled={isCurrent || run.isPending}
        title={isCurrent ? "Current branch" : `Checkout ${name}`}
        className={cn(
          "min-w-0 flex-1 truncate py-0.5 text-left font-mono text-[11px]",
          !isCurrent && "cursor-pointer",
        )}
      >
        {name}
      </button>
      {!isCurrent && (
        <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => doOp("merge", name)}
            title={`Merge ${name} into ${current}`}
            className="cursor-pointer rounded p-0.5 text-ink-faint hover:text-ink"
          >
            <GitMerge size={11} />
          </button>
          <button
            onClick={() => doOp("rebase", name)}
            title={`Rebase ${current} onto ${name}`}
            className="cursor-pointer rounded p-0.5 text-ink-faint hover:text-ink"
          >
            <ListRestart size={11} />
          </button>
          {isLocal && (
            <button
              onClick={() => {
                if (confirm(`Delete branch "${name}"?`)) doOp("delete-branch", name);
              }}
              title={`Delete ${name}`}
              className="cursor-pointer rounded p-0.5 text-ink-faint hover:text-err"
            >
              <Trash2 size={11} />
            </button>
          )}
        </span>
      )}
    </div>
  );

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-hairline px-2 py-1 text-[11px] text-ink-muted hover:border-hairline-strong hover:text-ink"
        title="Branch operations"
      >
        <GitBranch size={11} className="text-accent" />
        <span className="min-w-0 flex-1 truncate text-left font-mono">
          {run.isPending ? "working…" : current}
        </span>
        <ChevronDown size={11} />
      </button>

      {data?.inProgress && (
        <div className="mt-1 flex items-center justify-between rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-[10.5px] text-warn">
          {data.inProgress} in progress — resolve in a terminal
          <button
            onClick={() => doOp("abort")}
            className="cursor-pointer rounded-pill border border-warn/40 px-1.5 font-medium hover:bg-warn/20"
          >
            Abort
          </button>
        </div>
      )}

      {open && (
        <div className="absolute left-0 z-20 mt-1 w-72 rounded-lg border border-hairline-strong bg-surface-2 p-2 shadow-xl backdrop-blur-md">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search branches…"
            className="mb-1.5 h-7 w-full rounded-md border border-edge bg-surface px-2 text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <div className="mb-1.5 border-b border-hairline pb-1.5">
            {topAction(<RefreshCw size={11} />, "Fetch all", () => doOp("fetch"))}
            {topAction(<ArrowDownToLine size={11} />, "Pull", () => doOp("pull"))}
            {topAction(<ArrowDownToLine size={11} />, "Pull --rebase", () => doOp("pull-rebase"))}
            {topAction(<ArrowUpFromLine size={11} />, "Push", () => doOp("push"))}
            {creating ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = newName.trim();
                  if (name) {
                    setCreating(false);
                    setNewName("");
                    doOp("create-branch", name);
                  }
                }}
                className="flex items-center gap-1 px-2 py-1"
              >
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="new-branch-name"
                  className="h-6 min-w-0 flex-1 rounded-md border border-edge bg-surface px-1.5 font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
                />
                <button type="submit" className="cursor-pointer text-[11px] text-accent">
                  create
                </button>
              </form>
            ) : (
              topAction(<Plus size={11} />, `New branch from ${current}…`, () =>
                setCreating(true),
              )
            )}
          </div>

          <div className="max-h-64 overflow-y-auto">
            <p className="px-2 py-0.5 text-[10px] font-bold tracking-wide text-ink-faint uppercase">
              Local
            </p>
            {local.map((b) => branchRow(b.name, b.name === current, true))}
            {remote.length > 0 && (
              <p className="px-2 py-0.5 pt-1.5 text-[10px] font-bold tracking-wide text-ink-faint uppercase">
                Remote
              </p>
            )}
            {remote.map((b) => branchRow(b, false, false))}
          </div>
        </div>
      )}
    </div>
  );
}
