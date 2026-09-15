/**
 * Mission control: what the agents consumed, and whether the record can be trusted.
 *
 * Every number on this screen comes from the session ledger, which means two
 * things have to be visible or the screen lies by omission:
 *
 *   - **Which costs were measured.** The Agent SDK reports a real cost; a `claude`
 *     terminal reports none and is priced from a table. The totals say how much of
 *     the figure was derived, and a turn nobody could price is counted separately
 *     rather than silently counted as free.
 *   - **Whether capture is still running.** A dashboard that quietly lost its
 *     input looks exactly like a quiet week, so capture health sits at the top,
 *     not on another page.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, Badge } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Bot, CircleAlert, Terminal, TriangleAlert } from "@/components/ui/icons";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useProjects } from "@/features/projects/hooks";
import { DayBars, ShareRow, type Bar } from "./charts";
import { count, dayLabel, share, tokens, usd, when } from "./format";
import type { FilesResponse, Totals, UsageResponse } from "./types";

const WINDOWS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "12 months" },
] as const;

/** What the day chart is plotting. Cost first — it is why people open this. */
const METRICS = [
  { value: "costUsd", label: "Cost" },
  { value: "turns", label: "Turns" },
  { value: "totalTokens", label: "Tokens" },
  { value: "linesAdded", label: "Lines written" },
] as const;
type Metric = (typeof METRICS)[number]["value"];

function metricValue(row: Totals, metric: Metric): number {
  if (metric === "totalTokens") return row.inputTokens + row.outputTokens;
  return row[metric];
}

function metricText(value: number, metric: Metric): string {
  if (metric === "costUsd") return usd(value);
  if (metric === "totalTokens") return `${tokens(value)} tokens`;
  if (metric === "linesAdded") return `${count(value)} lines`;
  return `${count(value)} turns`;
}

