import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  File,
  Folder,
  GitPullRequest,
  Search as SearchIcon,
  Trash2,
} from "@/components/ui/icons";
import { normalizeGithubRepo } from "@claude-station/shared";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { Badge, Card } from "@/components/ui/card";
import { FilterChip } from "@/components/ui/chip";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { authorColor } from "@/lib/authorColor";
import { globalKey, useUiState } from "@/lib/uiStore";
import { useUrlPatch, useStickyUrlState, useStickyUrlStateOptional } from "@/lib/useUrlState";
import { WorkWithClaude } from "@/features/integrations/WorkWithClaude";
import { PrDetail } from "@/features/integrations/PrDetail";

interface Pull {
  number: number;
  title: string;
  /** "OPEN" | "CLOSED" | "MERGED". */
  state: string;
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  url: string;
  reviewDecision: string;
  reviewRequests: string[];
  mergedAt: string;
  closedAt: string;
}

/** github.com's own split: Closed holds merged and closed-unmerged together. */
const PR_STATES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const;

/**
 * Mirrors `stateBadge` in PrDetail so a PR doesn't read as merged in one view
 * and something else in the other. Open PRs get no badge — that's the default.
 */
function prStateBadge(pr: Pull): { label: string; tone: "accent" | "err"; date: string } | null {
  if (pr.state === "MERGED") return { label: "merged", tone: "accent", date: pr.mergedAt };
  if (pr.state === "CLOSED") return { label: "closed", tone: "err", date: pr.closedAt };
  return null;
}

/**
 * GitHub only fills `reviewDecision` when the branch has a required-review rule;
 * everywhere else a pending request is the only "someone still owes a review"
 * signal, so both feed one badge.
 */
