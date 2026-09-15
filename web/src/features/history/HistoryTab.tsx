import { useQuery } from "@tanstack/react-query";
import type { WorkHistory } from "@claude-station/shared";
import { Badge } from "@/components/ui/card";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { projectKey, useUiState } from "@/lib/uiStore";
import { useScrollMemory } from "@/lib/useScrollMemory";
import { PlansPanel } from "./PlansPanel";
import { TurnsPanel } from "./TurnsPanel";

function dayLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Two records of the same project, kept apart on purpose.
 *
 * `Turns` is what the agents did — prompts, files, tokens. `Activity` is what the
 * app did: terminals opened, commands run, tickets moved. Merging them reads like
 * noise, because one row is a decision and the other is a side effect.
 *
 * `Plans` is the third: what an agent proposed to do before doing any of it, kept
 * past the session that proposed it.
 */
type View = "turns" | "activity" | "plans";

export function HistoryTab({ projectId }: { projectId: string }) {
  const [view, setView] = useUiState<View>(projectKey(projectId, "history", "view"), "turns");
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["history", projectId],
    queryFn: () => api.get<WorkHistory[]>(`/api/projects/${projectId}/history`),
    enabled: view === "activity",
  });
  // Declared before the early returns below — hooks can't be conditional. The
  // ref simply stays unattached while the list isn't rendered.
  const scrollRef = useScrollMemory<HTMLDivElement>(projectKey(projectId, "history", "scroll"));

  const groups = new Map<string, WorkHistory[]>();
  for (const row of rows) {
    const key = dayLabel(row.createdAt);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const tab = (value: View, label: string) => (
    <button
      key={value}
      onClick={() => setView(value)}
      className={cn(
        "cursor-pointer rounded-md px-2 py-0.5 m3-label-md",
        view === value
          ? "bg-secondary-container text-on-secondary-container"
          : "text-ink-muted hover:bg-white/6",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-hairline px-6 py-1.5">
        {tab("turns", "Turns")}
        {tab("plans", "Plans")}
        {tab("activity", "Activity")}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {view === "turns" ? (
          <TurnsPanel projectId={projectId} />
        ) : view === "plans" ? (
          <PlansPanel projectId={projectId} />
        ) : isLoading ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing recorded yet.</p>
        ) : (
          [...groups.entries()].map(([day, items]) => (
            <div key={day} className="mb-5">
              <p className="mb-2 text-xs font-medium text-ink-faint">{day}</p>
              <div className="space-y-1">
                {items.map((row) => (
                  <div key={row.id} className="flex items-baseline gap-3 text-sm">
                    <span className="w-14 shrink-0 font-mono m3-label-sm text-ink-faint">
                      {new Date(row.createdAt).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <Badge className="shrink-0">{row.kind}</Badge>
                    <span className="min-w-0 text-ink-muted">{row.summary}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
