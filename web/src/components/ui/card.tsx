import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("glass rounded-lg p-4 transition-all duration-150", className)} {...props} />
  );
}

export function Badge({
  className,
  tone = "default",
  glow = false,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: "default" | "accent" | "ok" | "warn" | "err";
  /** Lit border + halo in the tone's own colour, for status that must be seen at a glance. */
  glow?: boolean;
}) {
  const tones = {
    default: "border-hairline bg-white/6 text-ink-muted",
    accent: "border-accent/30 bg-accent/12 text-accent",
    ok: "border-ok/30 bg-ok/12 text-ok",
    warn: "border-warn/30 bg-warn/12 text-warn",
    err: "border-err/30 bg-err/12 text-err",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill border px-2 py-0.5 text-[11px] font-medium backdrop-blur-sm",
        tones[tone],
        // currentColor keeps the halo in sync with whichever tone is applied.
        glow &&
          "border-current px-2.5 py-1 text-[11.5px] font-semibold shadow-[0_0_12px_-2px_currentColor]",
        className,
      )}
      {...props}
    />
  );
}