function reviewBadge(pr: Pull): { label: string; tone: "ok" | "err" | "warn" } | null {
  if (pr.reviewDecision === "APPROVED") return { label: "approved", tone: "ok" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { label: "changes requested", tone: "err" };
  if (pr.reviewDecision === "REVIEW_REQUIRED" || (pr.reviewRequests?.length ?? 0) > 0)
    return { label: "review required", tone: "warn" };
  return null;
}

interface Issue {
  number: number;
  title: string;
  author: string;
  labels: string[];
  updatedAt: string;
  url: string;
}

interface BranchList {
  defaultBranch: string;
  branches: { name: string; protected: boolean; sha: string }[];
}

interface Release {
  tagName: string;
  name: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
  isLatest: boolean;
  url: string;
}

type RepoContent =
  | {
      type: "dir";
      path: string;
      entries: { name: string; path: string; type: "dir" | "file"; size: number }[];
    }
  | {
      type: "file";
      path: string;
      name: string;
      size: number;
      text: string | null;
      truncated: boolean;
    };

const TABS = [
  { value: "pulls", label: "Pull requests" },
  { value: "issues", label: "Issues" },
  { value: "branches", label: "Branches" },
  { value: "releases", label: "Releases" },
  { value: "code", label: "Code" },
] as const;

// github.com blocks iframes (X-Frame-Options: deny), so the closest thing to
// "embedding GitHub" is one-click deep links into the selected repo.
const GH_SHORTCUTS = [
  { label: "Code", path: "" },
  { label: "Pull requests", path: "/pulls" },
  { label: "Issues", path: "/issues" },
  { label: "Actions", path: "/actions" },
  { label: "Branches", path: "/branches" },
  { label: "Releases", path: "/releases" },
] as const;

function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : "";
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function GitHubPage() {
  // Repo, tab and open PR live in the URL: leaving for another page and coming
  // back restores them, and the address bar is a shareable pointer at one PR.
  const [rawTab, setTab] = useStickyUrlState("tab", globalKey("github", "tab"), "pulls");
  const tab = TABS.find((t) => t.value === rawTab)?.value ?? "pulls";
  const [selectedRepo, , setRepoStore] = useStickyUrlState("repo", globalKey("github", "repo"), "");
  // Replaces rather than pushes: flipping a filter shouldn't fill up Back.
  const [rawPrState, setPrState] = useStickyUrlState(
    "prstate",
    globalKey("github", "prstate"),
    "open",
  );
  const prState = PR_STATES.find((s) => s.value === rawPrState)?.value ?? "open";
  // Goes straight into `gh pr list --search`, so qualifiers are the point, not a
  // side effect. Debounced like JiraPage — one `gh` process per keystroke would
  // be one process per keystroke.
  const [prQuery, setPrQuery] = useUiState(globalKey("github", "prq"), "");
  const [debouncedQuery, setDebouncedQuery] = useState(prQuery);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(prQuery), 400);
    return () => clearTimeout(t);
  }, [prQuery]);
  // Deliberately not in the URL: a shared ?page=5 points at a list that has since
  // moved, which is worse than not restoring it at all.
  const [prPage, setPrPage] = useState(1);
  // Opening a PR pushes, so Back returns to the list instead of leaving GitHub.
  const [rawPr, setPr, setPrStore] = useStickyUrlStateOptional("pr", globalKey("github", "pr"), {
    replace: false,
  });
  const selectedPr = Number.isInteger(Number(rawPr)) && rawPr ? Number(rawPr) : null;
  const patchUrl = useUrlPatch();

  // Both of these change more than one param, so the stores are updated
  // directly and every URL change goes through ONE patch. Chaining the
  // all-in-one setters instead would lose all but the last: `setSearchParams`
  // hands each caller the same pre-render snapshot, so the second navigation
  // reverts the first — closing a PR would leave `?pr=` in place, and picking a
  // repo would be undone by the PR that follows it.
  const closePr = () => {
    setPrStore(null); // clearing only the param would let the backfill reopen it
    patchUrl({ pr: null, prtab: null });
  };
  const changeRepo = (next: string) => {
    setRepoStore(next);
    setPrStore(null); // a PR number means nothing against a different repo
    patchUrl({ repo: next || null, pr: null, prtab: null });
  };
  const [newPrOpen, setNewPrOpen] = useState(false);

  const { data: config } = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => api.get<{ repos: string[] }>("/api/github/repos"),
  });

  // Settings entries may be pasted as full URLs — show and use owner/name.
  const repos = (config?.repos ?? [])
    .map(normalizeGithubRepo)
    .filter((r): r is string => r !== null);
  const repo =
    normalizeGithubRepo(selectedRepo) && repos.includes(normalizeGithubRepo(selectedRepo)!)
      ? normalizeGithubRepo(selectedRepo)!
      : (repos[0] ?? "");
  const [owner, name] = repo.split("/");
  const enabled = !!owner && !!name;

  // Any change to *what* is being listed invalidates the page number. Adjusted
  // during render rather than in an effect so the query below never gets one
  // pass with a page that no longer exists — and so repo/state/query are all
  // handled in one place instead of in three separate handlers.
  const listKey = `${repo}|${prState}|${debouncedQuery}`;
  const [prevListKey, setPrevListKey] = useState(listKey);
  if (prevListKey !== listKey) {
    setPrevListKey(listKey);
    setPrPage(1);
  }

  // AppShell scrolls <main>, not the window (AppShell.tsx:134), so rather than
  // reach for that element we hand the browser a node and let it find whichever
  // ancestor scrolls. Instant, not smooth: the rows underneath are being
  // replaced anyway, so gliding past a second of stale content buys nothing.
  const pageTopRef = useRef<HTMLDivElement>(null);
  const goToPage = (next: number) => {
    setPrPage(next);
    pageTopRef.current?.scrollIntoView({ block: "start" });
  };

  const pulls = useQuery({
    queryKey: ["gh-pulls", repo, prState, debouncedQuery, prPage],
    queryFn: () =>
      api.get<{ items: Pull[]; hasMore: boolean }>(
        `/api/github/${owner}/${name}/pulls?state=${prState}` +
          `&q=${encodeURIComponent(debouncedQuery)}&page=${prPage}`,
      ),
    enabled: enabled && tab === "pulls",
    // Keeps the layout from collapsing on a page change; the cost is that the
    // rows on screen can belong to the previous page, which prShowingStale below
    // is what makes visible.
    placeholderData: keepPreviousData,
  });
  // Rows on screen, but they're the previous page's while `gh` answers (~1s).
  const prShowingStale = pulls.isPlaceholderData && pulls.isFetching;
  const prListPending = pulls.isLoading || prShowingStale;
  const issues = useQuery({
    queryKey: ["gh-issues", repo],
    queryFn: () => api.get<Issue[]>(`/api/github/${owner}/${name}/issues`),
    enabled: enabled && tab === "issues",
  });

  if (config && repos.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-6">
        <PageHeader title="GitHub" icon={GitPullRequest} />
        <EmptyState icon={GitPullRequest} title="No repos configured">
          Add <code className="font-mono">owner/name</code> entries (or full GitHub URLs) in{" "}
          <a href="/settings" className="text-primary underline decoration-primary/40">
            Settings
          </a>
          . Data comes from the <code className="font-mono">gh</code> CLI, so it uses your existing
          login.
        </EmptyState>
      </div>
    );
  }

  const error = tab === "pulls" ? pulls.error : tab === "issues" ? issues.error : null;

  return (
    <div ref={pageTopRef} className="mx-auto max-w-4xl px-6 py-5">
      <PageHeader
        title="GitHub"
        icon={GitPullRequest}
        className="mb-4"
        actions={
          <Select
            size="md"
            className="max-w-[20rem]"
            value={repo}
            onChange={changeRepo}
            aria-label="Repository"
            options={repos.map((r) => ({ value: r, label: r }))}
          />
        }
      />
      {enabled && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {GH_SHORTCUTS.map((s) => (
            <a
              key={s.label}
              href={`https://github.com/${owner}/${name}${s.path}`}
              target="_blank"
              rel="noreferrer"
              className="state-layer m3-label-md flex h-8 items-center gap-1.5 rounded-pill border border-outline/40 px-3 font-semibold text-ink-muted transition-colors duration-200 ease-emphasized hover:border-outline/70 hover:text-ink"
            >
              {s.label}
              <ExternalLink size={16} />
            </a>
          ))}
        </div>
      )}

      <Tabs tabs={TABS} value={tab} onChange={setTab} className="mb-4" />

      {error && (
        <p className="m3-body-sm mb-3 text-err">
          {error instanceof Error ? error.message : "gh request failed"}
        </p>
      )}

      {tab === "pulls" && selectedPr !== null && enabled && (
        <PrDetail owner={owner!} name={name!} number={selectedPr} onBack={closePr} />
      )}

      {tab === "pulls" && selectedPr === null && enabled && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            {PR_STATES.map((s) => (
              <FilterChip
                key={s.value}
                selected={prState === s.value}
                onClick={() => setPrState(s.value)}
              >
                {s.label}
              </FilterChip>
            ))}
          </div>
          <div className="relative min-w-[12rem] flex-1">
            <SearchIcon size={16} className="absolute top-2 left-2.5 text-ink-faint" />
            <Input
              value={prQuery}
              onChange={(e) => setPrQuery(e.target.value)}
              placeholder="Search PRs — text, author:me, is:draft, review:required…"
              className="h-8 pl-8 text-xs"
              aria-label="Search pull requests"
            />
          </div>
          <Button size="sm" variant="primary" onClick={() => setNewPrOpen(true)}>
            <GitPullRequest size={16} /> New pull request
          </Button>
        </div>
      )}
      {enabled && (
        <NewPrDialog
          owner={owner!}
          name={name!}
          open={newPrOpen}
          onClose={() => setNewPrOpen(false)}
          onCreated={(number) => setPr(String(number))}
        />
      )}

      {/* Two different silences to break. isLoading: nothing on screen at all,
          so an empty area would read as "no PRs". isPlaceholderData: the rows
          below belong to the *previous* page, so without this a Next click
          looks like it did nothing for the second `gh` takes to answer. */}
      {tab === "pulls" && selectedPr === null && enabled && prListPending && (
        <p className="m3-body-sm mb-2 text-ink-muted">Loading…</p>
      )}

      <div
        className={cn(
          "space-y-1.5 transition-opacity duration-200",
          prShowingStale && "opacity-45",
        )}
      >
        {tab === "pulls" &&
          selectedPr === null &&
          pulls.data?.items.map((pr) => {
            // A merged PR keeps its reviewDecision, and "review required" on
            // something already merged is noise.
            const review = pr.state === "OPEN" ? reviewBadge(pr) : null;
            const state = prStateBadge(pr);
            return (
              <Card key={pr.number} className="p-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="m3-label-md shrink-0 rounded-pill bg-primary/14 px-2 py-0.5 font-mono font-semibold text-primary">
                    #{pr.number}
                  </span>
                  <button
                    onClick={() => setPr(String(pr.number))}
                    className="m3-title-sm min-w-0 flex-1 cursor-pointer truncate text-left transition-colors duration-150 hover:text-primary"
                  >
                    {pr.title}
                  </button>
                  {pr.isDraft && <Badge>draft</Badge>}
                  {state && (
                    <Badge tone={state.tone} className="shrink-0">
                      {state.label}
                    </Badge>
                  )}
                  {review && (
                    <Badge tone={review.tone} glow className="shrink-0">
                      {review.label}
                    </Badge>
                  )}
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink-faint transition-colors duration-150 hover:text-ink"
                    title="Open on GitHub"
                  >
                    <ExternalLink size={16} />
                  </a>
                </div>
                <div className="m3-label-sm mt-2 flex items-center gap-2.5 text-ink-faint">
                  <span
                    className="m3-label-md font-bold tracking-tight"
                    style={{ color: authorColor(pr.author) }}
                  >
                    {pr.author}
                  </span>
                  <span className="truncate font-mono">
                    {pr.headRefName} → {pr.baseRefName}
                  </span>
                  {state && state.date && (
                    <span className="shrink-0">
                      {state.label} {fmtDate(state.date)}
                    </span>
                  )}
                  <div className="ml-auto">
                    <WorkWithClaude
                      endpoint={`/api/github/${owner}/${name}/pr/${pr.number}/work-with-claude`}
                      label="Work with Claude"
                    />
                  </div>
                </div>
              </Card>
            );
          })}
        {tab === "pulls" && selectedPr === null && pulls.data?.items.length === 0 && (
          <EmptyState
            icon={GitPullRequest}
            title={
              debouncedQuery.trim()
                ? "No pull requests match"
                : prState === "all"
                  ? "No pull requests"
                  : `No ${prState} pull requests`
            }
          >
            {debouncedQuery.trim() ? (
              <>
                Nothing matches <code className="font-mono">{debouncedQuery.trim()}</code> among the{" "}
                {prState} pull requests.
              </>
            ) : prState === "open" ? (
              "Nothing is open right now — try Closed or All."
            ) : (
              "Nothing matches this filter in this repo."
            )}
          </EmptyState>
        )}
        {tab === "pulls" && selectedPr === null && (prPage > 1 || pulls.data?.hasMore) && (
          <div className="flex items-center justify-center gap-2 pt-2">
            <IconButton
              title="Previous page"
              disabled={prPage === 1 || prShowingStale}
              onClick={() => goToPage(Math.max(1, prPage - 1))}
            >
              <ChevronLeft size={20} />
            </IconButton>
            <span className="m3-label-md text-ink-muted">Page {prPage}</span>
            <IconButton
              title="Next page"
              // hasMore belongs to the page on screen; while that's the stale one
              // it can't be trusted to say whether a *next* page exists.
              disabled={!pulls.data?.hasMore || prShowingStale}
              onClick={() => goToPage(prPage + 1)}
            >
              <ChevronRight size={20} />
            </IconButton>
          </div>
        )}

        {tab === "issues" &&
          issues.data?.map((issue) => (
            <Card key={issue.number} className="p-3.5">
              <div className="flex items-center gap-2.5">
                <span className="m3-label-md shrink-0 rounded-pill bg-primary/14 px-2 py-0.5 font-mono font-semibold text-primary">
                  #{issue.number}
                </span>
                <span className="m3-title-sm min-w-0 flex-1 truncate">{issue.title}</span>
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink-faint transition-colors duration-150 hover:text-ink"
                  title="Open on GitHub"
                >
                  <ExternalLink size={16} />
                </a>
              </div>
              <div className="m3-label-sm mt-2 flex items-center gap-2.5 text-ink-faint">
                <span
                  className="m3-label-md font-bold tracking-tight"
                  style={{ color: authorColor(issue.author) }}
                >
                  {issue.author}
                </span>
                {issue.labels.map((l) => (
                  <Badge key={l}>{l}</Badge>
                ))}
                <div className="ml-auto">
                  <WorkWithClaude
                    endpoint={`/api/github/${owner}/${name}/issue/${issue.number}/work-with-claude`}
                    label="Work with Claude"
                  />
                </div>
              </div>
            </Card>
          ))}

        {tab === "branches" && enabled && <BranchesTab owner={owner!} name={name!} />}
        {tab === "releases" && enabled && <ReleasesTab owner={owner!} name={name!} />}
        {tab === "code" && enabled && <CodeTab owner={owner!} name={name!} />}
      </div>
    </div>
  );
}

