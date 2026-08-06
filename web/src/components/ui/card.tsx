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
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: "default" | "accent" | "ok" | "err" }) {
  const tones = {
    default: "border-hairline bg-white/6 text-ink-muted",
    accent: "border-accent/30 bg-accent/12 text-accent",
    ok: "border-ok/30 bg-ok/12 text-ok",
    err: "border-err/30 bg-err/12 text-err",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill border px-2 py-0.5 text-[11px] font-medium backdrop-blur-sm",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
