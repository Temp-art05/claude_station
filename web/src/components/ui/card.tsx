import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * An M3 surface-container sheet in liquid glass. `interactive` adds the hover
 * sheen and press squash — use it only where the whole card is clickable, so
 * the motion means "this responds" rather than being decoration.
 */
export function Card({
  className,
  interactive = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "liquid rounded-xl p-4",
        interactive && "liquid-interactive cursor-pointer",
        className,
      )}
      {...props}
    />
  );
}

/**
 * M3 label chip. Tonal fill, no outline — the outline was what made these read
 * as small buttons. `glow` keeps the lit ring for status that must carry across
 * a long list.
 */
export function Badge({
  className,
  tone = "default",
  glow = false,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: "default" | "accent" | "ok" | "warn" | "err" | "think";
  /** Lit border + halo in the tone's own colour, for status seen at a glance. */
  glow?: boolean;
}) {
  const tones = {
    default: "bg-white/8 text-ink-muted",
    accent: "bg-primary/16 text-primary",
    ok: "bg-ok/16 text-ok",
    warn: "bg-warn/16 text-warn",
    err: "bg-err/16 text-err",
    think: "bg-tertiary/16 text-tertiary",
  };
  return (
    <span
      className={cn(
        "m3-label-sm inline-flex items-center rounded-pill px-2.5 py-1 font-semibold",
        tones[tone],
        // currentColor keeps the halo in sync with whichever tone is applied.
        glow &&
          "m3-label-md border border-current px-3 font-semibold shadow-[0_0_14px_-4px_currentColor]",
        className,
      )}
      {...props}
    />
  );
}