function NewPrDialog({
  owner,
  name,
  open,
  onClose,
  onCreated,
}: {
  owner: string;
  name: string;
  open: boolean;
  onClose: () => void;
  onCreated: (number: number) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [draft, setDraft] = useState(false);

  const branches = useQuery({
    queryKey: ["gh-branches", owner, name],
    queryFn: () => api.get<BranchList>(`/api/github/${owner}/${name}/branches`),
    enabled: open,
  });
  const baseValue = base || branches.data?.defaultBranch || "";
  const names = branches.data?.branches.map((b) => b.name) ?? [];

  const create = useMutation({
    mutationFn: () =>
      api.post<{ number: number; url: string }>(`/api/github/${owner}/${name}/pulls`, {
        title,
        body: body || undefined,
        base: baseValue,
        head,
        draft,
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["gh-pulls", `${owner}/${name}`] });
      setTitle("");
      setBody("");
      setHead("");
      setBase("");
      setDraft(false);
      onClose();
      if (res.number) onCreated(res.number);
    },
  });

  const canCreate =
    !!title.trim() && !!head && !!baseValue && head !== baseValue && !create.isPending;

  return (
    <Dialog open={open} onClose={onClose} title="New pull request">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>base</span>
          <Select
            className="font-mono"
            value={baseValue}
            onChange={setBase}
            aria-label="Base branch"
            options={names.map((n) => ({ value: n, label: n }))}
          />
          <span>←</span>
          <span>compare</span>
          <Select
            className="font-mono"
            value={head}
            onChange={setHead}
            aria-label="Compare branch"
            options={[
              { value: "", label: "choose a branch…" },
              ...names.filter((n) => n !== baseValue).map((n) => ({ value: n, label: n })),
            ]}
          />
          {branches.isLoading && <span className="text-ink-faint">loading branches…</span>}
        </div>

        <div>
          <Label htmlFor="new-pr-title">Title</Label>
          <Input
            id="new-pr-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
          />
        </div>
        <div>
          <Label htmlFor="new-pr-body">Description</Label>
          <Textarea
            id="new-pr-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="Leave a description (optional)"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-muted">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Create as draft
        </label>

        {create.isError && (
          <p className="text-xs text-err">
            {create.error instanceof Error ? create.error.message : "Failed to create PR"}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!canCreate} onClick={() => create.mutate()}>
            <GitPullRequest size={16} />{" "}
            {draft ? "Create draft pull request" : "Create pull request"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function BranchesTab({ owner, name }: { owner: string; name: string }) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data, error, isFetching } = useQuery({
    queryKey: ["gh-branches", owner, name],
    queryFn: () => api.get<BranchList>(`/api/github/${owner}/${name}/branches`),
  });

  const remove = useMutation({
    mutationFn: (branch: string) =>
      api.delete(`/api/github/${owner}/${name}/branch?name=${encodeURIComponent(branch)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["gh-branches", owner, name] }),
  });

  if (error) {
    return (
      <p className="m3-body-sm text-err">{error instanceof Error ? error.message : "Failed"}</p>
    );
  }
  return (
    <>
      {remove.isError && (
        <p className="text-xs text-err">
          {remove.error instanceof Error ? remove.error.message : "Delete failed"}
        </p>
      )}
      {data?.branches.map((b) => {
        const undeletable = b.protected || b.name === data.defaultBranch;
        return (
          <Card key={b.name} className="p-3 pr-2">
            <div className="flex items-center gap-2.5">
              <span className="m3-body-sm min-w-0 flex-1 truncate font-mono">{b.name}</span>
              {b.name === data.defaultBranch && <Badge tone="accent">default</Badge>}
              {b.protected && <Badge>protected</Badge>}
              <span className="m3-label-sm font-mono text-ink-faint">{b.sha}</span>
              <a
                href={`https://github.com/${owner}/${name}/tree/${b.name}`}
                target="_blank"
                rel="noreferrer"
                className="text-ink-faint hover:text-ink"
              >
                <ExternalLink size={16} />
              </a>
              {!undeletable && (
                <IconButton
                  dense
                  title="Delete branch"
                  aria-label={`Delete branch ${b.name}`}
                  disabled={remove.isPending}
                  onClick={() => {
                    void confirm({
                      title: `Delete branch "${b.name}"?`,
                      body: `On ${owner}/${name}. This cannot be undone.`,
                      confirmLabel: "Delete branch",
                      tone: "danger",
                    }).then((ok) => ok && remove.mutate(b.name));
                  }}
                  className="hover:text-err"
                >
                  <Trash2 size={16} />
                </IconButton>
              )}
            </div>
          </Card>
        );
      })}
      {data && data.branches.length === 0 && !isFetching && (
        <p className="text-sm text-ink-muted">No branches.</p>
      )}
    </>
  );
}

