import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "icon";

const variants: Record<Variant, string> = {
  // A light top edge on the accent fill is what makes it read as raised glass.
  primary:
    "bg-accent text-accent-ink font-semibold shadow-[inset_0_1px_0_rgb(255_255_255/35%),0_6px_18px_-10px_var(--color-accent)] hover:bg-accent-hover",
  secondary: "glass text-ink hover:border-hairline-strong hover:bg-surface-3/70",
  ghost: "text-ink-muted hover:text-ink hover:bg-white/6",
  danger: "border border-err/30 bg-err/12 text-err backdrop-blur-md hover:bg-err/20",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-3 text-xs rounded-pill",
  md: "h-9 px-4 text-sm rounded-pill",
  icon: "h-8 w-8 rounded-pill inline-flex items-center justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 transition-all duration-150",
        "disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
