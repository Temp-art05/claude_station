import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outlined";
type Size = "sm" | "md" | "icon";

/**
 * The M3 button set. `primary` is the filled button, `secondary` the tonal one,
 * `ghost` the text button — the old names are kept because every call site uses
 * them. Hover/press tints come from the `state-layer` utility (currentColor at
 * the M3 opacities) rather than a hard-coded white overlay, so the veil is
 * always in the button's own on-colour.
 */
const variants: Record<Variant, string> = {
  primary:
    "bg-inverse-surface text-on-inverse-surface shadow-e1 hover:bg-inverse-hover hover:shadow-e2",
  secondary: "bg-secondary-container text-on-secondary-container hover:shadow-e1",
  ghost: "text-ink-muted hover:text-ink",
  danger: "bg-err/16 text-err hover:bg-err/22",
  outlined: "border border-outline/70 text-primary hover:border-primary/60",
};

const sizes: Record<Size, string> = {
  sm: "h-8 gap-1.5 rounded-pill px-3.5 m3-body-sm",
  md: "h-10 gap-2 rounded-pill px-5 text-sm",
  icon: "h-10 w-10 rounded-pill inline-flex items-center justify-center",
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
        "state-layer inline-flex cursor-pointer items-center justify-center font-semibold",
        "transition-[background-color,box-shadow,color,transform,border-color]",
        "duration-200 ease-emphasized active:scale-[0.97]",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-offset-2",
        "focus-visible:ring-offset-surface-dim focus-visible:outline-none",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";

/**
 * M3 icon button: a 40px round target whose glyph is the whole label. Same
 * tones as Button, minus the text metrics.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; dense?: boolean }
>(({ className, variant = "ghost", dense = false, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "state-layer inline-flex cursor-pointer items-center justify-center rounded-pill",
      "transition-[background-color,box-shadow,color,transform] duration-200 ease-emphasized",
      "active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40",
      "focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:outline-none",
      dense ? "h-8 w-8" : "h-10 w-10",
      variants[variant],
      className,
    )}
    {...props}
  />
));
IconButton.displayName = "IconButton";