export function InsightsTab({ projectId: fixedProject }: { projectId?: string }) {
  const [days, setDays] = useState("30");
  const [projectId, setProjectId] = useState(fixedProject ?? "");
  const [metric, setMetric] = useState<Metric>("costUsd");

  const scope = fixedProject ?? projectId;
  const params = new URLSearchParams({ days, ...(scope ? { projectId: scope } : {}) });

  const { data, isLoading } = useQuery({
    queryKey: ["insights", "usage", days, scope],
    queryFn: () => api.get<UsageResponse>(`/api/insights/usage?${params}`),
  });
  const { data: files } = useQuery({
    queryKey: ["insights", "files", days, scope],
    queryFn: () => api.get<FilesResponse>(`/api/insights/files?${params}`),
  });
  const { data: projects } = useProjects();

  if (isLoading) return <p className="p-6 text-ink-faint m3-body-sm">Loading…</p>;

  const totals = data?.totals;
  const bars: Bar[] = (data?.daily ?? []).map((row) => ({
    key: row.day,
    label: dayLabel(row.day),
    value: metricValue(row, metric),
    title: `${row.day} · ${metricText(metricValue(row, metric), metric)} · ${count(row.turns)} turns`,
  }));

  return (
    <div className="space-y-4 px-6 pb-10">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={days}
          onChange={setDays}
          options={WINDOWS}
          size="sm"
          aria-label="Time window"
        />
        {!fixedProject && (
          <Select
            value={projectId}
            onChange={setProjectId}
            size="sm"
            aria-label="Project"
            options={[
              { value: "", label: "All projects" },
              ...(projects ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        )}
        <div className="flex-1" />
        {data?.pricing ? (
          <span className="m3-label-sm text-ink-faint">
            prices: {data.pricing.models} models, {when(data.pricing.fetchedAt)}
          </span>
        ) : (
          <span className="m3-label-sm text-warn">
            no price table — costs are SDK-reported only
          </span>
        )}
      </div>

      <CaptureHealth rows={data?.capture ?? []} />

      {totals && <StatCards totals={totals} />}

      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="m3-title-sm">Over time</h2>
          <Select
            value={metric}
            onChange={(v) => setMetric(v as Metric)}
            options={METRICS}
            size="sm"
            aria-label="Metric"
          />
        </div>
        <DayBars bars={bars} empty="No turns recorded in this window." />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown
          title="By project"
          rows={(data?.byProject ?? []).map((row) => ({
            key: row.projectId,
            label: row.name ?? "(deleted project)",
            value: metricValue(row, metric),
            right: metricText(metricValue(row, metric), metric),
          }))}
        />
        <Breakdown
          title="By model"
          tone="tertiary"
          rows={(data?.byModel ?? []).map((row) => ({
            key: row.model,
            label: row.model,
            value: metricValue(row, metric),
            right: metricText(metricValue(row, metric), metric),
          }))}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SurfaceSplit rows={data?.bySource ?? []} />
        <Breakdown
          title="Files by kind"
          tone="tertiary"
          rows={(files?.byExtension ?? []).map((row) => ({
            key: row.ext,
            label: row.ext,
            value: row.files,
            right: `${count(row.files)} files`,
          }))}
          empty="Nothing touched in this window."
        />
      </div>

      <TopTurns turns={data?.top ?? []} />
    </div>
  );
}

// -- pieces -------------------------------------------------------------------

function StatCards({ totals }: { totals: Totals }) {
  const derived = totals.costUsd > 0 ? totals.estimatedCost / totals.costUsd : 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label="Cost"
        value={usd(totals.costUsd)}
        // The share that was derived, and the turns nobody could price at all:
        // the first makes the total approximate, the second makes it a floor.
        note={
          derived > 0.001
            ? `${share(totals.estimatedCost, totals.costUsd)} estimated from prices`
            : "as reported"
        }
        warn={totals.unpricedTurns > 0 ? `${count(totals.unpricedTurns)} turns unpriced` : null}
      />
      <Stat
        label="Turns"
        value={count(totals.turns)}
        note={`${count(totals.toolCalls)} tool calls`}
        warn={totals.errors > 0 ? `${count(totals.errors)} ended badly` : null}
      />
      <Stat
        label="Tokens"
        value={tokens(totals.inputTokens + totals.outputTokens)}
        note={`${tokens(totals.cacheReadTokens)} read from cache`}
      />
      <Stat
        label="Lines written"
        value={count(totals.linesAdded)}
        note={`${count(totals.linesRemoved)} removed`}
        // Counted from edit tools only, so a turn that wrote through the shell
        // adds nothing here. Saying so is cheaper than being quietly wrong.
        warn="edit tools only"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: string;
  note?: string;
  warn?: string | null;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="m3-label-sm font-bold tracking-[0.12em] text-ink-faint uppercase">
        {label}
      </span>
      <span className="m3-headline-sm font-semibold">{value}</span>
      {note && <span className="m3-label-sm text-ink-muted">{note}</span>}
      {warn && <span className="m3-label-sm text-warn">{warn}</span>}
    </Card>
  );
}

function Breakdown({
  title,
  rows,
  tone = "primary",
  empty = "Nothing in this window.",
}: {
  title: string;
  rows: { key: string; label: string; value: number; right: string }[];
  tone?: "primary" | "tertiary";
  empty?: string;
}) {
  const shown = rows.filter((r) => r.value > 0).slice(0, 8);
  const max = Math.max(...shown.map((r) => r.value), 0);
  return (
    <Card>
      <h2 className="m3-title-sm mb-3">{title}</h2>
      {shown.length === 0 ? (
        <p className="text-ink-faint m3-body-sm">{empty}</p>
      ) : (
        <div className="space-y-2">
          {shown.map((row) => (
            <ShareRow
              key={row.key}
              label={row.label}
              value={row.value}
              max={max}
              right={row.right}
              tone={tone}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * The two surfaces side by side.
 *
 * Worth its own card rather than another breakdown row: the split between the
 * chat sessions and the terminals is the one number that says whether the ledger
 * is seeing the work people actually do.
 */
function SurfaceSplit({
  rows,
}: {
  rows: { sourceKind: "sdk" | "cli"; turns: number; costUsd: number }[];
}) {
  const total = rows.reduce((sum, row) => sum + row.turns, 0);
  const meta = {
    sdk: { label: "Chat sessions", icon: Bot },
    cli: { label: "Terminals", icon: Terminal },
  } as const;

  return (
    <Card>
      <h2 className="m3-title-sm mb-3">By surface</h2>
      {total === 0 ? (
        <p className="text-ink-faint m3-body-sm">Nothing in this window.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {(["sdk", "cli"] as const).map((kind) => {
            const row = rows.find((r) => r.sourceKind === kind);
            const Icon = meta[kind].icon;
            return (
              <div key={kind} className="rounded-lg bg-white/4 p-3">
                <div className="mb-1 flex items-center gap-2 text-ink-muted">
                  <Icon size={16} />
                  <span className="m3-label-md">{meta[kind].label}</span>
                </div>
                <p className="m3-title-md">{count(row?.turns ?? 0)} turns</p>
                <p className="m3-label-sm text-ink-faint">
                  {share(row?.turns ?? 0, total)} of turns · {usd(row?.costUsd ?? 0)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function CaptureHealth({ rows }: { rows: { status: string; count: number; details: string[] }[] }) {
  const bad = rows.filter((row) => row.status !== "ok");
  if (bad.length === 0) {
    const ok = rows.find((row) => row.status === "ok");
    return (
      <div className="flex items-center gap-2 text-ink-faint m3-label-md">
        <Badge tone="ok">capture OK</Badge>
        {ok ? `${count(ok.count)} conversations followed` : "nothing being followed yet"}
      </div>
    );
  }
  return (
    <Card className="border border-warn/30">
      <div className="flex items-start gap-3">
        <TriangleAlert size={20} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0">
          <p className="m3-title-sm mb-1">Capture is not whole</p>
          {bad.map((row) => (
            <p key={row.status} className="m3-body-sm text-ink-muted">
              <span className={cn(row.status === "stopped" ? "text-err" : "text-warn")}>
                {row.status}
              </span>{" "}
              · {count(row.count)} conversation{row.count === 1 ? "" : "s"}
              {row.details.length > 0 && ` — ${row.details.slice(0, 3).join("; ")}`}
            </p>
          ))}
          <p className="m3-label-sm mt-1 text-ink-faint">
            Numbers below cover only what was captured. Settings → reindex history rebuilds a
            conversation from its transcript.
          </p>
        </div>
      </div>
    </Card>
  );
}

function TopTurns({ turns }: { turns: UsageResponse["top"] }) {
  if (turns.length === 0) return null;
  return (
    <Card>
      <h2 className="m3-title-sm mb-1">Where it went</h2>
      <p className="m3-label-sm mb-3 text-ink-faint">
        The most expensive turns in the window — the recent ones are in a project's History tab.
      </p>
      <div className="space-y-1">
        {turns.map((turn) => (
          <div
            key={turn.id}
            className="flex items-baseline gap-3 rounded-lg px-2 py-1.5 hover:bg-white/4"
          >
            <span className="m3-label-md w-16 shrink-0 text-right font-mono">
              {usd(turn.costUsd)}
            </span>
            {/* An estimate and a reported cost look identical otherwise, and the
                difference is exactly what someone reading this row needs. */}
            <span
              className="w-4 shrink-0 text-ink-faint"
              title={
                turn.costSource === "estimated"
                  ? "Estimated from the price table"
                  : turn.costSource === "unknown"
                    ? "No cost reported and no price for this model"
                    : "Reported by the SDK"
              }
            >
              {turn.costSource === "estimated" ? "≈" : turn.costSource === "unknown" ? "?" : ""}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-muted m3-body-sm">
              {turn.promptPreview || "(no prompt recorded)"}
            </span>
            {turn.status !== "done" && (
              <CircleAlert size={14} className="shrink-0 text-warn" title={turn.status} />
            )}
            <span className="m3-label-sm w-28 shrink-0 truncate text-right text-ink-faint">
              {turn.projectName ?? "—"}
            </span>
            <span className="m3-label-sm w-20 shrink-0 text-right text-ink-faint">
              {when(turn.startedAt)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
