import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, File, Folder, Trash2 } from "lucide-react";
import { normalizeGithubRepo } from "@claude-station/shared";
import { Badge, Card } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { WorkWithClaude } from "@/features/integrations/WorkWithClaude";
import { PrDetail } from "@/features/integrations/PrDetail";

interface Pull {
  number: number;
  title: string;
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  url: string;
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
  | { type: "dir"; path: string; entries: { name: string; path: string; type: "dir" | "file"; size: number }[] }
  | { type: "file"; path: string; name: string; size: number; text: string | null; truncated: boolean };

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
  const [tab, setTab] = useState<(typeof TABS)[number]["value"]>("pulls");
  const [selectedRepo, setRepo] = useState("");
  const [selectedPr, setSelectedPr] = useState<number | null>(null);

  const { data: config } = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => api.get<{ repos: string[] }>("/api/github/repos"),
  });

  // Settings entries may be pasted as full URLs — show and use owner/name.
  const repos = (config?.repos ?? [])
    .map(normalizeGithubRepo)
    .filter((r): r is string => r !== null);
  const repo = normalizeGithubRepo(selectedRepo) && repos.includes(normalizeGithubRepo(selectedRepo)!)
    ? normalizeGithubRepo(selectedRepo)!
    : repos[0] ?? "";
  const [owner, name] = repo.split("/");
  const enabled = !!owner && !!name;

  const pulls = useQuery({
    queryKey: ["gh-pulls", repo],
    queryFn: () => api.get<Pull[]>(`/api/github/${owner}/${name}/pulls`),
    enabled: enabled && tab === "pulls",
  });
  const issues = useQuery({
    queryKey: ["gh-issues", repo],
    queryFn: () => api.get<Issue[]>(`/api/github/${owner}/${name}/issues`),
    enabled: enabled && tab === "issues",
  });

  if (config && repos.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-6">
        <h1 className="mb-1 text-lg font-semibold">GitHub</h1>
        <Card className="mt-4 text-sm text-ink-muted">
          No repos configured. Add <code className="font-mono">owner/name</code> entries (or full
          GitHub URLs) in{" "}
          <a href="/settings" className="text-accent">
            Settings
          </a>
          . Data comes from the <code className="font-mono">gh</code> CLI, so it uses your existing
          login.
        </Card>
      </div>
    );
  }

  const error = tab === "pulls" ? pulls.error : tab === "issues" ? issues.error : null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-5">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-lg font-semibold">GitHub</h1>
        <select
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value);
            setSelectedPr(null);
          }}
          className="h-8 rounded-md border border-edge bg-surface px-2 text-xs text-ink"
        >
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {enabled && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {GH_SHORTCUTS.map((s) => (
            <a
              key={s.label}
              href={`https://github.com/${owner}/${name}${s.path}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 rounded-md border border-edge bg-surface px-2 py-1 text-xs text-ink-muted hover:text-ink"
            >
              {s.label}
              <ExternalLink size={10} />
            </a>
          ))}
        </div>
      )}

      <Tabs tabs={TABS} value={tab} onChange={setTab} className="mb-3" />

      {error && (
        <p className="mb-3 text-xs text-err">
          {error instanceof Error ? error.message : "gh request failed"}
        </p>
      )}

      {tab === "pulls" && selectedPr !== null && enabled && (
        <PrDetail owner={owner!} name={name!} number={selectedPr} onBack={() => setSelectedPr(null)} />
      )}

      <div className="space-y-1.5">
        {tab === "pulls" &&
          selectedPr === null &&
          pulls.data?.map((pr) => (
            <Card key={pr.number} className="p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-accent">#{pr.number}</span>
                <button
                  onClick={() => setSelectedPr(pr.number)}
                  className="min-w-0 flex-1 truncate text-left text-sm hover:text-accent"
                >
                  {pr.title}
                </button>
                {pr.isDraft && <Badge>draft</Badge>}
                <a href={pr.url} target="_blank" rel="noreferrer" className="text-ink-faint hover:text-ink">
                  <ExternalLink size={12} />
                </a>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10.5px] text-ink-faint">
                <span>{pr.author}</span>
                <span className="font-mono">
                  {pr.headRefName} → {pr.baseRefName}
                </span>
                <div className="ml-auto">
                  <WorkWithClaude
                    endpoint={`/api/github/${owner}/${name}/pr/${pr.number}/work-with-claude`}
                    label="Work with Claude"
                  />
                </div>
              </div>
            </Card>
          ))}

        {tab === "issues" &&
          issues.data?.map((issue) => (
            <Card key={issue.number} className="p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-accent">#{issue.number}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
                <a href={issue.url} target="_blank" rel="noreferrer" className="text-ink-faint hover:text-ink">
                  <ExternalLink size={12} />
                </a>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10.5px] text-ink-faint">
                <span>{issue.author}</span>
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

function BranchesTab({ owner, name }: { owner: string; name: string }) {
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
    return <p className="text-xs text-err">{error instanceof Error ? error.message : "Failed"}</p>;
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
          <Card key={b.name} className="p-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.name}</span>
              {b.name === data.defaultBranch && <Badge tone="accent">default</Badge>}
              {b.protected && <Badge>protected</Badge>}
              <span className="font-mono text-[10.5px] text-ink-faint">{b.sha}</span>
              <a
                href={`https://github.com/${owner}/${name}/tree/${b.name}`}
                target="_blank"
                rel="noreferrer"
                className="text-ink-faint hover:text-ink"
              >
                <ExternalLink size={12} />
              </a>
              {!undeletable && (
                <button
                  title="Delete branch"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete branch "${b.name}" on ${owner}/${name}?`)) {
                      remove.mutate(b.name);
                    }
                  }}
                  className="text-ink-faint hover:text-err disabled:opacity-50"
                >
                  <Trash2 size={12} />
                </button>
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
    return <p className="text-xs text-err">{error instanceof Error ? error.message : "Failed"}</p>;
  }
  return (
    <>
      {data?.map((r) => (
        <Card key={r.tagName} className="p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-accent">{r.tagName}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
            {r.isLatest && <Badge tone="accent">latest</Badge>}
            {r.isDraft && <Badge>draft</Badge>}
            {r.isPrerelease && <Badge>pre-release</Badge>}
            <span className="text-[10.5px] text-ink-faint">{fmtDate(r.publishedAt)}</span>
            <a href={r.url} target="_blank" rel="noreferrer" className="text-ink-faint hover:text-ink">
              <ExternalLink size={12} />
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
        <select
          value={branch}
          onChange={(e) => {
            setRef(e.target.value);
            setPath("");
          }}
          className="h-7 rounded-md border border-edge bg-surface px-2 font-mono text-xs text-ink"
        >
          {branches.data?.branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1 font-mono text-xs text-ink-muted">
          <button onClick={() => setPath("")} className="hover:text-ink">
            {name}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={10} />
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
              className="flex w-full items-center gap-2 rounded-md border border-edge bg-surface px-3 py-1.5 text-left text-xs text-ink hover:border-accent/40"
            >
              {e.type === "dir" ? (
                <Folder size={12} className="shrink-0 text-accent" />
              ) : (
                <File size={12} className="shrink-0 text-ink-faint" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{e.name}</span>
              {e.type === "file" && (
                <span className="text-[10.5px] text-ink-faint">{fmtSize(e.size)}</span>
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
          <div className="flex items-center gap-2 border-b border-edge px-3 py-2 text-xs text-ink-muted">
            <File size={12} />
            <span className="min-w-0 flex-1 truncate font-mono">{contents.data.path}</span>
            <span className="text-[10.5px] text-ink-faint">{fmtSize(contents.data.size)}</span>
            <a
              href={`https://github.com/${owner}/${name}/blob/${branch}/${contents.data.path}`}
              target="_blank"
              rel="noreferrer"
              className="text-ink-faint hover:text-ink"
            >
              <ExternalLink size={12} />
            </a>
          </div>
          {contents.data.text === null ? (
            <p className="px-3 py-3 text-sm text-ink-muted">
              Binary file — view it on GitHub instead.
            </p>
          ) : (
            <>
              {contents.data.truncated && (
                <p className="px-3 pt-2 text-[10.5px] text-warn">
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
