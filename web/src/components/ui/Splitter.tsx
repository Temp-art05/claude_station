import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** "x" resizes the pane to the splitter's left, "y" the pane above it. */
  axis: "x" | "y";
  /** Current size of that pane, in px. */
  size: number;
  onResize: (next: number) => void;
  min?: number;
  /** Omit for no upper bound; pass a number to stop the pane eating the layout. */
  max?: number;
  className?: string;
}

/**
 * A drag handle between two panes.
 *
 * Pointer capture rather than window listeners: the pointer keeps reporting to
 * this element even when it outruns the 4px hit area mid-drag, which is exactly
 * what happens when you throw the handle across the screen.
 */
export function Splitter({ axis, size, onResize, min = 120, max, className }: Props) {
  // Read from a ref during the drag: `size` from props would be stale inside the
  // move handler for every frame React hasn't re-rendered yet, so a fast drag
  // would visibly lag behind the cursor.
  const start = useRef({ pos: 0, size: 0 });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { pos: axis === "x" ? e.clientX : e.clientY, size };
    },
    [axis, size],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const delta = (axis === "x" ? e.clientX : e.clientY) - start.current.pos;
      const next = start.current.size + delta;
      onResize(Math.max(min, max === undefined ? next : Math.min(max, next)));
    },
    [axis, max, min, onResize],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "shrink-0 bg-transparent transition-colors hover:bg-accent/40 active:bg-accent/60",
        axis === "x" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
        className,
      )}
    />
  );
}
