/**
 * The two chart shapes this dashboard needs, drawn by hand.
 *
 * No chart library: a bar per day and a share bar per row is the whole
 * vocabulary here, and either one is less code than the wiring a library would
 * need. It also keeps the drawing on the app's own tokens — `primary`,
 * `tertiary`, `ink-faint` — instead of a second theme to keep in sync.
 */
import { cn } from "@/lib/utils";

export interface Bar {
  key: string;
  label: string;
  value: number;
  /** What the hover text should say. The value alone is rarely the whole story. */
  title: string;
}

/**
 * A day-by-day column chart.
 *
 * Heights are a share of the largest bar, not of the total: the question a
 * consumption chart answers is "which day was the heavy one", and normalising to
 * the total flattens every bar into invisibility as the window grows.
 */
export function DayBars({ bars, empty }: { bars: Bar[]; empty: string }) {
  const max = Math.max(...bars.map((b) => b.value), 0);
  if (bars.length === 0 || max <= 0) {
    return <div className="grid h-40 place-items-center text-ink-faint m3-body-sm">{empty}</div>;
  }

  // Past a few weeks the labels collide, so only every nth one is drawn. The
  // bars stay — the shape is the point, the axis is the footnote.
  const step = Math.ceil(bars.length / 12);

  return (
    <div className="flex h-40 items-end gap-[3px]">
      {bars.map((bar, i) => {
        const pct = (bar.value / max) * 100;
        return (
          <div key={bar.key} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <div className="flex h-32 w-full items-end" title={bar.title}>
              <div
                className={cn(
                  "w-full rounded-t-sm transition-[height]",
                  bar.value > 0 ? "bg-primary/70 hover:bg-primary" : "bg-white/5",
                )}
                // A day with work always gets a sliver, so "a little" never
                // renders identically to "none".
                style={{ height: `${bar.value > 0 ? Math.max(pct, 2) : 1}%` }}
              />
            </div>
            <span className="m3-label-sm truncate text-ink-faint">
              {i % step === 0 ? bar.label : " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One row of a breakdown: a label, a proportional bar, and the figure itself. */
export function ShareRow({
  label,
  value,
  max,
  right,
  tone = "primary",
}: {
  label: string;
  value: number;
  max: number;
  right: string;
  tone?: "primary" | "tertiary";
}) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 3 : 0) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="m3-label-md w-36 shrink-0 truncate text-ink-muted" title={label}>
        {label}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-pill bg-white/6">
        <div
          className={cn(
            "h-full rounded-pill",
            tone === "primary" ? "bg-primary/70" : "bg-tertiary/70",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="m3-label-md w-20 shrink-0 text-right font-mono text-ink">{right}</span>
    </div>
  );
}
