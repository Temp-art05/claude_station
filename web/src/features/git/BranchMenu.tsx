import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  GitMerge,
  ListRestart,
  Plus,
  RefreshCw,
  Trash2,
} from "@/components/ui/icons";
import { branchAncestors, buildBranchTree, type BranchNode } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Branches {
  current: string;
  local: { name: string; upstream: string | null }[];
  remote: string[];
  inProgress: "merge" | "rebase" | null;
}

type Op =
  | "remove-worktree"
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
  /** Explicit open/closed per folder path; absent = the default for that folder. */
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  /** Branch git refused to delete because its commits aren't merged anywhere. */
  const [unmerged, setUnmerged] = useState<string | null>(null);
  /**
   * A worktree of ours is holding the branch, so git refuses the op. `retry` is
   * the op to run again once the worktree is gone; `holdsWork` flips on when the
   * server reports the worktree isn't empty, turning this into a second ask.
   */
  const [blocking, setBlocking] = useState<{
    worktreePath: string;
    retry: { op: Op; branch?: string };
    holdsWork: boolean;
  } | null>(null);
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
    mutationFn: (body: { op: Op; branch?: string; force?: boolean; worktreePath?: string }) =>
      api.post<{ ok: boolean; output: string }>(`/api/projects/${projectId}/git/op`, {
        ...body,
        pathId,
      }),
    onSuccess: (r, vars) => {
      onNotice("ok", `git ${vars.op}${vars.branch ? ` ${vars.branch}` : ""} ✓`);
      void qc.invalidateQueries({ queryKey: branchesKey });
      void qc.invalidateQueries({ queryKey: ["git-log", projectId, pathId] });
      onChanged();
      // The worktree is gone — run whatever it was blocking.
      if (vars.op === "remove-worktree" && blocking) {
        const retry = blocking.retry;
        setBlocking(null);
        run.mutate(retry);
      }
    },
    onError: (err: unknown, vars) => {
      const message = err instanceof Error ? err.message : String(err);

      // git refuses `branch -d` when a branch's commits live nowhere else, and
      // tells you to rerun with -D. Worth keeping as a speed bump, but until now
      // it was a dead end: nothing in the UI could pass force, so a backup branch
      // — which by definition holds unmerged commits — could never be cleaned up.
      if (
        vars.op === "delete-branch" &&
        vars.branch &&
        !vars.force &&
        /not fully merged/i.test(message)
      ) {
        setUnmerged(vars.branch);
        return;
      }

      // The removal we offered was refused because the worktree isn't empty. Ask
      // again, this time saying what is at stake.
      if (vars.op === "remove-worktree" && /still holds work/i.test(message)) {
        setBlocking((prev) => (prev ? { ...prev, holdsWork: true } : prev));
        return;
      }

      // A branch checked out in one of our worktrees can be neither switched to
      // nor deleted. git names the path; offer to release it, but only when it is
      // ours — a worktree the user made elsewhere is not ours to remove.
      const held = /already used by worktree at '([^']+)'/.exec(message);
      if (held?.[1] && held[1].includes("/data/worktrees/")) {
        setBlocking({
          worktreePath: held[1],
          retry: { op: vars.op, branch: vars.branch },
          holdsWork: false,
        });
        return;
      }

      onNotice("err", message);
    },
  });

  const doOp = (op: Op, branch?: string, force?: boolean) => {
    setOpen(false);
    run.mutate({ op, branch, force });
  };

  const current = data?.current ?? "…";
  const q = filter.trim().toLowerCase();
  // Filtering happens on full names, so `version/4` still finds version/4.0.0 even
  // though the row itself only shows the last segment.
  const localNames = (data?.local ?? [])
    .map((b) => b.name)
    .filter((name) => name.toLowerCase().includes(q));
  const remoteNames = (data?.remote ?? []).filter((name) => name.toLowerCase().includes(q));
  const localTree = buildBranchTree(localNames);
  const remoteTree = buildBranchTree(remoteNames);

  // Folders start closed, except the ones the current branch lives in. Typing a
  // search opens everything (overrides are dropped on each keystroke) so a match is
  // never hidden behind a collapsed folder — but a folder can still be collapsed by
  // hand while searching.
  const currentFolders = new Set(branchAncestors(current));
  const isOpen = (path: string) => openFolders[path] ?? (q ? true : currentFolders.has(path));
  const toggleFolder = (path: string) =>
    setOpenFolders((prev) => ({ ...prev, [path]: !isOpen(path) }));

  const topAction = (icon: React.ReactNode, label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      disabled={run.isPending}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink-muted hover:bg-white/6 hover:text-ink"
    >
      {icon}
      {label}
    </button>
  );

  /** `label` is what the row shows; `name` is the full ref every op runs against. */
  const branchRow = (
    name: string,
    label: string,
    isCurrent: boolean,
    isLocal: boolean,
    depth: number,
  ) => (
    <div
      key={name}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={cn(
        "group flex items-center gap-1 rounded-md pr-2 py-0.5",
        isCurrent ? "bg-accent/10 text-accent" : "hover:bg-white/6",
      )}
    >
      <button
        onClick={() => !isCurrent && doOp("checkout", name)}
        disabled={isCurrent || run.isPending}
        title={isCurrent ? `Current branch — ${name}` : `Checkout ${name}`}
        className={cn(
          "min-w-0 flex-1 truncate py-0.5 text-left font-mono m3-label-sm",
          !isCurrent && "cursor-pointer",
        )}
      >
        {label}
      </button>
      {!isCurrent && (
        <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => doOp("merge", name)}
            title={`Merge ${name} into ${current}`}
            className="cursor-pointer rounded p-0.5 text-ink-faint hover:text-ink"
          >
            <GitMerge size={16} />
          </button>
          <button
            onClick={() => doOp("rebase", name)}
            title={`Rebase ${current} onto ${name}`}
            className="cursor-pointer rounded p-0.5 text-ink-faint hover:text-ink"
          >
            <ListRestart size={16} />
          </button>
          {isLocal && (
            <button
              // No confirm dialog: git itself refuses `branch -d` on anything not
              // fully merged and that error surfaces as a notice, so the case worth
              // guarding is already guarded — a prompt only slows down tidying up.
              // `run.mutate` instead of `doOp` keeps the popup open, because
              // clearing out stale branches is something you do several at a time.
              onClick={() => run.mutate({ op: "delete-branch", branch: name })}
              title={`Delete ${name}`}
              className="cursor-pointer rounded p-0.5 text-ink-faint hover:text-err"
            >
              <Trash2 size={16} />
            </button>
          )}
        </span>
      )}
    </div>
  );

  const nodeRows = (nodes: BranchNode[], isLocal: boolean, depth = 0): React.ReactNode[] =>
    nodes.map((node) => {
      if (node.kind === "leaf") {
        return branchRow(node.name, node.label, node.name === current, isLocal, depth);
      }
      const expanded = isOpen(node.path);
      return (
        <div key={`dir:${node.path}`}>
          <button
            onClick={() => toggleFolder(node.path)}
            style={{ paddingLeft: 8 + depth * 12 }}
            className="flex w-full cursor-pointer items-center gap-1 rounded-md py-0.5 pr-2 text-left text-ink-muted hover:bg-white/6 hover:text-ink"
            title={`${expanded ? "Collapse" : "Expand"} ${node.path}`}
          >
            <ChevronRight
              size={16}
              className={cn("shrink-0 transition-transform", expanded && "rotate-90")}
            />
            <Folder size={16} className="shrink-0 text-ink-faint" />
            <span className="min-w-0 flex-1 truncate font-mono m3-label-sm">{node.label}</span>
            <span className="shrink-0 m3-label-sm text-ink-faint">{node.count}</span>
          </button>
          {expanded && nodeRows(node.children, isLocal, depth + 1)}
        </div>
      );
    });

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-hairline px-2 py-1 m3-label-sm text-ink-muted hover:border-hairline-strong hover:text-ink"
        title="Branch operations"
      >
        <GitBranch size={16} className="text-accent" />
        <span className="min-w-0 flex-1 truncate text-left font-mono">
          {run.isPending ? "working…" : current}
        </span>
        <ChevronDown size={16} />
      </button>

      {data?.inProgress && (
        <div className="mt-1 flex items-center justify-between rounded-md border border-warn/40 bg-warn/10 px-2 py-1 m3-label-sm text-warn">
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
            onChange={(e) => {
              setFilter(e.target.value);
              setOpenFolders({});
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Escape clears a search first, and only closes the popup when there
              // is nothing left to clear.
              if (filter) setFilter("");
              else setOpen(false);
            }}
            placeholder="Search branches…"
            className="mb-1.5 m3-body-sm h-8 w-full rounded-md px-2.5 border border-outline/45 bg-white/3 text-ink transition-[border-color,background-color] duration-200 ease-emphasized hover:border-outline/80 focus:border-primary focus:outline-none placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <div className="mb-1.5 border-b border-hairline pb-1.5">
            {topAction(<RefreshCw size={16} />, "Fetch all", () => doOp("fetch"))}
            {topAction(<ArrowDownToLine size={16} />, "Pull", () => doOp("pull"))}
            {topAction(<ArrowDownToLine size={16} />, "Pull --rebase", () => doOp("pull-rebase"))}
            {topAction(<ArrowUpFromLine size={16} />, "Push", () => doOp("push"))}
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
                  className="m3-label-md h-7 min-w-0 flex-1 rounded-md px-2 font-mono border border-outline/45 bg-white/3 text-ink transition-[border-color,background-color] duration-200 ease-emphasized hover:border-outline/80 focus:border-primary focus:outline-none"
                />
                <button type="submit" className="cursor-pointer m3-label-sm text-accent">
                  create
                </button>
              </form>
            ) : (
              topAction(<Plus size={16} />, `New branch from ${current}…`, () => setCreating(true))
            )}
          </div>

          <div className="max-h-64 overflow-y-auto">
            {localNames.length > 0 && (
              <p className="px-2 py-0.5 m3-label-sm font-bold tracking-wide text-ink-faint uppercase">
                Local
              </p>
            )}
            {nodeRows(localTree, true)}
            {remoteNames.length > 0 && (
              <p className="px-2 py-0.5 pt-1.5 m3-label-sm font-bold tracking-wide text-ink-faint uppercase">
                Remote
              </p>
            )}
            {nodeRows(remoteTree, false)}
            {localNames.length === 0 && remoteNames.length === 0 && (
              <p className="px-2 py-1 m3-label-sm text-ink-faint">No branch matches “{filter}”</p>
            )}
          </div>
        </div>
      )}

      {blocking && (
        <Dialog
          open
          onClose={() => setBlocking(null)}
          title="A worktree is holding this branch"
          className="max-w-lg"
        >
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              This branch is checked out in a worktree Claude Station made for a session, so git
              won't let you switch to it or delete it:
            </p>
            <p className="rounded-md border border-hairline bg-white/4 px-2 py-1.5 font-mono m3-label-sm break-all text-ink-muted">
              {blocking.worktreePath}
            </p>
            {blocking.holdsWork ? (
              <p className="text-sm text-err">
                That worktree still has uncommitted changes, or commits that exist on no other
                branch. Removing it now throws them away.
              </p>
            ) : (
              <p className="text-sm text-ink-muted">
                It has nothing unsaved. Removing it frees the branch and then retries.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setBlocking(null)}>
                Cancel
              </Button>
              <Button
                variant={blocking.holdsWork ? "danger" : "primary"}
                disabled={run.isPending}
                onClick={() =>
                  run.mutate({
                    op: "remove-worktree",
                    worktreePath: blocking.worktreePath,
                    force: blocking.holdsWork,
                  })
                }
              >
                {blocking.holdsWork ? "Remove and lose that work" : "Remove worktree"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {unmerged && (
        <Dialog
          open
          onClose={() => setUnmerged(null)}
          title="Branch is not fully merged"
          className="max-w-md"
        >
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              <span className="font-mono text-ink">{unmerged}</span> has commits that aren't on any
              other branch. Deleting it leaves them reachable only through the reflog.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setUnmerged(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                disabled={run.isPending}
                onClick={() => {
                  run.mutate({ op: "delete-branch", branch: unmerged, force: true });
                  setUnmerged(null);
                }}
              >
                Delete anyway
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
