import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TabsProps<T extends string> {
  tabs: readonly { value: T; label: string; closable?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  /** Called for tabs marked closable when their × is clicked. */
  onClose?: (value: T) => void;
  className?: string;
}

/** Pill tabs: the active one is a raised glass chip rather than an underline. */
export function Tabs<T extends string>({ tabs, value, onChange, onClose, className }: TabsProps<T>) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            "cursor-pointer rounded-pill px-3.5 py-1.5 text-sm transition-all duration-150",
            tab.closable && "inline-flex items-center gap-1.5 pr-2",
            value === tab.value
              ? "border border-hairline-strong bg-white/8 font-medium text-ink shadow-[inset_0_1px_0_rgb(255_255_255/8%)] backdrop-blur-md"
              : "border border-transparent text-ink-muted hover:bg-white/5 hover:text-ink",
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
              className="rounded-full p-0.5 text-ink-faint hover:bg-white/10 hover:text-err"
            >
              <X size={12} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
