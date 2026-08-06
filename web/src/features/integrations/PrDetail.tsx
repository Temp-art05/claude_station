import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  X,
} from "lucide-react";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { api } from "@/lib/api";
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
  const qc = useQueryClient();
  const base = `/api/github/${owner}/${name}/pulls/${number}`;
  const [tab, setTab] = useState<(typeof SUB_TABS)[number]["value"]>("conversation");
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

  if (error) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <p className="text-xs text-err">{error instanceof Error ? error.message : "Failed"}</p>
      </div>
    );
  }
  if (!pr) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <p className="text-sm text-ink-muted">Loading…</p>
      </div>
    );
  }

  const badge = stateBadge(pr);
  // Review + comment events interleave on GitHub's conversation timeline.
  const timeline = [
    ...pr.comments.map((c) => ({ ...c, kind: "comment" as const, at: c.createdAt })),
    ...pr.reviews.map((r) => ({ ...r, kind: "review" as const, at: r.submittedAt })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <div>
      <BackButton onBack={onBack} />

      <div className="mb-1 flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold">
          {pr.title} <span className="font-normal text-ink-faint">#{pr.number}</span>
        </h2>
        <a href={pr.url} target="_blank" rel="noreferrer" className="mt-1 text-ink-faint hover:text-ink">
          <ExternalLink size={14} />
        </a>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${badge.cls}`}>
          {pr.state === "MERGED" ? <GitMerge size={11} /> : <GitPullRequest size={11} />}
          {badge.label}
        </span>
        <span>
          <span className="text-ink">{pr.author}</span> wants to merge{" "}
          {pr.commits.length} commit{pr.commits.length === 1 ? "" : "s"} into{" "}
          <code className="font-mono">{pr.baseRefName}</code> from{" "}
          <code className="font-mono">{pr.headRefName}</code>
        </span>
        <span className="text-ok">+{pr.additions}</span>
        <span className="text-err">−{pr.deletions}</span>
        <span>{pr.changedFiles} files</span>
        {pr.labels.map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
        {pr.reviewDecision === "APPROVED" && <Badge tone="ok">approved</Badge>}
        {pr.reviewDecision === "CHANGES_REQUESTED" && <Badge tone="err">changes requested</Badge>}
        {pr.state === "OPEN" && pr.mergeable === "CONFLICTING" && (
          <Badge tone="err">⚠ conflicts</Badge>
        )}
        {pr.state === "OPEN" && pr.mergeable === "MERGEABLE" && <Badge tone="ok">mergeable</Badge>}
        {pr.checks.map((c) => (
          <span key={c.name} className="flex items-center gap-0.5 text-[10.5px] text-ink-faint" title={c.name}>
            {["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.state) ? (
              <Check size={10} className="text-ok" />
            ) : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(c.state) ? (
              <X size={10} className="text-err" />
            ) : (
              <span className="inline-block h-2 w-2 rounded-full bg-warn" />
            )}
            {c.name}
          </span>
        ))}
        <div className="ml-auto">
          <WorkWithClaude
            endpoint={`/api/github/${owner}/${name}/pr/${pr.number}/work-with-claude`}
            label="Work with Claude"
          />
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
              <p key={i} className="px-1 text-xs text-ink-faint">
                <span className="text-ink-muted">{item.author}</span>{" "}
                {REVIEW_LABEL[item.state] ?? item.state.toLowerCase()} · {fmtDate(item.at)}
              </p>
            ) : (
              <TimelineCard
                key={i}
                author={item.author}
                at={item.at}
                body={item.body}
                tag={item.kind === "review" ? REVIEW_LABEL[item.state] ?? item.state.toLowerCase() : undefined}
              />
            ),
          )}

          {pr.state === "OPEN" && (
            <Card className="space-y-2 p-3">
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder="Leave a comment"
                className="w-full rounded-md border border-edge bg-surface px-3 py-2 text-xs text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
              />
              {send.isError && (
                <p className="text-xs text-err">
                  {send.error instanceof Error ? send.error.message : "Failed"}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={send.isPending}
                  onClick={() => send.mutate({ kind: "approve" })}
                >
                  <Check size={12} /> Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!comment.trim() || send.isPending}
                  onClick={() => send.mutate({ kind: "request-changes" })}
                >
                  Request changes
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!comment.trim() || send.isPending}
                  onClick={() => send.mutate({ kind: "comment" })}
                >
                  Comment
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-edge pt-2">
                <GitMerge size={13} className="text-ink-muted" />
                <select
                  value={mergeMethod}
                  onChange={(e) => setMergeMethod(e.target.value as typeof mergeMethod)}
                  className="h-7 rounded-md border border-edge bg-surface px-2 text-xs text-ink"
                >
                  <option value="squash">Squash and merge</option>
                  <option value="merge">Create a merge commit</option>
                  <option value="rebase">Rebase and merge</option>
                </select>
                <label className="flex items-center gap-1 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    checked={deleteBranch}
                    onChange={(e) => setDeleteBranch(e.target.checked)}
                  />
                  delete branch
                </label>
                {pr.mergeable === "CONFLICTING" && (
                  <span className="text-xs text-err">has conflicts</span>
                )}
                {merge.isError && (
                  <span className="text-xs text-err">
                    {merge.error instanceof Error ? merge.error.message : "Merge failed"}
                  </span>
                )}
                <div className="ml-auto">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={merge.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `${mergeMethod} PR #${pr.number} into ${pr.baseRefName}?` +
                            (deleteBranch ? ` The branch ${pr.headRefName} will be deleted.` : ""),
                        )
                      ) {
                        merge.mutate();
                      }
                    }}
                  >
                    <GitMerge size={12} /> Merge
                  </Button>
                </div>
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
                <GitCommitHorizontal size={12} className="shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-sm">{c.message}</span>
                <span className="text-[10.5px] text-ink-faint">{c.author}</span>
                <span className="text-[10.5px] text-ink-faint">{fmtDate(c.date)}</span>
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
            <p className="text-[10.5px] text-warn">
              Diff is over 2 MB — showing a truncated version, open GitHub for the rest.
            </p>
          )}
          {diff.data?.files.map((f) => {
            const stat = pr.files.find((x) => x.path === f.path);
            return (
              <Card key={f.path} className="overflow-hidden p-0">
                <div className="flex items-center gap-2 border-b border-edge bg-surface px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{f.path}</span>
                  {stat && (
                    <span className="text-[10.5px]">
                      <span className="text-ok">+{stat.additions}</span>{" "}
                      <span className="text-err">−{stat.deletions}</span>
                    </span>
                  )}
                </div>
                <pre className="max-h-[50vh] overflow-auto text-[11px] leading-relaxed">
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

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="mb-3 flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
    >
      <ArrowLeft size={12} /> Pull requests
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
      <div className="flex items-center gap-2 border-b border-edge bg-surface px-3 py-1.5 text-xs">
        <span className="font-medium text-ink">{author}</span>
        {tag && <Badge>{tag}</Badge>}
        <span className="ml-auto text-[10.5px] text-ink-faint">{fmtDate(at)}</span>
      </div>
      <div className="whitespace-pre-wrap px-3 py-2 text-xs leading-relaxed text-ink-muted">
        {body}
      </div>
    </Card>
  );
}
