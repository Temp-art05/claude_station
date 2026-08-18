import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Users,
  X,
} from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { authorColor } from "@/lib/authorColor";
import { useUrlState } from "@/lib/useUrlState";
import { MarkdownBody } from "@/features/git/MarkdownView";
import { WorkWithClaude } from "@/features/integrations/WorkWithClaude";

interface PrDetailData {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  mergeable: string;
  createdAt: string;
  labels: string[];
  assignees: string[];
  comments: { author: string; body: string; createdAt: string }[];
  reviews: { author: string; state: string; body: string; submittedAt: string }[];
  commits: { sha: string; message: string; author: string; date: string }[];
  files: { path: string; additions: number; deletions: number }[];
  checks: { name: string; state: string }[];
}

interface PrDiff {
  files: { path: string; patch: string }[];
  truncated: boolean;
}

interface RepoViewer {
  login: string;
  canPush: boolean;
  canAdmin: boolean;
}

const SUB_TABS = [
  { value: "conversation", label: "Conversation" },
  { value: "commits", label: "Commits" },
  { value: "files", label: "Files changed" },
] as const;

function fmtDate(iso: string): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "";
}

function stateBadge(pr: PrDetailData) {
  if (pr.state === "MERGED") return { label: "Merged", cls: "bg-accent/15 text-accent" };
  if (pr.state === "CLOSED") return { label: "Closed", cls: "bg-err/15 text-err" };
  if (pr.isDraft) return { label: "Draft", cls: "bg-surface text-ink-muted" };
  return { label: "Open", cls: "bg-ok/15 text-ok" };
}

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "review dismissed",
  PENDING: "review pending",
};

// git's per-file header lines carry no content — GitHub hides them too.
function isDiffMeta(line: string): boolean {
  return (
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename from") ||
    line.startsWith("rename to") ||
    /^a\/.* b\/.*$/.test(line)
  );
}

function diffLineCls(line: string): string {
  if (line.startsWith("+")) return "bg-ok/10 text-ok";
  if (line.startsWith("-")) return "bg-err/10 text-err";
  if (line.startsWith("@@")) return "text-accent";
  return "text-ink-muted";
}

