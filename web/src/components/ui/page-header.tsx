import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { GlyphProps } from "./icon";

interface PageHeaderProps {
  title: string;
  /** One line on what this page is for. Optional — most pages are self-evident. */
  supporting?: ReactNode;
  /** Section glyph, shown in a tonal container to the left of the title. */
  icon?: (props: GlyphProps) => ReactNode;
  /** Buttons or pickers, right-aligned on the title row. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The header every page opens with. Before this each page hand-rolled
 * `<h1 className="text-lg font-semibold">`, which is why they all drifted: this
 * is one M3 headline, one supporting line, one action slot.
 */
export function PageHeader({ title, supporting, icon: Icon, actions, className }: PageHeaderProps) {
  return (
    // With no supporting line the title is a single row, so top-aligning it
    // against a 44px glyph tile left it sitting low — centre it instead.
    <div
      className={cn("mb-5 flex gap-3.5", supporting ? "items-start" : "items-center", className)}
    >
      {Icon && (
        <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary-container/55 text-on-primary-container">
          <Icon size={22} fill={1} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="m3-headline-sm truncate">{title}</h1>
        {supporting && <p className="m3-body-sm mt-1 text-ink-muted">{supporting}</p>}
      </div>
      {actions && (
        <div className={cn("flex shrink-0 items-center gap-2", supporting && "pt-0.5")}>
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * The "nothing here yet" state: tonal glyph, headline, one line of guidance and
 * at most one action. Pages used to leave a bare sentence on a black field.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: (props: GlyphProps) => ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "liquid flex flex-col items-center rounded-xl px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <div className="mb-4 grid size-14 place-items-center rounded-xl bg-secondary-container text-on-secondary-container">
          <Icon size={28} fill={1} />
        </div>
      )}
      <p className="m3-title-md">{title}</p>
      {children && <div className="m3-body-md mt-1.5 max-w-md text-ink-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
