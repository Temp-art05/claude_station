import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Badge, Card } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { WorkWithClaude } from "@/features/integrations/WorkWithClaude";

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

const TABS = [
  { value: "pulls", label: "Pull requests" },
  { value: "issues", label: "Issues" },
] as const;

export function GitHubPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["value"]>("pulls");
  const [selectedRepo, setRepo] = useState("");

  const { data: config } = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => api.get<{ repos: string[] }>("/api/github/repos"),
  });

  // Derived: defaults to the first configured repo until the user picks one.
  const repo = selectedRepo || config?.repos[0] || "";
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

  if (config && config.repos.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-6">
        <h1 className="mb-1 text-lg font-semibold">GitHub</h1>
        <Card className="mt-4 text-sm text-ink-muted">
          No repos configured. Add <code className="font-mono">owner/name</code> entries in{" "}
          <a href="/settings" className="text-accent">
            Settings
          </a>
          . Data comes from the <code className="font-mono">gh</code> CLI, so it uses your existing
          login.
        </Card>
      </div>
    );
  }

  const error = tab === "pulls" ? pulls.error : issues.error;

  return (
    <div className="mx-auto max-w-4xl px-6 py-5">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-lg font-semibold">GitHub</h1>
        <select
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          className="h-8 rounded-md border border-edge bg-surface px-2 text-xs text-ink"
        >
          {config?.repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <Tabs tabs={TABS} value={tab} onChange={setTab} className="mb-3" />

      {error && (
        <p className="mb-3 text-xs text-err">
          {error instanceof Error ? error.message : "gh request failed"}
        </p>
      )}

      <div className="space-y-1.5">
        {tab === "pulls" &&
          pulls.data?.map((pr) => (
            <Card key={pr.number} className="p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-accent">#{pr.number}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{pr.title}</span>
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
      </div>
    </div>
  );
}
