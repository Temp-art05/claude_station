import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Ticket } from "@/components/ui/icons";
import { Button, IconButton } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page-header";
import { Input, Label, Textarea } from "@/components/ui/input";
import { api } from "@/lib/api";
import { globalKey, useUiState } from "@/lib/uiStore";
import { useStickyUrlStateOptional } from "@/lib/useUrlState";
import { WorkWithClaude } from "@/features/integrations/WorkWithClaude";

interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority: string | null;
  assignee: string | null;
  updated: string;
  url: string;
}

interface JiraDetail extends JiraIssue {
  reporter: string | null;
  labels: string[];
  description: string;
}

export function JiraPage() {
  const qc = useQueryClient();
  const [jql, setJql] = useUiState(globalKey("jira", "jql"), "");
  // Text search fires as you type — debounce so we don't hammer Jira per keystroke.
  const [debouncedJql, setDebouncedJql] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedJql(jql), 400);
    return () => clearTimeout(t);
  }, [jql]);
  // In the URL so leaving for a project and coming back reopens the same issue,
  // and so an issue can be linked to directly. Pushed, so Back closes it.
  const [selected, setSelected] = useStickyUrlStateOptional("issue", globalKey("jira", "issue"), {
    replace: false,
  });

  const { data: status } = useQuery({
    queryKey: ["jira-status"],
    queryFn: () => api.get<{ configured: boolean; baseUrl?: string }>("/api/jira/status"),
  });

  const {
    data: issues = [],
    isFetching,
    refetch,
    error,
  } = useQuery({
    queryKey: ["jira-issues", debouncedJql],
    queryFn: () =>
      api.get<JiraIssue[]>(
        `/api/jira/issues${debouncedJql.trim() ? `?jql=${encodeURIComponent(debouncedJql)}` : ""}`,
      ),
    enabled: status?.configured === true,
  });

  const { data: detail } = useQuery({
    queryKey: ["jira-issue", selected],
    queryFn: () => api.get<JiraDetail>(`/api/jira/issues/${selected}`),
    enabled: !!selected,
  });

  const { data: transitions = [] } = useQuery({
    queryKey: ["jira-transitions", selected],
    queryFn: () =>
      api.get<{ id: string; name: string; to: string }[]>(
        `/api/jira/issues/${selected}/transitions`,
      ),
    enabled: !!selected,
  });

  const [comment, setComment] = useState("");
  const [timeSpent, setTimeSpent] = useState("");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["jira-issues"] });
    void qc.invalidateQueries({ queryKey: ["jira-issue", selected] });
  };

  const addComment = useMutation({
    mutationFn: () => api.post(`/api/jira/issues/${selected}/comment`, { body: comment }),
    onSuccess: () => {
      setComment("");
      invalidate();
    },
  });
  const transition = useMutation({
    mutationFn: (transitionId: string) =>
      api.post(`/api/jira/issues/${selected}/transition`, { transitionId }),
    onSuccess: invalidate,
  });
  const worklog = useMutation({
    mutationFn: () => api.post(`/api/jira/issues/${selected}/worklog`, { timeSpent }),
    onSuccess: () => {
      setTimeSpent("");
      invalidate();
    },
  });

  if (status && !status.configured) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-6">
        <PageHeader title="Jira" icon={Ticket} />
        <EmptyState icon={Ticket} title="Not configured yet">
          Add your Jira base URL, email and API token in{" "}
          <a href="/settings" className="text-primary underline decoration-primary/40">
            Settings
          </a>
          .
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <PageHeader
          title="Jira"
          icon={Ticket}
          className="mb-4"
          actions={
            <IconButton
              onClick={() => void refetch()}
              disabled={isFetching}
              aria-label="Refresh issues"
              title="Refresh issues"
            >
              <RefreshCw size={20} className={isFetching ? "animate-status" : undefined} />
            </IconButton>
          }
        />

        <Input
          value={jql}
          onChange={(e) => setJql(e.target.value)}
          placeholder="Search text, issue key, or JQL — empty means my open issues"
          className="mb-3 font-mono text-xs"
        />

        {error && (
          <p className="mb-3 text-xs text-err">
            {error instanceof Error ? error.message : "Jira request failed"}
          </p>
        )}

        <div className="space-y-1.5">
          {issues.map((issue) => (
            <Card
              key={issue.key}
              className={`cursor-pointer p-2.5 hover:border-edge-strong ${
                selected === issue.key ? "border-accent/50" : ""
              }`}
              onClick={() => setSelected(issue.key)}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-accent">{issue.key}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{issue.summary}</span>
                <Badge>{issue.status}</Badge>
              </div>
              <div className="mt-1 flex gap-2 m3-label-sm text-ink-faint">
                <span>{issue.issueType}</span>
                {issue.priority && <span>{issue.priority}</span>}
                {issue.assignee && <span>{issue.assignee}</span>}
              </div>
            </Card>
          ))}
          {issues.length === 0 && !isFetching && (
            <p className="text-sm text-ink-muted">No issues.</p>
          )}
        </div>
      </div>

      {selected && detail && (
        <aside className="w-[420px] shrink-0 overflow-y-auto border-l border-hairline px-6 py-5">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono text-xs text-accent">{detail.key}</span>
            <a
              href={detail.url}
              target="_blank"
              rel="noreferrer"
              className="text-ink-faint hover:text-ink"
            >
              <ExternalLink size={16} />
            </a>
            <Badge className="ml-auto">{detail.status}</Badge>
          </div>
          <h2 className="m3-title-sm mb-3">{detail.summary}</h2>

          <div className="mb-4">
            <WorkWithClaude endpoint={`/api/jira/issues/${detail.key}/work-with-claude`} />
          </div>

          <div className="mb-4 whitespace-pre-wrap rounded-md bg-surface px-3 py-2 text-xs leading-relaxed text-ink-muted">
            {detail.description || "(no description)"}
          </div>

          <div className="mb-4">
            <Label>Transition</Label>
            <div className="flex flex-wrap gap-1.5">
              {transitions.map((t) => (
                <Button
                  key={t.id}
                  size="sm"
                  onClick={() => transition.mutate(t.id)}
                  disabled={transition.isPending}
                >
                  {t.name}
                </Button>
              ))}
              {transitions.length === 0 && (
                <span className="m3-label-sm text-ink-faint">No transitions available.</span>
              )}
            </div>
          </div>

          <div className="mb-4">
            <Label>Comment</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Posted as you, in Jira"
            />
            <Button
              size="sm"
              className="mt-2"
              onClick={() => addComment.mutate()}
              disabled={!comment.trim() || addComment.isPending}
            >
              Add comment
            </Button>
          </div>

          <div>
            <Label>Log work</Label>
            <div className="flex gap-2">
              <Input
                value={timeSpent}
                onChange={(e) => setTimeSpent(e.target.value)}
                placeholder="2h 30m"
                className="w-32"
              />
              <Button
                size="sm"
                onClick={() => worklog.mutate()}
                disabled={!timeSpent.trim() || worklog.isPending}
              >
                Log
              </Button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
