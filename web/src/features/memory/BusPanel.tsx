/**
 * The shared-memory bus, as a screen.
 *
 * Notes (the other half of this tab) are what *you* wrote for every session to
 * read. This is what the sessions wrote for each other: a decision one of them
 * reached, a turn that failed, a plan proposed, a commit that landed. Nobody
 * types in here — the log is the record of what happened, and a row you could
 * edit would be a record of what you wish had happened.
 *
 * What makes it worth reading rather than just worth having: every session keeps
 * its own place in this log, so a session that started this morning is handed
 * what the one running now decided, on its very next turn.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Bot, GitCommitHorizontal, Terminal, Trash2 } from "@/components/ui/icons";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Kind = "plan" | "decision" | "fact" | "failure" | "architecture" | "file_change" | "commit";

interface BusEvent {
  id: string;
  seq: number;
  kind: Kind;
  sourceKind: "sdk" | "cli" | "app";
  sessionKey: string | null;
  text: string;
  createdAt: string;
}

interface BusResponse {
  state: {
    plan: BusEvent | null;
    decisions: BusEvent[];
    facts: BusEvent[];
    failures: BusEvent[];
    changes: BusEvent[];
    lastSeq: number;
  };
  events: BusEvent[];
  lastSeq: number;
}

const KIND_TONE: Record<Kind, "default" | "accent" | "ok" | "warn" | "err" | "think"> = {
  plan: "think",
  decision: "accent",
  fact: "default",
  architecture: "think",
  failure: "err",
  file_change: "default",
  commit: "ok",
};

const KIND_LABEL: Record<Kind, string> = {
  plan: "plan",
  decision: "decided",
  fact: "fact",
  architecture: "architecture",
  failure: "failed",
  file_change: "changed",
  commit: "commit",
};

export function BusPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({
    queryKey: ["memory-bus", projectId],
    queryFn: () => api.get<BusResponse>(`/api/projects/${projectId}/memory/bus`),
    refetchInterval: 15_000,
  });

  const clear = useMutation({
    mutationFn: () => api.delete(`/api/projects/${projectId}/memory/bus`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory-bus", projectId] }),
  });

  if (isLoading) return <p className="text-sm text-ink-muted">Loading…</p>;
  const events = data?.events ?? [];

  if (events.length === 0) {
    return (
      <div className="max-w-2xl space-y-2">
        <p className="text-sm text-ink-muted">Nothing on the bus for this project yet.</p>
        <p className="m3-body-sm text-ink-faint">
          Sessions write here by themselves: a plan proposed, a turn that failed, files changed, a
          commit landed, and any line an agent marked <code className="font-mono">Decision:</code>{" "}
          or <code className="font-mono">Gotcha:</code>. Every other session in this project is
          handed what it has not seen yet, on its next turn.
        </p>
      </div>
    );
  }

  const state = data?.state;

  return (
    <div className="space-y-4">
      {state && (
        <Card className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="m3-title-sm">What a new session inherits</h3>
            <span className="m3-label-sm text-ink-faint">seq {data?.lastSeq}</span>
          </div>
          {state.plan && <StateLine kind="plan" text={state.plan.text} />}
          {state.decisions.map((event) => (
            <StateLine key={event.id} kind="decision" text={event.text} />
          ))}
          {state.facts.map((event) => (
            <StateLine key={event.id} kind={event.kind} text={event.text} />
          ))}
          {state.failures.map((event) => (
            <StateLine key={event.id} kind="failure" text={event.text} />
          ))}
          {state.changes.map((event) => (
            <StateLine key={event.id} kind={event.kind} text={event.text} />
          ))}
        </Card>
      )}

      <div className="flex items-center justify-between gap-3">
        <h3 className="m3-title-sm">The log</h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const ok = await confirm({
              title: "Clear this project's bus?",
              body: "Every event goes, and every session's place in the log resets — the next turn of each one will be handed the state again.",
              confirmLabel: "Clear",
              tone: "danger",
            });
            if (ok) clear.mutate();
          }}
        >
          <Trash2 size={16} />
          Clear
        </Button>
      </div>

      <div className="space-y-1">
        {events.map((event) => (
          <div key={event.id} className="flex items-baseline gap-3 py-1">
            <span className="m3-label-sm w-10 shrink-0 text-right font-mono text-ink-faint">
              {event.seq}
            </span>
            <Badge tone={KIND_TONE[event.kind]} className="w-24 shrink-0 justify-center">
              {KIND_LABEL[event.kind] ?? event.kind}
            </Badge>
            <SourceIcon source={event.sourceKind} />
            <span className="min-w-0 flex-1 text-ink-muted m3-body-sm">{event.text}</span>
            <span className="m3-label-sm shrink-0 text-ink-faint">
              {new Date(event.createdAt).toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StateLine({ kind, text }: { kind: Kind; text: string }) {
  return (
    <p className={cn("m3-body-sm flex gap-2", kind === "failure" && "text-warn")}>
      <span className="w-24 shrink-0 text-right text-ink-faint">{KIND_LABEL[kind] ?? kind}</span>
      <span className="min-w-0">{text}</span>
    </p>
  );
}

function SourceIcon({ source }: { source: BusEvent["sourceKind"] }) {
  const Icon = source === "sdk" ? Bot : source === "cli" ? Terminal : GitCommitHorizontal;
  return <Icon size={16} className="shrink-0 text-ink-faint" />;
}
