import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "./icons";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** Shown when `value` matches no option — usually an empty string. */
  placeholder?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  /** Widest the popup may get; defaults to the trigger's own width. */
  menuClassName?: string;
  title?: string;
  "aria-label"?: string;
}

const sizes = {
  sm: "h-8 px-3 m3-label-md font-semibold",
  md: "h-10 px-4 text-sm font-semibold",
} as const;

/**
 * Dropdown built out of the app's own parts. A native `<select>` draws its popup
 * in the OS, so on every one of these the list arrived as a grey system menu in
 * the middle of a glass UI — the one control that could not be styled. This
 * renders the trigger as a button and the list as a glass sheet in a portal, so
 * it escapes any `overflow: hidden` panel it happens to sit in.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "—",
  size = "sm",
  disabled = false,
  className,
  menuClassName,
  title,
  "aria-label": ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);

  // Positioned against the viewport, and flipped above the trigger when there
  // isn't room below — these sit in toolbars near the bottom of tall panels.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const height = menuRef.current?.offsetHeight ?? 0;
      const below = window.innerHeight - r.bottom;
      const flip = height > 0 && below < height + 12 && r.top > below;
      setBox({
        top: flip ? Math.max(8, r.top - height - 6) : r.bottom + 6,
        left: Math.min(r.left, Math.max(8, window.innerWidth - r.width - 8)),
        width: r.width,
      });
    };
    measure();
    // The second pass runs once the menu has a height, so the flip is right.
    const id = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "glass state-layer inline-flex max-w-full cursor-pointer items-center gap-2 rounded-pill",
          "text-ink transition-all duration-200 ease-emphasized",
          "hover:border-hairline-strong disabled:pointer-events-none disabled:opacity-40",
          "focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:outline-none",
          sizes[size],
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? placeholder}</span>
        <ChevronDown
          size={16}
          className={cn(
            "shrink-0 text-ink-faint transition-transform duration-200 ease-emphasized",
            open && "rotate-180",
          )}
        />
      </button>

      {open &&
        box &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            className={cn(
              "liquid-raised animate-dialog-in fixed z-60 max-h-[min(22rem,60vh)] overflow-y-auto",
              "rounded-xl p-1.5",
              menuClassName,
            )}
            style={{ top: box.top, left: box.left, minWidth: box.width }}
          >
            {options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={o.disabled}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={cn(
                    "state-layer m3-body-sm flex w-full cursor-pointer items-center gap-2",
                    "rounded-pill px-3 py-2 text-left transition-colors duration-150",
                    "disabled:pointer-events-none disabled:opacity-40",
                    active
                      ? "bg-inverse-surface font-semibold text-on-inverse-surface"
                      : "text-ink-muted hover:text-ink",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {active && <Check size={16} className="shrink-0" />}
                </button>
              );
            })}
            {options.length === 0 && (
              <p className="m3-body-sm px-3 py-2 text-ink-faint">Nothing to pick.</p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