function ReleasesTab({ owner, name }: { owner: string; name: string }) {
  const { data, error, isFetching } = useQuery({
    queryKey: ["gh-releases", owner, name],
    queryFn: () => api.get<Release[]>(`/api/github/${owner}/${name}/releases`),
  });

  if (error) {
    return (
      <p className="m3-body-sm text-err">{error instanceof Error ? error.message : "Failed"}</p>
    );
  }
  return (
    <>
      {data?.map((r) => (
        <Card key={r.tagName} className="p-3.5">
          <div className="flex items-center gap-2.5">
            <span className="m3-label-md shrink-0 rounded-pill bg-primary/14 px-2 py-0.5 font-mono font-semibold text-primary">
              {r.tagName}
            </span>
            <span className="m3-title-sm min-w-0 flex-1 truncate">{r.name}</span>
            {r.isLatest && <Badge tone="accent">latest</Badge>}
            {r.isDraft && <Badge>draft</Badge>}
            {r.isPrerelease && <Badge>pre-release</Badge>}
            <span className="m3-label-sm text-ink-faint">{fmtDate(r.publishedAt)}</span>
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="text-ink-faint hover:text-ink"
            >
              <ExternalLink size={16} />
            </a>
          </div>
        </Card>
      ))}
      {data && data.length === 0 && !isFetching && (
        <p className="text-sm text-ink-muted">No releases.</p>
      )}
    </>
  );
}

