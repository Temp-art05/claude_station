import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * M3 filter chip. The same folder filter row was hand-rolled in four places
 * (knowledge, workflows, attach-from-library) and had already drifted apart, so
 * it lives here once: tonal when selected, outlined when not.
 */
export function FilterChip({
  selected = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "state-layer m3-label-md h-8 cursor-pointer rounded-pill border px-3.5 font-semibold",
        "transition-[background-color,border-color,color] duration-200 ease-emphasized",
        selected
          ? "border-transparent bg-inverse-surface text-on-inverse-surface"
          : "border-outline/45 text-ink-muted hover:border-outline/80 hover:text-ink",
        className,
      )}
      {...props}
    />
  );
}
