import { cn } from "@/lib/utils";

interface TabsProps<T extends string> {
  tabs: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/** Pill tabs: the active one is a raised glass chip rather than an underline. */
export function Tabs<T extends string>({ tabs, value, onChange, className }: TabsProps<T>) {
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
            value === tab.value
              ? "border border-hairline-strong bg-white/8 font-medium text-ink shadow-[inset_0_1px_0_rgb(255_255_255/8%)] backdrop-blur-md"
              : "border border-transparent text-ink-muted hover:bg-white/5 hover:text-ink",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
