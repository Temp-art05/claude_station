import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "./icons";
import { cn } from "@/lib/utils";

interface TabsProps<T extends string> {
  tabs: readonly { value: T; label: string; closable?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  /** Called for tabs marked closable when their × is clicked. */
  onClose?: (value: T) => void;
  className?: string;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * M3 tabs. The active tab is a tonal pill that *slides* to its new position
 * instead of the fill jumping between buttons — one indicator element measured
 * against the pressed tab. It's measured in 2D rather than as an underline
 * offset, so a tab strip that wraps onto a second row still animates correctly.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  onClose,
  className,
}: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  // The first measurement positions the pill; animating from 0,0 to there would
  // read as the indicator flying in on every mount.
  const [ready, setReady] = useState(false);

  const measure = useCallback(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !active) {
      setBox(null);
      return;
    }
    setBox({
      left: active.offsetLeft,
      top: active.offsetTop,
      width: active.offsetWidth,
      height: active.offsetHeight,
    });
  }, []);

  useLayoutEffect(measure, [measure, value, tabs]);

  // Wrapping is what moves these tabs, and it happens on container resize —
  // which no React render is guaranteed to follow.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure]);

  // Labels re-flow when the webfont lands after first paint, which moves the
  // tabs out from under the pill.
  useEffect(() => {
    if (!("fonts" in document)) return;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
    };
  }, [measure]);

  useEffect(() => {
    if (box && !ready) {
      const id = requestAnimationFrame(() => setReady(true));
      return () => cancelAnimationFrame(id);
    }
  }, [box, ready]);

  return (
    <div ref={listRef} className={cn("relative flex flex-wrap gap-1", className)} role="tablist">
      {box && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-0 left-0 rounded-pill",
            "bg-inverse-surface shadow-e1",
            ready && "transition-all duration-300 ease-emphasized",
          )}
          style={{
            transform: `translate(${box.left}px, ${box.top}px)`,
            width: box.width,
            height: box.height,
          }}
        />
      )}

      {tabs.map((tab) => {
        const active = value === tab.value;
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={active}
            data-active={active}
            onClick={() => onChange(tab.value)}
            className={cn(
              "state-layer relative cursor-pointer rounded-pill px-4 py-1.5",
              "m3-label-lg font-semibold transition-colors duration-200 ease-emphasized",
              tab.closable && "inline-flex items-center gap-1.5 pr-2.5",
              active ? "text-on-inverse-surface" : "text-ink-muted hover:text-ink",
            )}
          >
            {tab.label}
            {tab.closable && onClose && (
              <span
                role="button"
                aria-label={`Close ${tab.label}`}
                title="Close this workspace tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.value);
                }}
                className="grid size-5 place-items-center rounded-pill text-ink-faint transition-colors duration-150 hover:bg-white/10 hover:text-err"
              >
                <X size={16} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