function CodeTab({ owner, name }: { owner: string; name: string }) {
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");

  const branches = useQuery({
    queryKey: ["gh-branches", owner, name],
    queryFn: () => api.get<BranchList>(`/api/github/${owner}/${name}/branches`),
  });
  const branch = ref || branches.data?.defaultBranch || "";

  const contents = useQuery({
    queryKey: ["gh-contents", owner, name, branch, path],
    queryFn: () =>
      api.get<RepoContent>(
        `/api/github/${owner}/${name}/contents?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(branch)}`,
      ),
    enabled: !!branch,
  });

  const crumbs = path.split("/").filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="font-mono"
          value={branch}
          onChange={(v) => {
            setRef(v);
            setPath("");
          }}
          aria-label="Branch"
          options={(branches.data?.branches ?? []).map((b) => ({ value: b.name, label: b.name }))}
        />
        <div className="flex items-center gap-1 font-mono text-xs text-ink-muted">
          <button onClick={() => setPath("")} className="hover:text-ink">
            {name}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={16} />
              <button
                onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}
                className="hover:text-ink"
              >
                {c}
              </button>
            </span>
          ))}
        </div>
      </div>

      {contents.error && (
        <p className="text-xs text-err">
          {contents.error instanceof Error ? contents.error.message : "Failed"}
        </p>
      )}

      {contents.data?.type === "dir" && (
        <div className="space-y-1">
          {contents.data.entries.map((e) => (
            <button
              key={e.path}
              onClick={() => setPath(e.path)}
              className="state-layer m3-body-sm flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-outline/40 px-3.5 py-2 text-left text-ink transition-colors duration-200 ease-emphasized hover:border-primary/40"
            >
              {e.type === "dir" ? (
                <Folder size={16} className="shrink-0 text-accent" />
              ) : (
                <File size={16} className="shrink-0 text-ink-faint" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{e.name}</span>
              {e.type === "file" && (
                <span className="m3-label-sm text-ink-faint">{fmtSize(e.size)}</span>
              )}
            </button>
          ))}
          {contents.data.entries.length === 0 && (
            <p className="text-sm text-ink-muted">Empty directory.</p>
          )}
        </div>
      )}

      {contents.data?.type === "file" && (
        <Card className="p-0">
          <div className="flex items-center gap-2.5 border-b border-hairline px-3.5 py-2.5 text-xs text-ink-muted">
            <File size={16} />
            <span className="min-w-0 flex-1 truncate font-mono">{contents.data.path}</span>
            <span className="m3-label-sm text-ink-faint">{fmtSize(contents.data.size)}</span>
            <a
              href={`https://github.com/${owner}/${name}/blob/${branch}/${contents.data.path}`}
              target="_blank"
              rel="noreferrer"
              className="text-ink-faint hover:text-ink"
            >
              <ExternalLink size={16} />
            </a>
          </div>
          {contents.data.text === null ? (
            <p className="px-3 py-3 text-sm text-ink-muted">
              Binary file — view it on GitHub instead.
            </p>
          ) : (
            <>
              {contents.data.truncated && (
                <p className="px-3 pt-2 m3-label-sm text-warn">
                  Showing the first 200 KB — open on GitHub for the full file.
                </p>
              )}
              <pre className="max-h-[60vh] overflow-auto px-3 py-2 font-mono text-xs leading-relaxed text-ink">
                {contents.data.text}
              </pre>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