export function PrDetail({
  owner,
  name,
  number,
  onBack,
}: {
  owner: string;
  name: string;
  number: number;
  onBack: () => void;
}) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const base = `/api/github/${owner}/${name}/pulls/${number}`;
  // Its own param, so a link can point at a PR's Files tab and Back still works.
  const [rawTab, setTab] = useUrlState("prtab", "conversation");
  const tab = SUB_TABS.find((t) => t.value === rawTab)?.value ?? "conversation";
  const [comment, setComment] = useState("");
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);

  const { data: pr, error } = useQuery({
    queryKey: ["gh-pr-detail", owner, name, number],
    queryFn: () => api.get<PrDetailData>(`${base}/detail`),
  });
  const diff = useQuery({
    queryKey: ["gh-pr-diff", owner, name, number],
    queryFn: () => api.get<PrDiff>(`${base}/diff`),
    enabled: tab === "files",
  });
  const { data: viewer } = useQuery({
    queryKey: ["gh-viewer", owner, name],
    queryFn: () => api.get<RepoViewer>(`/api/github/${owner}/${name}/viewer`),
    staleTime: 5 * 60_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["gh-pr-detail", owner, name, number] });
    void qc.invalidateQueries({ queryKey: ["gh-pulls", `${owner}/${name}`] });
  };
  const send = useMutation({
    mutationFn: (input: { kind: "comment" | "approve" | "request-changes" }) =>
      input.kind === "comment"
        ? api.post(`${base}/comment`, { body: comment })
        : api.post(`${base}/review`, { event: input.kind, body: comment || undefined }),
    onSuccess: () => {
      setComment("");
      refresh();
    },
  });
  const merge = useMutation({
    mutationFn: () => api.post(`${base}/merge`, { method: mergeMethod, deleteBranch }),
    onSuccess: refresh,
  });
  const editBase = useMutation({
    mutationFn: (branch: string) => api.post(`${base}/base`, { base: branch }),
    onSuccess: refresh,
  });
  const closeReopen = useMutation({
    mutationFn: (action: "close" | "reopen") => api.post(`${base}/${action}`),
    onSuccess: refresh,
  });
  const draftToggle = useMutation({
    mutationFn: (draft: boolean) => api.post(`${base}/draft`, { draft }),
    onSuccess: refresh,
  });
  const assign = useMutation({
    mutationFn: (input: { add?: string[]; remove?: string[] }) =>
      api.post(`${base}/assignees`, input),
    onSuccess: refresh,
  });

  if (error) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <p className="m3-body-sm text-err">{error instanceof Error ? error.message : "Failed"}</p>
      </div>
    );
  }
  if (!pr) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <p className="m3-body-md text-ink-muted">Loading…</p>
      </div>
    );
  }

  const badge = stateBadge(pr);
  // GitHub requires push access to review/merge, and never lets authors approve their own PR.
  const canReview = !!viewer && viewer.canPush && viewer.login !== pr.author;
  const reviewHint = !viewer
    ? "Checking permissions…"
    : !viewer.canPush
      ? "You don't have push access"
      : viewer.login === pr.author
        ? "You can't approve your own PR"
        : undefined;
  const pushHint = !viewer
    ? "Checking permissions…"
    : !viewer.canPush
      ? "You don't have push access"
      : undefined;
  // GitHub refuses the merge outright, so the button must not look available.
  const conflicted = pr.mergeable === "CONFLICTING";
  const mergeHint =
    pushHint ?? (conflicted ? `Resolve conflicts with ${pr.baseRefName} first` : undefined);
  // Review + comment events interleave on GitHub's conversation timeline.
  const timeline = [
    ...pr.comments.map((c) => ({ ...c, kind: "comment" as const, at: c.createdAt })),
    ...pr.reviews.map((r) => ({ ...r, kind: "review" as const, at: r.submittedAt })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <div>
      <BackButton onBack={onBack} />

      <div className="mb-1 flex items-start gap-2">
        <h2 className="m3-headline-sm min-w-0 flex-1 leading-snug text-ink">
          {pr.title} <span className="font-normal text-ink-muted">#{pr.number}</span>
        </h2>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 text-ink-faint transition-colors duration-150 hover:text-ink"
        >
          <ExternalLink size={16} />
        </a>
      </div>

      <div className="mb-3 flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 m3-label-md text-ink-muted">
          <span
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${badge.cls}`}
          >
            {pr.state === "MERGED" ? <GitMerge size={16} /> : <GitPullRequest size={16} />}
            {badge.label}
          </span>
          <span>
            <span className="font-bold tracking-tight" style={{ color: authorColor(pr.author) }}>
              {pr.author}
            </span>{" "}
            wants to merge {pr.commits.length} commit{pr.commits.length === 1 ? "" : "s"} into{" "}
            <BaseBranchControl
              owner={owner}
              name={name}
              pr={pr}
              pending={editBase.isPending}
              onPick={(branch) => editBase.mutate(branch)}
            />{" "}
            from <code className="font-mono">{pr.headRefName}</code>
          </span>
          <span className="text-ok">+{pr.additions}</span>
          <span className="text-err">−{pr.deletions}</span>
          <span>{pr.changedFiles} files</span>
          {pr.labels.map((l) => (
            <Badge key={l}>{l}</Badge>
          ))}
          {pr.assignees.map((a) => (
            <Badge key={a} tone="accent">
              @{a}
            </Badge>
          ))}
          {pr.checks.map((c) => (
            <span
              key={c.name}
              className="flex items-center gap-0.5 m3-label-md text-ink-muted"
              title={c.name}
            >
              {["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.state) ? (
                <Check size={16} className="text-ok" />
              ) : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(c.state) ? (
                <X size={16} className="text-err" />
              ) : (
                <span className="inline-block size-2 rounded-full bg-warn" />
              )}
              {c.name}
            </span>
          ))}
        </div>

        {/* Status the reviewer acts on sits under the CTA, not buried in the meta run-on.
            Assign lives here too — it used to be below the whole conversation. */}
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {assign.isError && (
              <span className="m3-body-sm text-err">
                {assign.error instanceof Error ? assign.error.message : "Assign failed"}
              </span>
            )}
            {pr.state === "OPEN" && (
              <AssigneeMenu
                owner={owner}
                name={name}
                assignees={pr.assignees}
                pending={assign.isPending}
                onToggle={(user, assigned) =>
                  assign.mutate(assigned ? { remove: [user] } : { add: [user] })
                }
              />
            )}
            <WorkWithClaude
              endpoint={`/api/github/${owner}/${name}/pr/${pr.number}/work-with-claude`}
              label="Work with Claude"
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {pr.reviewDecision === "APPROVED" && (
              <Badge tone="ok" glow>
                approved
              </Badge>
            )}
            {pr.reviewDecision === "CHANGES_REQUESTED" && (
              <Badge tone="err" glow>
                changes requested
              </Badge>
            )}
            {pr.reviewDecision === "REVIEW_REQUIRED" && (
              <Badge tone="warn" glow>
                review required
              </Badge>
            )}
            {pr.state === "OPEN" && pr.mergeable === "CONFLICTING" && (
              <Badge tone="err" glow>
                ⚠ conflicts
              </Badge>
            )}
            {pr.state === "OPEN" && pr.mergeable === "MERGEABLE" && (
              <Badge tone="ok" glow>
                mergeable
              </Badge>
            )}
          </div>
        </div>
      </div>

      <Tabs
        tabs={SUB_TABS.map((t) => ({
          ...t,
          label:
            t.value === "commits"
              ? `Commits (${pr.commits.length})`
              : t.value === "files"
                ? `Files changed (${pr.changedFiles})`
                : t.label,
        }))}
        value={tab}
        onChange={setTab}
        className="mb-3"
      />

      {tab === "conversation" && (
        <div className="space-y-2">
          <TimelineCard author={pr.author} at={pr.createdAt} body={pr.body || "(no description)"} />
          {timeline.map((item, i) =>
            item.kind === "review" && !item.body ? (
              <p key={i} className="px-1 m3-label-md text-ink-muted">
                <span
                  className="font-bold tracking-tight"
                  style={{ color: authorColor(item.author) }}
                >
                  {item.author}
                </span>{" "}
                {REVIEW_LABEL[item.state] ?? item.state.toLowerCase()} · {fmtDate(item.at)}
              </p>
            ) : (
              <TimelineCard
                key={i}
                author={item.author}
                at={item.at}
                body={item.body}
                tag={
                  item.kind === "review"
                    ? (REVIEW_LABEL[item.state] ?? item.state.toLowerCase())
                    : undefined
                }
              />
            ),
          )}

          {pr.state === "OPEN" && (
            <Card className="space-y-3 p-4">
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                placeholder="Leave a comment"
                className="w-full rounded-md px-3.5 py-2.5 text-sm leading-relaxed placeholder:text-ink-faint border border-outline/45 bg-white/3 text-ink transition-[border-color,background-color] duration-200 ease-emphasized hover:border-outline/80 focus:border-primary focus:outline-none"
              />
              {send.isError && (
                <p className="m3-body-sm text-err">
                  {send.error instanceof Error ? send.error.message : "Failed"}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {/* Tooltip lives on the span: disabled buttons have pointer-events none. */}
                <span className="inline-flex gap-2" title={canReview ? undefined : reviewHint}>
                  <Button
                    variant="secondary"
                    className="border-ok/40 text-ok hover:border-ok/70 hover:bg-ok/12"
                    disabled={!canReview || send.isPending}
                    onClick={() => send.mutate({ kind: "approve" })}
                  >
                    <Check size={16} /> Approve
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!canReview || !comment.trim() || send.isPending}
                    onClick={() => send.mutate({ kind: "request-changes" })}
                  >
                    Request changes
                  </Button>
                </span>
                <Button
                  variant="primary"
                  disabled={!comment.trim() || send.isPending}
                  onClick={() => send.mutate({ kind: "comment" })}
                >
                  Comment
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-hairline-strong pt-3.5">
                <Button
                  variant="secondary"
                  disabled={draftToggle.isPending}
                  onClick={() => draftToggle.mutate(!pr.isDraft)}
                >
                  {pr.isDraft ? "Ready for review" : "Convert to draft"}
                </Button>
                {(draftToggle.isError || closeReopen.isError || editBase.isError) && (
                  <span className="m3-body-sm text-err">
                    {[draftToggle.error, closeReopen.error, editBase.error]
                      .filter((e): e is Error => e instanceof Error)
                      .map((e) => e.message)[0] ?? "Action failed"}
                  </span>
                )}
                <div className="ml-auto">
                  <Button
                    variant="danger"
                    disabled={closeReopen.isPending}
                    onClick={() => {
                      void confirm({
                        title: `Close PR #${pr.number} without merging?`,
                        confirmLabel: "Close pull request",
                        tone: "danger",
                      }).then((ok) => ok && closeReopen.mutate("close"));
                    }}
                  >
                    <X size={16} /> Close pull request
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-hairline-strong pt-3.5">
                <GitMerge size={16} className="text-ink" />
                <Select
                  size="md"
                  value={mergeMethod}
                  onChange={(v) => setMergeMethod(v as typeof mergeMethod)}
                  options={[
                    { value: "squash", label: "Squash and merge" },
                    { value: "merge", label: "Create a merge commit" },
                    { value: "rebase", label: "Rebase and merge" },
                  ]}
                />
                <label className="flex items-center gap-1.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={deleteBranch}
                    onChange={(e) => setDeleteBranch(e.target.checked)}
                    className="h-4 w-4"
                  />
                  delete branch
                </label>
                {conflicted && (
                  <span className="m3-body-sm font-semibold text-err">has conflicts</span>
                )}
                {merge.isError && (
                  <span className="m3-body-sm text-err">
                    {merge.error instanceof Error ? merge.error.message : "Merge failed"}
                  </span>
                )}
                <div className="ml-auto" title={mergeHint}>
                  <Button
                    variant="primary"
                    disabled={!viewer?.canPush || conflicted || merge.isPending}
                    onClick={() => {
                      void confirm({
                        title: `${mergeMethod} PR #${pr.number} into ${pr.baseRefName}?`,
                        body: deleteBranch
                          ? `The branch ${pr.headRefName} will be deleted.`
                          : undefined,
                        confirmLabel: "Merge",
                      }).then((ok) => ok && merge.mutate());
                    }}
                  >
                    <GitMerge size={16} /> Merge
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {pr.state === "CLOSED" && (
            <Card className="flex flex-wrap items-center gap-2 p-3.5">
              <span className="m3-body-sm text-ink-muted">
                This pull request is closed without being merged.
              </span>
              {closeReopen.isError && (
                <span className="text-xs text-err">
                  {closeReopen.error instanceof Error ? closeReopen.error.message : "Failed"}
                </span>
              )}
              <div className="ml-auto">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={closeReopen.isPending}
                  onClick={() => closeReopen.mutate("reopen")}
                >
                  <GitPullRequest size={16} /> Reopen pull request
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === "commits" && (
        <div className="space-y-1.5">
          {pr.commits.map((c) => (
            <Card key={c.sha} className="p-3">
              <div className="flex items-center gap-2">
                <GitCommitHorizontal size={16} className="shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{c.message}</span>
                <span
                  className="shrink-0 m3-label-md font-bold tracking-tight"
                  style={{ color: authorColor(c.author) }}
                >
                  {c.author}
                </span>
                <span className="shrink-0 m3-label-md text-ink-muted">{fmtDate(c.date)}</span>
                <a
                  href={`https://github.com/${owner}/${name}/commit/${c.sha}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {c.sha}
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === "files" && (
        <div className="space-y-2">
          {diff.error && (
            <p className="text-xs text-err">
              {diff.error instanceof Error ? diff.error.message : "Failed to load diff"}
            </p>
          )}
          {diff.data?.truncated && (
            <p className="m3-label-sm text-warn">
              Diff is over 2 MB — showing a truncated version, open GitHub for the rest.
            </p>
          )}
          {diff.data?.files.map((f) => {
            const stat = pr.files.find((x) => x.path === f.path);
            return (
              <Card key={f.path} className="overflow-hidden p-0">
                <div className="flex items-center gap-2.5 border-b border-hairline bg-surface-2 px-4 py-3">
                  <span className="min-w-0 flex-1 truncate font-mono m3-label-md font-medium text-ink">
                    {f.path}
                  </span>
                  {stat && (
                    <span className="m3-label-md font-medium">
                      <span className="text-ok">+{stat.additions}</span>{" "}
                      <span className="text-err">−{stat.deletions}</span>
                    </span>
                  )}
                </div>
                <pre className="max-h-[50vh] overflow-auto font-mono m3-label-md leading-[1.6]">
                  {f.patch
                    .split("\n")
                    .filter((l) => !isDiffMeta(l))
                    .slice(1) // drop the `a/... b/...` remnant of the diff --git line
                    .map((l, i) => (
                      <div key={i} className={`px-3 ${diffLineCls(l)}`}>
                        {l || " "}
                      </div>
                    ))}
                </pre>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Closes a popover when the pointer goes down outside `ref`. */
function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ref, open, close]);
}

function BaseBranchControl({
  owner,
  name,
  pr,
  pending,
  onPick,
}: {
  owner: string;
  name: string;
  pr: PrDetailData;
  pending: boolean;
  onPick: (branch: string) => void;
}) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  const branches = useQuery({
    queryKey: ["gh-branches", owner, name],
    queryFn: () =>
      api.get<{ defaultBranch: string; branches: { name: string }[] }>(
        `/api/github/${owner}/${name}/branches`,
      ),
    enabled: open,
  });

  if (pr.state !== "OPEN") return <code className="font-mono">{pr.baseRefName}</code>;

  // GitHub rejects a base equal to the head, and the current base is a no-op.
  const options = (branches.data?.branches ?? []).filter(
    (b) => b.name !== pr.baseRefName && b.name !== pr.headRefName,
  );
  return (
    <span ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        title="Change base branch"
        className="inline-flex cursor-pointer items-center gap-0.5 rounded-sm border border-outline/50 bg-white/4 px-1.5 font-mono text-ink transition-colors duration-150 hover:border-primary/60 disabled:opacity-50"
      >
        {pending ? "changing…" : pr.baseRefName} <ChevronDown size={16} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-hairline-strong bg-surface-2 p-1 shadow-xl backdrop-blur-md">
          {branches.isLoading && <p className="px-2 py-1 text-xs text-ink-muted">Loading…</p>}
          {branches.error && (
            <p className="px-2 py-1 text-xs text-err">
              {branches.error instanceof Error ? branches.error.message : "Failed to load branches"}
            </p>
          )}
          {options.map((b) => (
            <button
              key={b.name}
              onClick={() => {
                setOpen(false);
                void confirm({
                  title: `Change base of #${pr.number}?`,
                  body: `From ${pr.baseRefName} to ${b.name}.`,
                  confirmLabel: "Change base",
                }).then((ok) => ok && onPick(b.name));
              }}
              className="block w-full cursor-pointer truncate rounded px-2 py-1 text-left font-mono text-xs text-ink hover:bg-surface"
            >
              {b.name}
            </button>
          ))}
          {branches.data && options.length === 0 && (
            <p className="px-2 py-1 text-xs text-ink-muted">No other branches</p>
          )}
        </div>
      )}
    </span>
  );
}

