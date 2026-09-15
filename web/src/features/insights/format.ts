/**
 * How the numbers are written down.
 *
 * All of it exists so a figure is read correctly at a glance: a cost that rounds
 * to zero says so rather than showing `$0.00`, and a token count is an order of
 * magnitude rather than nine digits nobody compares by eye.
 */

/** `$12.40`, `$0.86`, and `<$0.01` for anything that would round to nothing. */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

/** Thousands and millions, because token counts are compared, not summed by eye. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function count(n: number): string {
  return n.toLocaleString();
}

/** A UTC day key (`2026-09-15`) as `15/9` — the buckets are days, not instants. */
export function dayLabel(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(date)}/${Number(month)}`;
}

/** Local time of an ISO instant, to the minute. Dates only when it isn't today. */
export function when(iso: string): string {
  const at = new Date(iso);
  const today = new Date().toDateString() === at.toDateString();
  return today
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString([], {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** A share as a whole percent, floored at 1 so a visible row is never "0%". */
export function share(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  return `${pct < 1 && pct > 0 ? "<1" : Math.round(pct)}%`;
}
