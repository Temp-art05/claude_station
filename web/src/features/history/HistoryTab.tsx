import { useQuery } from "@tanstack/react-query";
import type { WorkHistory } from "@claude-station/shared";
import { Badge } from "@/components/ui/card";
import { api } from "@/lib/api";

function dayLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function HistoryTab({ projectId }: { projectId: string }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["history", projectId],
    queryFn: () => api.get<WorkHistory[]>(`/api/projects/${projectId}/history`),
  });

  if (isLoading) return <p className="p-6 text-sm text-ink-muted">Loading…</p>;
  if (rows.length === 0)
    return <p className="p-6 text-sm text-ink-muted">Nothing recorded yet.</p>;

  const groups = new Map<string, WorkHistory[]>();
  for (const row of rows) {
    const key = dayLabel(row.createdAt);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      {[...groups.entries()].map(([day, items]) => (
        <div key={day} className="mb-5">
          <p className="mb-2 text-xs font-medium text-ink-faint">{day}</p>
          <div className="space-y-1">
            {items.map((row) => (
              <div key={row.id} className="flex items-baseline gap-3 text-sm">
                <span className="w-14 shrink-0 font-mono text-[11px] text-ink-faint">
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
      ))}
    </div>
  );
}