function AssigneeMenu({
  owner,
  name,
  assignees,
  pending,
  onToggle,
}: {
  owner: string;
  name: string;
  assignees: string[];
  pending: boolean;
  onToggle: (user: string, assigned: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  const users = useQuery({
    queryKey: ["gh-assignable", owner, name],
    queryFn: () => api.get<string[]>(`/api/github/${owner}/${name}/assignable-users`),
    enabled: open,
  });

  // Substring match, not prefix — org logins are often `firstname-company`.
  const needle = query.trim().toLowerCase();
  const matches = (users.data ?? []).filter((u) => u.toLowerCase().includes(needle));

  return (
    <div ref={ref} className="relative">
      <Button
        variant="secondary"
        onClick={() => {
          setQuery("");
          setOpen((v) => !v);
        }}
      >
        <Users size={16} /> Assign{assignees.length > 0 ? ` (${assignees.length})` : ""}
      </Button>
      {open && (
        <div className="absolute top-full right-0 z-20 mt-1 flex max-h-80 w-72 flex-col rounded-lg border border-hairline-strong bg-surface-2 p-1.5 shadow-xl backdrop-blur-md">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people…"
            className="mb-1.5 w-full rounded-md px-3 py-1.5 text-sm placeholder:text-ink-faint border border-outline/45 bg-white/3 text-ink transition-[border-color,background-color] duration-200 ease-emphasized hover:border-outline/80 focus:border-primary focus:outline-none"
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {users.isLoading && <p className="px-2 py-1.5 text-sm text-ink-muted">Loading…</p>}
            {users.error && (
              <p className="px-2 py-1.5 text-sm text-err">
                {users.error instanceof Error ? users.error.message : "Failed to load users"}
              </p>
            )}
            {matches.map((u) => {
              const assigned = assignees.includes(u);
              return (
                <button
                  key={u}
                  disabled={pending}
                  onClick={() => onToggle(u, assigned)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm font-semibold text-white hover:bg-surface disabled:opacity-50"
                >
                  <Check size={16} className={assigned ? "text-ok" : "invisible"} />
                  {u}
                </button>
              );
            })}
            {users.data && matches.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-ink-muted">
                {needle ? `No match for “${query.trim()}”` : "No assignable users"}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="mb-3 flex items-center gap-1 m3-body-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft size={16} /> Pull requests
    </button>
  );
}

function TimelineCard({
  author,
  at,
  body,
  tag,
}: {
  author: string;
  at: string;
  body: string;
  tag?: string;
}) {
  return (
    <Card className="p-0">
      <div className="m3-body-sm flex items-center gap-2.5 border-b border-hairline bg-surface-2 px-4 py-3">
        <span className="font-bold tracking-tight" style={{ color: authorColor(author) }}>
          {author}
        </span>
        {tag && <Badge>{tag}</Badge>}
        <span className="ml-auto m3-label-md text-ink-faint">{fmtDate(at)}</span>
      </div>
      <MarkdownBody source={body} breaks className="px-3.5 py-3" />
    </Card>
  );
}
