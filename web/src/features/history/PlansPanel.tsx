/**
 * Every plan an agent proposed for this project, and what was decided.
 *
 * The repo's working rule is plan first, implement second — but until now a plan
 * only survived if somebody remembered to paste it into `docs/plans/`. This is
 * the rest of them: the drafts, the rejected ones, and the ones that were agreed
 * to and then implemented from memory.
 *
 * Export writes into the repo, and that is deliberately a button rather than
 * something capture does: most proposals are drafts, and a `docs/plans/` full of
 * drafts is noise nobody reads.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@claude-station/shared";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Bot, Download, Terminal, Trash2 } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

interface PlanRow {
  id: string;
  sourceKind: "sdk" | "cli";
  promptPreview: string;
  status: "proposed" | "accepted" | "rejected";
  createdAt: string;
  heading: string;
  lines: number;
}

interface PlanDetail extends PlanRow {
  markdown: string;
  suggestedPath: string;
}

interface PlansResponse {
  plans: PlanRow[];
  counts: Record<"proposed" | "accepted" | "rejected", number>;
}

const STATUS_TONE = {
  proposed: "default",
  accepted: "ok",
  rejected: "warn",
} as const;

export function PlansPanel({ projectId }: { projectId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["plans", projectId],
    queryFn: () => api.get<PlansResponse>(`/api/projects/${projectId}/plans`),
  });

  if (isLoading) return <p className="text-sm text-ink-muted">Loading…</p>;
  const plans = data?.plans ?? [];

  if (plans.length === 0) {
    return (
      <div className="max-w-2xl space-y-2">
        <p className="text-sm text-ink-muted">No plan has been proposed in this project yet.</p>
        <p className="m3-body-sm text-ink-faint">
          A plan lands here when Claude asks to leave plan mode — from a session in the Claude tab,
          or from a <code className="font-mono">claude</code> terminal. Plans proposed before this
          existed were never written down anywhere, so there is nothing to recover.
        </p>
      </div>
    );
  }

  const counts = data?.counts;

  return (
    <div className="space-y-3">
      {counts && (
        <div className="flex items-center gap-2">
          {(["accepted", "proposed", "rejected"] as const).map((status) =>
            counts[status] > 0 ? (
              <Badge key={status} tone={STATUS_TONE[status]}>
                {counts[status]} {status}
              </Badge>
            ) : null,
          )}
        </div>
      )}
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          projectId={projectId}
          plan={plan}
          open={openId === plan.id}
          onToggle={() => setOpenId(openId === plan.id ? null : plan.id)}
        />
      ))}
    </div>
  );
}

function PlanCard({
  projectId,
  plan,
  open,
  onToggle,
}: {
  projectId: string;
  plan: PlanRow;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = plan.sourceKind === "sdk" ? Bot : Terminal;
  return (
    <Card className="p-0">
      <button
        onClick={onToggle}
        className="state-layer flex w-full cursor-pointer items-start gap-3 rounded-xl p-3 text-left"
      >
        <Icon size={18} className="mt-0.5 shrink-0 text-ink-faint" />
        <div className="min-w-0 flex-1">
          <p className="m3-title-sm truncate">{plan.heading || "Untitled plan"}</p>
          <p className="m3-label-sm truncate text-ink-faint">
            {plan.promptPreview || "(the prompt behind it was not recorded)"}
          </p>
        </div>
        <Badge tone={STATUS_TONE[plan.status]} className="shrink-0">
          {plan.status}
        </Badge>
        <span className="m3-label-sm shrink-0 text-ink-faint">
          {new Date(plan.createdAt).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
          })}
        </span>
      </button>
      {open && <PlanBody projectId={projectId} planId={plan.id} />}
    </Card>
  );
}

function PlanBody({ projectId, planId }: { projectId: string; planId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [repoId, setRepoId] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const { data: plan } = useQuery({
    queryKey: ["plan", planId],
    queryFn: () => api.get<PlanDetail>(`/api/plans/${planId}`),
  });
  const { data: project } = useQuery({
    queryKey: ["projects", projectId],
    queryFn: () => api.get<Project>(`/api/projects/${projectId}`),
  });

  const repos = project?.paths ?? [];
  const target = repoId || repos[0]?.id || "";

  const exportPlan = useMutation({
    mutationFn: (overwrite: boolean) =>
      api.post<{ relPath: string }>(`/api/plans/${planId}/export`, {
        projectPathId: target,
        overwrite,
      }),
    onSuccess: (result) => setNote(`Written to ${result.relPath}`),
    onError: async (err) => {
      // A clash is the expected answer, not a failure: the second press is the
      // confirmation, which is why the server refuses the first one.
      if (err instanceof ApiError && err.status === 409) {
        const ok = await confirm({
          title: "That file already exists",
          body: err.message,
          confirmLabel: "Overwrite",
        });
        if (ok) exportPlan.mutate(true);
        return;
      }
      setNote(err instanceof Error ? err.message : "Export failed");
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/plans/${planId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plans", projectId] }),
  });

  if (!plan) return <p className="px-3 pb-3 text-ink-faint m3-label-sm">Loading…</p>;

  return (
    <div className="border-t border-hairline px-3 pt-3 pb-3">
      <pre className="m3-body-sm max-h-96 overflow-auto rounded-lg bg-black/20 p-3 whitespace-pre-wrap">
        {plan.markdown}
      </pre>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {repos.length > 1 && (
          <Select
            value={target}
            onChange={setRepoId}
            size="sm"
            aria-label="Repo to write into"
            options={repos.map((r) => ({ value: r.id, label: r.label || r.path }))}
          />
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={!target || exportPlan.isPending}
          onClick={() => exportPlan.mutate(false)}
        >
          <Download size={16} />
          Export to {plan.suggestedPath}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const ok = await confirm({
              title: "Delete this plan?",
              body: "The record of what was proposed goes with it.",
              confirmLabel: "Delete",
              tone: "danger",
            });
            if (ok) remove.mutate();
          }}
        >
          <Trash2 size={16} />
        </Button>
        {note && (
          <span className={cn("m3-label-sm", note.startsWith("Written") ? "text-ok" : "text-err")}>
            {note}
          </span>
        )}
      </div>
    </div>
  );
}
